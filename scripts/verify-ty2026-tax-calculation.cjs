/**
 * verify-ty2026-tax-calculation
 *
 * Numeric regression checks for the TY2026 pilot tax calculator, verified
 * against the FBR Withholding Income Tax Rate Card (updated to 30 June 2025
 * under Finance Act 2025).
 *
 * Key product rule under test: a surcharge is charged on CALCULATED TAX,
 * never on gross or taxable income.
 *
 * Run with: npm run verify:ty2026-tax-calculation
 */

const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");

// Minimal on-the-fly TypeScript loader so this script can exercise the real
// calculator without adding a build step or a test runner dependency.
require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = require("node:fs").readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  return module._compile(output, filename);
};

// Support the "@/..." path alias used across the codebase.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) {
    return originalResolve.call(
      this,
      path.join(projectRoot, request.slice(2)),
      ...rest,
    );
  }
  return originalResolve.call(this, request, ...rest);
};

const { calculateTaxEstimate } = require("../lib/tax/tax-calculation.ts");
const {
  assessPensionerAge,
  calculateAgeOn,
  parseTaxpayerDateOfBirth,
} = require("../lib/tax/taxpayer-age.ts");

let assertionCount = 0;
const failures = [];

function check(label, actual, expected) {
  assertionCount += 1;
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, received ${actual}`);
  }
}

function salaryEstimate(taxableIncome, overrides = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: taxableIncome,
    totalExpenses: 0,
    taxWithheld: 0,
    isSalariedRoute: true,
    isBankProfitRoute: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Section 149 — salary slabs (PDF pages 1-2)
// ---------------------------------------------------------------------------
check("Salary 600,000 is untaxed", salaryEstimate(600_000).taxDue, 0);
check("Salary 1,000,000 slab tax", salaryEstimate(1_000_000).taxDue, 4_000);
check("Salary 1,800,000 slab tax", salaryEstimate(1_800_000).taxDue, 72_000);
check("Salary 3,000,000 slab tax", salaryEstimate(3_000_000).taxDue, 300_000);
check("Salary 4,000,000 slab tax", salaryEstimate(4_000_000).taxDue, 586_000);
check("Salary 8,000,000 slab tax", salaryEstimate(8_000_000).taxDue, 1_981_000);

// ---------------------------------------------------------------------------
// Section 149 read with proviso to 4AB — 9% surcharge on CALCULATED TAX
// ---------------------------------------------------------------------------
const atThreshold = salaryEstimate(10_000_000);
check("Salary at exactly 10m has no surcharge", atThreshold.surcharge, 0);
check("Salary at exactly 10m tax due", atThreshold.taxDue, 2_681_000);

const at12m = salaryEstimate(12_000_000);
check("Salary 12m base tax before surcharge", at12m.baseTax, 3_381_000);
check("Salary 12m surcharge is 9% of calculated tax", at12m.surcharge, 304_290);
check("Salary 12m total tax due", at12m.taxDue, 3_685_290);
// Guards the client-confirmed rule: 9% of taxable income would be 1,080,000.
check(
  "Salary 12m surcharge is NOT 9% of taxable income",
  at12m.surcharge === 1_080_000,
  false,
);

const at20m = salaryEstimate(20_000_000);
check("Salary 20m base tax before surcharge", at20m.baseTax, 6_181_000);
check("Salary 20m surcharge is 9% of calculated tax", at20m.surcharge, 556_290);
check("Salary 20m total tax due", at20m.taxDue, 6_737_290);

// Withholding is credited against the surcharge-inclusive total.
const at12mWithheld = salaryEstimate(12_000_000, { taxWithheld: 3_000_000 });
check(
  "Salary 12m payable after withholding",
  at12mWithheld.taxPayable,
  685_290,
);
check("Salary 12m refund after withholding", at12mWithheld.refundDue, 0);

// ---------------------------------------------------------------------------
// Section 149(IA) — pension (PDF page 2)
// ---------------------------------------------------------------------------
function pensionEstimate(annualPension, overrides = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: annualPension,
    totalExpenses: 0,
    taxWithheld: 0,
    isSalariedRoute: false,
    isPensionRoute: true,
    isBankProfitRoute: false,
    ...overrides,
  });
}

check("Pension 9m is exempt", pensionEstimate(9_000_000).taxDue, 0);
check("Pension 10m is exempt", pensionEstimate(10_000_000).taxDue, 0);
check(
  "Pension 10m reports an estimate",
  pensionEstimate(10_000_000).status,
  "ESTIMATE",
);

// Above 10m the card covers a pensioner below 70 and Section 12(2A)(i)
// exempts a pensioner at 70; without a confirmed age the route must not fall
// through to the salary slabs.
const pensionUnknownAge = pensionEstimate(15_000_000);
check(
  "Pension above 10m without confirmed age needs rules",
  pensionUnknownAge.status,
  "NEEDS_RULES",
);
check(
  "Pension above 10m without confirmed age has no tax figure",
  pensionUnknownAge.taxDue,
  null,
);

const pension70Plus = pensionEstimate(15_000_000, {
  pensionerAgeBelow70: false,
  pensionerAge70OrAbove: true,
});
check(
  "Pension 15m at 70-plus is estimated",
  pension70Plus.status,
  "ESTIMATE",
);
check("Pension 15m at 70-plus pays nothing", pension70Plus.taxDue, 0);
check(
  "Pension 15m at 70-plus carries no surcharge",
  pension70Plus.surcharge,
  0,
);

const pensionBelow70 = pensionEstimate(15_000_000, {
  pensionerAgeBelow70: true,
});
check(
  "Pension 15m base tax is 5% of the excess",
  pensionBelow70.baseTax,
  250_000,
);
check(
  "Pension 15m surcharge is 10% of calculated tax",
  pensionBelow70.surcharge,
  25_000,
);
check("Pension 15m total tax due", pensionBelow70.taxDue, 275_000);
check(
  "Pension above 10m is a final-tax line",
  pensionBelow70.breakdown[0].isFinalTax,
  true,
);
check(
  "Pension above 10m carries final tax due",
  pensionBelow70.finalTaxDue,
  275_000,
);
check(
  "Pension above 10m carries no assessable tax",
  pensionBelow70.assessableTaxDue,
  0,
);
check(
  "Pension up to 10m is also a final-tax line",
  pensionEstimate(9_000_000).breakdown[0].isFinalTax,
  true,
);
check(
  "The 70-plus limb stays non-final: it is exempt, not charged as final tax",
  pension70Plus.breakdown[0].isFinalTax,
  false,
);
const pensionOverWithheld = pensionEstimate(
  15_000_000,
  { pensionerAgeBelow70: true, taxWithheld: 500_000 },
);
check(
  "Over-withholding on a final pension claims no refund",
  pensionOverWithheld.refundDue,
  0,
);
check(
  "The pension note discloses the final-tax treatment",
  pensionBelow70.breakdown[0].note.includes("as a final tax"),
  true,
);
// Regression guard: the salary slabs would have produced 4,431,000.
check(
  "Pension 15m does not use the salary slabs",
  pensionBelow70.taxDue === 4_431_000,
  false,
);

// ---------------------------------------------------------------------------
// Section 155 — rent of immovable property (PDF page 7)
// ---------------------------------------------------------------------------
function rentalEstimate(grossRent, overrides = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: grossRent,
    totalExpenses: 0,
    taxWithheld: 0,
    isSalariedRoute: false,
    isRentalRoute: true,
    isBankProfitRoute: false,
    ...overrides,
  });
}

check("Rent 300,000 is untaxed", rentalEstimate(300_000).taxDue, 0);
check("Rent 500,000 individual slab", rentalEstimate(500_000).taxDue, 10_000);
check(
  "Rent 1,500,000 individual slab",
  rentalEstimate(1_500_000).taxDue,
  105_000,
);
check(
  "Rent 5,000,000 individual slab",
  rentalEstimate(5_000_000).taxDue,
  905_000,
);

const rentCompanyAtl = rentalEstimate(1_500_000, {
  rentalRecipientKind: "COMPANY",
});
check("Company rent uses the flat ATL rate", rentCompanyAtl.taxDue, 225_000);
check(
  "Company rent does not use the individual slabs",
  rentCompanyAtl.taxDue === 105_000,
  false,
);

const rentCompanyNonAtl = rentalEstimate(1_500_000, {
  rentalRecipientKind: "COMPANY",
  filerStatus: "NON_ATL",
});
check("Company rent Non-ATL is double", rentCompanyNonAtl.taxDue, 450_000);

// ---------------------------------------------------------------------------
// Section 151 — profit on debt, treated as a final-tax route (PDF page 3)
// ---------------------------------------------------------------------------
function bankProfitEstimate(bankProfitIncome, overrides = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 0,
    totalExpenses: 0,
    bankProfitIncome,
    taxWithheld: 0,
    isSalariedRoute: false,
    isBankProfitRoute: true,
    // Section 151 holds six rows from 10% to 25%, so the row must be named.
    incomeSources: [
      {
        route: "bank_profit",
        income: bankProfitIncome,
        subcategory: "bank-or-financial-institution-deposit",
      },
    ],
    ...overrides,
  });
}

check("Bank profit ATL is 20%", bankProfitEstimate(1_000_000).taxDue, 200_000);
check(
  "Bank profit Non-ATL is 40%",
  bankProfitEstimate(1_000_000, { filerStatus: "NON_ATL" }).taxDue,
  400_000,
);
check(
  "Bank profit is flagged as a final-tax route",
  bankProfitEstimate(1_000_000).isFinalTax,
  true,
);

// A Non-ATL deduction claimed under ATL must not create an automatic refund.
const overWithheld = bankProfitEstimate(1_000_000, { taxWithheld: 400_000 });
check("Final-tax over-deduction claims no refund", overWithheld.refundDue, 0);
check(
  "Final-tax over-deduction leaves nothing payable",
  overWithheld.taxPayable,
  0,
);

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------
const combinedRoutes = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 5_000_000,
  totalExpenses: 0,
  bankProfitIncome: 500_000,
  taxWithheld: 0,
  isSalariedRoute: true,
  isBankProfitRoute: true,
});
check("Combined routes need rules", combinedRoutes.status, "NEEDS_RULES");

const noRoute = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 3_000_000,
  totalExpenses: 0,
  taxWithheld: 0,
  isSalariedRoute: false,
  isBankProfitRoute: false,
});
check("No selected route needs rules", noRoute.status, "NEEDS_RULES");

const unsupportedYear = salaryEstimate(3_000_000, { taxYear: 2027 });
check(
  "Unsupported tax year needs rules",
  unsupportedYear.status,
  "NEEDS_RULES",
);

const emptyBankProfit = bankProfitEstimate(0);
check(
  "Bank profit route with no income needs rules",
  emptyBankProfit.status,
  "NEEDS_RULES",
);

// Every successful estimate must cite the catalog rows it used.
check(
  "Salary estimate cites its rate-card rules",
  at12m.appliedRuleIds.join(","),
  "TY2026-149-SALARY-ABOVE-4M1,TY2026-149-SALARY-SURCHARGE-ABOVE-10M",
);
check(
  "Bank profit estimate cites its rate-card rule",
  bankProfitEstimate(1_000_000).appliedRuleIds.join(","),
  "TY2026-151-BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT",
);

// ---------------------------------------------------------------------------
// Date of birth parsing and the Section 149(IA) age condition
// TY2026 runs 1 July 2025 to 30 June 2026.
// ---------------------------------------------------------------------------
function isoDob(value) {
  const parsed = parseTaxpayerDateOfBirth(value);
  return parsed ? parsed.toISOString().slice(0, 10) : null;
}

check("Parses an ISO date of birth", isoDob("1960-03-15"), "1960-03-15");
check("Parses a DD/MM/YYYY CNIC date", isoDob("15/03/1960"), "1960-03-15");
check("Parses a DD.MM.YYYY CNIC date", isoDob("15.03.1960"), "1960-03-15");
check("Parses a DD-MM-YYYY CNIC date", isoDob("15-03-1960"), "1960-03-15");
check("Rejects an ambiguous month above 12", isoDob("03/15/1960"), null);
check("Rejects an impossible calendar date", isoDob("31/02/1960"), null);
check("Rejects unparseable text", isoDob("not a date"), null);
check("Rejects an empty value", isoDob(""), null);

check(
  "Age is not incremented before the birthday",
  calculateAgeOn(
    new Date(Date.UTC(1960, 5, 30)),
    new Date(Date.UTC(2026, 5, 29)),
  ),
  65,
);
check(
  "Age is incremented on the birthday",
  calculateAgeOn(
    new Date(Date.UTC(1960, 5, 30)),
    new Date(Date.UTC(2026, 5, 30)),
  ),
  66,
);

function bracketFor(dobIso) {
  return assessPensionerAge({
    taxYear: 2026,
    dateOfBirth: parseTaxpayerDateOfBirth(dobIso),
  });
}

// Turns 66 during TY2026 — clearly below 70 all year.
check("Born 1960 is below 70", bracketFor("1960-03-15").bracket, "BELOW_70");
check("Born 1960 is usable", bracketFor("1960-03-15").isBelow70, true);

// Turns 70 on 30 June 2026, the last day of the tax year.
const turns70OnLastDay = bracketFor("1956-06-30");
check(
  "Turning 70 on the last day is not below 70 all year",
  turns70OnLastDay.bracket,
  "TURNS_70_DURING_YEAR",
);
check(
  "Turning 70 during the year uses the below-70 row (first-day rule)",
  turns70OnLastDay.isBelow70,
  true,
);

// Turns 70 on 1 July 2025, the first day of the tax year.
check(
  "Born 1955-07-01 is 70 or above",
  bracketFor("1955-07-01").bracket,
  "SEVENTY_OR_ABOVE",
);
check(
  "Age 70 or above blocks the route",
  bracketFor("1955-07-01").isBelow70,
  false,
);

// Still 69 on the final day of the tax year.
check(
  "Born 1956-07-01 is below 70",
  bracketFor("1956-07-01").bracket,
  "BELOW_70",
);

const unknownAge = assessPensionerAge({ taxYear: 2026, dateOfBirth: null });
check("Missing date of birth is unknown", unknownAge.bracket, "UNKNOWN");
check("Missing date of birth blocks the route", unknownAge.isBelow70, false);
check(
  "Missing date of birth explains the CNIC route",
  unknownAge.reason.includes("CNIC"),
  true,
);

// The assessment drives the calculator end to end.
const pensionFromDob = pensionEstimate(15_000_000, {
  pensionerAgeBelow70: bracketFor("1960-03-15").isBelow70,
});
check(
  "Pension 15m for a 66-year-old is calculated",
  pensionFromDob.taxDue,
  275_000,
);

const pensionTurns70 = pensionEstimate(15_000_000, {
  pensionerAgeBelow70: bracketFor("1956-06-30").isBelow70,
});
check(
  "Pension 15m for a turns-70 pensioner is calculated (first-day rule)",
  pensionTurns70.taxDue,
  275_000,
);

const pensionSeventyPlus = pensionEstimate(15_000_000, {
  pensionerAgeBelow70: bracketFor("1955-07-01").isBelow70,
  pensionerAgeReason: bracketFor("1955-07-01").reason,
});
check(
  "Pension 15m for a 70-year-old needs rules",
  pensionSeventyPlus.status,
  "NEEDS_RULES",
);
check(
  "Pension 70-or-above explains why",
  pensionSeventyPlus.note.includes("70 or above"),
  true,
);

// ---------------------------------------------------------------------------
// Multi-source returns
//
// The engine prices a list of routes rather than a single selected one. Two
// properties matter most: a route priced beside others must produce the same
// figure it produces alone, and final tax must never be mixed into the
// assessable/refundable pool.
// ---------------------------------------------------------------------------

function multiEstimate(sources, overrides = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: sources.reduce((total, source) => total + source.income, 0),
    totalExpenses: 0,
    incomeSources: sources,
    isSalariedRoute: sources.some((s) => s.route === "salary"),
    isPensionRoute: sources.some((s) => s.route === "pension"),
    isRentalRoute: sources.some((s) => s.route === "property_rent"),
    isBankProfitRoute: sources.some((s) => s.route === "bank_profit"),
    ...overrides,
  });
}

function lineFor(result, route) {
  return result.breakdown.find((line) => line.route === route) ?? null;
}

// --- Salary + bank profit: the most common real combination ----------------

const salaryPlusBank = multiEstimate([
  { route: "salary", income: 8_000_000 },
  {
    route: "bank_profit",
    income: 1_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);

check(
  "Salary plus bank profit is estimated",
  salaryPlusBank.status,
  "ESTIMATE",
);
check(
  "Salary plus bank profit has two lines",
  salaryPlusBank.breakdown.length,
  2,
);

// Each line must equal what that route produces on its own.
check(
  "The salary line matches a solo salary filing",
  lineFor(salaryPlusBank, "salary").taxDue,
  salaryEstimate(8_000_000).taxDue,
);
check(
  "The bank line matches a solo bank filing",
  lineFor(salaryPlusBank, "bank_profit").taxDue,
  bankProfitEstimate(1_000_000).taxDue,
);
check(
  "Salary line is 1,981,000",
  lineFor(salaryPlusBank, "salary").taxDue,
  1_981_000,
);
check(
  "Bank line is 200,000",
  lineFor(salaryPlusBank, "bank_profit").taxDue,
  200_000,
);
check("The combined total is 2,181,000", salaryPlusBank.taxDue, 2_181_000);
check("The lines sum to the total", 1_981_000 + 200_000, salaryPlusBank.taxDue);

// Regime separation.
check(
  "Bank profit is flagged final",
  lineFor(salaryPlusBank, "bank_profit").isFinalTax,
  true,
);
check(
  "Salary is not flagged final",
  lineFor(salaryPlusBank, "salary").isFinalTax,
  false,
);
check("A mixed return is not wholly final", salaryPlusBank.isFinalTax, false);
check("Final tax is reported separately", salaryPlusBank.finalTaxDue, 200_000);
check(
  "Assessable tax is reported separately",
  salaryPlusBank.assessableTaxDue,
  1_981_000,
);
check(
  "Final plus assessable equals the total",
  salaryPlusBank.finalTaxDue + salaryPlusBank.assessableTaxDue,
  salaryPlusBank.taxDue,
);

// Rate shape is recorded so the aggregation rule can be applied later.
check(
  "Salary is progressive",
  lineFor(salaryPlusBank, "salary").rateShape,
  "PROGRESSIVE",
);
check(
  "Bank profit is flat",
  lineFor(salaryPlusBank, "bank_profit").rateShape,
  "FLAT",
);

// Rule citations survive aggregation.
check(
  "Both routes cite their rate-card rows",
  salaryPlusBank.appliedRuleIds.includes("TY2026-149-SALARY-ABOVE-4M1") &&
    salaryPlusBank.appliedRuleIds.includes(
      "TY2026-151-BANK-OR-FINANCIAL-INSTITUTION-DEPOSIT",
    ),
  true,
);

// --- A flat route must not change the other route's figure -----------------

for (const bankIncome of [100_000, 1_000_000, 9_000_000]) {
  const mixed = multiEstimate([
    { route: "salary", income: 8_000_000 },
    {
      route: "bank_profit",
      income: bankIncome,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ]);
  check(
    `Bank profit of ${bankIncome} leaves the salary charge unchanged`,
    lineFor(mixed, "salary").taxDue,
    1_981_000,
  );
  check(
    `Bank profit of ${bankIncome} is charged at a flat 20%`,
    lineFor(mixed, "bank_profit").taxDue,
    bankIncome * 0.2,
  );
}

// Salary above the surcharge threshold keeps its surcharge in a mixed return.
const bigSalaryPlusBank = multiEstimate([
  { route: "salary", income: 12_000_000 },
  {
    route: "bank_profit",
    income: 1_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check(
  "Surcharge survives aggregation",
  lineFor(bigSalaryPlusBank, "salary").surcharge,
  304_290,
);
check(
  "The salary line is still 3,685,290",
  lineFor(bigSalaryPlusBank, "salary").taxDue,
  3_685_290,
);
check("The mixed total is 3,885,290", bigSalaryPlusBank.taxDue, 3_885_290);

// Bank profit must not push salary over the surcharge threshold, because a
// flat final-tax route is not part of the progressive base.
const belowThresholdPlusBank = multiEstimate([
  { route: "salary", income: 9_500_000 },
  {
    route: "bank_profit",
    income: 2_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check(
  "A flat route does not trigger the salary surcharge",
  lineFor(belowThresholdPlusBank, "salary").surcharge,
  0,
);
check(
  "The salary line matches its solo figure",
  lineFor(belowThresholdPlusBank, "salary").taxDue,
  salaryEstimate(9_500_000).taxDue,
);

// --- Other supported combinations ------------------------------------------

const pensionPlusBank = multiEstimate([
  { route: "pension", income: 9_000_000 },
  {
    route: "bank_profit",
    income: 500_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check(
  "Pension plus bank profit is estimated",
  pensionPlusBank.status,
  "ESTIMATE",
);
check(
  "The exempt pension line is zero",
  lineFor(pensionPlusBank, "pension").taxDue,
  0,
);
check(
  "The bank line is 100,000",
  lineFor(pensionPlusBank, "bank_profit").taxDue,
  100_000,
);
check("The total is 100,000", pensionPlusBank.taxDue, 100_000);

const rentPlusBank = multiEstimate([
  { route: "property_rent", income: 1_500_000 },
  {
    route: "bank_profit",
    income: 1_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check("Rental plus bank profit is estimated", rentPlusBank.status, "ESTIMATE");
check(
  "The rental line is 105,000",
  lineFor(rentPlusBank, "property_rent").taxDue,
  105_000,
);
check("The total is 305,000", rentPlusBank.taxDue, 305_000);

// Company rental is flat, so it combines with salary without ambiguity.
const salaryPlusCompanyRent = multiEstimate(
  [
    { route: "salary", income: 8_000_000 },
    { route: "property_rent", income: 1_500_000 },
  ],
  { rentalRecipientKind: "COMPANY" },
);
check(
  "Salary plus company rental is estimated",
  salaryPlusCompanyRent.status,
  "ESTIMATE",
);
check(
  "Company rental is flat",
  lineFor(salaryPlusCompanyRent, "property_rent").rateShape,
  "FLAT",
);
check(
  "Company rental is charged at 15%",
  lineFor(salaryPlusCompanyRent, "property_rent").taxDue,
  225_000,
);
check(
  "The combined total is 2,206,000",
  salaryPlusCompanyRent.taxDue,
  2_206_000,
);

// Three sources at once.
const threeSources = multiEstimate(
  [
    { route: "salary", income: 8_000_000 },
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
    { route: "property_rent", income: 1_500_000 },
  ],
  { rentalRecipientKind: "COMPANY" },
);
check("Three sources are priced", threeSources.breakdown.length, 3);
check("Three sources total 2,406,000", threeSources.taxDue, 2_406_000);
check(
  "The breakdown is in a stable order",
  threeSources.breakdown.map((line) => line.route).join(","),
  "salary,property_rent,bank_profit",
);

// --- The aggregation rule --------------------------------------------------
//
// Assessable slab routes share ONE slab read against their combined taxable
// income (Division I reaches "taxable income"; FA2025 abolished rental's
// separate block). Clause (2) applies where salary-head income exceeds 75% of
// the total, else clause (1); the 4AB surcharge runs on the combined figure.
// A pension charged as final tax stands apart (Sections 12(2A), 169).

// Salary 8m + rent 4m: salary-head is 67% of 12m, so clause (1) reads
// 1,610,000 + 45% of 6.4m = 4,490,000, plus 9% surcharge (salary exists).
const salaryPlusIndividualRent = multiEstimate([
  { route: "salary", income: 8_000_000 },
  { route: "property_rent", income: 4_000_000 },
]);
check(
  "Salary plus rental is priced",
  salaryPlusIndividualRent.status,
  "ESTIMATE",
);
check(
  "The pair produces one joint line",
  salaryPlusIndividualRent.breakdown.length,
  1,
);
check(
  "The joint line carries the combined income",
  salaryPlusIndividualRent.breakdown[0].income,
  12_000_000,
);
check(
  "Clause (1) base tax on 12m",
  salaryPlusIndividualRent.baseTax,
  4_490_000,
);
check(
  "Combined 9% surcharge above 10m",
  salaryPlusIndividualRent.surcharge,
  404_100,
);
check(
  "Combined total is 4,894,100",
  salaryPlusIndividualRent.taxDue,
  4_894_100,
);
check(
  "The joint line stays assessable",
  salaryPlusIndividualRent.breakdown[0].isFinalTax,
  false,
);
check(
  "The note names both sources and the table",
  salaryPlusIndividualRent.breakdown[0].note.includes("salary") &&
    salaryPlusIndividualRent.breakdown[0].note.includes("rental income") &&
    salaryPlusIndividualRent.breakdown[0].note.includes("clause (1)"),
  true,
);
check(
  "The note states the combined figure",
  salaryPlusIndividualRent.breakdown[0].note.includes("12,000,000"),
  true,
);

// Salary 8m + rent 2m: salary-head is 80% of 10m, so the salaried clause (2)
// table reads 616,000 + 35% of 5.9m = 2,681,000 with no surcharge at 10m.
const salaryPlusSmallRent = multiEstimate([
  { route: "salary", income: 8_000_000 },
  { route: "property_rent", income: 2_000_000 },
]);
check(
  "The 75% test selects clause (2)",
  salaryPlusSmallRent.breakdown[0].note.includes("clause (2)"),
  true,
);
check(
  "Clause (2) base tax on 10m",
  salaryPlusSmallRent.baseTax,
  2_681_000,
);
check(
  "No surcharge at exactly 10m (the threshold is exclusive)",
  salaryPlusSmallRent.surcharge,
  0,
);
check(
  "Combined total is 2,681,000",
  salaryPlusSmallRent.taxDue,
  2_681_000,
);

// A final-tax pension never joins the slab: salary 5m prices alone at
// 616,000 + 35% of 0.9m = 931,000 beside a zero-tax final pension line.
const salaryPlusPension = multiEstimate([
  { route: "salary", income: 5_000_000 },
  { route: "pension", income: 3_000_000 },
]);
check(
  "Salary plus pension is priced",
  salaryPlusPension.status,
  "ESTIMATE",
);
check(
  "Pension stands apart as its own line",
  salaryPlusPension.breakdown.length,
  2,
);
check(
  "The pension line is final with no tax",
  lineFor(salaryPlusPension, "pension").isFinalTax &&
    lineFor(salaryPlusPension, "pension").taxDue === 0,
  true,
);
check(
  "Salary prices alone at 931,000",
  lineFor(salaryPlusPension, "salary").taxDue,
  931_000,
);

// Salary 5m + pension 15m (below 70): the 275,000 pension tax is final and
// the salary surcharge is tested on 5m alone, not on 20m.
const salaryPlusBigPension = multiEstimate(
  [
    { route: "salary", income: 5_000_000 },
    { route: "pension", income: 15_000_000 },
  ],
  { pensionerAgeBelow70: true },
);
check(
  "Pension tax stays final beside salary",
  lineFor(salaryPlusBigPension, "pension").taxDue,
  275_000,
);
check(
  "Final and assessable splits are reported",
  salaryPlusBigPension.finalTaxDue === 275_000 &&
    salaryPlusBigPension.assessableTaxDue === 931_000,
  true,
);
check(
  "Salary surcharge ignores the final pension",
  lineFor(salaryPlusBigPension, "salary").surcharge,
  0,
);
check(
  "Combined total is 1,206,000",
  salaryPlusBigPension.taxDue,
  1_206_000,
);
check(
  "The note discloses the final-tax slice",
  salaryPlusBigPension.note.includes("275,000 of this total is final tax"),
  true,
);

// A pension taxed as salary IS salary-head income: 6m + 6m combine into 12m
// at clause (2), 616,000 + 35% of 7.9m = 3,381,000 plus 9% surcharge.
const salaryPlusWorkingPension = multiEstimate(
  [
    { route: "salary", income: 6_000_000 },
    { route: "pension", income: 6_000_000 },
  ],
  { pensionTaxAsSalary: true },
);
check(
  "Working pension joins the slab",
  salaryPlusWorkingPension.breakdown.length,
  1,
);
check(
  "Combined base tax on 12m",
  salaryPlusWorkingPension.baseTax,
  3_381_000,
);
check(
  "Combined 9% surcharge",
  salaryPlusWorkingPension.surcharge,
  304_290,
);
check(
  "Combined total is 3,685,290",
  salaryPlusWorkingPension.taxDue,
  3_685_290,
);
check(
  "The former-employer reference is cited",
  salaryPlusWorkingPension.appliedRuleIds.includes(
    "TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE",
  ),
  true,
);

// A flat route prices beside the joint line as usual.
const combinedPlusFlat = multiEstimate([
  { route: "salary", income: 8_000_000 },
  { route: "property_rent", income: 4_000_000 },
  {
    route: "bank_profit",
    income: 1_000_000,
    subcategory: "bank-or-financial-institution-deposit",
  },
]);
check(
  "A flat route prices beside the joint line",
  combinedPlusFlat.status,
  "ESTIMATE",
);
check(
  "Joint plus bank totals 5,094,100",
  combinedPlusFlat.taxDue,
  5_094_100,
);

// --- Withholding and refunds across a mixed return -------------------------

const mixedWithWithholding = multiEstimate(
  [
    { route: "salary", income: 8_000_000 },
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ],
  { taxWithheld: 2_500_000 },
);
check("Withholding reduces the payable", mixedWithWithholding.taxPayable, 0);
check(
  "A genuine over-deduction on a mixed return is refundable",
  mixedWithWithholding.refundDue,
  2_500_000 - 2_181_000,
);

// A wholly final return still refuses to invent a refund.
const bankOnlyOverWithheld = multiEstimate(
  [
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ],
  { taxWithheld: 400_000 },
);
check(
  "A wholly final return is flagged final",
  bankOnlyOverWithheld.isFinalTax,
  true,
);
check("No refund arises on a final route", bankOnlyOverWithheld.refundDue, 0);

// --- Input hygiene ---------------------------------------------------------

const duplicated = multiEstimate([
  { route: "salary", income: 4_000_000 },
  { route: "salary", income: 4_000_000 },
]);
check(
  "A repeated route is merged, not double-charged",
  duplicated.breakdown.length,
  1,
);
check(
  "The merged income is summed",
  lineFor(duplicated, "salary").income,
  8_000_000,
);
check("The merged charge is correct", duplicated.taxDue, 1_981_000);

const zeroIncomeRoute = multiEstimate([
  { route: "salary", income: 8_000_000 },
  { route: "property_rent", income: 0 },
]);
check(
  "A route with no income stops the estimate",
  zeroIncomeRoute.status,
  "NEEDS_RULES",
);
check(
  "The message names the empty route",
  zeroIncomeRoute.note.includes("rental income"),
  true,
);

// Single-route filings must be unchanged by the multi-source machinery.
const soloViaList = multiEstimate([{ route: "salary", income: 12_000_000 }]);
check("A one-route list still estimates", soloViaList.status, "ESTIMATE");
check(
  "A one-route list matches the flag path",
  soloViaList.taxDue,
  salaryEstimate(12_000_000).taxDue,
);
check("A one-route list has one line", soloViaList.breakdown.length, 1);

// --- Mixed-regime excess withholding (section 29): the ambiguous refund -
// Probe 3 replica: bank profit 1M (final 200k) + salary 500k (assessable 0),
// 300k withheld. Formula refund stays 100k (final-first default), but the
// excess must be flagged for CPR verification instead of silently claimed.

const mixedExcess = multiEstimate(
  [
    { route: "salary", income: 500_000 },
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ],
  { taxWithheld: 300_000 },
);

check("mixed excess status", mixedExcess.status, "ESTIMATE");
check("mixed excess finalTaxDue", mixedExcess.finalTaxDue, 200_000);
check("mixed excess assessableTaxDue", mixedExcess.assessableTaxDue, 0);
check("mixed excess refundDue", mixedExcess.refundDue, 100_000);
check("mixed excess flagged", mixedExcess.mixedExcessWithholding, 100_000);
check("mixed excess note", mixedExcess.note.includes("CPRs"), true);

// Pure assessable excess: no ambiguity, no flag.
const pureExcess = multiEstimate([{ route: "salary", income: 2_000_000 }], {
  taxWithheld: 200_000,
});
check("pure excess status", pureExcess.status, "ESTIMATE");
check("pure excess flagged", pureExcess.mixedExcessWithholding, 0);

// All-final excess: existing final-tax path, no mixed flag.
const finalExcess = multiEstimate(
  [
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ],
  { taxWithheld: 300_000 },
);
check("all-final excess status", finalExcess.status, "ESTIMATE");
check("all-final excess refund", finalExcess.refundDue, 0);
check("all-final excess flagged", finalExcess.mixedExcessWithholding, 0);

// --- Combined slab line identity (section 30) ------------------------------
// Probe 5 replica: salary 3M + rent 3M price jointly on the clause-1 slab
// (6M -> 1,790,000), but the line must say so instead of borrowing "salary".

const combinedSlab = multiEstimate([
  { route: "salary", income: 3_000_000 },
  { route: "property_rent", income: 3_000_000 },
]);

check("combined slab status", combinedSlab.status, "ESTIMATE");
check("combined slab single line", combinedSlab.breakdown.length, 1);
check("combined slab route", combinedSlab.breakdown[0].route, "combined_slab");
check("combined slab income", combinedSlab.breakdown[0].income, 6_000_000);
check("combined slab tax", combinedSlab.breakdown[0].taxDue, 1_790_000);
check(
  "combined slab components",
  JSON.stringify(combinedSlab.breakdown[0].combinedRoutes),
  JSON.stringify([
    { route: "salary", income: 3_000_000 },
    { route: "property_rent", income: 3_000_000 },
  ]),
);

if (failures.length > 0) {
  console.error("TY2026 tax-calculation checks FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("TY2026 tax-calculation checks passed.");
console.log(
  JSON.stringify(
    {
      taxYear: 2026,
      assertionCount,
      surchargeBasis: "CALCULATED_TAX",
      routesCovered: ["salary", "pension", "rental", "bank_profit"],
      finalTaxRoutes: ["bank_profit"],
    },
    null,
    2,
  ),
);
