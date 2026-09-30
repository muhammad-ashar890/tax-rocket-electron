/**
 * Verifies that the per-source breakdown produced by the calculator actually
 * reaches the screen.
 *
 * The engine gained a `breakdown` array, but a value that is computed and then
 * dropped is worse than one that was never computed: the totals look
 * authoritative while the detail behind them is invisible. This suite follows
 * the value along its whole path — engine, persistence, read model, UI — and
 * fails if any link is missing.
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");

require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  return module._compile(outputText, filename);
};

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

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// 1. The engine still produces what the UI expects to render
// ---------------------------------------------------------------------------

const mixed = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 9_000_000,
  totalExpenses: 0,
  incomeSources: [
    { route: "salary", income: 8_000_000 },
    {
      route: "bank_profit",
      income: 1_000_000,
      subcategory: "bank-or-financial-institution-deposit",
    },
  ],
  isSalariedRoute: true,
  isBankProfitRoute: true,
});

check("A mixed return is estimated", mixed.status, "ESTIMATE");
check("It carries a breakdown", Array.isArray(mixed.breakdown), true);
check("Both sources appear", mixed.breakdown.length, 2);

// Every field the table renders must be present and numeric.
for (const line of mixed.breakdown) {
  for (const field of ["income", "baseTax", "surcharge", "taxDue"]) {
    check(
      `${line.route}.${field} is a finite number`,
      Number.isFinite(line[field]),
      true,
    );
  }
  check(`${line.route} names its rate shape`, typeof line.rateShape, "string");
  check(`${line.route} flags its regime`, typeof line.isFinalTax, "boolean");
  check(
    `${line.route} cites at least one rule`,
    line.appliedRuleIds.length > 0,
    true,
  );
}

// The rendered footer must agree with the rows above it, or the table
// contradicts itself on screen.
const renderedTotal = mixed.breakdown.reduce(
  (sum, line) => sum + line.taxDue,
  0,
);
check("The row totals sum to the headline figure", renderedTotal, mixed.taxDue);
check(
  "The split totals also reconcile",
  mixed.finalTaxDue + mixed.assessableTaxDue,
  mixed.taxDue,
);

// Collection lines travel beside the income breakdown, never inside it.
const withCollection = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 8_000_000,
  totalExpenses: 0,
  incomeSources: [
    { route: "salary", income: 8_000_000 },
    { route: "imports", income: 2_000_000, subcategory: "part-i" },
  ],
  isSalariedRoute: true,
  isBankProfitRoute: false,
});
check(
  "Income and collection price together",
  withCollection.status,
  "ESTIMATE",
);
check(
  "The income breakdown holds one line",
  withCollection.breakdown.length,
  1,
);
check(
  "The collection section holds one line",
  withCollection.collectionBreakdown.length,
  1,
);
check(
  "Collection is not folded into the headline",
  withCollection.taxDue,
  withCollection.breakdown[0].taxDue,
);
check(
  "Part-I collection on 2m",
  withCollection.collectionTaxDue,
  20_000,
);
check(
  "The note discloses the collection",
  withCollection.note.includes("collected at source"),
  true,
);

// A combined filing renders one joint line whose row agrees with the footer.
const combined = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 12_000_000,
  totalExpenses: 0,
  incomeSources: [
    { route: "salary", income: 8_000_000 },
    { route: "property_rent", income: 4_000_000 },
  ],
  isSalariedRoute: true,
  isRentalRoute: true,
  isBankProfitRoute: false,
});
check("A combined filing is estimated", combined.status, "ESTIMATE");
check(
  "A combined filing renders one joint line",
  combined.breakdown.length,
  1,
);
check(
  "The joint row equals the headline",
  combined.breakdown[0].taxDue,
  combined.taxDue,
);
check("The joint total is 4,894,100", combined.taxDue, 4_894_100);
check(
  "The joint row names both sources",
  combined.breakdown[0].note.includes("salary") &&
    combined.breakdown[0].note.includes("rental income"),
  true,
);

// A still-blocked filing must not render a misleading table: an unconfirmed
// pension age above 10m refuses with no lines at all.
const blocked = calculateTaxEstimate({
  taxYear: 2026,
  filerStatus: "ATL",
  totalIncome: 15_000_000,
  totalExpenses: 0,
  incomeSources: [{ route: "pension", income: 15_000_000 }],
  isSalariedRoute: false,
  isPensionRoute: true,
  isBankProfitRoute: false,
});
check("A blocked filing needs rules", blocked.status, "NEEDS_RULES");
check(
  "A blocked filing has no breakdown to render",
  blocked.breakdown.length,
  0,
);
check(
  "A blocked filing has no collection lines either",
  blocked.collectionBreakdown.length,
  0,
);

// ---------------------------------------------------------------------------
// 2. Persistence: the breakdown is written to the audit table
// ---------------------------------------------------------------------------

const calculationAction = read("app/actions/tax-calculation.ts");

check(
  "Income and collection lines are persisted together",
  calculationAction.includes(
    "const pricedLines = [...result.breakdown, ...result.collectionBreakdown]",
  ),
  true,
);
check(
  "The priced lines are mapped into calculation lines",
  calculationAction.includes("pricedLines.map"),
  true,
);
check(
  "Lines are written to the audit table",
  calculationAction.includes("filingTaxCalculationLine.createMany"),
  true,
);

// A plain substring test would still pass if the call were disabled by a
// falsy guard, so the guard around the write is inspected too. The only
// condition allowed to suppress it is an empty breakdown.
const createManyIndex = calculationAction.indexOf(
  "filingTaxCalculationLine.createMany",
);
const guardBeforeWrite = calculationAction
  .slice(Math.max(0, createManyIndex - 200), createManyIndex)
  .split("\n")
  .reverse()
  .find((line) => line.includes("if ("));

check(
  `The write is not disabled by a constant guard (found: ${guardBeforeWrite?.trim() ?? "none"})`,
  guardBeforeWrite === undefined ||
    guardBeforeWrite.includes("calculationLines.length"),
  true,
);
check(
  "The write is awaited rather than fired and forgotten",
  /await\s+tx\.filingTaxCalculationLine\.createMany/.test(calculationAction),
  true,
);
check(
  "A recalculation clears the previous revision",
  calculationAction.includes("filingTaxCalculationLine.deleteMany"),
  true,
);
check(
  "Writes happen inside the existing transaction",
  calculationAction.indexOf("prisma.$transaction") <
    calculationAction.indexOf("filingTaxCalculationLine.createMany"),
  true,
);
check(
  "The revision id ties lines to the draft totals",
  calculationAction.includes("calculationRevision: calculationRevision"),
  true,
);
check(
  "The section is resolved from the catalog, not guessed",
  calculationAction.includes("getTy2026RateCardRule"),
  true,
);

// The audit table must already exist in the schema, so no migration is needed.
const schema = read("prisma/schema.prisma");
check(
  "The audit model exists in the schema",
  schema.includes("model FilingTaxCalculationLine"),
  true,
);
for (const column of [
  "calculationRevision",
  "ruleId",
  "section",
  "source",
  "taxBase",
  "baseTax",
  "surcharge",
  "calculatedTax",
  "detailsJson",
]) {
  check(`The audit model has ${column}`, schema.includes(column), true);
}

// ---------------------------------------------------------------------------
// 3. Read model: the summary action returns the breakdown
// ---------------------------------------------------------------------------

const summaryAction = read("app/actions/filing-summary.ts");

check(
  "The summary reads the audit table",
  summaryAction.includes("filingTaxCalculationLine.findMany"),
  true,
);
check(
  "Decimal columns are converted for the client",
  summaryAction.includes("Number(line.taxBase)"),
  true,
);
check(
  "The breakdown is returned",
  summaryAction.includes("taxBreakdown"),
  true,
);
check(
  "Final tax is totalled separately",
  summaryAction.includes("finalTaxDue"),
  true,
);
check(
  "Assessable tax is totalled separately",
  summaryAction.includes("assessableTaxDue"),
  true,
);
check(
  "Collection lines are split out of the income breakdown",
  summaryAction.includes("collectionBreakdown"),
  true,
);
check(
  "Collected tax is totalled separately",
  summaryAction.includes("collectionTaxDue"),
  true,
);
check(
  "Malformed detail JSON cannot crash the summary",
  summaryAction.includes("catch"),
  true,
);

// ---------------------------------------------------------------------------
// 4. The screen actually renders it
// ---------------------------------------------------------------------------

const packetStep = read("components/tax/filing/wizard-packet-step.tsx");
const reviewStep = read("components/tax/filing/wizard-review-step.tsx");
const wizardConfig = read(
  "components/tax/filing/config/filing-wizard-config.ts",
);

check(
  "The shared summary type carries the breakdown",
  wizardConfig.includes("taxBreakdown?: TaxBreakdownLine[]"),
  true,
);

for (const [name, source] of [
  ["packet step", packetStep],
  ["review step", reviewStep],
]) {
  check(
    `The ${name} consumes the breakdown`,
    source.includes("taxBreakdown"),
    true,
  );
  check(
    `The ${name} iterates the lines`,
    source.includes("breakdown.map"),
    true,
  );
  check(
    `The ${name} labels sources for humans`,
    source.includes("SOURCE_LABELS"),
    true,
  );
  check(
    `The ${name} marks final-tax lines`,
    source.includes("Final tax"),
    true,
  );
  check(
    `The ${name} only renders a breakdown for a real estimate`,
    source.includes('"ESTIMATE"'),
    true,
  );
}

// Human-readable labels must exist for every route the engine can emit.
const engineRoutes = [
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
for (const route of engineRoutes) {
  check(
    `The packet step labels ${route}`,
    packetStep.includes(`${route}:`),
    true,
  );
  check(
    `The review step labels ${route}`,
    reviewStep.includes(`${route}:`),
    true,
  );
}

// The packet step shows the assessable/final split; the review step explains it.
check(
  "The packet step shows the assessable split",
  packetStep.includes("assessableTaxDue"),
  true,
);
check(
  "The review step explains non-refundable final tax",
  reviewStep.includes("not refundable"),
  true,
);
check(
  "The review step surfaces a blocked calculation",
  reviewStep.includes("NEEDS_RULES"),
  true,
);
check(
  "The review step renders collected tax separately",
  reviewStep.includes("Total collected at source"),
  true,
);
check(
  "The shared summary type carries the collection lines",
  wizardConfig.includes("collectionBreakdown?: TaxBreakdownLine[]"),
  true,
);

if (failures.length > 0) {
  console.error("Tax breakdown surfacing checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Tax breakdown surfacing checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      path: "engine -> FilingTaxCalculationLine -> getFilingSummaryAction -> wizard steps",
      renderedIn: ["wizard-review-step.tsx", "wizard-packet-step.tsx"],
      migrationRequired: false,
    },
    null,
    2,
  ),
);
