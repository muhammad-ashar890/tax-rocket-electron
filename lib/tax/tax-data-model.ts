export const TY2026_RULE_SET_VERSION = "TY2026-WHT-RATE-CARD-2025-06-30";

export const TAXPAYER_LIST_STATUSES = [
  "ATL",
  "NON_ATL",
  "LATE_FILER",
] as const;
export type TaxpayerListStatus = (typeof TAXPAYER_LIST_STATUSES)[number];

export const TAXPAYER_LIST_STATUS_SOURCES = ["MANUAL", "FBR"] as const;
export type TaxpayerListStatusSource =
  (typeof TAXPAYER_LIST_STATUS_SOURCES)[number];

export const INCOME_SELECTION_SOURCES = [
  "MANUAL",
  "DOCUMENT",
  "BANK_INTELLIGENCE",
] as const;
export type IncomeSelectionSource = (typeof INCOME_SELECTION_SOURCES)[number];

export const INCOME_RECORD_STATUSES = [
  "DRAFT",
  "NEEDS_REVIEW",
  "CONFIRMED",
] as const;
export type IncomeRecordStatus = (typeof INCOME_RECORD_STATUSES)[number];

export const TAX_RECORD_ORIGINS = [
  "MANUAL",
  "DOCUMENT",
  "BANK_INTELLIGENCE",
  "MERGED",
] as const;
export type TaxRecordOrigin = (typeof TAX_RECORD_ORIGINS)[number];

export const TAX_CREDIT_TREATMENTS = [
  "UNCONFIRMED",
  "ADJUSTABLE",
  "FINAL",
  "MINIMUM",
  "NON_CREDITABLE",
] as const;
export type TaxCreditTreatment = (typeof TAX_CREDIT_TREATMENTS)[number];

export const TAX_CREDIT_STATUSES = [
  "UNREVIEWED",
  "CONFIRMED",
  "REJECTED",
] as const;
export type TaxCreditStatus = (typeof TAX_CREDIT_STATUSES)[number];

export function isTaxpayerListStatus(
  value: unknown,
): value is TaxpayerListStatus {
  return (
    typeof value === "string" &&
    (TAXPAYER_LIST_STATUSES as readonly string[]).includes(value)
  );
}

export function isTaxpayerListStatusSource(
  value: unknown,
): value is TaxpayerListStatusSource {
  return (
    typeof value === "string" &&
    (TAXPAYER_LIST_STATUS_SOURCES as readonly string[]).includes(value)
  );
}

/** Manual status selector now includes LATE_FILER for 236C/K property rates. */
export function parseManualTaxpayerListStatus(
  value: unknown,
): Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER"> | null {
  return value === "ATL" || value === "NON_ATL" || value === "LATE_FILER"
    ? (value as Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">)
    : null;
}
