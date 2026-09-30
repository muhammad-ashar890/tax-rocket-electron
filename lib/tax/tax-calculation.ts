// File: lib/tax/tax-calculation.ts

import {
  TY2026_PENSION_RULES,
  TY2026_RATE_CARD_RULES,
  getTy2026RateCardRule,
} from "./rules/ty2026";
import type { RateCardRule, RateCardValue } from "./rules/rate-card-types";
import type { TaxpayerListStatus } from "./tax-data-model";

const TY2026_TAX_YEAR = 2026;

export type RentalRecipientKind = "INDIVIDUAL_OR_AOP" | "COMPANY";

/** The income routes this calculator can price from the TY2026 catalog. */
export type TaxRouteKey =
  | "salary"
  | "pension"
  | "property_rent"
  | "bank_profit"
  | "services"
  | "other_income"
  | "capital_gains"
  | "business"
  | "dividend"
  | "foreign_income_assets"
  | "imports"
  | "advance_tax"
  | "combined_slab";

/**
 * Routes whose lines price tax already collected at source rather than an
 * income-tax liability: Section 148 import collection and the advance-tax
 * sections (cash withdrawal, vehicles, utilities, property, auctions, ...).
 *
 * Collection lines are reported in `collectionBreakdown` with their own
 * `collectionTaxDue` subtotal. They are deliberately NOT added to the
 * income-tax `taxDue` and NOT auto-credited against payable/refund: the rate
 * card states the collectible amount, not the return treatment, so folding
 * them in would either double-count tax already paid or invent a refund.
 * The taxpayer claims them as credit with CPR/goods-declaration evidence.
 */
const COLLECTION_ROUTES: ReadonlySet<TaxRouteKey> = new Set([
  "imports",
  "advance_tax",
]);

function isCollectionRoute(route: TaxRouteKey): boolean {
  return COLLECTION_ROUTES.has(route);
}

/**
 * How a route's charge relates to the rest of the return.
 *
 * PROGRESSIVE routes are charged on a rising slab, so the rate that applies to
 * the last rupee depends on how much income sits beneath it. When two such
 * routes appear together the assessable ones share ONE slab read against
 * their combined taxable income (Division I of Part I reaches "taxable
 * income", and the Finance Act 2025 abolished rental's separate block), while
 * a pension charged as final tax stands apart and never enters the total
 * (Sections 12(2A) and 169). The FBR withholding rate card prices deduction
 * at source and does not state the assessment rule, so the combination itself
 * comes from the Ordinance and is cited as such on the combined line.
 *
 * FLAT routes are charged at a single percentage of their own amount. Nothing
 * about them changes when other income exists, so they combine with anything
 * without raising the aggregation question at all.
 *
 * FINAL is a separate axis from the above: it records whether the deduction
 * discharges the liability, which decides refundability rather than rate.
 */
export type TaxRateShape = "PROGRESSIVE" | "FLAT";

/** One priced line of a return. */
export type TaxRouteBreakdown = {
  route: TaxRouteKey;
  rateShape: TaxRateShape;
  /** Income attributed to this route. */
  income: number;
  /** Tax from the rate-card band before any surcharge. */
  baseTax: number;
  /** Surcharge charged on calculated tax for this route. */
  surcharge: number;
  /** baseTax + surcharge for this route. */
  taxDue: number;
  /**
   * True where the deduction discharges the liability, so an over-deduction is
   * not converted into an automatic refund claim.
   */
  isFinalTax: boolean;
  /** Catalog rule IDs used to price this line. */
  appliedRuleIds: string[];
  note: string;
  /**
   * Only on combined_slab lines: each contributing route and its income.
   * The joint slab has one computation, so per-route rule IDs cannot exist —
   * this list is the traceability record (section 30).
   */
  combinedRoutes?: { route: TaxRouteKey; income: number }[];
};

/**
 * Transaction-level inputs a route needs beyond the base amount. Income
 * routes price from the ledger alone and leave this empty; activity routes
 * and the composite dividend row read their declared figures from here.
 * Every field is optional at the type level, and each pricing helper refuses
 * with NEEDS_RULES when a figure it needs is missing or out of range.
 */
export type TaxRouteAttributes = {
  /** Engine capacity in cc, selecting vehicle bands. */
  engineCapacityCc?: number;
  /** Seat/person count, selecting per-seat passenger rows. */
  seatCount?: number;
  /** Laden weight in kg, selecting goods-transport rows. */
  ladenWeightKg?: number;
  /** Unit count for per-unit rows (workers, episodes, seconds). */
  unitQuantity?: number;
  /** Completed years since first registration (non-cc transfer taper). */
  vehicleAgeYears?: number;
  /** Debt-derived portion of a composite mutual-fund dividend. */
  debtPortion?: number;
  /** Equity-derived portion of a composite mutual-fund dividend. */
  equityPortion?: number;
  /** Customs C&F value in USD, banding mobile-phone imports. */
  cfValueUsd?: number;
  /** Whether an imported handset is a smartphone (matters at $30 or less). */
  isSmartphone?: boolean;
};

/** One income source handed to the calculator. */
export type TaxIncomeSource = {
  route: TaxRouteKey;
  income: number;
  /**
   * The catalog subcategory selected for this route.
   *
   * Routes whose section prices several different activities at different
   * percentages (services, other income) cannot be priced without it: Section
   * 153(1b) alone runs from 1.5% for advertising to 15% for unlisted services.
   * Guessing a row here would produce a confident, wrong number, so a route
   * that needs a subcategory and is given none reports NEEDS_RULES.
   *
   * Routes with a single catalogued row ignore this field.
   */
  subcategory?: string;
  /** Declared transaction figures; see `TaxRouteAttributes`. */
  attributes?: TaxRouteAttributes;
};

export type TaxCalculationResult = {
  status: "ESTIMATE" | "NEEDS_RULES";
  taxYear: number;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  taxableIncome: number | null;
  /** Tax from the rate-card band before any surcharge. */
  baseTax: number | null;
  /** Surcharge charged on calculated tax (never on gross income). */
  surcharge: number | null;
  /** baseTax + surcharge. */
  taxDue: number | null;
  taxPayable: number | null;
  refundDue: number | null;
  taxWithheld: number;
  /**
   * True only when every priced line is a final-tax route. On a mixed return
   * part of the liability is assessable, so this is false.
   */
  isFinalTax: boolean;
  /** Catalog rule IDs used, so a packet can cite the exact rate-card rows. */
  appliedRuleIds: string[];
  note: string;

  // ---- Per-source detail ---------------------------------------------------

  /**
   * Every income route priced in this estimate, in a stable order. All
   * headline totals (taxableIncome, baseTax, surcharge, taxDue, taxPayable,
   * refundDue) are summed from these lines alone.
   */
  breakdown: TaxRouteBreakdown[];
  /** Tax arising from routes whose deduction is final. */
  finalTaxDue: number;
  /** Tax arising from routes that remain assessable. */
  assessableTaxDue: number;
  /**
   * Withholding above the calculated liability on a MIXED return (both
   * final-tax and assessable lines). The excess may sit on either side and
   * final-side over-deduction is never refundable, so anything above 0 here
   * means the refund claim needs CPR verification. Always 0 on pure
   * (single-regime) returns. See NEEDS_RULES_IMPLEMENTATION.md section 29.
   */
  mixedExcessWithholding: number;
  /**
   * Collection-route lines (imports, advance tax), in a stable order. These
   * price tax already collected at source and are reported separately so
   * they can neither inflate the liability nor invent a refund.
   */
  collectionBreakdown: TaxRouteBreakdown[];
  /** Sum of the collection lines: tax collected at source. */
  collectionTaxDue: number;
};

type RouteComputation = {
  baseTax: number;
  surcharge: number;
  isFinalTax: boolean;
  appliedRuleIds: string[];
  note: string;
};

type RouteFailure = { error: string };

function isRouteFailure(
  value: RouteComputation | RouteFailure,
): value is RouteFailure {
  return "error" in value;
}

/**
 * Evaluates a single rate-card value against an amount.
 * Only the value kinds that this pilot calculator can safely compute are
 * handled; anything else returns null so the caller reports NEEDS_RULES
 * instead of inventing a number.
 */
function evaluateRateCardValue(
  value: RateCardValue,
  amount: number,
): number | null {
  switch (value.kind) {
    case "ZERO":
      return 0;
    case "PERCENT":
      return amount * (value.percent / 100);
    case "MARGINAL":
      return (
        value.baseTax + (amount - value.excessOver) * (value.percent / 100)
      );
    case "FIXED":
      return value.amount;
    default:
      // RANGE, COMPOSITE, REFERENCE, PER_UNIT and NOT_APPLICABLE all need
      // information the rate card does not supply on its own.
      return null;
  }
}

function matchesAmountCondition(
  candidate: RateCardRule,
  field: string,
  amount: number,
) {
  const condition = candidate.condition?.amount;
  if (!condition || condition.field !== field) return false;
  if (condition.minInclusive !== undefined && amount < condition.minInclusive) {
    return false;
  }
  if (
    condition.minExclusive !== undefined &&
    amount <= condition.minExclusive
  ) {
    return false;
  }
  if (condition.maxInclusive !== undefined && amount > condition.maxInclusive) {
    return false;
  }
  if (
    condition.maxExclusive !== undefined &&
    amount >= condition.maxExclusive
  ) {
    return false;
  }
  return true;
}

/**
 * Finds the single catalogued band that covers an amount. Returning null when
 * zero or multiple bands match keeps an ambiguous rate card from silently
 * picking the first row.
 */
function findBandRule(input: {
  section: string;
  subcategory: string;
  field: string;
  amount: number;
}): RateCardRule | null {
  const matches = TY2026_RATE_CARD_RULES.filter(
    (candidate) =>
      candidate.section === input.section &&
      candidate.subcategory === input.subcategory &&
      matchesAmountCondition(candidate, input.field, input.amount),
  );
  return matches.length === 1 ? matches[0] : null;
}

function selectStatusRate(
  candidate: RateCardRule,
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">,
): RateCardValue | null {
  // Late Filer: try LATE_FILER first, then ATL (filer), then DEFAULT
  // This matches FBR logic: late filer is still a filer, not non-filer
  if (filerStatus === "LATE_FILER") {
    return (
      candidate.rates.LATE_FILER ??
      candidate.rates.ATL ??
      candidate.rates.DEFAULT ??
      null
    );
  }
  return candidate.rates[filerStatus] ?? candidate.rates.DEFAULT ?? null;
}

/**
 * Surcharge is always charged on calculated tax, never on gross or taxable
 * income. The catalog enforces `basis: "CALCULATED_TAX"`, and this helper
 * refuses any other basis rather than applying it to the wrong figure.
 */
function calculateSurchargeOnTax(
  surchargeRule: RateCardRule | null,
  calculatedTax: number,
): number {
  const surcharge = surchargeRule?.surcharge;
  if (!surcharge) return 0;
  if (surcharge.basis !== "CALCULATED_TAX") return 0;
  return calculatedTax * (surcharge.percent / 100);
}

/**
 * Division I, clause (1) of Part I of the First Schedule: the slab table for
 * non-salaried individuals and AOPs (salary-head income NOT above 75% of
 * taxable income). This table is NOT on the FBR withholding rate card (the
 * card only carries the salaried clause-(2) table via Section 149), so the
 * bands are transcribed from the Income Tax Ordinance 2001 amended up to
 * 31.07.2025 (0/15/20/30/40/45%) and cross-checked against PwC's individual
 * summary; the combined line cites the Ordinance instead of a card row.
 * Limitation: an AOP professional firm gets a 40% cap on the top band, which
 * the engine cannot detect — the review note covers it.
 */
type DivisionIClause1Band = {
  /** Top of the band; null for the open top band. */
  max: number | null;
  /** Tax on everything below `over`. */
  base: number;
  /** Marginal percent above `over`. */
  percent: number;
  /** Threshold above which `percent` applies. */
  over: number;
};

const DIVISION_I_CLAUSE_1_BANDS: readonly DivisionIClause1Band[] = [
  { max: 600_000, base: 0, percent: 0, over: 0 },
  { max: 1_200_000, base: 0, percent: 15, over: 600_000 },
  { max: 1_600_000, base: 90_000, percent: 20, over: 1_200_000 },
  { max: 3_200_000, base: 170_000, percent: 30, over: 1_600_000 },
  { max: 5_600_000, base: 650_000, percent: 40, over: 3_200_000 },
  { max: null, base: 1_610_000, percent: 45, over: 5_600_000 },
];

/**
 * Prices the assessable slab routes jointly: salary, individual/AOP rental
 * and a pension taxed as salary share ONE slab read against their combined
 * taxable income. Division I clause (2) (the salaried table, the same bands
 * as Section 149) applies where salary-head income exceeds 75% of the total;
 * otherwise clause (1) above applies. The Section 4AB surcharge runs on the
 * combined figure above PKR 10 million at 9% where any salary-head income
 * exists, else 10%. Rental enters at gross rent because Section 15A
 * deductions need a professional's review, and the note says so.
 */
function computeCombinedSlabRoute(input: {
  combinedIncome: number;
  salaryHeadIncome: number;
  rentalIncome: number;
  labels: string[];
  includesWorkingPension: boolean;
}): RouteComputation | RouteFailure {
  const { combinedIncome, salaryHeadIncome } = input;
  if (!(combinedIncome > 0)) {
    return { error: "The combined slab needs a positive combined income." };
  }

  // "Exceeds seventy-five per cent" is strict; the cross-multiplied form
  // keeps the test exact at the boundary (3/4 either way).
  const readsSalariedTable = salaryHeadIncome * 4 > combinedIncome * 3;
  const salaryShare = Math.round((salaryHeadIncome / combinedIncome) * 100);

  const tableName = readsSalariedTable
    ? "the Division I clause (2) salaried table"
    : "the Division I clause (1) table";
  const testReading = readsSalariedTable
    ? "above the 75% test"
    : "at or below the 75% test";

  if (
    input.includesWorkingPension &&
    !getTy2026RateCardRule("TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE")
  ) {
    return {
      error: "The TY2026 pension former-employer rule is not catalogued.",
    };
  }
  const workingPensionIds = input.includesWorkingPension
    ? ["TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE"]
    : [];

  const headNote =
    `Pilot estimate combining ${input.labels.join(" and ")} into ` +
    `PKR ${Math.round(combinedIncome).toLocaleString()} of taxable income, read once against ` +
    `${tableName} (salary-head income is ${salaryShare}% of the total, ${testReading}). `;
  const rentalNote =
    input.rentalIncome > 0
      ? "Rental enters at gross rent; Section 15A deductions still require review. "
      : "";

  if (readsSalariedTable) {
    const priced = computeSalaryRoute(combinedIncome);
    if (isRouteFailure(priced)) return priced;
    const surchargeBit =
      priced.surcharge > 0
        ? "The 9% Section 4AB surcharge is charged on the calculated tax. "
        : "";
    return {
      ...priced,
      appliedRuleIds: [...workingPensionIds, ...priced.appliedRuleIds],
      note: `${headNote}${rentalNote}${surchargeBit}Credits, perquisites and deductions still require review.`,
    };
  }

  const band = DIVISION_I_CLAUSE_1_BANDS.find(
    (entry) => entry.max === null || combinedIncome <= entry.max,
  );
  if (!band) {
    return {
      error: "No Division I clause (1) band covers this taxable income.",
    };
  }
  const baseTax =
    band.base + (band.percent / 100) * (combinedIncome - band.over);
  // Section 4AB: 10% of the Division-I tax above PKR 10 million, or 9%
  // where the individual derives income under the head Salary.
  const surcharge =
    combinedIncome > 10_000_000
      ? baseTax * (salaryHeadIncome > 0 ? 0.09 : 0.1)
      : 0;
  return {
    baseTax,
    surcharge,
    isFinalTax: false,
    appliedRuleIds: workingPensionIds,
    note:
      `${headNote}${rentalNote}` +
      (combinedIncome > 10_000_000
        ? `A ${salaryHeadIncome > 0 ? "9" : "10"}% Section 4AB surcharge is charged on the calculated tax. `
        : "") +
      "Clause (1) bands are transcribed from the Income Tax Ordinance; credits and deductions still require review.",
  };
}

function computeSalaryRoute(
  taxableIncome: number,
): RouteComputation | RouteFailure {
  const band = findBandRule({
    section: "149",
    subcategory: "salary",
    field: "taxableIncome",
    amount: taxableIncome,
  });
  if (!band) {
    return { error: "No TY2026 salary band covers this taxable income." };
  }

  const rate = band.rates.DEFAULT;
  if (!rate) return { error: "The TY2026 salary band has no catalogued rate." };

  const baseTax = evaluateRateCardValue(rate, taxableIncome);
  if (baseTax === null) {
    return { error: "The TY2026 salary band rate cannot be calculated." };
  }

  // Section 149 read with the proviso to section 4AB: taxable income above
  // PKR 10 million attracts a 9% surcharge on the calculated tax.
  const surchargeRule = getTy2026RateCardRule(
    "TY2026-149-SALARY-SURCHARGE-ABOVE-10M",
  );
  const surchargeApplies =
    surchargeRule !== null &&
    matchesAmountCondition(surchargeRule, "taxableIncome", taxableIncome);
  const surcharge = surchargeApplies
    ? calculateSurchargeOnTax(surchargeRule, baseTax)
    : 0;

  const appliedRuleIds = [band.id];
  if (surchargeApplies && surchargeRule) appliedRuleIds.push(surchargeRule.id);

  return {
    baseTax,
    surcharge,
    isFinalTax: false,
    appliedRuleIds,
    note: surchargeApplies
      ? "Pilot estimate using TY2026 Section 149 salary slabs plus the 9% surcharge charged on calculated tax. Credits, perquisites and deductions still require review."
      : "Pilot estimate using TY2026 Section 149 salary slabs from the FBR WHT Rate Card. Credits, perquisites and deductions still require review.",
  };
}

function computePensionRoute(input: {
  annualPension: number;
  pensionerAgeBelow70?: boolean;
  pensionerAgeReason?: string;
  /**
   * Confirmed 70-or-above for the whole tax year. Section 12(2A)(i) exempts
   * these pensions outright; anything unconfirmed still refuses below.
   */
  pensionerAge70OrAbove?: boolean;
  /**
   * The former-employer row is a REFERENCE to Section 149 ("same as section
   * 149"): the pension is priced on the salary slabs instead of the
   * pension bands. Resolved here rather than in the generic evaluator so
   * the citation names both the referring row and the salary band used.
   */
  taxAsSalary?: boolean;
}): RouteComputation | RouteFailure {
  const { annualPension } = input;

  if (input.taxAsSalary === true) {
    const referenceRule = getTy2026RateCardRule(
      "TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE",
    );
    if (!referenceRule) {
      return { error: "The TY2026 pension former-employer rule is not catalogued." };
    }
    const salaryPriced = computeSalaryRoute(annualPension);
    if (isRouteFailure(salaryPriced)) return salaryPriced;
    return {
      ...salaryPriced,
      appliedRuleIds: [referenceRule.id, ...salaryPriced.appliedRuleIds],
      note:
        `The pensioner works for a former employer or its associate, so the TY2026 pension of ` +
        `PKR ${Math.round(annualPension).toLocaleString()} is priced on the Section 149 salary slabs ` +
        `(Section 149(IA) former-employer row). Credits, perquisites and deductions still require review.`,
    };
  }

  if (annualPension <= TY2026_PENSION_RULES.exemptUpTo) {
    const exemptRule = getTy2026RateCardRule("TY2026-149IA-PENSION-UP-TO-10M");
    return {
      baseTax: 0,
      surcharge: 0,
      isFinalTax: true,
      appliedRuleIds: exemptRule ? [exemptRule.id] : [],
      note: "TY2026 pension income up to PKR 10,000,000 is charged at 0% as a final tax (Section 149(IA) read with Section 12(2A)).",
    };
  }

  // Above PKR 10 million the rate card only states the treatment for a
  // pensioner below 70. Section 12(2A)(i) of the Ordinance covers the other
  // side: an individual who has attained 70 is not charged to tax on pension
  // income at all. Only a genuinely unconfirmed age still refuses.
  if (input.pensionerAge70OrAbove === true) {
    return {
      baseTax: 0,
      surcharge: 0,
      isFinalTax: false,
      appliedRuleIds: [],
      note:
        `TY2026 pension of PKR ${Math.round(annualPension).toLocaleString()} is exempt: ` +
        `Section 12(2A)(i) does not charge pension income to tax once the pensioner has attained 70.`,
    };
  }
  if (input.pensionerAgeBelow70 !== true) {
    return {
      error:
        input.pensionerAgeReason ??
        "Pension above PKR 10,000,000 needs a confirmed age: below 70 it is charged at 5% plus surcharge, at 70 or above it is exempt. Confirm the pensioner's age.",
    };
  }

  const band = getTy2026RateCardRule(
    "TY2026-149IA-PENSION-ABOVE-10M-BELOW-AGE-70",
  );
  if (!band?.rates.DEFAULT) {
    return { error: "The TY2026 pension rule is not catalogued." };
  }

  const baseTax = evaluateRateCardValue(band.rates.DEFAULT, annualPension);
  if (baseTax === null) {
    return { error: "The TY2026 pension rate cannot be calculated." };
  }

  const surcharge = calculateSurchargeOnTax(band, baseTax);

  return {
    baseTax,
    surcharge,
    isFinalTax: true,
    appliedRuleIds: [band.id],
    note: "Pilot estimate using TY2026 Section 149(IA): 5% on pension above PKR 10,000,000 as a final tax, plus a 10% surcharge charged on calculated tax.",
  };
}

function computeRentalRoute(input: {
  grossRent: number;
  recipientKind: RentalRecipientKind;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
}): RouteComputation | RouteFailure {
  if (input.recipientKind === "COMPANY") {
    const companyRule = getTy2026RateCardRule("TY2026-155-RENT-COMPANY");
    const rate = companyRule
      ? selectStatusRate(companyRule, input.filerStatus)
      : null;
    if (!companyRule || !rate) {
      return { error: "The TY2026 company rental rule is not catalogued." };
    }

    const baseTax = evaluateRateCardValue(rate, input.grossRent);
    if (baseTax === null) {
      return { error: "The TY2026 company rental rate cannot be calculated." };
    }

    return {
      baseTax,
      surcharge: 0,
      isFinalTax: false,
      appliedRuleIds: [companyRule.id],
      note: `Pilot estimate using the TY2026 Section 155 ${input.filerStatus} company rental rate. Deductions and final-return rules still require review.`,
    };
  }

  const band = findBandRule({
    section: "155",
    subcategory: "individual-aop",
    field: "grossRent",
    amount: input.grossRent,
  });
  if (!band?.rates.DEFAULT) {
    return { error: "No TY2026 individual/AOP rental band covers this rent." };
  }

  const baseTax = evaluateRateCardValue(band.rates.DEFAULT, input.grossRent);
  if (baseTax === null) {
    return { error: "The TY2026 rental band rate cannot be calculated." };
  }

  return {
    baseTax,
    surcharge: 0,
    isFinalTax: false,
    appliedRuleIds: [band.id],
    note: "Pilot estimate using TY2026 Section 155 individual/AOP rental slabs. Deductions and final-return rules still require review.",
  };
}

/**
 * Prices any route whose charge is a single percentage of its own amount.
 *
 * The route's identity comes entirely from `FLAT_ROUTE_DEFINITIONS`, so this
 * function never needs to know which route it is pricing. That is what keeps
 * a new flat route to one catalog entry instead of a new branch here.
 *
 * Every step that could go wrong returns a failure rather than a fallback: an
 * unrecognised subcategory, a subcategory the calculator has not been cleared
 * to price, a missing ATL/Non-ATL rate, or a rate the evaluator cannot compute
 * (RANGE, COMPOSITE and friends). A wrong tax number is worse than no number.
 */
function computeFlatRoute(input: {
  route: TaxRouteKey;
  income: number;
  subcategory: string | undefined;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  attributes?: TaxRouteAttributes;
}): RouteComputation | RouteFailure {
  const definition = FLAT_ROUTE_DEFINITIONS[input.route];
  if (!definition) {
    return { error: `Route ${input.route} is not catalogued as a flat route.` };
  }

  const label = ROUTE_LABELS[input.route];
  const available = TY2026_RATE_CARD_RULES.filter(
    (candidate) => candidate.source === definition.catalogSource,
  );

  // A single-row route needs no choice, so an omitted subcategory is fine
  // there. A multi-row route cannot be priced without knowing which row the
  // filing selected: Section 153(1b) alone spans 1.5% to 15%.
  let subcategory = input.subcategory;
  if (!subcategory) {
    if (definition.subcategories.length !== 1) {
      return {
        error:
          `TY2026 ${label} is charged at a different rate for each catalogued category, ` +
          `so the selected category is required before this route can be priced.`,
      };
    }
    subcategory = definition.subcategories[0];
  }

  if (!definition.subcategories.includes(subcategory)) {
    return {
      error:
        `The TY2026 ${label} category "${subcategory}" is not one this calculator prices. ` +
        `Confirmed rules are required before it can be included in an estimate.`,
    };
  }

  // Mobile-phone imports are fixed charges by C&F value band, not percentages
  // of income, so they dispatch to their own helper past the allowlist.
  if (
    input.route === "imports" &&
    (subcategory === "mobile-pct-8517-1219" ||
      subcategory === "mobile-pct-8517-1211")
  ) {
    return computeMobileImportRoute({
      subcategory,
      filerStatus: input.filerStatus,
      attributes: input.attributes,
    });
  }

  const matches = available.filter(
    (candidate) => candidate.subcategory === subcategory,
  );
  if (matches.length !== 1) {
    // Zero means the catalog and this definition have drifted apart. More than
    // one means the row is ambiguous, and picking the first would be a guess.
    return {
      error: `The TY2026 ${label} category "${subcategory}" does not resolve to exactly one rate-card row.`,
    };
  }

  const rule = matches[0];

  // Some rows only apply within an amount band — Sukuk held by an individual
  // or AOP is 12.5% above a PKR 1 million return and 10% below it. The band is
  // part of the rule's identity, so pricing income that falls outside it would
  // apply a rate the rate card does not give for that amount.
  const amountCondition = rule.condition?.amount;
  if (
    amountCondition &&
    !matchesAmountCondition(rule, amountCondition.field, input.income)
  ) {
    const sibling = available.find(
      (candidate) =>
        candidate.subcategory !== subcategory &&
        candidate.condition?.amount?.field === amountCondition.field &&
        matchesAmountCondition(
          candidate,
          amountCondition.field,
          input.income,
        ),
    );
    return {
      error:
        `The selected TY2026 ${label} category "${subcategory}" is only catalogued for a different amount band, ` +
        `so it cannot price PKR ${Math.round(input.income).toLocaleString()}.` +
        (sibling
          ? ` The rate card places this amount under "${sibling.subcategory}"; select that category and recalculate.`
          : ""),
    };
  }
  const rate = selectStatusRate(rule, input.filerStatus);
  if (!rate) {
    return {
      error: `No ${input.filerStatus} rate is catalogued for TY2026 ${label} (${subcategory}).`,
    };
  }

  // A COMPOSITE charge prices each declared portion at its own percentage.
  // The portions must be declared on the card and must add up to the priced
  // amount; anything else would price part of the income at the wrong rate.
  if (rate.kind === "COMPOSITE") {
    const portions = rate.components.map((component) => ({
      component,
      portion:
        component.basis === "DEBT_PORTION"
          ? input.attributes?.debtPortion
          : component.basis === "EQUITY_PORTION"
            ? input.attributes?.equityPortion
            : undefined,
    }));
    const missing = portions.some(
      (entry) =>
        entry.portion === undefined ||
        !Number.isFinite(entry.portion) ||
        entry.portion < 0,
    );
    if (missing) {
      return {
        error:
          `The TY2026 ${label} category "${subcategory}" is charged as ${rate.formula}, ` +
          `so declare the debt-derived and equity-derived portions on the card before it can be priced.`,
      };
    }
    const declared = portions.reduce(
      (total, entry) => total + (entry.portion as number),
      0,
    );
    if (Math.abs(declared - input.income) > 0.01) {
      return {
        error:
          `The declared TY2026 ${label} split adds up to PKR ${Math.round(declared).toLocaleString()} ` +
          `but the dividend income is PKR ${Math.round(input.income).toLocaleString()}. ` +
          `The portions must equal the dividend income before "${subcategory}" can be priced.`,
      };
    }
    const compositeTax = portions.reduce(
      (total, entry) =>
        total + (entry.portion as number) * (entry.component.percent / 100),
      0,
    );
    return {
      baseTax: compositeTax,
      surcharge: 0,
      isFinalTax: definition.isFinalTax,
      appliedRuleIds: [rule.id],
      note:
        `Pilot ${input.filerStatus} estimate for TY2026 ${definition.noteSubject} ` +
        `(${rule.label ?? subcategory}, Section ${rule.section}): ${rate.formula}. ` +
        `Final-return treatment still requires review.`,
    };
  }

  const baseTax = evaluateRateCardValue(rate, input.income);
  if (baseTax === null) {
    return {
      error: `The TY2026 ${label} rate for "${subcategory}" cannot be calculated from the rate card alone.`,
    };
  }

  const finalTaxNote = definition.isFinalTax
    ? ", treated as a final-tax route"
    : "";

  return {
    baseTax,
    surcharge: 0,
    isFinalTax: definition.isFinalTax,
    appliedRuleIds: [rule.id],
    note:
      `Pilot ${input.filerStatus} estimate for TY2026 ${definition.noteSubject} ` +
      `(${rule.label ?? subcategory}, Section ${rule.section})${finalTaxNote}. ` +
      `Final-return treatment still requires review.`,
  };
}

/**
 * Prices one advance-tax transaction from the TY2026 catalog.
 *
 * Unlike the flat routes, advance-tax rows are keyed by different facts: a
 * bill, a vehicle value plus engine capacity, a seat count, a laden weight,
 * a unit count. The base amount arrives as `income`; the selecting facts
 * arrive as `attributes`. Anything missing or out of range stops with
 * NEEDS_RULES and names the missing figure, and a case that lands outside
 * every band names the card to select instead of guessing a neighbour.
 *
 * Collection lines price tax already collected at source. They are always
 * reported separately from the income-tax liability (see
 * `calculateTaxEstimate`), so this helper never decides adjustability — it
 * only computes the collectible amount the rate card states.
 */
function computeAdvanceTaxRoute(input: {
  income: number;
  subcategory: string | undefined;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  attributes?: TaxRouteAttributes;
}): RouteComputation | RouteFailure {
  const { filerStatus } = input;
  const subcategory = input.subcategory;
  const attributes = input.attributes ?? {};
  const base = Math.max(0, input.income);

  if (!subcategory) {
    return {
      error:
        "TY2026 advance tax is charged at a different rate for each transaction category, " +
        "so the selected category is required before this route can be priced.",
    };
  }
  if (!ADVANCE_TAX_PRICED_SUBCATEGORIES.includes(subcategory)) {
    return {
      error:
        ADVANCE_TAX_UNPRICED_NOTES[subcategory] ??
        (`The TY2026 advance-tax category "${subcategory}" is not one this calculator prices. ` +
          `Confirmed rules are required before it can be included in an estimate.`),
    };
  }

  const priced = (
    rule: RateCardRule,
    baseTax: number,
    extraRuleIds: readonly string[] = [],
    extraNote = "",
  ): RouteComputation => ({
    baseTax,
    surcharge: 0,
    isFinalTax: false,
    appliedRuleIds: [rule.id, ...extraRuleIds],
    note:
      `Pilot ${filerStatus} advance-tax estimate for TY2026 ${rule.label} (Section ${rule.section}). ` +
      `Collected at source; claim as credit with the CPR or transaction evidence — ` +
      `it is not deducted from the income-tax payable automatically.${extraNote}`,
  });

  // Applies one resolved row to a tax base. A NOT_APPLICABLE rate is a
  // priced zero, not a refusal: the card explicitly leaves that status
  // outside the row (e.g. ATL cash withdrawals under Section 231AB).
  const finish = (
    rule: RateCardRule,
    taxBase: number,
    extraRuleIds: readonly string[] = [],
    extraNote = "",
  ): RouteComputation | RouteFailure => {
    const rate = selectStatusRate(rule, filerStatus);
    if (!rate) {
      return {
        error: `No ${filerStatus} rate is catalogued for ${rule.label} (Section ${rule.section}).`,
      };
    }
    if (rate.kind === "NOT_APPLICABLE") {
      return {
        baseTax: 0,
        surcharge: 0,
        isFinalTax: false,
        appliedRuleIds: [rule.id],
        note:
          `${rule.label} (Section ${rule.section}) does not apply to ${filerStatus}; ` +
          `no advance tax is charged.`,
      };
    }
    const tax = evaluateRateCardValue(rate, taxBase);
    if (tax === null) {
      return {
        error: `The TY2026 rate for ${rule.label} (Section ${rule.section}) cannot be calculated from the rate card alone.`,
      };
    }
    return priced(rule, tax, extraRuleIds, extraNote);
  };

  const singleRule = (): RateCardRule | RouteFailure => {
    const matches = TY2026_RATE_CARD_RULES.filter(
      (candidate) =>
        candidate.source === "advance_tax" &&
        candidate.subcategory === subcategory,
    );
    if (matches.length !== 1) {
      return {
        error: `The TY2026 advance-tax category "${subcategory}" does not resolve to exactly one rate-card row.`,
      };
    }
    return matches[0];
  };

  const requireEngineCapacity = (): number | RouteFailure => {
    const cc = attributes.engineCapacityCc;
    if (
      cc === undefined ||
      !Number.isFinite(cc) ||
      !Number.isInteger(cc) ||
      cc < 1
    ) {
      return {
        error:
          `Engine capacity in cc is required to select the vehicle band for "${subcategory}". ` +
          `Non-cc/electric vehicles use the non-cc card.`,
      };
    }
    return cc;
  };

  const requireUnitQuantity = (what: string): number | RouteFailure => {
    const count = attributes.unitQuantity;
    if (
      count === undefined ||
      !Number.isFinite(count) ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      return {
        error: `${what} is required before "${subcategory}" can be priced.`,
      };
    }
    return count;
  };

  // Section 231AB — cash withdrawal while not on ATL.
  if (subcategory === "cash-withdrawal") {
    const rule = singleRule();
    if ("error" in rule) return rule;
    return finish(rule, base);
  }

  // Section 231B(1)/(3) — percentage of vehicle value within a cc band.
  if (subcategory === "motor-vehicle-value") {
    const cc = requireEngineCapacity();
    if (typeof cc !== "number") return cc;
    const band = findBandRule({
      section: "231B",
      subcategory,
      field: "engineCapacityCc",
      amount: cc,
    });
    if (!band) {
      return {
        error: `No TY2026 Section 231B(1)/(3) band covers an engine capacity of ${cc} cc.`,
      };
    }
    return finish(
      band,
      base,
      [],
      ` Vehicle value PKR ${Math.round(base).toLocaleString()}, engine ${cc} cc.`,
    );
  }

  // Section 231B(2)/(2A) — fixed amount within a cc band.
  if (
    subcategory === "motor-vehicle-section-231b-2" ||
    subcategory === "motor-vehicle-section-231b-2a"
  ) {
    const cc = requireEngineCapacity();
    if (typeof cc !== "number") return cc;
    const band = findBandRule({
      section: "231B",
      subcategory,
      field: "engineCapacityCc",
      amount: cc,
    });
    const sectionLabel =
      subcategory === "motor-vehicle-section-231b-2"
        ? "231B(2)"
        : "231B(2A)";
    if (!band) {
      return {
        error: `No TY2026 Section ${sectionLabel} band covers an engine capacity of ${cc} cc.`,
      };
    }
    return finish(band, 0, [], ` Engine ${cc} cc.`);
  }

  // Section 231B endnote 1 — non-cc registration and sale: 3% of the
  // import/invoice/auction value at Rs 5m or more. The endnote states a
  // single value; the Tenth Schedule proviso raises ALL Section 231B
  // collection by 200% for non-ATL, so non-ATL pays 9% (Moore Shekha Mufti
  // charts the same 3%/9% split).
  if (subcategory === "motor-vehicle-non-cc-value-5m-or-more") {
    if (base < 5_000_000) {
      return {
        error:
          "The non-cc 3% rate applies only where the vehicle value is Rs 5,000,000 or more. " +
          "Below that no rate is set; confirm with the excise office what will be collected.",
      };
    }
    const rule = singleRule();
    if ("error" in rule) return rule;
    const percent = filerStatus === "NON_ATL" ? 9 : 3;
    return priced(
      rule,
      (base * percent) / 100,
      [],
      ` Vehicle value PKR ${Math.round(base).toLocaleString()} at ${percent}%` +
        (filerStatus === "NON_ATL"
          ? " (3% raised 3x by the Tenth Schedule proviso on Section 231B)."
          : " per rate-card endnote 1."),
    );
  }

  // Section 231B(2) endnote 2 — fixed Rs 20,000 transfer charge at Rs 5m or
  // more, reduced by 10% for each completed year from first registration
  // (compounded: 20,000 x 0.9^n), tripled to Rs 60,000 for non-ATL by the
  // same Tenth Schedule proviso.
  if (subcategory === "motor-vehicle-non-cc-fixed") {
    if (base < 5_000_000) {
      return {
        error:
          "The non-cc Rs 20,000 transfer charge applies only where the vehicle value is " +
          "Rs 5,000,000 or more. Below that no rate is set; confirm with the excise office " +
          "what will be collected.",
      };
    }
    const years = attributes.vehicleAgeYears;
    if (
      years === undefined ||
      !Number.isFinite(years) ||
      !Number.isInteger(years) ||
      years < 0
    ) {
      return {
        error:
          "Completed whole years since first registration in Pakistan are required " +
          "before the non-cc transfer charge can be priced (0 for the first year).",
      };
    }
    const rule = singleRule();
    if ("error" in rule) return rule;
    const baseAmount = filerStatus === "NON_ATL" ? 60_000 : 20_000;
    return priced(
      rule,
      baseAmount * Math.pow(0.9, years),
      [],
      ` Rs ${baseAmount.toLocaleString()} reduced 10% per year over ${years} completed year(s) from first registration` +
        (filerStatus === "NON_ATL"
          ? " (Rs 20,000 raised 3x by the Tenth Schedule proviso on Section 231B)."
          : "."),
    );
  }

  // Section 231C — fixed per worker.
  if (subcategory === "foreign-domestic-worker") {
    const count = requireUnitQuantity(
      "The number of foreign domestic workers",
    );
    if (typeof count !== "number") return count;
    const rule = singleRule();
    if ("error" in rule) return rule;
    const single = finish(rule, 0);
    if (isRouteFailure(single)) return single;
    return {
      ...single,
      baseTax: single.baseTax * count,
      note: `${single.note} ${count} worker(s).`,
    };
  }

  // Section 234 — goods transport at Rs 2.50 per kg up to 8,120 kg. Above
  // that the card charges a fixed Rs 1,200 instead, so the two rows are
  // alternatives and the selection decides; landing on the wrong one names
  // the right card rather than double-charging.
  if (subcategory === "goods-transport-vehicle") {
    const kg = attributes.ladenWeightKg;
    if (kg === undefined || !Number.isFinite(kg) || kg <= 0) {
      return {
        error:
          'Laden weight in kg is required before Section 234 goods transport can be priced.',
      };
    }
    if (kg > 8_120) {
      return {
        error:
          "Above 8,120 kg laden weight the rate card charges a fixed Rs 1,200 instead of the per-kg rate. " +
          "Select the goods-transport-vehicle-above-8120kg category and recalculate.",
      };
    }
    const rule = singleRule();
    if ("error" in rule) return rule;
    const rate = selectStatusRate(rule, filerStatus);
    if (!rate || rate.kind !== "PER_UNIT") {
      return {
        error:
          "The TY2026 Section 234 per-kg row is not catalogued as a per-unit rate.",
      };
    }
    return priced(
      rule,
      rate.amount * kg,
      [],
      ` Rs ${rate.amount} × ${kg.toLocaleString()} kg laden weight.`,
    );
  }

  if (subcategory === "goods-transport-vehicle-above-8120kg") {
    const kg = attributes.ladenWeightKg;
    if (kg === undefined || !Number.isFinite(kg) || kg <= 0) {
      return {
        error:
          'Laden weight in kg is required before Section 234 goods transport can be priced.',
      };
    }
    if (kg <= 8_120) {
      return {
        error:
          `The fixed Rs 1,200 row covers laden weight above 8,120 kg only. ` +
          `For ${kg.toLocaleString()} kg select the goods-transport-vehicle (per-kg) category and recalculate.`,
      };
    }
    const rule = singleRule();
    if ("error" in rule) return rule;
    return finish(rule, 0, [], ` Laden weight ${kg.toLocaleString()} kg.`);
  }

  // Section 234 — passenger rows are fixed per seat within a seat band.
  if (subcategory === "passenger-transport-per-seat") {
    const seats = attributes.seatCount;
    if (
      seats === undefined ||
      !Number.isFinite(seats) ||
      !Number.isInteger(seats) ||
      seats < 1
    ) {
      return {
        error:
          "The seat/person count is required before Section 234 passenger transport can be priced.",
      };
    }
    const band = findBandRule({
      section: "234",
      subcategory,
      field: "seatCount",
      amount: seats,
    });
    if (!band) {
      return {
        error: `No TY2026 Section 234 per-seat band covers ${seats} persons; the card rows start at 4 persons.`,
      };
    }
    const rate = selectStatusRate(band, filerStatus);
    if (!rate || rate.kind !== "FIXED") {
      return {
        error:
          "The TY2026 Section 234 per-seat band is not catalogued as a fixed per-seat amount.",
      };
    }
    return priced(
      band,
      rate.amount * seats,
      [],
      ` Rs ${rate.amount.toLocaleString()} × ${seats} seat(s).`,
    );
  }

  // Section 234 — private-vehicle annual and lump-sum rows by cc band.
  if (
    subcategory === "motor-vehicle-annual" ||
    subcategory === "motor-vehicle-lump-sum"
  ) {
    const cc = requireEngineCapacity();
    if (typeof cc !== "number") return cc;
    const band = findBandRule({
      section: "234",
      subcategory,
      field: "engineCapacityCc",
      amount: cc,
    });
    if (!band) {
      return {
        error: `No TY2026 Section 234 band covers an engine capacity of ${cc} cc.`,
      };
    }
    return finish(band, 0, [], ` Engine ${cc} cc.`);
  }

  // Section 235 — the shared commercial/industrial band runs to Rs 20,000;
  // above that each consumer type reads its own marginal row.
  if (subcategory === "electricity-commercial-industrial") {
    const band = findBandRule({
      section: "235",
      subcategory,
      field: "grossBill",
      amount: base,
    });
    if (!band) {
      return {
        error:
          "Above Rs 20,000 commercial and industrial electricity bills are charged at different rates. " +
          "Select the electricity-commercial or electricity-industrial category and recalculate.",
      };
    }
    return finish(band, base);
  }

  if (
    subcategory === "electricity-commercial" ||
    subcategory === "electricity-industrial"
  ) {
    const own = singleRule();
    if ("error" in own) return own;
    if (base > 20_000) return finish(own, base);
    // Bills up to Rs 20,000 share one band across both consumer types, so
    // the shared row prices them and both rows are cited.
    const shared = findBandRule({
      section: "235",
      subcategory: "electricity-commercial-industrial",
      field: "grossBill",
      amount: base,
    });
    if (!shared) {
      return {
        error: `No TY2026 Section 235 band covers a bill of PKR ${Math.round(base).toLocaleString()}.`,
      };
    }
    return finish(
      shared,
      base,
      [own.id],
      " Bills up to Rs 20,000 share one commercial/industrial band.",
    );
  }

  // Section 235 — domestic rows cover non-ATL consumers only; an ATL
  // consumer prices to zero through the catalogued NOT_APPLICABLE rate.
  if (subcategory === "electricity-domestic-non-atl") {
    const band = findBandRule({
      section: "235",
      subcategory,
      field: "monthlyBill",
      amount: base,
    });
    if (!band) {
      return {
        error: `No TY2026 Section 235 domestic band covers a bill of PKR ${Math.round(base).toLocaleString()}.`,
      };
    }
    return finish(band, base);
  }

  // Section 236 — landline is charged on the bill above Rs 1,000.
  if (subcategory === "landline-telephone") {
    const rule = singleRule();
    if ("error" in rule) return rule;
    if (base <= 1_000) {
      return {
        baseTax: 0,
        surcharge: 0,
        isFinalTax: false,
        appliedRuleIds: [rule.id],
        note:
          `Landline bill of PKR ${Math.round(base).toLocaleString()} does not exceed Rs 1,000, ` +
          `so no Section 236 charge applies.`,
      };
    }
    return finish(rule, base);
  }

  if (subcategory === "internet-mobile-prepaid") {
    const rule = singleRule();
    if ("error" in rule) return rule;
    return finish(rule, base);
  }

  // Sections 236A, 236CB, 236Y — straight percentages of the stated base.
  if (
    subcategory === "public-auction-movable-or-other" ||
    subcategory === "public-auction-immovable-or-railways" ||
    subcategory === "function-gathering" ||
    subcategory === "card-remittance-abroad"
  ) {
    const rule = singleRule();
    if ("error" in rule) return rule;
    return finish(rule, base);
  }

  // Sections 236C, 236K — percentages within consideration/value bands,
  // including the card's late-filer rates.
  if (subcategory === "immovable-property-transfer") {
    const band = findBandRule({
      section: "236C",
      subcategory,
      field: "grossConsiderationReceived",
      amount: base,
    });
    if (!band) {
      return {
        error: `No TY2026 Section 236C band covers a consideration of PKR ${Math.round(base).toLocaleString()}.`,
      };
    }
    return finish(band, base);
  }

  if (subcategory === "immovable-property-purchase") {
    const band = findBandRule({
      section: "236K",
      subcategory,
      field: "fairMarketValue",
      amount: base,
    });
    if (!band) {
      return {
        error: `No TY2026 Section 236K band covers a fair market value of PKR ${Math.round(base).toLocaleString()}.`,
      };
    }
    return finish(band, base);
  }

  // Section 236CA — fixed per episode/second, except the single-episode
  // play which is one fixed charge.
  if (subcategory === "foreign-tv-serial") {
    const count = requireUnitQuantity("The number of episodes");
    if (typeof count !== "number") return count;
    const rule = singleRule();
    if ("error" in rule) return rule;
    const single = finish(rule, 0);
    if (isRouteFailure(single)) return single;
    return {
      ...single,
      baseTax: single.baseTax * count,
      note: `${single.note} ${count} episode(s).`,
    };
  }

  if (subcategory === "foreign-tv-play-single-episode") {
    const rule = singleRule();
    if ("error" in rule) return rule;
    return finish(rule, 0);
  }

  if (subcategory === "advertisement-foreign-actor") {
    const count = requireUnitQuantity("The duration in seconds");
    if (typeof count !== "number") return count;
    const rule = singleRule();
    if ("error" in rule) return rule;
    const single = finish(rule, 0);
    if (isRouteFailure(single)) return single;
    return {
      ...single,
      baseTax: single.baseTax * count,
      note: `${single.note} ${count} second(s).`,
    };
  }

  // Exhaustiveness guard: the allowlist above and these branches must stay
  // in step. A subcategory cleared to price but handled by no branch stops
  // the estimate rather than falling through silently.
  return {
    error: `The TY2026 advance-tax category "${subcategory}" is not implemented.`,
  };
}

/**
 * Routes that are a plain percentage of their own amount, described as data.
 *
 * Everything these routes need is already in the rate card: pick the row the
 * filing selected, read the ATL or Non-ATL percentage, multiply. There is no
 * per-route formula to write, so adding another flat route is one entry in
 * this catalog rather than a new branch in the pricing loop.
 *
 * `catalogSource` is the `source` field on the rate-card rules, and
 * `subcategories` lists exactly which rows this calculator will price. A row
 * absent from that list is not silently priced with a sibling's rate; the
 * estimate stops with NEEDS_RULES instead.
 *
 * `isFinalTax` is stated per route rather than inferred. The rate card prices
 * deduction at source and does not say whether a deduction discharges the
 * liability, so treating a route as final is a decision, not a derivation.
 */
type FlatRouteDefinition = {
  catalogSource: string;
  /** Catalog subcategories this calculator will price, in display order. */
  subcategories: readonly string[];
  /**
   * Whether deduction under this route discharges the liability. Only Section
   * 151 profit on debt is treated as final here; every other route below stays
   * assessable, which is the safer default because it keeps the amount inside
   * the refundable pool rather than writing off a client's refund claim.
   */
  isFinalTax: boolean;
  /** Sentence fragment naming the charge, used in the estimate note. */
  noteSubject: string;
};

const FLAT_ROUTE_DEFINITIONS: Partial<
  Record<TaxRouteKey, FlatRouteDefinition>
> = {
  // Section 151: a single percentage of the profit paid.
  bank_profit: {
    catalogSource: "bank_profit",
    subcategories: [
      "bank-or-financial-institution-deposit",
      "government-securities-non-individual",
      "other-profit-on-debt",
      "sukuk-company",
      // The two individual/AOP Sukuk rows are split by a PKR 1 million band on
      // the return itself, which computeFlatRoute enforces before pricing.
      "sukuk-individual-aop-above-1m",
      "sukuk-individual-aop-below-1m",
    ],
    // Deducted as a final tax, so excess withholding is not turned into an
    // automatic refund.
    isFinalTax: true,
    noteSubject: "Section 151 bank profit",
  },
  // Section 152 — payments to non-residents. Nineteen catalogued rows.
  //
  // Twelve of them (sub-sections 1 through 1DB) carry a SINGLE rate on the
  // rate card: the Non-ATL column is blank, so a filer and a non-filer are
  // charged identically. That is the card's own position, not a gap here, and
  // it is confirmed with the client. The remaining seven rows, all under
  // 152(2A), do split ATL from Non-ATL.
  //
  // The two individual/AOP Sukuk rows under 1DB are split by a PKR 1 million
  // band on the return itself, which computeFlatRoute enforces before pricing.
  foreign_income_assets: {
    catalogSource: "foreign_income_assets",
    subcategories: [
      "1",
      "1a",
      "1aa",
      "1aaa",
      "1ba",
      "1c",
      "1d-holding-over-12-months",
      "1d-holding-under-12-months",
      "1da",
      "1db-sukuk-company",
      "1db-sukuk-individual-aop-above-1m",
      "1db-sukuk-individual-aop-below-1m",
      "2a-a-company",
      "2a-a-other",
      "2a-b-it-ites",
      "2a-b-certain-other-services",
      "2a-b-other-services",
      "2a-c-sportsperson",
      "2a-c-other",
    ],
    // Section 152 withholding is not stated as a final discharge on the rate
    // card, so it stays adjustable like every other non-151 route.
    isFinalTax: false,
    noteSubject: "Section 152 payment to a non-resident",
  },
  // Section 153(1b)/153(2)/154A. Seven catalogued rows spanning 0.25% to 15%,
  // so the selected subcategory decides the rate.
  services: {
    catalogSource: "services",
    subcategories: [
      "1b-service-certain",
      "1b-service-it-ites",
      "1b-service-advertising-media",
      "1b-service-other",
      "2-services-to-exporter",
      "export-it-ites-pseb",
      "export-services-other",
    ],
    isFinalTax: false,
    noteSubject: "services income",
  },
  // Section 156 prize winnings and Section 233 brokerage/commission.
  other_income: {
    catalogSource: "other_income",
    subcategories: [
      "prize-bond-crossword",
      "raffle-lottery-quiz-sales-promotion",
      "brokerage-commission-advertising-agent",
      "brokerage-commission-life-insurance-agent-below-500k",
      "brokerage-commission-other",
    ],
    isFinalTax: false,
    noteSubject: "other income",
  },
  // Section 151A gain on certain debt securities.
  capital_gains: {
    catalogSource: "capital_gains",
    subcategories: ["certain-debt-securities"],
    isFinalTax: false,
    noteSubject: "Section 151A capital gain",
  },
  // Sections 153(1a) supplies, 153(1c) contracts, 153(2A) e-commerce,
  // 154 exports, 156A petroleum, 236G/236H distribution and retail.
  //
  // Sixteen catalogued rows spanning 0.1% to 15%, so the selected subcategory
  // decides the rate. Note that Non-ATL is NOT simply double on three of these
  // rows: 236G fertilizer is 0.25%/0.70%, 236G other is 0.10%/2.00% and 236H
  // retail is 0.50%/2.50% (rate card page 13). The rates come from the catalog
  // rather than being derived, so those rows are priced correctly.
  business: {
    catalogSource: "business",
    subcategories: [
      "1a-supply-rice-cotton-seed-edible-oil",
      "1a-supply-company-toll-manufacturing",
      "1a-supply-company-other",
      "1a-supply-non-company-toll-manufacturing",
      "1a-supply-non-company-other",
      "1c-contract-sportsperson",
      "1c-contract-company",
      "1c-contract-other",
      "2a-ecommerce-digital",
      "2a-ecommerce-cod",
      "exports-1",
      "exports-3-3a-3b-3c",
      "petroleum-product-sale",
      "sale-to-distributor-fertilizer",
      "sale-to-distributor-other",
      "sale-to-retailer",
    ],
    isFinalTax: false,
    noteSubject: "business income",
  },
  // Section 150 dividends and Section 236Z bonus shares.
  //
  // "mutual-fund-proportional" is a COMPOSITE charge — 25% of the
  // debt-derived portion plus 15% of the equity-derived portion — so it is
  // priced only when the taxpayer declares the split on the card. Without
  // the split it reports NEEDS_RULES rather than pricing the whole dividend
  // at a single rate.
  dividend: {
    catalogSource: "dividend",
    subcategories: [
      "ipp",
      "reit-and-other",
      "mutual-fund-proportional",
      "mutual-fund-debt-50-or-more",
      "reit-receives-from-spv",
      "other-recipient-from-spv",
      "exempt-loss-or-credit-company",
      "bonus-shares",
    ],
    isFinalTax: false,
    noteSubject: "dividend income",
  },
  // Section 148 imports. Eight rows are a plain percentage of the import
  // value. The two mobile-phone rows are deliberately absent: the card gives
  // only a minimum-to-maximum range (Rs 70–Rs 11,500), and the underlying
  // PCT band table is required before any of those imports can be priced.
  // This is a collection route: the lines price tax collected at import and
  // are reported in collectionBreakdown, never in the income-tax totals.
  imports: {
    catalogSource: "imports",
    subcategories: [
      "part-i",
      "part-ii",
      "part-ii-commercial",
      "part-iii",
      "part-iii-commercial",
      "sro-1125-manufacturer",
      "pharma",
      "ev-ckd",
      // Fixed charges by C&F value band, handled by computeMobileImportRoute.
      "mobile-pct-8517-1219",
      "mobile-pct-8517-1211",
    ],
    isFinalTax: false,
    noteSubject: "Section 148 import collection",
  },
};

/**
 * The rows each flat route is cleared to price, exposed for the verification
 * suite so it can assert that the catalog and these definitions have not
 * drifted apart. A row added to the rate card later must be reviewed and
 * listed deliberately rather than being priced unnoticed.
 */
export const FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS: Record<
  string,
  readonly string[]
> = Object.fromEntries(
  Object.entries(FLAT_ROUTE_DEFINITIONS).map(([route, definition]) => [
    route,
    definition.subcategories,
  ]),
);

/**
 * Why a catalogued flat-route row is deliberately unpriced, keyed by
 * `catalogSource:subcategory`. Consulted when the flat-route allowlist
 * refuses a selection, so the NEEDS_RULES note names the actual blocker —
 * a missing band table — instead of a generic "confirmed rules required".
 */
/**
 * Mobile-phone import bands, transcribed from Part-II of the First Schedule
 * to the Income Tax Ordinance (amended up to 31.07.2025, i.e. the TY2026
 * law). The rate card carries only each column's minimum and maximum; the
 * Ordinance table behind it bands the fixed charge by C&F value in USD.
 * Entries are the filer charge; Non-ATL pays double per the Tenth Schedule.
 */
const MOBILE_IMPORT_BANDS: ReadonlyArray<{
  /** Inclusive C&F upper bound in USD; evaluated top to bottom. */
  maxUsd: number;
  cbu1219: number;
  ckd1211: number;
}> = [
  { maxUsd: 30, cbu1219: 70, ckd1211: 0 },
  { maxUsd: 100, cbu1219: 100, ckd1211: 0 },
  { maxUsd: 200, cbu1219: 930, ckd1211: 0 },
  { maxUsd: 350, cbu1219: 970, ckd1211: 0 },
  { maxUsd: 500, cbu1219: 5000, ckd1211: 3000 },
  { maxUsd: Number.POSITIVE_INFINITY, cbu1219: 11500, ckd1211: 5200 },
];

function computeMobileImportRoute(input: {
  subcategory: string;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  attributes?: TaxRouteAttributes;
}): RouteComputation | RouteFailure {
  const usd = input.attributes?.cfValueUsd;
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) {
    return {
      error:
        `C&F value in USD is required before "${input.subcategory}" can be priced. ` +
        `The Ordinance bands the fixed charge by the handset's C&F value.`,
    };
  }
  const isCbu = input.subcategory === "mobile-pct-8517-1219";
  // Band 1 covers non-smartphones up to $30 only; a smartphone in that value
  // range falls in band 2. Above $30 — and on the CKD code at any value, where
  // both low bands pay nothing — the distinction no longer matters.
  if (isCbu && usd <= 30 && input.attributes?.isSmartphone === undefined) {
    return {
      error:
        `A C&F value up to $30 falls in different bands for smartphones and other phones. ` +
        `Confirm whether the handset is a smartphone before "mobile-pct-8517-1219" can be priced.`,
    };
  }
  const naturalBand = MOBILE_IMPORT_BANDS.findIndex(
    (band) => usd <= band.maxUsd,
  );
  const bandNumber =
    isCbu && usd <= 30 && input.attributes?.isSmartphone === true
      ? 2
      : naturalBand + 1;
  const band = MOBILE_IMPORT_BANDS[bandNumber - 1];
  const filerCharge = isCbu ? band.cbu1219 : band.ckd1211;
  const baseTax =
    input.filerStatus === "NON_ATL" ? filerCharge * 2 : filerCharge;
  const rule = TY2026_RATE_CARD_RULES.find(
    (candidate) =>
      candidate.source === "imports" &&
      candidate.subcategory === input.subcategory,
  );
  return {
    baseTax,
    surcharge: 0,
    isFinalTax: false,
    appliedRuleIds: rule ? [rule.id] : [],
    note:
      `Mobile-phone import band ${bandNumber} of 6 (C&F $${usd.toLocaleString()}): ` +
      `Rs ${baseTax.toLocaleString()} fixed charge under Section 148. ` +
      `Collected at source; claim as credit with the goods-declaration evidence.`,
  };
}

/**
 * The advance-tax subcategories this calculator will price, in display
 * order. Like the flat-route allowlists, a row absent here is refused
 * rather than priced with a sibling's rate.
 *
 * Absent deliberately: the two non-cc endnote specials. Endnote 1 fixes a
 * 3% rate but states no ATL/Non-ATL treatment, and endnote 2 fixes Rs 20,000
 * reduced 10% per year from first registration with no stated ATL split
 * either. Pricing either would invent the missing half of the rule.
 */
const ADVANCE_TAX_PRICED_SUBCATEGORIES: readonly string[] = [
  "cash-withdrawal",
  "motor-vehicle-value",
  "motor-vehicle-section-231b-2",
  "motor-vehicle-section-231b-2a",
  "motor-vehicle-non-cc-value-5m-or-more",
  "motor-vehicle-non-cc-fixed",
  "foreign-domestic-worker",
  "goods-transport-vehicle",
  "goods-transport-vehicle-above-8120kg",
  "passenger-transport-per-seat",
  "motor-vehicle-annual",
  "motor-vehicle-lump-sum",
  "electricity-commercial-industrial",
  "electricity-commercial",
  "electricity-industrial",
  "electricity-domestic-non-atl",
  "landline-telephone",
  "internet-mobile-prepaid",
  "public-auction-movable-or-other",
  "public-auction-immovable-or-railways",
  "immovable-property-transfer",
  "immovable-property-purchase",
  "foreign-tv-serial",
  "foreign-tv-play-single-episode",
  "advertisement-foreign-actor",
  "function-gathering",
  "card-remittance-abroad",
];

export const ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS: readonly string[] =
  ADVANCE_TAX_PRICED_SUBCATEGORIES;

/**
 * Why a catalogued advance-tax row is deliberately unpriced. Empty today:
 * every catalogued row prices. The map stays so a future gap has a home and
 * the allowlist check keeps its fallback note.
 */
const ADVANCE_TAX_UNPRICED_NOTES: Readonly<Record<string, string>> = {};

export const ADVANCE_TAX_UNPRICED_SUBCATEGORIES_FOR_TESTS: readonly string[] =
  Object.keys(ADVANCE_TAX_UNPRICED_NOTES);

/**
 * The advance-tax allowlist, exposed for the verification suite so it can
 * assert that the catalog and this definition have not drifted apart.
 */
export const ADVANCE_TAX_SUBCATEGORIES_FOR_TESTS: readonly string[] =
  ADVANCE_TAX_PRICED_SUBCATEGORIES;

/**
 * Static facts about each route, used to decide how routes may be combined.
 *
 * `rateShape` is the important field. A flat route charges a fixed percentage
 * of its own amount, so its tax is identical whether it is filed alone or
 * beside anything else. A progressive route's rate depends on the income
 * beneath it, so assessable progressive routes together share one slab read
 * against their combined income (see the aggregation rule in
 * `calculateTaxEstimate`); a final-tax pension still stands apart.
 *
 * Rental is deliberately absent: Section 155 is progressive for an
 * individual/AOP but flat for a company, so its shape is resolved per filing
 * by `resolveRouteShape` rather than fixed here.
 */
const ROUTE_RATE_SHAPES: Record<
  Exclude<TaxRouteKey, "property_rent">,
  TaxRateShape
> = {
  // Section 149 slabs, plus a surcharge once taxable income passes 10m.
  salary: "PROGRESSIVE",
  // Section 149(IA): 0% to 10m, then 5% on the excess as a final tax. The rate
  // depends on where the income sits, so it behaves progressively, but as a
  // final-tax line it never joins the combined slab (Sections 12(2A), 169).
  pension: "PROGRESSIVE",
  bank_profit: "FLAT",
  services: "FLAT",
  other_income: "FLAT",
  capital_gains: "FLAT",
  business: "FLAT",
  dividend: "FLAT",
  foreign_income_assets: "FLAT",
  // Collection routes never join an income slab: each transaction prices
  // from its own declared figures, so they combine with anything.
  imports: "FLAT",
  advance_tax: "FLAT",
  // The joint slab read is progressive by construction (section 30).
  combined_slab: "PROGRESSIVE",
};

function resolveRouteShape(
  route: TaxRouteKey,
  rentalRecipientKind: RentalRecipientKind,
): TaxRateShape {
  if (route === "property_rent") {
    // A company is charged one percentage; an individual/AOP reads a slab.
    return rentalRecipientKind === "COMPANY" ? "FLAT" : "PROGRESSIVE";
  }
  return ROUTE_RATE_SHAPES[route];
}

const ROUTE_LABELS: Record<TaxRouteKey, string> = {
  salary: "salary",
  pension: "pension",
  property_rent: "rental income",
  bank_profit: "profit on debt",
  services: "services income",
  other_income: "other income",
  capital_gains: "capital gains",
  business: "business income",
  dividend: "dividend income",
  foreign_income_assets: "payment to a non-resident",
  imports: "imports",
  advance_tax: "advance tax",
  combined_slab: "combined slab",
};

/** Keeps breakdown lines and rule citations in a stable, predictable order. */
const ROUTE_ORDER: readonly TaxRouteKey[] = [
  "salary",
  "pension",
  "property_rent",
  "bank_profit",
  "services",
  "other_income",
  "capital_gains",
  "business",
  "dividend",
  "foreign_income_assets",
  "imports",
  "advance_tax",
];

export function calculateTaxEstimate(input: {
  taxYear: number;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  totalIncome: number;
  totalExpenses: number;
  bankProfitIncome?: number;
  taxWithheld?: number;
  isSalariedRoute: boolean;
  isPensionRoute?: boolean;
  isRentalRoute?: boolean;
  isBankProfitRoute: boolean;
  /**
   * Income per route. Supplying this prices every listed route and returns a
   * per-route breakdown. When omitted the single selected route is priced from
   * `totalIncome`, preserving the earlier single-route behaviour.
   */
  incomeSources?: readonly TaxIncomeSource[];
  /** Section 149(IA) only catalogues pension above PKR 10m for age below 70. */
  pensionerAgeBelow70?: boolean;
  /** Confirmed 70-or-above: Section 12(2A)(i) exempts the pension outright. */
  pensionerAge70OrAbove?: boolean;
  /** Operator-facing explanation shown when the age condition blocks a route. */
  pensionerAgeReason?: string;
  /**
   * Price the pension on the Section 149 salary slabs. Set when the filing
   * selects the former-employer row, which references Section 149.
   */
  pensionTaxAsSalary?: boolean;
  /** Section 155 charges an individual/AOP by slab and a company at a flat rate. */
  rentalRecipientKind?: RentalRecipientKind;
}): TaxCalculationResult {
  const bankProfitIncome = Math.max(0, input.bankProfitIncome ?? 0);
  // Salary is not reduced by ordinary personal/bank-account expenses. Those
  // expenses belong in wealth reconciliation, not the salary tax base.
  const taxableIncome = input.isBankProfitRoute
    ? bankProfitIncome
    : Math.max(0, input.totalIncome);
  const taxWithheld = Math.max(0, input.taxWithheld ?? 0);

  const needsRules = (note: string): TaxCalculationResult => ({
    status: "NEEDS_RULES",
    taxYear: input.taxYear,
    filerStatus: input.filerStatus,
    taxableIncome: null,
    baseTax: null,
    surcharge: null,
    taxDue: null,
    taxPayable: null,
    refundDue: null,
    taxWithheld,
    isFinalTax: false,
    appliedRuleIds: [],
    note,
    breakdown: [],
    finalTaxDue: 0,
    assessableTaxDue: 0,
    mixedExcessWithholding: 0,
    collectionBreakdown: [],
    collectionTaxDue: 0,
  });

  if (input.taxYear !== TY2026_TAX_YEAR) {
    return needsRules(
      `Only Tax Year ${TY2026_TAX_YEAR} rate-card rules are currently implemented.`,
    );
  }

  const rentalRecipientKind = input.rentalRecipientKind ?? "INDIVIDUAL_OR_AOP";

  // Build the list of routes to price. An explicit `incomeSources` list drives
  // a multi-source return; otherwise the selected route flags are converted
  // into a one-entry list so both paths run through the same code below.
  const selectedRouteFlags: Array<[TaxRouteKey, boolean]> = [
    ["salary", input.isSalariedRoute],
    ["pension", input.isPensionRoute ?? false],
    ["property_rent", input.isRentalRoute ?? false],
    ["bank_profit", input.isBankProfitRoute],
  ];
  const flaggedRoutes = selectedRouteFlags
    .filter(([, selected]) => selected)
    .map(([route]) => route);

  let requestedSources: TaxIncomeSource[];

  if (input.incomeSources && input.incomeSources.length > 0) {
    // Merge duplicates so a caller listing the same thing twice cannot
    // double-charge. The key is route AND subcategory, not route alone: a
    // filing may hold two services categories charged at different rates
    // (IT/ITES at 4% and advertising at 1.5%), and collapsing those into one
    // line would price part of the income at the wrong percentage.
    const totals = new Map<
      string,
      {
        route: TaxRouteKey;
        subcategory?: string;
        income: number;
        attributes?: TaxRouteAttributes;
      }
    >();
    for (const source of input.incomeSources) {
      const key = `${source.route}::${source.subcategory ?? ""}`;
      const existing = totals.get(key);
      if (existing) {
        existing.income += Math.max(0, source.income);
        // Declared figures ride with the first listing. A true duplicate
        // carries the same figures; anything else fails downstream (the
        // composite split no longer adds up) rather than pricing wrong.
      } else {
        totals.set(key, {
          route: source.route,
          subcategory: source.subcategory,
          income: Math.max(0, source.income),
          attributes: source.attributes,
        });
      }
    }
    // Order by route first so the breakdown stays stable, then keep the
    // caller's order within a route.
    requestedSources = ROUTE_ORDER.flatMap((route) =>
      Array.from(totals.values()).filter((entry) => entry.route === route),
    );
  } else {
    if (flaggedRoutes.length === 0) {
      return needsRules(
        "A route-specific FBR tax rule set is required before calculating a final estimate.",
      );
    }
    if (flaggedRoutes.length > 1) {
      return needsRules(
        "Combined-route filings need per-route income. Provide incomeSources so each selected route can be priced separately.",
      );
    }
    const [only] = flaggedRoutes;
    requestedSources = [
      {
        route: only,
        income: only === "bank_profit" ? bankProfitIncome : taxableIncome,
      },
    ];
  }

  if (requestedSources.length === 0) {
    return needsRules(
      "A route-specific FBR tax rule set is required before calculating a final estimate.",
    );
  }

  // A route carrying no income cannot be priced, and silently dropping it
  // would hide a data problem behind a plausible-looking number. Collection
  // routes are exempt: a fixed charge (Rs 20,000 vehicle transfer, Rs 3m TV
  // play) legitimately carries no base amount, and the declared figures each
  // priced row needs are validated by the caller and the row helper itself.
  const emptyRoutes = requestedSources.filter(
    (source) => !isCollectionRoute(source.route) && source.income <= 0,
  );
  if (emptyRoutes.length > 0) {
    const labels = emptyRoutes.map((source) => ROUTE_LABELS[source.route]);
    return needsRules(
      emptyRoutes.some((source) => source.route === "bank_profit")
        ? "Add an income ledger entry categorized as BANK_PROFIT before calculating this route."
        : `No income was recorded for ${labels.join(" and ")}. Add the ledger entries for that income before calculating.`,
    );
  }

  // The aggregation rule. Assessable slab routes (salary, individual/AOP
  // rental, a pension taxed as salary) share ONE slab read against their
  // combined taxable income: Division I reaches "taxable income", and the
  // Finance Act 2025 abolished rental's separate block. A pension charged as
  // final tax stands apart and never enters the total (Sections 12(2A) and
  // 169), and a company rental is a flat percentage of its own rent. Flat
  // routes are unaffected either way, so any combination involving them
  // proceeds normally.
  const isCombinableSlabSource = (source: TaxIncomeSource): boolean =>
    source.route === "salary" ||
    (source.route === "property_rent" && rentalRecipientKind !== "COMPANY") ||
    (source.route === "pension" && input.pensionTaxAsSalary === true);
  const combinableSources = requestedSources.filter(isCombinableSlabSource);

  // Two or more combinable lines price jointly below; a lone one prices
  // singly through its existing branch, exactly as before.
  let combinedLine: TaxRouteBreakdown | null = null;
  if (combinableSources.length > 1) {
    const combinedIncome = combinableSources.reduce(
      (total, source) => total + Math.max(0, source.income),
      0,
    );
    const salaryHeadIncome = combinableSources
      .filter(
        (source) =>
          source.route === "salary" ||
          (source.route === "pension" && input.pensionTaxAsSalary === true),
      )
      .reduce((total, source) => total + Math.max(0, source.income), 0);
    const rentalIncome = combinableSources
      .filter((source) => source.route === "property_rent")
      .reduce((total, source) => total + Math.max(0, source.income), 0);
    const computed = computeCombinedSlabRoute({
      combinedIncome,
      salaryHeadIncome,
      rentalIncome,
      labels: combinableSources.map((source) => ROUTE_LABELS[source.route]),
      includesWorkingPension: combinableSources.some(
        (source) => source.route === "pension",
      ),
    });
    if (isRouteFailure(computed)) {
      return needsRules(computed.error);
    }
    const combinedBase = Math.max(0, Math.round(computed.baseTax));
    const combinedSurcharge = Math.max(0, Math.round(computed.surcharge));
    combinedLine = {
      route: "combined_slab",
      rateShape: "PROGRESSIVE",
      income: Math.round(combinedIncome),
      combinedRoutes: combinableSources.map((source) => ({
        route: source.route,
        income: Math.max(0, Math.round(source.income)),
      })),
      baseTax: combinedBase,
      surcharge: combinedSurcharge,
      taxDue: combinedBase + combinedSurcharge,
      isFinalTax: computed.isFinalTax,
      appliedRuleIds: computed.appliedRuleIds,
      note: computed.note,
    };
  }

  // Price every route. Each helper is the same one used for single-route
  // filings, so a combined return cannot drift away from a solo return.
  // Income lines feed the liability totals; collection lines are reported
  // separately and never touch them.
  const breakdown: TaxRouteBreakdown[] = [];
  const collectionBreakdown: TaxRouteBreakdown[] = [];

  let combinedEmitted = false;
  for (const source of requestedSources) {
    // The joint line takes the position of the first combinable source so
    // the breakdown order stays stable; the rest price singly below.
    if (combinedLine && isCombinableSlabSource(source)) {
      if (!combinedEmitted) {
        breakdown.push(combinedLine);
        combinedEmitted = true;
      }
      continue;
    }

    let computed: RouteComputation | RouteFailure;

    // Flat routes are entirely described by FLAT_ROUTE_DEFINITIONS, so they
    // are dispatched as data before the switch. Only routes that need their
    // own formula appear below.
    const flatDefinition = FLAT_ROUTE_DEFINITIONS[source.route];

    if (flatDefinition) {
      computed = computeFlatRoute({
        route: source.route,
        income: source.income,
        subcategory: source.subcategory,
        filerStatus: input.filerStatus,
        attributes: source.attributes,
      });
    } else if (source.route === "advance_tax") {
      computed = computeAdvanceTaxRoute({
        income: source.income,
        subcategory: source.subcategory,
        filerStatus: input.filerStatus,
        attributes: source.attributes,
      });
    } else {
      switch (source.route) {
        case "pension":
          computed = computePensionRoute({
            annualPension: source.income,
            pensionerAgeBelow70: input.pensionerAgeBelow70,
            pensionerAgeReason: input.pensionerAgeReason,
            pensionerAge70OrAbove: input.pensionerAge70OrAbove,
            taxAsSalary: input.pensionTaxAsSalary,
          });
          break;
        case "property_rent":
          computed = computeRentalRoute({
            grossRent: source.income,
            recipientKind: rentalRecipientKind,
            filerStatus: input.filerStatus,
          });
          break;
        case "salary":
          computed = computeSalaryRoute(source.income);
          break;
        default: {
          // Exhaustiveness guard: a route that is neither in
          // FLAT_ROUTE_DEFINITIONS nor handled above must stop the estimate
          // rather than fall through to another route's formula.
          computed = {
            error: `Route ${String(source.route)} is not catalogued.`,
          };
        }
      }
    }

    if (isRouteFailure(computed)) {
      return needsRules(computed.error);
    }

    const lineBaseTax = Math.max(0, Math.round(computed.baseTax));
    const lineSurcharge = Math.max(0, Math.round(computed.surcharge));

    const line: TaxRouteBreakdown = {
      route: source.route,
      rateShape: resolveRouteShape(source.route, rentalRecipientKind),
      income: Math.round(source.income),
      baseTax: lineBaseTax,
      surcharge: lineSurcharge,
      taxDue: lineBaseTax + lineSurcharge,
      isFinalTax: computed.isFinalTax,
      appliedRuleIds: computed.appliedRuleIds,
      note: computed.note,
    };
    if (isCollectionRoute(source.route)) {
      collectionBreakdown.push(line);
    } else {
      breakdown.push(line);
    }
  }

  const sum = (pick: (line: TaxRouteBreakdown) => number) =>
    breakdown.reduce((total, line) => total + pick(line), 0);

  const totalIncomePriced = sum((line) => line.income);
  const baseTax = sum((line) => line.baseTax);
  const surcharge = sum((line) => line.surcharge);
  const taxDue = baseTax + surcharge;

  const finalTaxDue = breakdown
    .filter((line) => line.isFinalTax)
    .reduce((total, line) => total + line.taxDue, 0);
  const assessableTaxDue = taxDue - finalTaxDue;

  const everyLineIsFinal =
    breakdown.length > 0 && breakdown.every((line) => line.isFinalTax);

  const taxPayable = Math.max(0, taxDue - taxWithheld);

  // A refund can only arise on the assessable part of the return. Withholding
  // under a final-tax route discharges that route's liability, so an
  // over-deduction there is not converted into an automatic refund claim.
  const refundDue = everyLineIsFinal ? 0 : Math.max(0, taxWithheld - taxDue);

  const excessWithholding = Math.max(0, taxWithheld - taxDue);
  // Mixed-regime excess (section 29): on a return with both final-tax and
  // assessable lines, withholding above the total may sit on either side.
  // Final-side over-deduction is never refundable, but the engine only sees
  // one global withholding number (no per-route allocation yet), so it
  // cannot prove which side holds the excess. The refund formula below keeps
  // the final-first default; this field + note force the ambiguity into the
  // open instead of silently claiming it.
  const mixedExcessWithholding =
    !everyLineIsFinal && finalTaxDue > 0 && excessWithholding > 0
      ? excessWithholding
      : 0;
  const mixedExcessNote =
    mixedExcessWithholding > 0
      ? ` PKR ${mixedExcessWithholding.toLocaleString()} was withheld above the calculated liability on a mixed return (PKR ${finalTaxDue.toLocaleString()} of it final tax). Confirm via CPRs that the excess sits on adjustable withholding before claiming it as refund — final-tax over-deduction is not refundable.`
      : "";
  const finalTaxNote =
    everyLineIsFinal && excessWithholding > 0
      ? ` PKR ${excessWithholding.toLocaleString()} was withheld above the calculated final tax; a refund is not claimed automatically and needs professional review.`
      : "";

  const combinedNote =
    breakdown.length === 1
      ? breakdown[0].note
      : breakdown
          .map((line) => `${ROUTE_LABELS[line.route]}: ${line.note}`)
          .join(" ");

  const mixedRegimeNote =
    breakdown.length > 1 && finalTaxDue > 0 && assessableTaxDue > 0
      ? ` PKR ${finalTaxDue.toLocaleString()} of this total is final tax and is not part of the assessable liability.`
      : "";

  const collectionTaxDue = collectionBreakdown.reduce(
    (total, line) => total + line.taxDue,
    0,
  );

  const collectionNote =
    collectionBreakdown.length > 0
      ? `Separately, PKR ${collectionTaxDue.toLocaleString()} was collected at source across ` +
        `${collectionBreakdown.length} declared transaction(s) (imports/advance tax). ` +
        `This collection is not deducted from the income-tax payable above; ` +
        `claim it as credit with the CPR, goods declaration or bill evidence.`
      : "";

  return {
    status: "ESTIMATE",
    taxYear: input.taxYear,
    filerStatus: input.filerStatus,
    taxableIncome: totalIncomePriced,
    baseTax,
    surcharge,
    taxDue,
    taxPayable,
    refundDue,
    taxWithheld,
    isFinalTax: everyLineIsFinal,
    appliedRuleIds: [...breakdown, ...collectionBreakdown].flatMap(
      (line) => line.appliedRuleIds,
    ),
    note: [
      `${combinedNote}${mixedRegimeNote}${finalTaxNote}${mixedExcessNote}`,
      collectionNote,
    ]
      .filter(Boolean)
      .join(" "),
    breakdown,
    finalTaxDue,
    assessableTaxDue,
    mixedExcessWithholding,
    collectionBreakdown,
    collectionTaxDue,
  };
}
