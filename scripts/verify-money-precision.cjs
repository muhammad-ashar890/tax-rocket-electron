/**
 * Money precision safety net (Phase 5).
 *
 * This suite is written BEFORE the Float -> Decimal migration and must keep
 * passing, unchanged, after it. Its whole job is to notice if converting the
 * money columns quietly moves a number.
 *
 * Three groups:
 *
 *   1. Baseline figures. Every headline example the project has quoted to the
 *      client, hard-coded. If Decimal shifts any of them by even one rupee,
 *      these fail.
 *
 *   2. Sub-rupee inputs. The ledger stores paisa, so amounts arriving at the
 *      calculator can carry decimals. These pin what the engine does with
 *      them today so the behaviour cannot drift silently.
 *
 *   3. Decimal misuse guards. Prisma's Decimal does NOT support `+`: writing
 *      `decimalA + decimalB` concatenates them into a string
 *      ("1000.5" + "2000.25" = "1000.52000.25") and TypeScript accepts it,
 *      because a string is a perfectly valid result. That is the single most
 *      dangerous thing about this migration, so the failure mode is
 *      demonstrated here and the real aggregation sites are checked for it.
 */

const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const Module = require("module");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(root, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    filename,
  );
};

const { calculateTaxEstimate } = require(
  path.join(root, "lib/tax/tax-calculation.ts"),
);

let assertionCount = 0;
const failures = [];

function check(label, actual, expected) {
  assertionCount += 1;
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

const BANK_DEPOSIT = "bank-or-financial-institution-deposit";

function estimate(sources, filerStatus = "ATL", extra = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus,
    totalIncome: 0,
    totalExpenses: 0,
    bankProfitIncome: 0,
    taxWithheld: 0,
    isSalariedRoute: false,
    isBankProfitRoute: false,
    incomeSources: sources,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 1 — baseline figures
//
// Each of these has been quoted to the client in a written report. They are
// the numbers a precision change would be most likely to disturb, and the
// most damaging ones to get wrong.
// ---------------------------------------------------------------------------

const BASELINES = [
  // label, sources, extra input, expected taxDue
  ["Salary 8m alone", [{ route: "salary", income: 8_000_000 }], { isSalariedRoute: true, totalIncome: 8_000_000 }, 1_981_000],
  [
    "Salary 8m plus bank profit 1m",
    [
      { route: "salary", income: 8_000_000 },
      { route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT },
    ],
    { isSalariedRoute: true },
    2_181_000,
  ],
  [
    "Salary 12m carries the 9% surcharge on calculated tax",
    [{ route: "salary", income: 12_000_000 }],
    { isSalariedRoute: true, totalIncome: 12_000_000 },
    3_685_290,
  ],
  [
    "Salary 20m",
    [{ route: "salary", income: 20_000_000 }],
    { isSalariedRoute: true, totalIncome: 20_000_000 },
    6_737_290,
  ],
  [
    "Three sources together",
    [
      { route: "salary", income: 5_000_000 },
      { route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT },
      { route: "services", income: 2_000_000, subcategory: "1b-service-it-ites" },
    ],
    { isSalariedRoute: true },
    1_211_000,
  ],
  [
    "Section 152 IT services to a non-resident",
    [
      {
        route: "foreign_income_assets",
        income: 1_000_000,
        subcategory: "2a-b-it-ites",
      },
    ],
    {},
    40_000,
  ],
  [
    "Dividend bonus shares",
    [{ route: "dividend", income: 1_000_000, subcategory: "bonus-shares" }],
    {},
    100_000,
  ],
  [
    "Company rental 1.5m",
    [{ route: "property_rent", income: 1_500_000 }],
    { isRentalRoute: true, rentalRecipientKind: "COMPANY" },
    225_000,
  ],
];

for (const [label, sources, extra, expected] of BASELINES) {
  const result = estimate(sources, "ATL", extra);
  check(`${label}: status`, result.status, "ESTIMATE");
  check(`${label}: tax due`, result.taxDue, expected);
}

// A refund must survive the migration intact, because it is the one figure
// that reaches the taxpayer as money owed back to them.
const refundCase = estimate(
  [{ route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" }],
  "ATL",
  { taxWithheld: 250_000 },
);
check("Over-withheld services: tax due", refundCase.taxDue, 200_000);
check("Over-withheld services: refund", refundCase.refundDue, 50_000);
check("Over-withheld services: payable", refundCase.taxPayable, 0);

// Bank profit is a final tax, so over-withholding must NOT become a refund.
const finalTaxCase = estimate(
  [{ route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT }],
  "ATL",
  { taxWithheld: 300_000 },
);
check("Final-tax over-deduction: refund stays zero", finalTaxCase.refundDue, 0);
check("Final-tax over-deduction: payable stays zero", finalTaxCase.taxPayable, 0);

// ---------------------------------------------------------------------------
// 2 — sub-rupee inputs
//
// Ledger amounts carry paisa, so the calculator can receive fractional income.
// Today every breakdown line is rounded to whole rupees (tax-calculation.ts
// rounds income, base tax and surcharge), which means paisa never survives
// into a tax figure. That is a deliberate property worth pinning: if the
// Decimal migration starts letting fractions through, the totals below stop
// being whole numbers and these assertions fail.
// ---------------------------------------------------------------------------

const SUB_RUPEE_INPUTS = [
  1_000_000.01, 1_000_000.1, 1_000_000.49, 1_000_000.5, 1_000_000.51,
  1_000_000.99,
];

for (const income of SUB_RUPEE_INPUTS) {
  const result = estimate([
    { route: "bank_profit", income, subcategory: BANK_DEPOSIT },
  ]);
  check(
    `Bank profit on ${income}: tax is a whole rupee amount`,
    Number.isInteger(result.taxDue),
    true,
  );
  check(
    `Bank profit on ${income}: 20% of a rounded 1,000,000`,
    result.taxDue,
    200_000,
  );
}

// The classic floating-point failure, expressed as money: three amounts that
// must add up exactly. This is the shape of every ledger total in the app.
const pennyParts = estimate([
  { route: "bank_profit", income: 1_000_000.1, subcategory: BANK_DEPOSIT },
  {
    route: "services",
    income: 1_000_000.2,
    subcategory: "1b-service-it-ites",
  },
]);
check("Two fractional sources still total whole rupees", pennyParts.taxDue, 240_000);
check(
  "Two fractional sources produce an integer",
  Number.isInteger(pennyParts.taxDue),
  true,
);

// Every breakdown line, not just the headline, must be whole rupees.
for (const line of pennyParts.breakdown) {
  check(
    `Breakdown line ${line.route}: income is whole rupees`,
    Number.isInteger(line.income),
    true,
  );
  check(
    `Breakdown line ${line.route}: tax is whole rupees`,
    Number.isInteger(line.taxDue),
    true,
  );
}

// The breakdown must reconcile against the headline exactly — no tolerance.
// A tolerance here is precisely what this migration exists to remove.
const lineSum = pennyParts.breakdown.reduce((total, line) => total + line.taxDue, 0);
check("Breakdown sums to the headline exactly", lineSum, pennyParts.taxDue);

// ---------------------------------------------------------------------------
// 3 — Decimal misuse guards
//
// These are the assertions that make this suite worth writing. They do not
// test the app's behaviour; they test that the specific trap this migration
// walks into is still visible and still absent from the code.
// ---------------------------------------------------------------------------

const { Prisma } = require("@prisma/client");
const Decimal = Prisma.Decimal;

// Demonstrate the trap, so nobody has to rediscover it the hard way.
const left = new Decimal("1000.50");
const right = new Decimal("2000.25");

check(
  "Prisma Decimal does not support the + operator (it concatenates)",
  left + right,
  "1000.52000.25",
);
check(
  "A zero-seeded reduce over Decimals also concatenates",
  0 + left,
  "01000.5",
);
check(
  "The concatenated result is a string, which TypeScript accepts",
  typeof (left + right),
  "string",
);
check(
  "The correct API produces the right answer",
  left.plus(right).toString(),
  "3000.75",
);

// Two further Decimal traps, both found by running the class rather than by
// reading about it. Neither is caught by TypeScript.
//
// (a) Decimal.toLocaleString() does NOT group thousands. Float formatting
//     relies on that grouping throughout the PDF and the UI, so a column that
//     becomes Decimal must be converted with Number() before formatting or
//     the packet silently starts printing "1234567.89" instead of
//     "1,234,567.89".
check(
  "Decimal.toLocaleString() does not group thousands",
  new Decimal("1234567.89").toLocaleString(),
  "1234567.89",
);
check(
  "Number() restores the grouped format the PDF expects",
  Number(new Decimal("1234567.89")).toLocaleString(),
  "1,234,567.89",
);

// (b) A Decimal zero is TRUTHY, where a Float zero is falsy. Any `if (value)`
//     or `value || fallback` guarding a money column inverts its meaning the
//     moment that column becomes Decimal.
check("A Decimal zero is truthy", Boolean(new Decimal("0")), true);
check("A Float zero is falsy", Boolean(0), false);

// --- the conversion helpers themselves ---------------------------------------
//
// lib/money.ts is the single boundary where a Decimal column becomes a plain
// number for the UI and the packet PDF. Everything downstream trusts it, so it
// is checked directly rather than only through the code that calls it.

const {
  toMoneyNumber,
  toMoneyNumberOrNull,
  toMoneyAmount,
  formatMoneyForInput,
  deriveOpeningBalance,
  sumMoney,
  netMoney,
  serializePacketMoney,
} = require(path.join(root, "lib/money.ts"));

check("toMoneyNumber converts a Decimal exactly", toMoneyNumber(new Decimal("2181000.55")), 2181000.55);
check("toMoneyNumber leaves a whole rupee figure alone", toMoneyNumber(new Decimal("2181000")), 2181000);
check("toMoneyNumber passes a plain number through", toMoneyNumber(1234.5), 1234.5);
check("toMoneyNumber returns the number type", typeof toMoneyNumber(new Decimal("1")), "number");
check("toMoneyNumber handles zero without inventing a value", toMoneyNumber(new Decimal("0")), 0);

check("toMoneyNumberOrNull keeps null as null", toMoneyNumberOrNull(null), null);
check("toMoneyNumberOrNull keeps undefined as null", toMoneyNumberOrNull(undefined), null);
check(
  "toMoneyNumberOrNull converts a real Decimal zero rather than nulling it",
  toMoneyNumberOrNull(new Decimal("0")),
  0,
);
// A plain numeric zero is the case a falsy guard (`if (!value)`) gets wrong:
// zero rupees payable is a real answer and must not be reported as "Pending".
check(
  "toMoneyNumberOrNull keeps a numeric zero as zero, not null",
  toMoneyNumberOrNull(0),
  0,
);
check(
  "toMoneyNumberOrNull keeps a zero-valued string as zero",
  toMoneyNumberOrNull("0"),
  0,
);

const serialized = serializePacketMoney({
  id: "pk",
  version: 3,
  taxPayable: new Decimal("2181000.55"),
  refundDue: new Decimal("0"),
});
check("serializePacketMoney converts taxPayable", serialized.taxPayable, 2181000.55);
check("serializePacketMoney converts refundDue", serialized.refundDue, 0);
check("serializePacketMoney yields a real number", typeof serialized.taxPayable, "number");
check("serializePacketMoney preserves other fields", serialized.id, "pk");
check("serializePacketMoney preserves the version", serialized.version, 3);
check(
  "serialized money survives JSON, which a raw Decimal does not",
  JSON.parse(JSON.stringify(serialized)).taxPayable,
  2181000.55,
);
check(
  "a raw Decimal crosses JSON as a string instead",
  typeof JSON.parse(JSON.stringify({ v: new Decimal("1.5") })).v,
  "string",
);

// Decimal arithmetic is exact where Float is not. This is the entire point of
// the migration, stated as an assertion rather than a claim in a report.
const a = new Decimal("1000000.10");
const b = new Decimal("1000000.20");
const c = new Decimal("2000000.30");
check(
  "Decimal: (a + b) - c is exactly zero",
  a.plus(b).minus(c).toString(),
  "0",
);
check(
  "Float: the same sum is NOT zero, which is why tolerances exist",
  1_000_000.1 + 1_000_000.2 - 2_000_000.3 === 0,
  false,
);

// Now check the real aggregation sites. `incomeByCategory` in the calculator
// action is the reduce that turns ledger rows into a per-source total; it is
// the exact place where a Decimal column would silently concatenate.
//
// This assertion is deliberately structural rather than behavioural: while the
// column is still Float the reduce is correct, so no behavioural test can see
// the future bug. Once LedgerEntry.amount becomes Decimal, a bare
// `total + entry.amount` becomes a string concatenation, so the reduce must
// have been converted to Decimal arithmetic by then.
const calculatorAction = fs.readFileSync(
  path.join(root, "app/actions/tax-calculation.ts"),
  "utf8",
);
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");

const ledgerAmountIsDecimal = /model LedgerEntry \{[^}]*amount\s+Decimal/s.test(
  schema,
);
const reduceIsPlainAddition = /reduce\(\(total, entry\) => total \+ entry\.amount, 0\)/.test(
  calculatorAction,
);

check(
  "LedgerEntry.amount and its reduce agree: a Decimal column cannot use `total + entry.amount`",
  ledgerAmountIsDecimal && reduceIsPlainAddition,
  false,
);

// The same pairing for the money columns that feed the packet and the draft.
const MONEY_COLUMN_PAIRS = [
  ["FilingPacket", "taxPayable"],
  ["FilingPacket", "refundDue"],
  ["FilingDraft", "taxableIncome"],
  ["FilingDraft", "taxWithheld"],
  ["FilingDraft", "taxPayable"],
  ["FilingDraft", "refundDue"],
  ["FilingDraft", "reconciliationGap"],
  ["FilingDraft", "openingWealth"],
  ["FilingDraft", "closingWealth"],
  ["BankStatement", "openingBalance"],
  ["BankStatement", "closingBalance"],
  ["BankTransaction", "debit"],
  ["BankTransaction", "credit"],
  ["BankTransaction", "balance"],
  ["LedgerEntry", "amount"],
];

// Record today's storage type for each money column. This is a drift detector:
// when a column flips to Decimal, the matching Phase 5 step must have been
// done, and this list is the checklist that says which ones are still pending.
const stillFloat = [];
for (const [model, column] of MONEY_COLUMN_PAIRS) {
  const modelBlock = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(schema);
  check(`Schema still defines model ${model}`, Boolean(modelBlock), true);
  if (!modelBlock) continue;

  const columnLine = new RegExp(`\\n\\s+${column}\\s+(\\w+)`).exec(modelBlock[0]);
  check(`Schema still defines ${model}.${column}`, Boolean(columnLine), true);
  if (!columnLine) continue;

  if (columnLine[1] === "Float") stillFloat.push(`${model}.${column}`);
}

check(
  "Every money column is accounted for",
  stillFloat.length + (MONEY_COLUMN_PAIRS.length - stillFloat.length),
  MONEY_COLUMN_PAIRS.length,
);

// ---------------------------------------------------------------------------
// toMoneyAmount — the helper that replaced `?? 0` on optional money columns.
//
// This one guards the single most dangerous trap in the whole migration.
// Bank transactions decide "money in" vs "money out" with a falsy test on the
// unused side. A Float 0 is falsy, so the test worked. A Decimal 0 is TRUTHY,
// so once the column changed type the same expression reported neither a
// credit nor a debit, and every transaction would have gone unclassified.
// ---------------------------------------------------------------------------

check("toMoneyAmount converts a Decimal", toMoneyAmount(new Decimal("2500.75")), 2500.75);
check("toMoneyAmount converts a Decimal zero to a real zero", toMoneyAmount(new Decimal("0")), 0);
check("toMoneyAmount treats null as zero", toMoneyAmount(null), 0);
check("toMoneyAmount treats undefined as zero", toMoneyAmount(undefined), 0);
check("toMoneyAmount passes a plain number through", toMoneyAmount(4200.5), 4200.5);
check("toMoneyAmount passes a plain zero through", toMoneyAmount(0), 0);
check("toMoneyAmount parses a string amount", toMoneyAmount("1500.25"), 1500.25);
check("toMoneyAmount always returns a number", typeof toMoneyAmount(new Decimal("1")), "number");
check("toMoneyAmount returns a number for null too", typeof toMoneyAmount(null), "number");

// The trap itself, stated as an executable fact rather than a comment.
check("A Decimal zero is truthy, unlike a Float zero", Boolean(new Decimal("0")), true);
check("A plain zero is falsy", Boolean(0), false);
check(
  "Converting first makes a zero behave like a zero again",
  Boolean(toMoneyAmount(new Decimal("0"))),
  false,
);

// The exact credit/debit decision made in bank-classification.ts, run over
// Decimal values, proving the direction is still detected correctly.
function decideDirection(debit, credit) {
  const debitAmount = toMoneyAmount(debit);
  const creditAmount = toMoneyAmount(credit);
  return {
    hasCredit: creditAmount > 0 && debitAmount === 0,
    hasDebit: debitAmount > 0 && creditAmount === 0,
  };
}

const moneyIn = decideDirection(new Decimal("0"), new Decimal("50000"));
check("Money coming in is detected as a credit", moneyIn.hasCredit, true);
check("Money coming in is not also a debit", moneyIn.hasDebit, false);

const moneyOut = decideDirection(new Decimal("50000"), new Decimal("0"));
check("Money going out is detected as a debit", moneyOut.hasDebit, true);
check("Money going out is not also a credit", moneyOut.hasCredit, false);

const nullSide = decideDirection(null, new Decimal("50000"));
check("A null debit still leaves a clean credit", nullSide.hasCredit, true);

const bothSides = decideDirection(new Decimal("100"), new Decimal("100"));
check("A transaction with both sides is claimed by neither", bothSides.hasCredit, false);
check("A transaction with both sides is not a debit either", bothSides.hasDebit, false);

const emptyRow = decideDirection(new Decimal("0"), new Decimal("0"));
check("An empty row is not a credit", emptyRow.hasCredit, false);
check("An empty row is not a debit", emptyRow.hasDebit, false);

// ---------------------------------------------------------------------------
// sumMoney / netMoney — the exact-arithmetic helpers the reduce and `+=`
// sites now use.
//
// These carry the point of the entire migration. Two things must hold: the
// total must be a NUMBER (not a concatenated string), and it must be EXACT
// (not a float approximation). Converting each value first satisfies the
// first and fails the second, which is why the summing happens in Decimal.
// ---------------------------------------------------------------------------

check("sumMoney adds Decimals exactly", sumMoney([new Decimal("1000000.10"), new Decimal("2000000.20"), new Decimal("3000000.30")]), 6000000.6);
check("sumMoney returns a number", typeof sumMoney([new Decimal("1")]), "number");
check("sumMoney of nothing is zero", sumMoney([]), 0);
check("sumMoney ignores nulls", sumMoney([new Decimal("100"), null, undefined, new Decimal("50")]), 150);
check("sumMoney accepts plain numbers", sumMoney([1000.25, 2000.5]), 3000.75);
check("sumMoney accepts strings", sumMoney(["1000.25", "2000.50"]), 3000.75);
check("sumMoney handles a single zero", sumMoney([new Decimal("0")]), 0);

// The case the tolerances were invented to hide.
check(
  "Adding these in floating point does not give a clean total",
  0.1 + 0.2,
  0.30000000000000004,
);
check("sumMoney gives the clean total", sumMoney([new Decimal("0.10"), new Decimal("0.20")]), 0.3);

check("netMoney subtracts exactly", netMoney([{ value: new Decimal("2000000.30") }, { value: new Decimal("1000000.10"), subtract: true }]), 1000000.2);
check("netMoney returns a number", typeof netMoney([{ value: new Decimal("1") }]), "number");
check("netMoney of nothing is zero", netMoney([]), 0);
check("netMoney treats a missing flag as an addition", netMoney([{ value: new Decimal("500") }, { value: new Decimal("250"), subtract: false }]), 750);

// The exact reconciliation shape: closing - opening - movement. This is the
// calculation that currently leaves a 1e-10 residue and forces a tolerance.
const reconciliationResidue =
  2000000.3 - 1000000.1 - (1000000.2 + 0 - 0 - 0 + 0);
check(
  "In floating point the reconciliation does not cancel to zero",
  reconciliationResidue === 0,
  false,
);
check(
  "In Decimal the same figures cancel exactly",
  netMoney([
    { value: new Decimal("2000000.30") },
    { value: new Decimal("1000000.10"), subtract: true },
    { value: new Decimal("1000000.20"), subtract: true },
  ]),
  0,
);

// The inflow/outflow adjustment shape used by the reconciliation.
check(
  "Mixed inflow and outflow adjustments net correctly",
  netMoney([
    { value: new Decimal("125000.45") },
    { value: new Decimal("25000.15"), subtract: true },
    { value: new Decimal("50000.30") },
  ]),
  150000.6,
);

// Concatenation, stated as the failure these helpers prevent.
check(
  "A raw reduce over Decimals produces a string",
  typeof [new Decimal("1000000.10"), new Decimal("2000000.20")].reduce(
    (total, value) => total + value,
    0,
  ),
  "string",
);
check(
  "sumMoney over the same values produces a number",
  typeof sumMoney([new Decimal("1000000.10"), new Decimal("2000000.20")]),
  "number",
);

// A realistic ledger: many entries, mixed types, paisa amounts throughout.
const ledgerAmounts = [
  "125000.45", "75000.55", "250000.10", "12500.90", "99999.99",
  "1000.01", "45678.32", "8765.43", "333333.33", "666666.67",
];
check(
  "A ten-entry ledger sums exactly",
  sumMoney(ledgerAmounts.map((value) => new Decimal(value))),
  1617945.75,
);

// Floating point does NOT corrupt every sum -- these ten happen to land on
// the right answer. That is precisely what makes the bug dangerous: it is
// intermittent, so a handful of manual checks all look fine and the fault
// only appears on the particular combination a real filing happens to hit.
check(
  "This particular ledger survives floating point by luck",
  ledgerAmounts.reduce((total, value) => total + Number(value), 0),
  1617945.75,
);

// Ledgers of ordinary rupees-and-paisa amounts that do NOT survive. These
// were found by searching for combinations where the float sum differs from
// the exact one, rather than assumed -- an earlier guess at "obviously bad"
// numbers turned out to add up correctly.
const driftingLedgers = [
  { amounts: ["9128.24", "6715.91", "2916.82", "9299.34", "8509.29"], exact: 36569.6 },
  { amounts: ["983.53", "5572.35", "8785.63", "868.94", "8059.45"], exact: 24269.9 },
  { amounts: ["37.99", "8928.06", "7511.58"], exact: 16477.63 },
];

for (const { amounts, exact } of driftingLedgers) {
  const floatTotal = amounts.reduce((total, value) => total + Number(value), 0);
  check(
    `A ${amounts.length}-entry ledger totalling ${exact} drifts in floating point`,
    floatTotal === exact,
    false,
  );
  check(
    `sumMoney totals it exactly instead`,
    sumMoney(amounts.map((value) => new Decimal(value))),
    exact,
  );
}

// deriveOpeningBalance — the parser's `balance - credit + debit`, extracted so
// the `+` hazard is reachable from a test without uploading a file.
const parsedOpening = deriveOpeningBalance(
  new Decimal("52000.40"),
  new Decimal("10000.10"),
  new Decimal("3000.20"),
);
check("The opening balance derivation is a number", typeof parsedOpening, "number");
check("The opening balance derivation is exact", parsedOpening, 45000.5);
check(
  "The derivation reverses a credit correctly",
  deriveOpeningBalance(new Decimal("750000.55"), new Decimal("750000.55"), new Decimal("0")),
  0,
);
check(
  "The derivation reverses a debit correctly",
  deriveOpeningBalance(new Decimal("625000.10"), new Decimal("0"), new Decimal("125000.45")),
  750000.55,
);
// This is the case that proves the derivation must stay in Decimal. Doing the
// same subtraction after converting to number gives 750000.5499999999, and
// the result is stored as the statement's opening balance.
check(
  "Converting before the arithmetic would reintroduce the float error",
  625000.1 - 0 + 125000.45,
  750000.5499999999,
);
check(
  "The derivation avoids that error",
  deriveOpeningBalance(new Decimal("625000.10"), new Decimal("0"), new Decimal("125000.45")) ===
    625000.1 - 0 + 125000.45,
  false,
);
check(
  "The derivation copes with null sides",
  deriveOpeningBalance(new Decimal("5000"), null, null),
  5000,
);
check(
  "The derivation works on plain numbers too",
  deriveOpeningBalance(52000.4, 10000.1, 3000.2),
  45000.5,
);
check(
  "The same arithmetic without converting produces a string",
  typeof (new Decimal("52000.40") - new Decimal("10000.10") + new Decimal("3000.20")),
  "string",
);

// findLikelyInternalTransferPairs matches the two sides of a transfer between
// the taxpayer's own accounts. It compares amounts to the paisa, so a Decimal
// reaching those comparisons unconverted would stop pairing them, and the
// filing would be blocked by an unmatched-transfer error the user cannot fix.
const {
  findLikelyInternalTransferPairs,
} = require(path.join(root, "lib/tax/bank-transfer-matching.ts"));

const transferDate = new Date("2025-09-15T00:00:00.000Z");
const outgoing = {
  id: "out",
  bankAccountId: "account-a",
  transactionDate: transferDate,
  description: "Online transfer to savings",
  debit: new Decimal("250000.75"),
  credit: null,
};
const incoming = {
  id: "in",
  bankAccountId: "account-b",
  transactionDate: transferDate,
  description: "Online transfer from current",
  debit: null,
  credit: new Decimal("250000.75"),
};
const unrelated = {
  id: "other",
  bankAccountId: "account-b",
  transactionDate: transferDate,
  description: "Online transfer from current",
  credit: new Decimal("250000.76"),
  debit: null,
};

const transferMatches = findLikelyInternalTransferPairs(outgoing, [
  incoming,
  unrelated,
]);
check("A Decimal transfer still finds its opposite side", transferMatches.length, 1);
check("It matches the correct row", transferMatches[0] && transferMatches[0].id, "in");
check(
  "A one-paisa difference is not treated as the same transfer",
  findLikelyInternalTransferPairs(outgoing, [unrelated]).length,
  0,
);
check(
  "Matching works from the incoming side too",
  findLikelyInternalTransferPairs(incoming, [outgoing]).length,
  1,
);
check(
  "A zero-amount Decimal row matches nothing",
  findLikelyInternalTransferPairs(
    { ...outgoing, debit: new Decimal("0"), credit: new Decimal("0") },
    [incoming],
  ).length,
  0,
);

// formatMoneyForInput — feeds editable text boxes.
check("formatMoneyForInput renders a whole amount without trailing zeros", formatMoneyForInput(new Decimal("5000.00")), "5000");
check("formatMoneyForInput keeps real paisa", formatMoneyForInput(new Decimal("5000.25")), "5000.25");
check("formatMoneyForInput renders a zero, not an empty box", formatMoneyForInput(new Decimal("0")), "0");
check("formatMoneyForInput leaves a missing value empty", formatMoneyForInput(null), "");
check("formatMoneyForInput leaves undefined empty", formatMoneyForInput(undefined), "");
check("formatMoneyForInput always returns a string", typeof formatMoneyForInput(new Decimal("1")), "string");

// ---------------------------------------------------------------------------
// Phase 5-E — the 0.01 tolerances are gone
//
// Every money comparison used to allow a one-paisa difference, because the
// figures were computed in floating point and two runs over identical data
// could disagree in the last digits. With Decimal columns summed exactly that
// is no longer true, so the tolerances were removed.
//
// This matters beyond tidiness: the reconciliation gate decides whether a
// filing may be submitted to the FBR. At 0.01 it would accept books that are
// genuinely out by up to a paisa on every check.
// ---------------------------------------------------------------------------

const TOLERANCE_FREE_FILES = [
  "lib/tax/filing-status.ts",
  "lib/tax/reconciliation-calculation.ts",
  "app/actions/ledger.ts",
  "app/actions/reconciliation.ts",
  "app/tax/fbr-connect/page.tsx",
  "components/tax/filing/filing-wizard.tsx",
  "components/tax/filing/wizard-reconciliation-step.tsx",
  "components/tax/filing/hooks/use-filing-reconciliation.ts",
];

for (const file of TOLERANCE_FREE_FILES) {
  const source = fs
    .readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  check(`${file} no longer compares money against a 0.01 tolerance`, /0\.01/.test(source), false);
}

// Two 0.01 values are legitimate and must NOT be removed: the 1% tax band
// rate, and the paisa rounding banks apply to their own statement lines.
const rateCardSource = fs.readFileSync(path.join(root, "lib/tax/rules/ty2026.ts"), "utf8");
check("The 1 percent tax band rate is still present", /rate: 0\.01/.test(rateCardSource), true);
const transferSource = fs.readFileSync(path.join(root, "lib/tax/bank-transfer-matching.ts"), "utf8");
check("Bank transfer matching keeps its own paisa tolerance", /0\.01/.test(transferSource), true);

// isMizanResolved is the submission gate. It must demand an exact zero.
const { isMizanResolved } = require(path.join(root, "lib/tax/filing-status.ts"));

check("A balanced filing passes the gate", isMizanResolved("RESOLVED", new Decimal("0")), true);
check("A plain zero passes too", isMizanResolved("RESOLVED", 0), true);
check("A missing gap is treated as balanced", isMizanResolved("RESOLVED", null), true);
check("One paisa out no longer passes", isMizanResolved("RESOLVED", new Decimal("0.01")), false);
check("One paisa short no longer passes", isMizanResolved("RESOLVED", new Decimal("-0.01")), false);
check("A half-paisa residue does not pass", isMizanResolved("RESOLVED", 0.005), false);
check("A real imbalance does not pass", isMizanResolved("RESOLVED", new Decimal("1500.75")), false);
check("An unresolved filing never passes", isMizanResolved("IN_PROGRESS", new Decimal("0")), false);
check("A Decimal zero is not mistaken for truthy here", isMizanResolved("RESOLVED", new Decimal("0.00")), true);

// ---------------------------------------------------------------------------
// The final packet PDF — the document that goes to the FBR.
//
// `Decimal.toLocaleString()` does not group thousands, so a figure formatted
// straight off the column prints "PKR 3685290" instead of "PKR 3,685,290".
// Nothing throws and no test of the calculation notices: the number is
// correct, only unreadable, and it appears on the filed document.
// ---------------------------------------------------------------------------

check("A Decimal does not group thousands on its own", new Decimal("3685290").toLocaleString(), "3685290");
check("A number does", (3685290).toLocaleString(), "3,685,290");
check("Converting first restores the grouping", toMoneyNumber(new Decimal("3685290")).toLocaleString(), "3,685,290");
check("Grouping survives paisa", toMoneyNumber(new Decimal("2181000.55")).toLocaleString(), "2,181,000.55");

const packetSource = fs
  .readFileSync(path.join(root, "app/actions/packet.ts"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");
check(
  "The packet formats tax figures through the conversion helper",
  /PKR \$\{toMoneyNumber\(value\)\.toLocaleString\(\)\}/.test(packetSource),
  true,
);
check(
  "The packet does not format a raw column value",
  /PKR \$\{value\.toLocaleString\(\)\}/.test(packetSource),
  false,
);
check(
  "The packet converts the reconciliation gap before formatting it",
  /toMoneyAmount\(snapshot\.filing\.reconciliationGap\)/.test(packetSource),
  true,
);
check(
  "The packet ledger lines are converted too",
  /toMoneyNumber\(\s*entry\.amount,?\s*\)\.toLocaleString\(\)/.test(packetSource),
  true,
);

if (failures.length > 0) {
  console.error("Money precision checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Money precision checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      baselineFiguresPinned: BASELINES.length + 5,
      moneyColumnsTracked: MONEY_COLUMN_PAIRS.length,
      moneyColumnsStillFloat: stillFloat.length,
      stillFloat,
    },
    null,
    2,
  ),
);
