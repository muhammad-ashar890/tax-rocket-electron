/**
 * Builds an ESTIMATE of the monthly sales tax return (FBR goods, trader).
 *
 * Every amount is whole paisa. The formulas follow the IRIS return layout in
 * the official FBR filing guide. IRIS's own figure is final; this result is
 * only shown as an estimate so the user can review invoices before opening
 * IRIS.
 *
 * If anything cannot be estimated safely (unsupported sale type, an invoice
 * IRIS would reject, a missing rule), no figures are produced at all.
 */

import { isValidPeriod, lastDayOfMonth } from "./dates";
import {
  checkExports,
  checkImports,
  checkPurchaseRows,
  checkSalesRows,
} from "./invoice-checks";
import { paisaToRupees, percentOfFloor, type Paisa } from "./money";
import { makeProblem } from "./problems";
import {
  findRuleNumber,
  saleTypeTreatment,
} from "./rules/fbr-goods/catalog";
import type {
  PurchaseInvoiceRow,
  ReturnAdjustments,
  ReturnInput,
  ReturnLine,
  ReturnResult,
  SalesInvoiceRow,
  SalesTaxProblem,
  SectionEightB,
} from "./types";

const ZERO_ADJUSTMENTS: ReturnAdjustments = {
  creditBroughtForward: 0,
  inadmissible6a: 0,
  nonCreditable7: 0,
  inadmissible7a: 0,
  allowance7b: 0,
  arrears23: 0,
  refundClaimed29: 0,
  taxPaidPreviousReturn36: 0,
};

const ADJUSTMENT_LABELS: Record<keyof ReturnAdjustments, string> = {
  creditBroughtForward: "Line 6, credit brought forward",
  inadmissible6a: "Line 6a, inadmissible input tax",
  nonCreditable7: "Line 7, non-creditable input tax",
  inadmissible7a: "Line 7a, inadmissible credit",
  allowance7b: "Line 7b, allowance of input credit",
  arrears23: "Line 23, arrears",
  refundClaimed29: "Line 29, refund claimed",
  taxPaidPreviousReturn36: "Line 36, tax paid on the previous return",
};

const ESTIMATE_NOTE =
  "Estimate. IRIS applies the section 8B limit itself; its figure is final.";

function signOf(documentType: string): number {
  return documentType === "Credit Note" ? -1 : 1;
}

function blocks(problems: SalesTaxProblem[]): boolean {
  return problems.some((p) => p.severity === "refuse" || p.severity === "error");
}

function emptyResult(
  input: ReturnInput,
  problems: SalesTaxProblem[],
): ReturnResult {
  return {
    isEstimate: true,
    canEstimate: false,
    period: input.period,
    problems,
    lines: [],
    bySr: {},
    balancePayable: null,
    rulesUsed: [],
  };
}

interface Bucket {
  gross: Paisa;
  taxable: Paisa;
  tax: Paisa;
}

function newBucket(): Bucket {
  return { gross: 0, taxable: 0, tax: 0 };
}

function line(
  sr: string,
  code: string | null,
  description: string,
  status: ReturnLine["status"],
  amounts: { gross?: Paisa | null; taxable?: Paisa | null; tax?: Paisa | null },
  note: string | null = null,
): ReturnLine {
  return {
    sr,
    code,
    description,
    grossValue: amounts.gross === undefined ? null : amounts.gross,
    taxableValue: amounts.taxable === undefined ? null : amounts.taxable,
    salesTax: amounts.tax === undefined ? null : amounts.tax,
    status,
    note,
  };
}

export function computeSalesTaxReturn(input: ReturnInput): ReturnResult {
  const problems: SalesTaxProblem[] = [];

  if (!isValidPeriod(input.period)) {
    return emptyResult(input, [makeProblem("invalid_period", "return", null)]);
  }
  const asOf = lastDayOfMonth(input.period);

  // Inputs the user supplies.
  const adjustments: ReturnAdjustments = { ...ZERO_ADJUSTMENTS, ...(input.adjustments || {}) };
  for (const key of Object.keys(ZERO_ADJUSTMENTS) as Array<keyof ReturnAdjustments>) {
    const value = adjustments[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      problems.push(makeProblem("adjustment_invalid", "return", null, { field: ADJUSTMENT_LABELS[key] }));
    }
  }
  const defaultCap = findRuleNumber("fbr.s8b.cap_percent", asOf);
  if (defaultCap === null) {
    problems.push(makeProblem("rule_missing", "return", null, { rule: "input tax limit (section 8B)" }));
  }
  const eightB: SectionEightB = {
    excluded: false,
    capPercent: defaultCap === null ? 0 : defaultCap,
    ...(input.section8B || {}),
  };
  if (
    !Number.isInteger(eightB.capPercent) ||
    eightB.capPercent < 1 ||
    eightB.capPercent > 100
  ) {
    problems.push(makeProblem("cap_percent_invalid", "return", null));
  }

  // Invoice and record checks.
  problems.push(...checkSalesRows(input.sales, input.period));
  problems.push(...checkPurchaseRows(input.purchases, input.period));
  problems.push(...checkImports(input.imports));
  problems.push(...checkExports(input.exports));

  if (blocks(problems)) return emptyResult(input, problems);

  // Sales (Annex-C): lines 9, 10, 15, 16, 23a.
  const line9 = newBucket();
  const line10 = newBucket();
  let line16: Paisa = 0;
  let line23a: Paisa = 0;
  let sawExemptSale = false;
  for (const row of input.sales as SalesInvoiceRow[]) {
    const sign = signOf(row.documentType);
    const treatment = saleTypeTreatment(row.saleType);
    const value = row.valueExclTax || 0;
    const tax = row.salesTax || 0;
    line9.gross += sign * value;
    if (treatment !== "zero_rated" && treatment !== "exempt") {
      line9.taxable += sign * value;
    }
    line9.tax += sign * tax;
    if (treatment === "reduced") {
      line10.gross += sign * value;
      line10.taxable += sign * value;
      line10.tax += sign * tax;
    }
    if (treatment === "exempt") sawExemptSale = true;
    line16 += sign * (row.stWithheldAtSource || 0);
    line23a += sign * (row.furtherTax || 0);
  }

  // Exports (Annex-D): line 11.
  const line11 = newBucket();
  for (const row of input.exports) {
    line11.gross += row.valueExclTax;
    line11.taxable += row.valueExclTax;
  }

  // Purchases (Annex-A) and imports (Annex-B): lines 1 to 4 and 22.
  const line1 = newBucket();
  const line2 = newBucket();
  const line3 = newBucket();
  const line4 = newBucket();
  let line22: Paisa = 0;
  for (const row of input.purchases as PurchaseInvoiceRow[]) {
    const sign = signOf(row.documentType);
    const treatment = saleTypeTreatment(row.purchaseType);
    const value = row.valueExclTax || 0;
    const tax = row.salesTax || 0;
    line22 += sign * (row.stWithheldAsWhAgent || 0);
    const taxable = treatment === "zero_rated" || treatment === "exempt" ? 0 : value;
    if (row.sellerType !== "Registered") {
      // No input tax credit on purchases from unregistered suppliers.
      line2.gross += sign * value;
      line2.taxable += sign * taxable;
      continue;
    }
    const target = row.isCapitalGoods ? line4 : line1;
    target.gross += sign * value;
    target.taxable += sign * taxable;
    target.tax += sign * tax;
  }
  for (const row of input.imports) {
    const target = row.isCapitalGoods ? line4 : line3;
    target.gross += row.taxableValue;
    target.taxable += row.taxableValue;
    target.tax += row.salesTaxPaid;
  }

  const line5 = line1.tax + line3.tax + line4.tax;
  const line15 = line9.tax;
  const line17 = line15 - line16;
  const line8 =
    line5 +
    adjustments.creditBroughtForward +
    adjustments.allowance7b -
    (adjustments.inadmissible6a + adjustments.nonCreditable7 + adjustments.inadmissible7a);

  if (line8 < 0) {
    problems.push(makeProblem("adjustments_exceed_input", "return", null));
    return emptyResult(input, problems);
  }

  // Line 25: input tax adjusted against output tax (section 8B).
  let line25: Paisa;
  let line26: Paisa;
  if (eightB.excluded) {
    line25 = line8;
    line26 = line25 > line17 ? line25 - line17 : 0;
  } else {
    // Section 8B(1): input tax other than fixed assets is limited to the
    // cap percentage of output tax. Fixed assets and capital goods sit
    // outside the cap. The total can never exceed the output tax left after
    // withholding.
    const capitalInput = Math.min(line4.tax, line8);
    const ordinaryInput = line8 - capitalInput;
    const capAmount = percentOfFloor(line15, eightB.capPercent);
    const outputAvailable = Math.max(0, line17);
    line25 = Math.min(
      Math.min(ordinaryInput, capAmount) + capitalInput,
      outputAvailable,
    );
    line26 = line8 - line25;
  }
  const line27: Paisa = 0;
  const line28 = line26 - line27;
  const line29 = adjustments.refundClaimed29;
  const line30 = line28 > line29 ? line28 - line29 + line27 : line27;
  const line32 =
    (line17 > line25 ? line17 - line25 : 0) +
    line22 +
    adjustments.arrears23 +
    line23a;
  const line35 = line32;
  const line36 = adjustments.taxPaidPreviousReturn36;
  const line37 = line35 - line36;

  // Warnings that depend on the figures.
  if (line17 < 0) problems.push(makeProblem("withheld_exceeds_output", "return", null));
  if (line29 > line28) problems.push(makeProblem("refund_exceeds_credit", "return", null));
  if (blocks(problems)) return emptyResult(input, problems);
  if (line29 > 0) problems.push(makeProblem("refund_needs_annex_h", "return", null));
  if (sawExemptSale && adjustments.nonCreditable7 === 0 && line5 > 0) {
    problems.push(makeProblem("exempt_supplies_need_apportionment", "return", null));
  }
  if (
    input.sales.length === 0 &&
    input.purchases.length === 0 &&
    input.imports.length === 0 &&
    input.exports.length === 0
  ) {
    problems.push(makeProblem("no_invoices", "return", null));
  }

  const lines: ReturnLine[] = [
    line("1", "100101", "Purchases from registered suppliers (excluding fixed assets)", "computed", { gross: line1.gross, taxable: line1.taxable, tax: line1.tax }),
    line("2", "100102", "Purchases from unregistered suppliers (no input credit)", "computed", { gross: line2.gross, taxable: line2.taxable, tax: 0 }),
    line("3", "100103", "Imports (excluding fixed assets)", "computed", { gross: line3.gross, taxable: line3.taxable, tax: line3.tax }),
    line("4", "100104", "Fixed assets and capital goods (purchases and imports)", "computed", { gross: line4.gross, taxable: line4.taxable, tax: line4.tax }),
    line("5", "100105", "Input tax for the month (1 + 3 + 4)", "computed", { tax: line5 }),
    line("6", null, "Credit brought forward from the previous period", "input", { tax: adjustments.creditBroughtForward }),
    line("6a", "100109", "Inadmissible input tax, section 8(1)(m)", "input", { tax: adjustments.inadmissible6a }),
    line("7", "100107", "Non-creditable input tax", "input", { tax: adjustments.nonCreditable7 }),
    line("7a", "100111", "Inadmissible credit, section 7(2)(i) read with 8(1)(l)", "input", { tax: adjustments.inadmissible7a }),
    line("7b", "100112", "Allowance of input credit", "input", { tax: adjustments.allowance7b }),
    line("8", null, "Total admissible input tax", "computed", { tax: line8 }),
    line("9", "100201", "Supplies in Pakistan, including reduced rate (sales invoices less credit notes plus debit notes)", "computed", { gross: line9.gross, taxable: line9.taxable, tax: line9.tax }),
    line("10", "100202", "Of which at reduced rate (memo)", "computed", { gross: line10.gross, taxable: line10.taxable, tax: line10.tax }),
    line("11", "100203", "Exports (zero rated)", "computed", { gross: line11.gross, taxable: line11.taxable, tax: 0 }),
    line("15", "100205", "Output tax for the month", "computed", { tax: line15 }),
    line("16", "100210", "Sales tax withheld by buyers", "computed", { tax: line16 }),
    line("17", "100211", "Output tax after withholding (15 - 16)", "computed", { tax: line17 }),
    line("22", null, "Sales tax withheld by you as withholding agent", "computed", { tax: line22 }),
    line("23", null, "Arrears", "input", { tax: adjustments.arrears23 }),
    line("23a", null, "Further tax on supplies to unregistered buyers", "computed", { tax: line23a }),
    line("24", "100301", "Excluded from the section 8B limit", "input", {}, eightB.excluded ? "Yes" : `No (limit ${eightB.capPercent}% of output tax)`),
    line("25", "100302", "Input tax adjusted against output tax", "estimate", { tax: line25 }, ESTIMATE_NOTE),
    line("26", "100303", "Input tax not adjusted this month", "estimate", { tax: line26 }, ESTIMATE_NOTE),
    line("27", "100304", "Credit carried forward on account of value addition tax", "fixed_zero", { tax: line27 }, "Not supported in this version; kept at zero."),
    line("28", "100305", "Unadjusted credit available", "estimate", { tax: line28 }, ESTIMATE_NOTE),
    line("29", "100306", "Refund claimed", "input", { tax: line29 }),
    line("30", "100309", "Credit carried forward to the next month", "estimate", { tax: line30 }, ESTIMATE_NOTE),
    line("32", "100401", "Net sales tax payable", "estimate", { tax: line32 }, ESTIMATE_NOTE),
    line("35", "100404", "Total payable", "estimate", { tax: line35 }, ESTIMATE_NOTE),
    line("36", "100405", "Tax paid on the previous return", "input", { tax: line36 }),
    line("37", "100406", "Balance payable", "estimate", { tax: line37 }, ESTIMATE_NOTE),
  ];

  const bySr: Record<string, ReturnLine> = {};
  for (const item of lines) bySr[item.sr] = item;

  return {
    isEstimate: true,
    canEstimate: true,
    period: input.period,
    problems,
    lines,
    bySr,
    balancePayable: line37,
    rulesUsed: [
      "fbr.rate.standard",
      "fbr.rate.further_tax",
      "fbr.s8b.cap_percent",
      "fbr.s8b.capital_goods_outside_cap",
    ],
  };
}

/** Whole-rupee view of a line amount, the way IRIS prints it. */
export function lineRupees(amount: Paisa | null): number | null {
  return amount === null ? null : paisaToRupees(amount);
}
