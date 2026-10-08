/**
 * Opens an uploaded FBR invoice template (.xlsx or .xlsm) and returns the
 * cells of its SALES_INVOICES sheet, ready for the template reader.
 *
 * Server side only. Two things are done here that the reader relies on:
 *  - merged cells keep their value in the top-left cell only, like the
 *    reference headers, so the header check compares like with like;
 *  - dates become "YYYY-MM-DD" text, so the cells survive being stored as JSON.
 */

import { parseDateCell } from "./dates";
import type { CellGrid } from "./template-reader";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Invoice rows allowed in one file. Real months are far below this. */
export const MAX_DATA_ROWS = 20000;
const HEADER_ROWS = 5;
/** The full width of both templates, including the "Validation Details" column. */
const GRID_COLUMNS = 37;
const SHEET_NAME = "SALES_INVOICES";

export type WorkbookResult =
  | { ok: true; grid: CellGrid }
  | { ok: false; error: string };

const NOT_EXCEL =
  "This file could not be opened as an Excel file. Upload the invoice template you downloaded from IRIS (.xlsx or .xlsm).";

/** Turns whatever Excel stored in a cell into a plain string, number or null. */
function plainValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return parseDateCell(value);
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A formula: what matters is the value it shows.
    if ("result" in record) return plainValue(record.result);
    if ("formula" in record || "sharedFormula" in record) return null;
    if (Array.isArray(record.richText)) {
      return (record.richText as { text?: unknown }[])
        .map((part) => String(part?.text ?? ""))
        .join("");
    }
    if ("text" in record) return plainValue(record.text);
    if ("error" in record) return String(record.error);
  }
  return String(value);
}

export async function readInvoiceWorkbook(
  data: Uint8Array,
): Promise<WorkbookResult> {
  // Every .xlsx and .xlsm file is a zip archive.
  if (
    data.length < 4 ||
    data[0] !== 0x50 ||
    data[1] !== 0x4b ||
    data[2] !== 0x03 ||
    data[3] !== 0x04
  ) {
    return { ok: false, error: NOT_EXCEL };
  }

  let workbook: import("exceljs").Workbook;
  try {
    const { default: ExcelJS } = await import("exceljs");
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    return { ok: false, error: NOT_EXCEL };
  }

  const sheet = workbook.worksheets.find(
    (candidate) => candidate.name.trim().toUpperCase() === SHEET_NAME,
  );
  if (!sheet) {
    return {
      ok: false,
      error:
        "We could not find the SALES_INVOICES sheet in this file. Use the template from IRIS without renaming or removing its sheets.",
    };
  }

  const grid: CellGrid = [];
  let tooLong = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > HEADER_ROWS + MAX_DATA_ROWS) {
      // Only a row that really holds a value counts, not formatting.
      let hasValue = false;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (plainValue(cell.value) !== null && plainValue(cell.value) !== "") {
          hasValue = true;
        }
      });
      if (hasValue) tooLong = true;
      return;
    }
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (columnNumber > GRID_COLUMNS) return;
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
        return;
      }
      cells[columnNumber - 1] = plainValue(cell.value);
    });
    // Sparse rows become dense so every column index exists.
    grid[rowNumber - 1] = Array.from({ length: GRID_COLUMNS }, (_, index) =>
      cells[index] === undefined ? null : cells[index],
    );
  });

  if (tooLong) {
    return {
      ok: false,
      error: `This file has more than ${MAX_DATA_ROWS.toLocaleString("en-US")} invoice rows. Split the month into smaller files.`,
    };
  }
  for (let index = 0; index < grid.length; index += 1) {
    if (!grid[index]) grid[index] = [];
  }
  return { ok: true, grid };
}
