/**
 * Rules catalog for FBR goods sales tax.
 *
 * Every row carries its legal section, the source it was read from, the date
 * range in which it applies and the date it was last checked against that
 * source. Numbers come from the Sales Tax Act 1990 (updated to 30-06-2026),
 * official FBR pages and the official IRIS invoice templates. Blogs never
 * supply a number here.
 *
 * Rows are read by date, never hard-coded in the engine, so a change in law
 * means adding a new dated row, not editing the engine.
 */

import type { IsoDate } from "../../types";

export type RuleUnit =
  | "fraction"
  | "percent"
  | "rupees"
  | "day_of_month"
  | "days"
  | "flag";

export interface SalesTaxRule {
  id: string;
  title: string;
  /** The legal section or page the rule comes from. */
  section: string;
  /** The document the rule was read from. */
  source: string;
  effectiveFrom: IsoDate;
  /** Null while the rule is still in force. */
  effectiveTo: IsoDate | null;
  /** The day this row was last compared with its source. */
  verifiedOn: IsoDate;
  unit: RuleUnit;
  value: number | boolean;
  notes?: string;
}

const ACT = "Sales Tax Act 1990 updated to 30-06-2026";
const FBR_DUE_PAGE =
  "FBR page Sales Tax Due Dates, https://www.fbr.gov.pk/sales-tax-due-dates/51148/101162";
const CHECKED = "2026-10-07";
/**
 * Used when the source states the rule as currently in force without giving
 * a start date. Such a row applies to every period up to its end date.
 */
const IN_FORCE_SINCE_UNKNOWN: IsoDate = "2000-01-01";

export const FBR_GOODS_RULES: SalesTaxRule[] = [
  {
    id: "fbr.rate.standard",
    title: "Standard rate of sales tax",
    section: "s.3(1)",
    source: `${ACT}, footnote 142: eighteen substituted for seventeen by Finance (Supplementary) Act 2023`,
    effectiveFrom: "2023-02-14",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "fraction",
    value: 0.18,
    notes: "Start date 14 February 2023 per the EY tax alert on the 2023 rate change.",
  },
  {
    id: "fbr.rate.further_tax",
    title: "Further tax on supplies to a person without a registration number or who is not an active taxpayer",
    section: "s.3(1A)",
    source: `${ACT}, footnote 148: four substituted for three by Finance Act 2023; footnote 147 adds the active taxpayer condition (Finance Act 2022)`,
    effectiveFrom: "2023-07-01",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "fraction",
    value: 0.04,
    notes:
      "The Federal Government may notify supplies on which further tax is not charged, so a missing further tax is only a warning. Start date assumes the Finance Act 2023 took effect on 1 July 2023.",
  },
  {
    id: "fbr.s8b.cap_percent",
    title: "Limit on input tax adjustment, as a percentage of output tax",
    section: "s.8B(1)",
    source: `${ACT}, section 8B(1)`,
    effectiveFrom: "2007-07-01",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "percent",
    value: 90,
    notes:
      "Since Finance Act 2026 the Board may reduce or enhance the limit for a registered person (third proviso to s.8B(1)), so the percentage is a per-client input and this row is only the default.",
  },
  {
    id: "fbr.s8b.capital_goods_outside_cap",
    title: "The 90% limit does not apply to fixed assets or capital goods",
    section: "s.8B(1) first proviso",
    source: `${ACT}, proviso substituted by Finance Act 2011`,
    effectiveFrom: "2011-07-01",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "flag",
    value: true,
  },
  {
    id: "fbr.due.annex_c_day",
    title: "Annex-C (sales annexure) due day of the following month",
    section: "FBR due dates page",
    source: FBR_DUE_PAGE,
    effectiveFrom: IN_FORCE_SINCE_UNKNOWN,
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "day_of_month",
    value: 10,
  },
  {
    id: "fbr.due.payment_day",
    title: "Payment of tax due day of the following month",
    section: "s.2(9) and Sales Tax Rules 2006",
    source: `${ACT} (due date is the 15th day of the month after the tax period); ${FBR_DUE_PAGE}`,
    effectiveFrom: IN_FORCE_SINCE_UNKNOWN,
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "day_of_month",
    value: 15,
  },
  {
    id: "fbr.due.return_day",
    title: "Electronic filing of the return, day of the following month",
    section: "Sales Tax Rules 2006, rule on due dates prescribed as the 15th",
    source: `Sales Tax Rules 2006 updated to 06-08-2025 (return submitted electronically by the 18th where the due date is the 15th); ${FBR_DUE_PAGE}`,
    effectiveFrom: IN_FORCE_SINCE_UNKNOWN,
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "day_of_month",
    value: 18,
    notes:
      "The Board can extend dates by notification. Extensions are entered as overrides in due-dates.ts with the SRO number.",
  },
  {
    id: "fbr.penalty.late_return.fixed",
    title: "Penalty for failing to furnish the return by the due date",
    section: "s.33 Table, serial 1",
    source: `${ACT}, footnote 484: fifty substituted through Finance Act 2026`,
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "rupees",
    value: 50000,
    notes:
      "Start date assumes the Finance Act 2026 took effect on 1 July 2026. Earlier amounts are not loaded because their source was not verified.",
  },
  {
    id: "fbr.penalty.late_return.per_day",
    title: "Penalty per day when the return is filed within ten days of the due date",
    section: "s.33 Table, serial 1 proviso",
    source: `${ACT}, footnote 487: thousand substituted through Finance Act 2026 (two thousand rupees for each day of default)`,
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "rupees",
    value: 2000,
  },
  {
    id: "fbr.penalty.late_return.per_day_window",
    title: "Number of days after the due date in which the per-day penalty applies",
    section: "s.33 Table, serial 1 proviso",
    source: `${ACT}, footnote 485: ten substituted for fifteen by Finance Act 2015`,
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "days",
    value: 10,
  },
  {
    id: "fbr.default_surcharge.annual_percent",
    title: "Default surcharge on unpaid tax, fixed annual rate",
    section: "s.34(1)(a)",
    source: `${ACT}, section 34(1)(a): twelve percent per annum or KIBOR plus three percent per annum, whichever is higher`,
    effectiveFrom: IN_FORCE_SINCE_UNKNOWN,
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "percent",
    value: 12,
  },
  {
    id: "fbr.default_surcharge.kibor_margin",
    title: "Default surcharge, margin added to KIBOR",
    section: "s.34(1)(a)",
    source: `${ACT}, section 34(1)(a)`,
    effectiveFrom: IN_FORCE_SINCE_UNKNOWN,
    effectiveTo: null,
    verifiedOn: CHECKED,
    unit: "percent",
    value: 3,
  },
];

/**
 * How each sale type in the official template is treated by the Phase 1
 * engine. Every sale type in the template must have an entry here, so when
 * FBR adds a new type the validation test fails until someone decides what to
 * do with it. "unsupported" means the month is refused, never guessed.
 */
export type SaleTypeTreatment =
  | "standard"
  | "reduced"
  | "zero_rated"
  | "exempt"
  | "third_schedule"
  | "unsupported";

const SUPPORTED_BY_NAME: Record<string, SaleTypeTreatment> = {
  "Goods at standard rate (default)": "standard",
  "Goods at Reduced Rate": "reduced",
  "Goods at zero-rate": "zero_rated",
  "Exempt goods": "exempt",
  "3rd Schedule Goods": "third_schedule",
};

export function saleTypeTreatment(saleType: string): SaleTypeTreatment {
  return SUPPORTED_BY_NAME[saleType] || "unsupported";
}

/** Names of the sale types the engine supports. */
export const SUPPORTED_SALE_TYPES = Object.keys(SUPPORTED_BY_NAME);

/** Rule ids the engine reads. The validation test checks every one exists. */
export const REQUIRED_RULE_IDS = [
  "fbr.rate.standard",
  "fbr.rate.further_tax",
  "fbr.s8b.cap_percent",
  "fbr.s8b.capital_goods_outside_cap",
  "fbr.due.annex_c_day",
  "fbr.due.payment_day",
  "fbr.due.return_day",
  "fbr.penalty.late_return.fixed",
  "fbr.penalty.late_return.per_day",
  "fbr.penalty.late_return.per_day_window",
  "fbr.default_surcharge.annual_percent",
  "fbr.default_surcharge.kibor_margin",
];

/** Returns the rule row in force on the given day, or null. */
export function findRule(
  id: string,
  asOf: IsoDate,
  rules: SalesTaxRule[] = FBR_GOODS_RULES,
): SalesTaxRule | null {
  const matches = rules.filter(
    (rule) =>
      rule.id === id &&
      rule.effectiveFrom <= asOf &&
      (rule.effectiveTo === null || rule.effectiveTo >= asOf),
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`Rule ${id} has overlapping rows on ${asOf}.`);
  }
  return matches[0];
}

/** Returns a numeric rule value, or null when no row is in force. */
export function findRuleNumber(
  id: string,
  asOf: IsoDate,
  rules: SalesTaxRule[] = FBR_GOODS_RULES,
): number | null {
  const rule = findRule(id, asOf, rules);
  if (!rule || typeof rule.value !== "number") return null;
  return rule.value;
}
