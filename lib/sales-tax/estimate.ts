/**
 * From stored files and typed figures to the estimate the user reviews, and
 * from an approved estimate to the packet a later phase will work from.
 *
 * Pure: no database, no screens. The approval is only "current" while the
 * files and figures still produce the same fingerprint, so a changed file
 * can never ride on an old approval.
 */

import { createHash } from "crypto";

import { prepareMonth } from "./prepare-month";
import { readPurchaseSheet, type CellGrid } from "./template-reader";
import type { ReturnFigures } from "./figures";
import type { SalesTaxProblem, ReturnResult, TaxPeriod } from "./types";

export interface EstimateInput {
  registrationNo: string;
  period: TaxPeriod;
  salesGrid: CellGrid | null;
  purchaseGrid: CellGrid | null;
  figures: ReturnFigures;
}

export function buildEstimate(input: EstimateInput): ReturnResult {
  return prepareMonth({
    registrationNo: input.registrationNo,
    period: input.period,
    salesGrid: input.salesGrid,
    purchaseGrid: input.purchaseGrid,
    imports: input.figures.imports,
    exports: input.figures.exports,
    adjustments: input.figures.adjustments,
    section8B: { excluded: input.figures.excludedFrom8B },
    capitalGoodsRows: input.figures.capitalGoodsRows,
  });
}

/**
 * The rows marked as fixed assets must be real purchases from registered
 * suppliers; otherwise the mark would silently do nothing. Returns a message
 * for the user, or null when every row is fine.
 */
export function checkCapitalRows(
  purchaseGrid: CellGrid | null,
  rows: number[],
): string | null {
  if (rows.length === 0) return null;
  if (!purchaseGrid) {
    return "Fixed assets: you listed purchase rows, but no purchases file is uploaded. Upload it first or clear this box.";
  }
  const sheet = readPurchaseSheet(purchaseGrid);
  if (!sheet.readable) {
    return "Fixed assets: your purchases file could not be read. Fix the file first or clear this box.";
  }
  const byRow = new Map(sheet.rows.map((row) => [row.sourceRow, row]));
  for (const rowNumber of rows) {
    const row = byRow.get(rowNumber);
    if (!row) {
      return `Fixed assets: row ${rowNumber} is not an invoice in your purchases file. Check the row number.`;
    }
    if (row.sellerType !== "Registered") {
      return `Fixed assets: row ${rowNumber} is from an unregistered supplier, so it carries no input tax credit and cannot be a fixed asset here.`;
    }
  }
  return null;
}

export interface FileSummary {
  fileName: string;
  invoiceCount: number;
  valuePaisa: number;
  taxPaisa: number;
}

export interface ApprovalPacket {
  version: 1;
  approvedAt: string;
  authority: string;
  period: TaxPeriod;
  businessName: string;
  registrationNo: string;
  files: { sales: FileSummary | null; purchases: FileSummary | null };
  figures: ReturnFigures;
  lines: {
    sr: string;
    code: string | null;
    description: string;
    grossValue: number | null;
    taxableValue: number | null;
    salesTax: number | null;
    status: string;
  }[];
  balancePayable: number;
  warnings: SalesTaxProblem[];
  rulesUsed: string[];
  /** What the files and figures looked like at approval. */
  fingerprint: string;
}

/**
 * A short code that changes whenever anything behind the estimate changes.
 * It is a hash, because a big file can carry thousands of problems.
 */
export function fingerprintOf(input: {
  period: TaxPeriod;
  registrationNo: string;
  figures: ReturnFigures;
  files: { sales: FileSummary | null; purchases: FileSummary | null };
  result: ReturnResult;
}): string {
  const text = JSON.stringify({
    period: [input.period.year, input.period.month],
    registrationNo: input.registrationNo.replace(/\D/g, ""),
    figures: input.figures,
    files: input.files,
    canEstimate: input.result.canEstimate,
    lines: input.result.lines.map((line) => [
      line.sr,
      line.grossValue,
      line.taxableValue,
      line.salesTax,
    ]),
    balance: input.result.balancePayable,
    problems: input.result.problems.map((problem) => [problem.code, problem.row, problem.sheet]),
  });
  return createHash("sha256").update(text).digest("hex");
}

export type PacketResult =
  | { ok: true; packet: ApprovalPacket }
  | { ok: false; error: string };

export function buildApprovalPacket(input: {
  approvedAt: Date;
  authority: string;
  period: TaxPeriod;
  businessName: string;
  registrationNo: string;
  figures: ReturnFigures;
  files: { sales: FileSummary | null; purchases: FileSummary | null };
  result: ReturnResult;
}): PacketResult {
  if (!input.result.canEstimate || input.result.balancePayable === null) {
    return {
      ok: false,
      error: "This return cannot be approved yet. Fix the problems on the invoice check step first.",
    };
  }
  return {
    ok: true,
    packet: {
      version: 1,
      approvedAt: input.approvedAt.toISOString(),
      authority: input.authority,
      period: input.period,
      businessName: input.businessName,
      registrationNo: input.registrationNo,
      files: input.files,
      figures: input.figures,
      lines: input.result.lines.map((line) => ({
        sr: line.sr,
        code: line.code,
        description: line.description,
        grossValue: line.grossValue,
        taxableValue: line.taxableValue,
        salesTax: line.salesTax,
        status: line.status,
      })),
      balancePayable: input.result.balancePayable,
      warnings: input.result.problems,
      rulesUsed: input.result.rulesUsed,
      fingerprint: fingerprintOf({
        period: input.period,
        registrationNo: input.registrationNo,
        figures: input.figures,
        files: input.files,
        result: input.result,
      }),
    },
  };
}

/** True while the stored approval still matches the files and figures. */
export function isApprovalCurrent(
  stored: unknown,
  current: { fingerprint: string },
): boolean {
  if (!stored || typeof stored !== "object") return false;
  const fingerprint = (stored as { fingerprint?: unknown }).fingerprint;
  return typeof fingerprint === "string" && fingerprint === current.fingerprint;
}
