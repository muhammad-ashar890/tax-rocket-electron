import {
  BadgeDollarSign,
  BadgePercent,
  Banknote,
  BriefcaseBusiness,
  Building2,
  Coins,
  FileCheck2,
  FileText,
  Globe2,
  HandCoins,
  Landmark,
  LaptopMinimal,
  Leaf,
  Link2,
  ReceiptText,
  Ship,
  type LucideIcon,
} from "lucide-react";

import type {
  TaxIncomeSource,
  TaxReadinessItem,
} from "@/lib/tax/filing-drafts";
import type { SetupStepKey } from "@/components/tax/filing/wizard-setup-step";
import { buildTaxDocumentSlotsPreview } from "@/lib/tax/document-requirements";

export type ReconciliationMethod = "auto" | "manual";

export type PipelineStepKey =
  | "documents"
  | "bank_intelligence"
  | "ledgers"
  | "reconciliation"
  | "pipeline_review"
  | "filing_packet"
  | "approval"
  | "fbr_connect";

export type StepKey = SetupStepKey | PipelineStepKey;

export const incomeSourceOptions = [
  { value: "salary", label: "Salary", icon: BriefcaseBusiness },
  { value: "pension", label: "Pension", icon: HandCoins },
  { value: "property_rent", label: "Rental Income", icon: Building2 },
  { value: "services", label: "Freelancer", icon: LaptopMinimal },
  { value: "bank_profit", label: "Bank Profit", icon: Landmark },
  { value: "dividend", label: "Dividend", icon: Banknote },
  { value: "capital_gains", label: "Capital Gains", icon: Coins },
  { value: "business", label: "Business Income", icon: BadgeDollarSign },
  { value: "agriculture", label: "Agriculture", icon: Leaf },
  { value: "foreign_income_assets", label: "Non-Resident", icon: Globe2 },
  { value: "aop_company_links", label: "AOP / Company", icon: Link2 },
  {
    value: "sales_tax_fed_withholding",
    label: "Sales Tax / FED",
    icon: ReceiptText,
  },
  { value: "other_income", label: "Other Income", icon: FileText },
  { value: "imports", label: "Imports", icon: Ship },
  { value: "advance_tax", label: "Advance Tax", icon: BadgePercent },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  icon: LucideIcon;
}>;

export const readinessOptions = [
  {
    value: "previous_return_available",
    label: "Previous Return",
    icon: FileCheck2,
  },
  { value: "core_documents_ready", label: "Core Documents", icon: FileText },
] as const;

export function computeDocumentSlots(input: {
  incomeSources: TaxIncomeSource[];
  readinessCompleted: TaxReadinessItem[];
}) {
  return buildTaxDocumentSlotsPreview({
    incomeSources: input.incomeSources,
    readinessCompleted: input.readinessCompleted,
  });
}

export const stepLabels: Record<StepKey, string> = {
  who: "Who's filing",
  structure: "Business type",
  income: "Income sources",
  bank_accounts: "Bank accounts",
  salary_split: "Salary share",
  tax_year: "Tax year",
  subcategory_imports: "Import categories",
  subcategory_pension: "Pension categories",
  subcategory_property_rent: "Rental categories",
  subcategory_services: "Services categories",
  subcategory_bank_profit: "Bank-profit categories",
  subcategory_dividend: "Dividend categories",
  subcategory_business: "Business categories",
  subcategory_foreign_income_assets: "Non-resident categories",
  subcategory_other_income: "Other-income categories",
  subcategory_advance_tax: "Advance-tax categories",
  readiness: "Readiness",
  documents: "Upload documents",
  review: "Review & create",
  bank_intelligence: "Bank Intelligence",
  ledgers: "ledgers",
  reconciliation: "Reconciliation",
  pipeline_review: "Review",
  filing_packet: "Filing Packet",
  approval: "Approval",
  fbr_connect: "FBR connect",
};

/** One income source priced by the most recent tax calculation. */
export type TaxBreakdownLine = {
  source: string;
  section: string;
  ruleId: string;
  income: number;
  baseTax: number;
  surcharge: number;
  taxDue: number;
  /** Charged under a final-tax section, so excess deduction is not refundable. */
  isFinalTax: boolean;
  rateShape: string;
  combinedRoutes?: { route: string; income: number }[];
};

export type FilingSummary = {
  income: number;
  expenses: number;
  assets: number;
  liabilities: number;
  ledgerEntryCount: number;
  documentCount: number;
  pendingDocumentCount: number;
  reconciliationStatus: string;
  reconciliationGap: number | null;
  taxableIncome: number | null;
  taxWithheld: number | null;
  taxPayable: number | null;
  refundDue: number | null;
  taxCalculationStatus: string;
  taxpayerListStatus: "ATL" | "NON_ATL" | "LATE_FILER" | null;
  /** Salary-certificate/ledger duplicate warning, recomputed on every summary load. */
  withholdingWarning: string | null;
  /** Per-source detail behind the totals above. */
  taxBreakdown?: TaxBreakdownLine[];
  finalTaxDue?: number;
  assessableTaxDue?: number;
  /**
   * Collection-route lines (imports, advance tax): tax already collected at
   * source, reported separately and never folded into the totals above.
   */
  collectionBreakdown?: TaxBreakdownLine[];
  collectionTaxDue?: number;
};

/**
 * What the packet could NOT put on IRIS, reported by `buildPortalFieldMap`
 * (lib/tax/portal-field-map.ts) and stored inside the packet snapshot. Kept as a
 * local structural type so this client-facing module does not import the server
 * mapper — the shape is asserted against it by scripts/verify-portal-field-map.cjs.
 */
export type PortalMappingGaps = {
  /** Ledger categories with no verified IRIS line item: nothing was queued for these. */
  unmappedCategories: {
    category: string;
    entryIds: string[];
    totalAmount: number;
    reason: string;
  }[];
  /** IRIS codes deliberately skipped because the row is computed, not entered. */
  skippedComputedCodes: { code: string; description: string; amount: number }[];
  /**
   * Codes with no captured proof that IRIS renders an ENTERABLE row for them
   * (as opposed to `skippedComputedCodes`, which are known to be computed).
   * These are manual entry today and become fillable the day a portal capture
   * proves the row — see `npm run inventory:portal-coverage`.
   */
  captureUnverified?: {
    code: string;
    description: string;
    category: string;
    amount: number;
    reason: string;
  }[];
  /**
   * Pension exempt/taxable splits from the engine that do not add up to the ledger
   * row they belong to. IRIS carries one figure on line 1008, so a disagreement is
   * reported rather than resolved silently. `difference` is derived here.
   */
  pensionSplitMismatch?: {
    entryId: string;
    ledgerAmount: number;
    engineSplitTotal: number;
  }[];
};

export type FilingPacketSummary = {
  id: string;
  version: number;
  packetHash: string;
  status: string;
  taxPayable: number;
  refundDue: number;
  pdfUrl?: string | null;
  createdAt: string | Date;
  /** Portal-mapping gaps for this packet version; absent on pre-1.1.0 packets. */
  mappingGaps?: PortalMappingGaps | null;
};

export type FilingActionResult = {
  success: boolean;
  draftId?: string;
  error?: string;
};

export type FilingWizardProps = {
  createAction: (formData: FormData) => Promise<FilingActionResult>;
  onAutoSave?: (snapshotFormData: FormData) => void;
  onSaveDraft?: (
    snapshotFormData: FormData,
  ) => Promise<FilingActionResult> | FilingActionResult | void;
  resumeDraftId?: string;
};
