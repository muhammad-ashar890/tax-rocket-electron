import type { TaxIncomeSource, TaxReadinessItem } from "./filing-drafts";

// Demo stand-in for your real `@/lib/tax/draft-metadata` module.
export type TaxDraftMetadata = {
  incomeSources: TaxIncomeSource[];
  readinessCompleted: TaxReadinessItem[];
  readinessMissing: TaxReadinessItem[];
  complexityScore: number;
  /** Explicit user choice used for IRIS setup; absent means context is incomplete. */
  residencyStatus?: "resident" | "non_resident";
  /** Legacy eligibility input retained for old callers only. */
  residencyDaysInPakistan?: "yes" | "no" | "unsure";
  employerCount?: "single" | "multiple" | "unsure";
  hasServicesIncome?: "yes" | "no" | "unsure";
  hasForeignIncomeOrAssets?: "yes" | "no" | "unsure";
  hasAopCompanyLink?: "yes" | "no" | "unsure";
  highProfitOnDebt?: "yes" | "no" | "unsure";
  filingIntent?: "original" | "revised" | "unsure";
};

export function parseTaxDraftMetadata(
  json: string | null,
): TaxDraftMetadata | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as TaxDraftMetadata;
  } catch {
    return null;
  }
}
