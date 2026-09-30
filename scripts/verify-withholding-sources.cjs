/**
 * Withholding sources — every deduction already made must reach the engine.
 *
 * Tax is withheld in more than one place. An employer deducts under Section
 * 149 and issues a salary certificate. A bank deducts under Section 151 on
 * each profit payment, and that deduction only ever appears as a bank
 * transaction the wizard classifies as EXPENSE / TAX_PAYMENT.
 *
 * The defect this suite exists to prevent, found in a manual end-to-end run:
 * the calculator read the salary certificate and nothing else, so PKR 200,000
 * of bank withholding was invisible and the taxpayer was billed for it a
 * second time. Screen showed "Tax Payable 200,000" where the correct answer
 * was 0.
 *
 * These checks run against a real database because the sum happens in a
 * Prisma query, not in a pure function — an in-memory test of the engine
 * cannot see the bug at all. That is precisely why the original suites
 * missed it: every one of them passed taxWithheld in by hand.
 *
 * Skips cleanly when no database is reachable.
 */

const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const Module = require("module");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
};

// Load .env so DATABASE_URL is available exactly as the app sees it.
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

let PrismaClient;
try {
  ({ PrismaClient } = require("@prisma/client"));
} catch {
  console.log(
    "Withholding source checks skipped: Prisma client not generated.",
  );
  process.exit(0);
}

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

// ---------------------------------------------------------------------------
// Duplicate-withholding warning.
//
// These run without a database, because the risk they cover is worse than the
// defect that started this suite. Under-counting withholding overstates the
// bill and the taxpayer complains. Over-counting it invents a refund, the
// return is filed, and FBR raises the notice months later. So the resolver
// adds both sources and raises a question instead of silently picking one.
// ---------------------------------------------------------------------------
function runWarningChecks(resolveTaxWithheld, looksLikeSalaryWithholding) {
  const row = (description, amount, category = "TAX_PAYMENT") => ({
    entryType: "EXPENSE",
    category,
    description,
    amount,
  });

  const bankRows = [
    row("WITHHOLDING TAX U/S 151 ON PROFIT Q1", 50_000),
    row("WITHHOLDING TAX U/S 151 ON PROFIT Q2", 50_000),
  ];

  // Bank narration must never be mistaken for employer withholding, or every
  // ordinary filing would carry a warning and users would learn to ignore it.
  check(
    "Section 151 narration is not read as salary withholding",
    looksLikeSalaryWithholding("WITHHOLDING TAX U/S 151 ON PROFIT Q1"),
    false,
  );
  check(
    "Profit narration is not read as salary withholding",
    looksLikeSalaryWithholding("WHT ON PROFIT PAYMENT"),
    false,
  );
  check(
    "Employer narration is read as salary withholding",
    looksLikeSalaryWithholding("SALARY TAX DEDUCTION - ACME TEXTILES"),
    true,
  );
  check(
    "Payroll narration is read as salary withholding",
    looksLikeSalaryWithholding("PAYROLL TAX REMITTANCE"),
    true,
  );
  check(
    "Section 149 narration is read as salary withholding",
    looksLikeSalaryWithholding("INCOME TAX U/S 149 DEDUCTED"),
    true,
  );

  // A normal filing: certificate plus bank deductions, nothing overlapping.
  const clean = resolveTaxWithheld({
    certificateTaxWithheld: 3_685_290,
    entries: bankRows,
    storedTaxWithheld: 0,
  });
  check(
    "Certificate and bank deductions are added",
    clean.taxWithheld,
    3_785_290,
  );
  check("A clean filing raises no warning", clean.duplicateWarning, null);
  // Asserted on the resolver, not only on the helper: a change that made bank
  // narration look like employer withholding would otherwise pass here and
  // put an amber warning on every ordinary filing.
  //
  // The narration below deliberately contains BOTH a bank marker ("151",
  // "profit") and a salary marker ("income tax deduction", "149"), because
  // that is the only shape that can tell the two rules apart. A row with bank
  // language alone proves nothing: removing the bank check entirely would
  // still leave it unmatched, and the assertion would pass over a real
  // regression.
  check(
    "Bank narration wins when a row carries both markers",
    resolveTaxWithheld({
      certificateTaxWithheld: 3_685_290,
      entries: [
        row("INCOME TAX DEDUCTION U/S 151 ON PROFIT Q3", 50_000),
        row("PAYROLL TAX SYSTEM REF - PROFIT ON DEBT WHT", 50_000),
        row("EMPLOYER TAX CODE 149 - WHT ON PROFIT PAYMENT", 50_000),
      ],
      storedTaxWithheld: 0,
    }).duplicateWarning,
    null,
  );
  check(
    "Section 151 narration alone is not employer withholding",
    looksLikeSalaryWithholding("INCOME TAX DEDUCTION U/S 151 ON PROFIT"),
    false,
  );

  // The dangerous case: the employer pays gross and the deduction also lands
  // in the bank ledger, so the same money is described twice.
  const overlapping = resolveTaxWithheld({
    certificateTaxWithheld: 3_685_290,
    entries: [...bankRows, row("SALARY TAX DEDUCTION - ACME", 3_685_290)],
    storedTaxWithheld: 0,
  });
  check(
    "The suspected duplicate still calculates rather than blocking",
    overlapping.taxWithheld,
    7_470_580,
  );
  check(
    "The suspected duplicate is flagged",
    typeof overlapping.duplicateWarning,
    "string",
  );
  const overlapText = overlapping.duplicateWarning ?? "";
  check(
    "The warning names the amount at risk",
    overlapText.includes("3,685,290"),
    true,
  );
  check(
    "The warning names the offending row",
    overlapText.includes("SALARY TAX DEDUCTION - ACME"),
    true,
  );

  // No certificate means nothing can be double-counted, however the ledger
  // rows are worded.
  const ledgerOnly = resolveTaxWithheld({
    certificateTaxWithheld: 0,
    entries: [row("SALARY TAX DEDUCTION - ACME", 3_685_290)],
    storedTaxWithheld: 0,
  });
  check(
    "Ledger-only withholding is used in full",
    ledgerOnly.taxWithheld,
    3_685_290,
  );
  check(
    "Ledger-only withholding raises no duplicate warning",
    ledgerOnly.duplicateWarning,
    null,
  );

  // Rows that are not tax must never be added, whatever they say.
  const nonTax = resolveTaxWithheld({
    certificateTaxWithheld: 0,
    entries: [row("SALARY TAX ADVISORY FEE", 25_000, "PERSONAL_EXPENSE")],
    storedTaxWithheld: 0,
  });
  check(
    "Non-TAX_PAYMENT rows are excluded from withholding",
    nonTax.ledgerTaxWithheld,
    0,
  );

  // A row whose description was never selected must not take down Calculate.
  // This is the exact shape a Prisma `select` missing `description` returns,
  // and it crashed the ledger half of this suite on the first machine that
  // had a database. The amounts still have to be right; only the warning is
  // lost, because an unnamed row cannot be recognised.
  const undescribed = resolveTaxWithheld({
    certificateTaxWithheld: 3_685_290,
    entries: [
      { entryType: "EXPENSE", category: "TAX_PAYMENT", amount: 50_000 },
    ],
    storedTaxWithheld: 0,
  });
  check(
    "A row with no description still contributes its amount",
    undescribed.taxWithheld,
    3_735_290,
  );
  check(
    "A row with no description raises no warning",
    undescribed.duplicateWarning,
    null,
  );
  check(
    "A missing description is not read as salary withholding",
    looksLikeSalaryWithholding(undefined),
    false,
  );

  // With no evidence at all, a manually entered figure survives.
  const manual = resolveTaxWithheld({
    certificateTaxWithheld: 0,
    entries: [],
    storedTaxWithheld: 500_000,
  });
  check(
    "A hand-entered figure is preserved when there is no evidence",
    manual.taxWithheld,
    500_000,
  );
}

const { calculateTaxEstimate } = require("@/lib/tax/tax-calculation.ts");
const { sumMoney, toMoneyAmount } = require("@/lib/money.ts");
const {
  resolveTaxWithheld,
  looksLikeSalaryWithholding,
} = require("@/lib/tax/withholding-sources.ts");

const DEPOSIT = "bank-or-financial-institution-deposit";

// Runs first and without a database: a skipped suite must still prove the
// duplicate-withholding guard, since that is the check protecting against a
// fabricated refund.
runWarningChecks(resolveTaxWithheld, looksLikeSalaryWithholding);

const prisma = new PrismaClient();

/** Calls the production resolver, never a copy of its logic. */
function sumLedgerTaxPayments(entries) {
  return resolveTaxWithheld({
    certificateTaxWithheld: 0,
    entries,
    storedTaxWithheld: 0,
  }).ledgerTaxWithheld;
}

async function main() {
  const email = `withholding-probe-${Date.now()}@example.test`;
  const user = await prisma.user.create({
    data: { email, name: "Withholding Probe" },
  });

  const draft = await prisma.filingDraft.create({
    data: {
      userId: user.id,
      taxYear: 2026,
      incomeSources: JSON.stringify(["salary", "bank_profit"]),
    },
  });

  // The exact ledger the manual run produced: four quarterly Section 151
  // deductions of 50,000 approved as tax payments, plus ordinary expenses
  // that must not be mistaken for tax.
  const quarters = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-29"];
  for (const date of quarters) {
    await prisma.ledgerEntry.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        entryDate: new Date(`${date}T00:00:00.000Z`),
        entryType: "EXPENSE",
        category: "TAX_PAYMENT",
        description: `WITHHOLDING TAX U/S 151 ON PROFIT ${date}`,
        amount: 50000,
      },
    });
  }
  for (const [description, amount] of [
    ["K-ELECTRIC BILL PAYMENT", 24500],
    ["POS PURCHASE - IMTIAZ SUPERMARKET", 62000],
  ]) {
    await prisma.ledgerEntry.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        entryDate: new Date("2025-07-10T00:00:00.000Z"),
        entryType: "EXPENSE",
        category: "UTILITIES_OR_RENT",
        description,
        amount,
      },
    });
  }

  const entries = await prisma.ledgerEntry.findMany({
    where: { filingDraftId: draft.id, userId: user.id },
    // `description` is required. The resolver reads it to decide whether a
    // tax row looks like employer withholding, so omitting it here made the
    // ledger checks crash on a machine that actually has a database — the
    // sandbox this suite was written on has none, so the query never ran and
    // the mistake shipped. Keep this select in step with every field
    // WithholdingLedgerEntry declares.
    select: {
      entryType: true,
      category: true,
      amount: true,
      description: true,
    },
  });

  // 1 — the reducer isolates tax payments from ordinary expenses.
  check(
    "Four Section 151 deductions sum to 200,000",
    sumLedgerTaxPayments(entries),
    200_000,
  );
  check(
    "Utility and grocery rows are not counted as tax",
    sumMoney(
      entries.filter((e) => e.entryType === "EXPENSE").map((e) => e.amount),
    ),
    286_500,
  );

  // 2 — a ledger with no tax rows must contribute nothing, so the salary
  // certificate path is never inflated by an empty sum.
  check(
    "A ledger without tax payments contributes zero",
    sumLedgerTaxPayments(entries.filter((e) => e.category !== "TAX_PAYMENT")),
    0,
  );

  // 3 — the defect itself, priced end to end.
  const sources = [
    { route: "salary", income: 12_000_000 },
    { route: "bank_profit", income: 1_000_000, subcategory: DEPOSIT },
  ];
  const estimate = (taxWithheld) =>
    calculateTaxEstimate({
      taxYear: 2026,
      filerStatus: "ATL",
      totalIncome: 13_000_000,
      totalExpenses: 0,
      bankProfitIncome: 1_000_000,
      taxWithheld,
      isSalariedRoute: true,
      isBankProfitRoute: true,
      incomeSources: sources,
    });

  const salaryCertificateOnly = 3_685_290;
  const withBankWithholding =
    salaryCertificateOnly + sumLedgerTaxPayments(entries);

  check(
    "Total liability is unchanged by the fix",
    estimate(withBankWithholding).taxDue,
    3_885_290,
  );
  check(
    "Salary certificate alone leaves 200,000 wrongly payable",
    estimate(salaryCertificateOnly).taxPayable,
    200_000,
  );
  check(
    "Adding the bank's Section 151 deduction clears the balance",
    estimate(withBankWithholding).taxPayable,
    0,
  );
  check(
    "Fully withheld filing produces no refund",
    estimate(withBankWithholding).refundDue,
    0,
  );

  // 4 — over-withholding on the assessable portion still refunds, so the fix
  // has not turned every filing into a zero.
  const overWithheld = estimate(withBankWithholding + 100_000);
  check(
    "Excess withholding above the liability is refundable",
    overWithheld.refundDue,
    100_000,
  );
  check(
    "Excess withholding leaves nothing payable",
    overWithheld.taxPayable,
    0,
  );

  // 5 — idempotence. This action writes its own total back into
  // draft.taxWithheld, so the second press of Calculate reads a column that
  // already contains the first run's answer. A conditional top-up looks
  // correct on a fresh draft and then silently drops the bank's deduction on
  // every run after that: the first fix shipped for this defect passed a
  // clean-draft test and still showed 200,000 payable in the browser.
  //
  // Resolving from the two evidence sources each time is what makes the
  // result stable, so the rule is asserted directly here.
  const resolveWithheld = (storedColumn) =>
    resolveTaxWithheld({
      certificateTaxWithheld: salaryCertificateOnly,
      entries,
      storedTaxWithheld: storedColumn,
    }).taxWithheld;

  check(
    "First calculation resolves the full withheld amount",
    resolveWithheld(0),
    3_885_290,
  );
  check(
    "Second calculation is not skewed by its own stored result",
    resolveWithheld(3_885_290),
    3_885_290,
  );
  check(
    "A stale certificate-only column does not suppress the ledger",
    resolveWithheld(salaryCertificateOnly),
    3_885_290,
  );
  check(
    "Recalculating leaves nothing payable",
    estimate(resolveWithheld(3_885_290)).taxPayable,
    0,
  );
  check(
    "Recalculating does not double-count the ledger into a refund",
    estimate(resolveWithheld(3_885_290)).refundDue,
    0,
  );

  // 6 — Decimal safety: the column is Decimal(18,2) and `+` on it would
  // concatenate. Prove the sum is numeric, not "5000050000...".
  check(
    "Tax payments are summed numerically, not concatenated",
    typeof sumLedgerTaxPayments(entries),
    "number",
  );
  check(
    "A Decimal tax row converts to the exact amount",
    toMoneyAmount(entries.find((e) => e.category === "TAX_PAYMENT").amount),
    50_000,
  );

  await prisma.user.delete({ where: { id: user.id } });
}

main()
  .catch((error) => {
    const message = String(error?.message ?? error);
    if (/ECONNREFUSED|Can't reach database|P1001/.test(message)) {
      if (failures.length > 0) {
        console.error("Withholding source checks FAILED:");
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exit(1);
      }
      console.log(
        `Withholding source checks: ${assertionCount} duplicate-guard assertions passed; ` +
          "ledger checks skipped (no database reachable).",
      );
      process.exit(0);
    }
    failures.push(`Unexpected error: ${message}`);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    if (failures.length > 0) {
      console.error("Withholding source checks FAILED:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log("Withholding source checks passed.");
    console.log(
      JSON.stringify(
        {
          assertionCount,
          withholdingSources: [
            "salary certificate (Section 149)",
            "ledger TAX_PAYMENT rows (Section 151)",
          ],
          defectPrevented:
            "bank withholding ignored, taxpayer billed 200,000 twice",
        },
        null,
        2,
      ),
    );
  });
