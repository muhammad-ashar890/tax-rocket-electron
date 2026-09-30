// Demo stand-in for your real `@/lib/tax/filing-drafts` module.
// Keep these union types identical in shape to your backend's real types
// when you copy this project's components back into your main codebase.

export type TaxIncomeSource =
  | "imports"
  | "salary"
  | "pension"
  | "property_rent"
  | "services"
  | "bank_profit"
  | "dividend"
  | "capital_gains"
  | "business"
  | "agriculture"
  | "foreign_income_assets"
  | "aop_company_links"
  | "sales_tax_fed_withholding"
  | "other_income"
  | "advance_tax";

export const TAX_ACTIVITY_SOURCES = ["imports", "advance_tax"] as const;

export function isTaxActivitySource(
  source: string,
): source is (typeof TAX_ACTIVITY_SOURCES)[number] {
  return (TAX_ACTIVITY_SOURCES as readonly string[]).includes(source);
}

export type TaxReadinessItem =
  | "cnic_ntn_ready"
  | "iris_credentials_ready"
  | "mobile_email_ready"
  | "previous_return_available"
  | "core_documents_ready";
