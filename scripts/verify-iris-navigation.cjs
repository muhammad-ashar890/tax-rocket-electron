const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const navigation = require("../electron-connect/iris-navigation");

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});

// Synthetic fixture based only on the supplied log's menu LABELS. No customer
// identity, financial data, authentication or requests to FBR are used.
const dashboard = (dialog = "") => `<!doctype html><html><head><style>
body{font:16px sans-serif;margin:20px}a,button{display:inline-block;padding:9px;margin:4px;cursor:pointer}
a{background:#eee}th,td{padding:10px}[hidden]{display:none!important}
[role=dialog]{position:fixed;top:15%;left:20%;width:420px;padding:24px;background:#fff;border:2px solid #aaa;z-index:20}
.modal-backdrop{position:fixed;inset:0;background:#0004;z-index:10}
</style></head><body>
<nav><a id="homeLink" href="/dashboard">Home</a><a id="navbarDropdown1" onclick="actions.push('assets')">Assets Declaration</a>
<a id="navbarDropdown1" onclick="actions.push('declaration')">Declaration</a><button>person_pinarrow_drop_down</button>
<a>PRIVATE TEST TAXPAYER NAME</a></nav>
<a id="inbox" class="active">Inbox (Correspondence from FBR)</a>
<a id="draft" onclick="actions.push('draft');this.classList.add('active');document.querySelector('#inbox').classList.remove('active');setTimeout(()=>document.querySelector('#it').hidden=false,150)">Draft (Unsubmitted Documents)</a>
<a>Completed Tasks</a><button id="it" hidden onclick="actions.push('it');this.classList.add('active');setTimeout(()=>document.querySelector('#grid').hidden=false,200)">IT DECLARATION (2)</button>
<table id="grid" hidden><thead><tr><th>Task</th><th>Tax Period</th><th>Action</th></tr></thead><tbody>
<tr class="doubleclick" ondblclick="actions.push('OPEN_RETURN')"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2025 - 30-Jun-2026</td><td><button class="edit" onclick="actions.push('EDIT_RETURN')">Edit</button></td></tr>
<tr class="doubleclick" ondblclick="actions.push('OPEN_WRONG_YEAR')"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2024 - 30-Jun-2025</td><td><button onclick="actions.push('DELETE_RETURN')">Delete</button></td></tr>
</tbody></table>
<input id="search" value="PRIVATE_SEARCH_VALUE"><button onclick="actions.push('SUBMIT')">Submit</button>
<script>window.actions=[];localStorage.setItem('token','PRIVATE_STORAGE_TOKEN');</script>${dialog}</body></html>`;

async function withPage(html, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // No live network: every request, including the initial official-looking
  // fixture URL, is intercepted locally.
  await context.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto(
    "https://iris.fbr.gov.pk/dashboard?token=PRIVATE_URL_TOKEN#PRIVATE_HASH",
  );
  const mainFrame = {
    get url() {
      return page.url();
    },
    executeJavaScript: (source) => page.evaluate(source),
  };
  mainFrame.framesInSubtree = [mainFrame];
  const windowInstance = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      getURL: () => page.url(),
      executeJavaScript: mainFrame.executeJavaScript,
    },
  };
  try {
    await run(page, windowInstance);
  } finally {
    await context.close();
  }
}

const welcome = `<div class="modal-backdrop" id="backdrop"></div><section role="dialog" id="promo">
<h2>Submit Your Income Tax Return</h2><p>Tax year 2026 — Last Date</p>
<button aria-label="Close" onclick="actions.push('close_welcome');document.querySelector('#backdrop').remove();document.querySelector('#promo').remove()">×</button></section>`;

test("live inspection closes ONLY identified welcome and waits for Angular draft tabs/grid", async () => {
  await withPage(dashboard(welcome), async (page, windowInstance) => {
    const steps = [];
    const result = await navigation.inspectNavigation(windowInstance, {
      taxYear: 2026,
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.requiredAction, "portal_inspection");
    assert.deepEqual(await page.evaluate("actions"), [
      "close_welcome",
      "draft",
      "it",
    ]);
    const frame = result.inspection.frames[0];
    assert.equal(frame.rows.length, 2);
    assert.deepEqual(frame.rows[0].form.codes, ["114(1)"]);
    assert.equal(frame.rows[0].requestedYearMentioned, true);
    assert.equal(frame.rows[1].requestedYearMentioned, false);
    assert.deepEqual(frame.rows[0].candidatePeriods, [
      "01-Jul-2025",
      "30-Jun-2026",
    ]);
    assert.ok(steps.includes("draft_inventory"));
    assert.equal(
      await page.locator("#search").inputValue(),
      "PRIVATE_SEARCH_VALUE",
    );
    const exported = JSON.stringify(result);
    for (const secret of [
      "PRIVATE TEST",
      "PRIVATE_SEARCH_VALUE",
      "PRIVATE_STORAGE_TOKEN",
      "PRIVATE_URL_TOKEN",
      "PRIVATE_HASH",
    ]) {
      assert.ok(!exported.includes(secret), `Must not export ${secret}`);
    }
  });
});

test("an unknown modal is not hidden, dismissed or bypassed", async () => {
  const unknown = `<div class="modal-backdrop"></div><div role="dialog" id="unknown"><img alt="" width="80" height="40"><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(unknown), async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.equal(await page.locator("#unknown").isVisible(), true);
  });
});

test("OTP / PIN dialogs are protected even if they also mention a welcome promotion", async () => {
  const verification = `<div class="modal-backdrop"></div><div role="dialog" id="otp"><p>Submit Your Income Tax Return for tax year 2026</p><label>OTP / PIN <input name="otp" value="PRIVATE_OTP_VALUE"></label><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(verification), async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.equal(result.inspection.frames[0].dialogs[0].kind, "protected");
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_OTP_VALUE"));
    assert.equal(await page.locator("#otp").isVisible(), true);
  });
});

test("a final-confirmation dialog cannot masquerade as an auto-dismissible welcome", async () => {
  const final = `<div role="dialog" id="final"><p>Submit Your Income Tax Return for tax year 2026</p><button onclick="actions.push('SUBMIT')">Submit</button><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(final), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "close-welcome",
    });
    assert.equal(result.frames[0].actionResult.status, "manual_close_required");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("reappearing welcome popup retries are bounded and never navigate behind it", async () => {
  const recurring = welcome.replace(
    "document.querySelector('#promo').remove()",
    "document.querySelector('#promo').remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend',window.recurringMarkup),100)",
  );
  await withPage(dashboard(recurring), async (page, win) => {
    await page.evaluate(() => {
      window.recurringMarkup =
        document.querySelector("#backdrop").outerHTML +
        document.querySelector("#promo").outerHTML;
    });
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(
      await page.evaluate("actions"),
      Array(4).fill("close_welcome"),
    );
    assert.equal(
      await page.evaluate("Boolean(window.__taxrocketPopupGuardTimer)"),
      false,
    );
  });
});

test("body/domain/search input do not prove login or return readiness", async () => {
  await withPage(
    `<body><input type="password" name="password" value="PRIVATE_PASSWORD"><button>Login</button></body>`,
    async (page, win) => {
      const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
      assert.equal(result.requiredAction, "session_reconnect");
      assert.equal(navigation.isAuthenticated(result.inspection), false);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_PASSWORD"));
    },
  );
  // A bare search box is NOT a login prompt. Reporting session_reconnect here
  // would tell the user to sign in again when they may already be signed in;
  // the honest answer is that the screen could not be identified.
  await withPage(`<body><input id="search"></body>`, async (_page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_readiness_unverified");
    assert.equal(navigation.isAuthenticated(result.inspection), false);
  });
});

test("duplicate navbar ids are resolved by exact semantic action, never first id match", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "declaration-menu",
    });
    assert.equal(result.frames[0].actionResult.status, "clicked");
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
    await page.evaluate(() => {
      const extra = document.querySelector("#navbarDropdown1").cloneNode(true);
      extra.textContent = "Declaration";
      document.querySelector("nav").appendChild(extra);
      window.actions = [];
    });
    const ambiguous = await navigation.probeFrames(win, {
      action: "declaration-menu",
    });
    assert.equal(ambiguous.frames[0].actionResult.status, "ambiguous");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("only approved HTTPS hosts and actual Electron child-frame API are inspected", async () => {
  assert.equal(
    navigation.isAllowedPortalUrl("https://iris.fbr.gov.pk/dashboard"),
    true,
  );
  for (const url of [
    "https://iris.fbr.gov.pk.evil.example",
    "http://iris.fbr.gov.pk",
    "https://evil.example/?iris.fbr.gov.pk",
    "file:///mock.html",
  ]) {
    assert.equal(navigation.isAllowedPortalUrl(url), false);
  }
  const called = [];
  const main = {
    url: "https://iris.fbr.gov.pk/dashboard",
    executeJavaScript: async () => {
      called.push("main");
      return { authenticated: true };
    },
  };
  const child = {
    url: "https://iris.fbr.gov.pk/return",
    executeJavaScript: async () => {
      called.push("child");
      return {};
    },
  };
  const external = {
    url: "https://help.example",
    executeJavaScript: async () => {
      throw new Error("MUST NOT READ");
    },
  };
  main.framesInSubtree = [main, child, external];
  const result = await navigation.probeFrames({
    isDestroyed: () => false,
    webContents: { mainFrame: main },
  });
  assert.deepEqual(called, ["main", "child"]);
  assert.equal(result.frames[2].skipped, "unapproved_origin");
  assert.deepEqual(await navigation.probeFrames(null), {
    frames: [],
    unavailable: "window_closed",
  });
});

test("read-only action whitelist cannot be used to submit or click arbitrary selectors", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "submit",
      selector: "button",
    });
    assert.equal(result.frames[0].actionResult.status, "unsupported_action");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

const mainSource = fs.readFileSync(
  path.join(__dirname, "../electron-connect/main.js"),
  "utf8",
);
const ast = ts.createSourceFile(
  "main.js",
  mainSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function functionSource(name) {
  const found = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `Function ${name} exists`);
  return found.getText(ast);
}
function sandbox(names, extras = {}) {
  // Both real-portal flows now read the effective autofill mode through one
  // resolver, so any test that exercises `getRealAutofillMode` must be given the
  // resolver too — otherwise the sandbox throws on a symbol the shipped code
  // defines at module scope.
  const autofillFlows = ["runLocalTaxAssistedFilingFlow", "runLocalTaxDryRunFlow"];
  if (
    autofillFlows.some((flow) => names.includes(flow)) &&
    !names.includes("resolveAutofillMode")
  ) {
    names = [...names, "resolveAutofillMode"];
  }
  const ctx = vm.createContext({
    console,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    ...extras,
  });
  for (const name of names) vm.runInContext(functionSource(name), ctx);
  return ctx;
}

test("main worker is single-flight even while the claim request is still pending", async () => {
  let release;
  let calls = 0;
  const ctx = sandbox(["runLocalWorkerCycle"], {
    localWorkerRunning: false,
    workerIdleAnnounced: false,
    launchState: { deviceAuthToken: "test-token" },
    getApiBaseUrl: () => "https://test.invalid",
    loadAgentState: () => ({}),
    pushStatus: () => {},
    claimNextLocalJob: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = ctx.runLocalWorkerCycle();
  await ctx.runLocalWorkerCycle();
  assert.equal(calls, 1);
  assert.equal(ctx.localWorkerRunning, true);
  release(null);
  await first;
  assert.equal(ctx.localWorkerRunning, false);
});

test("main retains SAME live BrowserWindow on start/reconnect without loadURL", async () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    taxRocketPartition: "persist:test",
    webContents: { getURL: () => "https://iris.fbr.gov.pk/dashboard" },
    loadURL: async () => calls.push("load"),
    show: () => {},
    focus: () => {},
    setTitle: () => {},
    close: () => calls.push("close"),
  };
  const ctx = sandbox(["createLoginWindow", "ensureWorkerWindow"], {
    loginWindowPromise: null,
    loginWindow: win,
    workerWindow: null,
    realPortalMode: true,
    AGENT_BUILD_TAG: "test",
    irisNavigation: navigation,
    launchState: {
      flow: "fbr",
      token: "test",
      apiBaseUrl: "https://test.invalid",
      deviceAuthToken: "registered",
      desktopAuthConfig: { useMockIris: false },
    },
    getWorkerPartition: () => "persist:test",
    resolveDesktopLoginUrl: () => "https://iris.fbr.gov.pk/",
    scheduleAutoCapture: () => {},
    startLocalWorkerLoop: () => {},
  });
  assert.equal(await ctx.createLoginWindow(true), win);
  assert.equal(await ctx.ensureWorkerWindow(), win);
  assert.deepEqual(calls, []);
});

test("real assisted AND dry-run dispatch to inspection before any legacy fill/submit code", async () => {
  // Phase 1 put real-portal autofill behind TAXROCKET_REAL_AUTOFILL. With the
  // flag off (the default) both flows must still behave exactly as before:
  // inspection only, and the legacy mock filler never reached.
  let called = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "off",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => {
        called++;
        return { paused: true };
      },
      runRealIrisAutofill: () => {
        throw new Error("Autofill must not run while the flag is off");
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );
  assert.equal((await ctx.runLocalTaxAssistedFilingFlow({}, {})).paused, true);
  assert.equal((await ctx.runLocalTaxDryRunFlow({ job: {} })).paused, true);
  assert.equal(called, 2);
});

test("a paused navigation checkpoint is never overridden by autofill", async () => {
  // Even with autofill enabled, a pause (OTP, PIN, unknown modal, wrong route)
  // must be returned untouched — filling a form the user has not been driven to
  // is how values land in the wrong return.
  let autofillCalls = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "live",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => ({
        paused: true,
        pauseAction: "portal_popup",
      }),
      runRealIrisAutofill: async () => {
        autofillCalls++;
        return { executionLog: [], result: {} };
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );
  assert.equal(
    (await ctx.runLocalTaxAssistedFilingFlow({}, {})).pauseAction,
    "portal_popup",
  );
  assert.equal(
    (await ctx.runLocalTaxDryRunFlow({ job: {} })).pauseAction,
    "portal_popup",
  );
  assert.equal(autofillCalls, 0, "autofill must not run behind a pause");
});

test("autofill runs only after an un-paused navigation check, and merges its log", async () => {
  let autofillCalls = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "dry",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => ({
        paused: false,
        executionLog: [{ step: "nav" }],
        result: { navigated: true },
      }),
      runRealIrisAutofill: async (_ctx, _job, mode) => {
        autofillCalls++;
        return {
          executionLog: [{ step: "real_autofill_result" }],
          result: { mode, summary: { filled: 3 } },
        };
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );

  const assisted = await ctx.runLocalTaxAssistedFilingFlow({}, {});
  assert.equal(assisted.paused, false);
  assert.equal(assisted.result.autofill.mode, "dry");
  assert.equal(
    assisted.result.navigated,
    true,
    "navigation result must be preserved",
  );
  // Arrays come back from the vm realm, so deepEqual's realm check would fail
  // on structurally identical values. Compare the joined steps instead.
  assert.equal(
    assisted.executionLog.map((e) => e.step).join(","),
    "nav,real_autofill_result",
  );

  const dryRun = await ctx.runLocalTaxDryRunFlow({ job: {} });
  assert.equal(dryRun.result.autofill.summary.filled, 3);
  assert.equal(autofillCalls, 2);
});

test("CSS timeout does not starve a valid text navigation fallback", async () => {
  await withPage(dashboard(), async (page, win) => {
    const ctx = sandbox([
      "splitSelectorAlternatives",
      "findAndClickByText",
      "clickSelectorWithTextSupport",
    ]);
    await ctx.clickSelectorWithTextSupport(
      win,
      "#absent-selector, text:Declaration",
      500,
    );
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
  });
});

test("legacy menu helper clicks the successfully resolved selector", async () => {
  for (const [fn, key] of [
    ["navigateIrisTopMenu", "topMenuSelector"],
    ["navigateIrisLeftCategory", "leftCategorySelector"],
  ]) {
    const clicks = [];
    const ctx = sandbox([fn], {
      setTimeout: (callback) => {
        callback();
      },
      buildActionSelectorChain: () => ["#menu"],
      trySelectorsInPriority: async () => ({ selector: "#menu" }),
      clickSelector: async (_win, selector) => clicks.push(selector),
    });
    await ctx[fn]({}, { [key]: "#menu" });
    assert.deepEqual(clicks, ["#menu"]);
  }
});

test("context failures are reported and logged instead of leaving a job silently queued", async () => {
  const calls = [];
  const ctx = sandbox(["processLocalJob"], {
    buildPortalEvidenceDiagnostics: navigation.buildPortalEvidenceDiagnostics,
    loadLocalJobContext: async () => {
      throw new Error("Queued approved packet unavailable");
    },
    saveFailureDump: async () => null,
    captureDomEvidence: async () => ({ frames: [] }),
    workerWindow: null,
    lastSectionTour: null,
    activeJobExecutionLog: null,
    STANDARD_LOG_STEPS: { FAILURE: "failure" },
    classifyRecoverableAssistedIssue: () => null,
    // The REAL evidence builder, not a stub: a job that fails must still record
    // what the capture proved (here: nothing) instead of inventing drift.
    buildSelectorDriftDiagnostics: () => null,
    getSelectorBundleSignal: () => null,
    buildRecoveryActions: () => [],
    updateLocalJobStatus: async (_id, status) => calls.push(status),
    writeJobLogToDisk: async () => {
      calls.push("log");
      return null;
    },
    cleanupJobDocuments: async () => calls.push("cleanup"),
    pushStatus: () => {},
  });
  await ctx.processLocalJob({
    id: "job-test",
    type: "tax_assisted_filing",
    status: "created",
  });
  assert.deepEqual(calls, ["failed", "log", "cleanup"]);
});

// ─── Phase 1.5a: setup-dialog deadlock ──────────────────────────────────────
// The agent opens the "Normal Return (Ind/AOP/COY)" dialog itself, then its own
// sensitiveControl heuristic classified it as protected, so every retry paused
// on portal_popup and close-welcome (a no-op here) looped forever.

const setupDialog = (
  extra = "",
) => `<div class="modal-backdrop" id="backdrop" style="pointer-events:none"></div>
<section role="dialog" class="mat-mdc-dialog-container" id="setup">
<h3 role="heading">Normal Return (Ind/AOP/COY)</h3>
<label>Period</label>
<input type="radio" name="period" id="p1"><label for="p1">01-Jul-2025 - 30-Jun-2026</label>
${extra}
<button onclick="actions.push('setup_continue')">Continue</button>
</section>`;

async function dialogKinds(html) {
  let kinds;
  await withPage(dashboard(html), async (_page, win) => {
    const probe = await navigation.probeFrames(win, {
      action: "inspect",
      taxYear: 2026,
    });
    kinds = probe.frames[0];
  });
  return kinds;
}

test("Phase 1.5a: a recognised setup dialog is tagged 'setup' and does not block navigation", async () => {
  const frame = await dialogKinds(setupDialog());
  assert.equal(frame.dialogs.length, 1);
  assert.equal(frame.dialogs[0].kind, "setup");
  assert.equal(frame.setupDialogOnly, true);
  assert.equal(frame.hasBlockingOverlay, false);
});

test("Phase 1.5a: a setup dialog carrying an OTP field stays protected and blocking", async () => {
  const frame = await dialogKinds(
    setupDialog('<label>OTP</label><input type="text" name="otp">'),
  );
  assert.equal(frame.dialogs[0].kind, "protected");
  assert.equal(frame.setupDialogOnly, false);
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: a setup dialog carrying a commit control stays blocking", async () => {
  const frame = await dialogKinds(setupDialog("<button>Submit</button>"));
  assert.notEqual(frame.dialogs[0].kind, "setup");
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: an unrecognised dialog still blocks exactly as before", async () => {
  const frame = await dialogKinds(
    `<section role="dialog" id="mystery"><h3>Something unfamiliar</h3><button>Ok</button></section>`,
  );
  assert.equal(frame.dialogs[0].kind, "unknown");
  assert.equal(frame.setupDialogOnly, false);
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: a live backdrop blocks even when the only dialog is setup", async () => {
  const frame = await dialogKinds(
    `<div class="modal-backdrop" id="live"></div>` + setupDialog(),
  );
  assert.equal(frame.dialogs[0].kind, "setup");
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: the setup dialog reaches the stage machine instead of looping on close-welcome", async () => {
  await withPage(dashboard(setupDialog()), async (page, win) => {
    const steps = [];
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      state: { newEntryOpened: true },
      onStep: (step) => steps.push(String(step)),
    });
    // The deadlock signature was: portal_popup plus four no-op close_welcome clicks.
    assert.notEqual(result.requiredAction, "portal_popup");
    assert.equal(
      (await page.evaluate("actions")).filter((a) => a === "close_welcome")
        .length,
      0,
    );
    assert.ok(
      steps.some((s) => s.startsWith("new_return_setup")),
      `stage machine was reached, got: ${steps.join(", ")}`,
    );
  });
});

// ─── Phase 1.5b: economic-transactions gate ─────────────────────────────────
// Reached from the blue dashboard tile at /nitr/summary-economic-transactions.
// Read-only to the agent: residency (ITO s.82-84) and the income-source ticks
// are the taxpayer's own declarations.

const gate = ({ checked = false, residency = false, enabled = false } = {}) =>
  `<!doctype html><html><body><app-summary-economic-transactions>
<app-source-checkbox><mat-checkbox><input type="checkbox" ${checked ? "checked" : ""}></mat-checkbox>Income from Salary</app-source-checkbox>
<app-source-checkbox><mat-checkbox><input type="checkbox"></mat-checkbox>Income from Business</app-source-checkbox>
<mat-radio-group aria-label="Select Residential Status">
<mat-radio-button><input type="radio" name="res" value="yes" ${residency ? "checked" : ""}></mat-radio-button>Yes
<mat-radio-button><input type="radio" name="res" value="no"></mat-radio-button>No
</mat-radio-group>
<div class="btn-start-wrapper">
<button class="btn btn-start" ${enabled ? "" : "disabled"}>Start Return Filling</button>
<button type="button" aria-label="Start Return Filling" class="btn-start-overlay"></button>
</div></app-summary-economic-transactions>
<script>window.actions=[]</script></body></html>`;

// ─── P3: what actually proves "the return is open" ───────────────────────────
// Structure taken from `IRIS 2.0 form3.html`: app-nitr-workflow > container-fluid
// > ... > app-wf-header, with Year / 114(1) / Registration No: inside the header.

const returnWorkspace = () =>
  `<!doctype html><html><body><app-nitr-workflow class="ng-star-inserted"><div class="container-fluid">
<div class="row"><div class="col-sm-12"><app-wf-header><div class="row">
<div class="col-9"><div class="col-12"><h6 class="font-purple margin-0">Year 2026</h6>
<p class="margin-0 font-13"><span> 114(1) (Return of Income filed voluntarily for complete year) </span></p></div></div>
<div class="col-6"><p class="margin-0"><b>Full Name:</b> PRIVATE TEST TAXPAYER NAME</p>
<p class="margin-0"><b>Registration No:</b> 4220144218163</p></div>
</div></app-wf-header></div></div>
<div class="tableRows dataRow" id="1009"><div class="data-middle-child-wapper"><input type="text" value="0"></div></div>
</div></app-nitr-workflow><script>window.actions=[]</script></body></html>`;

test("P3: the return-workspace probe separates the gate from an open return", async () => {
  await withPage(returnWorkspace(), async (page, windowInstance) => {
    const out = await windowInstance.webContents.executeJavaScript(
      navigation.RETURN_WORKSPACE_PROBE,
    );
    assert.equal(out.returnWorkspace, true, JSON.stringify(out));
    assert.deepEqual(out.evidence, {
      year: true,
      returnDocument: true,
      registration: true,
    });
    assert.ok(out.inputs >= 1, "the entered cell is counted for context");
  });

  await withPage(gate(), async (page, windowInstance) => {
    const out = await windowInstance.webContents.executeJavaScript(
      navigation.RETURN_WORKSPACE_PROBE,
    );
    // This is the exact false positive the count-visible-inputs readiness had:
    // the gate is full of inputs but is NOT a return that can be filled.
    assert.equal(out.inputs > 0, true, "the gate does expose visible inputs");
    assert.equal(out.returnWorkspace, false, JSON.stringify(out));
    assert.equal(out.reason, "app-nitr-workflow-absent");
  });

  await withPage(dashboard(), async (page, windowInstance) => {
    const out = await windowInstance.webContents.executeJavaScript(
      navigation.RETURN_WORKSPACE_PROBE,
    );
    assert.equal(out.returnWorkspace, false, "the dashboard is not a return either");
    assert.equal(out.reason, "app-nitr-workflow-absent");
  });
});

test("Phase 1.5b: the unanswered gate is recognised, authenticated, and lists what is missing", async () => {
  await withPage(gate(), async (page, win) => {
    const steps = [];
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.requiredAction, "portal_economic_transactions_gate");
    assert.equal(result.economicTransactionsGate.ready, false);
    assert.deepEqual(result.economicTransactionsGate.missing, [
      "income sources",
      "tax residency",
    ]);
    assert.equal(navigation.isAuthenticated(result.inspection), true);
    assert.equal(
      result.inspection.frames[0].readiness.evidence,
      "economic_transactions_gate",
    );
    // The agent must never answer the gate on the taxpayer's behalf.
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.equal(
      await page.evaluate("document.querySelectorAll('input:checked').length"),
      0,
    );
  });
});

test("Phase 1.5b: a partially answered gate reports only the outstanding half", async () => {
  await withPage(gate({ checked: true }), async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
    });
    assert.deepEqual(result.economicTransactionsGate.missing, [
      "tax residency",
    ]);
    assert.deepEqual(result.economicTransactionsGate.selectedSources, [
      "Income from Salary",
    ]);
  });
});

test("Phase 1.5b: an answered gate reports ready and still refuses to click Start", async () => {
  await withPage(
    gate({ checked: true, residency: true, enabled: true }),
    async (page, win) => {
      const result = await navigation.inspectNavigation(win, {
        taxYear: 2026,
        openReturn: true,
        taxpayerIdentifier: "1234567890123",
      });
      assert.equal(result.requiredAction, "portal_economic_transactions_gate");
      assert.equal(result.economicTransactionsGate.ready, true);
      assert.equal(result.economicTransactionsGate.residencySelected, true);
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("Phase 1.5b: the gate snapshot never carries the opaque session token", async () => {
  await withPage(gate(), async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
    });
    assert.ok(!JSON.stringify(result).includes("PRIVATE_URL_TOKEN"));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_HASH"));
  });
});

test("Phase 1.5: the in-page stage classifier mirror cannot drift from the module original", async () => {
  // portalProbe is serialized into the renderer, so it carries its own copy of
  // classifyNewReturnSetupStage. Both must agree on every stage.
  const cases = [
    { nodeLabels: ["Normal Return (Ind/AOP/COY)"], expected: "menu" },
    {
      prompts: ["Normal Return", "Simplified Return"],
      expected: "return_type",
    },
    { prompts: ["Resident"], expected: "residency" },
    { actions: ["Accept and Continue"], expected: "accept_continue" },
    { prompts: ["Period"], actions: ["Continue"], expected: "period" },
    // The live 2026-09-10 dialog. Its caption is "Tax Period", which is what the
    // agent used to miss, so it stopped at a dialog with nothing left to type.
    {
      prompts: ["Person", "Tax Period", "Normal Return (Ind/AOP/COY)"],
      actions: ["Cancel", "Continue"],
      expected: "period",
    },
    { prompts: ["Something else"], expected: null },
    {
      documentPresent: true,
      nodeLabels: ["Normal Return (Ind/AOP/COY)"],
      expected: null,
    },
  ];
  const source = navigation.portalProbe.toString();
  const mirror = source.slice(
    source.indexOf("const classifySetupStage"),
    source.indexOf("const isSafeAutoAdvanceStage"),
  );
  const classify = new Function(
    "input",
    `const setupLabel=(v)=>String(v||"").replace(/\\s+/g," ").trim().toLowerCase();${mirror}return classifySetupStage(input);`,
  );
  for (const { expected, ...input } of cases) {
    const descriptor = {
      documentPresent: false,
      prompts: [],
      actions: [],
      nodeLabels: [],
      ...input,
    };
    assert.equal(navigation.classifyNewReturnSetupStage(descriptor), expected);
    assert.equal(
      classify(descriptor),
      expected,
      `mirror disagrees for ${JSON.stringify(input)}`,
    );
  }
});

// ─── Phase 1.6: complete the tour, then let autofill run ────────────────────
// Dry-run 2026-09-09 reached Computations then paused on "Personal Assets /
// Liabilities: section panel not_found". The 116 Wealth Statement is a separate
// document, not a panel in the 114(1) workflow, so the tour could never finish
// and autofill was unreachable.

test("Phase 1.6: the section plan excludes the 116 Wealth Statement views", () => {
  assert.deepEqual(navigation.WEALTH_SECTION_IDS, [
    "wealth_assets",
    "wealth_reconciliation",
  ]);
  for (const id of navigation.WEALTH_SECTION_IDS)
    assert.ok(
      !navigation.INCOME_SECTION_IDS.includes(id),
      `${id} must not block the income tour`,
    );
  // Every section the live dry-run actually captured is still planned.
  for (const id of [
    "salary",
    "tax_deductions",
    "allowance_credits",
    "withholding",
    "computations",
  ])
    assert.ok(
      navigation.INCOME_SECTION_IDS.includes(id),
      `${id} must stay in the tour`,
    );
  // The plan must remain a valid subset in the original order, salary first.
  assert.equal(navigation.INCOME_SECTION_IDS[0], "salary");
  assert.deepEqual(
    navigation.INCOME_SECTION_IDS,
    navigation.ALL_SECTION_IDS.filter(
      (id) => !navigation.WEALTH_SECTION_IDS.includes(id),
    ),
  );
});

test("Phase 1.6: the agent requests the income plan, not the wealth-blocked one", () => {
  const source = functionSource("runLocalIrisNavigationCheck");
  assert.ok(
    source.includes("sectionIds: irisNavigation.INCOME_SECTION_IDS"),
    "navigation check must request the income section plan",
  );
  assert.ok(
    !source.includes("sectionIds: irisNavigation.ALL_SECTION_IDS"),
    "the wealth-blocked plan must no longer be requested",
  );
});

test("Phase 1.6: a completed section tour is not reported as paused", async () => {
  // portal_sections_inspected is success. While it was returned as paused, both
  // filing flows short-circuited on `navigation?.paused` and autofill could
  // never run, no matter what TAXROCKET_REAL_AUTOFILL was set to.
  const statuses = [];
  const ctx = sandbox(["runLocalIrisNavigationCheck"], {
    assertNavigatorBuild: () => {},
    AGENT_BUILD_TAG: "test-build",
    lastTourStateKey: null,
    lastNavigationOptions: {},
    ensureWorkerWindow: async () => ({ isDestroyed: () => false }),
    getLivePortalWindow: () => ({}),
    navigationStates: new Map(),
    irisNavigation: {
      ...navigation,
      inspectNavigation: async () => ({
        inspection: { frames: [{ document: { present: true } }] },
        requiredAction: "portal_sections_inspected",
      }),
    },
    writePortalInspectionToDisk: () => "C:/logs/inspection.json",
    getSelectorBundleSignal: () => null,
    ensureNavigationJobActive: async () => {},
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    pushStatus: () => {},
    launchState: { accountReference: "1234567890123" },
    realPortalMode: true,
    activeJobExecutionLog: null,
    buildNewReturnContext: () => ({}),
    captureWindowScreenshot: async () => null,
  });
  const outcome = await ctx.runLocalIrisNavigationCheck(
    { filingPacket: { taxYear: 2026, snapshot: {} }, taxAutomationConfig: {} },
    { id: "job-1" },
  );
  assert.equal(
    outcome.paused,
    false,
    "a completed tour must not block autofill",
  );
  assert.equal(outcome.pauseAction, "portal_sections_inspected");
  assert.equal(outcome.result.navigationVerified, true);
  assert.equal(outcome.result.sectionTourComplete, true);
  assert.equal(outcome.result.submitted, false);
  assert.ok(
    !statuses.includes("awaiting_user_action"),
    "a completed tour must not be recorded as awaiting the user",
  );
});

test("Phase 1.6: with autofill off, a completed tour still parks the job for review", async () => {
  // Navigation succeeded but nothing was filled, so the job is finished work
  // awaiting the user — it must not be left silently running or marked done.
  const statuses = [];
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "off",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "done",
      result: {},
      executionLog: [],
    }),
    runRealIrisAutofill: () => {
      throw new Error("Autofill must not run while the flag is off");
    },
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.deepEqual(statuses, ["awaiting_user_action"]);
});

test("Phase 1.6: with dry-run on, a completed tour hands off to autofill", async () => {
  let mode = null;
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "dry",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "done",
      result: { navigationVerified: true },
      executionLog: [{ step: "nav" }],
    }),
    runRealIrisAutofill: async (_c, _j, m) => {
      mode = m;
      return {
        executionLog: [{ step: "fill" }],
        result: { mode: m, summary: { filled: 3 } },
      };
    },
    updateLocalJobStatus: async () => {},
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(mode, "dry", "autofill must receive the dry-run mode");
  assert.equal(outcome.paused, false);
  assert.equal(outcome.executionLog.map((s) => s.step).join(","), "nav,fill");
  assert.equal(outcome.result.autofill.summary.filled, 3);
});

test("Phase 1.6: a genuine checkpoint still pauses and is still recorded", async () => {
  const statuses = [];
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "dry",
    runLocalIrisNavigationCheck: async () => ({
      paused: true,
      pauseAction: "portal_section_navigation",
    }),
    runRealIrisAutofill: () => {
      throw new Error("Autofill must not run behind a pause");
    },
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.equal(outcome.pauseAction, "portal_section_navigation");
  // finishNavigationOnly must not re-record an already-paused checkpoint.
  assert.deepEqual(statuses, []);
});

// ─── Phase 2a: fill the section that owns each code ─────────────────────────
// Dry-run 2026-09-09 filled 0/27. The tour ends on Attachment (no data rows)
// and the filler only sees the section on screen, so codes that genuinely exist
// and are editable on Salary were reported row_not_found.

const tourFixture = {
  complete: true,
  sections: [
    {
      id: "salary",
      rows: [{ code: "1000" }, { code: "1009" }, { code: "1049" }],
    },
    { id: "withholding", rows: [{ code: "640000" }, { code: "64150002" }] },
    { id: "computations", rows: [{ code: "9201" }] },
    { id: "attachment", rows: [] },
  ],
};

test("Phase 2a: codes are grouped by the section that actually showed them", () => {
  const index = navigation.buildSectionCodeIndex(tourFixture);
  assert.equal(index.get("1000"), "salary");
  assert.equal(index.get("64150002"), "withholding");
  assert.equal(index.get("9201"), "computations");
  assert.equal(
    index.get("999999"),
    undefined,
    "an unseen code must not resolve",
  );

  const { groups, unlocated } = navigation.planSectionFills(
    [
      { irisCode: "9201" },
      { irisCode: "1000" },
      { irisCode: "640000" },
      { irisCode: "1009" },
      { irisCode: "999999" },
    ],
    tourFixture,
  );
  // Tour order, not packet order: navigation moves forward through the return.
  assert.equal(
    groups.map((g) => g.sectionId).join(","),
    "salary,withholding,computations",
  );
  assert.equal(groups[0].fields.map((f) => f.irisCode).join(","), "1000,1009");
  assert.equal(unlocated.map((f) => f.irisCode).join(","), "999999");
});

test("Phase 2a: an unseen code is never guessed into a section", () => {
  const { groups, unlocated } = navigation.planSectionFills(
    [{ irisCode: "5028" }, { irisCode: "" }, {}],
    tourFixture,
  );
  assert.equal(groups.length, 0);
  assert.equal(
    unlocated.length,
    3,
    "every unresolvable field must be reported, not dropped",
  );
});

test("Phase 2a: an empty or missing tour yields no targets rather than a wrong one", () => {
  for (const tour of [null, undefined, {}, { sections: [] }]) {
    const { groups, unlocated } = navigation.planSectionFills(
      [{ irisCode: "1000" }],
      tour,
    );
    assert.equal(groups.length, 0);
    assert.equal(unlocated.length, 1);
  }
});

test("Phase 2a: navigateToSection refuses an unknown section and never clicks", async () => {
  const result = await navigation.navigateToSection(
    {},
    { sectionId: "not_a_section" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported_section");
});

test("Phase 2a: navigateToSection reports rather than filling the showing grid", async () => {
  await withPage(dashboard(), async (_page, win) => {
    // No return document is open, so there is nothing to switch.
    const result = await navigation.navigateToSection(win, {
      sectionId: "salary",
      taxYear: 2026,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "document_not_open");
  });
});

test("Phase 2a: autofill walks each owning section and never fills the last-viewed grid", async () => {
  const visited = [];
  const filled = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      // Autofill now proves the return workspace is open before it touches a
      // section, so the stub window has to answer that probe.
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: navigation,
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({
        total: results.length,
        filled: 0,
        skipped: results.length,
      }),
      describeFillSummary: () => "summary",
      fillIrisRows: async (_win, fields) => {
        filled.push(fields.map((f) => f.irisCode).join(","));
        return {
          results: fields.map((f) => ({ ...f, status: "filled" })),
          summary: {},
        };
      },
    },
  });
  // navigateToSection is on the real module; stub only the movement.
  ctx.irisNavigation = {
    ...navigation,
    navigateToSection: async (_win, { sectionId }) => {
      visited.push(sectionId);
      return { ok: true, status: "switched" };
    },
  };
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "9201", label: "c" },
            { irisCode: "1000", label: "a" },
            { irisCode: "1009", label: "b" },
            { irisCode: "5028", label: "unseen" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(
    visited.join(","),
    "salary,computations",
    "sections visited in tour order",
  );
  assert.equal(filled.join(" | "), "1000,1009 | 9201");
  // The unseen code is reported, never filled into whatever grid was showing.
  const unseen = outcome.result.results.find((r) => r.irisCode === "5028");
  assert.equal(unseen.status, "row_not_found");
  assert.equal(unseen.sectionId, null);
  assert.equal(
    outcome.result.results.length,
    4,
    "every packet field is accounted for",
  );
});

test("Phase 2a: a section that will not open leaves its fields untouched", async () => {
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      // Autofill now proves the return workspace is open before it touches a
      // section, so the stub window has to answer that probe.
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: {
      ...navigation,
      navigateToSection: async () => ({ ok: false, status: "tab_not_found" }),
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({
        total: results.length,
        filled: 0,
        skipped: results.length,
      }),
      describeFillSummary: () => "summary",
      fillIrisRows: async () => {
        throw new Error("must not fill a section that did not open");
      },
    },
  });
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: { portalFieldMap: [{ irisCode: "1000" }] },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(outcome.result.results[0].status, "row_not_found");
  assert.equal(outcome.result.results[0].sectionStatus, "tab_not_found");
});

test("Phase 2a: navigateToSection unlocks the navigation allowlist (openReturn)", async () => {
  // Dry-run 2026-09-09 #4: every section click returned
  // "data_tab_navigation_not_enabled" because navigateToSection probed without
  // openReturn, and portalProbe gates the whole navigation action allowlist on
  // it. The plan was correct; the clicks were refused before they were tried.
  const seen = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => "https://iris.fbr.gov.pk/nitr/workflow",
      executeJavaScript: async (source) => {
        const options = JSON.parse(
          source.slice(source.lastIndexOf("})(") + 3, -1),
        );
        seen.push(options);
        return {
          document: { present: true },
          section: { id: "attachment", dataViewActive: false, navigation: [] },
          actionResult: {
            action: options.action || "inspect",
            status: "read_only",
          },
        };
      },
    },
  };
  fakeWindow.webContents.mainFrame = {
    url: "https://iris.fbr.gov.pk/nitr/workflow",
    executeJavaScript: fakeWindow.webContents.executeJavaScript,
  };
  fakeWindow.webContents.mainFrame.framesInSubtree = [
    fakeWindow.webContents.mainFrame,
  ];

  await navigation.navigateToSection(fakeWindow, {
    sectionId: "salary",
    taxYear: 2026,
  });
  assert.ok(seen.length > 0, "the section switch must actually probe the page");
  for (const options of seen)
    assert.equal(
      options.openReturn,
      true,
      "every probe must carry openReturn or portalProbe refuses the click",
    );
});

// ─── P2: drift must be EVIDENCE, not a substring ────────────────────────────
// Shapes copied from the operator's live capture (latest-portal-inspection.json):
// every section "captured" with rows, six of seven `structure_changed`.

const liveTourSections = (overrides = {}) => ({
  sections: [
    { id: "salary", status: "captured", transition: "salary_verified", rows: new Array(8), grids: [{}], mappingVerified: true },
    { id: "tax_deductions", status: "captured", transition: "structure_changed", rows: new Array(9), grids: [{}, {}, {}], mappingVerified: false },
    { id: "allowance_credits", status: "captured", transition: "structure_changed", rows: new Array(3), grids: [{}, {}, {}], mappingVerified: false },
    { id: "withholding", status: "captured", transition: "structure_changed", rows: new Array(7), grids: [{}, {}, {}, {}], mappingVerified: false },
    { id: "computations", status: "captured", transition: "structure_changed", rows: new Array(7), grids: [{}], mappingVerified: false },
    { id: "payment", status: "captured", transition: "structure_changed", rows: [], grids: [], mappingVerified: false },
    { id: "attachment", status: "captured", transition: "structure_changed", rows: [], grids: [], mappingVerified: false },
    ...(overrides.extraSections || []),
  ],
});

test("P2: the live pilot's refusal run is NOT selector drift", () => {
  const build = navigation.buildPortalEvidenceDiagnostics;
  const ctx = sandbox([
    "buildSelectorDriftDiagnostics",
    "buildMappingRefusalDiagnostics",
    "classifyRecoverableAssistedIssue",
    "looksLikeSessionReconnectNeeded",
    "inferLikelySelectorGroup",
    "getSelectorBundleSignal",
  ]);

  const evidence = build(liveTourSections());
  assert.equal(evidence.state, "structure_unverified", JSON.stringify(evidence));
  assert.deepEqual(evidence.drifted, [], "rows were present everywhere → no drift");
  // payment/attachment render no grids by design: they must not count as drift.
  assert.ok(!evidence.sections.some((s) => s.id === "payment" && evidence.drifted.includes("payment")));

  const refusalLog = [
    { step: "real_autofill_skip", detail: '1000 "Total Income from Salary" -> column_disabled (column: Total Amount)' },
    { step: "real_autofill_skip", detail: '1009 "Pay, Wages" -> column_disabled (column: Total Amount)' },
    { step: "real_autofill_skip", detail: '5028 "Other Receipts" -> row_not_found' },
  ];
  const classified = ctx.classifyRecoverableAssistedIssue(
    'Field fill failed: selector "#1000 input" matched nothing.',
    refusalLog,
    {},
    evidence,
  );
  assert.equal(classified.requiredAction, "portal_mapping_review");
  assert.equal(classified.selectorDriftDiagnostics, null);
  assert.equal(classified.mappingRefusalDiagnostics.refusalCount, 3);

  // Even with no refusals, the mere word "selector" plus an intact structure
  // must not produce a drift verdict.
  const driftless = ctx.buildSelectorDriftDiagnostics(
    'selector "#1000 input" did not resolve',
    [],
    {},
    evidence,
  );
  assert.equal(driftless, null, "intact structure ⇒ not drift, whatever the message says");
});

test("P2: rows that must exist but are missing IS drift, and the message is specific", () => {
  const build = navigation.buildPortalEvidenceDiagnostics;
  const ctx = sandbox([
    "buildSelectorDriftDiagnostics",
    "buildMappingRefusalDiagnostics",
    "classifyRecoverableAssistedIssue",
    "looksLikeSessionReconnectNeeded",
    "inferLikelySelectorGroup",
    "getSelectorBundleSignal",
  ]);
  const collapsed = build(
    liveTourSections({
      extraSections: [
        { id: "salary", status: "captured", transition: "structure_changed", rows: [], grids: [], mappingVerified: false },
      ],
    }),
  );
  assert.equal(collapsed.state, "rows_missing");
  assert.deepEqual(collapsed.drifted, ["salary"]);

  const drift = ctx.buildSelectorDriftDiagnostics(
    "Timed out waiting for selector #1009",
    [],
    { job: { payload: { selectorBundle: { bundleId: "b1" } } } },
    collapsed,
  );
  assert.equal(drift.reasonCode, "selector_drift_confirmed_by_capture");
  assert.match(drift.recommendedActions.join(" "), /rendered zero rows/s);

  // No capture at all → honest "suspected", never "confirmed".
  const blind = ctx.buildSelectorDriftDiagnostics(
    "Timed out waiting for selector #1009",
    [],
    {},
    build(null),
  );
  assert.equal(blind.reasonCode, "selector_drift_suspected");
  // main.js must not grow its own copy of the section rules.
  assert.match(mainSource, /const buildPortalEvidenceDiagnostics =\s*irisNavigation\.buildPortalEvidenceDiagnostics;/);
  assert.ok(
    !/const ROW_BEARING_SECTION_IDS = \[/.test(mainSource),
    "row-bearing section rules live in iris-navigation.js only",
  );
});

// ─── P4/P3: the config flag is a kill switch, live needs verified structure ──

test("P4.2: livePilot.automaticFilingEnabled downgrades live to dry", () => {
  // The REAL getRealAutofillMode, fed by env — the resolver is worthless if its
  // own input is stubbed away.
  const env = { TAXROCKET_REAL_AUTOFILL: "live" };
  const ctx = sandbox(["resolveAutofillMode", "getRealAutofillMode"], {
    process: { env },
  });
  const blocked = ctx.resolveAutofillMode({
    taxAutomationConfig: { livePilot: { automaticFilingEnabled: false } },
  });
  assert.equal(blocked.mode, "dry");
  assert.equal(blocked.downgradedFrom, "live");
  assert.match(blocked.note, /automaticFilingEnabled=false/);

  const allowed = ctx.resolveAutofillMode({
    taxAutomationConfig: { livePilot: { automaticFilingEnabled: true } },
  });
  assert.equal(allowed.mode, "live", "the flag never enables writes on its own");
  assert.equal(allowed.downgradedFrom, null);

  // Absent/null must not block — the mock and older bundles omit the whole shape.
  for (const context of [
    {},
    { taxAutomationConfig: {} },
    { taxAutomationConfig: { livePilot: { automaticFilingEnabled: null } } },
  ]) {
    assert.equal(
      ctx.resolveAutofillMode(context).mode,
      "live",
      `${JSON.stringify(context)} must leave the env var authoritative`,
    );
  }

  // "off" is never upgraded, and dry is never downgraded further.
  env.TAXROCKET_REAL_AUTOFILL = "off";
  const off = sandbox(["resolveAutofillMode", "getRealAutofillMode"], {
    process: { env },
  }).resolveAutofillMode({
    taxAutomationConfig: { livePilot: { automaticFilingEnabled: true } },
  });
  assert.equal(off.mode, "off");
});

test("P1 gate: live refuses a section the tour could not verify, dry still reports it", async () => {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }],
        mappingVerified: false,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  const makeCtx = (fillerStub) =>
    sandbox(["runRealIrisAutofill"], {
      ensureWorkerWindow: async () => ({
        isDestroyed: () => false,
        webContents: {
          executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
        },
      }),
      launchState: { accountReference: "1234567890123" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      irisNavigation: {
        ...navigation,
        navigateToSection: async () => ({ ok: true, status: "switched" }),
      },
      irisRowFiller: {
        FILL_STATUS: {
          FILLED: "filled",
          ROW_NOT_FOUND: "row_not_found",
          UNVERIFIED_TARGET: "unverified_target",
        },
        summarise: (results) => ({
          total: results.length,
          filled: results.filter((r) => r.status === "filled").length,
          skipped: results.filter((r) => r.status !== "filled").length,
        }),
        describeFillSummary: () => "summary",
        ...fillerStub,
      },
    });
  const packet = () => ({
    filingPacket: {
      taxYear: 2026,
      snapshot: { portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "1000" }] },
    },
  });

  let fillCalls = 0;
  const live = await makeCtx({
    fillIrisRows: async () => {
      fillCalls += 1;
      return { results: [], summary: {} };
    },
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.equal(fillCalls, 0, "live must not inject into an unverified section");
  assert.equal(live.result.results[0].status, "unverified_target");
  assert.equal(live.result.summary.filled, 0);

  let dryCalls = 0;
  await makeCtx({
    fillIrisRows: async () => {
      dryCalls += 1;
      return { results: [], summary: {} };
    },
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "dry");
  assert.equal(dryCalls, 1, "a dry run exists precisely to inspect unverified targets");
});

test("P3.2: real-portal readiness never falls through to the mock-era selector chain", () => {
  assert.match(
    mainSource,
    /if \(realPortalMode\) \{[\s\S]{0,700}?return \{\s*steps: iris2\.steps,\s*formReady: false,/,
    "the real-portal branch must return, not fall through",
  );
  assert.ok(
    !/Fall through to the legacy chain/.test(mainSource),
    "the old fall-through comment/behaviour is gone",
  );
});

test("P4.4: mapping gaps ride from the packet to the approval screen", () => {
  const action = fs
    .readFileSync(path.join(__dirname, "../app/actions/packet.ts"), "utf8")
    .replace(/\s+/g, " ");
  assert.match(
    action,
    /const mappingGaps = \(snapshot\.portalFieldMap && snapshot\.portalFieldMap\.mappingGaps\) \|\| null;/,
    "generate must read the gaps off the snapshot it just built",
  );
  assert.match(
    action,
    /packet: \{ \.\.\.serializePacketMoney\(packet\), mappingGaps, coverage \}/,
    "generate must return the gaps and the coverage verdict with them",
  );
  // The override only means anything if the record of it travels with the packet.
  assert.match(
    action,
    /const coverage = coverageGate\.coverage;/,
    "the verdict the gate reached is the verdict the snapshot stored",
  );
  assert.match(
    action,
    /mappingGaps = snapshot\.portalFieldMap\?\.mappingGaps \?\? null;/,
    "fetch must re-read them from the stored snapshot",
  );

  const config = fs
    .readFileSync(
      path.join(__dirname, "../components/tax/filing/config/filing-wizard-config.ts"),
      "utf8",
    )
    .replace(/\s+/g, " ");
  assert.match(config, /mappingGaps\?: PortalMappingGaps \| null;/, "summary type carries the gaps");

  const step = fs
    .readFileSync(path.join(__dirname, "../components/tax/filing/wizard-packet-step.tsx"), "utf8")
    .replace(/\s+/g, " ");
  assert.match(step, /<PortalMappingGapNotice gaps=\{filingPacket\?\.mappingGaps\} \/>/);
  assert.match(step, /Manual entry still required/);
});

test("P3.4: autofill holds when the return workspace cannot be proven", async () => {
  let fillCalls = 0;
  let sectionVisits = 0;
  const probes = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (script) => {
          probes.push(String(script));
          return { returnWorkspace: false, reason: "app-nitr-workflow-absent" };
        },
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: {
      ...navigation,
      navigateToSection: async () => {
        sectionVisits += 1;
        return { ok: true, status: "switched" };
      },
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({ total: results.length, filled: 0, skipped: results.length }),
      describeFillSummary: () => "summary",
      fillIrisRows: async () => {
        fillCalls += 1;
        return { results: [], summary: {} };
      },
    },
  });

  const held = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "1009", column: "Total Amount", value: "1000" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );

  assert.equal(held.paused, true);
  assert.equal(held.pauseAction, "portal_state_confirmation");
  assert.equal(fillCalls, 0, "nothing may be written into an unproven page");
  assert.equal(sectionVisits, 0, "the section tour is pointless off the return");
  assert.ok(
    probes.length === 1 && /app-nitr-workflow/.test(probes[0]),
    "the shared RETURN_WORKSPACE_PROBE is what decided this",
  );
  assert.match(
    held.executionLog.map((entry) => entry.detail).join(" "),
    /nothing was filled and no section tour was attempted/,
  );

  // The flow must turn that hold into a job the operator can act on, not a
  // "completed" run that filled nothing.
  const statuses = [];
  const flowCtx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "finishNavigationOnly",
      "resolveAutofillMode",
      "getRealAutofillMode",
    ],
    {
      process: { env: { TAXROCKET_REAL_AUTOFILL: "live" } },
      realPortalMode: true,
      updateLocalJobStatus: async (_id, status) => statuses.push(status),
      runLocalIrisNavigationCheck: async () => ({ paused: false, executionLog: [], result: {} }),
      runRealIrisAutofill: async () => ({
        paused: true,
        pauseAction: "portal_state_confirmation",
        pauseMessage: "Return workspace not proven.",
        executionLog: [],
        result: {},
      }),
    },
  );
  const flowOut = await flowCtx.runLocalTaxAssistedFilingFlow({}, { id: "job-1" });
  assert.equal(flowOut.paused, true);
  assert.deepEqual(statuses, ["awaiting_user_action"], "the hold is recorded, not swallowed");
});

// The dialog from the operator's screenshot, reproduced structurally: Material
// renders field captions as <mat-label> (never a bare <label>), the Person box is
// disabled, Tax Period is already filled by IRIS, and the dialog sits on its own
// overlay backdrop. Every one of those facts defeated a different guard.
const returnSetupDialog = ({ period = "2026", filled = true, extra = "" } = {}) =>
  `
<div class="modal-backdrop" id="backdrop"></div>
<section role="dialog" class="mat-mdc-dialog-container">
<h2 class="mdc-dialog__title">Normal Return (Ind/AOP/COY)</h2>
<div class="mat-mdc-form-field"><mat-label>Person</mat-label>
<input class="mdc-text-field__input" value="4220144218163" disabled></div>
<div class="mat-mdc-form-field"><mat-label>Tax Period</mat-label>
<input class="mdc-text-field__input" id="period" value="${filled ? period : ""}"></div>
${extra}
<button onclick="actions.push('CANCEL')">Cancel</button>
<button onclick="actions.push('CONTINUE')">Continue</button>
</section>`;

const setupProbeOptions = {
  taxYear: 2026,
  taxpayerIdentifier: "4220144218163",
  openReturn: true,
};

test("a prefilled TY2026 new-return dialog is recognised as a setup stage", async () => {
  await withPage(dashboard(returnSetupDialog()), async (page, win) => {
    const frame = (await navigation.probeFrames(win, { taxYear: 2026 })).frames[0];
    assert.equal(
      frame.newReturnSetup.prompts.includes("Tax Period"),
      true,
      "the caption must reach the classifier at all",
    );
    assert.equal(frame.setupDialogOnly, true, "one recognised setup dialog, nothing else");
    // Conservative for everyone else: the overlay is still reported as blocking.
    assert.equal(frame.hasBlockingOverlay, true);
  });
});

test("the agent advances the setup dialog by clicking Continue", async () => {
  await withPage(dashboard(returnSetupDialog()), async (page, win) => {
    const frame = (
      await navigation.probeFrames(win, {
        ...setupProbeOptions,
        action: "new-return-continue",
      })
    ).frames[0];
    assert.equal(
      frame.actionResult.status,
      "clicked",
      "the dialog's own backdrop must not deadlock its Continue button",
    );
    assert.deepEqual(await page.evaluate("actions"), ["CONTINUE"]);
  });
});

test("a period suggestion panel cannot block the recognised setup Continue", async () => {
  await withPage(
    dashboard(
      returnSetupDialog({
        extra: `<div style="position:fixed;inset:0;z-index:40;background:transparent"></div>`,
      }),
    ),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(frame.actionResult.status, "clicked");
      assert.deepEqual(await page.evaluate("actions"), ["CONTINUE"]);
    },
  );
});

test("a setup dialog with a box left empty is not advanced", async () => {
  await withPage(
    dashboard(returnSetupDialog({ filled: false })),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(frame.setupDialogOnly, false, "an empty field is a human question");
      assert.equal(frame.actionResult.status, "blocked_by_dialog");
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("a setup dialog naming a different tax year is not advanced", async () => {
  await withPage(
    dashboard(returnSetupDialog({ period: "2025" })),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(
        frame.actionResult.status,
        "blocked_by_dialog",
        "opening 2025 instead of the packet's 2026 would file the wrong return",
      );
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("verification dialogs keep blocking even beside a recognised setup caption", async () => {
  await withPage(
    dashboard(returnSetupDialog({ extra: `<input type="password" value="x">` })),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(frame.setupDialogOnly, false);
      assert.equal(frame.actionResult.status, "blocked_by_dialog");
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});
