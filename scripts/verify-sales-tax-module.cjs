/**
 * Sales Tax module shell (Phase 2A): business profile, authorities, months.
 *
 * Three levels, like the multiple-filings suite:
 *
 *   1. Pure validation (lib/sales-tax/profile.ts): messages are shown to the
 *      user as written, so each one is pinned.
 *   2. Source facts: the module is reachable from the sidebar, the income-tax
 *      wizard no longer offers the Sales Tax card (and says where to go
 *      instead), and the module never touches the income-tax tables.
 *   3. The REAL server actions against a REAL PostgreSQL database (skipped
 *      cleanly when none is reachable). Throw-away users are deleted at the end.
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

const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const code = (relativePath) =>
  read(relativePath)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

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
// 1. Pure validation
// ---------------------------------------------------------------------------
function runPureChecks() {
  const {
    validateProfile,
    validateRequestedPeriod,
    parseStoredAuthorities,
    isEnabledAuthority,
    formatPeriod,
    AUTHORITIES,
    validateBusinessDetails,
    validateAuthoritySelection,
  } = require(path.join(root, "lib/sales-tax/profile.ts"));

  const good = {
    businessName: "  Acme   Traders ",
    registrationNo: " 1234567890123 ",
    authorities: ["FBR"],
  };
  check("a good profile is accepted", validateProfile(good).ok, true);
  check(
    "the business name is cleaned",
    validateProfile(good).value.businessName,
    "Acme Traders",
  );
  check(
    "the registration number is kept as typed, trimmed",
    validateProfile(good).value.registrationNo,
    "1234567890123",
  );
  check(
    "dashes and spaces are allowed in the registration number",
    validateProfile({ ...good, registrationNo: "12-34-5678-901-23" }).ok,
    true,
  );

  const reject = (patch) => validateProfile({ ...good, ...patch });
  check(
    "an empty business name is refused",
    reject({ businessName: "   " }).error,
    "Enter the business name as it is registered.",
  );
  check(
    "a very long business name is refused",
    reject({ businessName: "x".repeat(121) }).ok,
    false,
  );
  check(
    "an empty registration number is refused",
    reject({ registrationNo: "" }).error,
    "Enter your sales tax registration number (STRN).",
  );
  check(
    "letters in the registration number are refused",
    reject({ registrationNo: "ABC1234567" }).error,
    "The registration number can only contain digits, dashes and spaces.",
  );
  check(
    "too few digits are refused",
    reject({ registrationNo: "123456" }).ok,
    false,
  );
  check(
    "too many digits are refused",
    reject({ registrationNo: "1".repeat(16) }).ok,
    false,
  );
  check(
    "seven digits is the lowest accepted",
    reject({ registrationNo: "1234567" }).ok,
    true,
  );
  check(
    "no authority is refused",
    reject({ authorities: [] }).error,
    "Select at least one authority.",
  );
  check(
    "a missing authority list is refused",
    reject({ authorities: undefined }).ok,
    false,
  );
  check(
    "a provincial board that is not built yet is refused",
    reject({ authorities: ["FBR", "SRB"] }).error,
    "SRB (Sindh) is not available yet. For now, select FBR only.",
  );
  check(
    "an unknown authority is refused",
    reject({ authorities: ["XYZ"] }).ok,
    false,
  );
  check(
    "duplicate authorities collapse",
    reject({ authorities: ["FBR", "FBR"] }).value.authorities,
    ["FBR"],
  );

  // The wizard validates one step at a time with these two; the server action
  // validates the whole profile with the same code, so they cannot disagree.
  check(
    "step 1 accepts a good name and STRN",
    validateBusinessDetails(good).ok,
    true,
  );
  check(
    "step 1 cleans the name",
    validateBusinessDetails(good).value.businessName,
    "Acme Traders",
  );
  check(
    "step 1 does not look at the authorities",
    validateBusinessDetails({ businessName: "Acme", registrationNo: "1234567" })
      .ok,
    true,
  );
  check(
    "step 1 refuses an empty name",
    validateBusinessDetails({ businessName: "", registrationNo: "1234567" })
      .error,
    "Enter the business name as it is registered.",
  );
  check(
    "step 1 refuses a bad STRN",
    validateBusinessDetails({ businessName: "Acme", registrationNo: "12" }).ok,
    false,
  );
  check("step 2 accepts FBR", validateAuthoritySelection(["FBR"]).value, [
    "FBR",
  ]);
  check(
    "step 2 refuses nothing selected",
    validateAuthoritySelection([]).error,
    "Select at least one authority.",
  );
  check(
    "step 2 refuses a board that is not built yet",
    validateAuthoritySelection(["SRB"]).ok,
    false,
  );
  check(
    "step 2 refuses a value that is not a list",
    validateAuthoritySelection("FBR").ok,
    false,
  );
  check(
    "the whole-profile check reports the step 1 error first",
    validateProfile({ businessName: "", registrationNo: "1", authorities: [] })
      .error,
    "Enter the business name as it is registered.",
  );
  check(
    "the whole-profile check reports the authority error when step 1 is fine",
    validateProfile({
      businessName: "Acme",
      registrationNo: "1234567",
      authorities: [],
    }).error,
    "Select at least one authority.",
  );

  check(
    "only FBR is enabled today",
    AUTHORITIES.filter((a) => a.enabled).map((a) => a.code),
    ["FBR"],
  );
  check(
    "the planned order is FBR, SRB, PRA, KPRA, BRA",
    AUTHORITIES.map((a) => a.code),
    ["FBR", "SRB", "PRA", "KPRA", "BRA"],
  );
  check("isEnabledAuthority accepts FBR", isEnabledAuthority("FBR"), true);
  check("isEnabledAuthority refuses SRB", isEnabledAuthority("SRB"), false);

  check("stored authorities are read", parseStoredAuthorities('["FBR"]'), [
    "FBR",
  ]);
  check("bad stored authorities give none", parseStoredAuthorities("nope"), []);
  check("null stored authorities give none", parseStoredAuthorities(null), []);
  check(
    "unknown stored authorities are dropped",
    parseStoredAuthorities('["FBR","ZZZ"]'),
    ["FBR"],
  );

  const today = new Date(2026, 9, 8); // 8 Oct 2026
  check(
    "a past month is accepted",
    validateRequestedPeriod(2026, 9, today).ok,
    true,
  );
  check(
    "the current month is accepted",
    validateRequestedPeriod(2026, 10, today).ok,
    true,
  );
  check(
    "next month is refused",
    validateRequestedPeriod(2026, 11, today).ok,
    false,
  );
  check(
    "next year is refused",
    validateRequestedPeriod(2027, 1, today).ok,
    false,
  );
  check(
    "month 13 is refused",
    validateRequestedPeriod(2026, 13, today).error,
    "Choose a valid month and year.",
  );
  check(
    "month 0 is refused",
    validateRequestedPeriod(2026, 0, today).ok,
    false,
  );
  check(
    "text is refused",
    validateRequestedPeriod("abc", "x", today).ok,
    false,
  );
  check(
    "a fractional month is refused",
    validateRequestedPeriod(2026, 3.5, today).ok,
    false,
  );
  check(
    "before 2020 is refused",
    validateRequestedPeriod(2019, 12, today).ok,
    false,
  );
  check(
    "numbers sent as text are accepted",
    validateRequestedPeriod("2026", "8", today).value,
    { year: 2026, month: 8 },
  );
  check(
    "the period is formatted for people",
    formatPeriod({ year: 2026, month: 8 }),
    "August 2026",
  );
}

// ---------------------------------------------------------------------------
// 2. Source facts
// ---------------------------------------------------------------------------
function runSourceChecks() {
  const sidebar = code("components/tax/dashboard-sidebar.tsx");
  check(
    "the sidebar links to the Sales Tax module",
    /href: "\/tax\/sales-tax", label: "Sales Tax"/.test(sidebar),
    true,
  );
  check(
    "the sidebar keeps Sales Tax highlighted on its month pages",
    /pathname\.startsWith\(`\$\{link\.href\}\/`\)/.test(sidebar),
    true,
  );
  check(
    "existing sidebar links are still there",
    [
      "/tax/dashboard",
      "/tax/new",
      "/tax/history",
      "/tax/fbr-connect",
      "/tax/profile",
      "/tax/settings",
    ].every((href) => sidebar.includes(`href: "${href}"`)),
    true,
  );

  const setup = code("components/tax/filing/wizard-setup-step.tsx");
  check(
    "the wizard hides the Sales Tax card unless an old draft already has it",
    /source\.value !== "sales_tax_fed_withholding" \|\|\s*incomeSources\.includes\(source\.value\)/.test(
      setup,
    ),
    true,
  );
  check(
    "the wizard points to the Sales Tax section",
    /href="\/tax\/sales-tax"/.test(setup),
    true,
  );

  const actions = code("app/actions/sales-tax.ts");
  check(
    "the module never reads or writes income-tax drafts",
    /filingDraft|FilingDraft/.test(actions),
    false,
  );
  check(
    "a start looks up the month by its unique key",
    /userId_authority_periodYear_periodMonth/.test(actions),
    true,
  );
  check(
    "only a draft month can be deleted",
    /filing\.status !== STATUS_DRAFT/.test(actions),
    true,
  );

  const pages =
    code("app/tax/sales-tax/page.tsx") +
    code("app/tax/sales-tax/new/page.tsx") +
    code("app/tax/sales-tax/[id]/page.tsx");
  const wizard = code("components/tax/sales-tax/sales-tax-wizard.tsx");
  check(
    "the Sales Tax pages do not use the income-tax wizard",
    /filing-wizard|filing\/wizard-/.test(pages),
    false,
  );
  check(
    "the Sales Tax pages require a login",
    (pages.match(/redirect\("\/login"\)/g) ?? []).length,
    3,
  );

  // The wizard shares only the look of the income-tax wizard (layout and
  // building blocks), never its logic or its draft actions.
  check(
    "the sales tax wizard does not use the income-tax wizard component",
    /filing-wizard|wizard-navigation|wizard-header|wizard-setup-step/.test(
      wizard,
    ),
    false,
  );
  check(
    "the sales tax wizard never touches income-tax drafts",
    /actions\/filing"|FilingDraft|createFilingDraftAction/.test(wizard),
    false,
  );
  check(
    "the sales tax wizard reuses the shared wizard shell",
    /wizard-shell-layout/.test(wizard) &&
      /components\/tax\/wizard-ui/.test(wizard),
    true,
  );
  check(
    "the wizard has four steps in order",
    /SETUP_STEPS = \[\s*"Business details",\s*"Authorities",\s*"Return month",\s*"Review",?\s*\] as const/.test(
      wizard,
    ),
    true,
  );
  check(
    "the wizard checks each step with the shared validators",
    /validateBusinessDetails\(/.test(wizard) &&
      /validateAuthoritySelection\(/.test(wizard) &&
      /validateRequestedPeriod\(/.test(wizard),
    true,
  );
  check(
    "Create stays disabled until every step is valid",
    /disabled=\{submitting \|\| !setupValid\}/.test(wizard),
    true,
  );
  check(
    "the wizard saves the business details before starting the month",
    wizard.indexOf("saveSalesTaxProfileAction({") > -1 &&
      wizard.indexOf("saveSalesTaxProfileAction({") <
        wizard.indexOf("startSalesTaxMonthAction({"),
    true,
  );
  check(
    "an existing month is opened with a note, not duplicated",
    /alreadyStarted/.test(wizard) && /started\.alreadyExisted/.test(wizard),
    true,
  );
  check(
    "the invoice steps follow Review in the same wizard",
    /INVOICE_STEPS = \[\s*"Sales invoices",\s*"Purchase invoices",\s*"Check problems",?\s*\] as const/.test(
      wizard,
    ) &&
      /UploadStep/.test(wizard) &&
      /CheckStep/.test(wizard),
    true,
  );
  check(
    "creating a return carries on in the same wizard without changing the address",
    /setFilingId\(started\.id\)/.test(wizard) &&
      !/router\.(push|replace)|history\.replaceState/.test(wizard),
    true,
  );
  check(
    "a reload of a started month resumes the same wizard",
    /<SalesTaxWizard/.test(code("app/tax/sales-tax/[id]/page.tsx")) &&
      /existing=\{\{/.test(code("app/tax/sales-tax/[id]/page.tsx")),
    true,
  );
  check(
    "the main screen starts a return through the wizard",
    /href="\/tax\/sales-tax\/new"/.test(code("app/tax/sales-tax/page.tsx")),
    true,
  );
  check(
    "the old single-page forms are gone",
    fs.existsSync(
      path.join(root, "components/tax/sales-tax/profile-form.tsx"),
    ) ||
      fs.existsSync(
        path.join(root, "components/tax/sales-tax/month-starter.tsx"),
      ),
    false,
  );
  check(
    "the wizard offers future months as disabled only",
    /disabled=\{future\}/.test(wizard),
    true,
  );

  const schema = read("prisma/schema.prisma");
  check(
    "a month is unique per user, authority and period",
    /@@unique\(\[userId, authority, periodYear, periodMonth\]\)/.test(schema),
    true,
  );
  check(
    "the profile is one per user",
    /model SalesTaxProfile \{[\s\S]*?userId String @unique/.test(schema),
    true,
  );
  const migrations = fs.readdirSync(path.join(root, "prisma", "migrations"));
  check(
    "a migration creates both tables",
    migrations.some(
      (name) =>
        /sales_tax_module/.test(name) &&
        /CREATE TABLE "SalesTaxFiling"/.test(
          read(`prisma/migrations/${name}/migration.sql`),
        ) &&
        /CREATE TABLE "SalesTaxProfile"/.test(
          read(`prisma/migrations/${name}/migration.sql`),
        ),
    ),
    true,
  );
}

// ---------------------------------------------------------------------------
// 3. Real actions against a real database
// ---------------------------------------------------------------------------
async function runDatabaseChecks() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log(
      "Sales tax module database checks skipped: Prisma client is not generated.",
    );
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log(
      "Sales tax module database checks skipped (no database reachable).",
    );
    return;
  }
  const tables = await probe.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('SalesTaxProfile','SalesTaxFiling')`,
  );
  await probe.$disconnect();
  if (tables.length !== 2) {
    check(
      "the database has the Sales Tax tables: run `npx prisma migrate deploy`",
      tables.length,
      2,
    );
    return;
  }

  const { prisma } = require(path.join(root, "lib/prisma.ts"));
  const actions = require(path.join(root, "app/actions/sales-tax.ts"));
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `sales-tax-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };

  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const prevPeriod = {
    year: previous.getFullYear(),
    month: previous.getMonth() + 1,
  };
  const goodProfile = {
    businessName: "Acme Traders",
    registrationNo: "1234567890123",
    authorities: ["FBR"],
  };

  try {
    const owner = newEmail("owner");
    sessionEmail = owner;

    const empty = await actions.getSalesTaxOverviewAction();
    check(
      "a new user has no profile and no months",
      [empty.success, empty.profile, empty.filings.length],
      [true, null, 0],
    );

    const early = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...prevPeriod,
    });
    check(
      "a month cannot be started before the profile is saved",
      early.success,
      false,
    );
    check(
      "the message says to save the details first",
      early.error,
      "Save your business details first, then start a month.",
    );

    const bad = await actions.saveSalesTaxProfileAction({
      ...goodProfile,
      registrationNo: "12",
    });
    check("an invalid profile is not saved", bad.success, false);
    const badBoard = await actions.saveSalesTaxProfileAction({
      ...goodProfile,
      authorities: ["SRB"],
    });
    check(
      "a provincial board that is not built yet is not saved",
      badBoard.success,
      false,
    );
    check(
      "nothing was stored after the refusals",
      (await actions.getSalesTaxOverviewAction()).profile,
      null,
    );

    const saved = await actions.saveSalesTaxProfileAction(goodProfile);
    check("a valid profile is saved", saved.success, true);
    const afterSave = await actions.getSalesTaxOverviewAction();
    check("the profile is read back", afterSave.profile, goodProfile);

    const renamed = await actions.saveSalesTaxProfileAction({
      ...goodProfile,
      businessName: "Acme Wholesale",
    });
    check("saving again updates the same profile", renamed.success, true);
    check(
      "the profile row is still one",
      await prisma.salesTaxProfile.count({ where: { user: { email: owner } } }),
      1,
    );
    check(
      "the new name is stored",
      (await actions.getSalesTaxOverviewAction()).profile.businessName,
      "Acme Wholesale",
    );

    const started = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...prevPeriod,
    });
    check("a month is started", started.success, true);
    check("it is new", started.alreadyExisted, false);

    const again = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...prevPeriod,
    });
    check(
      "starting the same month again opens the same one",
      [again.success, again.id, again.alreadyExisted],
      [true, started.id, true],
    );
    const twoText = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      year: String(prevPeriod.year),
      month: String(prevPeriod.month),
    });
    check("a month sent as text is the same month", twoText.id, started.id);

    check(
      "a future month is refused",
      (
        await actions.startSalesTaxMonthAction({
          authority: "FBR",
          year: next.getFullYear(),
          month: next.getMonth() + 1,
        })
      ).success,
      false,
    );
    check(
      "a made-up month is refused",
      (
        await actions.startSalesTaxMonthAction({
          authority: "FBR",
          year: 2026,
          month: 14,
        })
      ).success,
      false,
    );
    const other = await actions.startSalesTaxMonthAction({
      authority: "SRB",
      ...prevPeriod,
    });
    check("an authority outside the profile is refused", other.success, false);
    check(
      "the refusal asks to use a saved authority",
      other.error,
      "Choose one of the authorities saved in your business details.",
    );

    // A month that is long past has due dates; check the standard FBR dates.
    const august = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      year: 2026,
      month: 8,
    });
    if (
      prevPeriod.year > 2026 ||
      (prevPeriod.year === 2026 && prevPeriod.month >= 8)
    ) {
      check("August 2026 can be started", august.success, true);
      const detail = await actions.getSalesTaxFilingAction(august.id);
      check(
        "August 2026 due dates are the standard FBR ones",
        detail.filing.dueDates,
        {
          annexC: "2026-09-10",
          payment: "2026-09-15",
          returnFiling: "2026-09-18",
        },
      );
      check(
        "the detail carries the business details",
        detail.profile.businessName,
        "Acme Wholesale",
      );
    }
    const overview = await actions.getSalesTaxOverviewAction();
    check(
      "the overview lists the months, newest first",
      overview.filings.map((f) => `${f.periodYear}-${f.periodMonth}`),
      [`${prevPeriod.year}-${prevPeriod.month}`, "2026-8"].filter(
        (value, index, list) => list.indexOf(value) === index,
      ),
    );

    // Concurrent starts of one month give exactly one row.
    const racePeriod = { year: prevPeriod.year - 1, month: 3 };
    const race = await Promise.all(
      Array.from({ length: 8 }, () =>
        actions.startSalesTaxMonthAction({ authority: "FBR", ...racePeriod }),
      ),
    );
    check(
      "every concurrent start succeeds",
      race.every((r) => r.success),
      true,
    );
    check(
      "concurrent starts return one month",
      new Set(race.map((r) => r.id)).size,
      1,
    );
    check(
      "concurrent starts store one row",
      await prisma.salesTaxFiling.count({
        where: {
          user: { email: owner },
          periodYear: racePeriod.year,
          periodMonth: 3,
        },
      }),
      1,
    );

    // Another user cannot see, open or delete these months.
    const stranger = newEmail("stranger");
    sessionEmail = stranger;
    const strangerView = await actions.getSalesTaxOverviewAction();
    check(
      "another user sees none of these months",
      [strangerView.profile, strangerView.filings.length],
      [null, 0],
    );
    check(
      "another user cannot open a month",
      (await actions.getSalesTaxFilingAction(started.id)).success,
      false,
    );
    const strangerDelete = await actions.deleteSalesTaxMonthAction(started.id);
    check("another user cannot delete a month", strangerDelete.success, false);
    check(
      "the month survived",
      await prisma.salesTaxFiling.count({ where: { id: started.id } }),
      1,
    );
    await actions.saveSalesTaxProfileAction({
      businessName: "Other Co",
      registrationNo: "7654321",
      authorities: ["FBR"],
    });
    const strangerStart = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...prevPeriod,
    });
    check(
      "another user can start the same month for their own business",
      [strangerStart.success, strangerStart.id !== started.id],
      [true, true],
    );

    // Delete rules.
    sessionEmail = owner;
    await prisma.salesTaxFiling.update({
      where: { id: started.id },
      data: { status: "READY" },
    });
    const blocked = await actions.deleteSalesTaxMonthAction(started.id);
    check(
      "a month that is not a draft cannot be deleted",
      [blocked.success, blocked.error],
      [false, "Only a draft month can be deleted."],
    );
    const removed = await actions.deleteSalesTaxMonthAction(race[0].id);
    check("a draft month can be deleted", removed.success, true);
    check(
      "it is gone",
      await prisma.salesTaxFiling.count({ where: { id: race[0].id } }),
      0,
    );
    check(
      "deleting a missing month is refused",
      (await actions.deleteSalesTaxMonthAction("does-not-exist")).success,
      false,
    );

    // The module leaves the income-tax tables alone.
    const ownerRow = await prisma.user.findUnique({ where: { email: owner } });
    check(
      "no income-tax draft was created",
      await prisma.filingDraft.count({ where: { userId: ownerRow.id } }),
      0,
    );

    // Deleting the user removes the module data with it.
    await prisma.user.delete({ where: { id: ownerRow.id } });
    check(
      "the profile is removed with the user",
      await prisma.salesTaxProfile.count({ where: { userId: ownerRow.id } }),
      0,
    );
    check(
      "the months are removed with the user",
      await prisma.salesTaxFiling.count({ where: { userId: ownerRow.id } }),
      0,
    );

    // Unauthenticated calls.
    sessionEmail = null;
    const anonymous = await actions.getSalesTaxOverviewAction();
    check(
      "without a login the overview fails safely",
      [anonymous.success, anonymous.filings.length],
      [false, 0],
    );
    check(
      "without a login nothing can be saved",
      (await actions.saveSalesTaxProfileAction(goodProfile)).success,
      false,
    );
  } finally {
    sessionEmail = null;
    await prisma.user
      .deleteMany({ where: { email: { in: emails } } })
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  runPureChecks();
  runSourceChecks();
  await runDatabaseChecks();

  if (failures.length > 0) {
    console.error("Sales tax module checks FAILED:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Sales tax module checks passed: ${assertionCount} assertions.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
