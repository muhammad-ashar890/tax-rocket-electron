const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));

// Run actual TS modules with mocked auth/database/HTTP only. No database,
// real user session, FBR session or external network is needed.
function moduleLoader(mocks = {}, env = {}) {
  const cache = new Map();
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === "next/server")
      return {
        NextResponse: {
          json: (data, options = {}) => ({
            data,
            status: options.status || 200,
          }),
        },
      };
    const absolute = name.startsWith("@/")
      ? path.join(root, name.slice(2))
      : name.startsWith(".")
        ? path.resolve(parent, name)
        : path.isAbsolute(name)
          ? name
          : null;
    if (!absolute) return require(name);
    const file =
      fs.existsSync(absolute) && fs.statSync(absolute).isFile()
        ? absolute
        : `${absolute}.ts`;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    const context = vm.createContext({
      console,
      process: { env },
      URL,
      URLSearchParams,
      Date,
      Buffer,
      exports: module.exports,
      module,
      require: (child) => load(child, path.dirname(file)),
    });
    vm.runInContext(output, context, { filename: file });
    return module.exports;
  }
  return (name) => load(path.join(root, name));
}

const detailedMap = {
  incomeFields: [
    {
      irisCode: "1000",
      irisDescription: "Salary",
      portalArea: "Employment",
      section: "Salary",
      column: "Amount Subject to Normal Tax",
      ourAmount: 1234,
      ourCategory: "SALARY",
      ourDescription: "Salary income",
      isTaxField: false,
    },
  ],
  adjustableTaxFields: [],
  wealthFields: [],
};
function contextHarness({
  routeFamily,
  packetAvailable = true,
  payloadOverride,
  liveFiling,
} = {}) {
  const calls = {};
  const payload = {
    packetId: "packet-4",
    packetVersion: 4,
    packetHash: "approved-hash",
    taxYear: 2026,
    ...payloadOverride,
  };
  const job = {
    id: "job-1",
    status: "offered_to_device",
    filingDraftId: "draft-1",
    jobType: "tax_assisted_filing",
    payloadJson: JSON.stringify(payload),
    filingDraft: { taxYear: 2026 },
  };
  const packet = {
    id: "packet-4",
    version: 4,
    packetHash: "approved-hash",
    snapshotJson: JSON.stringify({
      filing: { taxYear: 2026, filerType: "myself" },
      routeMetadata: routeFamily
        ? { routeFamily, routeLabel: "Approved form" }
        : undefined,
      returnSummary: { taxPayable: 123 },
      portalFieldMap: detailedMap,
    }),
  };
  const prisma = {
    trustedDevice: {
      findUnique: async () => ({
        id: "device-1",
        userId: "user-1",
        status: "ACTIVE",
      }),
    },
    localAgentJob: { findFirst: async () => job, update: async () => job },
    filingPacket: {
      findFirst: async (args) => {
        calls.packetQuery = args;
        return packetAvailable ? packet : null;
      },
    },
    taxAuditEvent: { create: async () => ({}) },
  };
  const load = moduleLoader(
    { "@/lib/prisma": { prisma } },
    {
      // The deployment's own consent, exactly as it arrives from the server env.
      ...(liveFiling === undefined
        ? {}
        : { TAXROCKET_ALLOW_LIVE_FILING: String(liveFiling) }),
    },
  );
  const route = load("app/api/local-agent/jobs/[jobId]/context/route.ts");
  return {
    calls,
    run: () =>
      route.GET(
        {
          url: "https://app.invalid/api/context",
          headers: new Headers({ authorization: "Bearer synthetic-token" }),
        },
        { params: Promise.resolve({ jobId: "job-1" }) },
      ),
  };
}

test("real context pins approved packet, flattens the worker map, and preserves grouped route data", async () => {
  const harness = contextHarness({ routeFamily: "normal_individual_114" });
  const response = await harness.run();
  assert.equal(response.status, 200);
  assert.equal(harness.calls.packetQuery.where.id, "packet-4");
  assert.equal(harness.calls.packetQuery.where.version, 4);
  assert.equal(harness.calls.packetQuery.where.packetHash, "approved-hash");
  assert.equal(harness.calls.packetQuery.where.approvalStatus, "APPROVED");
  assert.equal(harness.calls.packetQuery.orderBy, undefined);
  assert.equal(response.data.filingPacket.taxYear, 2026);
  assert.equal(response.data.filingPacket.packetVersion, 4);
  assert.equal(
    response.data.snapshot.routeMetadata.routeFamily,
    "normal_individual_114",
  );
  assert.equal(response.data.snapshot.returnSummary.taxPayable, 123);
  assert.ok(response.data.taxAutomationConfig.routeSelector);
  assert.equal(Array.isArray(response.data.snapshot.portalFieldMap), true);
  assert.deepEqual(
    plain(response.data.snapshot.portalFieldMapDetailed),
    detailedMap,
  );
  assert.equal(response.data.snapshot.portalFieldMap[0].irisCode, "1000");
  assert.equal(
    response.data.snapshot.portalFieldMap[0].rowSelector,
    '[id="1000"]',
  );
  assert.equal(
    response.data.snapshot.portalFieldMap[0].selector.includes(
      '[id="1000"] input',
    ),
    true,
  );
  assert.equal(
    response.data.snapshot.portalFieldMap[0].leftPanel,
    "Employment",
  );
  assert.equal(
    JSON.stringify(response.data.snapshot.portalFieldMap).includes(
      "data-tax-field-key",
    ),
    false,
  );
  assert.equal(
    response.data.taxAutomationConfig.livePilot.automaticFilingEnabled,
    false,
  );
  assert.equal(
    response.data.taxAutomationConfig.livePilot.mode,
    "navigation_inspection_only",
  );
});

/* ------------------------------------------------------------------ *
 * the deployment's own consent for typing into IRIS                    *
 * ------------------------------------------------------------------ */

test("writes stay off unless the server env says otherwise, whatever a stray value is", async () => {
  for (const value of [
    undefined,
    "",
    "maybe",
    "0",
    "no",
    "false",
    "live-ish",
    "TRUEish",
  ]) {
    const response = await contextHarness({
      routeFamily: "normal_individual_114",
      liveFiling: value,
    }).run();
    const pilot = response.data.taxAutomationConfig.livePilot;
    assert.equal(
      pilot.automaticFilingEnabled,
      false,
      `TAXROCKET_ALLOW_LIVE_FILING=${JSON.stringify(value)} must not enable writes`,
    );
    assert.equal(pilot.mode, "navigation_inspection_only");
  }
});

test("an explicit on-value enables supervised entry, and says so in the mode", async () => {
  // The same spellings the agent's own parser accepts, so the two switches cannot
  // disagree about what "on" means.
  for (const value of ["true", "TRUE", " 1 ", "on", "yes"]) {
    const response = await contextHarness({
      routeFamily: "normal_individual_114",
      liveFiling: value,
    }).run();
    const pilot = response.data.taxAutomationConfig.livePilot;
    assert.equal(pilot.automaticFilingEnabled, true, String(value));
    assert.equal(pilot.mode, "supervised_live_filing", String(value));
  }
});

test("enabling the deployment flag does not by itself run anything else differently", async () => {
  const off = await contextHarness({
    routeFamily: "normal_individual_114",
  }).run();
  const on = await contextHarness({
    routeFamily: "normal_individual_114",
    liveFiling: "true",
  }).run();

  // The packet, the flattened map and the readiness contract are untouched: this
  // flag only answers "may the agent type", never what it types or where.
  assert.deepEqual(
    plain(on.data.snapshot.portalFieldMap),
    plain(off.data.snapshot.portalFieldMap),
  );
  assert.deepEqual(
    plain(on.data.taxAutomationConfig.readiness),
    plain(off.data.taxAutomationConfig.readiness),
  );
  assert.deepEqual(
    plain(on.data.taxAutomationConfig.dryRun),
    plain(off.data.taxAutomationConfig.dryRun),
  );
});

test("the operator is told live entry is on, and never by a silent default", () => {
  const client = fs.readFileSync(
    path.join(root, "components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  const page = fs.readFileSync(
    path.join(root, "app/tax/fbr-connect/page.tsx"),
    "utf8",
  );
  const config = fs.readFileSync(
    path.join(root, "lib/tax/fbr-agent-config.ts"),
    "utf8",
  );

  // The page asks the same function the job context uses — one source of truth,
  // so the banner cannot disagree with what the agent was told.
  assert.match(
    page,
    /liveFilingEnabled=\{isLiveFilingEnabledByDeployment\(\)\}/,
  );
  assert.match(config, /automaticFilingEnabled: liveFilingEnabled/);
  assert.match(
    config,
    /const liveFilingEnabled = isLiveFilingEnabledByDeployment\(\)/,
  );

  assert.match(
    client,
    /liveFilingEnabled = false/,
    "off is the default in the component",
  );
  assert.match(
    client,
    /role="alert"[\s\S]{0,700}Your filing is ready for supervised entry/,
    "the enabled state is announced, not whispered",
  );
  assert.match(
    client,
    /Nothing\s+is\s+saved or submitted\./,
    "the limits of live mode are stated in the same breath",
  );
  assert.match(client, /Start filing/, "the button uses taxpayer language");

  // The UI can turn the deployment flag on; it cannot loosen WHICH cell a value
  // goes into. That rule stays in the filler, where the captures prove it.
  assert.equal(
    client.includes("allowUnverifiedTargets"),
    false,
    "no web-side bypass of the verified-target rule",
  );
  assert.match(config, /new Set\(\["true", "1", "on", "yes"\]\)/);
});

test("completed agent work is never labeled as a filed FBR return", () => {
  const main = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  const navigation = fs.readFileSync(
    path.join(root, "electron-connect/iris-navigation.js"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(root, "components/tax/fbr-connect-client.tsx"),
    "utf8",
  );

  assert.match(main, /live_return_autofill/);
  assert.match(main, /navigationMode: navigation\?\.result\?\.mode/);
  assert.match(main, /Live entry entered and verified/);
  assert.match(
    main,
    /The return was not saved, calculated, paid, or submitted/,
  );
  assert.match(main, /paused: reviewRequired/);
  assert.match(navigation, /This inspection did not enter values/);
  // fix35: the completion card tells the taxpayer to review and submit it
  // themselves; the agent never submits. No emoji in the card.
  assert.match(client, /Review and submit it yourself/);
  assert.match(client, /does not save,\s+calculate, pay or submit for you/);
  assert.match(client, /submit the return yourself in the FBR/);
  assert.doesNotMatch(client, /[\u2705\u26A0\u26D4\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(client, /NOT ready to submit/);
  assert.doesNotMatch(client, /FBR handoff complete — review required/);
});

test("packet builder metadata marks supported original individual filings as normal 114 route", () => {
  const load = moduleLoader();
  const portalMap = load("lib/tax/portal-field-map.ts");
  const routeMetadata = portalMap.buildPacketRouteMetadata({
    taxYear: 2026,
    filerType: "myself",
    businessStructure: null,
    incomeSources: ["salary", "bank_profit"],
  });
  assert.deepEqual(plain(routeMetadata), {
    routeFamily: "normal_individual_114",
    routeLabel: "114(1) (Return of Income filed voluntarily for complete year)",
    filingIntent: "original",
    requiresIdentification: false,
    source: "packet_builder",
    notes: ["Income sources: salary, bank_profit"],
  });
});

test("unsupported packet profiles remain an explicit identification checkpoint", () => {
  const load = moduleLoader();
  const portalMap = load("lib/tax/portal-field-map.ts");
  const routeMetadata = portalMap.buildPacketRouteMetadata({
    taxYear: 2026,
    filerType: "my_business",
    businessStructure: "company",
    incomeSources: ["business"],
  });
  assert.equal(routeMetadata.routeFamily, null);
  assert.equal(routeMetadata.requiresIdentification, true);
});

test("desktop account reference prefers CNIC for self and NTN for business", () => {
  const load = moduleLoader();
  const desktop = load("lib/tax/fbr-desktop.ts");
  assert.equal(
    desktop.chooseDesktopAccountReference({
      filerType: "myself",
      cnic: "35202-1234567-1",
      ntn: "7654321",
    }),
    "35202-1234567-1",
  );
  assert.equal(
    desktop.chooseDesktopAccountReference({
      filerType: "my_business",
      cnic: "35202-1234567-1",
      ntn: "7654321",
    }),
    "7654321",
  );
});

test("unknown form is an explicit identification checkpoint, not an assumed normal return", async () => {
  const response = await contextHarness().run();
  assert.equal(response.data.snapshot.routeMetadata.routeFamily, null);
  assert.equal(
    response.data.snapshot.routeMetadata.requiresIdentification,
    true,
  );
  assert.equal(response.data.taxAutomationConfig.routeSelector, null);
  assert.equal(
    response.data.taxAutomationConfig.livePilot.mode,
    "navigation_inspection_only",
  );
});

test("missing or superseded queued packet cannot silently become latest packet", async () => {
  assert.equal(
    (await contextHarness({ packetAvailable: false }).run()).status,
    404,
  );
  const missing = contextHarness({ payloadOverride: { packetId: null } });
  assert.equal((await missing.run()).status, 409);
  assert.equal(missing.calls.packetQuery, undefined);
});

test("desktop handoff always targets the real FBR portal", () => {
  const load = moduleLoader(
    {},
    {
      NEXTAUTH_URL: "http://localhost:3000",
    },
  );
  const desktop = load("lib/tax/fbr-desktop.ts");
  const auth = load("lib/tax/fbr-agent-config.ts").getFbrDesktopAuthConfig();
  const session = desktop.buildDesktopSessionConfig({
    launchToken: "test-launch",
    partitionKey: "test-partition",
    deviceTokenHash: "test-hash",
    accountReference: "35202-1234567-1",
  });
  const url = new URL(session.deepLink);
  assert.equal(url.searchParams.get("loginUrl"), auth.loginUrl);
  assert.equal(url.searchParams.get("loginUrl"), "https://iris.fbr.gov.pk/");
  assert.equal(url.searchParams.get("useMockIris"), null);
  assert.equal(url.searchParams.get("accountReference"), "35202-1234567-1");
  assert.equal(session.irisReadySelector, auth.readySelector);
  assert.equal(session.localhostUrl, "http://127.0.0.1:37219/connect");
  assert.equal(auth.useMockIris, false);
  assert.equal(
    desktop.generatePartitionKey("user-one"),
    desktop.generatePartitionKey("user-one"),
  );
  assert.notEqual(
    desktop.generatePartitionKey("user-one"),
    desktop.generatePartitionKey("user-two"),
  );
});

function statusHarness({ status = "running", raceClosed = false } = {}) {
  const calls = {};
  let job = {
    id: "job-1",
    status,
    userId: "user-1",
    trustedDeviceId: "device-1",
    filingDraftId: "draft-1",
    jobType: "tax_assisted_filing",
    startedAt: new Date(),
  };
  const prisma = {
    trustedDevice: {
      findUnique: async () => ({
        id: "device-1",
        userId: "user-1",
        status: "ACTIVE",
      }),
      update: async () => ({}),
    },
    localAgentJob: {
      findFirst: async () => job,
      updateMany: async (args) => {
        calls.update = args;
        job = { ...job, ...args.data };
        return { count: raceClosed ? 0 : 1 };
      },
      findUniqueOrThrow: async () => job,
    },
    taxAuditEvent: { create: async () => ({}) },
    fbrConnection: { updateMany: async () => ({ count: 1 }) },
  };
  const load = moduleLoader({ "@/lib/prisma": { prisma } });
  const route = load("app/api/local-agent/jobs/[jobId]/status/route.ts");
  const run = (body) =>
    route.POST(
      {
        json: async () => body,
        headers: new Headers({ authorization: "Bearer test" }),
      },
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
  return { calls, run };
}

test("status endpoint accepts executionLog/errorMessage aliases actually sent by Electron", async () => {
  const harness = statusHarness();
  const logs = [{ step: "draft_inventory", detail: "Synthetic test" }];
  const response = await harness.run({
    status: "awaiting_user_action",
    executionLog: logs,
    errorMessage: "test-error",
    result: {
      requiredAction: "portal_inspection",
      pauseReason: "Identify form",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(harness.calls.update.data.logsJson), logs);
  assert.equal(harness.calls.update.data.errorMessage, "test-error");
  assert.equal(harness.calls.update.data.pauseAction, "portal_inspection");
});

test("late reports and cancellation races cannot resurrect a terminal job", async () => {
  const closed = statusHarness({ status: "cancelled" });
  assert.equal((await closed.run({ status: "running" })).status, 409);
  assert.equal(closed.calls.update, undefined);
  const race = statusHarness({ raceClosed: true });
  assert.equal(
    (await race.run({ status: "awaiting_user_action" })).status,
    409,
  );
  assert.ok(race.calls.update.where.status.notIn.includes("cancelled"));
});

test("recovery actions retry the SAME phase; unknown actions never skip filling", () => {
  const next = moduleLoader()("lib/tax/fbr-job-resume.ts").getNextFbrPilotPhase;
  for (const action of [
    "selector_bundle_update",
    "session_reconnect",
    "portal_popup",
    "portal_inspection",
    "unknown",
    "",
  ]) {
    assert.equal(next(action, "start"), "start");
    assert.equal(next(action, "after_password_reset"), "after_password_reset");
  }
  assert.equal(next("password_reset", "start"), "after_password_reset");
  assert.equal(next("classic_final_review", "start"), "after_otp_captcha_pin");
  assert.equal(
    next("classic_pin_entry", "after_otp_captcha_pin"),
    "after_classic_pin_entry",
  );
});

test("server final-submit gate still rejects a generic Continue action", async () => {
  let updated = false;
  const prisma = {
    user: { findUnique: async () => ({ id: "user-1" }) },
    localAgentJob: {
      findFirst: async () => ({
        id: "job-1",
        userId: "user-1",
        status: "awaiting_user_action",
        pauseAction: "final_submit_confirmation",
        resultJson: "{}",
        payloadJson: '{"livePilotState":{"phase":"start"}}',
      }),
      update: async () => {
        updated = true;
        return {};
      },
    },
  };
  const load = moduleLoader({
    "@/lib/prisma": { prisma },
    "next-auth/next": {
      getServerSession: async () => ({
        user: { email: "test@example.invalid" },
      }),
    },
    "@/lib/auth": { authOptions: {} },
    "@/app/actions/notifications": { createNotification: async () => {} },
  });
  const actions = load("app/actions/fbr-jobs.ts");
  const result = await actions.resumeJobAfterPauseAction("job-1", {
    confirmedBy: "user",
  });
  assert.equal(result.success, false);
  assert.equal(updated, false);
});

test("reconnect reuses stable device row, clears previous login readiness, and forwards the taxpayer identifier", async () => {
  let upsert;
  const prisma = {
    user: {
      findUnique: async () => ({
        id: "user-1",
        cnic: "35202-1234567-1",
        ntn: "7654321",
      }),
    },
    filingDraft: {
      findFirst: async () => ({
        id: "draft-1",
        taxYear: 2026,
        filerType: "myself",
      }),
    },
    filingPacket: { findFirst: async () => ({ id: "packet-4", version: 4 }) },
    trustedDevice: {
      findUnique: async () => ({
        id: "device-1",
        userId: "user-1",
        localFbrConnectedAt: new Date(),
      }),
      upsert: async (args) => {
        upsert = args;
        return {
          id: "device-1",
          partitionKey: args.where.partitionKey,
          status: "PENDING",
        };
      },
    },
    taxAuditEvent: { create: async () => ({}) },
  };
  const load = moduleLoader({
    "@/lib/prisma": { prisma },
    "next-auth/next": {
      getServerSession: async () => ({
        user: { email: "test@example.invalid" },
      }),
    },
    "@/lib/auth": { authOptions: {} },
  });
  const route = load("app/api/fbr-connect/desktop/session/route.ts");
  const response = await route.POST({
    json: async () => ({ filingDraftId: "draft-1" }),
  });
  assert.equal(response.status, 200);
  assert.equal(upsert.update.localFbrConnectedAt, null);
  assert.equal(upsert.update.status, "PENDING");
  assert.equal(response.data.device.id, "device-1");
  const url = new URL(response.data.session.deepLink);
  assert.equal(url.searchParams.get("accountReference"), "35202-1234567-1");
});

test("packaged Windows agent includes the new module and frontend uses one transport", () => {
  const agentPackage = JSON.parse(
    fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"),
  );
  assert.ok(agentPackage.build.files.includes("iris-navigation.js"));
  const ui = fs.readFileSync(
    path.join(root, "components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  assert.ok(!ui.includes("fetch(data.session.localhostUrl"));
  assert.ok(ui.includes("const agentReady = Boolean(readyDevice)"));
  assert.ok(ui.includes("d.localFbrConnectedAt"));
});

test("live Electron start is explicit and restores the shell's previous mode", () => {
  const agentPackage = JSON.parse(
    fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"),
  );
  const launcher = fs.readFileSync(
    path.join(root, "electron-connect/start-live.ps1"),
    "utf8",
  );
  assert.equal(agentPackage.scripts.dev, "electron . --dev");
  assert.equal(
    agentPackage.scripts["dev:live"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File ./start-live.ps1",
  );
  assert.match(launcher, /\$env:TAXROCKET_REAL_AUTOFILL\s*=\s*"live"/);
  assert.match(launcher, /\$previousMode/);
  assert.match(launcher, /Remove-Item Env:TAXROCKET_REAL_AUTOFILL/);
});

// ── Phase 1: real-portal autofill wiring ──

test("real-portal autofill module is packaged into the Windows installer", () => {
  const agentPackage = JSON.parse(
    fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"),
  );
  assert.ok(
    agentPackage.build.files.includes("iris-row-filler.js"),
    "iris-row-filler.js must ship with the agent or real autofill is dead code on installed clients",
  );
});

test("real IRIS mode no longer dead-ends at navigation-only inspection", () => {
  const main = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );

  // The old shape returned the navigation check immediately, so packet values
  // could never reach the live portal.
  assert.ok(
    !/if \(realPortalMode\) \{\s*return runLocalIrisNavigationCheck\(/.test(
      main,
    ),
    "real mode must not unconditionally return the navigation check",
  );

  assert.ok(main.includes("function runRealIrisAutofill("));
  assert.ok(main.includes('require("./iris-row-filler")'));

  // Both job types must route through it.
  const dryRun = main.slice(
    main.indexOf("async function runLocalTaxDryRunFlow("),
  );
  assert.ok(dryRun.slice(0, 1400).includes("runRealIrisAutofill"));
  const assisted = main.slice(
    main.indexOf("async function runLocalTaxAssistedFilingFlow("),
  );
  assert.ok(assisted.slice(0, 1400).includes("runRealIrisAutofill"));
});

test("real autofill stays opt-in and honours a dry-run mode", () => {
  const main = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  assert.ok(main.includes("TAXROCKET_REAL_AUTOFILL"));
  assert.ok(main.includes("function getRealAutofillMode("));

  // Unset env must preserve the previous behaviour.
  assert.ok(
    /return "off";/.test(main),
    "an unrecognised/unset flag must fall back to navigation-only",
  );
  assert.ok(
    main.includes('autofillMode === "off"'),
    "the off mode must short-circuit before any writing happens",
  );
  assert.ok(
    main.includes("navigation?.paused"),
    "a paused navigation checkpoint must not be overridden by autofill",
  );
});

test("packet field map carries the IRIS code the filler addresses rows by", () => {
  const mapSource = fs.readFileSync(
    path.join(root, "lib/tax/portal-field-map.ts"),
    "utf8",
  );
  // The filler resolves a row as document row id === irisCode, so the flattened
  // worker payload must expose irisCode and the column name.
  assert.ok(mapSource.includes("irisCode: entry.irisCode"));
  assert.ok(mapSource.includes("column: entry.column"));
});

test("completion card reports what the agent actually did for the Wealth Statement", () => {
  const client = fs.readFileSync(
    path.join(__dirname, "..", "components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  const jobs = fs.readFileSync(
    path.join(__dirname, "..", "app/actions/fbr-jobs.ts"),
    "utf8",
  );
  assert.match(
    client,
    /scope\?\.wealthStatement ===\s+"entered_not_calculated"/,
  );
  assert.match(client, /"needs_review"/);
  // Only the scope summary leaves the server, never the whole agent result.
  assert.match(
    jobs,
    /const views = jobs\.map\(\(\{ resultJson, \.\.\.job \}\)/,
  );
  assert.ok(
    !/resultJson: true[\s\S]{0,400}return \{ success: true, jobs \}/.test(jobs),
  );
});

test("taxpayer review step: label, confirmation button and completion line are wired end to end", () => {
  const client = fs.readFileSync(
    path.join(__dirname, "..", "components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  const jobs = fs.readFileSync(
    path.join(__dirname, "..", "app/actions/fbr-jobs.ts"),
    "utf8",
  );
  const main = fs.readFileSync(
    path.join(__dirname, "..", "electron-connect/main.js"),
    "utf8",
  );
  assert.match(
    client,
    /portal_handoff_review: "Review the rest of your return in the FBR window"/,
  );
  assert.match(client, /I have reviewed it in FBR/);
  assert.match(
    client,
    /propertyPaymentsComputations ===\s+"reviewed_by_taxpayer"/,
  );
  assert.match(jobs, /propertyPaymentsComputations:/);
  // The pause is not a final-submit gate: a generic Continue must be able to resume it.
  assert.ok(
    !/final_review|final_submit/.test(
      main.match(/function getHandoffReviewAction\(\) \{[\s\S]*?\n\}/)[0],
    ),
  );
  // The tour never presses Calculate, Save or Submit.
  const tour = main.match(
    /async function runHandoffReviewTour[\s\S]*?\n\}\n/,
  )[0];
  assert.ok(
    !/calculate|submit|save|click/i.test(
      tour.replace(/Calculate, Save or Submit/g, ""),
    ),
  );
});

test("employers: reviewed certificate names travel packet -> device context -> agent, and the opt-in switch is wired", () => {
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const packet = read("app/actions/packet.ts");
  const context = read("app/api/local-agent/jobs/[jobId]/context/route.ts");
  const main = read("electron-connect/main.js");
  const live = read("electron-connect/start-live.ps1");
  const extraction = read("app/actions/extraction.ts");
  assert.match(packet, /employers: extractMappedSalaryEmployers\(/);
  // The detailed map (which carries `employers`) is what the agent reads.
  assert.match(context, /portalFieldMapDetailed: portalMapDetailed/);
  assert.match(main, /snapshot\.portalFieldMapDetailed\?\.employers/);
  assert.match(main, /TAXROCKET_EMPLOYER_AUTOFILL/);
  assert.match(live, /\$env:TAXROCKET_EMPLOYER_AUTOFILL = "on"/);
  // Mapping a certificate without an employer name is refused server-side too.
  assert.match(
    extraction,
    /Enter the employer name exactly as it is registered with FBR/,
  );
});

test("employers: the packet field map carries the names only when there are some", () => {
  const { loadTs } = moduleLoaderForPortalMap();
  const map = (employers) =>
    loadTs("lib/tax/portal-field-map.ts").buildPortalFieldMap({
      taxYear: 2026,
      filerType: "myself",
      taxpayerListStatus: "filer",
      ledgerEntries: [],
      salaryCertificateGrossSalary: 3420000,
      salaryCertificateTaxWithheld: 210000,
      ...(employers ? { employers } : {}),
    });
  assert.deepEqual(plain(map(["SYSTEMS LIMITED", "BETA CORP"]).employers), [
    "SYSTEMS LIMITED",
    "BETA CORP",
  ]);
  assert.equal(
    "employers" in map([]),
    false,
    "no employers: the packet is unchanged",
  );
  assert.equal("employers" in map(undefined), false);
});

function moduleLoaderForPortalMap() {
  const loader = moduleLoader({}, {});
  return { loadTs: (rel) => loader(rel) };
}

test("employer review pause: label, button, resume confirmation and completion line are wired end to end", () => {
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const client = read("components/tax/fbr-connect-client.tsx");
  const main = read("electron-connect/main.js");
  assert.match(
    client,
    /portal_employer_review: "Add your employer in the FBR window"/,
  );
  assert.match(client, /I have added the employer in FBR/);
  assert.match(client, /"confirmed_by_taxpayer"/);
  assert.match(main, /return "portal_employer_review";/);
  // Not a final-submit gate: a plain Continue must be able to resume it.
  assert.ok(
    !/final_review|final_submit|classic_final/.test(
      main.match(/function getEmployerReviewAction\(\) \{[\s\S]*?\n\}/)[0],
    ),
  );
});

test("review pauses need a ticked, recorded confirmation before Continue", () => {
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const client = read("components/tax/fbr-connect-client.tsx");
  const actions = read("app/actions/fbr-jobs.ts");
  assert.match(client, /ACKNOWLEDGEMENT_TEXT/);
  assert.match(client, /type="checkbox"/);
  // The tick is per job AND pause kind, so it cannot carry over to the next pause.
  assert.match(
    client,
    /ackedKey !== `\$\{activeJob\.id\}:\$\{activeJob\.pauseAction\}`/,
  );
  assert.match(
    client,
    /portal_handoff_review:\s*"I confirm that I have personally reviewed/,
  );
  assert.match(
    client,
    /portal_employer_review:\s*"I confirm that I have added my employer/,
  );
  assert.match(actions, /Please tick the confirmation box before continuing\./);
  assert.match(actions, /acknowledgementText/);
  assert.match(actions, /requiredAction === "portal_handoff_review"/);
  assert.match(actions, /requiredAction === "portal_employer_review"/);
});

test("a mapped salary certificate keeps its employer names editable (own save, packet superseded)", () => {
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const actions = read("app/actions/extraction.ts");
  const step = read("components/tax/filing/wizard-documents-step.tsx");
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  const hook = read("components/tax/filing/hooks/use-filing-documents.ts");
  const fn = actions.match(
    /export async function saveSalaryCertificateEmployersAction[\s\S]*?\n}\n/,
  )[0];
  assert.match(fn, /extractionStatus !== "MAPPED"/);
  assert.match(fn, /planSalaryCertificateEmployerUpdate/);
  assert.match(fn, /filingPacket\.updateMany/);
  assert.match(fn, /status: "SUPERSEDED"/);
  assert.match(fn, /packetApprovalConfirmed: false/);
  assert.match(step, /employersEditableAfterMap/);
  assert.match(step, /Save employer/);
  assert.match(
    wizard,
    /handleSaveSalaryEmployers=\{handleSaveSalaryEmployers\}/,
  );
  assert.match(hook, /saveSalaryCertificateEmployersAction/);
});
