/**
 * Row checks for sales and purchase invoices.
 *
 * Checks mirror what IRIS validates, plus a few extra safety checks. A
 * problem with severity "refuse" or "error" stops the estimate; "warning"
 * does not. The engine never changes a figure to make a check pass.
 */

import { isDateInPeriod, lastDayOfMonth } from "./dates";
import { applyRate, formatRupees, type Paisa } from "./money";
import { makeProblem } from "./problems";
import {
  findRuleNumber,
  saleTypeTreatment,
  type SaleTypeTreatment,
} from "./rules/fbr-goods/catalog";
import {
  PURCHASE_TEMPLATE,
  SALES_TEMPLATE,
  type TemplateReference,
} from "./rules/fbr-goods/reference";
import type {
  ExportRow,
  ImportRow,
  PurchaseInvoiceRow,
  SalesInvoiceRow,
  SalesTaxProblem,
  TaxPeriod,
} from "./types";

/** Largest difference, in paisa, accepted between stated and computed tax. */
export const TAX_TOLERANCE_PAISA = 100;

/** Digit counts that an NTN with check digit, CNIC or STRN can have. */
const PLAUSIBLE_ID_LENGTHS = [7, 8, 13, 15];

const UNREGISTERED_BUYER_TYPES = [
  "Unregistered",
  "Unregistered Distributor",
  "Retail Consumer",
];

/** A sales or purchase row in one common shape. */
interface TradeRow {
  sheet: "sales" | "purchases";
  sourceRow: number;
  partyWord: "buyer" | "seller";
  partyTypeLabel: string;
  partyType: string;
  partyId: string;
  origin: string;
  destination: string;
  docType: string;
  docNo: string;
  partyName: string;
  date: string | null;
  typeLabel: string;
  type: string;
  rate: number | string | null;
  value: Paisa | null;
  valueLabel: string;
  tax: Paisa | null;
  taxLabel: string;
  fixed: Paisa | null;
  extra: Paisa | null;
  further: Paisa | null;
  withheld: Paisa | null;
  sro: string;
  item: string;
  invoiceRef: string;
  reason: string;
  unreadable: string[];
  /** Special-sector columns that are filled in, as [label, filled]. */
  specialColumns: Array<{ label: string; filled: boolean }>;
}

function fromSales(row: SalesInvoiceRow): TradeRow {
  return {
    sheet: "sales",
    sourceRow: row.sourceRow,
    partyWord: "buyer",
    partyTypeLabel: "Buyer type",
    partyType: row.buyerType,
    partyId: row.buyerRegistrationNo,
    partyName: row.buyerName,
    origin: row.originProvince,
    destination: row.destinationProvince,
    docType: row.documentType,
    docNo: row.documentNo,
    date: row.documentDate,
    typeLabel: "Sale Type",
    type: row.saleType,
    rate: row.rate,
    value: row.valueExclTax,
    valueLabel: "Value of Sales Excluding Sales Tax",
    tax: row.salesTax,
    taxLabel: "Sales Tax/ FED in ST Mode",
    fixed: row.fixedOrRetailValue,
    extra: row.extraTax,
    further: row.furtherTax,
    withheld: row.stWithheldAtSource,
    sro: row.exemptionSroNo,
    item: row.exemptionItemSrNo,
    invoiceRef: row.invoiceRefNo,
    reason: row.reason,
    unreadable: row.unreadableFields || [],
    specialColumns: [
      { label: "Total Value of Sales (In case of PFAD only)", filled: (row.totalValuePfad || 0) !== 0 },
      {
        label: "Petroleum Levy Rate",
        filled: row.petroleumLevyRate !== "" && row.petroleumLevyRate !== "No Levy",
      },
      { label: "Additional Sales Tax Rate", filled: row.additionalSalesTaxRate !== "" },
    ],
  };
}

function fromPurchase(row: PurchaseInvoiceRow): TradeRow {
  return {
    sheet: "purchases",
    sourceRow: row.sourceRow,
    partyWord: "seller",
    partyTypeLabel: "Seller type",
    partyType: row.sellerType,
    partyId: row.sellerRegistrationNo,
    partyName: row.sellerName,
    origin: row.originProvince,
    destination: row.destinationProvince,
    docType: row.documentType,
    docNo: row.documentNo,
    date: row.documentDate,
    typeLabel: "Purchase Type",
    type: row.purchaseType,
    rate: row.rate,
    value: row.valueExclTax,
    valueLabel: "Value of Purchases",
    tax: row.salesTax,
    taxLabel: "Sales Tax/ FED in ST Mode",
    fixed: row.fixedRetailValue,
    extra: row.extraTax,
    further: null,
    withheld: row.stWithheldAsWhAgent,
    sro: row.exemptionSroNo,
    item: row.exemptionItemSrNo,
    invoiceRef: row.invoiceRefNo,
    reason: row.reason,
    unreadable: row.unreadableFields || [],
    specialColumns: [{ label: "FED Charged", filled: (row.fedCharged || 0) !== 0 }],
  };
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

function rateInList(rate: number | string, list: Array<number | string>): boolean {
  if (typeof rate === "number") {
    return list.some(
      (entry) => typeof entry === "number" && Math.abs(entry - rate) < 1e-9,
    );
  }
  return list.includes(rate);
}

function rateText(rate: number | string | null): string {
  if (rate === null) return "(blank)";
  if (typeof rate === "number") {
    return `${Number((rate * 100).toFixed(4))}%`;
  }
  return rate;
}

function numericRate(rate: number | string | null): number | null {
  return typeof rate === "number" ? rate : null;
}

function checkTradeRows(
  rows: TradeRow[],
  period: TaxPeriod,
  reference: TemplateReference,
): SalesTaxProblem[] {
  const problems: SalesTaxProblem[] = [];
  const asOf = lastDayOfMonth(period);
  const standardRate = findRuleNumber("fbr.rate.standard", asOf);
  const furtherRate = findRuleNumber("fbr.rate.further_tax", asOf);
  if (standardRate === null) {
    problems.push(makeProblem("rule_missing", "return", null, { rule: "standard rate of sales tax" }));
    return problems;
  }
  if (furtherRate === null) {
    problems.push(makeProblem("rule_missing", "return", null, { rule: "further tax" }));
    return problems;
  }

  const seenExact = new Map<string, number>();
  const seenNumber = new Map<string, { row: number; who: string }>();
  let sawRegisteredSupplier = false;

  for (const row of rows) {
    const sheet = row.sheet;
    const n = row.sourceRow;
    const add = (code: string, params: Record<string, string | number> = {}) =>
      problems.push(makeProblem(code, sheet, n, params));
    const skipMissing = (label: string) => row.unreadable.includes(label);

    // 1. Required fields.
    const required: Array<[string, string]> = [
      [row.partyTypeLabel, row.partyType],
      ["Sale Origination Province of Supplier", row.origin],
      ["Destination of Supply", row.destination],
      ["Document Type", row.docType],
      ["Document Number", row.docNo],
      [row.typeLabel, row.type],
    ];
    for (const [label, value] of required) {
      if (value === "") add("row_missing_field", { field: label });
    }
    if (row.date === null && !skipMissing("Date")) add("row_missing_field", { field: "Document Date" });
    if (row.rate === null) add("row_missing_field", { field: "Rate" });
    if (row.value === null && !skipMissing(row.valueLabel)) add("row_missing_field", { field: row.valueLabel });

    // 2. Values must be choices the template offers.
    const lists: Array<[string, string, string[]]> = [
      [row.partyTypeLabel, row.partyType, reference.partyTypes],
      ["Sale Origination Province of Supplier", row.origin, reference.provinces],
      ["Destination of Supply", row.destination, reference.provinces],
      ["Document Type", row.docType, reference.documentTypes],
      [row.typeLabel, row.type, reference.saleTypes],
    ];
    for (const [label, value, list] of lists) {
      if (value !== "" && !list.includes(value)) {
        add("row_value_not_in_list", { field: label, value });
      }
    }
    if (row.rate !== null && !rateInList(row.rate, reference.rates)) {
      add("row_value_not_in_list", { field: "Rate", value: rateText(row.rate) });
    }
    if (row.reason !== "" && !reference.reasons.includes(row.reason)) {
      add("row_value_not_in_list", { field: "Reasons", value: row.reason });
    }
    if (row.sro !== "" && !reference.sroNumbers.includes(row.sro)) {
      add("row_value_not_in_list", { field: "SRO No./ Schedule No.", value: row.sro });
    }
    if (row.item !== "" && !reference.itemSerials.includes(row.item)) {
      add("row_value_not_in_list", { field: "Item S. No.", value: row.item });
    }

    // 3. Negative amounts.
    const amounts: Array<[string, Paisa | null]> = [
      [row.valueLabel, row.value],
      [row.taxLabel, row.tax],
      ["Fixed / Retail value", row.fixed],
      ["Further Tax", row.further],
      ["ST Withheld", row.withheld],
    ];
    for (const [label, amount] of amounts) {
      if (amount !== null && amount < 0) add("row_negative_amount", { field: label });
    }

    // 4. Things this version cannot estimate. Never guessed.
    let refused = false;
    if (row.docType === "STWH") {
      add("row_withholding_document");
      refused = true;
    }
    const treatment: SaleTypeTreatment = reference.saleTypes.includes(row.type)
      ? saleTypeTreatment(row.type)
      : "unsupported";
    if (row.type !== "" && reference.saleTypes.includes(row.type) && treatment === "unsupported") {
      add("row_unsupported_sale_type", { value: row.type });
      refused = true;
    }
    if ((row.extra || 0) > 0) {
      add("row_extra_tax");
      refused = true;
    }
    for (const special of row.specialColumns) {
      if (special.filled) {
        add("row_unsupported_column", { field: special.label });
        refused = true;
      }
    }

    // 5. Date inside the return month.
    if (row.date !== null && !isDateInPeriod(row.date, period)) {
      add("row_date_outside_period", { value: row.date });
    }

    // 6. Duplicates and reused document numbers.
    if (row.docNo !== "" && row.docType !== "") {
      const exactKey = JSON.stringify([
        row.docType, row.docNo, row.date, row.partyId, row.partyName.toLowerCase(),
        row.type, row.rate, row.value, row.tax, row.fixed, row.further,
        row.withheld, row.sro, row.item,
      ]);
      const firstExact = seenExact.get(exactKey);
      if (firstExact !== undefined) {
        add("row_duplicate", { firstRow: firstExact });
      } else {
        seenExact.set(exactKey, n);
        const numberKey = `${row.docType}\u0000${row.docNo}`;
        const who = `${row.partyId}\u0000${row.partyName.toLowerCase()}\u0000${row.date}`;
        const first = seenNumber.get(numberKey);
        if (!first) {
          seenNumber.set(numberKey, { row: n, who });
        } else if (first.who !== who) {
          add("row_invoice_number_reused", { value: row.docNo, firstRow: first.row });
        }
      }
    }

    // 7. Credit and debit notes need the original invoice and a reason.
    if (row.docType === "Credit Note" || row.docType === "Debit Note") {
      if (row.invoiceRef === "" || row.reason === "") {
        add("row_note_reference_missing", { noteKind: row.docType.toLowerCase() });
      }
    }

    // 8. Party registration number.
    const registered = row.partyType === "Registered";
    const idDigits = digitsOf(row.partyId);
    if (registered) {
      if (row.partyId === "") {
        add("row_party_id_missing", { party: row.partyWord });
      } else if (!PLAUSIBLE_ID_LENGTHS.includes(idDigits.length)) {
        add("row_party_id_unusual", { value: row.partyId });
      }
      if (row.sheet === "purchases") sawRegisteredSupplier = true;
    } else if (
      row.sheet === "sales" &&
      (row.partyType === "Unregistered" || row.partyType === "Unregistered Distributor")
    ) {
      if (row.partyId === "") {
        add("row_unregistered_buyer_without_id");
      } else if (row.partyId !== "" && !PLAUSIBLE_ID_LENGTHS.includes(idDigits.length)) {
        add("row_party_id_unusual", { value: row.partyId });
      }
    }

    if (refused || treatment === "unsupported") continue;

    // 9. Purchases from unregistered suppliers carry no creditable tax.
    if (row.sheet === "purchases" && row.partyType === "Unregistered") {
      if ((row.tax || 0) > 0) add("purchase_unregistered_with_tax");
      continue;
    }

    // 10. Rate must fit the sale type; tax must equal value times rate.
    const rate = numericRate(row.rate);
    let rateDetail: string | null = null;
    if (row.rate !== null) {
      if (treatment === "standard" && !(rate !== null && Math.abs(rate - standardRate) < 1e-9)) {
        rateDetail = `Goods at the standard rate are taxed at ${rateText(standardRate)}.`;
      } else if (treatment === "reduced" && !(rate !== null && rate > 0 && rate < standardRate)) {
        rateDetail = "A reduced rate is a percentage above 0% and below the standard rate.";
      } else if (treatment === "zero_rated" && rate !== 0) {
        rateDetail = "Zero-rated supplies use the rate 0.";
      } else if (treatment === "exempt" && row.rate !== "Exempt") {
        rateDetail = 'Exempt supplies use the rate "Exempt".';
      } else if (treatment === "third_schedule" && !(rate !== null && rate > 0 && rate <= standardRate)) {
        rateDetail = "Third Schedule goods use a percentage rate.";
      }
      if (rateDetail) {
        add("row_rate_not_expected", {
          rate: rateText(row.rate),
          saleType: row.type,
          detail: rateDetail,
        });
      }
    }
    if (
      (treatment === "reduced" || treatment === "zero_rated" || treatment === "exempt") &&
      row.sro === "" && row.item === ""
    ) {
      add("row_reference_missing", {
        kind:
          treatment === "reduced" ? "reduced-rate" : treatment === "zero_rated" ? "zero-rated" : "exempt",
      });
    }

    let base: Paisa | null = row.value;
    if (treatment === "third_schedule") {
      if (row.fixed === null || row.fixed <= 0) {
        add("row_retail_price_missing");
        base = null;
      } else {
        base = row.fixed;
      }
    }
    if (!rateDetail && base !== null) {
      let expected: Paisa | null = null;
      let tolerance = TAX_TOLERANCE_PAISA;
      if (treatment === "zero_rated" || treatment === "exempt") {
        expected = 0;
        tolerance = 0;
      } else if (rate !== null) {
        expected = applyRate(base, rate);
      }
      const stated = row.tax === null && expected === 0 ? 0 : row.tax;
      if (expected !== null) {
        if (stated === null) {
          if (!skipMissing(row.taxLabel)) add("row_missing_field", { field: row.taxLabel });
        } else if (Math.abs(stated - expected) > tolerance) {
          add("row_tax_mismatch", {
            stated: formatRupees(stated),
            expected: formatRupees(expected),
          });
        }
      }
    }

    // 11. Further tax on supplies to unregistered buyers (sales only).
    if (
      row.sheet === "sales" &&
      UNREGISTERED_BUYER_TYPES.includes(row.partyType) &&
      (treatment === "standard" || treatment === "reduced" || treatment === "third_schedule") &&
      base !== null
    ) {
      const expectedFurther = applyRate(base, furtherRate);
      const statedFurther = row.further === null ? 0 : row.further;
      if (statedFurther === 0 && expectedFurther > 0) {
        add("row_further_tax_missing", { rate: rateText(furtherRate) });
      } else if (Math.abs(statedFurther - expectedFurther) > TAX_TOLERANCE_PAISA) {
        add("row_further_tax_mismatch", {
          stated: formatRupees(statedFurther),
          rate: rateText(furtherRate),
          expected: formatRupees(expectedFurther),
        });
      }
    }
  }

  if (sawRegisteredSupplier) {
    problems.push(makeProblem("purchase_supplier_status_unknown", "purchases", null));
  }
  return problems;
}

export function checkSalesRows(
  rows: SalesInvoiceRow[],
  period: TaxPeriod,
): SalesTaxProblem[] {
  return checkTradeRows(rows.map(fromSales), period, SALES_TEMPLATE);
}

export function checkPurchaseRows(
  rows: PurchaseInvoiceRow[],
  period: TaxPeriod,
): SalesTaxProblem[] {
  return checkTradeRows(rows.map(fromPurchase), period, PURCHASE_TEMPLATE);
}

export function checkImports(imports: ImportRow[]): SalesTaxProblem[] {
  const problems: SalesTaxProblem[] = [];
  for (const row of imports) {
    const gdNo = row.gdNo || "(no number)";
    const amounts = [row.taxableValue, row.salesTaxPaid, row.valueAdditionTaxPaid];
    if (amounts.some((a) => !Number.isSafeInteger(a) || a < 0)) {
      problems.push(makeProblem("import_invalid_amount", "imports", null, { gdNo }));
      continue;
    }
    if (row.valueAdditionTaxPaid > 0) {
      problems.push(makeProblem("import_vat_unsupported", "imports", null, { gdNo }));
    }
  }
  return problems;
}

export function checkExports(exports: ExportRow[]): SalesTaxProblem[] {
  const problems: SalesTaxProblem[] = [];
  for (const row of exports) {
    if (!Number.isSafeInteger(row.valueExclTax) || row.valueExclTax < 0) {
      problems.push(
        makeProblem("export_invalid_amount", "exports", null, {
          documentNo: row.documentNo || "(no number)",
        }),
      );
    }
  }
  return problems;
}

export interface ExpectedSheetOwner {
  /** The client's registration number as typed in the app (digits only are compared). */
  registrationNo: string;
  period: TaxPeriod;
}

/**
 * Compares the file header with the client and month the user chose.
 * A file prepared for another client or another month is rejected.
 */
export function checkSheetHeader(
  header: {
    registrationNo: string;
    taxPeriod: TaxPeriod | null;
    invalidRecordsReported: number | null;
  },
  sheet: "sales" | "purchases",
  expected: ExpectedSheetOwner,
): SalesTaxProblem[] {
  const problems: SalesTaxProblem[] = [];
  const foundDigits = digitsOf(header.registrationNo);
  const expectedDigits = digitsOf(expected.registrationNo);
  if (foundDigits !== expectedDigits) {
    problems.push(
      makeProblem("template_registration_mismatch", "template", null, {
        sheet,
        found: header.registrationNo || "(blank)",
        expected: expected.registrationNo || "(blank)",
      }),
    );
  }
  const label = (period: TaxPeriod | null) =>
    period ? `${String(period.month).padStart(2, "0")}/${period.year}` : "(blank)";
  if (
    !header.taxPeriod ||
    header.taxPeriod.year !== expected.period.year ||
    header.taxPeriod.month !== expected.period.month
  ) {
    problems.push(
      makeProblem("template_period_mismatch", "template", null, {
        sheet,
        found: label(header.taxPeriod),
        expected: label(expected.period),
      }),
    );
  }
  if (header.invalidRecordsReported !== null && header.invalidRecordsReported > 0) {
    problems.push(
      makeProblem("template_reports_invalid_rows", "template", null, {
        sheet,
        count: header.invalidRecordsReported,
      }),
    );
  }
  return problems;
}
