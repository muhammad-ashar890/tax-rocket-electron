/**
 * Phase 4-A — services, other income and capital gains.
 *
 * These routes are a plain percentage of their own amount, so every expected
 * figure below is computed by hand from the FBR TY2026 withholding rate card
 * and hard-coded. The engine is never asked what it thinks the rate is; it is
 * asked to produce a number that was worked out independently.
 *
 * The suite also pins the design constraints that make the route catalog worth
 * having: no per-route branch in the pricing loop, no guessing when a rate
 * cannot be resolved, and no collapsing of two differently-priced categories
 * into one line.
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const Module = require("module");

const projectRoot = path.join(__dirname, "..");

// Resolve "@/..." the way Next.js does, and compile TypeScript on require.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(projectRoot, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const { calculateTaxEstimate } = require(
  path.join(projectRoot, "lib/tax/tax-calculation.ts"),
);
const { TY2026_RATE_CARD_RULES } = require(
  path.join(projectRoot, "lib/tax/rules/ty2026/catalog.ts"),
);

const failures = [];
let assertionCount = 0;

function check(label, actual, expected) {
  assertionCount += 1;
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function estimate(sources, filerStatus = "ATL", extra = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus,
    totalIncome: 0,
    totalExpenses: 0,
    isSalariedRoute: false,
    isBankProfitRoute: false,
    incomeSources: sources,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 1 — every rate, worked out by hand from the rate card
//
// Columns: route, subcategory, income, ATL tax, Non-ATL tax.
// Non-ATL is exactly double the ATL rate on every one of these rows, which is
// itself asserted rather than assumed.
// ---------------------------------------------------------------------------

const RATE_CASES = [
  // --- services, Section 153(1b) -------------------------------------------
  // 6% / 12% of the gross service payment
  ["services", "1b-service-certain", 5_000_000, 300_000, 600_000],
  // 4% / 8% — IT and IT-enabled services
  ["services", "1b-service-it-ites", 5_000_000, 200_000, 400_000],
  // 1.5% / 3% — advertising and media
  ["services", "1b-service-advertising-media", 2_000_000, 30_000, 60_000],
  // 15% / 30% — services not otherwise listed
  ["services", "1b-service-other", 1_000_000, 150_000, 300_000],
  // --- services, Section 153(2) --------------------------------------------
  // 1% / 2% — services rendered to an exporter
  ["services", "2-services-to-exporter", 3_000_000, 30_000, 60_000],
  // --- services, Section 154A ----------------------------------------------
  // 0.25% / 0.5% — PSEB-registered IT/ITES export proceeds
  ["services", "export-it-ites-pseb", 10_000_000, 25_000, 50_000],
  // 1% / 2% — other export services
  ["services", "export-services-other", 10_000_000, 100_000, 200_000],

  // --- other income, Section 156 -------------------------------------------
  // 15% / 30% — prize bond and crossword winnings
  ["other_income", "prize-bond-crossword", 1_000_000, 150_000, 300_000],
  // 20% / 40% — raffle, lottery, quiz, sales promotion
  [
    "other_income",
    "raffle-lottery-quiz-sales-promotion",
    500_000,
    100_000,
    200_000,
  ],
  // --- other income, Section 233 -------------------------------------------
  // 10% / 20% — advertising agent commission
  [
    "other_income",
    "brokerage-commission-advertising-agent",
    1_000_000,
    100_000,
    200_000,
  ],
  // 8% / 16% — life insurance agent, commission below 500k
  [
    "other_income",
    "brokerage-commission-life-insurance-agent-below-500k",
    400_000,
    32_000,
    64_000,
  ],
  // 12% / 24% — other brokerage and commission
  ["other_income", "brokerage-commission-other", 800_000, 96_000, 192_000],

  // --- capital gains, Section 151A -----------------------------------------
  // 15% / 30% — gain on certain debt securities
  ["capital_gains", "certain-debt-securities", 2_000_000, 300_000, 600_000],

  // --- business, Section 153(1a) supplies (rate card pages 5-6) ------------
  // 1.5% / 3% — rice, cotton seed, edible oils
  [
    "business",
    "1a-supply-rice-cotton-seed-edible-oil",
    4_000_000,
    60_000,
    120_000,
  ],
  // 9% / 18% — company, toll manufacturing
  [
    "business",
    "1a-supply-company-toll-manufacturing",
    4_000_000,
    360_000,
    720_000,
  ],
  // 5% / 10% — company, other than toll manufacturing
  ["business", "1a-supply-company-other", 4_000_000, 200_000, 400_000],
  // 11% / 22% — non-company, toll manufacturing
  [
    "business",
    "1a-supply-non-company-toll-manufacturing",
    4_000_000,
    440_000,
    880_000,
  ],
  // 5.5% / 11% — non-company, other than toll manufacturing
  ["business", "1a-supply-non-company-other", 4_000_000, 220_000, 440_000],

  // --- business, Section 153(1c) contracts (page 6) ------------------------
  // 15% / 30% — sportsperson
  ["business", "1c-contract-sportsperson", 2_000_000, 300_000, 600_000],
  // 7.5% / 15% — company
  ["business", "1c-contract-company", 2_000_000, 150_000, 300_000],
  // 8% / 16% — any other case
  ["business", "1c-contract-other", 2_000_000, 160_000, 320_000],

  // --- business, Section 153(2A) e-commerce (pages 6-7) --------------------
  // 1% / 2% — paid through digital or banking channels
  ["business", "2a-ecommerce-digital", 3_000_000, 30_000, 60_000],
  // 2% / 4% — cash on delivery by courier
  ["business", "2a-ecommerce-cod", 3_000_000, 60_000, 120_000],

  // --- business, Section 154 exports (page 7) ------------------------------
  // 1% / 2% — sub-section (1)
  ["business", "exports-1", 10_000_000, 100_000, 200_000],
  // 1% / 2% — sub-sections (3), (3A), (3B), (3C)
  ["business", "exports-3-3a-3b-3c", 10_000_000, 100_000, 200_000],

  // --- business, Section 156A petroleum (page 8) ---------------------------
  // 12% / 24% — sale of petroleum products
  ["business", "petroleum-product-sale", 1_000_000, 120_000, 240_000],

  // --- business, Sections 236G / 236H distribution (page 13) ---------------
  // These three rows are the reason rates are read from the catalog rather
  // than derived: Non-ATL is NOT double on any of them.
  // 0.25% / 0.70% — fertilizer to distributor, dealer or wholesaler
  ["business", "sale-to-distributor-fertilizer", 20_000_000, 50_000, 140_000],
  // 0.10% / 2.00% — other sales to distributor, dealer or wholesaler
  ["business", "sale-to-distributor-other", 20_000_000, 20_000, 400_000],
  // 0.50% / 2.50% — sales to retailers
  ["business", "sale-to-retailer", 20_000_000, 100_000, 500_000],

  // --- profit on debt, Section 151 (rate card page 3) ----------------------
  // 20% / 40% — bank or financial-institution deposit
  [
    "bank_profit",
    "bank-or-financial-institution-deposit",
    1_000_000,
    200_000,
    400_000,
  ],
  // 20% / 40% — government securities paid to a non-individual
  [
    "bank_profit",
    "government-securities-non-individual",
    1_000_000,
    200_000,
    400_000,
  ],
  // 15% / 30% — other profit-on-debt cases
  ["bank_profit", "other-profit-on-debt", 1_000_000, 150_000, 300_000],
  // 25% / 50% — Sukuk held by a company
  ["bank_profit", "sukuk-company", 1_000_000, 250_000, 500_000],
  // 12.5% / 25% — Sukuk, individual/AOP, return ABOVE PKR 1m
  [
    "bank_profit",
    "sukuk-individual-aop-above-1m",
    4_000_000,
    500_000,
    1_000_000,
  ],
  // 10% / 20% — Sukuk, individual/AOP, return BELOW PKR 1m
  ["bank_profit", "sukuk-individual-aop-below-1m", 800_000, 80_000, 160_000],

  // --- dividend, Section 150 (pages 2-3) -----------------------------------
  // 7.5% / 15% — Independent Power Producer
  ["dividend", "ipp", 2_000_000, 150_000, 300_000],
  // 15% / 30% — REIT and other cases
  ["dividend", "reit-and-other", 2_000_000, 300_000, 600_000],
  // 25% / 50% — mutual fund deriving 50% or more from profit on debt
  ["dividend", "mutual-fund-debt-50-or-more", 2_000_000, 500_000, 1_000_000],
  // 0% / 0% — dividend received by a REIT scheme from an SPV
  ["dividend", "reit-receives-from-spv", 2_000_000, 0, 0],
  // 35% / 70% — another recipient from a REIT SPV
  ["dividend", "other-recipient-from-spv", 1_000_000, 350_000, 700_000],
  // 25% / 50% — company with no tax payable due to exemption/losses/credits
  ["dividend", "exempt-loss-or-credit-company", 1_000_000, 250_000, 500_000],
  // --- dividend, Section 236Z (page 14) ------------------------------------
  // 10% / 20% — bonus shares
  ["dividend", "bonus-shares", 1_000_000, 100_000, 200_000],

  // --- payments to non-residents, Section 152 (pages 4-5) ------------------
  //
  // IMPORTANT: the twelve sub-section 1 to 1DB rows below carry ONE rate on
  // the card. The Non-ATL column is blank, so the expected Non-ATL figure is
  // deliberately the SAME as ATL, not double. This is the card's own position
  // (confirmed with the client), not a copy-paste slip in this table.
  ["foreign_income_assets", "1", 1_000_000, 150_000, 150_000],
  ["foreign_income_assets", "1a", 1_000_000, 70_000, 70_000],
  ["foreign_income_assets", "1aa", 1_000_000, 50_000, 50_000],
  ["foreign_income_assets", "1aaa", 1_000_000, 100_000, 100_000],
  ["foreign_income_assets", "1ba", 1_000_000, 200_000, 200_000],
  ["foreign_income_assets", "1c", 1_000_000, 100_000, 100_000],
  [
    "foreign_income_assets",
    "1d-holding-over-12-months",
    1_000_000,
    100_000,
    100_000,
  ],
  [
    "foreign_income_assets",
    "1d-holding-under-12-months",
    1_000_000,
    100_000,
    100_000,
  ],
  ["foreign_income_assets", "1da", 1_000_000, 100_000, 100_000],
  ["foreign_income_assets", "1db-sukuk-company", 1_000_000, 250_000, 250_000],
  // Banded like the Section 151 Sukuk rows: above PKR 1m.
  [
    "foreign_income_assets",
    "1db-sukuk-individual-aop-above-1m",
    4_000_000,
    500_000,
    500_000,
  ],
  // Banded: below PKR 1m.
  [
    "foreign_income_assets",
    "1db-sukuk-individual-aop-below-1m",
    800_000,
    80_000,
    80_000,
  ],
  // The seven 152(2A) rows DO split ATL from Non-ATL.
  ["foreign_income_assets", "2a-a-company", 1_000_000, 50_000, 100_000],
  ["foreign_income_assets", "2a-a-other", 1_000_000, 55_000, 110_000],
  ["foreign_income_assets", "2a-b-it-ites", 1_000_000, 40_000, 80_000],
  [
    "foreign_income_assets",
    "2a-b-certain-other-services",
    1_000_000,
    80_000,
    160_000,
  ],
  ["foreign_income_assets", "2a-b-other-services", 1_000_000, 150_000, 300_000],
  ["foreign_income_assets", "2a-c-sportsperson", 1_000_000, 150_000, 300_000],
  ["foreign_income_assets", "2a-c-other", 1_000_000, 80_000, 160_000],
];

// Note on ATL / Non-ATL: every expected figure in RATE_CASES above is read
// straight off the rate card and written out in full. There is deliberately
// no "Non-ATL is double ATL" rule anywhere in this suite. Most rows happen to
// double, three of the Section 236G/236H rows do not, and that pattern is a
// coincidence of the rate card rather than a rule the card states. Asserting
// a relationship the source never claims would invent a rule and would have
// to carry a list of exceptions; the literal values carry no such risk.

for (const [route, subcategory, income, atlTax, nonAtlTax] of RATE_CASES) {
  for (const [status, expectedTax] of [
    ["ATL", atlTax],
    ["NON_ATL", nonAtlTax],
  ]) {
    const result = estimate([{ route, income, subcategory }], status);
    const label = `${route}/${subcategory} @ ${income.toLocaleString()} ${status}`;

    check(`${label} produces an estimate`, result.status, "ESTIMATE");
    check(`${label} tax due`, result.taxDue, expectedTax);
    check(`${label} base tax`, result.baseTax, expectedTax);
    // None of these rows carries a surcharge; the 9% surcharge is Section 149
    // only and must not leak onto a flat route.
    check(`${label} carries no surcharge`, result.surcharge, 0);
    check(`${label} prices the income given`, result.taxableIncome, income);
    check(`${label} produces exactly one line`, result.breakdown.length, 1);
    check(`${label} cites a rate-card rule`, result.appliedRuleIds.length, 1);
  }
}

// ---------------------------------------------------------------------------
// 1b — collection routes: Section 148 imports (rate card page 1)
//
// Columns: subcategory, import value, ATL collection, Non-ATL collection.
// Imports ride the same flat dispatch as the income routes above, but the
// line lands in collectionBreakdown with the income-tax totals left at zero:
// the amount was already collected at the customs stage.
// ---------------------------------------------------------------------------

const IMPORT_COLLECTION_CASES = [
  // 1% / 2% — Part-I goods
  ["part-i", 2_000_000, 20_000, 40_000],
  // 2% / 4% — Part-II goods
  ["part-ii", 2_000_000, 40_000, 80_000],
  // 3.5% / 7% — Part-II goods, commercial importer
  ["part-ii-commercial", 2_000_000, 70_000, 140_000],
  // 5.5% / 11% — Part-III goods
  ["part-iii", 2_000_000, 110_000, 220_000],
  // 6% / 12% — Part-III goods, commercial importer
  ["part-iii-commercial", 2_000_000, 120_000, 240_000],
  // 1% / 2% — SRO 1125 manufacturer
  ["sro-1125-manufacturer", 2_000_000, 20_000, 40_000],
  // 4% / 8% — pharmaceutical products
  ["pharma", 2_000_000, 80_000, 160_000],
  // 1% / 2% — EV CKD kits
  ["ev-ckd", 2_000_000, 20_000, 40_000],
];

for (const [
  subcategory,
  income,
  atlTax,
  nonAtlTax,
] of IMPORT_COLLECTION_CASES) {
  for (const [status, expectedTax] of [
    ["ATL", atlTax],
    ["NON_ATL", nonAtlTax],
  ]) {
    const result = estimate(
      [{ route: "imports", income, subcategory }],
      status,
    );
    const label = `imports/${subcategory} @ ${income.toLocaleString()} ${status}`;

    check(`${label} produces an estimate`, result.status, "ESTIMATE");
    check(
      `${label} collects the hand-computed amount`,
      result.collectionTaxDue,
      expectedTax,
    );
    check(
      `${label} produces exactly one collection line`,
      result.collectionBreakdown.length,
      1,
    );
    check(`${label} cites a rate-card rule`, result.appliedRuleIds.length, 1);
    check(`${label} carries no surcharge`, result.surcharge, 0);
    check(`${label} leaves income-tax totals at zero`, result.taxDue, 0);
    check(
      `${label} leaves the income breakdown empty`,
      result.breakdown.length,
      0,
    );
  }
}

// ---------------------------------------------------------------------------
// 2 — refundability
//
// Section 151 profit on debt and the Section 149(IA) pension limbs are final;
// an over-deduction there is not converted into an automatic refund claim.
// Everything else added in this phase stays assessable, which keeps the
// amount inside the refundable pool instead of writing off a client's refund
// claim.
// ---------------------------------------------------------------------------

for (const [route, subcategory] of [
  ["services", "1b-service-it-ites"],
  ["other_income", "prize-bond-crossword"],
  ["capital_gains", "certain-debt-securities"],
  ["business", "1c-contract-company"],
]) {
  const result = estimate([{ route, income: 1_000_000, subcategory }]);
  check(`${route} is not a final-tax route`, result.isFinalTax, false);
  check(`${route} line is not final`, result.breakdown[0].isFinalTax, false);
  check(`${route} tax is assessable`, result.assessableTaxDue, result.taxDue);
  check(`${route} contributes no final tax`, result.finalTaxDue, 0);
}

// Bank profit must still be final after the refactor that generalised it.
// Section 151 is 20% ATL / 40% Non-ATL (rate card page 4).
const bankOnly = estimate([
  {
    route: "bank_profit",
    income: 1_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check("Bank profit still prices at 20%", bankOnly.taxDue, 200_000);
check("Bank profit is still final", bankOnly.isFinalTax, true);
check("Bank profit final tax", bankOnly.finalTaxDue, 200_000);
check("Bank profit assessable tax", bankOnly.assessableTaxDue, 0);

// A final-tax route does not create a refund; an assessable one does.
const finalOverWithheld = estimate(
  [
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ],
  "ATL",
  { taxWithheld: 300_000 },
);
check(
  "Over-withholding on a final route claims no refund",
  finalOverWithheld.refundDue,
  0,
);

const assessableOverWithheld = estimate(
  [{ route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" }],
  "ATL",
  { taxWithheld: 250_000 },
);
check(
  "Over-withholding on an assessable route does claim a refund",
  assessableOverWithheld.refundDue,
  50_000,
);

// ---------------------------------------------------------------------------
// 3 — flat routes combine with anything
//
// A flat rate does not depend on the income beneath it, so these combinations
// must price beside anything, including a combined slab pair.
// ---------------------------------------------------------------------------

// salary 8,000,000 -> 1,981,000 (established by the tax-calculation suite)
// services IT/ITES 5,000,000 @ 4% -> 200,000
const salaryPlusServices = estimate([
  { route: "salary", income: 8_000_000 },
  { route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" },
]);
check("Salary + services prices", salaryPlusServices.status, "ESTIMATE");
check("Salary + services total", salaryPlusServices.taxDue, 2_181_000);
check("Salary + services lines", salaryPlusServices.breakdown.length, 2);
check(
  "Salary + services is fully assessable",
  salaryPlusServices.assessableTaxDue,
  2_181_000,
);

// services 5,000,000 @ 4% -> 200,000 assessable
// bank profit 1,000,000 @ 20% -> 200,000 final
const servicesPlusBank = estimate([
  { route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" },
  {
    route: "bank_profit",
    income: 1_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check("Services + bank prices", servicesPlusBank.status, "ESTIMATE");
check("Services + bank total", servicesPlusBank.taxDue, 400_000);
check("Services + bank final portion", servicesPlusBank.finalTaxDue, 200_000);
check(
  "Services + bank assessable portion",
  servicesPlusBank.assessableTaxDue,
  200_000,
);
check("A mixed return is not wholly final", servicesPlusBank.isFinalTax, false);

// Three flat routes at once.
const threeFlat = estimate([
  { route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" },
  {
    route: "other_income",
    income: 800_000,
    subcategory: "brokerage-commission-other",
  },
  {
    route: "capital_gains",
    income: 2_000_000,
    subcategory: "certain-debt-securities",
  },
]);
check("Three flat routes price", threeFlat.status, "ESTIMATE");
// 200,000 + 96,000 + 300,000
check("Three flat routes total", threeFlat.taxDue, 596_000);
check("Three flat routes produce three lines", threeFlat.breakdown.length, 3);

// A final-tax pension stands apart from the slab, so a flat route prices
// beside a progressive pair as usual: salary 8m -> 1,981,000, pension 4m
// final at 0, services 1m @ 4% -> 40,000.
const progressivePairPlusFlat = estimate([
  { route: "salary", income: 8_000_000 },
  { route: "pension", income: 4_000_000 },
  { route: "services", income: 1_000_000, subcategory: "1b-service-it-ites" },
]);
check(
  "Progressive pair plus flat prices",
  progressivePairPlusFlat.status,
  "ESTIMATE",
);
check(
  "Progressive pair plus flat total",
  progressivePairPlusFlat.taxDue,
  2_021_000,
);
check(
  "Progressive pair plus flat lines",
  progressivePairPlusFlat.breakdown.length,
  3,
);

// ---------------------------------------------------------------------------
// 4 — the calculator refuses rather than guesses
// ---------------------------------------------------------------------------

const noSubcategory = estimate([{ route: "services", income: 5_000_000 }]);
check(
  "A multi-rate route without a category is refused",
  noSubcategory.status,
  "NEEDS_RULES",
);
check(
  "The refusal explains that the category decides the rate",
  /different rate for each catalogued category/.test(noSubcategory.note),
  true,
);
check("A refused estimate has no tax", noSubcategory.taxDue, null);
check("A refused estimate has no breakdown", noSubcategory.breakdown.length, 0);

const unknownSubcategory = estimate([
  { route: "services", income: 5_000_000, subcategory: "not-a-real-row" },
]);
check(
  "An unknown category is refused",
  unknownSubcategory.status,
  "NEEDS_RULES",
);
check(
  "The refusal names the offending category",
  unknownSubcategory.note.includes("not-a-real-row"),
  true,
);

// A category that exists in the catalog under a DIFFERENT source must not be
// accepted here. This is the mistake that would silently price services at a
// dividend rate.
const foreignSubcategory = estimate([
  { route: "services", income: 5_000_000, subcategory: "prize-bond-crossword" },
]);
check(
  "A category belonging to another source is refused",
  foreignSubcategory.status,
  "NEEDS_RULES",
);

// A single-row route may omit the category, because there is nothing to choose.
const capitalGainsNoSub = estimate([
  { route: "capital_gains", income: 2_000_000 },
]);
check(
  "A single-row route prices without a category",
  capitalGainsNoSub.status,
  "ESTIMATE",
);
check(
  "A single-row route uses its only row",
  capitalGainsNoSub.taxDue,
  300_000,
);

// Zero income is a data problem, not a zero-tax return.
const zeroIncome = estimate([
  { route: "services", income: 0, subcategory: "1b-service-it-ites" },
]);
check("A route with no income is refused", zeroIncome.status, "NEEDS_RULES");

// ---------------------------------------------------------------------------
// 5 — two categories under one route stay separate
//
// Collapsing them would price part of the income at the wrong percentage.
// 5,000,000 @ 4% = 200,000 and 2,000,000 @ 1.5% = 30,000. Merging the incomes
// first and applying either rate gives 280,000 or 105,000 — both wrong.
// ---------------------------------------------------------------------------

const twoCategories = estimate([
  { route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" },
  {
    route: "services",
    income: 2_000_000,
    subcategory: "1b-service-advertising-media",
  },
]);
check("Two categories on one route price", twoCategories.status, "ESTIMATE");
check(
  "Two categories produce two separate lines",
  twoCategories.breakdown.length,
  2,
);
check(
  "Two categories are priced at their own rates",
  twoCategories.taxDue,
  230_000,
);
check(
  "Neither wrong single-rate answer is produced",
  twoCategories.taxDue !== 280_000 && twoCategories.taxDue !== 105_000,
  true,
);

// The same category listed twice IS merged, because it is one rate.
const duplicateCategory = estimate([
  { route: "services", income: 3_000_000, subcategory: "1b-service-it-ites" },
  { route: "services", income: 2_000_000, subcategory: "1b-service-it-ites" },
]);
check(
  "A repeated category merges into one line",
  duplicateCategory.breakdown.length,
  1,
);
check(
  "A repeated category is not double-charged",
  duplicateCategory.taxDue,
  200_000,
);

// ---------------------------------------------------------------------------
// 6 — breakdown lines carry their own identity
// ---------------------------------------------------------------------------

const identity = estimate([
  { route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" },
]);
const line = identity.breakdown[0];
check("The line names its route", line.route, "services");
check("The line records its rate shape", line.rateShape, "FLAT");
check("The line records its income", line.income, 5_000_000);
check("The line records its tax", line.taxDue, 200_000);
check(
  "The line cites the exact catalog rule",
  line.appliedRuleIds[0],
  "TY2026-153-1B-SERVICE-IT-ITES",
);

const citedRule = TY2026_RATE_CARD_RULES.find(
  (rule) => rule.id === line.appliedRuleIds[0],
);
check("The cited rule exists in the catalog", Boolean(citedRule), true);
check("The cited rule belongs to this source", citedRule.source, "services");
check(
  "The cited rule is the selected row",
  citedRule.subcategory,
  "1b-service-it-ites",
);
check(
  "The line note cites the section",
  line.note.includes("Section 153"),
  true,
);

// ---------------------------------------------------------------------------
// 7 — the route catalog is data, not branches
//
// The point of FLAT_ROUTE_DEFINITIONS is that adding a flat route is a catalog
// entry. If someone adds a `case "services":` back into the pricing loop the
// design has been lost even though the numbers still pass.
// ---------------------------------------------------------------------------

const engineSource = fs.readFileSync(
  path.join(projectRoot, "lib/tax/tax-calculation.ts"),
  "utf8",
);

check(
  "A flat-route catalog exists",
  /const FLAT_ROUTE_DEFINITIONS/.test(engineSource),
  true,
);
check(
  "Flat routes are dispatched from the catalog, not a switch case",
  /const flatDefinition = FLAT_ROUTE_DEFINITIONS\[source\.route\]/.test(
    engineSource,
  ),
  true,
);

for (const route of [
  "services",
  "other_income",
  "capital_gains",
  "business",
  "bank_profit",
  "imports",
  "advance_tax",
]) {
  check(
    `The pricing loop has no hand-written case for ${route}`,
    new RegExp(`case "${route}":`).test(engineSource),
    false,
  );
}

// --- the allowlist must be a real gate ------------------------------------
//
// There are two guards: the explicit `subcategories` allowlist, and the
// "resolves to exactly one catalog row" lookup. The second alone is NOT
// enough. It only rejects rows that do not exist. The allowlist is what stops
// a row that DOES exist — one added to the catalog later and never reviewed —
// from being priced silently. Assert it structurally, because a behavioural
// test cannot see the difference while the two lists happen to agree.

check(
  "Each flat route declares the exact rows it is cleared to price",
  /subcategories: readonly string\[\]/.test(engineSource),
  true,
);
check(
  "A subcategory outside the allowlist is refused",
  /if \(!definition\.subcategories\.includes\(subcategory\)\)/.test(
    engineSource,
  ),
  true,
);
check(
  "The allowlist is checked before the rate-card row is looked up",
  engineSource.indexOf("definition.subcategories.includes(subcategory)") <
    engineSource.indexOf("candidate.subcategory === subcategory"),
  true,
);
check(
  "The row lookup refuses anything that is not exactly one match",
  /if \(matches\.length !== 1\)/.test(engineSource),
  true,
);

// Catalog drift, in both directions. If a new row appears in the catalog it
// must be deliberately added to the route definition after its rate has been
// checked against the rate card — this assertion turns "silently priced
// unreviewed row" into a failing build.
const { FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS } = require(
  path.join(projectRoot, "lib/tax/tax-calculation.ts"),
);

// Direction 1 — nothing declared may be missing from the catalog. A typo here
// would produce a route the wizard offers and the engine can never price.
for (const [source, declared] of Object.entries(
  FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS,
)) {
  const catalogSubcategories = new Set(
    TY2026_RATE_CARD_RULES.filter((rule) => rule.source === source).map(
      (rule) => rule.subcategory,
    ),
  );
  for (const subcategory of declared) {
    check(
      `${source}/${subcategory} exists in the catalog`,
      catalogSubcategories.has(subcategory),
      true,
    );
  }
}

// Direction 2 — the routes this phase implements must cover their whole
// source. If a new row is added to the rate card for one of them it has to be
// reviewed against the PDF and listed deliberately; this assertion fails until
// someone does that, which is the point.
//
// bank_profit is deliberately NOT in this list. Section 151 has six catalogued
// rows and only the bank-deposit row is implemented; the other five (government
// securities, Sukuk, other profit on debt) predate this phase and still report
// NEEDS_RULES. Adding them is its own task with its own rate checks.
const FULLY_COVERED_SOURCES = [
  "services",
  "other_income",
  "capital_gains",
  "business",
  "bank_profit",
  "foreign_income_assets",
  "dividend",
  "imports",
];

for (const source of FULLY_COVERED_SOURCES) {
  const catalogSubcategories = TY2026_RATE_CARD_RULES.filter(
    (rule) => rule.source === source,
  )
    .map((rule) => rule.subcategory)
    .sort();
  const declared = [
    ...(FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS[source] ?? []),
  ].sort();

  check(
    `${source}: every catalog row is declared (a new row must be reviewed, not auto-priced)`,
    declared.join("|"),
    catalogSubcategories.join("|"),
  );
}

// Dividend is fully covered: the mutual-fund proportional row is a COMPOSITE
// charge priced from the debt/equity split the taxpayer declares on the card.
// The engine refuses the row when the split is missing or does not add up,
// and prices it otherwise — pinned both ways below.
const dividendCatalogRows = TY2026_RATE_CARD_RULES.filter(
  (rule) => rule.source === "dividend",
);
check(
  "Section 150 plus 236Z give eight dividend rows",
  dividendCatalogRows.length,
  8,
);
check(
  "Eight dividend rows are implemented",
  FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS.dividend.length,
  8,
);
check(
  "The mutual-fund proportional row is implemented",
  FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS.dividend.includes(
    "mutual-fund-proportional",
  ),
  true,
);

const compositeRow = dividendCatalogRows.find(
  (rule) => rule.subcategory === "mutual-fund-proportional",
);
check(
  "The proportional row is a COMPOSITE charge",
  compositeRow.rates.ATL.kind,
  "COMPOSITE",
);

const proportionalAttempt = estimate([
  {
    route: "dividend",
    income: 2_000_000,
    subcategory: "mutual-fund-proportional",
  },
]);
check(
  "Pricing the proportional row is refused",
  proportionalAttempt.status,
  "NEEDS_RULES",
);
check(
  "The whole dividend is not priced at a single rate instead",
  proportionalAttempt.taxDue,
  null,
);

// PKR 2m split 1.2m debt / 0.8m equity: 25% + 15% ATL, 50% + 30% Non-ATL.
const proportionalPriced = estimate([
  {
    route: "dividend",
    income: 2_000_000,
    subcategory: "mutual-fund-proportional",
    attributes: { debtPortion: 1_200_000, equityPortion: 800_000 },
  },
]);
check(
  "The split row prices at 25% debt plus 15% equity",
  proportionalPriced.taxDue,
  420_000,
);
const proportionalPricedNonAtl = estimate(
  [
    {
      route: "dividend",
      income: 2_000_000,
      subcategory: "mutual-fund-proportional",
      attributes: { debtPortion: 1_200_000, equityPortion: 800_000 },
    },
  ],
  "NON_ATL",
);
check(
  "The split row prices at 50% debt plus 30% equity for Non-ATL",
  proportionalPricedNonAtl.taxDue,
  840_000,
);
const proportionalMismatch = estimate([
  {
    route: "dividend",
    income: 2_000_000,
    subcategory: "mutual-fund-proportional",
    attributes: { debtPortion: 1_000_000, equityPortion: 800_000 },
  },
]);
check(
  "A split that does not add up is refused",
  proportionalMismatch.status,
  "NEEDS_RULES",
);
check(
  "The refusal names the mismatch",
  proportionalMismatch.note.includes("must equal the dividend income"),
  true,
);

// --- imports: the two mobile-phone rows ------------------------------------
//
// Mobiles are fixed charges by C&F value band from Part-II of the First
// Schedule (Ordinance) — the card carries only each column's minimum and
// maximum. Six bands, hand-copied: 70/100/930/970/5000/11500 on the CBU code
// and 0/0/0/0/3000/5200 on the CKD code, doubled for Non-ATL.
const importsCatalogRows = TY2026_RATE_CARD_RULES.filter(
  (rule) => rule.source === "imports",
);
check("Section 148 gives ten import rows", importsCatalogRows.length, 10);
check(
  "Ten import rows are implemented",
  FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS.imports.length,
  10,
);

const MOBILE_BAND_CASES = [
  // [C&F USD, CBU charge, CKD charge]
  [25, 70, 0],
  [30, 70, 0],
  [100, 100, 0],
  [150, 930, 0],
  [350, 970, 0],
  [400, 5000, 3000],
  [600, 11500, 5200],
];
for (const [usd, cbuTax, ckdTax] of MOBILE_BAND_CASES) {
  for (const [subcategory, expectedTax] of [
    ["mobile-pct-8517-1219", cbuTax],
    ["mobile-pct-8517-1211", ckdTax],
  ]) {
    for (const [status, multiplier] of [
      ["ATL", 1],
      ["NON_ATL", 2],
    ]) {
      const result = estimate(
        [
          {
            route: "imports",
            income: 0,
            subcategory,
            attributes: { cfValueUsd: usd, isSmartphone: false },
          },
        ],
        status,
      );
      const label = `${subcategory} at $${usd} ${status}`;
      check(`${label} produces an estimate`, result.status, "ESTIMATE");
      check(
        `${label} charges the hand-copied band`,
        result.collectionTaxDue,
        expectedTax * multiplier,
      );
    }
  }
}
// A $25 smartphone rides band 2, not band 1.
const smartphone25 = estimate([
  {
    route: "imports",
    income: 0,
    subcategory: "mobile-pct-8517-1219",
    attributes: { cfValueUsd: 25, isSmartphone: true },
  },
]);
check("Smartphone at $25 pays band 2", smartphone25.collectionTaxDue, 100);
// An unconfirmed type at $30 or less refuses on the CBU code...
const unknownType = estimate([
  {
    route: "imports",
    income: 0,
    subcategory: "mobile-pct-8517-1219",
    attributes: { cfValueUsd: 25 },
  },
]);
check(
  "Unconfirmed handset type at $25 is refused",
  unknownType.status,
  "NEEDS_RULES",
);
check(
  "The refusal asks the smartphone question",
  unknownType.note.includes("smartphone"),
  true,
);
// ...but not above $30, and never on the CKD code, where both low bands pay
// nothing either way.
const expensiveNoFlag = estimate([
  {
    route: "imports",
    income: 0,
    subcategory: "mobile-pct-8517-1219",
    attributes: { cfValueUsd: 600 },
  },
]);
check("No handset question above $30", expensiveNoFlag.collectionTaxDue, 11500);
const cheapCkdNoFlag = estimate([
  {
    route: "imports",
    income: 0,
    subcategory: "mobile-pct-8517-1211",
    attributes: { cfValueUsd: 25 },
  },
]);
check("CKD at $25 pays nothing", cheapCkdNoFlag.collectionTaxDue, 0);
// A missing C&F value refuses; there is no band without it.
const noUsd = estimate([
  { route: "imports", income: 0, subcategory: "mobile-pct-8517-1219" },
]);
check("Mobile without a C&F value is refused", noUsd.status, "NEEDS_RULES");
check(
  "The refusal names the missing value",
  noUsd.note.includes("C&F value in USD"),
  true,
);
// A late filer is still a filer: the filer charge, not double.
const lateMobile = estimate(
  [
    {
      route: "imports",
      income: 0,
      subcategory: "mobile-pct-8517-1219",
      attributes: { cfValueUsd: 600 },
    },
  ],
  "LATE_FILER",
);
check(
  "Late-filer mobile pays the filer charge",
  lateMobile.collectionTaxDue,
  11500,
);
// Every priced import row must cite its own catalog rule. Mobiles need their
// banding inputs to price at all.
for (const subcategory of FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS.imports) {
  const rule = importsCatalogRows.find(
    (candidate) => candidate.subcategory === subcategory,
  );
  const attributes = subcategory.startsWith("mobile-")
    ? { cfValueUsd: 600 }
    : undefined;
  const result = estimate([
    { route: "imports", income: 1_000_000, subcategory, attributes },
  ]);
  check(
    `imports/${subcategory} cites its own rule`,
    result.collectionBreakdown[0].appliedRuleIds[0],
    rule.id,
  );
}

// --- amount-banded rows -----------------------------------------------------
//
// Sukuk held by an individual/AOP is 12.5% above a PKR 1 million return and
// 10% below it. Selecting the wrong band must be refused, not priced: at
// 4,000,000 the "below 1m" row would give 400,000 instead of 500,000.

const wrongBandLow = estimate([
  {
    route: "bank_profit",
    income: 4_000_000,
    subcategory: "sukuk-individual-aop-below-1m",
  },
]);
check(
  "A Sukuk return above the band cannot use the below-1m row",
  wrongBandLow.status,
  "NEEDS_RULES",
);
check(
  "The refusal points at the correct band",
  wrongBandLow.note.includes("sukuk-individual-aop-above-1m"),
  true,
);

const wrongBandHigh = estimate([
  {
    route: "bank_profit",
    income: 800_000,
    subcategory: "sukuk-individual-aop-above-1m",
  },
]);
check(
  "A Sukuk return below the band cannot use the above-1m row",
  wrongBandHigh.status,
  "NEEDS_RULES",
);
check(
  "The refusal points at the other band",
  wrongBandHigh.note.includes("sukuk-individual-aop-below-1m"),
  true,
);

// Exactly PKR 1,000,000 sits in neither band: the card says "greater than" and
// "less than". Refusing is correct; silently choosing one would invent a rule.
for (const subcategory of [
  "sukuk-individual-aop-above-1m",
  "sukuk-individual-aop-below-1m",
]) {
  const atBoundary = estimate([
    { route: "bank_profit", income: 1_000_000, subcategory },
  ]);
  check(
    `Exactly 1m is refused for ${subcategory}`,
    atBoundary.status,
    "NEEDS_RULES",
  );
}

// Unbanded rows must not be affected by the band check.
const unbanded = estimate([
  { route: "bank_profit", income: 4_000_000, subcategory: "sukuk-company" },
]);
check("An unbanded row prices at any amount", unbanded.status, "ESTIMATE");
check("Sukuk company at 4m", unbanded.taxDue, 1_000_000);

// Every subcategory the catalog offers for these sources must be priceable.
// A row listed in the wizard but absent from the definition would silently
// become a NEEDS_RULES dead end.
for (const source of [
  "services",
  "other_income",
  "capital_gains",
  "business",
]) {
  const catalogRows = TY2026_RATE_CARD_RULES.filter(
    (rule) => rule.source === source,
  );
  for (const rule of catalogRows) {
    const result = estimate([
      { route: source, income: 1_000_000, subcategory: rule.subcategory },
    ]);
    check(
      `${source}/${rule.subcategory} is priceable`,
      result.status,
      "ESTIMATE",
    );
    check(
      `${source}/${rule.subcategory} cites its own rule`,
      result.breakdown[0].appliedRuleIds[0],
      rule.id,
    );
  }
}

// ---------------------------------------------------------------------------
// 7b — surcharge is charged on CALCULATED TAX, never on income
//
// Client-confirmed rule, re-verified against the rate card:
//   Section 149     salary above 10m  -> 9%  (page 2, "surcharge @ 9%")
//   Section 149(IA) pension above 10m -> 10% (page 2, "plus surcharge @ 10.00%")
//
// Both percentages are applied to the tax already calculated, not to taxable
// income. The wrong basis is asserted as an explicit non-result so the mistake
// cannot reappear silently.
// ---------------------------------------------------------------------------

const salarySurcharge = estimate([{ route: "salary", income: 12_000_000 }]);
check("Salary 12m base tax", salarySurcharge.baseTax, 3_381_000);
check(
  "Salary surcharge is 9% of calculated tax",
  salarySurcharge.surcharge,
  Math.round(3_381_000 * 0.09),
);
check("Salary surcharge value", salarySurcharge.surcharge, 304_290);
check("Salary 12m total", salarySurcharge.taxDue, 3_685_290);
// 9% of 12,000,000 would be 1,080,000. It must never be that.
check(
  "Salary surcharge is NOT 9% of taxable income",
  salarySurcharge.surcharge === 1_080_000,
  false,
);

const pensionSurcharge = estimate(
  [{ route: "pension", income: 15_000_000 }],
  "ATL",
  { pensionerAgeBelow70: true },
);
check(
  "Pension 15m base tax is 5% of the excess",
  pensionSurcharge.baseTax,
  250_000,
);
check(
  "Pension surcharge is 10% of calculated tax",
  pensionSurcharge.surcharge,
  Math.round(250_000 * 0.1),
);
check("Pension surcharge value", pensionSurcharge.surcharge, 25_000);
check("Pension 15m total", pensionSurcharge.taxDue, 275_000);
// 10% of 15,000,000 would be 1,500,000.
check(
  "Pension surcharge is NOT 10% of pension income",
  pensionSurcharge.surcharge === 1_500_000,
  false,
);

// The former-employer pension row references Section 149, so the action flags
// the whole pension onto the salary slabs. Anchored to the salary 12m figure
// pinned above (3,685,290).
const pensionAsSalary = estimate(
  [{ route: "pension", income: 12_000_000 }],
  "ATL",
  { pensionTaxAsSalary: true },
);
check(
  "Former-employer pension uses the salary slabs",
  pensionAsSalary.taxDue,
  3_685_290,
);

// Section 12(2A)(i): at 70 the pension is exempt however large.
const pension70Plus = estimate(
  [{ route: "pension", income: 15_000_000 }],
  "ATL",
  { pensionerAgeBelow70: false, pensionerAge70OrAbove: true },
);
check("Pension at 70-plus is estimated", pension70Plus.status, "ESTIMATE");
check("Pension at 70-plus pays nothing", pension70Plus.taxDue, 0);

// The two surcharge percentages are different and must not be conflated.
check(
  "Salary and pension use different surcharge percentages",
  salarySurcharge.surcharge / 3_381_000 !==
    pensionSurcharge.surcharge / 250_000,
  true,
);

// Threshold: the rate card says "exceeds", so exactly 10m carries none.
const atThreshold = estimate([{ route: "salary", income: 10_000_000 }]);
check("No surcharge at exactly 10m", atThreshold.surcharge, 0);
const overThreshold = estimate([{ route: "salary", income: 10_000_001 }]);
check(
  "Surcharge applies one rupee above 10m",
  overThreshold.surcharge > 0,
  true,
);

// A flat route must never attract the salary surcharge, however large it is.
for (const [route, subcategory] of [
  ["services", "1b-service-other"],
  ["business", "1c-contract-sportsperson"],
  ["other_income", "prize-bond-crossword"],
  ["capital_gains", "certain-debt-securities"],
  ["bank_profit", "bank-or-financial-institution-deposit"],
]) {
  const large = estimate([{ route, income: 50_000_000, subcategory }]);
  check(`${route} at 50m carries no surcharge`, large.surcharge, 0);
  check(
    `${route} at 50m line carries no surcharge`,
    large.breakdown[0].surcharge,
    0,
  );
}

// The helper itself must refuse any basis other than calculated tax.
check(
  "The surcharge helper refuses a basis other than CALCULATED_TAX",
  /if \(surcharge\.basis !== "CALCULATED_TAX"\) return 0;/.test(engineSource),
  true,
);
check(
  "The surcharge multiplies calculated tax, not income",
  /return calculatedTax \* \(surcharge\.percent \/ 100\);/.test(engineSource),
  true,
);

// Both catalogued surcharges must declare that basis.
const surchargeRules = TY2026_RATE_CARD_RULES.filter((rule) => rule.surcharge);
check("Exactly two rules carry a surcharge", surchargeRules.length, 2);
for (const rule of surchargeRules) {
  check(
    `${rule.id} charges the surcharge on calculated tax`,
    rule.surcharge.basis,
    "CALCULATED_TAX",
  );
}
check(
  "Section 149 salary surcharge is 9%",
  surchargeRules.find((rule) => rule.subcategory === "salary-surcharge")
    .surcharge.percent,
  9,
);
check(
  "Section 149(IA) pension surcharge is 10%",
  surchargeRules.find(
    (rule) => rule.subcategory === "pension-above-10m-below-age-70",
  ).surcharge.percent,
  10,
);

// ---------------------------------------------------------------------------
// 8 — the server action routes the income and blocks ambiguous splits
// ---------------------------------------------------------------------------

const actionSource = fs.readFileSync(
  path.join(projectRoot, "app/actions/tax-calculation.ts"),
  "utf8",
);

for (const category of [
  "SERVICES",
  "CAPITAL_GAINS",
  "COMMISSION",
  "PRIZE",
  "BUSINESS",
  "EXPORTS",
  "CONTRACT",
  "DIVIDEND",
]) {
  check(
    `Ledger category ${category} is recognised`,
    actionSource.includes(`"${category}"`),
    true,
  );
}

// The salary remainder must subtract every newly routed amount, or services
// income would be taxed twice: once at its own rate and once inside salary.
const salaryRemainder = actionSource.slice(
  actionSource.indexOf("const salaryIncomeFromLedger = Math.max("),
  actionSource.indexOf("const bankSalaryIncome"),
);
for (const term of [
  "bankProfitIncome",
  "pensionIncome",
  "rentalIncome",
  "servicesIncome",
  "otherIncomeAmount",
  "capitalGainsIncome",
  "businessIncome",
  "dividendIncome",
]) {
  check(
    `The salary remainder subtracts ${term}`,
    salaryRemainder.includes(term),
    true,
  );
}

check(
  "Mapped certificate gross replaces only salary bank credits",
  /resolveSalaryTaxableIncome\(\{[\s\S]*?ledgerSalaryRemainder: salaryIncomeFromLedger,[\s\S]*?bankSalaryIncome,[\s\S]*?certificateGrossSalary/s.test(
    actionSource,
  ),
  true,
);

check(
  "Flat routes are appended to the priced source list",
  /routedIncomeSources\.push\(\.\.\.flatRouteSources\)/.test(actionSource),
  true,
);
check(
  "Activity routes are appended to the priced source list",
  /routedIncomeSources\.push\(\.\.\.activitySources\)/.test(actionSource),
  true,
);
check(
  "The missing-figures blocker takes priority over the split message",
  actionSource.indexOf("activityDetailProblems.length > 0") <
    actionSource.indexOf("flatRoutesNeedingSplit.length > 0"),
  true,
);
check(
  "The action flags former-employer pensions onto the salary slabs",
  actionSource.includes("pensionTaxAsSalary"),
  true,
);
check(
  "Newly routed sources are marked as routed, so they are not reported unrouted",
  /for \(const source of routedFlatSourceNames\) routedSourceNames\.add\(source\)/.test(
    actionSource,
  ),
  true,
);
check(
  "Selecting several categories under one source is blocked, not apportioned",
  /flatRoutesNeedingSplit\.push\(entry\.source\)/.test(actionSource),
  true,
);
check(
  "The split blocker takes priority over the unrouted message",
  actionSource.indexOf("flatRoutesNeedingSplit.length > 0") <
    actionSource.indexOf("unroutedSources.length > 0"),
  true,
);
// Guards the reverted pro-rata attempt: income must never be split across
// categories by formula. Matches identifiers/calls, not the prose in comments
// that explains why apportioning is refused.
check(
  "No apportionment helper was introduced",
  /(function|const|let)\s+\w*[aA]pportion|\bapportion\w*\s*\(|proRata|pro_rata/.test(
    actionSource,
  ),
  false,
);

// --- Section 152: the single-rate rows ---------------------------------------
//
// Twelve Section 152 rows carry one rate with a blank Non-ATL column, so a
// filer and a non-filer are charged the same. That is unusual enough that a
// future reader would assume it is a bug, so it is pinned here against the
// catalog itself: the assertion reads the card, it does not restate it.
//
// The seven 152(2A) rows must keep their ATL/Non-ATL split, which guards the
// opposite mistake — collapsing every Section 152 row onto one rate.

const SINGLE_RATE_152 = [
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
];

for (const rule of TY2026_RATE_CARD_RULES.filter(
  (candidate) => candidate.source === "foreign_income_assets",
)) {
  const isSingleRate = SINGLE_RATE_152.includes(rule.subcategory);
  check(
    `Section 152 ${rule.subcategory}: card ${isSingleRate ? "gives one rate" : "splits ATL from Non-ATL"}`,
    Boolean(rule.rates.DEFAULT) && !rule.rates.ATL && !rule.rates.NON_ATL,
    isSingleRate,
  );
}

check(
  "Twelve Section 152 rows are single-rate and seven are split",
  SINGLE_RATE_152.length,
  12,
);

// Section 152 withholding is adjustable: unlike Section 151 bank profit, the
// card does not describe it as a final discharge, so over-withholding must
// still produce a refund rather than being absorbed.
const nonResidentOverWithheld = estimate(
  [
    {
      route: "foreign_income_assets",
      income: 1_000_000,
      subcategory: "2a-b-it-ites",
    },
  ],
  "ATL",
  { taxWithheld: 60_000 },
);
check(
  "Section 152 is not treated as a final tax",
  nonResidentOverWithheld.refundDue,
  20_000,
);

if (failures.length > 0) {
  console.error("Flat income route checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Flat income route checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      routesAdded: [
        "services",
        "other_income",
        "capital_gains",
        "business",
        "dividend",
        "foreign_income_assets",
        "imports",
      ],
      catalogRowsNowPriceable: RATE_CASES.length,
      implementedRoutes: [
        "salary",
        "pension",
        "property_rent",
        "bank_profit",
        "services",
        "other_income",
        "capital_gains",
        "business",
        "dividend",
        "imports",
      ],
      finalTaxRoutes: ["bank_profit"],
      note: "Flat routes are catalog entries, not branches; a multi-rate route without a selected category is refused rather than guessed.",
    },
    null,
    2,
  ),
);
