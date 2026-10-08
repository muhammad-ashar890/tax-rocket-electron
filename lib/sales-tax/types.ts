/**
 * Shared types for the sales tax engine (FBR goods).
 *
 * Phase 1 has no screens and no database. Everything here is plain data so
 * the engine can be tested on its own and wired to the app in a later phase.
 */

import type { Paisa } from "./money";

/** A calendar month, month is 1 to 12. */
export interface TaxPeriod {
  year: number;
  month: number;
}

/** A calendar day as a "YYYY-MM-DD" string. Strings avoid time zone drift. */
export type IsoDate = string;

export type DocumentKind =
  | "sale_invoice"
  | "credit_note"
  | "debit_note"
  | "purchase_invoice"
  | "withholding_document";

/** One row of the official Domestic Sales Invoices (DSI) template. */
export interface SalesInvoiceRow {
  /** Row number in the source sheet, used in messages. */
  sourceRow: number;
  buyerRegistrationNo: string;
  buyerName: string;
  /** One of the template's buyer types, as written in the template. */
  buyerType: string;
  originProvince: string;
  destinationProvince: string;
  /** The template's document type text, for example "Sale Invoice". */
  documentType: string;
  documentNo: string;
  documentDate: IsoDate | null;
  saleType: string;
  /** A fraction such as 0.18, or text such as "Exempt". */
  rate: number | string | null;
  valueExclTax: Paisa | null;
  salesTax: Paisa | null;
  /** Fixed, notified or retail price value, when the sale type needs it. */
  fixedOrRetailValue: Paisa | null;
  extraTax: Paisa | null;
  furtherTax: Paisa | null;
  /** Total value column used only for PFAD. */
  totalValuePfad: Paisa | null;
  stWithheldAtSource: Paisa | null;
  exemptionSroNo: string;
  exemptionItemSrNo: string;
  invoiceRefNo: string;
  reason: string;
  petroleumLevyRate: string;
  additionalSalesTaxRate: string;
  /** Names of cells that held text that is not an amount (set by the reader). */
  unreadableFields?: string[];
}

/** One row of the official Domestic Purchases Invoices (DPI) template. */
export interface PurchaseInvoiceRow {
  sourceRow: number;
  sellerRegistrationNo: string;
  sellerName: string;
  /** "Registered" or "Unregistered" as written in the template. */
  sellerType: string;
  originProvince: string;
  destinationProvince: string;
  documentType: string;
  documentNo: string;
  documentDate: IsoDate | null;
  purchaseType: string;
  rate: number | string | null;
  valueExclTax: Paisa | null;
  salesTax: Paisa | null;
  fixedRetailValue: Paisa | null;
  extraTax: Paisa | null;
  fedCharged: Paisa | null;
  stWithheldAsWhAgent: Paisa | null;
  exemptionSroNo: string;
  exemptionItemSrNo: string;
  invoiceRefNo: string;
  reason: string;
  /**
   * The official template has no column for fixed assets, so this flag is
   * set by the user in the app. Defaults to false.
   */
  isCapitalGoods?: boolean;
  /** Names of cells that held text that is not an amount (set by the reader). */
  unreadableFields?: string[];
}

/** An import goods declaration (Annex-B). IRIS loads these from customs data. */
export interface ImportRow {
  gdNo: string;
  gdDate: IsoDate | null;
  taxableValue: Paisa;
  salesTaxPaid: Paisa;
  /** Value addition tax on commercial imports. Not supported in Phase 1. */
  valueAdditionTaxPaid: Paisa;
  isCapitalGoods?: boolean;
}

/** An export (Annex-D). Exports are zero rated, so only the value matters. */
export interface ExportRow {
  documentNo: string;
  documentDate: IsoDate | null;
  valueExclTax: Paisa;
}

/**
 * Amounts the user supplies or carries over from the previous return.
 * Every field is paisa and defaults to zero.
 */
export interface ReturnAdjustments {
  /** Sr. 6, credit brought forward from the previous tax period. */
  creditBroughtForward: Paisa;
  /** Sr. 6a, inadmissible input tax, section 8(1)(m). */
  inadmissible6a: Paisa;
  /** Sr. 7, non-creditable inputs (exempt or non-taxed supplies). */
  nonCreditable7: Paisa;
  /** Sr. 7a, inadmissible credit, section 7(2)(i) read with 8(1)(l). */
  inadmissible7a: Paisa;
  /** Sr. 7b, allowance of input credit / reduction of output tax. */
  allowance7b: Paisa;
  /** Sr. 23, arrears (Annex-G). */
  arrears23: Paisa;
  /** Sr. 29, refund claimed. */
  refundClaimed29: Paisa;
  /** Sr. 36, tax paid on the normal return (revised return only). */
  taxPaidPreviousReturn36: Paisa;
}

export interface SectionEightB {
  /** Sr. 24: true when the person is excluded from the section 8B(1) cap. */
  excluded: boolean;
  /** The cap percentage for this person. The Act default is 90. */
  capPercent: number;
}

export interface ReturnInput {
  period: TaxPeriod;
  sales: SalesInvoiceRow[];
  purchases: PurchaseInvoiceRow[];
  imports: ImportRow[];
  exports: ExportRow[];
  adjustments?: Partial<ReturnAdjustments>;
  section8B?: Partial<SectionEightB>;
}

export type ProblemSeverity = "refuse" | "error" | "warning";

export type ProblemSheet =
  | "sales"
  | "purchases"
  | "imports"
  | "exports"
  | "template"
  | "return";

export interface SalesTaxProblem {
  code: string;
  severity: ProblemSeverity;
  sheet: ProblemSheet;
  /** Source sheet row number when the problem belongs to one row. */
  row: number | null;
  /** What happened and why it matters, in plain English. */
  message: string;
  /** What the user should do about it. */
  action: string;
}

export type LineStatus =
  | "computed"
  | "input"
  | "fixed_zero"
  | "estimate";

/** One line of the return as IRIS shows it. */
export interface ReturnLine {
  /** The serial number printed on the return, for example "9" or "23a". */
  sr: string;
  /** The IRIS amount code when it is confirmed from the official guide. */
  code: string | null;
  description: string;
  grossValue: Paisa | null;
  taxableValue: Paisa | null;
  salesTax: Paisa | null;
  status: LineStatus;
  /** Plain note shown next to the line, for example why it is an estimate. */
  note: string | null;
}

export interface ReturnResult {
  /** Always true. Every figure is an estimate; IRIS decides. */
  isEstimate: true;
  /** False when the month cannot be estimated (see problems). */
  canEstimate: boolean;
  period: TaxPeriod;
  problems: SalesTaxProblem[];
  /** Empty when canEstimate is false. */
  lines: ReturnLine[];
  /** Lines by serial number for quick lookup. */
  bySr: Record<string, ReturnLine>;
  /** Sr. 37, the balance payable (positive) or refundable (negative). */
  balancePayable: Paisa | null;
  /** The rule rows used, so a reviewer can see what the numbers rest on. */
  rulesUsed: string[];
}
