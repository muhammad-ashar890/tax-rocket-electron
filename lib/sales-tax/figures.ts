/**
 * The figures a sales tax return needs that are NOT in the invoice files:
 * the carried-over and adjustment lines, the section 8B answer, which
 * purchases are fixed assets, and the imports and exports of the month.
 *
 * The form holds text exactly as typed; validation turns it into paisa.
 * Nothing here guesses: a blank amount is zero, anything unreadable is an
 * error the user can read and fix.
 */

import { isValidIso } from "./dates";
import { toPaisa, type Paisa } from "./money";
import type { ExportRow, ImportRow, ReturnAdjustments } from "./types";

export type AdjustmentKey = keyof ReturnAdjustments;

export const ADJUSTMENT_FIELDS: {
  key: AdjustmentKey;
  sr: string;
  label: string;
  hint: string;
}[] = [
  {
    key: "creditBroughtForward",
    sr: "6",
    label: "Credit brought forward",
    hint: "Line 30 of last month's return (credit carried to this month).",
  },
  {
    key: "inadmissible6a",
    sr: "6a",
    label: "Inadmissible input tax",
    hint: "Input tax you cannot claim, section 8(1)(m).",
  },
  {
    key: "nonCreditable7",
    sr: "7",
    label: "Non-creditable input tax",
    hint: "Input tax on purchases used for exempt supplies.",
  },
  {
    key: "inadmissible7a",
    sr: "7a",
    label: "Inadmissible credit",
    hint: "Credit IRIS or the law does not allow, section 7(2)(i).",
  },
  {
    key: "allowance7b",
    sr: "7b",
    label: "Allowance of input credit",
    hint: "An allowance added to your input tax, if you have one.",
  },
  {
    key: "arrears23",
    sr: "23",
    label: "Arrears",
    hint: "Tax from earlier months you are paying now.",
  },
  {
    key: "refundClaimed29",
    sr: "29",
    label: "Refund claimed",
    hint: "Only if you are claiming a refund of unadjusted credit.",
  },
  {
    key: "taxPaidPreviousReturn36",
    sr: "36",
    label: "Tax already paid on this month's earlier return",
    hint: "Only for a revised return: what you paid on the first one.",
  },
];

export interface ReturnFigures {
  adjustments: ReturnAdjustments;
  /** Sr. 24: the business is excluded from the section 8B input tax limit. */
  excludedFrom8B: boolean;
  /** Row numbers of the purchases file that are fixed assets. */
  capitalGoodsRows: number[];
  imports: ImportRow[];
  exports: ExportRow[];
}

export interface ImportForm {
  gdNo: string;
  gdDate: string;
  taxableValue: string;
  salesTaxPaid: string;
  isCapitalGoods: boolean;
}

export interface ExportForm {
  documentNo: string;
  documentDate: string;
  valueExclTax: string;
}

export interface FiguresForm {
  adjustments: Record<AdjustmentKey, string>;
  excludedFrom8B: boolean;
  /** Row numbers typed as text, for example "7, 9". */
  capitalGoodsRows: string;
  imports: ImportForm[];
  exports: ExportForm[];
}

export const MAX_IMPORT_ROWS = 200;
export const MAX_EXPORT_ROWS = 200;
export const MAX_CAPITAL_ROWS = 500;
/** The first data row of both official templates. */
export const FIRST_DATA_ROW = 6;
/** Rs 1,000,000,000,000 in paisa: far beyond any real monthly return. */
export const MAX_FIGURE_PAISA = 100_000_000_000_000;

export function emptyAdjustments(): ReturnAdjustments {
  return {
    creditBroughtForward: 0,
    inadmissible6a: 0,
    nonCreditable7: 0,
    inadmissible7a: 0,
    allowance7b: 0,
    arrears23: 0,
    refundClaimed29: 0,
    taxPaidPreviousReturn36: 0,
  };
}

export function emptyFigures(): ReturnFigures {
  return {
    adjustments: emptyAdjustments(),
    excludedFrom8B: false,
    capitalGoodsRows: [],
    imports: [],
    exports: [],
  };
}

/** Plain number text for an input box: 1234.5 becomes "1234.50"; zero is blank. */
export function paisaToInput(paisa: Paisa, keepZero = false): string {
  if (paisa === 0 && !keepZero) return "";
  const sign = paisa < 0 ? "-" : "";
  const absolute = Math.abs(paisa);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function emptyFiguresForm(): FiguresForm {
  return figuresToForm(emptyFigures());
}

export function figuresToForm(figures: ReturnFigures): FiguresForm {
  const adjustments = {} as Record<AdjustmentKey, string>;
  for (const field of ADJUSTMENT_FIELDS) {
    adjustments[field.key] = paisaToInput(figures.adjustments[field.key]);
  }
  return {
    adjustments,
    excludedFrom8B: figures.excludedFrom8B,
    capitalGoodsRows: figures.capitalGoodsRows.join(", "),
    imports: figures.imports.map((row) => ({
      gdNo: row.gdNo,
      gdDate: row.gdDate ?? "",
      taxableValue: paisaToInput(row.taxableValue, true),
      salesTaxPaid: paisaToInput(row.salesTaxPaid, true),
      isCapitalGoods: Boolean(row.isCapitalGoods),
    })),
    exports: figures.exports.map((row) => ({
      documentNo: row.documentNo,
      documentDate: row.documentDate ?? "",
      valueExclTax: paisaToInput(row.valueExclTax, true),
    })),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isBlank(value: unknown): boolean {
  return text(value) === "";
}

type AmountResult = { ok: true; paisa: Paisa } | { ok: false; error: string };

function readAmount(value: unknown, label: string, allowBlank: boolean): AmountResult {
  if (isBlank(value)) {
    return allowBlank
      ? { ok: true, paisa: 0 }
      : { ok: false, error: `${label}: enter an amount in rupees (0 if there is none).` };
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return { ok: false, error: `${label}: enter an amount in rupees, for example 12,500.50.` };
  }
  const paisa = toPaisa(value);
  if (paisa === null) {
    return { ok: false, error: `${label}: "${String(value).trim().slice(0, 30)}" is not an amount. Use digits only, for example 12,500.50.` };
  }
  if (paisa < 0) return { ok: false, error: `${label}: the amount cannot be negative.` };
  if (paisa > MAX_FIGURE_PAISA) return { ok: false, error: `${label}: this amount is too large. Check the digits.` };
  return { ok: true, paisa };
}

function readDate(value: unknown, label: string): { ok: true; date: string | null } | { ok: false; error: string } {
  if (isBlank(value)) return { ok: true, date: null };
  const date = text(value);
  if (!isValidIso(date)) {
    return { ok: false, error: `${label}: enter the date as year-month-day, for example 2026-08-14.` };
  }
  return { ok: true, date };
}

export type FiguresResult =
  | { ok: true; value: ReturnFigures }
  | { ok: false; error: string };

/** Turns the typed form into figures, or says exactly what to correct. */
export function validateFiguresForm(input: unknown): FiguresResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Your figures could not be read. Please try again." };
  }
  const form = input as Partial<FiguresForm>;

  const adjustments = emptyAdjustments();
  const typed = (form.adjustments && typeof form.adjustments === "object" ? form.adjustments : {}) as Record<string, unknown>;
  for (const field of ADJUSTMENT_FIELDS) {
    const read = readAmount(typed[field.key], `Line ${field.sr} (${field.label})`, true);
    if (read.ok === false) return { ok: false, error: read.error };
    adjustments[field.key] = read.paisa;
  }

  const capitalGoodsRows: number[] = [];
  if (!isBlank(form.capitalGoodsRows)) {
    for (const part of text(form.capitalGoodsRows).split(/[,;\s]+/).filter(Boolean)) {
      if (!/^\d{1,7}$/.test(part)) {
        return { ok: false, error: `Fixed assets: "${part.slice(0, 20)}" is not a row number. Type row numbers from your purchases file, for example 7, 9.` };
      }
      const rowNumber = Number(part);
      if (rowNumber < FIRST_DATA_ROW) {
        return { ok: false, error: `Fixed assets: row ${rowNumber} is a heading row. Invoices start at row ${FIRST_DATA_ROW}.` };
      }
      if (!capitalGoodsRows.includes(rowNumber)) capitalGoodsRows.push(rowNumber);
    }
    if (capitalGoodsRows.length > MAX_CAPITAL_ROWS) {
      return { ok: false, error: `Fixed assets: list at most ${MAX_CAPITAL_ROWS} rows.` };
    }
    capitalGoodsRows.sort((a, b) => a - b);
  }

  const imports: ImportRow[] = [];
  const typedImports = Array.isArray(form.imports) ? form.imports : [];
  let importNumber = 0;
  for (const raw of typedImports) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Partial<ImportForm>;
    const empty =
      isBlank(row.gdNo) && isBlank(row.gdDate) && isBlank(row.taxableValue) && isBlank(row.salesTaxPaid) && !row.isCapitalGoods;
    if (empty) continue;
    importNumber += 1;
    if (importNumber > MAX_IMPORT_ROWS) {
      return { ok: false, error: `Imports: list at most ${MAX_IMPORT_ROWS} goods declarations.` };
    }
    const label = `Import ${importNumber}`;
    const gdNo = text(row.gdNo);
    if (!gdNo) return { ok: false, error: `${label}: enter the goods declaration (GD) number.` };
    if (gdNo.length > 40) return { ok: false, error: `${label}: the GD number is too long.` };
    const date = readDate(row.gdDate, `${label} date`);
    if (date.ok === false) return { ok: false, error: date.error };
    const value = readAmount(row.taxableValue, `${label} value`, false);
    if (value.ok === false) return { ok: false, error: value.error };
    const tax = readAmount(row.salesTaxPaid, `${label} sales tax paid`, false);
    if (tax.ok === false) return { ok: false, error: tax.error };
    imports.push({
      gdNo,
      gdDate: date.date,
      taxableValue: value.paisa,
      salesTaxPaid: tax.paisa,
      valueAdditionTaxPaid: 0,
      isCapitalGoods: Boolean(row.isCapitalGoods),
    });
  }

  const exportRows: ExportRow[] = [];
  const typedExports = Array.isArray(form.exports) ? form.exports : [];
  let exportNumber = 0;
  for (const raw of typedExports) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Partial<ExportForm>;
    if (isBlank(row.documentNo) && isBlank(row.documentDate) && isBlank(row.valueExclTax)) continue;
    exportNumber += 1;
    if (exportNumber > MAX_EXPORT_ROWS) {
      return { ok: false, error: `Exports: list at most ${MAX_EXPORT_ROWS} export documents.` };
    }
    const label = `Export ${exportNumber}`;
    const documentNo = text(row.documentNo);
    if (!documentNo) return { ok: false, error: `${label}: enter the export document number.` };
    if (documentNo.length > 40) return { ok: false, error: `${label}: the document number is too long.` };
    const date = readDate(row.documentDate, `${label} date`);
    if (date.ok === false) return { ok: false, error: date.error };
    const value = readAmount(row.valueExclTax, `${label} value`, false);
    if (value.ok === false) return { ok: false, error: value.error };
    exportRows.push({ documentNo, documentDate: date.date, valueExclTax: value.paisa });
  }

  return {
    ok: true,
    value: {
      adjustments,
      excludedFrom8B: form.excludedFrom8B === true,
      capitalGoodsRows,
      imports,
      exports: exportRows,
    },
  };
}

/**
 * Reads figures back from the database. Anything missing or damaged falls
 * back to "nothing entered", never to invented numbers.
 */
export function parseStoredFigures(stored: unknown): ReturnFigures {
  const fallback = emptyFigures();
  if (!stored || typeof stored !== "object") return fallback;
  const value = stored as Record<string, unknown>;
  const safe = (n: unknown): Paisa =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;

  const adjustments = emptyAdjustments();
  const storedAdjustments = (value.adjustments && typeof value.adjustments === "object" ? value.adjustments : {}) as Record<string, unknown>;
  for (const field of ADJUSTMENT_FIELDS) adjustments[field.key] = safe(storedAdjustments[field.key]);

  const rows = Array.isArray(value.capitalGoodsRows) ? value.capitalGoodsRows : [];
  const capitalGoodsRows = rows.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= FIRST_DATA_ROW,
  );

  const imports = (Array.isArray(value.imports) ? value.imports : [])
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .slice(0, MAX_IMPORT_ROWS)
    .map((row) => ({
      gdNo: typeof row.gdNo === "string" ? row.gdNo : "",
      gdDate: typeof row.gdDate === "string" && isValidIso(row.gdDate) ? row.gdDate : null,
      taxableValue: safe(row.taxableValue),
      salesTaxPaid: safe(row.salesTaxPaid),
      valueAdditionTaxPaid: 0,
      isCapitalGoods: row.isCapitalGoods === true,
    }));

  const exportRows = (Array.isArray(value.exports) ? value.exports : [])
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .slice(0, MAX_EXPORT_ROWS)
    .map((row) => ({
      documentNo: typeof row.documentNo === "string" ? row.documentNo : "",
      documentDate: typeof row.documentDate === "string" && isValidIso(row.documentDate) ? row.documentDate : null,
      valueExclTax: safe(row.valueExclTax),
    }));

  return {
    adjustments,
    excludedFrom8B: value.excludedFrom8B === true,
    capitalGoodsRows,
    imports,
    exports: exportRows,
  };
}
