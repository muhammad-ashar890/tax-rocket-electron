/**
 * Advance tax — Sections 231AB through 236Y (rate card pages 5-14).
 *
 * Like the flat income routes, every expected figure below is worked out by
 * hand from the FBR TY2026 withholding rate card and hard-coded. The engine
 * is never asked what it thinks the rate is; it is asked to produce a number
 * that was worked out independently.
 *
 * Advance tax differs from the income routes in two ways this suite pins:
 * priced lines land in collectionBreakdown with the income-tax totals left at
 * zero (the amount was already collected at source), and several categories
 * need declared figures — engine capacity, seat counts, laden weight — that
 * the card cannot supply, so a missing figure must refuse the estimate rather
 * than price a guess.
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

const {
  calculateTaxEstimate,
  ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS,
  ADVANCE_TAX_UNPRICED_SUBCATEGORIES_FOR_TESTS,
} = require(path.join(projectRoot, "lib/tax/tax-calculation.ts"));
const { TY2026_RATE_CARD_RULES } = require(
  path.join(projectRoot, "lib/tax/rules/ty2026/catalog.ts"),
);
const { getTy2026SubcategoryDetailFields } = require(
  path.join(projectRoot, "lib/tax/rules/ty2026/subcategories.ts"),
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

function estimate(subcategory, income, attributes, filerStatus = "ATL") {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus,
    totalIncome: 0,
    totalExpenses: 0,
    isSalariedRoute: false,
    isBankProfitRoute: false,
    incomeSources: [
      { route: "advance_tax", income, subcategory, attributes },
    ],
  });
}

// ---------------------------------------------------------------------------
// 1 — every priced category, worked out by hand from the rate card
//
// Columns: subcategory, base amount, declared figures, ATL tax, Non-ATL tax.
// ---------------------------------------------------------------------------

const ADVANCE_CASES = [
  // --- Section 231AB: 0.8% of cash withdrawn while not on ATL -------------
  // ATL carries a NOT_APPLICABLE rate: a priced zero, not a refusal.
  ["cash-withdrawal", 1_000_000, {}, 0, 8_000],
  // --- Section 231B(1)/(3): percentage of vehicle value within a cc band --
  // 1300 cc sits in the 1001-1300 band: 1.5% / 4.5%.
  ["motor-vehicle-value", 3_000_000, { engineCapacityCc: 1300 }, 45_000, 135_000],
  // 850 cc is the top of the first band: 0.5% / 1.5%.
  ["motor-vehicle-value", 2_000_000, { engineCapacityCc: 850 }, 10_000, 30_000],
  // 851 cc opens the second band: 1% / 3%.
  ["motor-vehicle-value", 2_000_000, { engineCapacityCc: 851 }, 20_000, 60_000],
  // --- Section 231B(2): fixed transfer charge within a cc band ------------
  // 900 cc: Rs 5,000 / Rs 15,000.
  ["motor-vehicle-section-231b-2", 0, { engineCapacityCc: 900 }, 5_000, 15_000],
  // Up to 850 cc the card charges nothing: ZERO / ZERO.
  ["motor-vehicle-section-231b-2", 0, { engineCapacityCc: 800 }, 0, 0],
  // --- Section 231B(2A): fixed lease charge within a cc band --------------
  // 1500 cc: Rs 200,000 / Rs 600,000.
  ["motor-vehicle-section-231b-2a", 0, { engineCapacityCc: 1500 }, 200_000, 600_000],
  // --- Section 231B endnote 1: non-cc 3% / 9% at Rs 5m or more -----------
  // Rs 8m EV: 3% = 240,000 ATL; 9% = 720,000 non-ATL (Tenth Schedule 3x).
  ["motor-vehicle-non-cc-value-5m-or-more", 8_000_000, {}, 240_000, 720_000],
  // Boundary: exactly Rs 5m still qualifies.
  ["motor-vehicle-non-cc-value-5m-or-more", 5_000_000, {}, 150_000, 450_000],
  // --- Section 231B endnote 2: Rs 20,000 / Rs 60,000, 10%/yr off ---------
  // New: 20,000 / 60,000. Five completed years: x0.9^5 -> 11,810 / 35,429.
  ["motor-vehicle-non-cc-fixed", 6_000_000, { vehicleAgeYears: 0 }, 20_000, 60_000],
  ["motor-vehicle-non-cc-fixed", 6_000_000, { vehicleAgeYears: 5 }, 11_810, 35_429],
  // --- Section 231C: Rs 200,000 / Rs 400,000 per worker --------------------
  ["foreign-domestic-worker", 0, { unitQuantity: 2 }, 400_000, 800_000],
  // --- Section 234: Rs 2.50 per kg laden weight up to 8,120 kg ------------
  ["goods-transport-vehicle", 0, { ladenWeightKg: 8000 }, 20_000, 20_000],
  // Above 8,120 kg the card charges a fixed Rs 1,200 instead.
  ["goods-transport-vehicle-above-8120kg", 0, { ladenWeightKg: 9000 }, 1_200, 1_200],
  // --- Section 234: per-seat bands. 12 seats: Rs 500 / Rs 750 a seat ------
  ["passenger-transport-per-seat", 0, { seatCount: 12 }, 6_000, 9_000],
  // --- Section 234: annual 1300 cc band is Rs 2,500 / Rs 5,000 ------------
  ["motor-vehicle-annual", 0, { engineCapacityCc: 1300 }, 2_500, 5_000],
  // --- Section 234: lump-sum 1300 cc band is Rs 30,000 / Rs 60,000 --------
  ["motor-vehicle-lump-sum", 0, { engineCapacityCc: 1300 }, 30_000, 60_000],
  // --- Section 235: shared commercial/industrial band ---------------------
  // Rs 10,000 bill: 10%. Rs 400 bill: ZERO band.
  ["electricity-commercial-industrial", 10_000, {}, 1_000, 1_000],
  ["electricity-commercial-industrial", 400, {}, 0, 0],
  // --- Section 235: marginal rows above Rs 20,000 --------------------------
  // Commercial Rs 30,000: 1,950 + 12% of 10,000 = 3,150.
  ["electricity-commercial", 30_000, {}, 3_150, 3_150],
  // Industrial Rs 30,000: 1,950 + 5% of 10,000 = 2,450.
  ["electricity-industrial", 30_000, {}, 2_450, 2_450],
  // --- Section 235: domestic bills, non-ATL only ---------------------------
  // Rs 30,000: 7.5% for non-ATL, NOT_APPLICABLE (zero) for ATL.
  ["electricity-domestic-non-atl", 30_000, {}, 0, 2_250],
  // Below Rs 25,000 even non-ATL pays nothing: ZERO.
  ["electricity-domestic-non-atl", 20_000, {}, 0, 0],
  // --- Section 236: landline 10% of the bill above Rs 1,000 ---------------
  // Rs 1,500 bill: 10% of 500 = 50. Rs 800 bill: nothing.
  ["landline-telephone", 1_500, {}, 50, 50],
  ["landline-telephone", 800, {}, 0, 0],
  // --- Section 236: 15% on internet/mobile prepaid -------------------------
  ["internet-mobile-prepaid", 10_000, {}, 1_500, 1_500],
  // --- Section 236A auctions: 10%/20% movable, 5%/10% immovable ------------
  ["public-auction-movable-or-other", 1_000_000, {}, 100_000, 200_000],
  ["public-auction-immovable-or-railways", 1_000_000, {}, 50_000, 100_000],
  // --- Section 236C transfer: 4.5% / 11.5% up to Rs 50m --------------------
  ["immovable-property-transfer", 40_000_000, {}, 1_800_000, 4_600_000],
  // 50-100m band: 5% ATL. Above 100m: 5.5% ATL.
  ["immovable-property-transfer", 60_000_000, {}, 3_000_000, 6_900_000],
  ["immovable-property-transfer", 120_000_000, {}, 6_600_000, 13_800_000],
  // --- Section 236K purchase: 1.5% / 10.5% up to Rs 50m --------------------
  ["immovable-property-purchase", 40_000_000, {}, 600_000, 4_200_000],
  // 50-100m band: 2% / 14.5%. Above 100m: 2.5% / 18.5%.
  ["immovable-property-purchase", 60_000_000, {}, 1_200_000, 8_700_000],
  ["immovable-property-purchase", 120_000_000, {}, 3_000_000, 22_200_000],
  // --- Section 236CA: Rs 1m per serial episode ------------------------------
  ["foreign-tv-serial", 0, { unitQuantity: 3 }, 3_000_000, 3_000_000],
  // --- Section 236CA: single-episode play is one Rs 3m charge ---------------
  ["foreign-tv-play-single-episode", 0, {}, 3_000_000, 3_000_000],
  // --- Section 236CA: Rs 100,000 per ad second ------------------------------
  ["advertisement-foreign-actor", 0, { unitQuantity: 30 }, 3_000_000, 3_000_000],
  // --- Section 236CB functions: 10% / 20% of the bill ----------------------
  ["function-gathering", 500_000, {}, 50_000, 100_000],
  // --- Section 236Y card remittance abroad: 5% / 10% ------------------------
  ["card-remittance-abroad", 200_000, {}, 10_000, 20_000],
];

for (const [subcategory, income, attributes, atlTax, nonAtlTax] of ADVANCE_CASES) {
  for (const [status, expectedTax] of [
    ["ATL", atlTax],
    ["NON_ATL", nonAtlTax],
  ]) {
    const result = estimate(subcategory, income, attributes, status);
    const label = `advance_tax/${subcategory} ${status}`;

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
    check(`${label} cites a rate-card rule`, result.appliedRuleIds.length >= 1, true);
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
// 2 — late-filer property rates (Sections 236C and 236K carry LATE_FILER rows)
// ---------------------------------------------------------------------------

// Rs 40m transfer: 7.5% late-filer.
const transferLate = estimate("immovable-property-transfer", 40_000_000, {}, "LATE_FILER");
check("236C late-filer transfer at 40m", transferLate.collectionTaxDue, 3_000_000);
// Rs 40m purchase: 4.5% late-filer.
const purchaseLate = estimate("immovable-property-purchase", 40_000_000, {}, "LATE_FILER");
check("236K late-filer purchase at 40m", purchaseLate.collectionTaxDue, 1_800_000);
// A late filer is still a filer: without a LATE_FILER row the ATL rate
// applies, so cash withdrawal stays NOT_APPLICABLE (zero) rather than 0.8%.
const cashLate = estimate("cash-withdrawal", 1_000_000, {}, "LATE_FILER");
check("Late-filer cash withdrawal follows ATL", cashLate.collectionTaxDue, 0);

// ---------------------------------------------------------------------------
// 3 — the shared electricity fallback cites both rows
// ---------------------------------------------------------------------------

// A Rs 10,000 commercial bill sits in the shared band, so the shared row
// prices it and both rows are cited.
const commercialShared = estimate("electricity-commercial", 10_000, {});
check(
  "Commercial bill under 20k falls back to the shared band",
  commercialShared.collectionTaxDue,
  1_000,
);
check(
  "The fallback cites both the shared and the own row",
  commercialShared.collectionBreakdown[0].appliedRuleIds.length,
  2,
);

// ---------------------------------------------------------------------------
// 4 — wrong-card selections name the right card instead of double-charging
// ---------------------------------------------------------------------------

const goodsTooHeavy = estimate("goods-transport-vehicle", 0, { ladenWeightKg: 9000 });
check(
  "Per-kg goods above 8,120 kg is refused",
  goodsTooHeavy.status,
  "NEEDS_RULES",
);
check(
  "The refusal names the fixed-charge card",
  goodsTooHeavy.note.includes("goods-transport-vehicle-above-8120kg"),
  true,
);
const goodsTooLight = estimate(
  "goods-transport-vehicle-above-8120kg",
  0,
  { ladenWeightKg: 8000 },
);
check(
  "Fixed goods at 8,120 kg or below is refused",
  goodsTooLight.status,
  "NEEDS_RULES",
);
check(
  "The refusal names the per-kg card",
  goodsTooLight.note.includes("goods-transport-vehicle (per-kg)"),
  true,
);
const sharedTooHigh = estimate("electricity-commercial-industrial", 25_000, {});
check(
  "Shared electricity above Rs 20,000 is refused",
  sharedTooHigh.status,
  "NEEDS_RULES",
);
check(
  "The refusal names the split cards",
  sharedTooHigh.note.includes("electricity-commercial"),
  true,
);
const tooFewSeats = estimate("passenger-transport-per-seat", 0, { seatCount: 3 });
check("Fewer than 4 seats is refused", tooFewSeats.status, "NEEDS_RULES");
check(
  "The refusal states where the bands start",
  tooFewSeats.note.includes("start at 4 persons"),
  true,
);

// ---------------------------------------------------------------------------
// 5 — missing figures refuse the estimate; nothing is guessed
// ---------------------------------------------------------------------------

for (const [subcategory, attributes, fragment] of [
  ["motor-vehicle-value", {}, "Engine capacity in cc is required"],
  ["motor-vehicle-section-231b-2", {}, "Engine capacity in cc is required"],
  ["foreign-domestic-worker", {}, "number of foreign domestic workers"],
  ["goods-transport-vehicle", {}, "Laden weight in kg is required"],
  ["passenger-transport-per-seat", {}, "seat/person count is required"],
  ["foreign-tv-serial", {}, "number of episodes"],
  ["advertisement-foreign-actor", {}, "duration in seconds"],
]) {
  const result = estimate(subcategory, 0, attributes);
  check(
    `${subcategory} without declared figures is refused`,
    result.status,
    "NEEDS_RULES",
  );
  check(
    `${subcategory} refusal names the missing figure`,
    result.note.includes(fragment),
    true,
  );
}

const noSubcategory = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 0,
  totalExpenses: 0,
  isSalariedRoute: false,
  isBankProfitRoute: false,
  incomeSources: [{ route: "advance_tax", income: 10_000 }],
});
check("Advance tax without a category is refused", noSubcategory.status, "NEEDS_RULES");

const bogus = estimate("not-a-category", 10_000, {});
check("An unknown category is refused", bogus.status, "NEEDS_RULES");
check(
  "The refusal does not borrow a sibling rate",
  bogus.note.includes("not one this calculator prices"),
  true,
);

// ---------------------------------------------------------------------------
// 6 — non-cc guardrails: the Rs 5m floor, the age figure, late filers
// ---------------------------------------------------------------------------

// Below Rs 5m no rate is set for either endnote row.
const belowFloorValue = estimate("motor-vehicle-non-cc-value-5m-or-more", 4_000_000, {});
check("Non-cc 3% below Rs 5m is refused", belowFloorValue.status, "NEEDS_RULES");
check(
  "Non-cc 3% refusal names the Rs 5m floor",
  belowFloorValue.note.includes("5,000,000"),
  true,
);
const belowFloorFixed = estimate(
  "motor-vehicle-non-cc-fixed",
  4_000_000,
  { vehicleAgeYears: 2 },
);
check("Non-cc fixed below Rs 5m is refused", belowFloorFixed.status, "NEEDS_RULES");

// The fixed row needs completed whole years since first registration.
const missingYears = estimate("motor-vehicle-non-cc-fixed", 6_000_000, {});
check("Non-cc fixed without years is refused", missingYears.status, "NEEDS_RULES");
const fractionalYears = estimate(
  "motor-vehicle-non-cc-fixed",
  6_000_000,
  { vehicleAgeYears: 2.5 },
);
check(
  "Non-cc fixed with fractional years is refused",
  fractionalYears.status,
  "NEEDS_RULES",
);

// Late filers appear on ATL, so the Tenth Schedule uplift does not hit them.
const nonCcValueLate = estimate(
  "motor-vehicle-non-cc-value-5m-or-more",
  8_000_000,
  {},
  "LATE_FILER",
);
check("Non-cc 3% late filer pays the filer rate", nonCcValueLate.collectionTaxDue, 240_000);
const nonCcFixedLate = estimate(
  "motor-vehicle-non-cc-fixed",
  6_000_000,
  { vehicleAgeYears: 0 },
  "LATE_FILER",
);
check("Non-cc fixed late filer pays the filer rate", nonCcFixedLate.collectionTaxDue, 20_000);

// ---------------------------------------------------------------------------
// 7 — separation: collection never leaks into income totals
// ---------------------------------------------------------------------------

const advanceOnly = estimate("cash-withdrawal", 1_000_000, {}, "NON_ATL");
check("Advance-only filing is estimated", advanceOnly.status, "ESTIMATE");
check("Advance-only prices no income", advanceOnly.taxableIncome, 0);
check("Advance-only income tax is zero", advanceOnly.taxDue, 0);

const mixed = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 8_000_000,
  totalExpenses: 0,
  isSalariedRoute: true,
  isBankProfitRoute: false,
  incomeSources: [
    { route: "salary", income: 8_000_000 },
    { route: "advance_tax", income: 10_000, subcategory: "internet-mobile-prepaid" },
  ],
});
check("Income and advance price together", mixed.status, "ESTIMATE");
check("The income breakdown holds one line", mixed.breakdown.length, 1);
check(
  "The collection section holds one line",
  mixed.collectionBreakdown.length,
  1,
);
check(
  "Collection is not folded into the headline",
  mixed.taxDue,
  mixed.breakdown[0].taxDue,
);
check("Internet prepaid on 10k", mixed.collectionTaxDue, 1_500);

// ---------------------------------------------------------------------------
// 8 — coverage: priced plus explicitly unpriced equals the catalog
// ---------------------------------------------------------------------------

const catalogAdvanceSubcategories = new Set(
  TY2026_RATE_CARD_RULES.filter((rule) => rule.source === "advance_tax").map(
    (rule) => rule.subcategory,
  ),
);
check(
  "Twenty-seven advance-tax subcategories are catalogued",
  catalogAdvanceSubcategories.size,
  27,
);
check(
  "Twenty-seven advance-tax subcategories are priced",
  ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS.length,
  27,
);
check(
  "No advance-tax subcategory is left unpriced",
  ADVANCE_TAX_UNPRICED_SUBCATEGORIES_FOR_TESTS.length,
  0,
);
for (const subcategory of ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS) {
  check(
    `${subcategory} is catalogued`,
    catalogAdvanceSubcategories.has(subcategory),
    true,
  );
}
for (const subcategory of ADVANCE_TAX_UNPRICED_SUBCATEGORIES_FOR_TESTS) {
  check(
    `${subcategory} is catalogued`,
    catalogAdvanceSubcategories.has(subcategory),
    true,
  );
  check(
    `${subcategory} is not also priced`,
    ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS.includes(subcategory),
    false,
  );
}

// Every priced category the suite exercises must be in the allowlist, so the
// table above cannot drift away from what the engine clears to price.
const exercised = new Set(ADVANCE_CASES.map(([subcategory]) => subcategory));
check("The suite exercises twenty-seven categories", exercised.size, 27);
for (const subcategory of exercised) {
  check(
    `${subcategory} is cleared to price`,
    ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS.includes(subcategory),
    true,
  );
}

// ---------------------------------------------------------------------------
// 9 — structural guards: the allowlist gates, and no card is a dead end
// ---------------------------------------------------------------------------

const engineSource = fs.readFileSync(
  path.join(projectRoot, "lib/tax/tax-calculation.ts"),
  "utf8",
);
check(
  "The allowlist gates advance pricing",
  /if \(!ADVANCE_TAX_PRICED_SUBCATEGORIES\.includes\(subcategory\)\)/.test(
    engineSource,
  ),
  true,
);
check(
  "A cleared-but-unhandled category stops the estimate",
  engineSource.includes("is not implemented."),
  true,
);

// Every priced card must collect the figures its branch requires, or the
// wizard would offer a category the engine can never price. The only
// exception is the single-episode play: a fixed charge with nothing to declare.
for (const subcategory of ADVANCE_TAX_PRICED_SUBCATEGORIES_FOR_TESTS) {
  const fields = getTy2026SubcategoryDetailFields("advance_tax", subcategory);
  if (subcategory === "foreign-tv-play-single-episode") {
    check(
      "The single-episode play needs no declared figures",
      fields.length,
      0,
    );
  } else {
    check(
      `${subcategory} collects declared figures`,
      fields.length > 0,
      true,
    );
  }
}

const actionSource = fs.readFileSync(
  path.join(projectRoot, "app/actions/tax-calculation.ts"),
  "utf8",
);
check(
  "The action reads declared figures",
  actionSource.includes("selectionDetails"),
  true,
);
check(
  "The action routes activity sources",
  actionSource.includes("isTaxActivitySource"),
  true,
);
check(
  "The action blocks on missing figures",
  actionSource.includes("activityDetailProblems"),
  true,
);

if (failures.length > 0) {
  console.error("Advance-tax checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Advance-tax checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      pricedCategories: 27,
      unpricedCategories: 0,
      sections: [
        "231AB",
        "231B",
        "231C",
        "234",
        "235",
        "236",
        "236A",
        "236C",
        "236CA",
        "236CB",
        "236K",
        "236Y",
      ],
      note: "Collection lines sit beside income lines; a missing figure refuses the estimate rather than pricing a guess.",
    },
    null,
    2,
  ),
);
