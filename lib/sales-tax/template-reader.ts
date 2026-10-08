/**
 * Reads the official FBR invoice templates (DSI sales, DPI purchases) from a
 * grid of cells.
 *
 * The input is an array of rows, each an array of cell values, exactly what
 * XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null })
 * returns for the SALES_INVOICES sheet when the workbook was read with
 * cellDates enabled. Opening the .xlsm file itself is a Phase 2 job.
 *
 * Column positions are fixed by the template. Before any row is read, the
 * header rows are compared with the headers stored in reference-data.json, so
 * a template whose columns moved is rejected instead of misread.
 */

import { isValidPeriod, parseDateCell } from "./dates";
import { toPaisa } from "./money";
import { makeProblem } from "./problems";
import {
  PURCHASE_TEMPLATE,
  SALES_TEMPLATE,
  SUPPORTED_PURCHASE_TEMPLATE_VERSIONS,
  SUPPORTED_SALES_TEMPLATE_VERSIONS,
  type TemplateReference,
} from "./rules/fbr-goods/reference";
import type {
  PurchaseInvoiceRow,
  SalesInvoiceRow,
  SalesTaxProblem,
  TaxPeriod,
} from "./types";

export type CellGrid = unknown[][];

/** Zero-based column positions of the sales (DSI) template. */
export const SALES_COLUMNS = {
  sr: 0,
  partyRegistrationNo: 1,
  partyName: 2,
  partyType: 3,
  originProvince: 4,
  destinationProvince: 5,
  documentType: 6,
  documentNo: 7,
  documentDate: 8,
  hsCode: 9,
  saleType: 10,
  rate: 11,
  quantity: 13,
  unitOfMeasure: 14,
  value: 15,
  salesTax: 16,
  fixedOrRetailValue: 17,
  extraTax: 18,
  furtherTax: 19,
  totalValuePfad: 20,
  stWithheld: 21,
  exemptionSroNo: 22,
  exemptionItemSrNo: 23,
  invoiceRefNo: 24,
  reason: 25,
  reasonRemarks: 26,
  productDescription: 27,
  petroleumLevyRate: 28,
  additionalSalesTaxRate: 29,
} as const;

/** Zero-based column positions of the purchase (DPI) template. */
export const PURCHASE_COLUMNS = {
  sr: 0,
  partyRegistrationNo: 1,
  partyName: 2,
  partyType: 3,
  originProvince: 4,
  destinationProvince: 5,
  documentType: 6,
  documentNo: 7,
  documentDate: 8,
  hsCode: 9,
  purchaseType: 10,
  rate: 11,
  quantity: 13,
  unitOfMeasure: 14,
  value: 15,
  salesTax: 16,
  fixedRetailValue: 17,
  extraTax: 18,
  fedCharged: 20,
  stWithheld: 21,
  exemptionSroNo: 22,
  exemptionItemSrNo: 23,
  invoiceRefNo: 24,
  reason: 25,
  reasonRemarks: 26,
  productDescription: 27,
} as const;

/** Data rows start on the sixth row of the sheet (zero-based index 5). */
const FIRST_DATA_ROW_INDEX = 5;
/** Columns checked when deciding whether a row is empty. */
const LAST_DATA_COLUMN = 29;

export interface TemplateHeader {
  registrationNo: string;
  taxPeriod: TaxPeriod | null;
  marker: string;
  markerKind: string | null;
  version: string | null;
  invalidRecordsReported: number | null;
}

export interface SalesSheetResult {
  header: TemplateHeader;
  rows: SalesInvoiceRow[];
  /** Problems found while reading. Row rule checks are separate. */
  problems: SalesTaxProblem[];
  /** False when the sheet cannot be trusted at all (layout or version). */
  readable: boolean;
}

export interface PurchaseSheetResult {
  header: TemplateHeader;
  rows: PurchaseInvoiceRow[];
  problems: SalesTaxProblem[];
  readable: boolean;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return parseDateCell(value) || "";
  if (typeof value === "number") return String(value);
  return String(value).trim();
}

function normalizeHeader(value: unknown): string {
  return text(value).replace(/\s+/g, " ").trim();
}

function cell(grid: CellGrid, rowIndex: number, columnIndex: number): unknown {
  const row = grid[rowIndex];
  return row ? row[columnIndex] : null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

/** Registration numbers are read as text; a bare number loses no digits. */
function idText(value: unknown): string {
  if (typeof value === "number")
    return Number.isFinite(value) ? value.toFixed(0) : "";
  return text(value);
}

function readHeader(grid: CellGrid): TemplateHeader {
  const marker = text(cell(grid, 2, 1));
  const match = /_~_(DSI|DPI)_~_([0-9.]+)$/.exec(marker);
  const periodCell = cell(grid, 1, 5);
  const periodDate = parseDateCell(periodCell);
  let taxPeriod: TaxPeriod | null = null;
  if (periodDate) {
    taxPeriod = {
      year: Number(periodDate.slice(0, 4)),
      month: Number(periodDate.slice(5, 7)),
    };
    if (!isValidPeriod(taxPeriod)) taxPeriod = null;
  }
  const invalidCell = cell(grid, 2, 9);
  const invalid = Number(invalidCell);
  return {
    registrationNo: idText(cell(grid, 1, 2)),
    taxPeriod,
    marker,
    markerKind: match ? match[1] : null,
    version: match ? match[2] : null,
    invalidRecordsReported:
      isBlank(invalidCell) || !Number.isFinite(invalid) ? null : invalid,
  };
}

/** True when header rows 4 and 5 of the grid equal the reference template. */
function headerMatches(grid: CellGrid, reference: TemplateReference): boolean {
  for (const rowIndex of [3, 4]) {
    const expected = reference.headerRows[rowIndex] || [];
    for (let column = 0; column < expected.length; column += 1) {
      const found = normalizeHeader(cell(grid, rowIndex, column));
      if (found === normalizeHeader(expected[column])) continue;
      // A header cell merged downwards (the "Rate" column) keeps its text in
      // the cell above only; the cell below reads as blank in a real file.
      if (
        found === "" &&
        rowIndex > 0 &&
        normalizeHeader(cell(grid, rowIndex - 1, column)) ===
          normalizeHeader(expected[column])
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
}

function rowIsEmpty(row: unknown[] | undefined): boolean {
  if (!row) return true;
  // Column 0 is only the serial number; a pre-numbered blank row is empty.
  for (let column = 1; column <= LAST_DATA_COLUMN; column += 1) {
    if (!isBlank(row[column])) return false;
  }
  return true;
}

function rateCell(value: unknown): number | string | null {
  if (isBlank(value)) return null;
  if (typeof value === "number") return value;
  const trimmed = String(value).trim();
  if (/^\d*\.?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Reads an amount cell. Blank gives null; text that is not a number is recorded. */
function amountCell(
  value: unknown,
  field: string,
  unreadable: string[],
): number | null {
  if (isBlank(value)) return null;
  const paisa = toPaisa(value);
  if (paisa === null) {
    unreadable.push(field);
    return null;
  }
  return paisa;
}

function openSheet(
  grid: CellGrid,
  sheetName: "sales" | "purchases",
  reference: TemplateReference,
  supportedVersions: string[],
  expectedKind: "DSI" | "DPI",
): { header: TemplateHeader; problems: SalesTaxProblem[]; readable: boolean } {
  const problems: SalesTaxProblem[] = [];
  const header = readHeader(grid);
  let readable = true;
  if (!headerMatches(grid, reference)) {
    problems.push(
      makeProblem("template_layout_changed", "template", null, {
        sheet: sheetName,
      }),
    );
    readable = false;
  }
  if (header.markerKind && header.markerKind !== expectedKind) {
    problems.push(
      makeProblem("template_wrong_kind", "template", null, {
        sheet: sheetName,
        found: header.markerKind,
        expected: expectedKind,
      }),
    );
    readable = false;
  } else if (!header.markerKind) {
    problems.push(
      makeProblem("template_layout_changed", "template", null, {
        sheet: sheetName,
      }),
    );
    readable = false;
  } else if (!header.version || !supportedVersions.includes(header.version)) {
    problems.push(
      makeProblem("template_version_unsupported", "template", null, {
        sheet: sheetName,
        found: header.version || "unknown",
        expected: supportedVersions.join(" or "),
      }),
    );
    readable = false;
  }
  return { header, problems, readable };
}

export function readSalesSheet(grid: CellGrid): SalesSheetResult {
  const opened = openSheet(
    grid,
    "sales",
    SALES_TEMPLATE,
    SUPPORTED_SALES_TEMPLATE_VERSIONS,
    "DSI",
  );
  const rows: SalesInvoiceRow[] = [];
  if (!opened.readable) {
    return {
      header: opened.header,
      rows,
      problems: opened.problems,
      readable: false,
    };
  }
  const c = SALES_COLUMNS;
  for (let index = FIRST_DATA_ROW_INDEX; index < grid.length; index += 1) {
    const row = grid[index];
    if (rowIsEmpty(row)) continue;
    const unreadable: string[] = [];
    const sourceRow = index + 1;
    const rawDate = row[c.documentDate];
    const parsedDate = parseDateCell(rawDate);
    if (!isBlank(rawDate) && parsedDate === null) unreadable.push("Date");
    rows.push({
      sourceRow,
      buyerRegistrationNo: idText(row[c.partyRegistrationNo]),
      buyerName: text(row[c.partyName]),
      buyerType: text(row[c.partyType]),
      originProvince: text(row[c.originProvince]),
      destinationProvince: text(row[c.destinationProvince]),
      documentType: text(row[c.documentType]),
      documentNo: text(row[c.documentNo]),
      documentDate: parsedDate,
      saleType: text(row[c.saleType]),
      rate: rateCell(row[c.rate]),
      valueExclTax: amountCell(
        row[c.value],
        "Value of Sales Excluding Sales Tax",
        unreadable,
      ),
      salesTax: amountCell(
        row[c.salesTax],
        "Sales Tax/ FED in ST Mode",
        unreadable,
      ),
      fixedOrRetailValue: amountCell(
        row[c.fixedOrRetailValue],
        "Fixed / Notified value or Retail Price",
        unreadable,
      ),
      extraTax: amountCell(row[c.extraTax], "Extra Tax", unreadable),
      furtherTax: amountCell(row[c.furtherTax], "Further Tax", unreadable),
      totalValuePfad: amountCell(
        row[c.totalValuePfad],
        "Total Value of Sales (In case of PFAD only)",
        unreadable,
      ),
      stWithheldAtSource: amountCell(
        row[c.stWithheld],
        "ST Withheld at Source",
        unreadable,
      ),
      exemptionSroNo: text(row[c.exemptionSroNo]),
      exemptionItemSrNo: text(row[c.exemptionItemSrNo]),
      invoiceRefNo: text(row[c.invoiceRefNo]),
      reason: text(row[c.reason]),
      petroleumLevyRate: text(row[c.petroleumLevyRate]),
      additionalSalesTaxRate: text(row[c.additionalSalesTaxRate]),
      unreadableFields: unreadable,
    });
    for (const field of unreadable) {
      opened.problems.push(
        makeProblem("row_unreadable_cell", "sales", sourceRow, { field }),
      );
    }
  }
  return {
    header: opened.header,
    rows,
    problems: opened.problems,
    readable: true,
  };
}

export function readPurchaseSheet(grid: CellGrid): PurchaseSheetResult {
  const opened = openSheet(
    grid,
    "purchases",
    PURCHASE_TEMPLATE,
    SUPPORTED_PURCHASE_TEMPLATE_VERSIONS,
    "DPI",
  );
  const rows: PurchaseInvoiceRow[] = [];
  if (!opened.readable) {
    return {
      header: opened.header,
      rows,
      problems: opened.problems,
      readable: false,
    };
  }
  const c = PURCHASE_COLUMNS;
  for (let index = FIRST_DATA_ROW_INDEX; index < grid.length; index += 1) {
    const row = grid[index];
    if (rowIsEmpty(row)) continue;
    const unreadable: string[] = [];
    const sourceRow = index + 1;
    const rawDate = row[c.documentDate];
    const parsedDate = parseDateCell(rawDate);
    if (!isBlank(rawDate) && parsedDate === null) unreadable.push("Date");
    rows.push({
      sourceRow,
      sellerRegistrationNo: idText(row[c.partyRegistrationNo]),
      sellerName: text(row[c.partyName]),
      sellerType: text(row[c.partyType]),
      originProvince: text(row[c.originProvince]),
      destinationProvince: text(row[c.destinationProvince]),
      documentType: text(row[c.documentType]),
      documentNo: text(row[c.documentNo]),
      documentDate: parsedDate,
      purchaseType: text(row[c.purchaseType]),
      rate: rateCell(row[c.rate]),
      valueExclTax: amountCell(row[c.value], "Value of Purchases", unreadable),
      salesTax: amountCell(
        row[c.salesTax],
        "Sales Tax/ FED in ST Mode",
        unreadable,
      ),
      fixedRetailValue: amountCell(
        row[c.fixedRetailValue],
        "Fixed Retail Value",
        unreadable,
      ),
      extraTax: amountCell(row[c.extraTax], "Extra Tax", unreadable),
      fedCharged: amountCell(row[c.fedCharged], "FED Charged", unreadable),
      stWithheldAsWhAgent: amountCell(
        row[c.stWithheld],
        "ST Withheld as WH Agent",
        unreadable,
      ),
      exemptionSroNo: text(row[c.exemptionSroNo]),
      exemptionItemSrNo: text(row[c.exemptionItemSrNo]),
      invoiceRefNo: text(row[c.invoiceRefNo]),
      reason: text(row[c.reason]),
      unreadableFields: unreadable,
    });
    for (const field of unreadable) {
      opened.problems.push(
        makeProblem("row_unreadable_cell", "purchases", sourceRow, { field }),
      );
    }
  }
  return {
    header: opened.header,
    rows,
    problems: opened.problems,
    readable: true,
  };
}
