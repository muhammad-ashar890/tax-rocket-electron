import type {
  RateCardFilerStatus,
  RateCardRule,
  RateCardValue,
} from "@/lib/tax/rules/rate-card-types";
import {
  TY2026_RATE_CARD_RULES,
  getTy2026RateCardRule,
} from "./catalog";

function fail(message: string): never {
  throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    fail(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function expectClose(actual: number, expected: number, label: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    fail(`${label}: expected ${expected}, received ${actual}`);
  }
}

function requiredRule(id: string) {
  return getTy2026RateCardRule(id) ?? fail(`Missing test rule ${id}`);
}

function requiredRate(ruleId: string, status: RateCardFilerStatus) {
  const value = requiredRule(ruleId).rates[status];
  return value ?? fail(`${ruleId}: missing ${status} rate`);
}

function calculateValue(value: RateCardValue, amount: number) {
  switch (value.kind) {
    case "ZERO":
      return 0;
    case "PERCENT":
      return amount * (value.percent / 100);
    case "MARGINAL":
      return value.baseTax + (amount - value.excessOver) * (value.percent / 100);
    case "FIXED":
      return value.amount;
    case "PER_UNIT":
      return amount * value.amount;
    default:
      fail(`Test evaluator does not calculate ${value.kind} values`);
  }
}

function matchesAmount(rule: RateCardRule, field: string, amount: number) {
  const condition = rule.condition?.amount;
  if (!condition || condition.field !== field) return false;
  if (condition.minInclusive !== undefined && amount < condition.minInclusive) return false;
  if (condition.minExclusive !== undefined && amount <= condition.minExclusive) return false;
  if (condition.maxInclusive !== undefined && amount > condition.maxInclusive) return false;
  if (condition.maxExclusive !== undefined && amount >= condition.maxExclusive) return false;
  return true;
}

function expectExactlyOneBand(input: {
  label: string;
  rules: ReadonlyArray<RateCardRule>;
  field: string;
  amount: number;
}) {
  const matches = input.rules.filter((item) =>
    matchesAmount(item, input.field, input.amount),
  );
  expectEqual(matches.length, 1, `${input.label} at ${input.amount}`);
}

export function runTy2026RateCardCatalogTests() {
  let assertionCount = 0;
  const equal = (actual: unknown, expected: unknown, label: string) => {
    assertionCount += 1;
    expectEqual(actual, expected, label);
  };
  const close = (actual: number, expected: number, label: string) => {
    assertionCount += 1;
    expectClose(actual, expected, label);
  };

  // Boundary integrity for the catalogued slab rows.
  const salaryBands = TY2026_RATE_CARD_RULES.filter(
    (item) => item.section === "149" && item.subcategory === "salary",
  );
  for (const amount of [0, 600_000, 600_001, 1_200_000, 1_200_001, 2_200_000, 2_200_001, 3_200_000, 3_200_001, 4_100_000, 4_100_001, 12_000_000]) {
    assertionCount += 1;
    expectExactlyOneBand({
      label: "Salary band",
      rules: salaryBands,
      field: "taxableIncome",
      amount,
    });
  }

  const rentBands = TY2026_RATE_CARD_RULES.filter(
    (item) => item.section === "155" && item.subcategory === "individual-aop",
  );
  for (const amount of [0, 300_000, 300_001, 600_000, 600_001, 2_000_000, 2_000_001]) {
    assertionCount += 1;
    expectExactlyOneBand({
      label: "Rent band",
      rules: rentBands,
      field: "grossRent",
      amount,
    });
  }

  // Salary and surcharge examples.
  close(
    calculateValue(requiredRate("TY2026-149-SALARY-1M2-2M2", "DEFAULT"), 1_800_000),
    72_000,
    "Salary tax at PKR 1.8m",
  );
  const salaryTaxAt12m = calculateValue(
    requiredRate("TY2026-149-SALARY-ABOVE-4M1", "DEFAULT"),
    12_000_000,
  );
  close(salaryTaxAt12m, 3_381_000, "Salary tax at PKR 12m before surcharge");
  const salarySurcharge = requiredRule(
    "TY2026-149-SALARY-SURCHARGE-ABOVE-10M",
  ).surcharge;
  equal(salarySurcharge?.basis, "CALCULATED_TAX", "Salary surcharge basis");
  close(
    salaryTaxAt12m * ((salarySurcharge?.percent ?? 0) / 100),
    304_290,
    "Salary surcharge at PKR 12m",
  );

  const pensionRule = requiredRule(
    "TY2026-149IA-PENSION-ABOVE-10M-BELOW-AGE-70",
  );
  const pensionTax = calculateValue(
    pensionRule.rates.DEFAULT ?? fail("Missing pension default rate"),
    12_000_000,
  );
  close(pensionTax, 100_000, "Pension tax at PKR 12m");
  equal(pensionRule.surcharge?.basis, "CALCULATED_TAX", "Pension surcharge basis");
  close(
    pensionTax * ((pensionRule.surcharge?.percent ?? 0) / 100),
    10_000,
    "Pension surcharge at PKR 12m",
  );

  // Investment and business-rate examples.
  close(
    calculateValue(requiredRate("TY2026-150-DIVIDEND-IPP", "ATL"), 100_000),
    7_500,
    "IPP dividend ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-150-DIVIDEND-IPP", "NON_ATL"), 100_000),
    15_000,
    "IPP dividend Non-ATL",
  );
  close(
    calculateValue(
      requiredRate("TY2026-151-BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "ATL"),
      200_000,
    ),
    40_000,
    "Bank profit ATL",
  );
  close(
    calculateValue(
      requiredRate("TY2026-151-BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT", "NON_ATL"),
      200_000,
    ),
    80_000,
    "Bank profit Non-ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-153-1B-SERVICE-IT-ITES", "ATL"), 1_000_000),
    40_000,
    "Local IT service ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-153-1B-SERVICE-IT-ITES", "NON_ATL"), 1_000_000),
    80_000,
    "Local IT service Non-ATL",
  );
  close(
    calculateValue(
      requiredRate("TY2026-154A-EXPORT-SERVICES-PSEB-IT-ITES", "ATL"),
      1_000_000,
    ),
    2_500,
    "PSEB IT export ATL",
  );
  close(
    calculateValue(
      requiredRate("TY2026-154A-EXPORT-SERVICES-PSEB-IT-ITES", "NON_ATL"),
      1_000_000,
    ),
    5_000,
    "PSEB IT export Non-ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-155-RENT-INDIVIDUAL-AOP-600K-2M", "DEFAULT"), 900_000),
    45_000,
    "Rent withholding at PKR 900k",
  );

  // Advance-tax and fixed/per-unit examples.
  equal(
    requiredRate("TY2026-231AB-CASH-WITHDRAWAL-NON-ATL", "ATL").kind,
    "NOT_APPLICABLE",
    "Cash withdrawal ATL is not applicable",
  );
  close(
    calculateValue(
      requiredRate("TY2026-231AB-CASH-WITHDRAWAL-NON-ATL", "NON_ATL"),
      1_000_000,
    ),
    8_000,
    "Cash withdrawal Non-ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-231B-1-3-1301-1600CC", "ATL"), 2_000_000),
    40_000,
    "Vehicle value ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-234-GOODS-TRANSPORT-PER-KG", "DEFAULT"), 10_000),
    25_000,
    "Goods vehicle per-kg tax",
  );
  close(
    calculateValue(requiredRate("TY2026-235-COMMERCIAL-ABOVE-20K", "DEFAULT"), 25_000),
    2_550,
    "Commercial electricity above PKR 20k",
  );
  close(
    calculateValue(requiredRate("TY2026-236-LANDLINE-BILL-ABOVE-1000", "DEFAULT"), 2_000),
    100,
    "Landline bill above PKR 1k",
  );

  for (const [status, expected] of [
    ["ATL", 2_250_000],
    ["NON_ATL", 5_750_000],
    ["LATE_FILER", 3_750_000],
  ] as const) {
    close(
      calculateValue(
        requiredRate("TY2026-236C-PROPERTY-TRANSFER-UP-TO-50M", status),
        50_000_000,
      ),
      expected,
      `Property transfer ${status}`,
    );
  }

  for (const [status, expected] of [
    ["ATL", 750_000],
    ["NON_ATL", 5_250_000],
    ["LATE_FILER", 2_250_000],
  ] as const) {
    close(
      calculateValue(
        requiredRate("TY2026-236K-PROPERTY-PURCHASE-UP-TO-50M", status),
        50_000_000,
      ),
      expected,
      `Property purchase ${status}`,
    );
  }

  close(
    calculateValue(requiredRate("TY2026-236Y-CARD-REMITTANCE-ABROAD", "ATL"), 100_000),
    5_000,
    "Card remittance ATL",
  );
  close(
    calculateValue(requiredRate("TY2026-236Z-BONUS-SHARES", "NON_ATL"), 100_000),
    20_000,
    "Bonus shares Non-ATL",
  );
  close(
    calculateValue(
      requiredRate("TY2026-236CA-FOREIGN-TV-SERIAL-EPISODE", "DEFAULT"),
      1,
    ),
    1_000_000,
    "Foreign TV serial fixed amount",
  );

  // Every intentionally incomplete catalog row must remain explicit.
  const externalDetailRules = TY2026_RATE_CARD_RULES.filter(
    (item) => item.implementationStatus === "NEEDS_EXTERNAL_DETAIL",
  );
  equal(externalDetailRules.length, 2, "External-detail rule count");
  for (const item of externalDetailRules) {
    assertionCount += 1;
    if (!item.notes?.length) fail(`${item.id}: external-detail row needs an explanatory note`);
  }

  return { scenarioCount: 16, assertionCount };
}
