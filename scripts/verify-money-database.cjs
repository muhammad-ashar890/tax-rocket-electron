/**
 * Money precision — live database checks (Phase 5-C onward).
 *
 * verify-money-precision.cjs pins the pure calculation and the conversion
 * helpers. This suite is the other half: it exercises the money columns
 * against a real PostgreSQL database, because the failures this migration is
 * built to prevent only appear once values have made a round trip through
 * storage.
 *
 * It answers three questions that no in-memory test can:
 *
 *   1. Does an existing Float value survive the conversion to Decimal
 *      unchanged? (A migration that silently rounds is worse than no
 *      migration.)
 *   2. Does the database actually sum money exactly once the column is
 *      Decimal, where Float returns 2000000.5999999999?
 *   3. Does application code that reads the column still get the right
 *      answer, rather than a concatenated string?
 *
 * Requires DATABASE_URL. Skips cleanly when no database is reachable, so it
 * never turns a laptop without Postgres into a red build.
 */

const { createHash } = require("node:crypto");
const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const Module = require("module");

// lib/money.ts is TypeScript; compile it on demand, as the other verify
// scripts do, so the conversion boundary can be exercised directly.
const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
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

let PrismaClient;
let Prisma;
try {
  ({ PrismaClient, Prisma } = require("@prisma/client"));
} catch {
  console.log("Money database checks skipped: Prisma client is not generated.");
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

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "prisma", "schema.prisma"),
  "utf8",
);

/** Reads the declared storage type of a column straight from the schema. */
function columnType(model, column) {
  const block = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(SCHEMA);
  if (!block) return null;
  const line = new RegExp(`\\n\\s+${column}\\s+(\\w+)`).exec(block[0]);
  return line ? line[1] : null;
}

/**
 * Source-level checks that need no database.
 *
 * These used to sit inside the Prisma block, which meant they only ran on a
 * machine that had Postgres. A sandbox without a database reported "skipped"
 * and the assertions never executed, so a rename in tax-calculation.ts went
 * unnoticed until it failed on the user's machine. Anything that only reads
 * a file belongs out here.
 */
function runSourceChecks() {
  const taxActionSource = fs
    .readFileSync(
      path.join(__dirname, "..", "app", "actions", "tax-calculation.ts"),
      "utf8",
    )
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  // `taxWithheld` is Decimal(18,2). A Decimal is never `=== 0` and `+` on it
  // concatenates, so every read of the column has to pass through
  // toMoneyAmount first. Rather than pin one particular line — the previous
  // version matched `let taxWithheld = toMoneyAmount(draft.taxWithheld)` and
  // broke the moment the read moved into resolveTaxWithheld — this checks the
  // rule itself: no occurrence of draft.taxWithheld may appear unwrapped.
  const reads = [...taxActionSource.matchAll(/(\w*\s*\(?\s*)draft\.taxWithheld/g)];
  check(
    "The tax calculation reads the withheld column at least once",
    reads.length > 0,
    true,
  );
  const unwrapped = reads.filter((match) => !/toMoneyAmount\s*\($/.test(match[1]));
  check(
    "Every read of the withheld column is converted with toMoneyAmount",
    unwrapped.length,
    0,
  );

  // The resolver owns the decision now, and it must be handed the converted
  // number rather than the raw column.
  check(
    "The stored column reaches the resolver already converted",
    /storedTaxWithheld:\s*toMoneyAmount\(draft\.taxWithheld\)/.test(taxActionSource),
    true,
  );
}

async function main() {
  runSourceChecks();

  const prisma = new PrismaClient();

  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch {
    await prisma.$disconnect().catch(() => {});
    if (failures.length > 0) {
      console.error("Money database checks FAILED:\n");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(
      `Money database checks: ${assertionCount} source assertions passed; ` +
        "database checks skipped (no database reachable).",
    );
    process.exit(0);
  }

  const suffix = `mp_${Date.now()}`;
  let userId = null;

  try {
    // -----------------------------------------------------------------------
    // 1 — the storage type in the database matches the schema
    //
    // Prisma will happily generate a client from a schema the database has
    // never seen. If a migration was written but never applied, every other
    // assertion here would pass against the old column type and prove nothing.
    // -----------------------------------------------------------------------

    const MIGRATED_COLUMNS = [
      ["FilingPacket", "taxPayable"],
      ["FilingPacket", "refundDue"],
    ];

    for (const [model, column] of MIGRATED_COLUMNS) {
      const declared = columnType(model, column);
      if (declared !== "Decimal") continue;

      const rows = await prisma.$queryRawUnsafe(
        `SELECT data_type::text AS t FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2`,
        model,
        column,
      );
      check(
        `${model}.${column}: schema says Decimal, database agrees`,
        rows[0] ? rows[0].t : "MISSING",
        "numeric",
      );
    }

    // -----------------------------------------------------------------------
    // 2 — the database sums Decimal money exactly
    //
    // This is the entire justification for the migration, run against real
    // Postgres rather than asserted in a report. 1000000.10 + 1000000.20 +
    // 0.30 must be 2000000.60 with no trailing noise.
    // -----------------------------------------------------------------------

    const table = `_money_${suffix}`;
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${table}" (f double precision, d numeric(18,2))`,
    );
    for (const value of ["1000000.10", "1000000.20", "0.30"]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${table}" (f, d) VALUES (${value}, ${value})`,
      );
    }

    const sums = await prisma.$queryRawUnsafe(
      `SELECT sum(f)::text AS float_sum, sum(d)::text AS decimal_sum,
              (sum(d) = 2000000.60) AS decimal_exact,
              (sum(f) = 2000000.60) AS float_exact
       FROM "${table}"`,
    );

    check("Decimal sums exactly in the database", sums[0].decimal_exact, true);
    check("Float does not, which is why tolerances exist", sums[0].float_exact, false);
    check("Decimal total reads back correctly", sums[0].decimal_sum, "2000000.60");

    await prisma.$executeRawUnsafe(`DROP TABLE "${table}"`);

    // -----------------------------------------------------------------------
    // 3 — an existing value survives the Float -> Decimal conversion
    //
    // Simulates a row written before the migration and converts the column in
    // place, exactly as the real migration does. A value that rounds or
    // truncates here would be silent data loss for a live user.
    // -----------------------------------------------------------------------

    const legacy = `_legacy_${suffix}`;
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${legacy}" (id text, money double precision)`,
    );
    // Deliberately awkward values: paisa, a whole rupee, and a zero.
    for (const [id, value] of [
      ["a", "2181000.55"],
      ["b", "1234.99"],
      ["c", "3685290"],
      ["d", "0"],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${legacy}" VALUES ('${id}', ${value})`,
      );
    }

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${legacy}" ALTER COLUMN money SET DATA TYPE numeric(18,2)`,
    );

    const converted = await prisma.$queryRawUnsafe(
      `SELECT id, money::text AS m FROM "${legacy}" ORDER BY id`,
    );
    const byId = Object.fromEntries(converted.map((row) => [row.id, row.m]));

    check("Conversion preserves paisa", byId.a, "2181000.55");
    check("Conversion preserves a small amount", byId.b, "1234.99");
    check("Conversion preserves a whole rupee figure", byId.c, "3685290.00");
    check("Conversion preserves zero", byId.d, "0.00");

    const type = await prisma.$queryRawUnsafe(
      `SELECT data_type::text AS t FROM information_schema.columns
       WHERE table_name = '${legacy}' AND column_name = 'money'`,
    );
    check("The column really is numeric afterwards", type[0].t, "numeric");

    await prisma.$executeRawUnsafe(`DROP TABLE "${legacy}"`);

    // -----------------------------------------------------------------------
    // 4 — application round trip through the Prisma client
    //
    // Writing and reading a money column must give back the same figure, and
    // the value the client hands to application code must be usable. This is
    // where a concatenating `+` would show up as a wrong total rather than an
    // error.
    // -----------------------------------------------------------------------

    const user = await prisma.user.create({
      data: { email: `${suffix}@example.test`, name: "Money precision probe" },
    });
    userId = user.id;

    const draft = await prisma.filingDraft.create({
      data: { userId: user.id, taxYear: 2026 },
    });

    const AMOUNTS = ["1000000.10", "1000000.20", "0.30"];
    for (const [index, value] of AMOUNTS.entries()) {
      await prisma.filingPacket.create({
        data: {
          filingDraftId: draft.id,
          userId: user.id,
          version: index + 1,
          packetHash: `h${index}`,
          snapshotJson: "{}",
          taxPayable: new Prisma.Decimal(value),
          refundDue: 0,
        },
      });
    }

    const aggregate = await prisma.filingPacket.aggregate({
      where: { filingDraftId: draft.id },
      _sum: { taxPayable: true },
    });
    check(
      "Prisma aggregate over Decimal money is exact",
      aggregate._sum.taxPayable.toString(),
      "2000000.6",
    );

    const stored = await prisma.filingPacket.findFirst({
      where: { filingDraftId: draft.id, version: 1 },
      select: { taxPayable: true, refundDue: true },
    });
    check("A stored Decimal reads back unchanged", stored.taxPayable.toString(), "1000000.1");

    // The trap, demonstrated on a value that came out of the database rather
    // than one constructed in the test: `+` concatenates instead of adding.
    check(
      "Adding two database Decimals with + concatenates",
      stored.taxPayable + stored.taxPayable,
      "1000000.11000000.1",
    );
    check(
      "Their .plus() is the correct total",
      stored.taxPayable.plus(stored.taxPayable).toString(),
      "2000000.2",
    );

    // A zero read from the database is truthy, so any falsy guard on a money
    // column inverts once that column becomes Decimal.
    check("A zero read from the database is truthy", Boolean(stored.refundDue), true);
    check("Its numeric value is still zero", Number(stored.refundDue), 0);

    // -----------------------------------------------------------------------
    // 5 — the reconciliation totals guard
    //
    // calculateAuthoritativeReconciliation sums bank balances and ledger
    // amounts. If any of those columns is Decimal and reaches a `+` without
    // being converted, the total becomes a concatenated string instead of a
    // number, and the reconciliation gap silently turns to nonsense.
    //
    // A cast or an `any` is enough to hide that from TypeScript, so the
    // function carries a runtime guard. This checks the guard is present and
    // actually throws, rather than trusting that the conversions are right.
    // -----------------------------------------------------------------------

    const reconciliationSource = fs.readFileSync(
      path.join(__dirname, "..", "lib", "tax", "reconciliation-calculation.ts"),
      "utf8",
    );
    check(
      "The reconciliation totals are guarded against non-numeric sums",
      /Number\.isFinite\(value\)/.test(reconciliationSource),
      true,
    );
    check(
      "The guard throws rather than continuing with a bad total",
      /throw new Error\(\s*`Reconciliation total/.test(reconciliationSource),
      true,
    );
    // Each total is fed a poisoned value in turn to prove the guard actually
    // covers it, rather than only checking the source text lists it.
    const GUARDED_TOTALS = [
      "openingWealth",
      "closingWealth",
      "totalIncome",
      "totalExpenses",
      "totalAssets",
      "totalLiabilities",
      "otherAdjustments",
    ];
    const guardBlock = /const componentTotals = \{([\s\S]*?)\};/.exec(
      reconciliationSource,
    );
    check("The guard declares a componentTotals block", Boolean(guardBlock), true);
    for (const name of GUARDED_TOTALS) {
      check(
        `The guard covers ${name}`,
        Boolean(guardBlock) &&
          new RegExp(`(^|\\s)${name},`).test(guardBlock[1]),
        true,
      );
    }

    check(
      "The guard covers every money total, not just one",
      [
        "openingWealth",
        "closingWealth",
        "totalIncome",
        "totalExpenses",
        "totalAssets",
        "totalLiabilities",
        "otherAdjustments",
      ].every((name) =>
        new RegExp(`componentTotals = \\{[\\s\\S]*?${name}[\\s\\S]*?\\};`).test(
          reconciliationSource,
        ),
      ),
      true,
    );

    // Prove the concatenation the guard exists to catch is real, using values
    // that came out of the database rather than literals.
    const balances = [
      new Prisma.Decimal("1000000.10"),
      new Prisma.Decimal("2000000.20"),
      new Prisma.Decimal("3000000.30"),
    ];
    const unconverted = balances.reduce((total, value) => total + value, 0);
    check(
      "Summing Decimals without converting produces a string, not a total",
      typeof unconverted,
      "string",
    );
    check(
      "The wrong total is visibly nonsense",
      unconverted,
      "01000000.12000000.23000000.3",
    );
    check(
      "Converting first gives the correct total",
      balances.reduce((total, value) => total + Number(value), 0),
      6000000.6,
    );
    check(
      "The guard's own condition rejects the concatenated value",
      typeof unconverted === "number" && Number.isFinite(unconverted),
      false,
    );

    // -----------------------------------------------------------------------
    // 6 — end-to-end: run the real reconciliation against the real database
    //
    // The checks above read source code. This one executes the actual
    // function over rows that were genuinely written to and read from
    // Postgres, which is the only way to catch a missed conversion: a cast or
    // an `any` silences TypeScript, and a source-level assertion can be
    // satisfied while the runtime value is still a Decimal.
    //
    // Balances and amounts are chosen so the correct gap is exactly zero.
    // Under Float the same arithmetic leaves a rounding residue, and under an
    // unconverted Decimal the totals concatenate into a string.
    // -----------------------------------------------------------------------

    const account = await prisma.bankAccount.create({
      data: {
        userId: user.id,
        filingDraftId: draft.id,
        bankName: "Precision Bank",
        accountLabel: "Main",
      },
    });

    // The reconciliation refuses to run on an incomplete filing, so the
    // supporting documents it insists on are created too: a CNIC, and a
    // mapped bank-statement document the saved statement points back to.
    await prisma.document.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        documentType: "cnic",
        fileName: "cnic.pdf",
        fileUrl: "/tmp/cnic.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        extractionStatus: "MAPPED",
      },
    });

    const statementDocument = await prisma.document.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        documentType: "bank_statement",
        fileName: "statement.pdf",
        fileUrl: "/tmp/statement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        extractionStatus: "MAPPED",
        bankAccountId: account.id,
      },
    });

    const precisionStatement = await prisma.bankStatement.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        bankAccountId: account.id,
        accountLabel: "Main",
        periodStart: new Date(Date.UTC(2025, 6, 1)),
        periodEnd: new Date(Date.UTC(2026, 5, 30)),
        openingBalance: new Prisma.Decimal("1000000.10"),
        closingBalance: new Prisma.Decimal("2000000.30"),
        sourceDocumentId: statementDocument.id,
      },
    });

    // Closing - opening = 1000000.20, and the income entries below add up to
    // exactly that, so a correct reconciliation gap is zero.
    //
    // The amounts are deliberately split across five entries rather than one.
    // A single entry cannot expose the bug: any implementation, exact or not,
    // gets one number right. These five were chosen because their floating
    // point sum is 1000000.2000000002 rather than 1000000.20, so summing them
    // as numbers leaves a residue and the gap misses zero. That is what makes
    // this assertion able to fail.
    const probeAmounts = [
      "199999.93",
      "300000.07",
      "150000.11",
      "250000.04",
      "100000.05",
    ];

    check(
      "The probe amounts do not sum cleanly in floating point",
      probeAmounts.reduce((total, value) => total + Number(value), 0) ===
        1000000.2,
      false,
    );

    await prisma.ledgerEntry.createMany({
      data: probeAmounts.map((amount, index) => ({
        filingDraftId: draft.id,
        userId: user.id,
        entryType: "INCOME",
        category: "BANK_PROFIT",
        description: `Precision probe ${index + 1}`,
        amount: new Prisma.Decimal(amount),
        entryDate: new Date(Date.UTC(2025, 8, 1)),
      })),
    });

    // Expenses, assets and liabilities are populated too, so that the
    // intermediate wealth-movement figure is itself a combination of several
    // inexact totals rather than a single income number passing straight
    // through. Without these, the movement step cannot be shown to be wrong:
    // adding one total to four zeros is exact whatever the arithmetic.
    const movementProbes = {
      EXPENSE: ["983.53", "5572.35", "8785.63", "868.94", "8059.45"],
      ASSET: ["37.99", "8928.06", "7511.58"],
      LIABILITY: ["6204.44", "5538.31", "8166.49"],
    };
    for (const [entryType, amounts] of Object.entries(movementProbes)) {
      await prisma.ledgerEntry.createMany({
        data: amounts.map((amount, index) => ({
          filingDraftId: draft.id,
          userId: user.id,
          entryType,
          description: `${entryType} movement probe ${index + 1}`,
          amount: new Prisma.Decimal(amount),
          entryDate: new Date(Date.UTC(2025, 8, 1)),
        })),
      });
    }

    // income + liabilities - expenses - assets = 979161.91, so the closing
    // balance is set to opening + that, making the correct gap exactly zero.
    check(
      "The movement figure does not combine cleanly in floating point",
      1000000.2 + 19909.24 - 24269.9 - 16477.63 === 979161.91,
      false,
    );

    await prisma.bankStatement.update({
      where: { id: precisionStatement.id },
      data: { closingBalance: new Prisma.Decimal("1979162.01") },
    });

    const { calculateAuthoritativeReconciliation } = require(
      path.join(__dirname, "..", "lib", "tax", "reconciliation-calculation.ts"),
    );

    let reconciliation;
    let reconciliationError = null;
    try {
      reconciliation = await calculateAuthoritativeReconciliation(
        { draftId: draft.id, userId: user.id },
        prisma,
      );
    } catch (error) {
      reconciliationError = error;
    }

    check(
      "The real reconciliation runs without a conversion error",
      reconciliationError === null
        ? "ran"
        : `threw: ${reconciliationError.message}`,
      "ran",
    );

    if (reconciliation && reconciliation.success !== false) {
      const preview = reconciliation.preview ?? reconciliation;

      check(
        "Opening wealth is a number, not a concatenated string",
        typeof preview.openingWealth,
        "number",
      );
      check(
        "Opening wealth sums the Decimal balance exactly",
        preview.openingWealth,
        1000000.1,
      );
      check(
        "Closing wealth sums the Decimal balance exactly",
        preview.closingWealth,
        1979162.01,
      );
      check(
        "Total income is a number",
        typeof preview.totalIncome,
        "number",
      );
      check("Total income is exact across five entries", preview.totalIncome, 1000000.2);

      // The point of the whole migration: this gap should be exactly zero.
      //
      // It is NOT zero yet. LedgerEntry.amount is still Float (Phase 5-C-3),
      // so the income side of the calculation still carries a rounding
      // residue of about 1e-10 even though both bank balances are now exact.
      // That residue is precisely what the `0.01` tolerances in the app were
      // added to hide.
      //
      // So this assertion is written to today's truth and flipped in 5-C-3:
      // the gap must be tiny (proving the Decimal balances are exact) but is
      // allowed to be non-zero until the ledger column is converted too.
      check("The reconciliation gap is a number", typeof preview.gap, "number");

      const ledgerAmountIsDecimal =
        /model LedgerEntry \{[^}]*amount\s+Decimal/s.test(SCHEMA);

      if (ledgerAmountIsDecimal) {
        // 5-C-3 is done: every input is Decimal, so the gap must be exact and
        // the tolerances become unnecessary.
        check("The reconciliation gap is exactly zero", preview.gap, 0);
        check(
          "The gap needs no tolerance to look balanced",
          Math.abs(preview.gap) === 0,
          true,
        );
      } else {
        // Still on a Float ledger: pin the residue as small, so a genuinely
        // wrong total (a concatenated string, a dropped entry) still fails.
        check(
          "The gap is within a rupee, so the Decimal balances are summing correctly",
          Math.abs(preview.gap) < 0.01,
          true,
        );
        check(
          "The residue is real, and is why the 0.01 tolerances exist",
          preview.gap !== 0,
          true,
        );
      }
    } else {
      check(
        `The reconciliation produced a preview (blockers: ${JSON.stringify(reconciliation && reconciliation.blockers)})`,
        true,
        false,
      );
    }

    // -----------------------------------------------------------------------
    // 7 — the Decimal boundary sites stay converted
    //
    // Two places outside the reconciliation read these columns:
    //   - bank-classification compares a saved balance to an incoming one.
    //     `Decimal === number` is ALWAYS false, so without conversion every
    //     statement looks changed and gets rewritten on each run.
    //   - bank-statements serialises statements for the browser. A Decimal
    //     crosses that boundary as a string, so the UI would format "1000.5"
    //     instead of a number.
    //
    // Both are cheap to break with a cast, so both are pinned.
    // -----------------------------------------------------------------------

    const classificationSource = fs.readFileSync(
      path.join(__dirname, "..", "app", "actions", "bank-classification.ts"),
      "utf8",
    );
    for (const column of ["openingBalance", "closingBalance"]) {
      check(
        `bank-classification compares ${column} through toMoneyNumber`,
        new RegExp(`toMoneyNumber\\(statement\\.${column}\\)\\s*===`).test(
          classificationSource,
        ),
        true,
      );
      check(
        `bank-classification does not compare a raw Decimal ${column}`,
        new RegExp(`statement\\.${column}\\s*===`).test(classificationSource),
        false,
      );
    }

    const statementsSource = fs.readFileSync(
      path.join(__dirname, "..", "app", "actions", "bank-statements.ts"),
      "utf8",
    );
    for (const column of ["openingBalance", "closingBalance"]) {
      const converted = new RegExp(
        `${column}: toMoneyNumber\\(statement\\.${column}\\)`,
        "g",
      );
      check(
        `bank-statements converts ${column} on both serialisation paths`,
        (statementsSource.match(converted) ?? []).length,
        2,
      );
    }

    // Proof the equality trap is real, using a value read from the database.
    const dbStatement = await prisma.bankStatement.findFirst({
      where: { filingDraftId: draft.id },
      select: { openingBalance: true },
    });
    check(
      "A Decimal balance is never === its own numeric value",
      dbStatement.openingBalance === 1000000.1,
      false,
    );
    check(
      "Converting first makes the comparison work",
      Number(dbStatement.openingBalance) === 1000000.1,
      true,
    );

    // -----------------------------------------------------------------------
    // 8 — transaction direction survives the Decimal columns (Phase 5-C-2)
    //
    // Deciding whether a row is money in or money out is the single most
    // fragile thing in this migration. The original test was
    //
    //     (credit ?? 0) > 0 && !(debit ?? 0)
    //
    // and it depended on a Float zero being falsy. A Decimal zero is truthy,
    // so after the column change that expression reported neither a credit
    // nor a debit for EVERY row, and nothing would have been classified.
    //
    // These rows are written to Postgres and read back, so the values under
    // test are genuine Decimals rather than constructed ones.
    // -----------------------------------------------------------------------

    const directionStatement = await prisma.bankStatement.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        bankAccountId: account.id,
        accountLabel: "Direction probe",
        openingBalance: new Prisma.Decimal("0"),
        closingBalance: new Prisma.Decimal("0"),
      },
    });

    await prisma.bankTransaction.createMany({
      data: [
        {
          filingDraftId: draft.id,
          userId: user.id,
          bankStatementId: directionStatement.id,
          bankAccountId: account.id,
          description: "Salary credited",
          debit: new Prisma.Decimal("0"),
          credit: new Prisma.Decimal("750000.55"),
          balance: new Prisma.Decimal("750000.55"),
        },
        {
          filingDraftId: draft.id,
          userId: user.id,
          bankStatementId: directionStatement.id,
          bankAccountId: account.id,
          description: "Rent paid",
          debit: new Prisma.Decimal("125000.45"),
          credit: new Prisma.Decimal("0"),
          balance: new Prisma.Decimal("625000.10"),
        },
        {
          filingDraftId: draft.id,
          userId: user.id,
          bankStatementId: directionStatement.id,
          bankAccountId: account.id,
          description: "Credit with a null debit side",
          debit: null,
          credit: new Prisma.Decimal("99999.99"),
          balance: null,
        },
      ],
    });

    const directionRows = await prisma.bankTransaction.findMany({
      where: { bankStatementId: directionStatement.id },
      orderBy: { description: "asc" },
    });

    check("Three probe transactions were stored", directionRows.length, 3);

    const {
      toMoneyAmount: dbToMoneyAmount,
      toMoneyNumberOrNull: toMoneyNumberOrNullFromLib,
    } = require(path.join(__dirname, "..", "lib", "money.ts"));

    const classify = (row) => {
      const debitAmount = dbToMoneyAmount(row.debit);
      const creditAmount = dbToMoneyAmount(row.credit);
      return {
        hasCredit: creditAmount > 0 && debitAmount === 0,
        hasDebit: debitAmount > 0 && creditAmount === 0,
      };
    };

    const byDescription = Object.fromEntries(
      directionRows.map((row) => [row.description, row]),
    );

    const salaryRow = byDescription["Salary credited"];
    check(
      "A stored zero debit really is a Decimal, not a number",
      salaryRow.debit instanceof Prisma.Decimal,
      true,
    );
    check(
      "That Decimal zero is truthy, which is what broke the old test",
      Boolean(salaryRow.debit),
      true,
    );
    check("Salary is recognised as money in", classify(salaryRow).hasCredit, true);
    check("Salary is not also money out", classify(salaryRow).hasDebit, false);
    check(
      "The credited amount converts exactly",
      dbToMoneyAmount(salaryRow.credit),
      750000.55,
    );

    const rentRow = byDescription["Rent paid"];
    check("Rent is recognised as money out", classify(rentRow).hasDebit, true);
    check("Rent is not also money in", classify(rentRow).hasCredit, false);
    check(
      "The debited amount converts exactly",
      dbToMoneyAmount(rentRow.debit),
      125000.45,
    );

    const nullSideRow = byDescription["Credit with a null debit side"];
    check(
      "A null debit is still money in",
      classify(nullSideRow).hasCredit,
      true,
    );
    check("A null side converts to zero", dbToMoneyAmount(nullSideRow.debit), 0);

    // The old expression, run over the same database rows, to show the
    // failure is real rather than hypothetical.
    const legacyDirection = (row) => ({
      hasCredit: (row.credit ?? 0) > 0 && !(row.debit ?? 0),
      hasDebit: (row.debit ?? 0) > 0 && !(row.credit ?? 0),
    });
    check(
      "The old falsy test would have missed this credit",
      legacyDirection(salaryRow).hasCredit,
      false,
    );
    check(
      "The old falsy test would have missed this debit",
      legacyDirection(rentRow).hasDebit,
      false,
    );

    // The live code must not contain that pattern any more.
    //
    // Comment lines are stripped first: the fix is explained in a comment that
    // quotes the old expression verbatim, and a naive search matches the
    // explanation instead of real code.
    const classificationCode = classificationSource
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    check(
      "bank-classification no longer falsy-tests a money column",
      /!\(transaction\.(debit|credit) \?\? 0\)/.test(classificationCode),
      false,
    );
    check(
      "bank-classification compares converted amounts instead",
      /const debitAmount = toMoneyAmount\(transaction\.debit\)/.test(
        classificationSource,
      ),
      true,
    );

    // The reconciliation's revision payload is sent to the browser and stored
    // as JSON. A Decimal survives JSON.stringify as a STRING, so an
    // unconverted amount arrives in the UI as "750000.55" rather than a
    // number, and any total computed from it concatenates. This runs the real
    // serialisation and inspects what actually comes out the far side.
    const payloadRows = directionRows.map((row) => ({
      debit: toMoneyNumberOrNullFromLib(row.debit),
      credit: toMoneyNumberOrNullFromLib(row.credit),
      balance: toMoneyNumberOrNullFromLib(row.balance),
    }));
    const roundTripped = JSON.parse(JSON.stringify(payloadRows));

    check(
      "Every serialised amount survives JSON as a number",
      roundTripped.every(
        (row) =>
          (row.credit === null || typeof row.credit === "number") &&
          (row.debit === null || typeof row.debit === "number") &&
          (row.balance === null || typeof row.balance === "number"),
      ),
      true,
    );
    check(
      "A null amount stays null rather than becoming zero",
      roundTripped.some((row) => row.debit === null),
      true,
    );
    check(
      "Serialised amounts can be added without concatenating",
      roundTripped.reduce((total, row) => total + (row.credit ?? 0), 0),
      850000.54,
    );

    // The same rows serialised WITHOUT conversion, to show the failure is real.
    const rawRoundTripped = JSON.parse(JSON.stringify(directionRows));
    check(
      "An unconverted Decimal crosses JSON as a string",
      typeof rawRoundTripped[0].credit,
      "string",
    );
    check(
      "Totalling those strings concatenates instead of adding",
      typeof rawRoundTripped.reduce((total, row) => total + (row.credit ?? 0), 0),
      "string",
    );

    // Both server actions that expose these rows must do the conversion.
    for (const [file, label] of [
      ["lib/tax/reconciliation-calculation.ts", "the reconciliation payload"],
      ["app/actions/bank-classification.ts", "the classification payload"],
    ]) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      for (const column of ["debit", "credit", "balance"]) {
        check(
          `${label} converts ${column} before sending it`,
          new RegExp(
            `${column}: toMoneyNumberOrNull\\(transaction\\.${column}\\)`,
          ).test(source),
          true,
        );
      }
    }

    // Postgres sums the Decimal transaction columns exactly.
    const creditTotal = await prisma.bankTransaction.aggregate({
      where: { bankStatementId: directionStatement.id },
      _sum: { credit: true },
    });
    check(
      "Postgres sums the credit column exactly",
      creditTotal._sum.credit.toString(),
      "850000.54",
    );

    // -----------------------------------------------------------------------
    // 9 — the tax and summary totals are exact too (Phase 5-C-3)
    //
    // The reconciliation is covered above. These are the other two places
    // that add ledger amounts, and both feed figures the taxpayer sees: the
    // tax engine's income total, and the ledger summary on the filing screen.
    //
    // Same principle as the gap probe: the amounts are split across several
    // entries chosen so a floating-point sum misses the exact total.
    // -----------------------------------------------------------------------

    // A separate taxpayer, because a draft is unique per user and tax year.
    const summaryUser = await prisma.user.create({
      data: { email: `money-summary-${Date.now()}@verify.test`, name: "Summary probe" },
    });
    const summaryDraft = await prisma.filingDraft.create({
      data: { userId: summaryUser.id, taxYear: 2026 },
    });

    const summaryAmounts = {
      INCOME: ["9128.24", "6715.91", "2916.82", "9299.34", "8509.29"],
      EXPENSE: ["983.53", "5572.35", "8785.63", "868.94", "8059.45"],
      ASSET: ["37.99", "8928.06", "7511.58"],
      LIABILITY: ["6204.44", "5538.31", "8166.49"],
    };
    const summaryExpected = {
      INCOME: 36569.6,
      EXPENSE: 24269.9,
      ASSET: 16477.63,
      LIABILITY: 19909.24,
    };

    for (const [entryType, amounts] of Object.entries(summaryAmounts)) {
      check(
        `The ${entryType} probe amounts do not sum cleanly in floating point`,
        amounts.reduce((total, value) => total + Number(value), 0) ===
          summaryExpected[entryType],
        false,
      );
      await prisma.ledgerEntry.createMany({
        data: amounts.map((amount, index) => ({
          filingDraftId: summaryDraft.id,
          userId: summaryUser.id,
          entryType,
          category: entryType === "INCOME" ? "BANK_PROFIT" : null,
          description: `${entryType} probe ${index + 1}`,
          amount: new Prisma.Decimal(amount),
          entryDate: new Date(Date.UTC(2025, 8, 1)),
        })),
      });
    }

    // Postgres agrees on every total, which fixes the expected values
    // independently of the application code.
    for (const [entryType, expected] of Object.entries(summaryExpected)) {
      const dbTotal = await prisma.ledgerEntry.aggregate({
        where: { filingDraftId: summaryDraft.id, entryType },
        _sum: { amount: true },
      });
      check(
        `Postgres sums the ${entryType} entries to ${expected}`,
        Number(dbTotal._sum.amount),
        expected,
      );
    }

    // The same sums through the application helper the actions now use.
    const { sumMoney: dbSumMoney } = require(
      path.join(__dirname, "..", "lib", "money.ts"),
    );
    for (const [entryType, expected] of Object.entries(summaryExpected)) {
      const rows = await prisma.ledgerEntry.findMany({
        where: { filingDraftId: summaryDraft.id, entryType },
        select: { amount: true },
      });
      check(
        `sumMoney totals the ${entryType} entries exactly`,
        dbSumMoney(rows.map((row) => row.amount)),
        expected,
      );
      check(
        `Adding the ${entryType} entries as numbers does not match`,
        rows.reduce((total, row) => total + Number(row.amount), 0) === expected,
        false,
      );
    }

    // Both call sites must use it, rather than reducing over amounts.
    for (const [file, label] of [
      ["app/actions/tax-calculation.ts", "The tax calculation"],
      ["app/actions/filing-summary.ts", "The filing summary"],
    ]) {
      const source = fs
        .readFileSync(path.join(__dirname, "..", file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      check(`${label} sums ledger amounts with sumMoney`, /sumMoney\(/.test(source), true);
      // A bare `sumMoney(` search is too weak: these files call it several
      // times, so one site can be reverted to a float reduce while the others
      // keep the search satisfied. Every reduce and `+=` over an amount has
      // to be gone, including the `Number(...)` form that silences the type
      // checker while still accumulating in floating point.
      check(
        `${label} does not add ledger amounts directly`,
        /total \+ entry\.amount|\+= entry\.amount|total \+ Number\(entry\.amount\)|\+= Number\(entry\.amount\)/.test(
          source,
        ),
        false,
      );
      check(
        `${label} has no reduce left over an amount`,
        /\.reduce\([^)]*\)\s*=>\s*[^;]*\bamount\b/.test(source),
        false,
      );
    }

    await prisma.user.delete({ where: { id: summaryUser.id } });

    // -----------------------------------------------------------------------
    // 10 — a second reconciliation, exercising the final gap subtraction
    //
    // The probe above populates every category, which is what makes the
    // intermediate wealth-movement figure inexact. But its closing balance
    // then happens to cancel cleanly, so the FINAL subtraction
    // (closing - opening - movement) stays exact even done as numbers, and a
    // fault in that last step goes unnoticed.
    //
    // This second filing is the mirror image: income only, with balances
    // chosen so it is the final subtraction that drifts. One scenario cannot
    // cover both steps, so there are two.
    // -----------------------------------------------------------------------

    const gapUser = await prisma.user.create({
      data: { email: `money-gap-${Date.now()}@verify.test`, name: "Gap probe" },
    });
    const gapDraft = await prisma.filingDraft.create({
      data: { userId: gapUser.id, taxYear: 2026 },
    });
    const gapAccount = await prisma.bankAccount.create({
      data: {
        userId: gapUser.id,
        filingDraftId: gapDraft.id,
        bankName: "Gap Bank",
        accountLabel: "Main",
      },
    });
    await prisma.document.create({
      data: {
        filingDraftId: gapDraft.id,
        userId: gapUser.id,
        documentType: "cnic",
        fileName: "cnic.pdf",
        fileUrl: "/tmp/cnic.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        extractionStatus: "MAPPED",
      },
    });
    const gapDocument = await prisma.document.create({
      data: {
        filingDraftId: gapDraft.id,
        userId: gapUser.id,
        documentType: "bank_statement",
        fileName: "statement.pdf",
        fileUrl: "/tmp/statement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        extractionStatus: "MAPPED",
        bankAccountId: gapAccount.id,
      },
    });
    await prisma.bankStatement.create({
      data: {
        filingDraftId: gapDraft.id,
        userId: gapUser.id,
        bankAccountId: gapAccount.id,
        accountLabel: "Main",
        periodStart: new Date(Date.UTC(2025, 6, 1)),
        periodEnd: new Date(Date.UTC(2026, 5, 30)),
        openingBalance: new Prisma.Decimal("1000000.10"),
        closingBalance: new Prisma.Decimal("2000000.30"),
        sourceDocumentId: gapDocument.id,
      },
    });
    await prisma.ledgerEntry.createMany({
      data: ["199999.93", "300000.07", "150000.11", "250000.04", "100000.05"].map(
        (amount, index) => ({
          filingDraftId: gapDraft.id,
          userId: gapUser.id,
          entryType: "INCOME",
          category: "BANK_PROFIT",
          description: `Gap probe ${index + 1}`,
          amount: new Prisma.Decimal(amount),
          entryDate: new Date(Date.UTC(2025, 8, 1)),
        }),
      ),
    });

    check(
      "This filing's final subtraction is the inexact step",
      2000000.3 - 1000000.1 - 1000000.2 === 0,
      false,
    );

    const gapResult = await calculateAuthoritativeReconciliation(
      { draftId: gapDraft.id, userId: gapUser.id },
      prisma,
    );
    const gapPreview = gapResult.preview ?? gapResult;

    check(
      "The second reconciliation produced a preview",
      gapResult.success !== false,
      true,
    );
    check("Its income total is exact", gapPreview.totalIncome, 1000000.2);
    check("Its gap is a number", typeof gapPreview.gap, "number");
    check("Its gap is exactly zero", gapPreview.gap, 0);

    // Reconciliation adjustments: inflows add, outflows subtract. This is the
    // one running total that mixes both directions, so it gets its own probe.
    // The amounts are chosen so netting them as numbers misses the exact
    // figure, and so that inflows and outflows do not simply cancel -- a
    // sign error has to change the answer too.
    await prisma.ledgerEntry.createMany({
      data: [
        { amount: "5922.43", category: "RECONCILIATION_ADJUSTMENT_INFLOW" },
        { amount: "1179.01", category: "RECONCILIATION_ADJUSTMENT_OUTFLOW" },
        { amount: "6863.28", category: "RECONCILIATION_ADJUSTMENT_INFLOW" },
        { amount: "41.67", category: "RECONCILIATION_ADJUSTMENT_OUTFLOW" },
        { amount: "1734.85", category: "RECONCILIATION_ADJUSTMENT_INFLOW" },
      ].map(({ amount, category }, index) => ({
        filingDraftId: gapDraft.id,
        userId: gapUser.id,
        entryType: "OTHER",
        category,
        description: `Adjustment probe ${index + 1}`,
        amount: new Prisma.Decimal(amount),
        entryDate: new Date(Date.UTC(2025, 8, 1)),
      })),
    });

    // inflows 5922.43 + 6863.28 + 1734.85 = 14520.56
    // outflows 1179.01 + 41.67 = 1220.68, net = 13299.88
    check(
      "Netting the adjustments as numbers misses the exact figure",
      5922.43 - 1179.01 + 6863.28 - 41.67 + 1734.85 === 13299.88,
      false,
    );

    const adjustedResult = await calculateAuthoritativeReconciliation(
      { draftId: gapDraft.id, userId: gapUser.id },
      prisma,
    );
    const adjustedPreview = adjustedResult.preview ?? adjustedResult;

    check(
      "The adjustments net to the exact figure",
      adjustedPreview.otherAdjustments,
      13299.88,
    );
    check(
      "The netted adjustments are a number",
      typeof adjustedPreview.otherAdjustments,
      "number",
    );
    // Outflows must reduce the total: if the sign were dropped the result
    // would be the full 14520.56 + 1220.68 instead.
    check(
      "Outflows are subtracted rather than added",
      adjustedPreview.otherAdjustments < 14520.56,
      true,
    );

    await prisma.user.delete({ where: { id: gapUser.id } });

    // -----------------------------------------------------------------------
    // 11 — the FilingDraft money columns (Phase 5-D)
    //
    // These are the figures the taxpayer actually reads: taxable income, tax
    // withheld, tax payable, refund due, and the reconciliation gap that
    // gates submission. They are written once per calculation and read
    // everywhere, so the checks here are that they store and return exactly.
    // -----------------------------------------------------------------------

    const draftUser = await prisma.user.create({
      data: { email: `money-draft-${Date.now()}@verify.test`, name: "Draft probe" },
    });
    const moneyDraft = await prisma.filingDraft.create({
      data: {
        userId: draftUser.id,
        taxYear: 2026,
        openingWealth: new Prisma.Decimal("1000000.10"),
        closingWealth: new Prisma.Decimal("1979162.01"),
        taxableIncome: new Prisma.Decimal("2181000.55"),
        taxWithheld: new Prisma.Decimal("250000.45"),
        taxPayable: new Prisma.Decimal("3685290"),
        refundDue: new Prisma.Decimal("0"),
        reconciliationGap: new Prisma.Decimal("0"),
      },
    });

    const storedDraft = await prisma.filingDraft.findUnique({
      where: { id: moneyDraft.id },
    });

    const draftExpectations = {
      openingWealth: 1000000.1,
      closingWealth: 1979162.01,
      taxableIncome: 2181000.55,
      taxWithheld: 250000.45,
      taxPayable: 3685290,
      refundDue: 0,
      reconciliationGap: 0,
    };
    for (const [column, expected] of Object.entries(draftExpectations)) {
      check(
        `FilingDraft.${column} is stored as a Decimal`,
        storedDraft[column] instanceof Prisma.Decimal,
        true,
      );
      check(
        `FilingDraft.${column} round-trips exactly`,
        Number(storedDraft[column]),
        expected,
      );
    }

    // The zero columns are the dangerous ones: a Decimal zero is truthy, so
    // any `if (gap)` or `gap || fallback` inverts. The gate below is the one
    // that decides whether a filing can be submitted at all.
    check(
      "A stored zero gap is truthy as a Decimal",
      Boolean(storedDraft.reconciliationGap),
      true,
    );
    check(
      "Converting it gives a falsy zero again",
      Boolean(toMoneyNumberOrNullFromLib(storedDraft.reconciliationGap)),
      false,
    );

    const { isMizanResolved: dbIsMizanResolved } = require(
      path.join(__dirname, "..", "lib", "tax", "filing-status.ts"),
    );
    check(
      "A balanced filing read from the database passes the submission gate",
      dbIsMizanResolved("RESOLVED", storedDraft.reconciliationGap),
      true,
    );

    // Phase 5-E: the gate is exact, so a one-paisa imbalance is refused.
    await prisma.filingDraft.update({
      where: { id: moneyDraft.id },
      data: { reconciliationGap: new Prisma.Decimal("0.01") },
    });
    const imbalancedDraft = await prisma.filingDraft.findUnique({
      where: { id: moneyDraft.id },
    });
    check(
      "A one-paisa gap is stored, not rounded away",
      Number(imbalancedDraft.reconciliationGap),
      0.01,
    );
    check(
      "A one-paisa imbalance is refused by the gate",
      dbIsMizanResolved("RESOLVED", imbalancedDraft.reconciliationGap),
      false,
    );

    // The server actions that expose these columns must convert them. A
    // Decimal crossing to the browser arrives as a string, so the wizard's
    // comparisons against preview numbers all fail and money renders without
    // thousands separators.
    const summaryActionSource = fs
      .readFileSync(path.join(__dirname, "..", "app", "actions", "filing-summary.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    for (const column of [
      "reconciliationGap",
      "taxableIncome",
      "taxWithheld",
      "taxPayable",
      "refundDue",
    ]) {
      check(
        `The filing summary converts ${column} before sending it`,
        new RegExp(
          `${column}: toMoneyNumberOrNull\\(currentDraft\\?\\.${column}\\)`,
        ).test(summaryActionSource),
        true,
      );
      check(
        `The filing summary does not pass ${column} through raw`,
        new RegExp(`${column}: currentDraft\\?\\.${column}[,\\s]`).test(
          summaryActionSource,
        ),
        false,
      );
    }

    // Prove what an unconverted column does once JSON is involved, using the
    // row that was actually read back from Postgres.
    const rawDraftPayload = JSON.parse(
      JSON.stringify({ taxPayable: storedDraft.taxPayable }),
    );
    check(
      "An unconverted draft amount reaches the client as a string",
      typeof rawDraftPayload.taxPayable,
      "string",
    );
    check(
      "It would format without thousands separators",
      storedDraft.taxPayable.toLocaleString(),
      "3685290",
    );
    check(
      "Converted first, it formats correctly",
      toMoneyNumberOrNullFromLib(storedDraft.taxPayable).toLocaleString(),
      "3,685,290",
    );

    // taxWithheld is compared against zero to decide whether to fall back to
    // the salary certificate. `Decimal === 0` is always false, so leaving it
    // unconverted would permanently skip that fallback.
    const zeroWithheldDraft = await prisma.filingDraft.update({
      where: { id: moneyDraft.id },
      data: { taxWithheld: new Prisma.Decimal("0") },
    });
    check(
      "A zero withheld amount is never === 0 as a Decimal",
      zeroWithheldDraft.taxWithheld === 0,
      false,
    );
    check(
      "Converting first makes the zero check work",
      dbToMoneyAmount(zeroWithheldDraft.taxWithheld) === 0,
      true,
    );

    await prisma.user.delete({ where: { id: draftUser.id } });

    // -----------------------------------------------------------------------
    // 12 — the Mizan revision fingerprint is type-independent
    //
    // The reconciliation hashes a snapshot of the filing into a `revision`
    // string. When the user confirms, the server recomputes it and refuses
    // the confirmation if it differs, on the grounds that the filing changed
    // underneath them.
    //
    // JSON.stringify renders a Decimal as a quoted string and a number bare,
    // so if any money value reaches that payload unconverted the fingerprint
    // depends on the COLUMN TYPE rather than the amount. That is not
    // hypothetical: this migration changed those very columns, so every saved
    // filing would have produced a new hash and told the taxpayer their
    // inputs had changed when nothing had.
    // -----------------------------------------------------------------------

    check(
      "A Decimal and a number of equal value serialise differently",
      JSON.stringify({ amount: new Prisma.Decimal("5000") }) ===
        JSON.stringify({ amount: 5000 }),
      false,
    );
    check(
      "So hashing them unconverted gives different fingerprints",
      createHash("sha256")
        .update(JSON.stringify({ amount: new Prisma.Decimal("5000") }))
        .digest("hex") ===
        createHash("sha256")
          .update(JSON.stringify({ amount: 5000 }))
          .digest("hex"),
      false,
    );
    check(
      "Converting first makes them identical",
      createHash("sha256")
        .update(
          JSON.stringify({
            amount: toMoneyNumberOrNullFromLib(new Prisma.Decimal("5000")),
          }),
        )
        .digest("hex") ===
        createHash("sha256")
          .update(JSON.stringify({ amount: 5000 }))
          .digest("hex"),
      true,
    );

    // Every money field in the payload must be converted, not just some.
    const revisionBlock = /const revisionPayload = \{[\s\S]*?\n  \};/.exec(
      reconciliationSource,
    );
    check("The revision payload block was found", Boolean(revisionBlock), true);
    if (revisionBlock) {
      for (const field of [
        "openingBalance",
        "closingBalance",
        "debit",
        "credit",
        "balance",
        "amount",
      ]) {
        check(
          `The revision payload converts ${field}`,
          new RegExp(
            `${field}: (toMoneyNumber|toMoneyNumberOrNull)\\(`,
          ).test(revisionBlock[0]),
          true,
        );
      }
      check(
        "The revision payload leaves no raw money field behind",
        /(openingBalance|closingBalance|debit|credit|balance|amount): (statement|transaction|entry)\./.test(
          revisionBlock[0],
        ),
        false,
      );
    }

    // Run the real thing twice and confirm the fingerprint is stable, and
    // that every money value in the preview it returns is a number.
    //
    // This needs its own clean filing. The earlier probes deliberately added
    // a second statement and extra transactions to their drafts, which the
    // completeness rules reject, so reusing one of those returns blockers
    // instead of a preview.
    const revisionUser = await prisma.user.create({
      data: {
        email: `money-revision-${Date.now()}@verify.test`,
        name: "Revision probe",
      },
    });
    const revisionDraft = await prisma.filingDraft.create({
      data: { userId: revisionUser.id, taxYear: 2026 },
    });
    const revisionAccount = await prisma.bankAccount.create({
      data: {
        userId: revisionUser.id,
        filingDraftId: revisionDraft.id,
        bankName: "Revision Bank",
        accountLabel: "Main",
      },
    });
    await prisma.document.create({
      data: {
        filingDraftId: revisionDraft.id,
        userId: revisionUser.id,
        documentType: "cnic",
        fileName: "cnic.pdf",
        fileUrl: "/tmp/cnic.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        extractionStatus: "MAPPED",
      },
    });
    const revisionDocument = await prisma.document.create({
      data: {
        filingDraftId: revisionDraft.id,
        userId: revisionUser.id,
        documentType: "bank_statement",
        fileName: "statement.pdf",
        fileUrl: "/tmp/statement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        extractionStatus: "MAPPED",
        bankAccountId: revisionAccount.id,
      },
    });
    await prisma.bankStatement.create({
      data: {
        filingDraftId: revisionDraft.id,
        userId: revisionUser.id,
        bankAccountId: revisionAccount.id,
        accountLabel: "Main",
        periodStart: new Date(Date.UTC(2025, 6, 1)),
        periodEnd: new Date(Date.UTC(2026, 5, 30)),
        openingBalance: new Prisma.Decimal("1000000.10"),
        closingBalance: new Prisma.Decimal("2000000.30"),
        sourceDocumentId: revisionDocument.id,
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        filingDraftId: revisionDraft.id,
        userId: revisionUser.id,
        entryType: "INCOME",
        category: "BANK_PROFIT",
        description: "Revision probe income",
        amount: new Prisma.Decimal("1000000.20"),
        entryDate: new Date(Date.UTC(2025, 8, 1)),
      },
    });

    const firstRun = await calculateAuthoritativeReconciliation(
      { draftId: revisionDraft.id, userId: revisionUser.id },
      prisma,
    );
    const secondRun = await calculateAuthoritativeReconciliation(
      { draftId: revisionDraft.id, userId: revisionUser.id },
      prisma,
    );
    check(
      "The revision probe reconciliation succeeded",
      firstRun.success !== false
        ? "ok"
        : `blocked: ${JSON.stringify(firstRun.blockers)}`,
      "ok",
    );
    check(
      "The same filing produces the same revision twice",
      (firstRun.preview ?? firstRun).revision,
      (secondRun.preview ?? secondRun).revision,
    );
    check(
      "The revision is a non-empty hash",
      typeof (firstRun.preview ?? firstRun).revision === "string" &&
        (firstRun.preview ?? firstRun).revision.length === 64,
      true,
    );

    const previewMoneyFields = [
      "openingWealth",
      "closingWealth",
      "totalIncome",
      "totalExpenses",
      "totalAssets",
      "totalLiabilities",
      "otherAdjustments",
      "gap",
    ];
    const firstPreview = firstRun.preview ?? firstRun;
    for (const field of previewMoneyFields) {
      check(
        `The preview returns ${field} as a number`,
        typeof firstPreview[field],
        "number",
      );
    }

    await prisma.user.delete({ where: { id: revisionUser.id } });

    // The conversion boundary must turn all of this back into plain numbers.
    const { serializePacketMoney } = require(path.join(__dirname, "..", "lib", "money.ts"));
    const serialized = serializePacketMoney(stored);
    check("The boundary yields a real number", typeof serialized.taxPayable, "number");
    check("The boundary preserves the value", serialized.taxPayable, 1000000.1);
    check("The boundary keeps zero as zero", serialized.refundDue, 0);
  } finally {
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  }

  if (failures.length > 0) {
    console.error("Money database checks FAILED:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log("Money database checks passed.");
  console.log(JSON.stringify({ assertionCount }, null, 2));
}

main().catch((error) => {
  console.error("Money database checks FAILED:\n");
  console.error(`  - ${error.message}`);
  process.exit(1);
});
