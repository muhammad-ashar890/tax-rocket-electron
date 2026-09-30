import type { TaxDraftMetadata } from "./draft-metadata";

// Demo stand-in for your real `@/lib/tax/simplified-eligibility` engine.
// Mirrors the same output shape (`isSimplifiedReturnEligible`,
// `supportedScope`, `eligibilityReasons`) so the wizard's route-preview
// sidebar behaves like it will against your real engine.

export function evaluateSimplifiedReturnEligibility(
  metadata: TaxDraftMetadata,
) {
  const reasons: string[] = [];
  let complex = false;
  let unsupported = false;

  const complexSources: string[] = [
    "imports",
    "advance_tax",
    "business",
    "capital_gains",
    "foreign_income_assets",
    "aop_company_links",
    "sales_tax_fed_withholding",
  ];
  const hasComplexSource = metadata.incomeSources.some((s) =>
    complexSources.includes(s),
  );

  if (hasComplexSource) {
    complex = true;
    reasons.push("One or more income sources require advanced schedules.");
  }

  if (metadata.hasForeignIncomeOrAssets === "yes") {
    complex = true;
    reasons.push("Foreign income or assets require additional disclosures.");
  }

  if (metadata.hasAopCompanyLink === "yes") {
    complex = true;
    reasons.push("AOP/company linkage adds review complexity.");
  }

  if (metadata.employerCount === "multiple") {
    reasons.push(
      "Multiple employers may need consolidated salary reconciliation.",
    );
  }

  if (metadata.hasServicesIncome === "yes" && !hasComplexSource) {
    reasons.push(
      "Freelance/services income needs invoice-based reconciliation.",
    );
  }

  if (
    !metadata.residencyStatus &&
    metadata.residencyDaysInPakistan !== "yes" &&
    metadata.residencyDaysInPakistan !== "no"
  ) {
    reasons.push("Residency status needs confirmation before final routing.");
  }

  if (metadata.incomeSources.length === 0) {
    return {
      isSimplifiedReturnEligible: false,
      supportedScope: false,
      eligibilityReasons: [],
    };
  }

  if (reasons.length === 0) {
    reasons.push(
      "Your income profile matches the simplified assisted filing pilot.",
    );
  }

  return {
    isSimplifiedReturnEligible: !complex && !unsupported,
    supportedScope: !unsupported,
    eligibilityReasons: reasons,
  };
}
