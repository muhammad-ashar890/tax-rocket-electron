/**
 * Several filings for one tax year.
 *
 * A taxpayer can file salary first and add another income source later, both
 * for the same tax year. The database used to allow ONE draft per user per
 * year, and saving a second filing overwrote the first: its approval was
 * reset, its income selections were replaced, and its approved packet stayed
 * attached to a draft that no longer described it.
 *
 * This suite pins the fix at three levels:
 *
 *   1. The pure decision helper (lib/tax/filing-draft-identity.ts).
 *   2. Source-level facts: the schema no longer declares the unique key, the
 *      migration drops it, the server never looks a draft up by that key, and
 *      the wizard sends the draft id with every snapshot.
 *   3. The REAL server actions run against a REAL PostgreSQL database (skipped
 *      cleanly when no database is reachable): a protected filing is never
 *      overwritten, an explicit draft id is honoured, concurrent creates do not
 *      duplicate, and another user's draft id is refused.
 *
 * Every row the database part creates belongs to throw-away users that are
 * deleted at the end (their drafts cascade with them).
 */

const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const Module = require("module");

const root = path.join(__dirname, "..");
let assertionCount = 0;
const failures = [];

function check(label, actual, expected) {
  assertionCount += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

/** Source without comment lines, so a comment cannot satisfy or break a check. */
function code(relativePath) {
  return read(relativePath)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// TypeScript loader plus the stubs the server actions need to run in Node.
// ---------------------------------------------------------------------------
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
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
    filename,
  );
};

let sessionEmail = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "next/cache") return { revalidatePath() {} };
  if (request === "next-auth/next") {
    return {
      getServerSession: async () =>
        sessionEmail ? { user: { email: sessionEmail, name: "Test" } } : null,
    };
  }
  if (request === "server-only") return {};
  if (request === "@/lib/auth" || request === path.join(root, "lib/auth")) {
    return { authOptions: {} };
  }
  return originalLoad.call(this, request, ...rest);
};

// ---------------------------------------------------------------------------
// 1. Pure helper
// ---------------------------------------------------------------------------
function runHelperChecks() {
  const {
    isProtectedFilingDraft,
    pickReusableDraft,
    numberFilingsPerYear,
    describeIncomeSources,
  } = require(path.join(root, "lib/tax/filing-draft-identity.ts"));

  check("a plain in-progress draft is not protected", isProtectedFilingDraft({ status: "IN_PROGRESS" }), false);
  check("an empty object is not protected", isProtectedFilingDraft({}), false);
  check("FILED is protected", isProtectedFilingDraft({ status: "FILED" }), true);
  check("APPROVED_FOR_FILING is protected", isProtectedFilingDraft({ status: "APPROVED_FOR_FILING" }), true);
  check("packetApprovalConfirmed protects", isProtectedFilingDraft({ status: "IN_PROGRESS", packetApprovalConfirmed: true }), true);
  check("an approved packet protects", isProtectedFilingDraft({ status: "IN_PROGRESS", filingPackets: [{ approvalStatus: "APPROVED" }] }), true);
  check("a pending packet does not protect", isProtectedFilingDraft({ status: "IN_PROGRESS", filingPackets: [{ approvalStatus: "PENDING" }] }), false);
  check("a completed real filing protects", isProtectedFilingDraft({ status: "IN_PROGRESS", fbrConnections: [{ status: "FILING_COMPLETED" }] }), true);
  for (const active of ["WAITING_FOR_AGENT", "CONNECTED", "SUBMITTING"]) {
    check(`a running FBR connection (${active}) protects`, isProtectedFilingDraft({ status: "IN_PROGRESS", fbrConnections: [{ status: active }] }), true);
  }
  check("a finished dry run does not protect", isProtectedFilingDraft({ status: "IN_PROGRESS", fbrConnections: [{ status: "DRY_RUN_COMPLETED" }] }), false);
  check("null relations are tolerated", isProtectedFilingDraft({ status: null, filingPackets: null, fbrConnections: null }), false);

  const day = (n) => new Date(Date.UTC(2026, 0, n));
  check("no drafts: nothing to reuse", pickReusableDraft([]), null);
  check(
    "only protected drafts: nothing to reuse",
    pickReusableDraft([
      { id: "a", status: "APPROVED_FOR_FILING", updatedAt: day(1) },
      { id: "b", status: "FILED", updatedAt: day(2) },
    ]),
    null,
  );
  check(
    "a protected draft is skipped even when it is the newest",
    pickReusableDraft([
      { id: "old", status: "IN_PROGRESS", updatedAt: day(1) },
      { id: "approved", status: "APPROVED_FOR_FILING", updatedAt: day(5) },
    ])?.id,
    "old",
  );
  check(
    "the most recently updated unprotected draft wins",
    pickReusableDraft([
      { id: "x", status: "IN_PROGRESS", updatedAt: day(2) },
      { id: "y", status: "IN_PROGRESS", updatedAt: day(9) },
      { id: "z", status: "IN_PROGRESS", updatedAt: day(4) },
    ])?.id,
    "y",
  );
  const input = [
    { id: "x", status: "IN_PROGRESS", updatedAt: day(2) },
    { id: "y", status: "IN_PROGRESS", updatedAt: day(9) },
  ];
  pickReusableDraft(input);
  check("the input array is not reordered", input.map((d) => d.id), ["x", "y"]);

  const numbering = numberFilingsPerYear([
    { id: "late", taxYear: 2026, createdAt: day(9) },
    { id: "early", taxYear: 2026, createdAt: day(1) },
    { id: "other-year", taxYear: 2025, createdAt: day(3) },
  ]);
  check("oldest same-year filing is number 1", numbering.get("early"), { position: 1, total: 2 });
  check("newer same-year filing is number 2", numbering.get("late"), { position: 2, total: 2 });
  check("a lone filing for its year has total 1", numbering.get("other-year"), { position: 1, total: 1 });

  check("income summary uses readable names", describeIncomeSources('["salary","business"]'), "Salary, Business income");
  check("income summary skips unknown sources and duplicates", describeIncomeSources('["salary","imports","salary"]'), "Salary");
  check("income summary tolerates bad JSON", describeIncomeSources("not json"), "");
  check("income summary tolerates null", describeIncomeSources(null), "");
  check("income summary tolerates a non-array", describeIncomeSources('{"a":1}'), "");
}

// ---------------------------------------------------------------------------
// 2. Source-level facts
// ---------------------------------------------------------------------------
function runSourceChecks() {
  const schema = read("prisma/schema.prisma");
  const draftModel = schema.slice(
    schema.indexOf("model FilingDraft {"),
    schema.indexOf("model Document {"),
  );
  check("FilingDraft no longer declares a unique (userId, taxYear)", /@@unique\(\s*\[\s*userId\s*,\s*taxYear\s*\]\s*\)/.test(draftModel), false);
  check("FilingDraft keeps a plain (userId, taxYear) lookup index", /@@index\(\s*\[\s*userId\s*,\s*taxYear\s*\]\s*\)/.test(draftModel), true);

  const migrationsDir = path.join(root, "prisma", "migrations");
  const sql = fs
    .readdirSync(migrationsDir)
    .filter((name) => fs.statSync(path.join(migrationsDir, name)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"),
    }));
  const createsUnique = sql.filter((m) => /CREATE UNIQUE INDEX "FilingDraft_userId_taxYear_key"/.test(m.sql));
  const dropsUnique = sql.filter((m) => /DROP INDEX "FilingDraft_userId_taxYear_key"/.test(m.sql));
  check("exactly one migration drops the unique index", dropsUnique.length, 1);
  check(
    "the drop migration comes after the migration that created the index",
    createsUnique.length === 1 && dropsUnique[0].name > createsUnique[0].name,
    true,
  );
  check(
    "the drop migration adds the plain index",
    /CREATE INDEX "FilingDraft_userId_taxYear_idx" ON "FilingDraft"\("userId", "taxYear"\)/.test(dropsUnique[0]?.sql ?? ""),
    true,
  );

  const filingActions = code("app/actions/filing.ts");
  check("no code looks a draft up by the removed compound key", /userId_taxYear/.test(filingActions), false);
  check("the draft save no longer uses a user+year upsert", /filingDraft\.upsert\(/.test(filingActions), false);
  check("create reads the explicit draft id", /getRequestedDraftId\(formData\)/.test(filingActions), true);
  check(
    "both create and save pass the explicit draft id",
    (filingActions.match(/getRequestedDraftId\(formData\),\s*\n\s*\);/g) ?? []).length,
    2,
  );
  check("reuse is decided by the shared helper", /pickReusableDraft\(/.test(filingActions), true);
  check(
    "an explicit draft id is read from the form and trimmed",
    /const value = raw\.trim\(\);/.test(filingActions),
    true,
  );
  check(
    "an explicit draft id that the user does not own is refused",
    /if \(!owned\) throw new FilingDraftNotFoundError\(\);/.test(filingActions),
    true,
  );

  for (const file of ["app", "lib", "components", "electron-connect"]) {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
        } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name) && /userId_taxYear/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, file));
    check(`${file}/ has no use of the removed compound key`, offenders, []);
  }

  const wizard = code("components/tax/filing/filing-wizard.tsx");
  check(
    "the wizard sends the draft id with every snapshot",
    /formData\.set\(\s*"draftId"\s*,\s*currentDraftId\s*\)/.test(wizard) &&
      /const currentDraftId = draftId \?\? resumeDraftId \?\? null/.test(wizard),
    true,
  );
}

// ---------------------------------------------------------------------------
// 3. Real actions against a real database
// ---------------------------------------------------------------------------
function snapshotForm({ sources, draftId, step = 3, completion = 3 }) {
  const form = new FormData();
  form.set("taxYear", "2026");
  form.set("filerType", "myself");
  form.set("residencyStatus", "resident");
  form.set("currentStep", String(step));
  form.set("wizardCompletionStep", String(completion));
  if (sources.length > 1) form.set("salaryPercentage", "70");
  for (const source of sources) form.append("incomeSources", source);
  if (draftId) form.set("draftId", draftId);
  return form;
}

async function runDatabaseChecks() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log("Multiple-filings database checks skipped: Prisma client is not generated.");
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log("Multiple-filings database checks skipped (no database reachable).");
    return;
  }
  await probe.$disconnect();

  const { prisma } = require(path.join(root, "lib/prisma.ts"));
  const actions = require(path.join(root, "app/actions/filing.ts"));
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `multi-filing-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };

  try {
    // The index state of the live database: the migration must be applied.
    const indexes = await prisma.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'FilingDraft' AND indexdef LIKE '%"userId", "taxYear"%'`,
    );
    check(
      "the database has no unique index on (userId, taxYear): run `npx prisma migrate deploy`",
      indexes.some((row) => /UNIQUE/i.test(row.indexdef)),
      false,
    );
    check("the database has the plain (userId, taxYear) index", indexes.length >= 1, true);
    if (indexes.some((row) => /UNIQUE/i.test(row.indexdef))) {
      // Every scenario below would fail for the same reason; stop with the
      // one clear message instead of a stack trace.
      return;
    }

    const countDrafts = (userId) => prisma.filingDraft.count({ where: { userId, taxYear: 2026 } });

    // ---- Scenario 1: salary approved, then a second income source -------
    const owner = newEmail("owner");
    sessionEmail = owner;
    const salary = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["salary"] }),
    );
    check("the salary filing is created", salary.success, true);
    const salaryId = salary.draftId;
    const ownerId = (await prisma.user.findUnique({ where: { email: owner } })).id;

    // Make it a finished, approved salary filing with a packet.
    await prisma.filingDraft.update({
      where: { id: salaryId },
      data: { status: "APPROVED_FOR_FILING", packetApprovalConfirmed: true },
    });
    await prisma.filingPacket.create({
      data: {
        filingDraftId: salaryId,
        userId: ownerId,
        version: 1,
        packetHash: "hash-salary",
        snapshotJson: "{}",
        approvalStatus: "APPROVED",
      },
    });
    const selectionsBefore = await prisma.filingIncomeSelection.count({
      where: { filingDraftId: salaryId },
    });

    // The user now starts another filing for the same year (no draft id yet).
    const second = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["salary", "pension"] }),
    );
    check("the second same-year filing is created", second.success, true);
    check("the second filing is a NEW draft", second.draftId !== salaryId && Boolean(second.draftId), true);
    check("the user now has two filings for the year", await countDrafts(ownerId), 2);

    const salaryAfter = await prisma.filingDraft.findUnique({
      where: { id: salaryId },
      include: { filingPackets: true },
    });
    check("the approved filing keeps its status", salaryAfter.status, "APPROVED_FOR_FILING");
    check("the approved filing keeps its income sources", salaryAfter.incomeSources, JSON.stringify(["salary"]));
    check("the approved filing keeps its approval flag", salaryAfter.packetApprovalConfirmed, true);
    check("the approved filing keeps its approved packet", salaryAfter.filingPackets.map((p) => p.approvalStatus), ["APPROVED"]);
    check(
      "the approved filing keeps its income selections",
      await prisma.filingIncomeSelection.count({ where: { filingDraftId: salaryId } }),
      selectionsBefore,
    );
    const secondRow = await prisma.filingDraft.findUnique({ where: { id: second.draftId } });
    check("the new filing has its own income sources", secondRow.incomeSources, JSON.stringify(["salary", "pension"]));
    check("the new filing starts in progress", secondRow.status, "IN_PROGRESS");

    // ---- Scenario 2: later saves target the draft they belong to --------
    const save = await actions.saveFilingDraftAction(
      snapshotForm({ sources: ["salary", "pension"], draftId: second.draftId, step: 5, completion: 4 }),
    );
    check("Save Draft with a draft id succeeds", save.success, true);
    check("Save Draft updates the same draft", save.draftId, second.draftId);
    check("Save Draft creates no extra filing", await countDrafts(ownerId), 2);
    check("Save Draft stored the requested step", (await prisma.filingDraft.findUnique({ where: { id: second.draftId } })).currentStep, 5);
    check(
      "Save Draft left the approved filing untouched",
      (await prisma.filingDraft.findUnique({ where: { id: salaryId } })).status,
      "APPROVED_FOR_FILING",
    );

    const createAgain = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["salary", "pension"], draftId: second.draftId }),
    );
    check("Create Filing pressed again reuses the known draft", createAgain.draftId, second.draftId);
    check("Create Filing pressed again adds no filing", await countDrafts(ownerId), 2);

    // ---- Scenario 3: without an id an unfinished draft is continued ------
    const resumed = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["salary", "pension"] }),
    );
    check("without an id the unfinished draft is continued", resumed.draftId, second.draftId);
    check("continuing adds no filing", await countDrafts(ownerId), 2);

    // ---- Scenario 4: every same-year draft protected -> a third draft ----
    await prisma.fbrConnection.create({
      data: { filingDraftId: second.draftId, userId: ownerId, status: "FILING_COMPLETED" },
    });
    const third = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["pension"] }),
    );
    check("a completed filing is never reused: a third draft is created", third.draftId !== second.draftId && third.draftId !== salaryId, true);
    check("the user has three filings", await countDrafts(ownerId), 3);
    check(
      "the completed filing's income sources are intact",
      (await prisma.filingDraft.findUnique({ where: { id: second.draftId } })).incomeSources,
      JSON.stringify(["salary", "pension"]),
    );

    // A finished dry run does not protect: that draft is continued.
    await prisma.fbrConnection.update({
      where: { filingDraftId: second.draftId },
      data: { status: "DRY_RUN_COMPLETED" },
    });
    // third is newer, so it is the one continued
    const afterDryRun = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["pension"] }),
    );
    check("an unprotected draft (dry run only) is continued", [second.draftId, third.draftId].includes(afterDryRun.draftId), true);
    check("continuing after a dry run adds no filing", await countDrafts(ownerId), 3);

    // ---- Scenario 5: explicit save on a protected draft is an edit -------
    const editApproved = await actions.saveFilingDraftAction(
      snapshotForm({ sources: ["salary"], draftId: salaryId }),
    );
    check("an explicit save on the approved draft succeeds", editApproved.draftId, salaryId);
    check(
      "editing an approved filing on purpose resets it to in progress",
      (await prisma.filingDraft.findUnique({ where: { id: salaryId } })).status,
      "IN_PROGRESS",
    );
    check("editing it adds no filing", await countDrafts(ownerId), 3);

    // ---- Scenario 6: another user's draft id is refused -------------------
    const intruder = newEmail("intruder");
    sessionEmail = intruder;
    const stolen = await actions.saveFilingDraftAction(
      snapshotForm({ sources: ["salary"], draftId: salaryId }),
    );
    check("another user's draft id is refused", stolen.success, false);
    check("the refusal says the draft was not found", stolen.error, "Filing draft not found");
    const stolenCreate = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["salary"], draftId: salaryId }),
    );
    check("create with another user's draft id is refused", stolenCreate.success, false);
    const intruderRow = await prisma.user.findUnique({ where: { email: intruder } });
    check("the refused request created nothing for the intruder", await countDrafts(intruderRow.id), 0);
    check(
      "the owner's draft was not touched by the intruder",
      (await prisma.filingDraft.findUnique({ where: { id: salaryId } })).userId,
      ownerId,
    );

    // ---- Scenario 7: concurrent creates do not duplicate ------------------
    // Repeated over several fresh users: a single round can pass by luck when
    // the requests happen to interleave kindly.
    let worstDraftCount = 0;
    let allSucceeded = true;
    let distinctReturned = 0;
    for (let round = 0; round < 5; round += 1) {
      const racer = newEmail(`racer${round}`);
      sessionEmail = racer;
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          actions.createFilingDraftAction(snapshotForm({ sources: ["salary"] })),
        ),
      );
      allSucceeded = allSucceeded && results.every((r) => r.success);
      const racerRow = await prisma.user.findUnique({ where: { email: racer } });
      worstDraftCount = Math.max(worstDraftCount, await countDrafts(racerRow.id));
      distinctReturned = Math.max(distinctReturned, new Set(results.map((r) => r.draftId)).size);
    }
    check("every concurrent create succeeds", allSucceeded, true);
    check("concurrent creates produce exactly one draft (worst of 5 rounds)", worstDraftCount, 1);
    check("all concurrent creates return that one draft (worst of 5 rounds)", distinctReturned, 1);

    // ---- Scenario 8: a bad id format is ignored, not trusted --------------
    const legacy = newEmail("legacy");
    sessionEmail = legacy;
    const withLegacyId = await actions.createFilingDraftAction(
      snapshotForm({ sources: ["salary"], draftId: "draft_12345" }),
    );
    check("a legacy-looking draft id is ignored and a draft is created", withLegacyId.success, true);
  } finally {
    sessionEmail = null;
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  runHelperChecks();
  runSourceChecks();
  await runDatabaseChecks();

  if (failures.length > 0) {
    console.error("Multiple filings per year checks FAILED:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Multiple filings per year checks passed: ${assertionCount} assertions.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
