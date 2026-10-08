/**
 * What the user sees after uploading invoice files: how many invoices were
 * read, their totals, and the list of problems to fix. Pure: it works on the
 * stored cell grids, so it can run again whenever the checks change.
 */

import { prepareMonth } from "./prepare-month";
import {
  readPurchaseSheet,
  readSalesSheet,
  type CellGrid,
} from "./template-reader";
import { sumPaisa } from "./money";
import type { Paisa } from "./money";
import type { SalesTaxProblem, TaxPeriod } from "./types";

export type UploadKind = "SALES" | "PURCHASES";

export function isUploadKind(value: unknown): value is UploadKind {
  return value === "SALES" || value === "PURCHASES";
}

export interface SheetStats {
  readable: boolean;
  invoiceCount: number;
  /** Total value excluding sales tax, in paisa. */
  valuePaisa: Paisa;
  /** Total sales tax, in paisa. */
  taxPaisa: Paisa;
}

export interface UploadAnalysis {
  sales: SheetStats | null;
  purchases: SheetStats | null;
  /** Only problems with the files themselves; return-level notes come later. */
  problems: SalesTaxProblem[];
}

const FILE_LEVEL_SHEETS = new Set(["sales", "purchases", "template"]);

export function analyzeUploads(input: {
  registrationNo: string;
  period: TaxPeriod;
  salesGrid: CellGrid | null;
  purchaseGrid: CellGrid | null;
}): UploadAnalysis {
  const prepared = prepareMonth({
    registrationNo: input.registrationNo,
    period: input.period,
    salesGrid: input.salesGrid,
    purchaseGrid: input.purchaseGrid,
  });

  let sales: SheetStats | null = null;
  if (input.salesGrid) {
    const sheet = readSalesSheet(input.salesGrid);
    sales = {
      readable: sheet.readable,
      invoiceCount: sheet.rows.length,
      valuePaisa: sumPaisa(sheet.rows.map((row) => row.valueExclTax ?? 0)),
      taxPaisa: sumPaisa(sheet.rows.map((row) => row.salesTax ?? 0)),
    };
  }
  let purchases: SheetStats | null = null;
  if (input.purchaseGrid) {
    const sheet = readPurchaseSheet(input.purchaseGrid);
    purchases = {
      readable: sheet.readable,
      invoiceCount: sheet.rows.length,
      valuePaisa: sumPaisa(sheet.rows.map((row) => row.valueExclTax ?? 0)),
      taxPaisa: sumPaisa(sheet.rows.map((row) => row.salesTax ?? 0)),
    };
  }

  return {
    sales,
    purchases,
    problems: prepared.problems.filter((problem) =>
      FILE_LEVEL_SHEETS.has(problem.sheet),
    ),
  };
}
