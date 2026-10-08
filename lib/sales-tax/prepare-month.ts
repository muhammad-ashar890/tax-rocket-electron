/**
 * One call from two template grids to an estimated return.
 *
 * Reads the sales and purchase templates, checks their headers against the
 * client and month, then runs the return engine. Problems from every stage
 * are merged into one list so the caller shows a single set of messages.
 */

import { computeSalesTaxReturn } from "./compute-return";
import { checkSheetHeader } from "./invoice-checks";
import {
  readPurchaseSheet,
  readSalesSheet,
  type CellGrid,
} from "./template-reader";
import { isValidPeriod } from "./dates";
import type {
  ExportRow,
  ImportRow,
  ReturnAdjustments,
  ReturnResult,
  SalesTaxProblem,
  SectionEightB,
  TaxPeriod,
} from "./types";

export interface PrepareMonthInput {
  /** The client's registration number as typed in the app. */
  registrationNo: string;
  period: TaxPeriod;
  /** Cells of the SALES_INVOICES sheet, or null when no sales file was given. */
  salesGrid: CellGrid | null;
  purchaseGrid: CellGrid | null;
  imports?: ImportRow[];
  exports?: ExportRow[];
  adjustments?: Partial<ReturnAdjustments>;
  section8B?: Partial<SectionEightB>;
  /** Purchase rows (by sheet row number) the user marked as fixed assets. */
  capitalGoodsRows?: number[];
}

export function prepareMonth(input: PrepareMonthInput): ReturnResult {
  if (!isValidPeriod(input.period)) {
    return computeSalesTaxReturn({
      period: input.period,
      sales: [],
      purchases: [],
      imports: [],
      exports: [],
    });
  }
  const readProblems: SalesTaxProblem[] = [];
  const owner = { registrationNo: input.registrationNo, period: input.period };

  let sales: ReturnType<typeof readSalesSheet>["rows"] = [];
  let purchases: ReturnType<typeof readPurchaseSheet>["rows"] = [];
  let unreadable = false;

  if (input.salesGrid) {
    const sheet = readSalesSheet(input.salesGrid);
    readProblems.push(...sheet.problems);
    if (sheet.readable) {
      readProblems.push(...checkSheetHeader(sheet.header, "sales", owner));
      sales = sheet.rows;
    } else {
      unreadable = true;
    }
  }
  if (input.purchaseGrid) {
    const sheet = readPurchaseSheet(input.purchaseGrid);
    readProblems.push(...sheet.problems);
    if (sheet.readable) {
      readProblems.push(...checkSheetHeader(sheet.header, "purchases", owner));
      const capital = new Set(input.capitalGoodsRows || []);
      purchases = sheet.rows.map((row) =>
        capital.has(row.sourceRow) ? { ...row, isCapitalGoods: true } : row,
      );
    } else {
      unreadable = true;
    }
  }

  const result = computeSalesTaxReturn({
    period: input.period,
    sales,
    purchases,
    imports: input.imports || [],
    exports: input.exports || [],
    adjustments: input.adjustments,
    section8B: input.section8B,
  });

  const merged = [...readProblems, ...result.problems];
  const stopped = merged.some(
    (p) => p.severity === "refuse" || p.severity === "error",
  );
  if (unreadable || stopped) {
    return {
      ...result,
      canEstimate: false,
      lines: [],
      bySr: {},
      balancePayable: null,
      problems: merged,
    };
  }
  return { ...result, problems: merged };
}
