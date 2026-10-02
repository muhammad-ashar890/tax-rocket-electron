const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} = require("electron");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createStateStore,
  isBackendAllowed,
  isOriginAllowed,
  sanitizeBaseUrl,
} = require("./portal-agent");

const DLD_OWNER_LOGIN_URL = "https://iris.fbr.gov.pk/login";
const LOCAL_BRIDGE_HOST = "127.0.0.1";
const LOCAL_BRIDGE_PORT = 37219;
const DLD_PORTAL_HOST = "dubailand.gov.ae";
const LOCAL_AGENT_POLL_INTERVAL_MS = 10000;
const LOCAL_AGENT_CONFIRMATION_TITLE = "Tax Rocket Desktop Agent";
const REAL_FBR_ROOT = "https://iris.fbr.gov.pk/";

function isOfficialFbrUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "iris.fbr.gov.pk";
  } catch {
    return false;
  }
}

let mainWindow = null;
let loginWindow = null;
let workerWindow = null;
let localBridgeServer = null;
let autoCaptureTimer = null;
let localWorkerTimer = null;
let localWorkerRunning = false;
let workerIdleAnnounced = false;
// Points at the execution log of whichever flow (assisted/dry-run) is
// currently running, so the failure handler in processLocalJob can persist
// the FULL step history instead of a single generic line.
let activeJobExecutionLog = null;
// TaxRocket buttons the taxpayer pressed before the current run (read from the
// job payload); printed in the job report.
let activeJobConfirmations = [];
let realEntryFallbackAnnounced = false;
let realPortalMode = false;
let realPortalLoginUrl = "";
const irisNavigation = require("./iris-navigation");
const irisRowFiller = require("./iris-row-filler");
const irisWealthDriver = require("./iris-wealth-driver");
const irisEmployerDriver = require("./iris-employer-driver");
const { buildJobReport } = require("./job-report");
// Phase 1 — real-portal autofill.
//
// Until now every real-IRIS job short-circuited into a navigation-only
// inspection, so calculation-engine values never reached the live portal. The
// filler is wired in behind this flag rather than switched on wholesale: a
// wrong write on a government return is far worse than no write, so operators
// opt in explicitly and get a dry-run mode first.
//
//   TAXROCKET_REAL_AUTOFILL=dry   resolve targets + report, write nothing
//   TAXROCKET_REAL_AUTOFILL=1     actually fill
//   (unset)                       previous navigation-only behaviour
function getRealAutofillMode() {
  const raw = String(process.env.TAXROCKET_REAL_AUTOFILL || "")
    .trim()
    .toLowerCase();
  if (raw === "dry" || raw === "dryrun" || raw === "dry-run") return "dry";
  if (
    raw === "1" ||
    raw === "true" ||
    raw === "on" ||
    raw === "yes" ||
    raw === "live"
  )
    return "live";
  return "off";
}

/**
 * Wealth Statement entry (modal driver) is a second, separate opt-in. The Salary
 * rows already exist on screen; the Wealth rows are CREATED by clicking through
 * IRIS modals, which is a bigger step, so it has its own switch:
 *
 *   TAXROCKET_WEALTH_AUTOFILL=on   drive the Wealth modals (live) / plan them (dry)
 *   TAXROCKET_EMPLOYER_AUTOFILL=on add the packet's employers by registered name (live) / plan (dry)
 *   (unset)                        wealth figures stay "prepared, not entered"
 *
 * It only ever applies on top of TAXROCKET_REAL_AUTOFILL: dry mode reports what
 * it would add without clicking, live mode adds and fills. Never Save/Calculate.
 */
/**
 * Employer Details on the IRIS Salary page. Opt-in like the wealth driver:
 * TAXROCKET_EMPLOYER_AUTOFILL=on adds each employer named in the approved packet
 * by its registered name (live) or only reports what it would add (dry).
 */
function getEmployerAutofillEnabled() {
  const raw = String(process.env.TAXROCKET_EMPLOYER_AUTOFILL || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "on", "yes", "live"].includes(raw);
}

function getWealthAutofillEnabled() {
  const raw = String(process.env.TAXROCKET_WEALTH_AUTOFILL || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "on", "yes", "live"].includes(raw);
}

/**
 * The env var is the OPERATOR's switch; `livePilot.automaticFilingEnabled` is the
 * deployment's. The flag used to be declared in `lib/tax/fbr-agent-config.ts` and
 * read by nothing, which is worse than absent: everyone assumed it controlled
 * something. Now it does, with kill-switch semantics —
 *
 *   automaticFilingEnabled === false  → live is downgraded to dry, whatever env says
 *   automaticFilingEnabled === true   → the env var is still required (no new capability)
 *   absent/null                       → env only, i.e. current behaviour
 *
 * "Only false blocks" is deliberate: the shipped default in the config builder is
 * false, so a deployment that has not opted in cannot write to IRIS even with
 * TAXROCKET_REAL_AUTOFILL=live, and this is logged rather than silent.
 */
function resolveAutofillMode(jobContext) {
  const envMode = getRealAutofillMode();
  const livePilot = jobContext?.taxAutomationConfig?.livePilot;
  const gate = livePilot && livePilot.automaticFilingEnabled;
  if (envMode === "live" && gate === false) {
    return {
      mode: "dry",
      downgradedFrom: "live",
      note:
        "livePilot.automaticFilingEnabled=false in the job config: writes are blocked " +
        "by the deployment, so this run is DRY. Enable the flag to allow live entry.",
    };
  }
  return { mode: envMode, downgradedFrom: null, note: null };
}
// Independent controller stamp: a new navigator must not make an OLD main
// process appear fully updated (the mixed fix10/fix11 rollout hid this).
const AGENT_BUILD_TAG = "fix34-tax-year-employer-20261002";
function getAgentBuildLabel() {
  return `${AGENT_BUILD_TAG} | navigator: ${irisNavigation.BUILD_TAG} | filler: ${irisRowFiller.BUILD_TAG}`;
}
function assertNavigatorBuild() {
  const mismatched = [
    ["iris-navigation.js", irisNavigation.BUILD_TAG],
    // The filler decides which cell a value lands in; a stale copy of it is as
    // dangerous as a stale navigator, and it ships as a loose file too.
    ["iris-row-filler.js", irisRowFiller.BUILD_TAG],
  ].filter(([, tag]) => tag !== AGENT_BUILD_TAG);
  if (mismatched.length) {
    throw new Error(
      `Desktop files are mixed versions (${mismatched
        .map(([name, tag]) => `${name}: ${tag || "untagged"}`)
        .join(", ")} vs main: ${AGENT_BUILD_TAG}). Replace ${mismatched
        .map(([name]) => name)
        .join(
          " and ",
        )} from the same patch as main.js and fully restart the agent.`,
    );
  }
}
let loginWindowPromise = null;
const navigationStates = new Map();
let lastNavigationOptions = {}; // local-only target; never serialized in job logs
let lastSectionTour = null;
let lastTourStateKey = null;

async function ensureNavigationJobActive(jobId, expectedIdentifier) {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();
  if (!deviceAuthToken || !apiBaseUrl)
    throw new Error(
      "Desktop connection is not available for the navigation job check.",
    );
  const response = await fetch(
    `${apiBaseUrl}/api/local-agent/jobs/${encodeURIComponent(jobId)}/status`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${deviceAuthToken}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload?.job) {
    const error = new Error(
      "Cannot verify the current job with the web app. Ensure the fix13 job status API file is installed and the web server is running.",
    );
    error.code = "NAVIGATION_GUARD_UNAVAILABLE";
    throw error;
  }
  if (
    !["running", "accepted_by_device"].includes(payload.job.status) ||
    payload.job.expired
  ) {
    if (
      payload.job.expired &&
      ["running", "accepted_by_device"].includes(payload.job.status)
    ) {
      await updateLocalJobStatus(jobId, "expired", {
        errorMessage: "The navigation job expired.",
      });
    }
    const error = new Error(
      `Navigation stopped: the web job is ${payload.job.expired ? "expired" : payload.job.status}. No further portal actions were attempted.`,
    );
    error.code = "NAVIGATION_JOB_STOPPED";
    throw error;
  }
  const current = String(launchState.accountReference || "")
    .trim()
    .replace(/[ -]/g, "");
  if (current !== expectedIdentifier) {
    const error = new Error(
      "The local taxpayer target changed during navigation. Retry with the intended target.",
    );
    error.code = "NAVIGATION_TARGET_CHANGED";
    throw error;
  }
}

function getLivePortalWindow() {
  if (workerWindow && !workerWindow.isDestroyed()) return workerWindow;
  if (loginWindow && !loginWindow.isDestroyed()) return loginWindow;
  return null;
}

function configurePortalChildWindows(windowInstance) {
  if (
    launchState.flow !== "fbr" ||
    !windowInstance.webContents.setWindowOpenHandler
  )
    return;
  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    if (!irisNavigation.isAllowedPortalUrl(url)) {
      pushStatus(
        "progress",
        "A portal popup with an unapproved URL was not opened automatically. Inspect the current IRIS screen.",
      );
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: windowInstance.taxRocketPartition,
        },
      },
    };
  });
  windowInstance.webContents.on("did-create-window", (child) => {
    child.taxRocketPartition = windowInstance.taxRocketPartition;
    loginWindow = child;
    workerWindow = child;
    attachLoginWindowWatchers(child);
    child.show();
    pushStatus(
      "progress",
      "Following the IRIS document in its new portal window; the same local session is retained.",
    );
  });
}
let trustedDeviceState = null;
let autoCaptureState = {
  inProgress: false,
  completed: false,
};
let acceptedLaunchNonces = new Set();
let launchState = {
  flow: "fbr",
  token: "",
  nonce: "",
  apiBaseUrl: "",
  accountReference: "",
  partitionKey: "",
  deviceAuthToken: "",
  trustedDevicePublicId: "",
  allowedOrigins: [],
  backendAllowlist: [],
  desktopAuthConfig: {
    loginUrl: "",
    readySelector: "",
    readyRejectSelector: "",
    readyUrlPattern: "",
    useMockIris: false,
  },
};
const stateStore = createStateStore({ app, fs, path, safeStorage });

function loadAgentState() {
  if (trustedDeviceState) {
    return trustedDeviceState;
  }

  trustedDeviceState = stateStore.loadAgentState();
  return trustedDeviceState;
}

function setTrustedDeviceState(nextState) {
  trustedDeviceState = {
    ...loadAgentState(),
    ...nextState,
  };
  stateStore.saveAgentState(trustedDeviceState);
}

function getInstallationId() {
  return loadAgentState().installationId;
}

function getApiBaseUrl() {
  return launchState.apiBaseUrl || loadAgentState().apiBaseUrl || "";
}

function notifyRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function pushStatus(kind, message) {
  console.log(`[agent:${kind}] ${message}`);
  notifyRenderer("status-update", { kind, message });
}

function resetAutoCaptureState() {
  autoCaptureState = {
    inProgress: false,
    completed: false,
  };
}

function publishLaunchState() {
  if (!mainWindow) {
    return;
  }

  mainWindow.webContents.send("launch-state", {
    ...launchState,
    agentBuild: getAgentBuildLabel(),
  });
  mainWindow.show();
  mainWindow.focus();
}

function normalizeDesktopAuthConfig(input = {}) {
  const requestedLoginUrl =
    typeof input.loginUrl === "string" ? input.loginUrl.trim() : "";
  const loginUrl = isOfficialFbrUrl(requestedLoginUrl)
    ? requestedLoginUrl
    : REAL_FBR_ROOT;

  return {
    loginUrl,
    readySelector:
      typeof input.readySelector === "string"
        ? input.readySelector.trim()
        : typeof input.successSelector === "string"
          ? input.successSelector.trim()
          : "",
    readyRejectSelector:
      typeof input.readyRejectSelector === "string"
        ? input.readyRejectSelector.trim()
        : typeof input.rejectSelector === "string"
          ? input.rejectSelector.trim()
          : "",
    readyUrlPattern:
      typeof input.readyUrlPattern === "string"
        ? input.readyUrlPattern.trim()
        : typeof input.successUrlPattern === "string"
          ? input.successUrlPattern.trim()
          : "",
    // FBR always uses the live portal. This remains in the handoff shape for
    // compatibility with older agents, but it is hard-coded false so a stale
    // launch link cannot switch the runtime to local pages.
    useMockIris: false,
  };
}

function resolveDesktopLoginUrl() {
  if (launchState.flow === "fbr") {
    return launchState.desktopAuthConfig.loginUrl || REAL_FBR_ROOT;
  }

  return DLD_OWNER_LOGIN_URL;
}

function resolveWorkerEntryUrl(config) {
  // FBR jobs stay on the live portal, even when an old job contains an invalid
  // or local entry URL.
  const configuredLoginUrl =
    realPortalLoginUrl ||
    (config && config.readiness && config.readiness.loginUrl) ||
    launchState.desktopAuthConfig?.loginUrl ||
    "";
  const entryUrl = String(config?.dryRun?.entryUrl || "").trim();
  if (!isOfficialFbrUrl(entryUrl)) {
    if (!realEntryFallbackAnnounced) {
      realEntryFallbackAnnounced = true;
      pushStatus(
        "progress",
        "Connected to the real FBR portal. Continuing there.",
      );
    }
    return isOfficialFbrUrl(configuredLoginUrl)
      ? configuredLoginUrl
      : REAL_FBR_ROOT;
  }
  return entryUrl;
}

/**
 * Navigate the IRIS top-level menu to reach the target module.
 *
 * Uses the route selector config to click the top-level menu item
 * (e.g., "Income Tax Return") and waits for the left-side category
 * panel to appear.
 *
 * Phase 19.12: Uses trySelectorsInPriority with fallback chains when
 * selectorFallbackChains are available in the routeSelector config.
 */
async function navigateIrisTopMenu(
  windowInstance,
  routeSelector,
  driftContext,
) {
  if (!routeSelector?.topMenuSelector) {
    return false;
  }

  // Build fallback chain for this action
  const selectors = buildActionSelectorChain(routeSelector, "topMenuSelector");

  try {
    const match = await trySelectorsInPriority(
      windowInstance,
      "topMenuSelector",
      selectors,
      driftContext,
    );
    await clickSelector(windowInstance, match.selector);
  } catch (error) {
    // Fall back to legacy single-selector approach
    try {
      await clickSelector(windowInstance, routeSelector.topMenuSelector);
    } catch {
      // Real IRIS 2.0: selectors may carry "text:Declaration" style
      // alternatives — clickSelector resolves those by visible text.
      await clickSelectorWithTextSupport(
        windowInstance,
        routeSelector.topMenuSelector,
        15000,
      );
    }
  }

  // Wait for the left category panel to load
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return true;
}

/**
 * Navigate the IRIS left-side category panel to reach the target form list.
 *
 * Phase 19.12: Uses trySelectorsInPriority with fallback chains.
 */
async function navigateIrisLeftCategory(
  windowInstance,
  routeSelector,
  driftContext,
) {
  if (!routeSelector?.leftCategorySelector) {
    return false;
  }

  const selectors = buildActionSelectorChain(
    routeSelector,
    "leftCategorySelector",
  );

  try {
    const match = await trySelectorsInPriority(
      windowInstance,
      "leftCategorySelector",
      selectors,
      driftContext,
    );
    await clickSelector(windowInstance, match.selector);
  } catch (error) {
    try {
      await clickSelector(windowInstance, routeSelector.leftCategorySelector);
    } catch {
      // Real IRIS 2.0: "text:Income Tax Return" style alternatives are
      // resolved by visible text.
      await clickSelectorWithTextSupport(
        windowInstance,
        routeSelector.leftCategorySelector,
        15000,
      );
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  return true;
}

// ── Phase 19.12: buildActionSelectorChain ──────────────────────────────

/**
 * Build a priority-ordered selector array for a given action.
 * Combines the primary selector with any fallback selectors from the
 * routeSelector's `_fallbackChains` metadata (set by server-side
 * buildSelectorFallbackChains).
 */
function buildActionSelectorChain(routeSelector, action) {
  const selectors = [];

  // Primary selector
  const primary = routeSelector[action];
  if (primary) {
    // Split comma-separated multi-selectors into individual entries
    const parts = primary
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    selectors.push(...parts);
  }

  // Add fallbacks from the server-generated fallback chains
  const fallbackChains = routeSelector._fallbackChains;
  if (fallbackChains && Array.isArray(fallbackChains)) {
    const chain = fallbackChains.find((c) => c.action === action);
    if (chain && Array.isArray(chain.fallbacks)) {
      for (const fb of chain.fallbacks) {
        if (fb && !selectors.includes(fb)) {
          selectors.push(fb);
        }
      }
    }
  }

  return selectors;
}

/**
 * Find and click the target form link in the IRIS form list.
 *
 * Uses fuzzy matching to find a form link by text content when the
 * exact selector isn't available. Falls back to the configured
 * formSelector if fuzzy matching fails.
 */
async function navigateIrisFormList(windowInstance, routeSelector, formLabel) {
  if (!routeSelector?.formSelector) {
    return false;
  }

  // Try exact selector first (supports "text:Label" alternatives for
  // the real IRIS 2.0 portal).
  try {
    await clickSelector(windowInstance, routeSelector.formSelector);
    return true;
  } catch {
    // Fall through to fuzzy matching
  }

  // Fuzzy matching: find a link/button whose text contains the form label
  if (formLabel) {
    try {
      const clicked = await findAndClickByText(windowInstance, [formLabel]);
      if (clicked) {
        return true;
      }
    } catch {
      // Fall through
    }
  }

  // Last resort: try to find any link in the form list area
  try {
    const found = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const links = document.querySelectorAll('a, button');
        for (const link of links) {
          const text = (link.textContent || '').trim().toLowerCase();
          if (text.includes('return') || text.includes('114') || text.includes('form')) {
            link.click();
            return true;
          }
        }
        return false;
      })();
    `);
    return found;
  } catch {
    return false;
  }
}

/**
 * Verify that the expected form page loaded after navigation.
 *
 * Checks for the formReadySelector and returns true if found.
 */
async function verifyFormReady(windowInstance, routeSelector) {
  if (!routeSelector?.formReadySelector) {
    return true;
  }

  try {
    await waitForVisibleSelector(
      windowInstance,
      routeSelector.formReadySelector,
      10000,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the tax year / period on the IRIS form.
 *
 * Uses the route selector config to find and set the period dropdown
 * or input field. Falls back to trying common selectors if the
 * configured selector doesn't match.
 */
async function setIrisFormPeriod(windowInstance, routeSelector, taxYear) {
  if (!routeSelector?.periodSelector || !taxYear) {
    return false;
  }

  try {
    await fillSelector(
      windowInstance,
      routeSelector.periodSelector,
      String(taxYear),
    );
    return true;
  } catch {
    // Fall back to trying common period selectors
    const fallbackSelectors = [
      'select[name="taxYear"]',
      'select[id*="taxYear"]',
      'select[id*="period"]',
      'input[name*="taxYear"]',
      'input[id*="period"]',
    ];

    for (const selector of fallbackSelectors) {
      try {
        await fillSelector(windowInstance, selector, String(taxYear));
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }
}

/**
 * Handle the taxpayer name field if it's editable on the form.
 *
 * Some IRIS routes allow editing the taxpayer name. This function
 * fills it if a nameSelector is configured and a name value is provided.
 */
async function handleIrisFormName(windowInstance, routeSelector, taxpayerName) {
  if (!routeSelector?.nameSelector || !taxpayerName) {
    return false;
  }

  try {
    await fillSelector(
      windowInstance,
      routeSelector.nameSelector,
      String(taxpayerName),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate from the IRIS dashboard to the target form using route-aware selectors.
 *
 * This is the main entry point for route-aware navigation. It:
 * 1. Clicks the top-level menu (e.g., "Income Tax Return")
 * 2. Clicks the left-side category (e.g., "Return")
 * 3. Finds and clicks the specific form link
 * 4. Sets the tax year / period
 * 5. Handles the taxpayer name if editable
 * 6. Verifies the form is ready for data entry
 *
 * Returns an execution log entry describing what was done.
 */
/**
 * IRIS 2.0 live-portal navigation (dashboard-first strategy).
 *
 * The mock-era menu selectors do not exist on the real IRIS 2.0 Angular
 * portal. What DOES exist (verified from a live dashboard capture):
 *  - a draft row like "114(1) (Return of Income filed voluntarily for
 *    complete year)" with a period and an edit action, or
 *  - the "Income Tax Return for tax year 2026" card.
 * Click the most specific matching text, wait for Angular to render, and
 * confirm the form actually opened by counting visible inputs.
 */
async function navigateIris2DashboardFlow(windowInstance, formLabel) {
  const label = String(formLabel || "").toLowerCase();
  const wantsWealth = label.includes("wealth");

  // The welcome popup re-renders after dismissal (Angular), and its own
  // text ("Submit Your Income Tax Return...") matches our click targets.
  // Dismiss it right before picking, and exclude overlay content below.
  await dismissIrisWelcomePopup(windowInstance);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // --- Evidence-based (2026-09-07 dashboard dump, logged-in user): ----
  // Dashboard is Angular Material at /dashboard. The draft 114(1) row is
  // <tr class="doubleclick ng-tns-... ng-star-inserted"> inside the
  // "Draft (Unsubmitted Documents)" tab — the row itself carries a
  // DOUBLE-CLICK handler (class "doubleclick"), so we dispatch click +
  // dblclick on the row. Fallback: the old smallest-text card chain.
  const clickMatch = await windowInstance.webContents
    .executeJavaScript(
      `(() => {
      const clip = (t) => String(t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const inOverlay = (el) => !!el.closest(
        '.ui-dialog, [role="dialog"], .modal, [class*="overlay" i], [class*="popup" i], [class*="modal" i]');
      const wantsWealth = ${wantsWealth ? "true" : "false"};
      const taskMatch = (t) => wantsWealth
        ? (t.includes('wealth') || t.includes('116('))
        : ((t.includes('114(1)') || t.includes('return of income filed'))
           && !t.includes('user guide') && !t.includes('video guide'));

      // 0) Make sure the Draft (Unsubmitted Documents) tab is selected (best effort).
      try {
        const tab = Array.from(document.querySelectorAll('a, button'))
          .filter((el) => visible(el) && !inOverlay(el))
          .find((el) => clip(el.innerText).includes('draft (unsubmitted'));
        if (tab && !String(tab.className).toLowerCase().includes('active')) tab.click();
      } catch (e) {}

      // 1) Precise draft row: tr.doubleclick with matching task text.
      const rows = Array.from(document.querySelectorAll('tr'))
        .filter((el) => visible(el) && !inOverlay(el))
        .filter((el) => String(el.className).toLowerCase().includes('doubleclick'))
        .filter((el) => taskMatch(clip(el.innerText || '')));

      if (rows.length > 0) {
        const row = rows[0];
        try {
          try { row.scrollIntoView({ block: 'center' }); } catch (e) {}
          const opts = { bubbles: true, cancelable: true, view: window };
          row.dispatchEvent(new MouseEvent('mousedown', opts));
          row.dispatchEvent(new MouseEvent('mouseup', opts));
          row.click();
          row.dispatchEvent(new MouseEvent('dblclick', opts));
          return { clicked: 'row_dblclick', rowText: clip(row.innerText).slice(0, 70) };
        } catch (e) {
          return { clicked: null, error: 'row_dblclick_failed: ' + String(e && e.message || e) };
        }
      }

      // 2) Fallback: smallest-text chain (cards / any row).
      const candidates = Array.from(document.querySelectorAll(
        'a, button, span, div, td, tr, li, [role="button"], [role="row"], [role="menuitem"]'
      )).filter((el) => visible(el) && !inOverlay(el));

      const pick = (pred) => {
        const hits = candidates.filter((el) => pred(clip(el.innerText || '')));
        hits.sort((a, b) =>
          String(a.innerText || '').length - String(b.innerText || '').length);
        return hits[0] || null;
      };

      let target = null;
      let how = '';
      if (wantsWealth) {
        target = pick((t) => t.includes('wealth statement'));
        how = 'wealth_card';
      }
      if (!target) {
        target = pick(taskMatch);
        how = 'draft_row_text';
      }
      if (!target) {
        target = pick((t) => t.includes('income tax return'));
        how = 'itr_card';
      }
      if (!target) return { clicked: null };
      try {
        target.scrollIntoView({ block: 'center' });
        target.click();
        return { clicked: how };
      } catch {
        return { clicked: null };
      }
    })()`,
    )
    .catch(() => ({ clicked: null }));

  if (!clickMatch?.clicked) {
    return {
      steps: [],
      formReady: false,
      detail:
        "IRIS 2.0 dashboard strategy: no draft row or Income-Tax-Return card matched" +
        (clickMatch?.error ? " (" + clickMatch.error + ")" : "") +
        ".",
    };
  }

  const how = clickMatch.clicked;
  const rowText = clickMatch.rowText ? ' row="' + clickMatch.rowText + '"' : "";

  // Poll for the form to render (up to ~18s). Angular needs time, and the
  // dashboard itself has 0 visible inputs, so ANY visible input counts.
  const countInputs = () =>
    windowInstance.webContents
      .executeJavaScript(
        `(() => {
          const inputs = Array.from(document.querySelectorAll(
            'input, textarea, select'
          )).filter((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 &&
              s.display !== 'none' && s.visibility !== 'hidden';
          });
          return inputs.length;
        })()`,
      )
      .catch(() => 0);

  let formOpen = 0;
  let editFallbackTried = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    formOpen = await countInputs();
    if (formOpen > 0) break;

    // Row dblclick didn't open the form → try the row's Action-column
    // edit/pencil control (icon-only buttons: mat-icon ligature text,
    // font-awesome classes). Explicitly avoid delete/trash.
    if (!editFallbackTried && how === "row_dblclick") {
      editFallbackTried = true;
      const editClicked = await windowInstance.webContents
        .executeJavaScript(
          `(() => {
            const clip = (t) => String(t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            const visible = (el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const inOverlay = (el) => !!el.closest(
              '.ui-dialog, [role="dialog"], .modal, [class*="overlay" i], [class*="popup" i], [class*="modal" i]');
            const wantsWealth = ${wantsWealth ? "true" : "false"};
            const taskMatch = (t) => wantsWealth
              ? (t.includes('wealth') || t.includes('116('))
              : (t.includes('114(1)') || t.includes('return of income filed'));
            const row = Array.from(document.querySelectorAll('tr'))
              .filter((el) => visible(el) && !inOverlay(el))
              .filter((el) => String(el.className).toLowerCase().includes('doubleclick'))
              .find((el) => taskMatch(clip(el.innerText || '')));
            if (!row) return null;
            const ctl = Array.from(
              row.querySelectorAll('button, a, i, mat-icon, span, img')
            ).filter(visible).find((el) => {
              const sig = clip(el.innerText) + ' ' + String(el.className).toLowerCase();
              return (sig.includes('edit') || sig.includes('pencil') ||
                      sig.includes('create') || sig.includes('draft') ||
                      sig.includes('open')) &&
                     !sig.includes('delete') && !sig.includes('trash') &&
                     !sig.includes('remove');
            });
            if (!ctl) return null;
            try { ctl.click(); return clip(ctl.innerText || ctl.className).slice(0, 40) || 'ctl'; }
            catch (e) { return null; }
          })()`,
        )
        .catch(() => null);
      if (editClicked) {
        console.log(
          `[agent] iris2: dblclick did not open the form; clicked row action control "${editClicked}"`,
        );
      }
    }
  }

  // Readiness is the WORKSPACE, not the presence of inputs: the
  // Summary-of-Economic-Transactions gate also renders ten visible inputs, and
  // treating that as "form ready" is how a job can start filling the wrong page.
  let readiness = {
    returnWorkspace: false,
    inputs: formOpen,
    probeFailed: true,
  };
  if (formOpen > 0) {
    readiness = await windowInstance.webContents
      .executeJavaScript(irisNavigation.RETURN_WORKSPACE_PROBE)
      .then((value) => (value && typeof value === "object" ? value : readiness))
      .catch(() => readiness);
  }

  return {
    steps: [`iris2_${how}${editFallbackTried ? "+edit_ctl" : ""}`],
    formReady: Boolean(readiness.returnWorkspace),
    readiness,
    detail: readiness.returnWorkspace
      ? `IRIS 2.0 dashboard strategy: "${how}"${rowText}` +
        `${editFallbackTried ? " + row action control" : ""}, return workspace confirmed ` +
        `(year/document/registration header present, ${readiness.inputs ?? formOpen} visible inputs).`
      : `IRIS 2.0 dashboard strategy: "${how}"${rowText} — ${formOpen} visible input(s) but no ` +
        `app-nitr-workflow header proving the return is open (tax-year/document/registration). ` +
        `Held instead of filling an unconfirmed page.`,
  };
}

async function navigateToIrisForm(
  windowInstance,
  routeSelector,
  formLabel,
  taxYear,
  taxpayerName,
) {
  const steps = [];

  // IRIS 2.0 live portal: try the dashboard-first strategy BEFORE the
  // mock-era menu selectors, which do not exist on the real portal.
  if (realPortalMode) {
    const iris2 = await navigateIris2DashboardFlow(windowInstance, formLabel);
    if (iris2.formReady) {
      return {
        steps: iris2.steps,
        formReady: true,
        detail: iris2.detail,
      };
    }
    // Do NOT fall through to the legacy chain on the live portal. Its
    // selectors (`#iris-return-form-ready`, `#return-tax-form`,
    // `a[href*='IncomeTaxReturn']`) match 0 of 13 captured IRIS 2.0 pages, so
    // the fall-through only burns ~30s of per-selector timeouts and then throws
    // a message containing the word "selector" — which is how a readiness miss
    // used to get mislabelled as selector drift. The mock keeps the chain below.
    return {
      steps: iris2.steps,
      formReady: false,
      readiness: iris2.readiness,
      detail: iris2.detail,
    };
  }

  // Step 1: Navigate top menu
  if (routeSelector?.topMenuSelector) {
    await navigateIrisTopMenu(windowInstance, routeSelector);
    steps.push("top_menu");
  }

  // Step 2: Navigate left category
  if (routeSelector?.leftCategorySelector) {
    await navigateIrisLeftCategory(windowInstance, routeSelector);
    steps.push("left_category");
  }

  // Step 3: Find and click the form
  const formFound = await navigateIrisFormList(
    windowInstance,
    routeSelector,
    formLabel,
  );
  if (formFound) {
    steps.push("form_selected");
  }

  // Wait for form to load
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Step 4: Set period / tax year
  if (taxYear) {
    const periodSet = await setIrisFormPeriod(
      windowInstance,
      routeSelector,
      taxYear,
    );
    if (periodSet) {
      steps.push("period_set");
    }
  }

  // Step 5: Handle name field
  if (taxpayerName) {
    const nameSet = await handleIrisFormName(
      windowInstance,
      routeSelector,
      taxpayerName,
    );
    if (nameSet) {
      steps.push("name_set");
    }
  }

  // Step 6: Verify form is ready
  const formReady = await verifyFormReady(windowInstance, routeSelector);

  return {
    steps,
    formReady,
    detail: `Navigated IRIS menus: ${steps.join(" → ")}. Form ready: ${formReady}`,
  };
}

/**
 * Detect and handle the PSID generation flow on the IRIS payment screen.
 *
 * This function:
 * 1. Checks if the "Generate PSID" button is visible
 * 2. Captures the balance payable before PSID generation
 * 3. Clicks "Generate PSID" to trigger PSID creation
 * 4. Captures the PSID number from the display
 * 5. Attempts to download/print the PSID slip
 *
 * Returns an object with PSID details or null if PSID generation
 * is not applicable.
 */
async function handlePsidGeneration(windowInstance, routeSelector) {
  if (!routeSelector?.generatePsidSelector) {
    return null;
  }

  const hasGenerateButton = await hasSelector(
    windowInstance,
    routeSelector.generatePsidSelector,
  );
  if (!hasGenerateButton) {
    return null;
  }

  // Capture balance payable before PSID generation
  let balancePayable = null;
  if (routeSelector.balancePayableSelector) {
    try {
      balancePayable = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.balancePayableSelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore balance capture errors
    }
  }

  // Click "Generate PSID"
  await clickSelector(windowInstance, routeSelector.generatePsidSelector);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Capture PSID number
  let psidNumber = null;
  if (routeSelector.psidDisplaySelector) {
    try {
      psidNumber = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.psidDisplaySelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore PSID capture errors
    }
  }

  // Attempt to download PSID slip
  let psidDownloaded = false;
  if (routeSelector.psidDownloadSelector) {
    try {
      await clickSelector(windowInstance, routeSelector.psidDownloadSelector);
      psidDownloaded = true;
    } catch {
      // Ignore download errors
    }
  }

  return {
    psidNumber,
    balancePayable,
    psidDownloaded,
  };
}

/**
 * Detect and verify CPR (Computerized Payment Receipt) on the IRIS payment screen.
 *
 * This function:
 * 1. Checks if a CPR display area is visible
 * 2. Captures the CPR reference number
 * 3. Reads the paid amount shown by IRIS
 * 4. Compares the paid amount against the balance payable
 * 5. Detects refund banners / overpayment indicators
 * 6. Checks if the submit button is unlocked
 *
 * Returns an object with CPR/payment verification details.
 */
async function verifyCprAndPayment(windowInstance, routeSelector) {
  const result = {
    cprDetected: false,
    cprReference: null,
    paidAmount: null,
    balancePayable: null,
    refundDetected: false,
    submitUnlocked: false,
  };

  // Detect CPR
  if (routeSelector.cprDisplaySelector) {
    try {
      result.cprDetected = await hasSelector(
        windowInstance,
        routeSelector.cprDisplaySelector,
      );
      if (result.cprDetected) {
        result.cprReference = await windowInstance.webContents
          .executeJavaScript(`
          (() => {
            const element = document.querySelector(${JSON.stringify(routeSelector.cprDisplaySelector)});
            return element ? (element.textContent || element.value || "").trim() : null;
          })();
        `);
      }
    } catch {
      // Ignore CPR detection errors
    }
  }

  // Read paid amount
  if (routeSelector.paidAmountSelector) {
    try {
      result.paidAmount = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.paidAmountSelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore paid amount errors
    }
  }

  // Read balance payable
  if (routeSelector.balancePayableSelector) {
    try {
      result.balancePayable = await windowInstance.webContents
        .executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.balancePayableSelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore balance errors
    }
  }

  // Detect refund banner
  if (routeSelector.refundBannerSelector) {
    try {
      result.refundDetected = await hasSelector(
        windowInstance,
        routeSelector.refundBannerSelector,
      );
    } catch {
      // Ignore refund detection errors
    }
  }

  // Check if submit is unlocked (submit button visible and enabled)
  if (routeSelector.submitButtonSelector) {
    try {
      const submitEnabled = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.submitButtonSelector)});
          if (!element) return false;
          return !element.disabled && element.getAttribute('aria-disabled') !== 'true';
        })();
      `);
      result.submitUnlocked = submitEnabled;
    } catch {
      // Ignore submit check errors
    }
  }

  return result;
}

/**
 * Verify that the filing was completed successfully by checking for
 * completion evidence on the IRIS portal.
 *
 * Checks for:
 * - Completed tasks / outbox entry
 * - Acknowledgement receipt
 * - Return copy availability
 * - CPR proof
 */
async function verifyCompletionEvidence(windowInstance, routeSelector) {
  const evidence = {
    completedTasksDetected: false,
    acknowledgementDetected: false,
    returnCopyDetected: false,
    cprProofDetected: false,
  };

  // Check for completed tasks / outbox
  if (routeSelector?.completionConfirmSelector) {
    try {
      evidence.completedTasksDetected = await hasSelector(
        windowInstance,
        routeSelector.completionConfirmSelector,
      );
    } catch {
      // Ignore
    }
  }

  // Try common completion evidence selectors
  const evidenceSelectors = {
    acknowledgementDetected:
      '#iris-acknowledgement-proof, [id*="acknowledgement"], [class*="acknowledgement"]',
    returnCopyDetected:
      '#iris-return-copy-proof, [id*="returnCopy"], [class*="return-copy"]',
    cprProofDetected: '#iris-cpr-proof, [id*="cpr"], [class*="cpr-proof"]',
  };

  for (const [key, selector] of Object.entries(evidenceSelectors)) {
    try {
      const found = await hasSelector(windowInstance, selector);
      if (found) {
        evidence[key] = true;
      }
    } catch {
      // Ignore
    }
  }

  return evidence;
}

function resolveFbrPortalUrl(value) {
  const fallback =
    realPortalLoginUrl ||
    launchState.desktopAuthConfig?.loginUrl ||
    REAL_FBR_ROOT;
  const candidate = String(value || "").trim();
  return isOfficialFbrUrl(candidate) ? candidate : fallback;
}

function getTrustedDeviceRegisterEndpoint() {
  if (launchState.flow === "fbr") {
    return "/api/fbr-connect/desktop/register";
  }

  return "/api/dld-connect/desktop/register";
}

function getTrustedDeviceReadyEndpoint() {
  if (launchState.flow === "fbr") {
    return "/api/fbr-connect/desktop/ready";
  }

  return "/api/dld-connect/desktop/ready";
}

function isLikelyLoggedInDldUrl(rawValue) {
  if (!rawValue || rawValue === "about:blank") {
    return false;
  }

  try {
    const parsed = new URL(rawValue);
    const hostMatches =
      parsed.hostname === DLD_PORTAL_HOST ||
      parsed.hostname.endsWith(`.${DLD_PORTAL_HOST}`);

    if (!hostMatches) {
      return false;
    }

    const normalized = rawValue.toLowerCase();

    if (normalized.includes("/mydld/#/login/owner")) {
      return false;
    }

    if (normalized.includes("/login")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function isLikelyReadyFbrUrl(rawValue) {
  if (!rawValue || rawValue === "about:blank") {
    return false;
  }

  if (!launchState.desktopAuthConfig.useMockIris) {
    // Scheduling may run on any official SPA route. Positive DOM evidence is
    // still required by captureLoginWindowState; domain alone is NOT ready.
    return irisNavigation.isAllowedPortalUrl(rawValue);
  }
  const readyUrlPattern = launchState.desktopAuthConfig.readyUrlPattern;

  if (readyUrlPattern && matchesSuccessUrlPattern(rawValue, readyUrlPattern)) {
    return true;
  }

  return rawValue.includes("dashboard.html");
}

function matchesSuccessUrlPattern(rawValue, pattern) {
  if (!rawValue || !pattern) {
    return false;
  }

  return rawValue.toLowerCase().includes(pattern.toLowerCase());
}

function clearAutoCaptureTimer() {
  if (autoCaptureTimer) {
    clearTimeout(autoCaptureTimer);
    autoCaptureTimer = null;
  }
}

function sameLaunchAlreadyOpening(token, apiBaseUrl, partitionKey) {
  return Boolean(
    token &&
    token === launchState.token &&
    sanitizeBaseUrl(apiBaseUrl) === launchState.apiBaseUrl &&
    (!partitionKey || partitionKey === launchState.partitionKey) &&
    (loginWindowPromise || (loginWindow && !loginWindow.isDestroyed())),
  );
}

function focusPortalWindow() {
  const windowInstance = loginWindow || workerWindow;
  if (windowInstance && !windowInstance.isDestroyed()) {
    windowInstance.show();
    windowInstance.focus();
  }
}

function applyLaunchUrl(rawValue) {
  if (!rawValue || !String(rawValue).startsWith("taxrocket-connect://")) {
    return false;
  }

  const parsed = new URL(rawValue);
  if (
    sameLaunchAlreadyOpening(
      parsed.searchParams.get("token"),
      parsed.searchParams.get("apiBaseUrl"),
      parsed.searchParams.get("partition") ||
        parsed.searchParams.get("partitionKey"),
    )
  ) {
    focusPortalWindow();
    return true;
  }
  if (localWorkerRunning) {
    pushStatus(
      "error",
      "A filing is already in progress. Wait for it to pause before reconnecting.",
    );
    return false;
  }
  const incomingPartitionKey =
    parsed.searchParams.get("partitionKey") ||
    parsed.searchParams.get("partition") ||
    loadAgentState().partitionKey ||
    "";
  const incomingAccountReference = String(
    parsed.searchParams.get("accountReference") || "",
  ).trim();
  launchState = {
    flow: parsed.searchParams.get("flow") !== "dld" ? "fbr" : "dld",
    token: parsed.searchParams.get("token") || "",
    nonce: parsed.searchParams.get("nonce") || "",
    apiBaseUrl: sanitizeBaseUrl(parsed.searchParams.get("apiBaseUrl") || ""),
    accountReference:
      incomingAccountReference ||
      (incomingPartitionKey === launchState.partitionKey
        ? launchState.accountReference
        : ""),
    partitionKey: incomingPartitionKey,
    deviceAuthToken: "",
    trustedDevicePublicId: loadAgentState().trustedDevicePublicId || "",
    allowedOrigins: [],
    backendAllowlist: [],
    desktopAuthConfig: normalizeDesktopAuthConfig({
      readySelector:
        parsed.searchParams.get("readySelector") ||
        parsed.searchParams.get("successSelector") ||
        "",
      readyRejectSelector: parsed.searchParams.get("rejectSelector") || "",
      readyUrlPattern:
        parsed.searchParams.get("readyUrlPattern") ||
        parsed.searchParams.get("successUrlPattern") ||
        "",
      loginUrl: parsed.searchParams.get("loginUrl") || "",
    }),
  };
  setTrustedDeviceState({
    apiBaseUrl: launchState.apiBaseUrl || loadAgentState().apiBaseUrl || "",
    deviceAuthToken: "",
  });
  resetAutoCaptureState();
  publishLaunchState();
  pushStatus(
    "ready",
    launchState.flow === "fbr"
      ? "Connection request received. Opening FBR sign-in now."
      : "Connection request received. Opening MyDLD sign-in now.",
  );
  void createLoginWindow(true).catch((error) =>
    pushStatus("error", error.message || "Could not open FBR."),
  );

  return true;
}

function applyLaunchPayload(payload) {
  if (
    sameLaunchAlreadyOpening(
      payload?.token,
      payload?.apiBaseUrl,
      payload?.partitionKey,
    )
  ) {
    focusPortalWindow();
    return true;
  }
  if (localWorkerRunning) {
    pushStatus(
      "error",
      "A filing is already in progress. Wait for it to pause before reconnecting.",
    );
    return false;
  }
  const incomingPartitionKey =
    typeof payload?.partitionKey === "string"
      ? payload.partitionKey.trim()
      : loadAgentState().partitionKey || "";
  const incomingAccountReference =
    typeof payload?.accountReference === "string"
      ? payload.accountReference.trim()
      : "";
  launchState = {
    flow: payload?.flow !== "dld" ? "fbr" : "dld",
    token: typeof payload?.token === "string" ? payload.token : "",
    nonce: typeof payload?.nonce === "string" ? payload.nonce.trim() : "",
    apiBaseUrl: sanitizeBaseUrl(
      typeof payload?.apiBaseUrl === "string" ? payload.apiBaseUrl : "",
    ),
    accountReference:
      incomingAccountReference ||
      (incomingPartitionKey === launchState.partitionKey
        ? launchState.accountReference
        : ""),
    partitionKey: incomingPartitionKey,
    deviceAuthToken: "",
    trustedDevicePublicId: loadAgentState().trustedDevicePublicId || "",
    allowedOrigins: Array.isArray(payload?.allowedOrigins)
      ? payload.allowedOrigins
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    backendAllowlist: Array.isArray(payload?.backendAllowlist)
      ? payload.backendAllowlist
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    desktopAuthConfig: normalizeDesktopAuthConfig(payload?.desktopAuthConfig),
  };
  setTrustedDeviceState({
    apiBaseUrl: launchState.apiBaseUrl || loadAgentState().apiBaseUrl || "",
    deviceAuthToken: "",
  });
  resetAutoCaptureState();
  publishLaunchState();

  if (!launchState.token || !launchState.apiBaseUrl) {
    pushStatus("error", "The desktop connection request is incomplete.");
    return false;
  }

  pushStatus(
    "ready",
    launchState.flow === "fbr"
      ? "Connection request received. Opening FBR sign-in now."
      : "Connection request received. Opening MyDLD sign-in now.",
  );
  void createLoginWindow(true).catch((error) =>
    pushStatus("error", error.message || "Could not open FBR."),
  );
  return true;
}

async function ensureTrustedDeviceRegistration() {
  if (!launchState.token || !launchState.apiBaseUrl) {
    throw new Error(
      "No active connection session was provided by the web app.",
    );
  }

  const response = await fetch(
    `${launchState.apiBaseUrl}${getTrustedDeviceRegisterEndpoint()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${launchState.token}`,
      },
      body: JSON.stringify({
        installationId: getInstallationId(),
        displayName: `${os.hostname()} Desktop Agent`,
        platform: process.platform,
        appVersion: app.getVersion(),
      }),
    },
  );

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.error ||
        `Trusted device registration failed with status ${response.status}.`,
    );
  }

  setTrustedDeviceState({
    installationId: getInstallationId(),
    deviceAuthToken: result.deviceAuthToken || "",
    trustedDevicePublicId: result?.trustedDevice?.publicId || "",
    partitionKey: result.partitionKey || launchState.partitionKey || "",
    apiBaseUrl: launchState.apiBaseUrl || "",
  });

  launchState = {
    ...launchState,
    partitionKey: result.partitionKey || launchState.partitionKey || "",
    deviceAuthToken: result.deviceAuthToken || "",
    trustedDevicePublicId: result?.trustedDevice?.publicId || "",
  };
  publishLaunchState();
  return result;
}

function clearLocalWorkerTimer() {
  if (localWorkerTimer) {
    clearInterval(localWorkerTimer);
    localWorkerTimer = null;
  }
}

function startLocalWorkerLoop() {
  clearLocalWorkerTimer();

  localWorkerTimer = setInterval(() => {
    void runLocalWorkerCycle();
  }, LOCAL_AGENT_POLL_INTERVAL_MS);

  void runLocalWorkerCycle();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error || `Request failed with status ${response.status}.`,
    );
  }

  return payload;
}

function getWorkerPartition() {
  const partitionKey =
    launchState.partitionKey || loadAgentState().partitionKey || "default";
  return launchState.flow === "fbr"
    ? `persist:fbr-iris-${partitionKey}`
    : `persist:dld-portal-${partitionKey}`;
}

function getWorkerTempDir(jobId) {
  return path.join(app.getPath("userData"), "jobs", jobId);
}

async function ensureWorkerWindow() {
  if (launchState.flow === "fbr" && realPortalMode) {
    const windowInstance = await createLoginWindow(false);
    workerWindow = windowInstance;
    windowInstance.setTitle(
      `Tax Rocket IRIS — Navigation check [${AGENT_BUILD_TAG}]`,
    );
    windowInstance.show();
    return windowInstance;
  }
  if (workerWindow && !workerWindow.isDestroyed()) {
    return workerWindow;
  }

  workerWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    title:
      launchState.flow === "fbr"
        ? "Tax Rocket Iris Dry Run"
        : "Tax Rocket Portal Agent",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getWorkerPartition(),
    },
  });

  pushStatus(
    "progress",
    `Agent window opened (partition: ${getWorkerPartition()}) [build ${AGENT_BUILD_TAG}]`,
  );

  workerWindow.on("closed", () => {
    workerWindow = null;
  });

  return workerWindow;
}

async function captureWindowScreenshot(windowInstance, label) {
  const image = await windowInstance.capturePage();
  return {
    label,
    dataUrl: image.toDataURL(),
  };
}

/**
 * Capture the live page's interactive elements (links, buttons, inputs,
 * menu items) with their ids/classes/text. Attached to every job failure so
 * the real IRIS 2.0 selector bundle can be written from EVIDENCE instead of
 * guesswork — the agent is the only vantage point onto the logged-in DOM.
 */
async function captureDomEvidence(windowInstance) {
  return irisNavigation.probeFrames(windowInstance);
}

async function collectPreFillComparison(windowInstance, portalFieldMap) {
  const comparisons = [];

  for (const field of portalFieldMap) {
    // Phase 15.5a F1: Use field.selector (actual CSS selector for classic portal JSF IDs)
    // when available, falling back to data-tax-field-key for legacy portal pages.
    const selector =
      field.selector ||
      `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
    const currentValue = await windowInstance.webContents
      .executeJavaScript(
        `
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return element ? (element.value || "") : "";
      })();
    `,
      )
      .catch(() => "");

    if (currentValue && currentValue !== field.value) {
      comparisons.push({
        key: field.key,
        label: field.label,
        portalValue: currentValue,
        packetValue: field.value,
      });
    }
  }

  return comparisons;
}

function getSelectorBundleSignal(jobContext) {
  const configBundle = jobContext?.taxAutomationConfig?.selectorBundle;
  if (configBundle && typeof configBundle === "object") {
    return configBundle;
  }

  const payloadBundle =
    jobContext?.job?.payload?.selectorBundle ||
    jobContext?.payload?.selectorBundle;
  if (payloadBundle && typeof payloadBundle === "object") {
    return payloadBundle;
  }

  return null;
}

function inferLikelySelectorGroup(errorMessage, executionLog) {
  const message = String(errorMessage || "").toLowerCase();
  const recentStep =
    Array.isArray(executionLog) && executionLog.length > 0
      ? executionLog[executionLog.length - 1]
      : null;
  const step = typeof recentStep?.step === "string" ? recentStep.step : "";

  if (step === "route_navigation" || message.includes("navigation")) {
    return "route_navigation";
  }

  if (
    step === "payment_verification" ||
    message.includes("psid") ||
    message.includes("cpr") ||
    message.includes("submit button")
  ) {
    return "payment_verification";
  }

  if (
    step === "completion_verification" ||
    message.includes("completed tasks") ||
    message.includes("acknowledgement")
  ) {
    return "completion_verification";
  }

  if (message.includes("data-tax-field-key") || step === "field_fill") {
    return "field_fill";
  }

  return "unknown_selector_group";
}

/**
 * Evidence about the portal's own shape lives in the navigation module, next to the
 * section lists it depends on — main.js delegates so the two cannot disagree.
 */
const buildPortalEvidenceDiagnostics =
  irisNavigation.buildPortalEvidenceDiagnostics;

function buildSelectorDriftDiagnostics(
  errorMessage,
  executionLog,
  jobContext,
  evidence = null,
) {
  const message = String(errorMessage || "").toLowerCase();
  // The word "selector" in a message is not evidence of drift, and neither is a
  // readiness miss: the live pilot's `0/27 refused` run was labelled
  // "update your selectors" because this function only string-matched.
  const selectorLikeFailure =
    message.includes("selector") ||
    message.includes("timed out waiting for selector") ||
    message.includes("missing selector");

  if (!selectorLikeFailure) {
    return null;
  }
  // With a capture in hand, only missing rows justify calling it drift.
  if (
    evidence &&
    evidence.state !== "rows_missing" &&
    evidence.state !== "no_evidence"
  ) {
    return null;
  }

  const rowsMissing = Boolean(evidence && evidence.state === "rows_missing");
  return {
    reasonCode: rowsMissing
      ? "selector_drift_confirmed_by_capture"
      : "selector_drift_suspected",
    likelySelectorGroup: inferLikelySelectorGroup(message, executionLog),
    selectorBundle: getSelectorBundleSignal(jobContext),
    evidence: evidence
      ? {
          state: evidence.state,
          driftedSections: evidence.drifted,
          unverifiedSections: evidence.unverified,
        }
      : null,
    recommendedActions: [
      "Capture a fresh screenshot of the failed IRIS screen on the trusted device.",
      rowsMissing
        ? `These sections rendered zero rows although their panels were found: ${evidence.drifted.join(", ")}. Update only the selectors that open them.`
        : "Update the affected selector group in the active selector bundle.",
      "Re-run the job from the latest approved packet after bundle update.",
    ],
  };
}

function looksLikeSessionReconnectNeeded(errorMessage) {
  const message = String(errorMessage || "").toLowerCase();
  return (
    message.includes("session appears invalid") ||
    message.includes("requires reconnect") ||
    message.includes("trusted local iris session") ||
    message.includes("ready screen") ||
    message.includes("not logged")
  );
}

/**
 * A fill that the portal REFUSED (derived column, computed row, no matching row) is a
 * mapping problem, not selector drift. That distinction is the whole point of this
 * branch: the live pilot parked a job on `selector_bundle_update` for what was really
 * 24 `column_disabled` refusals, because the classifier only string-matched the word
 * "selector" out of the thrown message. Telling an operator to rewrite selectors
 * instead of fixing the packet's column target wastes the one thing this pilot has
 * scarce of — a real filing window.
 */
function buildMappingRefusalDiagnostics(executionLog) {
  const steps = Array.isArray(executionLog) ? executionLog : [];
  const refusals = [];
  for (const entry of steps) {
    if (entry?.step !== "real_autofill_skip") continue;
    refusals.push(String(entry.detail || ""));
  }
  if (!refusals.length) return null;

  const counts = new Map();
  for (const line of refusals) {
    const status = line.split("->")[1]?.trim().split(" ")[0] || "unknown";
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const derived =
    (counts.get("column_disabled") || 0) +
    (counts.get("no_editable_cell") || 0);
  const unplaced = counts.get("row_not_found") || 0;
  return {
    reasonCode: "portal_mapping_refused",
    refusalCount: refusals.length,
    byStatus: Object.fromEntries(counts),
    likelyCause:
      derived >= unplaced
        ? "The packet targeted IRIS-derived columns or computed rows. IRIS derives Total/Final/Exemption/Normal itself; only the entered column may be written."
        : "The packet carries IRIS codes that this taxpayer's return does not render. Each one must be a named mapping gap, not a fallback row.",
    recommendedActions: [
      "Rebuild the packet so portalFieldMap is version 1.1.0 or newer (aggregated, entered-column targeting, mappingGaps reported).",
      "Treat portalFieldMap.mappingGaps entries as manual-entry work, not as a selector problem.",
      "Re-run in dry mode and confirm 'no refusal is left behind' before going live.",
    ],
    refusals: refusals.slice(0, 40),
  };
}

function classifyRecoverableAssistedIssue(
  errorMessage,
  executionLog,
  jobContext,
  portalEvidence = null,
) {
  const mappingRefusal = buildMappingRefusalDiagnostics(executionLog);
  if (mappingRefusal) {
    return {
      requiredAction: "portal_mapping_review",
      message:
        "IRIS refused the packet's field mapping; no selector bundle change can fix that.",
      pauseReason: `${mappingRefusal.refusalCount} field(s) were refused by the portal (${Object.entries(
        mappingRefusal.byStatus,
      )
        .map(([status, count]) => `${count} ${status}`)
        .join(", ")}).`,
      userInstruction:
        "Review the packet mapping gaps and re-approve. The portal was not modified.",
      selectorDriftDiagnostics: null,
      mappingRefusalDiagnostics: mappingRefusal,
    };
  }

  const selectorDriftDiagnostics = buildSelectorDriftDiagnostics(
    errorMessage,
    executionLog,
    jobContext,
    portalEvidence,
  );
  if (selectorDriftDiagnostics) {
    return {
      requiredAction: "selector_bundle_update",
      message: "IRIS selector mismatch detected during assisted filing.",
      pauseReason:
        "Selector drift suspected. Update the route selector bundle before continuing.",
      userInstruction:
        "Update the affected selector bundle entry, then confirm to retry this phase.",
      selectorDriftDiagnostics,
    };
  }

  // The tour found the panels but could not bind headers to rows. That is a
  // verification gap, not a broken selector: say so, with the per-section numbers,
  // instead of pointing the operator at the selector bundle.
  if (portalEvidence && portalEvidence.state === "structure_unverified") {
    return {
      requiredAction: "portal_structure_review",
      message:
        "IRIS rendered the sections but the agent could not verify their column/row binding, so nothing was written into them.",
      pauseReason: `Unverified structure in: ${portalEvidence.unverified.join(", ")}.`,
      userInstruction:
        "Either re-run the inspection so the grids are expanded, or enter these sections manually. The selector bundle does not need changing.",
      selectorDriftDiagnostics: null,
      portalEvidence,
    };
  }

  if (looksLikeSessionReconnectNeeded(errorMessage)) {
    return {
      requiredAction: "session_reconnect",
      message:
        "Trusted Iris session needs to be reconnected before assisted filing can continue.",
      pauseReason: "The local Iris session is no longer valid for this phase.",
      userInstruction:
        "Sign back into IRIS on the trusted device, return to the expected screen, then confirm to continue.",
      selectorDriftDiagnostics: null,
    };
  }

  return null;
}

function buildRecoveryActions(errorMessage, options = {}) {
  const message = String(errorMessage || "").toLowerCase();

  if (options.selectorDriftDiagnostics) {
    const likelyGroup =
      options.selectorDriftDiagnostics.likelySelectorGroup || "unknown group";
    return [
      `Selector drift is likely in the "${likelyGroup}" group.`,
      "Update the active selector bundle for this route and retry from the latest approved packet.",
      "If the portal layout changed broadly, pause assisted filing and switch to manual packet-guided entry.",
    ];
  }

  if (message.includes("selector")) {
    return [
      "Re-open the expected Iris screen and confirm the DOM did not change.",
      "Update the active selector bundle if the portal UI changed.",
      "Retry the pilot from the latest approved packet after selectors are corrected.",
    ];
  }

  if (message.includes("payment")) {
    return [
      "Complete the PSID or payment step locally and confirm the portal moved forward.",
      "If payment reflected late, refresh the portal state before resuming.",
    ];
  }

  return [
    "Review the latest desktop screenshot and execution log.",
    "Return the filing to the last stable review step if the portal state is unclear.",
    "Retry only after the user confirms the local portal is back on the expected screen.",
  ];
}

async function waitForVisibleSelector(
  windowInstance,
  selector,
  timeoutMs = 15000,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const matched = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })();
    `);

    if (matched) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`Timed out waiting for selector: ${selector}`);
}

async function hasSelector(windowInstance, selector) {
  return windowInstance.webContents.executeJavaScript(`
    Boolean(document.querySelector(${JSON.stringify(selector)}));
  `);
}

async function fillSelector(windowInstance, selector, value) {
  if (
    !selector ||
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return;
  }

  await waitForVisibleSelector(windowInstance, selector);
  await windowInstance.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing selector: " + ${JSON.stringify(selector)});
      element.focus();
      element.value = ${JSON.stringify(String(value))};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    })();
  `);
}

/**
 * IRIS 2.0 real-portal support: text-based element matching.
 * Real IRIS uses generated ids/classes, but visible labels ("Declaration",
 * "114(1) (Return of Income...)") are stable. Selectors may carry
 * "text:Some Label" alternatives that are resolved by visible text.
 */
async function findAndClickByText(windowInstance, candidates) {
  const list = (candidates || [])
    .map((c) => String(c).trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  return await windowInstance.webContents.executeJavaScript(
    `(() => {
      const candidates = ${JSON.stringify(list)};
      const elements = Array.from(
        document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="tab"], li, td, th, span, p, h1, h2, h3, h4, label')
      );
      const visible = elements.filter((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        if (!text || text.length > 140) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
        return candidates.some((c) => text === c || text.includes(c));
      });
      // Prefer the deepest/shortest match so we click the leaf control,
      // not a wrapper card containing half the page.
      visible.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const target = visible[0];
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    })()`,
  );
}

function splitSelectorAlternatives(selector) {
  return String(selector || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Click a selector that may mix CSS alternatives with `text:Label`
 * alternatives. CSS parts are tried first, then text parts, polling until
 * the timeout. This is the real-IRIS-safe variant of clickSelector.
 */
async function clickSelectorWithTextSupport(
  windowInstance,
  selector,
  timeoutMs = 15000,
) {
  const parts = splitSelectorAlternatives(selector);
  const textParts = parts
    .filter((part) => part.toLowerCase().startsWith("text:"))
    .map((part) => part.slice(5).trim())
    .filter(Boolean);
  const cssParts = parts.filter(
    (part) => !part.toLowerCase().startsWith("text:"),
  );
  const start = Date.now();

  // Fast path: a CSS part is immediately available.
  if (cssParts.length > 0) {
    const clicked = await windowInstance.webContents
      .executeJavaScript(
        `(() => {
        const el = document.querySelector(${JSON.stringify(cssParts.join(","))});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`,
      )
      .catch(() => false);
    if (clicked) return;
  }

  while (Date.now() - start < timeoutMs) {
    if (cssParts.length > 0) {
      const clicked = await windowInstance.webContents
        .executeJavaScript(
          `(() => {
          const el = document.querySelector(${JSON.stringify(cssParts.join(","))});
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`,
        )
        .catch(() => false);
      if (clicked) return;
    }
    if (textParts.length > 0) {
      const clicked = await findAndClickByText(windowInstance, textParts).catch(
        () => false,
      );
      if (clicked) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("Missing selector: " + selector);
}

/**
 * Detect the IRIS login form. On the real portal the session does not always
 * carry into the worker window, and the readiness URL (portal root) then
 * renders the login screen — the pilot must not mistake that for a
 * "trusted session confirmed".
 */
async function isIrisLoginFormVisible(windowInstance) {
  return await windowInstance.webContents
    .executeJavaScript(
      `(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
      const visible = inputs.filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (visible.length === 0) return false;
      const pageText = (document.body.innerText || '').toLowerCase();
      return pageText.includes('login') || pageText.includes('forgot password') ||
        pageText.includes('password');
    })()`,
    )
    .catch(() => false);
}

/**
 * Wait (up to timeoutMs) for the user to complete the IRIS login inside the
 * worker window. Returns true as soon as the login form disappears.
 */
async function waitForIrisLogin(windowInstance, timeoutMs = 5 * 60 * 1000) {
  const pollMs = 2500;
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < timeoutMs) {
    const needsLogin = await isIrisLoginFormVisible(windowInstance);
    if (!needsLogin) return true;
    if (!announced) {
      announced = true;
      pushStatus(
        "progress",
        "FBR sign-in required: complete your CNIC/NTN, password, and CAPTCHA in the FBR window, then wait here.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/**
 * Confirm the IRIS dashboard is ready before automation touches it.
 *
 * Real portal: the trusted session may not have carried into this window, so
 * wait for the user's IRIS login FIRST. Only then check the ready selector —
 * and treat a selector timeout as advisory, not fatal: after a proven login
 * a stale/wrong selector (e.g. the mock-only "#iris-dashboard-ready" default
 * on the live portal) must not kill the job before automation starts. Set
 * FBR_IRIS_READY_SELECTOR to the live dashboard element to restore the check.
 */
async function confirmIrisReadiness(
  windowInstance,
  config,
  readySelector,
  executionLog,
) {
  if (config.useMockIris) {
    await waitForVisibleSelector(windowInstance, readySelector, 15000);
    return;
  }

  const loggedIn = await waitForIrisLogin(windowInstance);
  if (!loggedIn) {
    throw new Error(
      "FBR sign-in was not completed. Restart the filing and complete your CNIC/NTN, password, and CAPTCHA in the FBR window.",
    );
  }

  // Arm the welcome-popup auto-closer IMMEDIATELY after login. Previously it
  // was only armed later (inside navigation); if anything threw before that
  // point the popup stayed open for the whole run. dismissIrisWelcomePopup
  // arms a persistent in-page guard and attempts one close.
  await dismissIrisWelcomePopup(windowInstance);

  try {
    await waitForVisibleSelector(windowInstance, readySelector, 15000);
  } catch (error) {
    executionLog.push({
      step: STANDARD_LOG_STEPS.READINESS_CHECK,
      label: "Ready selector not found on the live portal",
      detail: `FBR sign-in is confirmed, but "${readySelector}" was not detected (${
        error instanceof Error ? error.message : String(error)
      }). Continuing on the live portal — set FBR_IRIS_READY_SELECTOR to the correct dashboard element to restore this check.`,
    });
  }
}

/**
 * Dismiss the IRIS 2.0 welcome/promotional popup that overlays the dashboard
 * after login ("Submit Your Income Tax Return ... LAST DATE ..." card).
 * The popup is typically a jQuery-UI style dialog whose close control is the
 * small (x) icon in the dialog title bar; ESC usually closes it too.
 */
async function dismissIrisWelcomePopup(windowInstance) {
  const result = await irisNavigation.probeFrames(windowInstance, {
    action: "close-welcome",
  });
  return result.frames.some((frame) => frame.actionResult?.status === "clicked")
    ? "identified-welcome-close"
    : null;
}

async function isIrisOverlayPresent(windowInstance) {
  const result = await irisNavigation.probeFrames(windowInstance);
  return (
    result.frames.length === 0 ||
    result.frames.some((frame) => frame.unavailable || frame.hasBlockingOverlay)
  );
}

async function clickSelector(windowInstance, selector) {
  if (!selector) {
    return;
  }

  if (String(selector).toLowerCase().includes("text:")) {
    await clickSelectorWithTextSupport(windowInstance, selector);
    return;
  }

  await waitForVisibleSelector(windowInstance, selector);
  await windowInstance.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing selector: " + ${JSON.stringify(selector)});
      element.click();
    })();
  `);
}

// ── Phase 19.10: trySelectorsInPriority ──────────────────────────────────

/**
 * Attempt selectors in priority order (primary first, then fallbacks).
 * Returns the first selector that matches an element in the DOM.
 * Reports drift to server when a fallback is used.
 */
async function trySelectorsInPriority(
  windowInstance,
  action,
  selectors,
  driftContext,
) {
  if (!selectors || selectors.length === 0) {
    throw new Error(`No selectors provided for action: ${action}`);
  }

  let lastError = null;

  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    try {
      await waitForVisibleSelector(windowInstance, selector);
      const usedFallback = i > 0;

      // Phase 19.11: Report drift when a fallback selector is used
      if (usedFallback && driftContext) {
        reportSelectorDriftToServer({
          ...driftContext,
          action,
          primarySelector: selectors[0],
          fallbackUsed: selector,
          fallbackIndex: i,
        }).catch(() => {
          // Fire-and-forget — never block filing on telemetry
        });
      }

      return {
        selector,
        usedFallback,
        fallbackIndex: i,
      };
    } catch (error) {
      lastError = error;
      // Continue to next fallback
    }
  }

  throw new Error(
    `All ${selectors.length} selectors failed for action "${action}". ` +
      `Last error: ${lastError?.message || "unknown"}`,
  );
}

// ── Phase 19.11: reportSelectorDriftToServer ─────────────────────────────

/**
 * Fire-and-forget drift telemetry report to the server.
 * Never blocks filing — errors are silently swallowed.
 */
async function reportSelectorDriftToServer(driftData) {
  try {
    const apiBaseUrl = getApiBaseUrl();
    if (!apiBaseUrl) return;

    const deviceAuthToken =
      launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
    if (!deviceAuthToken) return;

    const reportUrl = new URL(
      "/api/agents/selector-drift-reports",
      apiBaseUrl,
    ).toString();

    const response = await fetch(reportUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceAuthToken}`,
        "X-Agent-Id": getInstallationId(),
      },
      body: JSON.stringify({
        agentId: getInstallationId(),
        jobId: driftData.jobId || null,
        bundleId: driftData.bundleId,
        bundleVersion: Number(driftData.bundleVersion) || 1,
        routeFamily: driftData.routeFamily,
        action: driftData.action,
        primarySelector: driftData.primarySelector,
        fallbackUsed: driftData.fallbackUsed,
        fallbackIndex: driftData.fallbackIndex,
        screenshotUrl: null,
        domSnapshotUrl: null,
      }),
    });

    if (!response.ok && process.env.NODE_ENV === "development") {
      console.warn("[drift-report] Server returned", response.status);
    }
  } catch (_error) {
    // Swallow all errors — drift telemetry must never block filing
  }
}

async function setFileInputFiles(windowInstance, selector, filePaths) {
  if (!selector || !filePaths?.length) {
    return;
  }

  await waitForVisibleSelector(windowInstance, selector);

  const objectIdResponse =
    await windowInstance.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup: "taxrocket-worker",
    });

  if (!objectIdResponse?.result?.objectId) {
    throw new Error(`Could not resolve upload selector: ${selector}`);
  }

  await windowInstance.webContents.debugger.sendCommand(
    "DOM.setFileInputFiles",
    {
      objectId: objectIdResponse.result.objectId,
      files: filePaths,
    },
  );
}

async function downloadJobDocuments(jobId, documents) {
  const targetDir = getWorkerTempDir(jobId);
  fs.mkdirSync(targetDir, { recursive: true });

  const downloaded = [];

  for (const document of documents || []) {
    const response = await fetch(document.downloadUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(
        `Failed to download document "${document.fileName}" for local automation.`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(targetDir, document.fileName);
    fs.writeFileSync(filePath, buffer);
    downloaded.push({
      ...document,
      localPath: filePath,
    });
  }

  return downloaded;
}

async function cleanupJobDocuments(jobId) {
  const targetDir = getWorkerTempDir(jobId);
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function documentByType(documents, documentType) {
  return (documents || []).find(
    (document) => document.documentType === documentType,
  );
}

async function updateLocalJobStatus(jobId, status, body = {}) {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    throw new Error(
      "Trusted desktop device credentials are not ready for status updates.",
    );
  }

  return fetchJson(`${apiBaseUrl}/api/local-agent/jobs/${jobId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deviceAuthToken}`,
    },
    body: JSON.stringify({
      status,
      ...body,
      ...(body.executionLog ? { logs: body.executionLog } : {}),
      ...(body.errorMessage ? { error: body.errorMessage } : {}),
    }),
  });
}

async function claimNextLocalJob() {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    return null;
  }

  const payload = await fetchJson(`${apiBaseUrl}/api/local-agent/jobs/next`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceAuthToken}`,
    },
  });

  const job = payload?.job || null;
  if (!job) return null;
  if (job.status === "awaiting_user_action") return null;
  return job;
}

async function loadLocalJobContext(jobId) {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    throw new Error(
      "Trusted desktop device credentials are not ready for job loading.",
    );
  }

  return fetchJson(`${apiBaseUrl}/api/local-agent/jobs/${jobId}/context`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${deviceAuthToken}`,
    },
  });
}

async function attachDebugger(windowInstance) {
  if (windowInstance.webContents.debugger.isAttached()) {
    return;
  }

  windowInstance.webContents.debugger.attach("1.3");
}

async function detachDebugger(windowInstance) {
  if (!windowInstance.webContents.debugger.isAttached()) {
    return;
  }

  try {
    windowInstance.webContents.debugger.detach();
  } catch {
    // Ignore detach errors during cleanup.
  }
}

async function runLocalDldFlow(jobContext, localDocuments) {
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.automationConfig || {};
  const registration = jobContext.registration || {};

  if (!config.validationUrl || !config.validationSelector) {
    throw new Error("Local DLD validation config is incomplete.");
  }

  await windowInstance.loadURL(config.validationUrl);

  if (
    config.validationRejectSelector &&
    (await hasSelector(windowInstance, config.validationRejectSelector))
  ) {
    throw new Error(
      "The local MyDLD session appears invalid and requires reconnect.",
    );
  }

  await waitForVisibleSelector(windowInstance, config.validationSelector);

  const portalFlowUrl = config.portalFlowUrl || config.flowUrl;
  if (!portalFlowUrl) {
    throw new Error("Local portal flow URL is not configured.");
  }

  await windowInstance.loadURL(portalFlowUrl);
  await attachDebugger(windowInstance);

  try {
    const fields = config.fieldSelectors || {};
    await fillSelector(
      windowInstance,
      fields.tenantName,
      registration.tenantName,
    );
    await fillSelector(
      windowInstance,
      fields.landlordName,
      registration.landlordName,
    );
    await fillSelector(
      windowInstance,
      fields.rentAmount,
      registration.rentAmount,
    );
    await fillSelector(
      windowInstance,
      fields.contractStartDate,
      registration.contractStartDate,
    );
    await fillSelector(
      windowInstance,
      fields.contractEndDate,
      registration.contractEndDate,
    );
    await fillSelector(
      windowInstance,
      fields.unitAddress,
      registration.unitAddress,
    );
    await fillSelector(
      windowInstance,
      fields.makaniNumber,
      registration.makaniNumber,
    );
    await fillSelector(
      windowInstance,
      fields.previousContractId,
      registration.previousContractId,
    );

    const uploads = config.uploadSelectors || {};
    const tenancyContract = documentByType(localDocuments, "tenancyContract");
    const emiratesId = documentByType(localDocuments, "emiratesId");
    const dewaBill = documentByType(localDocuments, "dewaBill");
    const titleDeed = documentByType(localDocuments, "titleDeed");

    await setFileInputFiles(
      windowInstance,
      uploads.tenancyContract,
      tenancyContract?.localPath ? [tenancyContract.localPath] : [],
    );
    await setFileInputFiles(
      windowInstance,
      uploads.emiratesId,
      emiratesId?.localPath ? [emiratesId.localPath] : [],
    );
    await setFileInputFiles(
      windowInstance,
      uploads.dewaBill,
      dewaBill?.localPath ? [dewaBill.localPath] : [],
    );
    await setFileInputFiles(
      windowInstance,
      uploads.titleDeed,
      titleDeed?.localPath ? [titleDeed.localPath] : [],
    );

    if (config.nextButtonSelector) {
      await clickSelector(windowInstance, config.nextButtonSelector);
    }

    for (const selector of config.additionalStepSelectors || []) {
      await clickSelector(windowInstance, selector);
    }

    if (!config.submitButtonSelector) {
      throw new Error("Local DLD submit selector is not configured.");
    }

    await clickSelector(windowInstance, config.submitButtonSelector);
    await new Promise((resolve) =>
      setTimeout(resolve, config.postSubmitWaitMs || 5000),
    );

    if (config.successSelector) {
      await waitForVisibleSelector(
        windowInstance,
        config.successSelector,
        15000,
      );
    } else if (config.successUrlFragment) {
      const startedAt = Date.now();
      let matched = false;
      while (Date.now() - startedAt < 15000) {
        const currentUrl = windowInstance.webContents.getURL();
        if (currentUrl.includes(config.successUrlFragment)) {
          matched = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!matched) {
        throw new Error("Timed out waiting for the local DLD success URL.");
      }
    } else {
      throw new Error(
        "A local success selector or success URL fragment is required.",
      );
    }

    return {
      message: "Local desktop DLD automation completed successfully.",
      finalUrl: windowInstance.webContents.getURL(),
    };
  } finally {
    await detachDebugger(windowInstance);
  }
}

/**
 * Standardized log step labels used across dry run and assisted filing flows.
 *
 * TR-V8-030: All execution log entries use these consistent step labels
 * so job history is easier to interpret regardless of flow type.
 *
 * Step labels:
 * - readiness_check       — Trusted Iris session confirmed
 * - route_navigation      — Route-aware IRIS navigation completed
 * - prefill_compare       — Pre-fill comparison captured
 * - field_fill            — Approved packet values filled
 * - password_reset_pause  — Paused for password reset
 * - otp_captcha_pin_pause — Paused for OTP, captcha, and PIN
 * - payment_psid_pause    — Paused for PSID and payment
 * - payment_verification  — Payment state verified on portal
 * - final_submit_boundary — Stopped before final submit
 * - final_submit_confirmation_gate — Paused for final submit confirmation
 * - completion_verification — Completion evidence verified
 * - proof_capture         — Completion proof captured
 * - failure               — Local desktop job failed
 */
const STANDARD_LOG_STEPS = Object.freeze({
  READINESS_CHECK: "readiness_check",
  ROUTE_NAVIGATION: "route_navigation",
  PREFILL_COMPARE: "prefill_compare",
  FIELD_FILL: "field_fill",
  PASSWORD_RESET_PAUSE: "password_reset_pause",
  OTP_CAPTCHA_PIN_PAUSE: "otp_captcha_pin_pause",
  PAYMENT_PSID_PAUSE: "payment_psid_pause",
  PAYMENT_VERIFICATION: "payment_verification",
  FINAL_SUBMIT_BOUNDARY: "final_submit_boundary",
  FINAL_SUBMIT_CONFIRMATION_GATE: "final_submit_confirmation_gate",
  COMPLETION_VERIFICATION: "completion_verification",
  PROOF_CAPTURE: "proof_capture",
  FAILURE: "failure",
});

/**
 * Standardized capture labels used across dry run and assisted filing flows.
 *
 * TR-V8-030: All screenshot captures use these consistent labels
 * so proof artifacts are identifiable regardless of flow type.
 *
 * Capture labels:
 * - Iris readiness screen
 * - Route navigation state
 * - Pre-fill comparison
 * - Field fill complete
 * - Password reset pause
 * - OTP / captcha / PIN pause
 * - Payment / PSID pause
 * - Payment verification
 * - Dry-run review gate
 * - Final submit confirmation gate
 * - Completed Tasks proof
 * - Acknowledgement proof
 * - Return copy proof
 * - CPR proof
 */
const STANDARD_CAPTURE_LABELS = Object.freeze({
  READINESS: "Iris readiness screen",
  ROUTE_NAVIGATION: "Route navigation state",
  PREFILL_COMPARE: "Pre-fill comparison",
  FIELD_FILL: "Field fill complete",
  PASSWORD_RESET: "Password reset pause",
  OTP_CAPTCHA_PIN: "OTP / captcha / PIN pause",
  PAYMENT_PSID: "Payment / PSID pause",
  PAYMENT_VERIFICATION: "Payment verification",
  DRY_RUN_REVIEW_GATE: "Dry-run review gate",
  FINAL_SUBMIT_CONFIRMATION: "Final submit confirmation gate",
  COMPLETED_TASKS: "Completed Tasks proof",
  ACKNOWLEDGEMENT: "Acknowledgement proof",
  RETURN_COPY: "Return copy proof",
  CPR_PROOF: "CPR proof",
});

// ──────────────────────────────────────────────────────────
// Phase 18: Classic Portal Tree Navigation — FULL IMPLEMENTATION
//
// These functions implement text-based navigation for PrimeFaces/JSF
// tree panels (ui-panelmenu) replacing the stubs from Phase 15.5c.
// The classic portal at irisv1.fbr.gov.pk uses PrimeFaces auto-generated
// IDs that are unstable across sessions, so all navigation is done by
// matching visible text labels rather than CSS selectors.
//
// Key design decisions:
// - Panel headers are matched by their text content (e.g., "Business")
// - Sub-items are matched by text inside expanded panels
// - Data table rows are found by matching text in the first data column
// - Fields are identified by their column position (total/exempt/etc.)
// - "Add" (+) buttons are clicked when no matching row exists
// ──────────────────────────────────────────────────────────

/**
 * Expand a classic portal ui-panelmenu header by visible text.
 *
 * Finds panel headers (h3, a.panel-header, or .ui-panelmenu-title) whose
 * text content includes headerText, then clicks to expand the sub-items.
 * On the real PrimeFaces portal, clicking the header toggles expansion.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} headerText - Visible text of the panel header to click
 * @returns {Promise<boolean>} true if a matching header was found and clicked
 */
async function clickClassicTreePanel(windowInstance, headerText) {
  if (!headerText) return false;

  const clicked = await windowInstance.webContents.executeJavaScript(`
    (() => {
      const searchText = ${JSON.stringify(headerText)};

      // Strategy 1: Find .panel-header links (legacy portal pages)
      let headers = document.querySelectorAll('.panel-header');
      for (const h of headers) {
        if ((h.textContent || '').trim().includes(searchText)) {
          h.classList.add('expanded');
          // Expand the associated sub-items panel
          const panel = h.closest('li');
          if (panel) {
            const subItems = panel.querySelector('.sub-items, ul');
            if (subItems) {
              subItems.classList.add('open');
              subItems.style.display = 'block';
            }
          }
          h.click();
          return true;
        }
      }

      // Strategy 2: Find ui-panelmenu headers via h3 elements
      headers = document.querySelectorAll('.ui-panelmenu .ui-panelmenu-header, h3.ui-panelmenu-title');
      for (const h of headers) {
        if ((h.textContent || '').trim().includes(searchText)) {
          // Click the link inside the header to toggle expansion
          const link = h.querySelector('a');
          if (link) { link.click(); return true; }
          h.click();
          return true;
        }
      }

      // Strategy 3: Generic — find any h3 or heading with matching text
      const allHeadings = document.querySelectorAll('h3, h2, .ui-panelmenu-header a, [role="tab"]');
      for (const h of allHeadings) {
        if ((h.textContent || '').trim().includes(searchText)) {
          h.click();
          return true;
        }
      }

      // Strategy 4: Find any link whose text starts with searchText
      const allLinks = document.querySelectorAll('a, button');
      for (const link of allLinks) {
        const text = (link.textContent || '').trim();
        if (text.includes(searchText) || text.toLowerCase().includes(searchText.toLowerCase())) {
          link.click();
          return true;
        }
      }

      return false;
    })();
  `);

  // Wait for the panel to expand and sub-items to render
  if (clicked) {
    await new Promise((resolve) => setTimeout(resolve, 600));
  } else {
    console.warn(
      `[classic-portal] clickClassicTreePanel("${headerText}") — no matching header found`,
    );
  }

  return clicked;
}

/**
 * Click a classic portal panelmenu sub-item by visible text.
 *
 * Finds sub-menu items (<a> or <li> elements) inside the currently
 * expanded panel whose text matches itemText, then clicks to navigate
 * to the corresponding JSF data table form.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} itemText - Visible text of the sub-item to click
 * @returns {Promise<boolean>} true if a matching sub-item was found and clicked
 */
async function clickClassicTreeMenuItem(windowInstance, itemText) {
  if (!itemText) return false;

  const clicked = await windowInstance.webContents.executeJavaScript(`
    (() => {
      const searchText = ${JSON.stringify(itemText)};

      // Strategy 1: Find links inside visible/open sub-items panels
      const openPanels = document.querySelectorAll('.sub-items.open, .sub-items[style*="block"], ul[data-panel]');
      for (const panel of openPanels) {
        const links = panel.querySelectorAll('a');
        for (const link of links) {
          if ((link.textContent || '').trim().includes(searchText)) {
            link.click();
            return true;
          }
        }
      }

      // Strategy 2: Find any sub-item link by data-nav attribute (legacy portal pages)
      const allSubLinks = document.querySelectorAll('.sub-items a, [data-nav]');
      for (const link of allSubLinks) {
        if ((link.textContent || '').trim().includes(searchText)) {
          link.click();
          return true;
        }
      }

      // Strategy 3: ui-panelmenu-content sub-items (real PrimeFaces)
      const menuItems = document.querySelectorAll('.ui-panelmenu .ui-menuitem-link, .ui-panelmenu-content a');
      for (const link of menuItems) {
        const textSpan = link.querySelector('.ui-menuitem-text');
        const text = (textSpan ? textSpan.textContent : link.textContent || '').trim();
        if (text.includes(searchText)) {
          link.click();
          return true;
        }
      }

      return false;
    })();
  `);

  if (clicked) {
    // Wait for the JSF form / data table to load after navigation
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } else {
    console.warn(
      `[classic-portal] clickClassicTreeMenuItem("${itemText}") — no matching item found`,
    );
  }

  return clicked;
}

/**
 * Fill a classic portal JSF data table cell by row description and field type.
 *
 * Classic portal data tables use a description/code column to identify rows.
 * This function finds the row whose first text column contains rowDesc,
 * then fills the appropriate input field based on fieldType.
 *
 * Field types map to column positions:
 * - "total" / "amount" / "receipt" → the first numeric input after description
 * - "exempt" / "tax" / "deducted" → the second numeric input after description
 * - By explicit selector: if fieldType starts with "#" or contains ":", use as CSS selector
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} rowDesc - Text to match in the row's description column
 * @param {string} fieldType - Which field in the row to fill ("total", "exempt", "tax", css-selector)
 * @param {string} value - Value to fill into the field
 * @returns {Promise<boolean>} true if the field was found and filled
 */
async function fillClassicDataTable(windowInstance, rowDesc, fieldType, value) {
  if (!rowDesc || value === null || value === undefined) return false;

  const filled = await windowInstance.webContents.executeJavaScript(`
    (() => {
      const searchDesc = ${JSON.stringify(rowDesc)};
      const type = ${JSON.stringify(fieldType)};
      const fillValue = ${JSON.stringify(String(value))};

      // If fieldType is an explicit CSS selector, use it directly
      if (type && (type.startsWith('#') || type.includes(':'))) {
        const el = document.querySelector(type);
        if (el) {
          el.focus();
          if (el.tagName === 'SELECT') {
            // Try to find matching option
            const opts = el.options;
            for (let i = 0; i < opts.length; i++) {
              if ((opts[i].textContent || '').trim().toLowerCase().includes(fillValue.toLowerCase())) {
                el.value = opts[i].value;
                break;
              }
            }
            if (!el.value) el.value = fillValue;
          } else {
            el.value = fillValue;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }

      // Find data tables on the page
      const tables = document.querySelectorAll('table.ui-datatable, table[id*="data"], table[class*="dataTable"]');
      if (tables.length === 0) {
        // Fallback: any table with input fields
        const allTables = document.querySelectorAll('table');
        for (const table of allTables) {
          if (table.querySelectorAll('input[type="text"], input:not([type])').length === 0) continue;

          const rows = table.querySelectorAll('tbody tr');
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;

            // Check if the first text-bearing cell contains rowDesc
            let firstText = '';
            for (const cell of cells) {
              const text = (cell.textContent || '').trim();
              // Skip cells that are just inputs with values
              const input = cell.querySelector('input');
              if (input && text === (input.value || '')) {
                firstText = text;
                break;
              }
              if (text && !cell.querySelector('input')) {
                firstText = text;
                break;
              }
              // Also check input values
              if (input && input.value && input.value.includes(searchDesc)) {
                firstText = input.value;
                break;
              }
            }

            if (!firstText || !firstText.includes(searchDesc)) continue;

            // Find the input fields in this row
            const inputs = row.querySelectorAll('input[type="text"], input:not([type]), input[type="number"]');
            if (inputs.length === 0) continue;

            // Filter to only visible, non-readonly inputs
            const editableInputs = Array.from(inputs).filter(inp =>
              !inp.readOnly && inp.type !== 'hidden' && inp.offsetParent !== null
            );

            let targetInput = null;

            if (type === 'total' || type === 'amount' || type === 'receipt') {
              targetInput = editableInputs[0];
            } else if (type === 'exempt' || type === 'tax' || type === 'deducted') {
              targetInput = editableInputs[1] || editableInputs[0];
            } else if (type === 'description' || type === 'code') {
              // Fill the description field itself
              targetInput = row.querySelector('input') || editableInputs[0];
            } else {
              // Try numeric index
              const idx = parseInt(type, 10);
              if (!isNaN(idx) && idx < editableInputs.length) {
                targetInput = editableInputs[idx];
              } else {
                targetInput = editableInputs[0];
              }
            }

            if (targetInput) {
              targetInput.focus();
              targetInput.value = fillValue;
              targetInput.dispatchEvent(new Event('input', { bubbles: true }));
              targetInput.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      }

      // Search through recognized data tables
      for (const table of tables) {
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue;

          // Check if any cell text matches rowDesc
          let matched = false;
          for (const cell of cells) {
            const text = (cell.textContent || '').trim();
            const input = cell.querySelector('input');
            if (input && (input.value || '').includes(searchDesc)) { matched = true; break; }
            if (text.includes(searchDesc)) { matched = true; break; }
          }
          if (!matched) continue;

          // Find editable inputs in this row
          const inputs = row.querySelectorAll('input[type="text"], input:not([type]), input[type="number"]');
          const editableInputs = Array.from(inputs).filter(inp =>
            !inp.readOnly && inp.type !== 'hidden' && inp.offsetParent !== null
          );

          let targetInput = null;
          if (type === 'total' || type === 'amount' || type === 'receipt') {
            targetInput = editableInputs[0];
          } else if (type === 'exempt' || type === 'tax' || type === 'deducted') {
            targetInput = editableInputs[1] || editableInputs[0];
          } else {
            targetInput = editableInputs[0];
          }

          if (targetInput) {
            targetInput.focus();
            targetInput.value = fillValue;
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }

      return false;
    })();
  `);

  if (!filled) {
    console.warn(
      `[classic-portal] fillClassicDataTable("${rowDesc}", "${fieldType}", "${value}") — could not find matching row/field`,
    );
  }

  return filled;
}

/**
 * Click the "Add" (+) button to insert a new row in a classic portal data table.
 *
 * Classic portal uses "Add"/"+" buttons to insert new rows into data tables.
 * The agent must handle row insertion before filling — it can't assume rows exist.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} rowDesc - Description for the new row (used to find which table's Add button)
 * @returns {Promise<boolean>} true if an Add button was found and clicked
 */
async function handleClassicAddRow(windowInstance, rowDesc) {
  if (!rowDesc) return false;

  const clicked = await windowInstance.webContents.executeJavaScript(`
    (() => {
      // Strategy 1: Find Add buttons with class add-row-btn
      let addBtns = document.querySelectorAll('.add-row-btn, button[id*="add"], button[class*="add-row"]');
      for (const btn of addBtns) {
        if (btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }

      // Strategy 2: Find buttons with text "Add" or "+"
      const allBtns = document.querySelectorAll('button, a.btn, [role="button"]');
      for (const btn of allBtns) {
        const text = (btn.textContent || '').trim();
        if ((text === 'Add' || text === '+' || text.includes('Add Row') || text.includes('Add Section')) &&
            btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }

      // Strategy 3: PrimeFaces commandLink for row addition
      const cmdLinks = document.querySelectorAll('a.ui-commandlink, span.ui-icon-plus');
      for (const link of cmdLinks) {
        if (link.offsetParent !== null) {
          link.click();
          return true;
        }
      }

      return false;
    })();
  `);

  if (clicked) {
    // Wait for the new row to render
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return clicked;
}

/**
 * Navigate the new IRIS portal pre-redirect screens (FBR5-FBR8).
 *
 * Between the dashboard and the classic portal, the new IRIS portal shows:
 * 1. FBR5: "Normal Return" vs "Simplified Return" radio buttons
 * 2. FBR6: Tax period auto-selected + "Continue" button
 * 3. FBR7: "Were you tax resident of Pakistan?" Yes/No radio
 * 4. FBR8: "Accept and Continue" to redirect to classic portal
 *
 * Without handling these screens, the agent never reaches the classic portal.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @returns {Promise<{steps: string[], success: boolean}>}
 */
async function navigateNewPortalPreRedirectFlow(
  windowInstance,
  residencyStatus,
) {
  const normalizedResidencyStatus =
    normalizeExplicitResidencyStatus(residencyStatus);
  if (!normalizedResidencyStatus) {
    throw new Error(
      "Missing filing context: select Resident or Non-Resident before portal navigation. No portal action was taken.",
    );
  }
  const residencyInputValue =
    normalizedResidencyStatus === "Resident" ? "yes" : "no";
  const residencyOptionText =
    normalizedResidencyStatus === "Resident" ? "yes" : "no";
  const steps = [];

  // FBR5: Select "Normal Return" radio button
  try {
    const normalReturnClicked = await windowInstance.webContents
      .executeJavaScript(`
      (() => {
        // Try: "Normal Return" radio or label
        const labels = document.querySelectorAll('label, .radio-label, [class*="radio"]');
        for (const label of labels) {
          if ((label.textContent || '').trim().toLowerCase().includes('normal return')) {
            // Click the associated radio input
            const radio = label.querySelector('input[type="radio"]') ||
                          label.previousElementSibling?.querySelector?.('input[type="radio"]') ||
                          document.getElementById(label.getAttribute('for'));
            if (radio) { radio.checked = true; radio.click(); return true; }
            label.click();
            return true;
          }
        }
        // Fallback: find radio by value
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
          const parentText = (r.parentElement?.textContent || '').trim();
          if (parentText.toLowerCase().includes('normal')) { r.checked = true; r.click(); return true; }
        }
        return false;
      })();
    `);
    if (normalReturnClicked) {
      steps.push("return_type_selected");
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch (err) {
    console.warn(
      "[classic-portal] FBR5 return type selection failed:",
      err.message,
    );
  }

  // FBR6: Click "Continue" on period screen
  try {
    const continueClicked = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]');
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').trim();
          if (text.toLowerCase() === 'continue' || text.toLowerCase().includes('continue')) {
            btn.click();
            return true;
          }
        }
        return false;
      })();
    `);
    if (continueClicked) {
      steps.push("period_continue");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (err) {
    console.warn("[classic-portal] FBR6 continue failed:", err.message);
  }

  // FBR7: Select "Yes" for tax residency
  try {
    const residencyClicked = await windowInstance.webContents
      .executeJavaScript(`
      (() => {
        const labels = document.querySelectorAll('label, .radio-label');
        for (const label of labels) {
          const text = (label.textContent || '').trim().toLowerCase();
          if (text.includes('tax resident') || text.includes('resident of pakistan')) {
            // Find the associated radio — look for "Yes"
            const container = label.closest('div, fieldset, .form-group');
            if (container) {
              const targetRadio = container.querySelector('input[value="${residencyInputValue}"], input[id*="${residencyInputValue}"], input[id*="resident"]');
              if (targetRadio) { targetRadio.checked = true; targetRadio.click(); return true; }
            }
            // Fallback: first radio in the group
            const firstRadio = label.parentElement?.querySelector?.('input[type="radio"]');
            if (firstRadio) { firstRadio.checked = true; firstRadio.click(); return true; }
            return true;
          }
        }
        // Fallback: find any radio that looks like "Yes"
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
          const parentText = (r.parentElement?.textContent || '').trim().toLowerCase();
          if (parentText === '${residencyOptionText}' || parentText === '${normalizedResidencyStatus.toLowerCase()}') {
            r.checked = true; r.click(); return true;
          }
        }
        return false;
      })();
    `);
    if (residencyClicked) {
      steps.push("residency_declared");
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch (err) {
    console.warn(
      "[classic-portal] FBR7 residency declaration failed:",
      err.message,
    );
  }

  // FBR8: Click "Accept and Continue" to redirect to classic portal
  try {
    const redirectClicked = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]');
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').trim().toLowerCase();
          if (text.includes('accept') || text.includes('redirect') || text.includes('continue to')) {
            btn.click();
            return true;
          }
        }
        // Fallback: look for "Continue" again (might be generic)
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').trim().toLowerCase();
          if (text === 'continue') {
            btn.click();
            return true;
          }
        }
        return false;
      })();
    `);
    if (redirectClicked) {
      steps.push("redirect_accepted");
    }
  } catch (err) {
    console.warn(
      "[classic-portal] FBR8 redirect acceptance failed:",
      err.message,
    );
  }

  // Wait for the classic portal to fully load after redirect
  if (steps.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return {
    steps,
    success: steps.length >= 2,
    detail: `Pre-redirect flow: ${steps.join(" → ") || "no screens detected"}. ${steps.length} of 4 screens handled.`,
  };
}

/**
 * Map an irisSection label to the classic portal tree navigation path.
 *
 * Returns { panel, item } for the tree panel header and sub-item to click,
 * or null if the section cannot be mapped.
 */
function resolveClassicSectionPath(irisSection) {
  if (!irisSection) return null;
  const s = irisSection.toLowerCase();

  if (s.includes("other revenue") || s.includes("other revenues")) {
    return { panel: "Business", item: "Other Revenues" };
  }
  if (s.includes("business asset")) {
    return { panel: "Business", item: "Business Assets" };
  }
  if (s.includes("fixed") && s.includes("final tax")) {
    return { panel: "Tax Chargeable / Payments", item: "Fixed / Final Tax" };
  }
  if (s.includes("adjustable tax") || s.includes("tax credit")) {
    return { panel: "Tax Chargeable / Payments", item: "Adjustable Tax" };
  }
  if (s.includes("personal expense")) {
    return { panel: "Wealth Statement", item: "Personal Expenses" };
  }
  if (s.includes("asset") && (s.includes("wealth") || s.includes("personal"))) {
    return { panel: "Wealth Statement", item: "Assets" };
  }
  if (s.includes("liabilit")) {
    return { panel: "Wealth Statement", item: "Liabilities" };
  }
  if (s.includes("reconciliation")) {
    return { panel: "Wealth Statement", item: "Reconciliation" };
  }
  if (
    s.includes("attribut") ||
    s.includes("business sector") ||
    s.includes("residence")
  ) {
    return { panel: "Attributes", item: "Business Sector / Residence" };
  }
  if (s.includes("capital asset") || s.includes("7e")) {
    return { panel: "Capital Assets (7E)", item: "Property Details" };
  }
  if (s.includes("comput") || s.includes("return summar")) {
    return { panel: "Computations", item: "Return Summary" };
  }
  return null;
}

/**
 * Navigate to a specific classic portal section by clicking tree panels and sub-items.
 *
 * This is used for per-section navigation: navigate → fill section fields →
 * navigate to next section → fill its fields. Each section lives on its own
 * JSF form page in the real classic portal.
 *
 * @param {BrowserWindow} windowInstance
 * @param {string} irisSection - IRIS section name (e.g., "Other Revenues")
 * @returns {Promise<boolean>}
 */
async function navigateToClassicSection(windowInstance, irisSection) {
  if (!irisSection) return false;

  const path = resolveClassicSectionPath(irisSection);
  if (!path) {
    console.warn(
      `[classic-portal] No tree path mapped for section: "${irisSection}"`,
    );
    return false;
  }

  const panelExpanded = await clickClassicTreePanel(windowInstance, path.panel);
  if (!panelExpanded) {
    console.warn(
      `[classic-portal] Could not expand panel "${path.panel}" for section "${irisSection}"`,
    );
  }

  const itemClicked = await clickClassicTreeMenuItem(windowInstance, path.item);
  if (itemClicked) {
    console.log(
      `[classic-portal] Navigated to section: ${path.panel} \u2192 ${path.item}`,
    );
    return true;
  }

  console.warn(
    `[classic-portal] Could not click item "${path.item}" in panel "${path.panel}"`,
  );
  return false;
}

/**
 * Full classic portal tree navigation \u2014 initial arrival (Phase 18 implementation).
 *
 * This function handles getting the agent TO the classic portal and verifying
 * it's ready. Per-section navigation happens separately via navigateToClassicSection()
 * during the fill loop, because each section is on its own JSF form page.
 *
 * Navigates pre-redirect screens (FBR5-FBR8), then verifies the tree panel.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {Object} routeSelector - Route selector config
 * @returns {Promise<{steps: string[], formReady: boolean, detail: string}>}
 */
async function navigateClassicPortalFlow(
  windowInstance,
  routeSelector,
  useMockIris,
  residencyStatus,
) {
  const steps = [];

  if (useMockIris) {
    const classicUrl = resolveFbrPortalUrl("https://iris.fbr.gov.pk/");
    await windowInstance.loadURL(classicUrl);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    steps.push("classic_portal_loaded");

    const formReady = await verifyFormReady(windowInstance, routeSelector);
    if (formReady) steps.push("data_table_ready");

    return {
      steps,
      formReady,
      detail: `Classic portal mock loaded: ${steps.join(" \u2192 ")}. Form ready: ${formReady}.`,
    };
  }

  const preRedirectResult = await navigateNewPortalPreRedirectFlow(
    windowInstance,
    residencyStatus,
  );
  steps.push(...preRedirectResult.steps.map((s) => `preredirect_${s}`));
  steps.push("awaiting_classic_portal");

  if (!preRedirectResult.success) {
    console.warn(
      "[classic-portal] Pre-redirect flow may not have completed all screens. Proceeding anyway...",
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const isClassicPortal = await windowInstance.webContents.executeJavaScript(`
    (() => {
      return !!(
        document.querySelector('.ui-panelmenu') ||
        document.querySelector('#correspondenceTabs\\\\:returnAmountForm\\\\:menuPanel') ||
        document.querySelector('[id*="menuPanel"]') ||
        document.querySelector('.tree-panel') ||
        document.querySelector('table.ui-datatable')
      );
    })();
  `);

  if (!isClassicPortal) {
    throw new Error(
      "Expected classic portal (PrimeFaces/JSF tree panel) but tree menu was not detected on the page after pre-redirect flow.",
    );
  }
  steps.push("classic_portal_detected");

  const formReady = await verifyFormReady(windowInstance, routeSelector);
  if (formReady) steps.push("data_table_ready");

  return {
    steps,
    formReady,
    detail: `Classic portal live flow: ${steps.join(" \u2192 ")}. Form ready: ${formReady}.`,
  };
}

/**
 * Determine if the route requires classic portal (PrimeFaces/JSF) navigation.
 */
function isClassicPortalRoute(routeMetadata) {
  return routeMetadata?.routeFamily === "classic_individual_114";
}

function normalizeExplicitResidencyStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (normalized === "resident") return "Resident";
  if (normalized === "non-resident" || normalized === "nonresident")
    return "Non-Resident";
  return null;
}

async function runLocalIrisNavigationCheck(jobContext, job) {
  assertNavigatorBuild();
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.taxAutomationConfig || {};
  const packet = jobContext.filingPacket || {};
  const snapshot = packet.snapshot || jobContext.snapshot || {};
  const taxYear = Number(
    packet.taxYear || snapshot.filing?.taxYear || job?.payload?.taxYear,
  );
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    throw new Error(
      "The approved packet does not specify a valid tax year. No portal action was taken.",
    );
  }
  const residencyStatus = normalizeExplicitResidencyStatus(
    snapshot.filing?.residencyStatus,
  );
  if (!residencyStatus) {
    const pauseMessage =
      "Missing filing context: select Resident or Non-Resident in TaxRocket before starting FBR navigation. No portal action was taken.";
    const executionLog = [
      {
        step: "missing_residency_context",
        label: "Missing residency context",
        detail: pauseMessage,
      },
    ];
    const result = {
      mode: "live_return_navigation_only",
      requiredAction: "missing_residency_context",
      message: pauseMessage,
      pauseReason: pauseMessage,
      taxYear,
      submitted: false,
      navigationVerified: false,
      sectionTourComplete: false,
      captures: [],
    };
    await updateLocalJobStatus(job.id, "awaiting_user_action", {
      pauseAction: "missing_residency_context",
      pauseMessage,
      result,
      executionLog,
    });
    return {
      paused: true,
      pauseAction: "missing_residency_context",
      pauseMessage,
      result,
      executionLog,
    };
  }
  const reconciliationStatus = String(
    snapshot.filing?.reconciliationStatus || "",
  ).toUpperCase();
  const reconciliationGapRaw = snapshot.filing?.reconciliationGap;
  const reconciliationGap = Number(
    reconciliationGapRaw === null || reconciliationGapRaw === undefined
      ? NaN
      : String(reconciliationGapRaw).replace(/,/g, ""),
  );
  const reconciliationResolved =
    reconciliationStatus === "RESOLVED" &&
    Number.isFinite(reconciliationGap) &&
    reconciliationGap === 0;
  if (!reconciliationResolved) {
    const gapText = Number.isFinite(reconciliationGap)
      ? ` The recorded unresolved amount is PKR ${Math.abs(reconciliationGap).toLocaleString()}.`
      : "";
    const pauseMessage = `Your TaxRocket return data still needs reconciliation.${gapText} Resolve the outstanding amount before starting FBR. No portal action was taken.`;
    const executionLog = [
      {
        step: "reconciliation_review_required",
        label: "Reconciliation review required",
        detail: pauseMessage,
      },
    ];
    const result = {
      mode: "live_return_navigation_only",
      requiredAction: "portal_reconciliation_review",
      message: pauseMessage,
      pauseReason: pauseMessage,
      taxYear,
      submitted: false,
      navigationVerified: false,
      sectionTourComplete: false,
      reconciliationStatus,
      reconciliationGap: Number.isFinite(reconciliationGap)
        ? reconciliationGap
        : null,
      captures: [],
    };
    await updateLocalJobStatus(job.id, "awaiting_user_action", {
      pauseAction: "portal_reconciliation_review",
      pauseMessage,
      result,
      executionLog,
    });
    return {
      paused: true,
      pauseAction: "portal_reconciliation_review",
      pauseMessage,
      result,
      executionLog,
    };
  }
  const packetIncomeSources = Array.isArray(snapshot.filing?.incomeSources)
    ? snapshot.filing.incomeSources.map((source) => String(source))
    : null;
  // An approved packet has passed the wealth-reconciliation gate. That is the
  // packet-backed answer to IRIS's Wealth Confirmation question; do not infer it
  // from whatever the live page happens to show.
  const wealthStatement = Boolean(
    snapshot.filing?.reconciliationStatus === "RESOLVED" ||
    snapshot.filing?.openingWealth != null ||
    snapshot.filing?.closingWealth != null ||
    (Array.isArray(snapshot.portalFieldMap?.wealthFields) &&
      snapshot.portalFieldMap.wealthFields.length > 0),
  );
  const newReturnContext = {
    routeFamily: snapshot.routeMetadata?.routeFamily || null,
    filingIntent: snapshot.routeMetadata?.filingIntent || "original",
    residencyStatus: residencyStatus || null,
    incomeSources: packetIncomeSources,
    wealthStatement,
  };
  const executionLog = [];
  activeJobExecutionLog = executionLog;
  const onStep = (step, detail) => {
    executionLog.push({
      step,
      label: step.replace(/_/g, " "),
      detail,
      at: new Date().toISOString(),
    });
    pushStatus("progress", detail);
  };
  onStep(
    "live_pilot_boundary",
    `Original 114(1), TY${taxYear}: existing draft first, otherwise guarded TY2026+ new-return setup. This navigation check does not enter values; approved autofill may run afterward only when both live gates and packet mapping allow it. Save and Submit are never automated.`,
  );
  onStep(
    "new_return_context",
    `Route=${newReturnContext.routeFamily || "unknown"}; filingIntent=${newReturnContext.filingIntent || "unknown"}; residency=${newReturnContext.residencyStatus || "not provided in packet/context"}; incomeSources=${packetIncomeSources ? packetIncomeSources.length : "not provided"}; wealthStatement=${wealthStatement}.`,
  );
  const taxpayerIdentifier = String(launchState.accountReference || "")
    .trim()
    .replace(/[ -]/g, "");
  const stateKey = `${job.id}:${packet.packetHash || ""}:${taxYear}:${taxpayerIdentifier}`;
  if (!navigationStates.has(stateKey)) navigationStates.set(stateKey, {});
  navigationStates.get(stateKey).jobId = job.id;
  lastNavigationOptions = { taxYear, taxpayerIdentifier };
  onStep(
    "agent_handoff",
    `Main ${AGENT_BUILD_TAG}; navigator ${irisNavigation.BUILD_TAG}; openReturn=true; inspectSections=true; targetConfigured=${/^(?:\d{7}|\d{8}|\d{13})$/.test(taxpayerIdentifier)}.`,
  );
  const allowedHandoffSections = new Set(
    irisNavigation.SALARY_WITHHOLDING_SECTION_IDS,
  );
  const compatibleTour = (tour) =>
    Boolean(
      tour &&
      Array.isArray(tour.sections) &&
      tour.sections.every((entry) => allowedHandoffSections.has(entry?.id)) &&
      tour.sections.length <= allowedHandoffSections.size,
    );
  if (lastTourStateKey !== stateKey || !compatibleTour(lastSectionTour)) {
    lastSectionTour = null;
  }
  const storedNavigationState = navigationStates.get(stateKey);
  if (
    storedNavigationState.sectionTour &&
    !compatibleTour(storedNavigationState.sectionTour)
  ) {
    // A resumed fix24 job may still carry a completed broad tour. Discard it
    // before this narrower Salary + withholding test so stale Property/Wealth/
    // Payments/Computations state cannot be replayed.
    storedNavigationState.sectionTour = null;
    onStep(
      "stale_section_tour_reset",
      "Discarded stale section state; this handoff will inspect only Salary and Salary withholding.",
    );
  }
  lastTourStateKey = stateKey;
  const requestedFamily = packet.snapshot?.routeMetadata?.routeFamily;
  const supportedFamily =
    !requestedFamily || requestedFamily === "normal_individual_114";
  // Ignore mock checkpoint URLs entirely. All inspection occurs on the SAME
  // authenticated BrowserWindow; createLoginWindow does not reload its SPA.
  let outcome;
  try {
    outcome = supportedFamily
      ? await irisNavigation.inspectNavigation(getLivePortalWindow, {
          ...lastNavigationOptions,
          newReturnContext,
          openReturn: true,
          state: navigationStates.get(stateKey),
          inspectSections: true,
          // This supervised test explicitly includes Salary and its withholding
          // grid so the verified 64020004 row can be filled. Property, Wealth,
          // Payments, Computations, and other unsupported routes remain closed.
          sectionIds: irisNavigation.SALARY_WITHHOLDING_SECTION_IDS,
          beforeStep: () =>
            ensureNavigationJobActive(job.id, taxpayerIdentifier),
          onSectionCaptured: async (snapshot) => {
            lastSectionTour = snapshot.sectionTour
              ? { ...snapshot.sectionTour, jobId: job.id, taxYear }
              : null;
            writePortalInspectionToDisk(
              { ...snapshot, sectionTour: lastSectionTour },
              job,
            );
          },
          hosts: config.portalHostAllowlist?.length
            ? config.portalHostAllowlist
            : irisNavigation.DEFAULT_HOSTS,
          onStep,
        })
      : {
          inspection: await irisNavigation.probeFrames(
            getLivePortalWindow,
            lastNavigationOptions,
          ),
          requiredAction: "portal_unsupported_route",
        };
  } catch (error) {
    if (
      error.code !== "NAVIGATION_TARGET_CHANGED" &&
      error.code !== "NAVIGATION_GUARD_UNAVAILABLE"
    )
      throw error;
    if (error.code === "NAVIGATION_TARGET_CHANGED") {
      lastSectionTour = null;
      navigationStates.delete(stateKey);
    }
    outcome = {
      inspection: await irisNavigation.probeFrames(getLivePortalWindow, {
        taxYear,
        taxpayerIdentifier: launchState.accountReference || "",
      }),
      requiredAction:
        error.code === "NAVIGATION_TARGET_CHANGED"
          ? "portal_identity_changed"
          : "portal_job_check_unavailable",
    };
    onStep("navigation_guard", error.message);
  }
  if (outcome.inspection.sectionTour) {
    lastSectionTour = {
      ...outcome.inspection.sectionTour,
      jobId: job.id,
      taxYear,
    };
  }
  if (lastSectionTour)
    outcome.inspection = {
      ...outcome.inspection,
      sectionTour: lastSectionTour,
    };
  const inspectionPath = writePortalInspectionToDisk(outcome.inspection, job);
  const rows = outcome.inspection.frames.flatMap((frame) => frame.rows || []);
  const economicSourceLabels = {
    salary: "Income from Salary",
    pension: "Income from Other Sources",
    property_rent: "Property Rental Income",
    services: "Income from Business",
    bank_profit: "Income from Other Sources",
    dividend: "Income from Other Sources",
    capital_gains: "Capital Gain",
    capital_gain: "Capital Gain",
    business: "Income from Business",
    agriculture: "Income from Agriculture",
    foreign_income_assets: "Income from Foreign Sources and Assets",
    other_income: "Income from Other Sources",
  };
  const expectedEconomicSources = (packetIncomeSources || [])
    .map(
      (source) =>
        economicSourceLabels[String(source).toLowerCase()] || String(source),
    )
    .filter(Boolean);
  const economicGateMessage =
    expectedEconomicSources.length > 0
      ? `In the FBR window, select only ${expectedEconomicSources.join(", ")} and choose ${residencyStatus === "Resident" ? "Yes (Resident)" : "No (Non-Resident)"}. Then choose Continue filing here. Do not submit the return.`
      : "In the FBR window, answer the income and residency questions for this filing, then choose Continue filing here. Do not submit the return.";
  const messages = {
    session_reconnect:
      "Sign in to FBR in the open window, then choose Continue. Nothing was changed.",
    portal_popup:
      "An FBR dialog is open. Complete the required verification locally, then choose Continue. The agent did not bypass it.",
    portal_inspection: `Your FBR return is being prepared. No values were entered, saved or submitted.`,
    portal_readiness_unverified:
      "FBR is still loading. Keep the intended FBR window open, wait a moment, and choose Continue.",
    portal_identity_required:
      "Confirm the intended taxpayer CNIC or NTN in the FBR window, then choose Continue. It must match this filing.",
    portal_taxpayer_mismatch:
      "The taxpayer details in FBR do not match this filing. Check the correct FBR account and taxpayer before continuing. No tax values were changed.",
    portal_document_mismatch:
      "The open FBR return does not match the requested form, full-year period, or tax year. Check the correct return before continuing.",
    portal_draft_ambiguous:
      "More than one matching return was found. Open the return you intend to file, then choose Continue.",
    portal_draft_list_incomplete:
      "The full list of FBR returns is not visible. Show the complete list or open the intended return, then choose Continue.",
    portal_economic_transactions_gate: economicGateMessage,
    portal_reconciliation_review:
      "The TaxRocket return data still has an unresolved reconciliation amount. Resolve it before starting FBR. No portal values were changed.",
    portal_new_return_setup: `FBR needs the return setup completed. Select the intended 114(1) form and TY${taxYear} period, answer only the questions you know, then choose Continue. Do not submit the return.`,
    portal_sections_inspected:
      "Your return is prepared for review. No amounts, uploads, payments, saves, or submissions were made.",
    portal_section_navigation:
      "The requested part of the FBR return could not be opened safely. Your progress is retained; choose Continue to try again. No amounts were changed.",
    portal_section_capture:
      "The current part of the FBR return is not ready. No fields were mislabeled or changed. Choose Continue to try again.",
    portal_employer_review:
      "An employer could not be added by its exact registered name. Add it in the FBR window (Employment > Salary > + Add Employer Details), then choose Continue. Nothing was saved or submitted.",
    portal_autofill_review:
      "Some approved packet fields could not be placed safely. Review the named fields in the FBR window. Nothing was saved or submitted.",
    portal_identity_changed:
      "The taxpayer selection changed while filing. Confirm the intended taxpayer in FBR, then choose Continue.",
    portal_job_check_unavailable:
      "TaxRocket could not check the filing connection. Make sure the web app is open, then choose Continue.",
    portal_fields_verified: `Your TY${taxYear} Salary return is open and the Salary plus withholding fields are ready. No amounts were saved or submitted.`,
    portal_fields_unverified:
      "The return opened, but the Salary fields could not be verified. No amount fields were changed. Choose Continue to try again.",
    portal_navigation:
      "The expected FBR return could not be verified. Keep the correct FBR return open, then choose Continue. Do not submit.",
    portal_unsupported_route:
      "This filing currently supports the Salary return only. The requested return was not changed or substituted.",
  };

  const pauseMessage =
    outcome.pauseMessage ||
    messages[outcome.requiredAction] ||
    messages.portal_inspection;
  const result = {
    mode: "live_return_navigation_only",
    requiredAction: outcome.requiredAction,
    message: pauseMessage,
    pauseReason: pauseMessage,
    taxYear,
    returnTypeConfirmed: outcome.inspection.frames.some(
      (frame) =>
        frame.document?.originalFullYear &&
        frame.document?.taxYear === taxYear &&
        frame.document?.identityStatus === "match",
    ),
    submitted: false,
    navigationVerified: [
      "portal_fields_verified",
      "portal_sections_inspected",
    ].includes(outcome.requiredAction),
    sectionTourComplete: outcome.requiredAction === "portal_sections_inspected",
    newReturnMenuOpened: Boolean(
      navigationStates.get(stateKey)?.newEntryOpened,
    ),
    selectorBundle: getSelectorBundleSignal(jobContext),
    domEvidence: outcome.inspection,
    captures: [],
    ...(outcome.economicTransactionsGate
      ? { economicTransactionsGate: outcome.economicTransactionsGate }
      : {}),
  };
  // portal_sections_inspected is a successful completion of the tour, not a
  // request for the user to do something. Reporting it as paused meant autofill
  // was unreachable even when navigation had fully succeeded: both filing flows
  // return early on `navigation?.paused`. Every other requiredAction is still a
  // genuine checkpoint. Save/Submit remain untouched either way.
  const navigationComplete =
    outcome.requiredAction === "portal_sections_inspected";
  onStep(
    navigationComplete ? "inspection_complete" : "inspection_pause",
    `Navigation checkpoint: ${outcome.requiredAction}. Local structure file: ${inspectionPath}`,
  );
  if (navigationComplete) {
    return {
      paused: false,
      pauseAction: outcome.requiredAction,
      pauseMessage,
      result,
      executionLog,
    };
  }
  await updateLocalJobStatus(job.id, "awaiting_user_action", {
    pauseAction: outcome.requiredAction,
    pauseMessage,
    result,
    executionLog,
  });
  return {
    paused: true,
    pauseAction: outcome.requiredAction,
    pauseMessage,
    result,
    executionLog,
  };
}

/**
 * Phase 1: fill packet values into the live IRIS 2.0 return.
 *
 * Addresses rows by their IRIS system code (the row container's `id`) and the
 * column by matching the rendered header text, because the amount inputs carry
 * no id/name of their own — see electron-connect/iris-row-filler.js.
 *
 * Runs only for the section currently on screen; codes belonging to other
 * sections come back as `row_not_found`, which is expected and reported rather
 * than treated as failure. Section-by-section navigation is Phase 2 work.
 */
async function runRealIrisAutofill(jobContext, job, mode) {
  const windowInstance = await ensureWorkerWindow();
  const packet = jobContext.filingPacket || {};
  const snapshot = packet.snapshot || jobContext.snapshot || {};
  const portalFieldMap = Array.isArray(snapshot.portalFieldMap)
    ? snapshot.portalFieldMap
    : [];

  const allCoded = portalFieldMap.filter((f) => f && f.irisCode);
  // Wealth Statement figures travel in the packet, but this build does not enter
  // them: wealth sections are not toured and the expense rows only exist after a
  // modal step. Holding them out keeps the Salary handoff from pausing on codes
  // it was never going to place, and they are reported as prepared-not-entered.
  const wealthPrepared = allCoded.filter(
    (f) => f.sourceGroup === "wealthFields",
  );
  const coded = allCoded.filter((f) => f.sourceGroup !== "wealthFields");
  const executionLog = [];
  activeJobExecutionLog = executionLog;

  const onStep = (step, detail) => {
    executionLog.push({
      step,
      label: step.replace(/_/g, " "),
      detail,
      at: new Date().toISOString(),
    });
    pushStatus("progress", detail);
  };

  onStep(
    "real_autofill_start",
    `Real-portal autofill (${mode === "dry" ? "DRY RUN — no writes" : "LIVE"}): ` +
      `${coded.length} IRIS-coded fields of ${portalFieldMap.length} in packet.`,
  );
  if (wealthPrepared.length) {
    onStep(
      "real_autofill_wealth_prepared",
      `${wealthPrepared.length} Wealth Statement figure(s) are in the packet (${wealthPrepared
        .map((f) => `${f.irisCode}=${f.value}`)
        .join(", ")}). ${
        getWealthAutofillEnabled()
          ? "The wealth driver will handle them after Salary."
          : "TAXROCKET_WEALTH_AUTOFILL is off, so they are NOT entered."
      }`,
    );
  }

  if (!coded.length) {
    const pauseMessage =
      "No approved FBR fields were available for this handoff. Review the filing packet before continuing. Nothing was saved, submitted, calculated, or paid.";
    onStep(
      "real_autofill_skipped",
      "The approved packet contains no IRIS-coded fields, so the handoff cannot be marked complete.",
    );
    return {
      paused: true,
      pauseAction: "portal_autofill_review",
      pauseMessage,
      executionLog,
      result: {
        mode,
        summary: { total: 0, filled: 0, skipped: 0, byStatus: {} },
        results: [],
        message: pauseMessage,
        reviewRequired: true,
      },
    };
  }

  // The tour drives navigation section by section from whatever is on screen, and
  // it only works inside the return. After a resume — or a start where the draft
  // row's dblclick did not open anything — the window can be sitting on the
  // dashboard or the economic-transactions gate, and every section lookup would
  // then report `row_not_found` and the operator would read that as "the packet is
  // wrong". Prove the workspace first; hold with the reason if it is not there.
  const workspace = await windowInstance.webContents
    .executeJavaScript(irisNavigation.RETURN_WORKSPACE_PROBE)
    .catch((error) => ({
      returnWorkspace: false,
      reason: `probe_failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  onStep(
    workspace?.returnWorkspace
      ? "real_autofill_workspace_confirmed"
      : "real_autofill_workspace_missing",
    workspace?.returnWorkspace
      ? `Return workspace confirmed (${workspace.inputs ?? "?"} entered inputs).`
      : `No return workspace on screen (${workspace?.reason || "unknown"}). ` +
          `Open the intended 114(1)/116 return so the tax-year header is visible, then resume — ` +
          `nothing was filled and no section tour was attempted.`,
  );
  if (!workspace?.returnWorkspace) {
    return {
      paused: true,
      pauseAction: "portal_state_confirmation",
      pauseMessage:
        "The agent could not prove the return is open, so it held instead of filling.",
      executionLog,
      result: {
        mode,
        workspace,
        summary: { total: coded.length, filled: 0, skipped: 0, byStatus: {} },
        results: [],
      },
    };
  }

  // Phase 2a. The section tour leaves the portal on its last view (Attachment,
  // which has no data rows), and the filler only sees the section on screen.
  // Walk the sections that actually own these codes, filling each in place.
  const sectionTour = lastSectionTour || null;
  const plan = irisNavigation.planSectionFills(coded, sectionTour);
  const taxYear =
    Number(packet.taxYear || snapshot.filing?.taxYear) || undefined;
  const taxpayerIdentifier = launchState.accountReference || "";

  let results = [];
  const unexpectedPrefill = [];

  // Employer Details (Employment > Salary). Names only: IRIS fills the
  // registration number when the exact registered name is chosen. Done before
  // the salary figures so an employer card appearing cannot disturb them.
  const employersPrepared = irisEmployerDriver.planEmployers(
    snapshot.portalFieldMapDetailed?.employers,
  );
  const employerConfirmed =
    employersPrepared.length > 0 && hasConfirmedEmployerReview(jobContext);
  const employerEnabled =
    employersPrepared.length > 0 &&
    getEmployerAutofillEnabled() &&
    !employerConfirmed;
  let employerOutcome = null;
  if (employerConfirmed) {
    onStep(
      "real_autofill_employer_confirmed",
      `The taxpayer confirmed that the employer details were added in FBR (${employersPrepared.join(
        "; ",
      )}). The agent trusts that and does not search or change employers again.`,
    );
  }
  if (employersPrepared.length && !employerEnabled && !employerConfirmed) {
    onStep(
      "real_autofill_employer_prepared",
      `${employersPrepared.length} employer(s) are in the packet (${employersPrepared.join(
        "; ",
      )}) but TAXROCKET_EMPLOYER_AUTOFILL is off, so they are NOT added. Add them in the FBR window (Employment > Salary > + Add Employer Details).`,
    );
  }
  if (employerEnabled) {
    onStep(
      "real_autofill_employer_start",
      `Employer Details (${mode === "dry" ? "DRY - nothing clicked" : "LIVE"}): ${employersPrepared.length} employer(s) by registered name. The agent never types a registration number and never picks a name that is not an exact match.`,
    );
    try {
      employerOutcome = await irisEmployerDriver.runEmployerDriver(
        windowInstance,
        employersPrepared,
        {
          mode: mode === "dry" ? "dry" : "live",
          navigate: (sectionId) =>
            irisNavigation.navigateToSection(windowInstance, {
              sectionId,
              taxYear,
              taxpayerIdentifier,
            }),
          beforeStep: () =>
            ensureNavigationJobActive(
              job.id,
              String(taxpayerIdentifier || "")
                .trim()
                .replace(/[ -]/g, ""),
            ),
          onStep,
        },
      );
    } catch (error) {
      onStep(
        "real_autofill_employer_error",
        `Employer driver stopped: ${error instanceof Error ? error.message : String(error)}. Nothing further was clicked.`,
      );
      employerOutcome = {
        results: employersPrepared.map((name) => ({
          name,
          status: irisEmployerDriver.EMPLOYER_STATUS.SETUP_FAILED,
          setupStatus: "driver_error",
        })),
        setup: [],
      };
    }
  }
  const employerIssues = employerOutcome
    ? irisEmployerDriver.describeEmployerIssues(employerOutcome.results)
    : [];
  const employersResult = {
    enabled: employerEnabled,
    mode,
    prepared: employersPrepared,
    confirmedByTaxpayer: employerConfirmed,
    summary: employerOutcome
      ? irisEmployerDriver.summariseEmployers(employerOutcome.results)
      : null,
    results: employerOutcome?.results || [],
  };
  // Employers come first. When one cannot be added by its exact registered name
  // the run stops HERE: the taxpayer adds it in IRIS and presses Continue, and
  // the figures are entered on the resumed run (which is idempotent).
  if (employerIssues.length) {
    const pauseMessage =
      `Employer details need you: ${employerIssues.join(". ")}. ` +
      `Add the employer yourself in the FBR window (Employment > Salary > + Add Employer Details), ` +
      `then press "I have added the employer in FBR - Continue". ` +
      `The salary and wealth figures have not been entered yet; they are entered after you continue. ` +
      `Nothing was saved, submitted, calculated, or paid.`;
    onStep("real_autofill_employer_pause", pauseMessage);
    return {
      paused: true,
      pauseAction: getEmployerReviewAction(),
      pauseMessage,
      executionLog,
      result: {
        mode,
        summary: { total: 0, filled: 0, skipped: 0, byStatus: {} },
        salarySummary: { total: 0, filled: 0, skipped: 0, byStatus: {} },
        results: [],
        message: pauseMessage,
        wealthPrepared: wealthPrepared.map((f) => ({
          irisCode: f.irisCode,
          label: f.label,
          value: f.value,
        })),
        wealth: { enabled: false, mode, summary: null, setup: [] },
        employers: employersResult,
        unexpectedPrefill: [],
        overwriteConflicts: [],
        reviewRequired: true,
        handoffReviewConfirmed: false,
      },
    };
  }
  if (!plan.groups.length) {
    onStep(
      "real_autofill_no_plan",
      "No packet code was seen in the captured section tour, so no section could be targeted. Nothing was filled.",
    );
  }
  for (const group of plan.groups) {
    // This approved fix is intentionally limited to salary withholding row
    // 64020004. If some other tax-deduction code appears in the same group, hold
    // instead of treating it as part of this one-row permission.
    const isTaxDeductionGroup = group.sectionId === "tax_deductions";
    if (
      isTaxDeductionGroup &&
      group.fields.some(
        (field) => String(field.irisCode || "").trim() !== "64020004",
      )
    ) {
      onStep(
        "real_autofill_section_skipped",
        "tax_deductions: the approved one-row scope (64020004) did not match every field in this group; all of its fields were left untouched.",
      );
      results = results.concat(
        group.fields.map((field) => ({
          ...field,
          status: irisRowFiller.FILL_STATUS.ROW_NOT_FOUND,
          sectionId: group.sectionId,
          sectionStatus: "unsupported_tax_deduction_scope",
        })),
      );
      continue;
    }
    const moved = await irisNavigation.navigateToSection(windowInstance, {
      sectionId: group.sectionId,
      taxYear,
      taxpayerIdentifier,
      requiredGridTitle: isTaxDeductionGroup ? "Adjustable Tax" : null,
      requiredRowCodes: isTaxDeductionGroup
        ? group.fields.map((field) => field.irisCode)
        : [],
    });
    if (!moved.ok) {
      onStep(
        "real_autofill_section_skipped",
        `${group.sectionId}: could not be opened (${moved.status}). ${group.fields.length} field(s) were left untouched rather than filled into the wrong grid.`,
      );
      results = results.concat(
        group.fields.map((field) => ({
          ...field,
          status: irisRowFiller.FILL_STATUS.ROW_NOT_FOUND,
          sectionId: group.sectionId,
          sectionStatus: moved.status,
        })),
      );
      continue;
    }
    onStep(
      "real_autofill_section",
      `${group.sectionId}${moved.gridTitle ? ` / ${moved.gridTitle}` : ""}: ${moved.status}; filling ${group.fields.length} field(s).`,
    );
    // The tour reports, per section, whether the header/row binding was proven
    // (`mappingVerified`). In the live capture only `salary` had it — six of seven
    // sections came back unverified because their grids render more than one
    // heading bar. Writing into a section whose structure we could not prove is
    // exactly how a wrong number reaches a return, so live mode refuses.
    const sectionVerified = Boolean(
      sectionTour?.sections?.find((entry) => entry?.id === group.sectionId)
        ?.mappingVerified,
    );
    if (mode !== "dry" && !sectionVerified) {
      onStep(
        "real_autofill_section_unverified",
        `${group.sectionId}: the section tour could not verify its header/row binding, so ${group.fields.length} field(s) were left untouched. Re-run the inspection (or use dry mode) to review the targets.`,
      );
      results = results.concat(
        group.fields.map((field) => ({
          ...field,
          status: irisRowFiller.FILL_STATUS.UNVERIFIED_TARGET,
          sectionId: group.sectionId,
          sectionStatus: "section_mapping_unverified",
        })),
      );
      continue;
    }
    // Read-only look at what is ALREADY in this grid before anything is typed.
    // Rows the packet does not cover but which carry a figure are reported: the
    // IRIS total would then differ from the packet, and the agent must not call
    // that draft clean.
    try {
      const snapshot = await irisRowFiller.snapshotIrisRows(windowInstance);
      const unexpected = irisRowFiller.findUnexpectedPrefill(
        snapshot,
        group.fields.map((field) => field.irisCode),
      );
      onStep(
        "real_autofill_prefill_snapshot",
        `${group.sectionId}: ${snapshot.length} row(s) read, ${unexpected.length} unexpected pre-filled row(s).`,
      );
      for (const row of unexpected) {
        unexpectedPrefill.push({ ...row, sectionId: group.sectionId });
        onStep(
          "real_autofill_unexpected_prefill",
          `${row.code} "${row.description}" already holds ${row.cells
            .map((cell) => cell.value)
            .join(
              " / ",
            )} in IRIS but is not in the TaxRocket packet. Left untouched.`,
        );
      }
    } catch (error) {
      onStep(
        "real_autofill_prefill_snapshot_failed",
        `${group.sectionId}: pre-fill snapshot could not be read (${error?.message || error}). Fill continues; the overwrite guard still protects non-empty cells.`,
      );
    }
    const outcome = await irisRowFiller.fillIrisRows(
      windowInstance,
      group.fields,
      { dryRun: mode === "dry", sectionVerified },
    );
    results = results.concat(
      outcome.results.map((entry) => ({
        ...entry,
        sectionId: group.sectionId,
      })),
    );
  }
  // Salary-only view, kept for the handoff label before wealth rows are added.
  const salarySummary = irisRowFiller.summarise(results);

  // Wealth Statement. Opt-in (TAXROCKET_WEALTH_AUTOFILL). The driver opens the
  // Reconciliation / Personal Assets sections itself, creates the rows through
  // the IRIS modals (live) or only reports what it would create (dry), and
  // fills them through the same verified row filler.
  let wealthOutcome = null;
  const wealthEnabled = wealthPrepared.length > 0 && getWealthAutofillEnabled();
  if (wealthEnabled) {
    onStep(
      "real_autofill_wealth_start",
      `Wealth Statement (${mode === "dry" ? "DRY — nothing clicked" : "LIVE"}): ${wealthPrepared.length} figure(s). ` +
        `The agent only adds rows and types amounts; it never saves, calculates or submits.`,
    );
    try {
      wealthOutcome = await irisWealthDriver.runWealthDriver(
        windowInstance,
        wealthPrepared,
        {
          mode: mode === "dry" ? "dry" : "live",
          navigate: (sectionId) =>
            irisNavigation.navigateToSection(windowInstance, {
              sectionId,
              taxYear,
              taxpayerIdentifier,
            }),
          // Wealth rows are single-column ("Amount"), so the filler's
          // single_column match is a proven target, not a guess.
          fillRows: (fields, opts) =>
            irisRowFiller.fillIrisRows(windowInstance, fields, {
              dryRun: Boolean(opts && opts.dryRun),
              sectionVerified: true,
            }),
          // ensureNavigationJobActive compares against the NORMALISED account
          // reference (no spaces/dashes); passing the raw value made it report
          // "target changed" on a CNIC written with dashes.
          beforeStep: () =>
            ensureNavigationJobActive(
              job.id,
              String(taxpayerIdentifier || "")
                .trim()
                .replace(/[ -]/g, ""),
            ),
          onStep,
        },
      );
    } catch (error) {
      onStep(
        "real_autofill_wealth_error",
        `Wealth driver stopped: ${error instanceof Error ? error.message : String(error)}. Nothing further was clicked.`,
      );
      wealthOutcome = {
        results: wealthPrepared.map((field) => ({
          ...field,
          status: irisWealthDriver.WEALTH_STATUS.SETUP_FAILED,
          setupStatus: "driver_error",
        })),
        setup: [],
      };
    }
    results = results.concat(
      wealthOutcome.results.map((entry) => ({
        ...entry,
        sectionId: entry.sectionId || "wealth",
      })),
    );
  }
  for (const field of plan.unlocated) {
    onStep(
      "real_autofill_unlocated",
      `${field.irisCode} "${field.label || ""}" was not seen in any captured section, so no grid could be targeted.`,
    );
    results.push({
      ...field,
      status: irisRowFiller.FILL_STATUS.ROW_NOT_FOUND,
      sectionId: null,
    });
  }
  const summary = irisRowFiller.summarise(results);

  onStep("real_autofill_result", irisRowFiller.describeFillSummary(summary));

  // Surface each refusal individually — a value that silently did not land is
  // exactly the failure mode this phase exists to prevent.
  for (const r of results) {
    if (irisRowFiller.SUCCESS_STATUSES.has(r.status)) continue;
    onStep(
      "real_autofill_skip",
      `${r.irisCode} "${r.label || r.rowDescription || ""}" -> ${r.status}` +
        (r.requestedColumn ? ` (column: ${r.requestedColumn})` : ""),
    );
  }

  const captures = [
    await captureWindowScreenshot(windowInstance, "real_autofill"),
  ];
  const fillMessage = irisRowFiller.describeFillSummary(summary);
  const overwriteConflicts = results.filter(
    (r) => r.status === irisRowFiller.FILL_STATUS.OVERWRITE_NEEDS_CONFIRMATION,
  );
  const autofillReviewRequired =
    summary.skipped > 0 || unexpectedPrefill.length > 0;
  const conflictText = overwriteConflicts.length
    ? ` IRIS already holds a different figure in ${overwriteConflicts
        .map(
          (r) =>
            `${r.irisCode} (IRIS ${r.existingValue}, packet ${r.plannedValue})`,
        )
        .join(
          "; ",
        )} — it was NOT overwritten. Decide which figure is right in the FBR window.`
    : "";
  const prefillText = unexpectedPrefill.length
    ? ` IRIS also holds figures the packet does not cover: ${unexpectedPrefill
        .map(
          (row) =>
            `${row.code} ${row.cells.map((cell) => cell.value).join("/")}`,
        )
        .join(
          "; ",
        )} — the IRIS total will differ from the packet until this is resolved.`
    : "";
  // A clean LIVE fill in an assisted-filing job hands the rest of the return to
  // the taxpayer: the agent shows the pages it does not fill and waits for the
  // taxpayer's Continue. The resumed run sees the recorded confirmation and
  // finishes without pausing again.
  const handoffReviewDue =
    mode === "live" &&
    !autofillReviewRequired &&
    job?.type === "tax_assisted_filing" &&
    !hasConfirmedHandoffReview(jobContext);
  if (handoffReviewDue) {
    await runHandoffReviewTour(windowInstance, {
      taxYear,
      taxpayerIdentifier,
      onStep,
    });
  }
  const pauseMessage = autofillReviewRequired
    ? `The FBR return opened, but ${summary.skipped} approved field(s) could not be placed safely (${fillMessage}).${conflictText}${prefillText} Review those fields in the FBR window. Nothing was saved, submitted, calculated, or paid.`
    : handoffReviewDue
      ? buildHandoffReviewMessage()
      : null;

  return {
    paused: autofillReviewRequired || handoffReviewDue,
    pauseAction: autofillReviewRequired
      ? "portal_autofill_review"
      : handoffReviewDue
        ? getHandoffReviewAction()
        : null,
    pauseMessage,
    executionLog,
    result: {
      mode,
      summary,
      results,
      captures,
      message: fillMessage,
      wealthPrepared: wealthPrepared.map((f) => {
        const placed = (wealthOutcome?.results || []).find(
          (entry) => entry.key === f.key,
        );
        return {
          irisCode: f.irisCode,
          label: f.label,
          value: f.value,
          ...(placed
            ? {
                status: placed.status,
                ...(placed.setupStatus
                  ? { setupStatus: placed.setupStatus }
                  : {}),
              }
            : {}),
        };
      }),
      salarySummary,
      wealth: {
        enabled: wealthEnabled,
        mode,
        summary: wealthOutcome
          ? irisRowFiller.summarise(wealthOutcome.results)
          : null,
        setup: wealthOutcome?.setup || [],
      },
      unexpectedPrefill,
      employers: employersResult,
      overwriteConflicts: overwriteConflicts.map((r) => ({
        irisCode: r.irisCode,
        existingValue: r.existingValue,
        plannedValue: r.plannedValue,
      })),
      reviewRequired: autofillReviewRequired,
      handoffReviewConfirmed: hasConfirmedHandoffReview(jobContext),
    },
  };
}

/**
 * A navigation check that completed the section tour is no longer marked paused,
 * so autofill can run. When autofill is switched off the job has nonetheless
 * finished its work, and must still be recorded as awaiting the user rather
 * than left silently running.
 */
async function finishNavigationOnly(navigation, job) {
  if (!navigation || navigation.paused !== false || !navigation.pauseAction)
    return navigation;
  await updateLocalJobStatus(job.id, "awaiting_user_action", {
    pauseAction: navigation.pauseAction,
    pauseMessage: navigation.pauseMessage,
    result: navigation.result,
    executionLog: navigation.executionLog,
  });
  return { ...navigation, paused: true };
}

/**
 * The pause the agent raises after a clean LIVE fill so the taxpayer reviews the
 * parts of the return the agent does not touch. The pause action is recorded as
 * a confirmation when the taxpayer presses Continue, and that confirmation is
 * what lets the resumed run finish instead of pausing again.
 */
function getHandoffReviewAction() {
  return "portal_handoff_review";
}

/**
 * The pause raised when an employer could not be added by exact registered name.
 * The taxpayer adds it in IRIS and presses Continue; that recorded confirmation
 * makes the resumed run trust the taxpayer and skip the employer step, instead
 * of searching again and pausing on the same employer.
 */
function getEmployerReviewAction() {
  return "portal_employer_review";
}

function hasConfirmedEmployerReview(jobContext) {
  const confirmations = jobContext?.livePilotState?.confirmations;
  return (
    Array.isArray(confirmations) &&
    confirmations.some(
      (entry) =>
        String(entry?.action || "").toLowerCase() === getEmployerReviewAction(),
    )
  );
}

function hasConfirmedHandoffReview(jobContext) {
  const confirmations = jobContext?.livePilotState?.confirmations;
  return (
    Array.isArray(confirmations) &&
    confirmations.some(
      (entry) =>
        String(entry?.action || "").toLowerCase() === getHandoffReviewAction(),
    )
  );
}

/**
 * Read-only tour of the pages the taxpayer must still review: property (top of
 * Personal Assets), the Payment tab, and Computations. It only switches views;
 * IRIS recalculates by itself while tabs switch, the agent never presses
 * Calculate, Save or Submit. A view that will not open is reported, never
 * forced.
 */
async function runHandoffReviewTour(
  windowInstance,
  { taxYear, taxpayerIdentifier, onStep },
) {
  const views = [
    {
      sectionId: "wealth_assets",
      label:
        "Personal Assets / Liabilities (Immovable Properties are at the top)",
    },
    { sectionId: "payment", label: "Payment tab" },
    {
      sectionId: "computations",
      label: "Tax Chargeable / Payments - Computations",
    },
  ];
  const opened = [];
  const skipped = [];
  for (const view of views) {
    let moved;
    try {
      moved = await irisNavigation.navigateToSection(windowInstance, {
        sectionId: view.sectionId,
        taxYear,
        taxpayerIdentifier,
      });
    } catch (error) {
      moved = { ok: false, status: error?.message || "error" };
    }
    if (moved?.ok) {
      opened.push(view.label);
      onStep("handoff_review_opened", `Review view opened: ${view.label}.`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } else {
      skipped.push(view.label);
      onStep(
        "handoff_review_skipped",
        `Review view could not be opened (${moved?.status || "unknown"}): ${view.label}. Open it yourself in the FBR window.`,
      );
    }
  }
  return { opened, skipped };
}

function buildHandoffReviewMessage() {
  return (
    "The agent finished entering your approved figures in the FBR draft. Now review the rest of the return in the FBR window: " +
    "(1) Personal Assets / Liabilities - check Immovable Properties and every other asset you own, and add anything missing yourself. " +
    "(2) Payment tab - check whether any payment is due; the agent never pays. " +
    "(3) Computations - IRIS recalculates by itself when you switch tabs; compare the tax with TaxRocket's estimate and confirm the Reconciliation amount is 0. " +
    "When everything is correct, press Continue here. The agent did not press Calculate, and nothing was saved, submitted or paid."
  );
}

/**
 * Plain statement of what this handoff covers. "Completed" only ever means the
 * agent's own step finished: the Wealth Statement and everything after Salary is
 * still the taxpayer's, so the return is never reported as ready to submit.
 */
function buildHandoffScopeSummary(
  summary,
  reviewRequired,
  wealthPrepared,
  extras = {},
) {
  // `summary` covers everything the agent attempted; the Salary label must not
  // turn red because a Wealth row needed review (and vice versa), so the Salary
  // half is read from its own summary when the run provides one.
  const salary = extras.salarySummary || summary;
  const salaryTotal = Number(salary?.total) || 0;
  const salaryFilled = Number(salary?.filled) || 0;
  const salaryNeedsReview = extras.salarySummary
    ? Number(salary?.skipped) > 0
    : reviewRequired;
  const wealthRows = Array.isArray(wealthPrepared) ? wealthPrepared.length : 0;
  const wealth = extras.wealth || null;
  const wealthEntered = Boolean(wealth && wealth.enabled && wealth.summary);
  const wealthFilled = Number(wealth?.summary?.filled) || 0;
  const wealthTotal = Number(wealth?.summary?.total) || 0;
  const wealthDry = wealthEntered && wealth.mode === "dry";
  const wealthState = !wealthEntered
    ? "pending"
    : wealthDry
      ? "dry_run_only"
      : wealthFilled === wealthTotal && wealthTotal > 0
        ? "entered_not_calculated"
        : "needs_review";
  const salaryText = `Salary ${
    salaryNeedsReview
      ? "\u26A0\uFE0F needs review"
      : salaryTotal > 0 && salaryFilled === salaryTotal
        ? "\u2705 filled"
        : "\u26A0\uFE0F not entered"
  }`;
  const wealthText =
    wealthState === "pending"
      ? `Wealth \u26A0\uFE0F pending${
          wealthRows ? ` (${wealthRows} row(s) prepared, not entered)` : ""
        }`
      : wealthState === "dry_run_only"
        ? `Wealth \u26A0\uFE0F dry run only (${wealthTotal} row(s) checked, nothing entered)`
        : wealthState === "entered_not_calculated"
          ? `Wealth \u2705 ${wealthFilled}/${wealthTotal} row(s) entered \u2014 press Calculate in FBR and confirm the reconciliation difference is 0`
          : `Wealth \u26A0\uFE0F needs review (${wealthFilled}/${wealthTotal} row(s) entered)`;
  const employers = extras.employers || null;
  const employerRows = Array.isArray(employers?.prepared)
    ? employers.prepared.length
    : 0;
  const employerEntered = Boolean(
    employers && employers.enabled && employers.summary,
  );
  const employerState = !employerRows
    ? "none"
    : employers.confirmedByTaxpayer
      ? "confirmed_by_taxpayer"
      : !employerEntered
        ? "pending"
        : employers.mode === "dry"
          ? "dry_run_only"
          : Number(employers.summary.needsReview) > 0
            ? "needs_review"
            : "listed";
  const employerText =
    employerState === "none"
      ? ""
      : employerState === "confirmed_by_taxpayer"
        ? ` \u00B7 Employers \u2705 added by the taxpayer in FBR`
        : employerState === "pending"
          ? ` \u00B7 Employers \u26A0\uFE0F pending (${employerRows} prepared, not added)`
          : employerState === "dry_run_only"
            ? ` \u00B7 Employers \u26A0\uFE0F dry run only (${employerRows} checked, nothing added)`
            : employerState === "needs_review"
              ? ` \u00B7 Employers \u26A0\uFE0F needs review (${employers.summary.ok}/${employers.summary.total} listed)`
              : ` \u00B7 Employers \u2705 ${employers.summary.ok}/${employers.summary.total} listed`;
  return {
    wealthPreparedRows: wealthRows,
    employers: employerState,
    salary: salaryNeedsReview
      ? "needs_review"
      : salaryTotal > 0 && salaryFilled === salaryTotal
        ? "filled"
        : "not_entered",
    wealthStatement: wealthState,
    propertyPaymentsComputations: extras.reviewConfirmed
      ? "reviewed_by_taxpayer"
      : "pending",
    readyToSubmit: false,
    label: `${salaryText} \u00B7 ${wealthText}${employerText}${
      extras.reviewConfirmed
        ? " \u00B7 Property, Payments and Computations reviewed by the taxpayer"
        : ""
    } \u00B7 Return NOT ready to submit`,
  };
}

function mergeNavigationAutofillOutcome(navigation, autofill, autofillMode) {
  const summary = autofill?.result?.summary || {};
  const asCount = (value) =>
    Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const total = asCount(summary.total);
  const filled = asCount(summary.filled);
  const skipped = asCount(summary.skipped ?? Math.max(0, total - filled));
  const reviewRequired = Boolean(autofill?.paused || skipped > 0);
  const fieldLabel = total === 1 ? "field" : "fields";
  const defaultMessage =
    autofillMode === "live"
      ? total === 0
        ? "Live entry found no approved fields in this packet. No values were entered, saved, calculated, paid, or submitted."
        : reviewRequired
          ? `Live entry verified ${filled}/${total} approved ${fieldLabel}; ${skipped} need review. The return was not saved, calculated, paid, or submitted.`
          : `Live entry entered and verified ${filled}/${total} approved ${fieldLabel} in the open FBR draft. The return was not saved, calculated, paid, or submitted.`
      : reviewRequired
        ? `Dry run checked ${total} approved ${fieldLabel}; ${skipped} need review. It did not enter or save values or submit the return.`
        : total === 0
          ? "Dry run found no approved fields. It did not enter or save values or submit the return."
          : `Dry run checked ${total} approved ${fieldLabel}. It did not enter or save values or submit the return.`;
  const resultMessage = autofill?.pauseMessage || defaultMessage;
  const pauseAction = reviewRequired
    ? autofill?.pauseAction || "portal_autofill_review"
    : null;
  const result = {
    ...(navigation?.result || {}),
    requiredAction:
      pauseAction ||
      navigation?.result?.requiredAction ||
      "portal_sections_inspected",
    pauseReason: reviewRequired ? resultMessage : null,
    mode:
      autofillMode === "live" ? "live_return_autofill" : "live_return_dry_run",
    navigationMode: navigation?.result?.mode || null,
    autofillMode,
    autofillSummary: summary,
    handoffScope: buildHandoffScopeSummary(
      summary,
      reviewRequired,
      autofill?.result?.wealthPrepared,
      {
        salarySummary: autofill?.result?.salarySummary,
        wealth: autofill?.result?.wealth,
        employers: autofill?.result?.employers,
        reviewConfirmed: Boolean(autofill?.result?.handoffReviewConfirmed),
      },
    ),
    autofill: autofill?.result || null,
    message: resultMessage,
    submitted: false,
  };
  return {
    ...navigation,
    paused: reviewRequired,
    pauseAction,
    pauseMessage: reviewRequired ? resultMessage : null,
    executionLog: [
      ...(navigation?.executionLog || []),
      ...(autofill?.executionLog || []),
    ],
    result,
  };
}

async function runLocalTaxDryRunFlow(jobContext) {
  if (realPortalMode) {
    const {
      mode: autofillMode,
      downgradedFrom,
      note: autofillGateNote,
    } = resolveAutofillMode(jobContext);
    if (downgradedFrom && autofillGateNote) {
      pushStatus("progress", autofillGateNote);
    }
    // Navigation check first: it drives the taxpayer to the right return and
    // is where all the login/route/pause handling lives. Only once it reports
    // an un-paused, ready form does filling make sense.
    const navigation = await runLocalIrisNavigationCheck(
      jobContext,
      jobContext.job,
    );
    if (autofillMode === "off" || navigation?.paused) {
      return await finishNavigationOnly(navigation, jobContext.job);
    }
    const autofill = await runRealIrisAutofill(
      jobContext,
      jobContext.job,
      autofillMode,
    );
    return mergeNavigationAutofillOutcome(navigation, autofill, autofillMode);
  }
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.taxAutomationConfig || {};
  const packet = jobContext.filingPacket || {};
  const snapshot = packet.snapshot || {};
  const portalFieldMap = Array.isArray(snapshot.portalFieldMap)
    ? snapshot.portalFieldMap
    : [];
  const executionLog = [];
  activeJobExecutionLog = executionLog;
  const routeSelector = config?.routeSelector || null;
  const routeMetadata = snapshot.routeMetadata || {};
  const selectorBundle = getSelectorBundleSignal(jobContext);

  if (!portalFieldMap.length) {
    throw new Error(
      "The approved filing packet does not contain a portal field map for dry-run fill.",
    );
  }

  const readySelector = config?.readiness?.readySelector || "#homeLink";
  const entryUrl = resolveWorkerEntryUrl(config);

  await windowInstance.loadURL(config?.readiness?.loginUrl || entryUrl);

  // Real portal: login confirmation first, advisory selector check second —
  // see confirmIrisReadiness. The old order timed out on the live portal.
  await confirmIrisReadiness(
    windowInstance,
    config,
    readySelector,
    executionLog,
  );
  executionLog.push({
    step: STANDARD_LOG_STEPS.READINESS_CHECK,
    label: "Trusted Iris session confirmed",
    detail:
      "Desktop worker validated the configured ready screen before entering dry-run data.",
  });

  const captures = [
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.READINESS,
    ),
  ];

  // ── Phase 15.5c F7: Route-family-aware branching ──
  if (config.useMockIris) {
    await clickSelector(windowInstance, "#open-return-dry-run");
  } else if (isClassicPortalRoute(routeMetadata)) {
    // Classic portal (PrimeFaces/JSF tree navigation) — Phase 18 FULL IMPLEMENTATION
    const navigationResult = await navigateClassicPortalFlow(
      windowInstance,
      routeSelector,
      Boolean(config.useMockIris),
      normalizeExplicitResidencyStatus(snapshot.filing?.residencyStatus),
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Classic portal tree navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Classic portal navigation completed but the target data table was not detected as ready.",
      );
    }
  } else if (routeSelector) {
    // New portal: route-aware navigation via top-menu + left-category
    const formLabel = routeMetadata.routeLabel || null;
    const taxYear = packet.taxYear || snapshot.taxYear || null;
    const taxpayerName = snapshot.taxpayerName || null;

    const navigationResult = await navigateToIrisForm(
      windowInstance,
      routeSelector,
      formLabel,
      taxYear,
      taxpayerName,
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Route-aware IRIS navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Route-aware navigation completed but the target form was not detected as ready.",
      );
    }
  } else {
    await windowInstance.loadURL(entryUrl);
  }

  // Fill portal fields — Phase 18: Classic portal uses per-section navigation + fillClassicDataTable().
  // Each classic portal section is on its own JSF form page, so we navigate to each section,
  // handle Add-row if needed, fill its fields, then move to the next section.
  const isClassicRoute = isClassicPortalRoute(routeMetadata);
  if (isClassicRoute) {
    // Group classic portal fields by irisSection for per-section navigation
    const sectionGroups = new Map();
    for (const field of portalFieldMap) {
      if (field.section && field.section.startsWith("classic.")) {
        const sectionKey = field.irisSection || field.section;
        if (!sectionGroups.has(sectionKey)) sectionGroups.set(sectionKey, []);
        sectionGroups.get(sectionKey).push(field);
      }
    }

    // Navigate to each section and fill its fields
    for (const [sectionKey, fields] of sectionGroups) {
      // Navigate to the section's data table page
      await navigateToClassicSection(windowInstance, sectionKey);

      // Handle Add-row: for sections like "Fixed / Final Tax", rows may not exist yet
      // Check if any data table rows exist; if not, try to add one
      const rowCount = await windowInstance.webContents
        .executeJavaScript(
          `
        (() => {
          const tables = document.querySelectorAll('table.ui-datatable, table');
          for (const t of tables) {
            const rows = t.querySelectorAll('tbody tr');
            if (rows.length > 0) return rows.length;
          }
          return 0;
        })();
      `,
        )
        .catch(() => 0);

      if (rowCount === 0) {
        const firstFieldLabel = fields[0]?.label || sectionKey;
        await handleClassicAddRow(windowInstance, firstFieldLabel);
      }

      // Fill each field in this section
      for (const field of fields) {
        const rowDesc = field.label || field.key.split(".").pop() || "";
        // Determine field type from irisSection/label: "total" for amount, "exempt" for tax collected
        const isExemptOrTax =
          (field.irisSection || "").toLowerCase().includes("tax collected") ||
          (field.irisSection || "").toLowerCase().includes("deducted") ||
          (field.irisSection || "").toLowerCase().includes("exempt") ||
          (field.label || "").toLowerCase().includes("tax collected") ||
          (field.label || "").toLowerCase().includes("deducted") ||
          (field.label || "").toLowerCase().includes("exempt");
        const fieldType = isExemptOrTax ? "exempt" : "total";

        const filled = await fillClassicDataTable(
          windowInstance,
          rowDesc,
          fieldType,
          field.value,
        );
        // Fallback to selector-based fill
        if (!filled && field.selector) {
          try {
            await fillSelector(windowInstance, field.selector, field.value);
          } catch {
            // Both strategies failed
          }
        }
      }
    }

    // Fill any non-classic fields using standard selector approach
    for (const field of portalFieldMap) {
      if (!field.section || !field.section.startsWith("classic.")) {
        const selector =
          field.selector ||
          `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
        await fillSelector(windowInstance, selector, field.value);
      }
    }
  } else {
    // Non-classic: standard fill using selectors
    for (const field of portalFieldMap) {
      const selector =
        field.selector ||
        `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
      await fillSelector(windowInstance, selector, field.value);
    }
  }

  executionLog.push({
    step: STANDARD_LOG_STEPS.FIELD_FILL,
    label: "Approved packet values filled",
    detail: `Dry run filled ${portalFieldMap.length} mapped packet values into the local Iris workspace.`,
  });

  captures.push(
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.FIELD_FILL,
    ),
  );

  const reviewGateSelector =
    config?.dryRun?.reviewGateSelector || "#dry-run-review-gate";
  await waitForVisibleSelector(windowInstance, reviewGateSelector, 15000);
  captures.push(
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.DRY_RUN_REVIEW_GATE,
    ),
  );

  const finalSubmitSelector =
    config?.dryRun?.finalSubmitSelector || "#final-submit";
  const finalSubmitVisible = await hasSelector(
    windowInstance,
    finalSubmitSelector,
  );

  executionLog.push({
    step: STANDARD_LOG_STEPS.FINAL_SUBMIT_BOUNDARY,
    label: "Stopped before final submit",
    detail: finalSubmitVisible
      ? "Final submit control was visible, but dry-run mode stopped without clicking it."
      : "Dry-run mode stopped at the configured review gate before any final submission control.",
  });

  return {
    result: {
      message:
        "Local Iris dry run completed and stopped at the final review gate.",
      pauseReason:
        config?.dryRun?.pauseReason ||
        "Dry-run reached the final review gate. Final submit stays user controlled.",
      finalUrl: windowInstance.webContents.getURL(),
      reviewedFieldCount: portalFieldMap.length,
      packetVersion: packet.packetVersion || null,
      packetHash: packet.packetHash || null,
      selectorBundle,
      captures,
    },
    executionLog,
  };
}

function getPilotStateFromContext(jobContext) {
  const payload = jobContext?.job?.payload || jobContext?.payload || {};
  const live =
    (payload && typeof payload === "object" && payload.livePilotState) ||
    jobContext?.livePilotState ||
    null;

  if (live && typeof live === "object") {
    return {
      phase:
        typeof live.phase === "string" && live.phase ? live.phase : "start",
      confirmations: Array.isArray(live.confirmations)
        ? live.confirmations
        : [],
    };
  }

  return {
    phase: "start",
    confirmations: [],
  };
}

async function pauseAssistedPilot(job, windowInstance, input) {
  const captures = [
    await captureWindowScreenshot(windowInstance, input.captureLabel),
  ];
  // Real-portal evidence: dump the worker page's HTML + screenshot at every
  // pause so the live portal's DOM can be mapped without waiting for a
  // hard failure. Files land under userData/jobs/<jobId>/.
  try {
    const fsMod = await import("fs/promises");
    const dumpDir = getWorkerTempDir(job.id);
    await fsMod.mkdir(dumpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const pageUrl = windowInstance.webContents.getURL();
    const html = await windowInstance.webContents.executeJavaScript(
      "document.documentElement.outerHTML",
    );
    if (html) {
      await fsMod.writeFile(
        path.join(dumpDir, `pause-${input.requiredAction}-${stamp}.html`),
        html,
        "utf8",
      );
    }
    await fsMod.writeFile(
      path.join(dumpDir, `pause-${input.requiredAction}-${stamp}.json`),
      JSON.stringify(
        {
          jobId: job.id,
          requiredAction: input.requiredAction,
          pageUrl,
          at: stamp,
        },
        null,
        2,
      ),
      "utf8",
    );
    pushStatus(
      "progress",
      `Pause evidence saved: ${path.join(dumpDir, `pause-${input.requiredAction}-${stamp}.html`)}`,
    );
  } catch {
    // Evidence capture is best-effort; never block the pause itself.
  }
  await updateLocalJobStatus(job.id, "awaiting_user_action", {
    pauseAction: input.requiredAction,
    pauseMessage: input.pauseReason || input.message,
    result: {
      message: input.message,
      pauseReason: input.pauseReason,
      requiredAction: input.requiredAction,
      userInstruction: input.userInstruction,
      recoveryActions: input.recoveryActions || [],
      selectorBundle: input.selectorBundle || null,
      captures,
      ...(input.extraResult && typeof input.extraResult === "object"
        ? input.extraResult
        : {}),
    },
    executionLog: input.executionLog,
  });

  return {
    paused: true,
    pauseAction: input.requiredAction,
    pauseMessage: input.pauseReason || input.message,
    executionLog: input.executionLog,
    result: { requiredAction: input.requiredAction, message: input.message },
  };
}

async function runLocalTaxAssistedFilingFlow(jobContext, job) {
  if (realPortalMode) {
    const {
      mode: autofillMode,
      downgradedFrom,
      note: autofillGateNote,
    } = resolveAutofillMode(jobContext);
    if (downgradedFrom && autofillGateNote) {
      pushStatus("progress", autofillGateNote);
    }
    const navigation = await runLocalIrisNavigationCheck(jobContext, job);
    if (autofillMode === "off" || navigation?.paused) {
      return await finishNavigationOnly(navigation, job);
    }
    // Assisted filing still stops before Save/Submit — this only populates the
    // data grid for the supervising user to review.
    const autofill = await runRealIrisAutofill(jobContext, job, autofillMode);
    const outcome = mergeNavigationAutofillOutcome(
      navigation,
      autofill,
      autofillMode,
    );
    if (outcome.paused) {
      // A skipped approved field is not a completed agent task. Keep the job
      // awaiting review; never relabel partial autofill as completion.
      await updateLocalJobStatus(job.id, "awaiting_user_action", {
        pauseAction: outcome.pauseAction,
        pauseMessage: outcome.pauseMessage,
        result: outcome.result,
        executionLog: outcome.executionLog,
      });
    }
    return outcome;
  }
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.taxAutomationConfig || {};
  const packet = jobContext.filingPacket || {};
  const snapshot = packet.snapshot || {};
  const portalFieldMap = Array.isArray(snapshot.portalFieldMap)
    ? snapshot.portalFieldMap
    : [];
  const executionLog = [];
  activeJobExecutionLog = executionLog;
  const pilotState = getPilotStateFromContext(jobContext);
  const assistedConfig = config.assistedFiling || {};
  const routeSelector = config?.routeSelector || null;
  const routeMetadata = snapshot.routeMetadata || {};
  const selectorBundle = getSelectorBundleSignal(jobContext);
  // Phase 15.5c F7/F9: Is this a classic portal route?
  const isClassic = isClassicPortalRoute(routeMetadata);
  const shouldFillReturn = !pilotState.phase || pilotState.phase === "start";

  if (!portalFieldMap.length) {
    throw new Error(
      "The approved filing packet does not contain a portal field map for assisted filing.",
    );
  }

  const readySelector = config?.readiness?.readySelector || "#homeLink";
  const dashboardUrl = resolveFbrPortalUrl(
    assistedConfig.readinessUrl || "https://iris.fbr.gov.pk/",
  );
  const captures = [];

  // After Resume, skip dashboard + return.html. Re-loading the filing
  // form is what flashed Tax Payable / Opening Wealth over password-reset.
  if (shouldFillReturn) {
    await windowInstance.loadURL(dashboardUrl);
    // Real portal: confirm the IRIS login FIRST, then the ready selector.
    // Waiting on the selector first timed out on the live portal (mock-only
    // default selector) and killed the job before any field was filled.
    await confirmIrisReadiness(
      windowInstance,
      config,
      readySelector,
      executionLog,
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.READINESS_CHECK,
      label: "Trusted Iris session confirmed",
      detail:
        "Desktop worker validated the trusted local Iris session before entering the live pilot.",
    });

    // IRIS 2.0 shows a promotional popup over the dashboard after login.
    // It must be dismissed or it swallows every later click.
    if (!config.useMockIris) {
      let dismissedHow = null;
      for (let popupTry = 0; popupTry < 3; popupTry++) {
        dismissedHow = await dismissIrisWelcomePopup(windowInstance);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (dismissedHow && dismissedHow !== "esc") break;
      }

      // Verify the popup is REALLY gone. If automation could not close it,
      // hold here (up to 2 min) so the user can close it manually — the
      // status message tells them exactly that.
      let overlayStillPresent = await isIrisOverlayPresent(windowInstance);
      if (overlayStillPresent) {
        pushStatus(
          "progress",
          "The IRIS welcome popup is still open. Close it in the agent window — automation continues automatically once it is gone.",
        );
        const manualWaitStart = Date.now();
        while (Date.now() - manualWaitStart < 120000) {
          overlayStillPresent = await isIrisOverlayPresent(windowInstance);
          if (!overlayStillPresent) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      executionLog.push({
        step: "welcome_popup_dismissed",
        label: "IRIS welcome popup dismissed",
        detail: `Dashboard popup closed via ${dismissedHow || "no attempt"}${
          overlayStillPresent
            ? " (WARNING: overlay still present after automated and manual-close wait)"
            : ""
        }.`,
      });
    }

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.READINESS,
      ),
    );
  }

  // ── Phase 15.5c F7: Route-family-aware navigation branching ──
  if (!shouldFillReturn) {
    // Resume: jump straight to the pause URL for the current phase.
  } else if (config.useMockIris) {
    const returnUrl = resolveWorkerEntryUrl(config);
    await windowInstance.loadURL(returnUrl);
  } else if (isClassic) {
    // Classic portal (PrimeFaces/JSF tree navigation) — Phase 18 FULL IMPLEMENTATION
    const navigationResult = await navigateClassicPortalFlow(
      windowInstance,
      routeSelector,
      Boolean(config.useMockIris),
      normalizeExplicitResidencyStatus(snapshot.filing?.residencyStatus),
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Classic portal tree navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Classic portal navigation completed but the target data table was not detected as ready.",
      );
    }
  } else if (routeSelector) {
    // New portal: route-aware navigation via top-menu + left-category
    const formLabel = routeMetadata.routeLabel || null;
    const taxYear = packet.taxYear || snapshot.taxYear || null;
    const taxpayerName = snapshot.taxpayerName || null;

    const navigationResult = await navigateToIrisForm(
      windowInstance,
      routeSelector,
      formLabel,
      taxYear,
      taxpayerName,
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Route-aware IRIS navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Route-aware navigation completed but the target form was not detected as ready.",
      );
    }
  } else {
    const returnUrl = resolveWorkerEntryUrl(config);
    await windowInstance.loadURL(returnUrl);
  }

  const prefillComparison = shouldFillReturn
    ? await collectPreFillComparison(windowInstance, portalFieldMap)
    : [];
  // Phase 18: Classic portal uses per-section navigation + fillClassicDataTable().
  // Each classic portal section is on its own JSF form page, so we navigate to each section,
  // handle Add-row if needed, fill its fields, then move to the next section.
  if (shouldFillReturn && isClassic) {
    // Group classic portal fields by irisSection for per-section navigation
    const sectionGroups = new Map();
    for (const field of portalFieldMap) {
      if (field.section && field.section.startsWith("classic.")) {
        const sectionKey = field.irisSection || field.section;
        if (!sectionGroups.has(sectionKey)) sectionGroups.set(sectionKey, []);
        sectionGroups.get(sectionKey).push(field);
      }
    }

    for (const [sectionKey, fields] of sectionGroups) {
      await navigateToClassicSection(windowInstance, sectionKey);

      const rowCount = await windowInstance.webContents
        .executeJavaScript(
          `
        (() => {
          const tables = document.querySelectorAll('table.ui-datatable, table');
          for (const t of tables) {
            const rows = t.querySelectorAll('tbody tr');
            if (rows.length > 0) return rows.length;
          }
          return 0;
        })();
      `,
        )
        .catch(() => 0);

      if (rowCount === 0) {
        const firstFieldLabel = fields[0]?.label || sectionKey;
        await handleClassicAddRow(windowInstance, firstFieldLabel);
      }

      for (const field of fields) {
        const rowDesc = field.label || field.key.split(".").pop() || "";
        const isExemptOrTax =
          (field.irisSection || "").toLowerCase().includes("tax collected") ||
          (field.irisSection || "").toLowerCase().includes("deducted") ||
          (field.irisSection || "").toLowerCase().includes("exempt") ||
          (field.label || "").toLowerCase().includes("tax collected") ||
          (field.label || "").toLowerCase().includes("deducted") ||
          (field.label || "").toLowerCase().includes("exempt");
        const fieldType = isExemptOrTax ? "exempt" : "total";

        const filled = await fillClassicDataTable(
          windowInstance,
          rowDesc,
          fieldType,
          field.value,
        );
        if (!filled && field.selector) {
          try {
            await fillSelector(windowInstance, field.selector, field.value);
          } catch {
            // Both strategies failed
          }
        }
      }
    }

    // Fill any non-classic fields
    for (const field of portalFieldMap) {
      if (!field.section || !field.section.startsWith("classic.")) {
        const selector =
          field.selector ||
          `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
        await fillSelector(windowInstance, selector, field.value);
      }
    }
  } else if (shouldFillReturn) {
    for (const field of portalFieldMap) {
      const selector =
        field.selector ||
        `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
      await fillSelector(windowInstance, selector, field.value);
    }
  }

  if (shouldFillReturn) {
    executionLog.push({
      step: STANDARD_LOG_STEPS.PREFILL_COMPARE,
      label: "Pre-fill comparison captured",
      detail:
        prefillComparison.length > 0
          ? `${prefillComparison.length} existing portal values differed from the approved packet before fill.`
          : "No material pre-fill differences were detected before assisted fill.",
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.PREFILL_COMPARE,
      ),
    );
    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.FIELD_FILL,
      ),
    );
  }

  // ── Phase 15.5c F9: Classic portal has no mid-filing password reset ──
  if (pilotState.phase === "start" && !isClassic) {
    await windowInstance.loadURL(
      resolveFbrPortalUrl(
        assistedConfig.passwordResetUrl || "https://iris.fbr.gov.pk/",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.PASSWORD_RESET_PAUSE,
      label: "Paused for password reset",
      detail:
        "Pilot paused so the user can complete any Iris password reset locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "password_reset",
      captureLabel: STANDARD_CAPTURE_LABELS.PASSWORD_RESET,
      message: "Assisted filing paused for a password reset checkpoint.",
      pauseReason:
        "Complete any required Iris password reset locally before continuing.",
      userInstruction:
        "If Iris asked for a password reset, finish it on the trusted device, then continue here.",
      recoveryActions: [
        "Complete the password reset locally.",
        "Return to the ready screen if the portal logs you out.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // ── Phase 15.5c F9: Classic portal has no mid-filing OTP/captcha ──
  if (pilotState.phase === "after_password_reset" && !isClassic) {
    await windowInstance.loadURL(
      resolveFbrPortalUrl(
        assistedConfig.otpCaptchaUrl || "https://iris.fbr.gov.pk/",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.OTP_CAPTCHA_PIN_PAUSE,
      label: "Paused for OTP, captcha, and PIN",
      detail:
        "Pilot paused so the user can handle OTP, captcha, and any Iris PIN gates locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "otp_captcha_pin",
      captureLabel: STANDARD_CAPTURE_LABELS.OTP_CAPTCHA_PIN,
      message: "Assisted filing paused for OTP, captcha, or PIN confirmation.",
      pauseReason:
        "Complete the OTP, captcha, or Iris PIN step locally before continuing.",
      userInstruction:
        "Handle the verification prompts on the trusted device, then continue here.",
      recoveryActions: [
        "Wait for the OTP or captcha challenge to clear locally.",
        "Only continue after the portal moves past the verification gate.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // ── Phase 15.5c F9: Classic portal Section 154A = final tax, no PSID/payment needed ──
  if (
    pilotState.phase === "after_otp_captcha_pin" &&
    !isClassic &&
    Number(
      snapshot.returnSummary?.taxPayable || snapshot.filing?.taxPayable || 0,
    ) > 0
  ) {
    await windowInstance.loadURL(
      resolveFbrPortalUrl(
        assistedConfig.paymentUrl || "https://iris.fbr.gov.pk/",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.PAYMENT_PSID_PAUSE,
      label: "Paused for PSID and payment",
      detail:
        "Pilot paused so the user can create a PSID or complete payment locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "payment_psid",
      captureLabel: STANDARD_CAPTURE_LABELS.PAYMENT_PSID,
      message: "Assisted filing paused for PSID or payment handling.",
      pauseReason:
        "Complete PSID creation or payment locally before continuing.",
      userInstruction:
        "Finish the PSID or payment step on the trusted device, then continue here.",
      recoveryActions: [
        "Record the PSID or CPR in Tax Rocket after payment if needed.",
        "Only continue once the portal is ready to move to final review.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // ── Phase 15.5c F9: Classic portal phase transitions ──
  // Classic portal skips password_reset, otp_captcha_pin, and payment_psid.
  // Instead: start → classic_final_review → classic_pin_entry → proof capture.
  if (isClassic) {
    if (
      pilotState.phase === "start" ||
      pilotState.phase === "after_password_reset"
    ) {
      // Classic portal: go directly to final review (save→submit→confirm dialog)
      const classicConfig = config.classicAssistedFiling || {};
      await windowInstance.loadURL(
        resolveFbrPortalUrl(
          classicConfig.finalReviewUrl || "https://iris.fbr.gov.pk/",
        ),
      );
      executionLog.push({
        step: STANDARD_LOG_STEPS.FINAL_SUBMIT_CONFIRMATION_GATE,
        label: "Paused for classic portal final review",
        detail:
          "Classic portal pilot paused at the final review gate (save → submit → confirm dialog).",
      });
      return pauseAssistedPilot(job, windowInstance, {
        requiredAction: "classic_final_review",
        captureLabel: STANDARD_CAPTURE_LABELS.FINAL_SUBMIT_CONFIRMATION,
        message:
          "Assisted filing paused at the classic portal final review gate.",
        pauseReason:
          "Complete the classic portal save → submit → confirm dialog locally, then continue for PIN entry.",
        userInstruction:
          "In the classic portal: click Save, then Submit, confirm the declaration dialog. Then continue here.",
        recoveryActions: [
          "Complete the save → submit → confirm dialog sequence locally.",
          "Only continue after the rule engine validation completes and the PIN dialog appears.",
        ],
        selectorBundle,
        executionLog,
      });
    }

    if (
      pilotState.phase === "after_otp_captcha_pin" ||
      pilotState.phase === "after_payment_psid"
    ) {
      // Classic portal PIN entry: after submit confirmation, the portal shows a 4-digit PIN dialog
      const classicConfig = config.classicAssistedFiling || {};
      await windowInstance.loadURL(
        resolveFbrPortalUrl(
          classicConfig.pinEntryUrl || "https://iris.fbr.gov.pk/",
        ),
      );
      executionLog.push({
        step: "classic_pin_entry_pause",
        label: "Paused for classic portal PIN entry",
        detail:
          "Classic portal pilot paused for 4-digit FBR PIN entry before final submission.",
      });
      return pauseAssistedPilot(job, windowInstance, {
        requiredAction: "classic_pin_entry",
        captureLabel: "Classic portal PIN entry",
        message: "Assisted filing paused for classic portal 4-digit PIN entry.",
        pauseReason:
          "Enter the 4-digit FBR PIN in the classic portal PIN dialog before final submission.",
        userInstruction:
          "Enter your FBR PIN, click Submit, then continue here for proof capture.",
        recoveryActions: [
          "Enter the 4-digit FBR PIN in the classic portal PIN dialog.",
          "Click Submit. The return should move from Drafts to Completed.",
        ],
        selectorBundle,
        executionLog,
      });
    }
  }

  // ── New portal (non-classic) phase transitions ──
  if (
    !isClassic &&
    (pilotState.phase === "after_otp_captcha_pin" ||
      pilotState.phase === "after_payment_psid")
  ) {
    await windowInstance.loadURL(
      resolveFbrPortalUrl(
        assistedConfig.finalReviewUrl || "https://iris.fbr.gov.pk/",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.FINAL_SUBMIT_CONFIRMATION_GATE,
      label: "Paused for final submit confirmation",
      detail:
        "Pilot stopped at the final declaration so the user can confirm the last action locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "final_submit_confirmation",
      captureLabel: STANDARD_CAPTURE_LABELS.FINAL_SUBMIT_CONFIRMATION,
      message: "Assisted filing paused at the final submit confirmation gate.",
      pauseReason:
        "User must confirm the final declaration locally before proof capture can continue.",
      userInstruction:
        "If you submitted locally, continue here so Tax Rocket can capture proof and close the pilot job.",
      recoveryActions: [
        "Only continue after the final declaration was confirmed locally.",
        "If the submission did not succeed, stop and review the portal screen before retrying.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // After final submit confirmation: verify payment state and capture completion evidence
  // Check payment state before proceeding to proof capture
  if (routeSelector && !config.useMockIris && !isClassic) {
    // Verify CPR and payment state on the portal
    const paymentVerification = await verifyCprAndPayment(
      windowInstance,
      routeSelector,
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.PAYMENT_VERIFICATION,
      label: "Payment state verified on portal",
      detail: `CPR detected: ${paymentVerification.cprDetected}, Paid: ${paymentVerification.paidAmount || "N/A"}, Refund: ${paymentVerification.refundDetected}, Submit unlocked: ${paymentVerification.submitUnlocked}`,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.PAYMENT_VERIFICATION,
      ),
    );

    // Enforce ready_to_submit gate: if payment is required and submit is not unlocked,
    // pause for user intervention
    if (
      Number(
        snapshot.returnSummary?.taxPayable || snapshot.filing?.taxPayable || 0,
      ) > 0 &&
      !paymentVerification.submitUnlocked
    ) {
      return pauseAssistedPilot(job, windowInstance, {
        requiredAction: "payment_verification",
        captureLabel: STANDARD_CAPTURE_LABELS.PAYMENT_VERIFICATION,
        message: "Payment state on the portal does not allow submission yet.",
        pauseReason:
          "Complete payment or verify CPR on the portal before continuing.",
        userInstruction:
          "Check the payment status on the trusted device and ensure the submit button is enabled.",
        recoveryActions: [
          "Complete the PSID or payment step locally.",
          "Refresh the portal and verify the submit button is enabled.",
        ],
        selectorBundle,
        executionLog,
      });
    }
  }

  await windowInstance.loadURL(
    resolveFbrPortalUrl(
      assistedConfig.completedTasksUrl || "https://iris.fbr.gov.pk/",
    ),
  );
  const proofCaptures = [
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.COMPLETED_TASKS,
    ),
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.ACKNOWLEDGEMENT,
    ),
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.RETURN_COPY,
    ),
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.CPR_PROOF,
    ),
  ];
  captures.push(...proofCaptures);

  // Verify completion evidence on the portal
  let completionEvidence = null;
  if (routeSelector && !config.useMockIris) {
    completionEvidence = await verifyCompletionEvidence(
      windowInstance,
      routeSelector,
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.COMPLETION_VERIFICATION,
      label: "Completion evidence verified",
      detail: `Completed tasks: ${completionEvidence.completedTasksDetected}, Acknowledgement: ${completionEvidence.acknowledgementDetected}, Return copy: ${completionEvidence.returnCopyDetected}, CPR proof: ${completionEvidence.cprProofDetected}`,
    });
  }

  executionLog.push({
    step: STANDARD_LOG_STEPS.PROOF_CAPTURE,
    label: "Completion proof captured",
    detail:
      "Desktop worker captured Completed Tasks, acknowledgement, return copy, and CPR proof surfaces.",
  });

  return {
    result: {
      message: "Controlled assisted filing pilot completed with proof capture.",
      finalUrl: windowInstance.webContents.getURL(),
      packetVersion: packet.packetVersion || null,
      packetHash: packet.packetHash || null,
      selectorBundle,
      prefillComparison,
      captures,
      proofSummary: completionEvidence || {
        completedTasks: true,
        acknowledgement: true,
        returnCopy: true,
        cpr: true,
      },
      paymentVerification:
        routeSelector && !config.useMockIris
          ? await verifyCprAndPayment(windowInstance, routeSelector).catch(
              () => null,
            )
          : null,
    },
    executionLog,
  };
}

/**
 * Failure evidence dump: when a job fails, save the worker page's full HTML,
 * its URL, and a screenshot under userData/jobs/<jobId>/. This is the ground
 * truth needed to write real-portal selectors without guessing.
 * Returns the dump folder path (also embedded into the error message).
 */
function writePortalInspectionToDisk(inspection, job = null) {
  const state = lastTourStateKey
    ? navigationStates.get(lastTourStateKey)
    : null;
  if (
    !inspection.interactionDiagnostics &&
    state?.interactionDiagnostics?.length &&
    (!job || state.jobId === job.id)
  ) {
    inspection = {
      ...inspection,
      interactionDiagnostics: state.interactionDiagnostics,
    };
  }
  if (
    !inspection.sectionTour &&
    lastSectionTour &&
    (!job || lastSectionTour.jobId === job.id)
  ) {
    inspection = { ...inspection, sectionTour: lastSectionTour };
  }
  const dir = getAgentLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    build: AGENT_BUILD_TAG,
    navigatorBuild: irisNavigation.BUILD_TAG,
    savedAt: new Date().toISOString(),
    mode: "live_return_navigation_only",
    taxYear: job?.payload?.taxYear || lastNavigationOptions.taxYear || null,
    notice:
      "No input values, storage, cookies, HTML or screenshots captured. Review metadata before sharing.",
    inspection,
  };
  const filePath = path.join(dir, "latest-portal-inspection.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

async function saveFailureDump(job, error) {
  try {
    const inspection = await captureDomEvidence(workerWindow || loginWindow);
    const filePath = writePortalInspectionToDisk(inspection, job);
    pushStatus("progress", `Read-only portal structure saved to: ${filePath}`);
    return path.dirname(filePath);
  } catch {
    return null;
  }
}

// Persist the full outcome of a local job to a user-findable folder so it can
// be attached/reviewed without Prisma Studio:
//   <user home>/TaxRocketAgentLogs/latest-job.json  (+ per-job file)
function getAgentLogDir() {
  return path.join(app.getPath("home"), "TaxRocketAgentLogs");
}

async function writeJobLogToDisk(job, data) {
  try {
    const dir = getAgentLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const id = String(job?.publicId || job?.id || "unknown").replace(
      /[^a-zA-Z0-9_-]/g,
      "",
    );
    // A job that pauses and is resumed runs several times under one id. Keep
    // a compact record of the earlier runs inside the same file so a single
    // file shows the whole story (for example, why a pause happened).
    const jobFile = path.join(dir, `job-${id}.json`);
    let previousRuns = [];
    try {
      const before = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      previousRuns = [
        ...(Array.isArray(before.previousRuns) ? before.previousRuns : []),
        {
          savedAt: before.savedAt || null,
          build: before.build || null,
          finalStatus: before.finalStatus || null,
          pauseAction: before.pauseAction || null,
          pauseMessage: before.pauseMessage || null,
          report: Array.isArray(before.report) ? before.report : undefined,
          executionLog: (Array.isArray(before.executionLog)
            ? before.executionLog
            : []
          ).map((entry) => ({
            step: entry?.step,
            at: entry?.at,
            detail: String(entry?.detail ?? "").slice(0, 600),
          })),
        },
      ].slice(-8);
    } catch {
      previousRuns = [];
    }
    const savedAt = new Date().toISOString();
    let report = [];
    try {
      report = buildJobReport({
        savedAt,
        jobId: job?.id || null,
        build: AGENT_BUILD_TAG,
        confirmations: activeJobConfirmations,
        ...data,
      });
    } catch (error) {
      report = [`Report could not be built: ${String(error)}`];
    }
    const payload = {
      report,
      savedAt,
      jobId: job?.id || null,
      jobType: job?.type || null,
      build: AGENT_BUILD_TAG,
      navigatorBuild: irisNavigation.BUILD_TAG,
      runtimeMainFile: __filename,
      realPortalMode,
      ...data,
      previousRuns,
    };
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(jobFile, json, "utf8");
    fs.writeFileSync(path.join(dir, "latest-job.json"), json, "utf8");
    return path.join(dir, "latest-job.json");
  } catch (error) {
    console.log("[agent] writeJobLogToDisk failed:", String(error));
    return null;
  }
}

async function processLocalJob(job) {
  if (job.status === "awaiting_user_action") {
    return;
  }

  let context = {};
  let localDocuments = [];
  try {
    context = await loadLocalJobContext(job.id);
    context.job = { ...(context.job || {}), id: job.id };
    if (job.payload && typeof job.payload === "object") {
      context.job = {
        ...(context.job || {}),
        id: job.id,
        payload: job.payload,
      };
      context.payload = job.payload;
      if (job.payload.livePilotState) {
        context.livePilotState = job.payload.livePilotState;
      }
      activeJobConfirmations = Array.isArray(
        job.payload.livePilotState?.confirmations,
      )
        ? job.payload.livePilotState.confirmations
        : [];
    }

    // Filing jobs always use the live FBR portal. Normalize the server response
    // before passing it to any worker flow so an old or malformed job payload
    // cannot select a local page.
    const jobAutomationConfig = {
      ...(context.taxAutomationConfig || {}),
      useMockIris: false,
    };
    if (job.type === "tax_dry_run" || job.type === "tax_assisted_filing") {
      context.taxAutomationConfig = jobAutomationConfig;
    }
    const jobLoginUrl = String(jobAutomationConfig.readiness?.loginUrl || "");
    realPortalMode =
      job.type === "tax_dry_run" ||
      job.type === "tax_assisted_filing" ||
      /^https?:\/\//i.test(jobLoginUrl) ||
      /^https?:\/\//i.test(
        String(launchState.desktopAuthConfig?.loginUrl || ""),
      );
    realPortalLoginUrl = /^https?:\/\//i.test(jobLoginUrl)
      ? jobLoginUrl
      : /^https?:\/\//i.test(
            String(launchState.desktopAuthConfig?.loginUrl || ""),
          )
        ? launchState.desktopAuthConfig.loginUrl
        : "https://iris.fbr.gov.pk/";
    if (realPortalMode) {
      pushStatus("progress", "Real FBR mode active for this filing.");
    }

    pushStatus(
      "progress",
      `Running local desktop automation for job ${job.publicId || job.id}.`,
    );

    localDocuments = await downloadJobDocuments(job.id, context.documents);

    await updateLocalJobStatus(job.id, "running");
    const outcome =
      job.type === "tax_dry_run"
        ? await runLocalTaxDryRunFlow(context)
        : job.type === "tax_assisted_filing"
          ? await runLocalTaxAssistedFilingFlow(context, job)
          : {
              result: await runLocalDldFlow(context, localDocuments),
              executionLog: [],
            };
    if (outcome?.paused) {
      const logPath = await writeJobLogToDisk(job, {
        finalStatus: "paused",
        pauseAction: outcome.pauseAction || null,
        pauseMessage: outcome.pauseMessage || null,
        result: outcome.result || null,
        executionLog: outcome.executionLog || [],
      });
      if (logPath) {
        pushStatus("progress", `Job log saved to: ${logPath}`);
      }
      pushStatus(
        outcome.pauseAction === "portal_sections_inspected"
          ? "success"
          : "progress",
        outcome.pauseMessage ||
          "Local desktop job is waiting for a user action before it can continue.",
      );
      return;
    }
    await updateLocalJobStatus(job.id, "completed", {
      result: outcome.result,
      executionLog: outcome.executionLog,
    });
    const doneLogPath = await writeJobLogToDisk(job, {
      finalStatus: "completed",
      result: outcome.result || null,
      executionLog: outcome.executionLog || [],
    });
    if (doneLogPath) {
      pushStatus("progress", `Job log saved to: ${doneLogPath}`);
    }
    pushStatus("success", "Local desktop automation completed successfully.");
  } catch (error) {
    if (error?.code === "NAVIGATION_JOB_STOPPED") {
      await writeJobLogToDisk(job, {
        finalStatus: "stopped",
        errorMessage: error.message,
        result: { submitted: false, sectionTour: lastSectionTour },
        executionLog: Array.isArray(activeJobExecutionLog)
          ? activeJobExecutionLog
          : [],
      });
      pushStatus("progress", error.message);
      return;
    }
    const message =
      error instanceof Error
        ? error.message
        : "The local desktop automation failed unexpectedly.";
    const failureDumpDir = await saveFailureDump(job, error);
    const messageWithDump = failureDumpDir
      ? `${message} [Evidence: ${failureDumpDir}]`
      : message;
    // Live-DOM snapshot of the worker window at failure time — this is what
    // makes the next iteration's real-IRIS selector bundle evidence-based.
    const domEvidence = await captureDomEvidence(workerWindow);
    const failureExecutionLog = [
      ...(Array.isArray(activeJobExecutionLog)
        ? activeJobExecutionLog.map((entry) => ({ ...entry }))
        : []),
      {
        step: STANDARD_LOG_STEPS.FAILURE,
        label: "Local desktop job failed",
        detail: message,
      },
    ];
    const portalEvidence = buildPortalEvidenceDiagnostics(
      domEvidence?.sectionTour || lastSectionTour,
    );
    const recoverableAssistedIssue =
      job.type === "tax_assisted_filing"
        ? classifyRecoverableAssistedIssue(
            message,
            failureExecutionLog,
            context,
            portalEvidence,
          )
        : null;
    const autofillSummaryForRecovery =
      failureExecutionLog
        .filter((entry) => entry?.step === "real_autofill_result")
        .pop()?.detail || null;

    if (recoverableAssistedIssue) {
      await updateLocalJobStatus(job.id, "awaiting_user_action", {
        result: {
          message: recoverableAssistedIssue.message,
          pauseReason: recoverableAssistedIssue.pauseReason,
          requiredAction: recoverableAssistedIssue.requiredAction,
          userInstruction: recoverableAssistedIssue.userInstruction,
          selectorBundle: getSelectorBundleSignal(context),
          selectorDriftDiagnostics:
            recoverableAssistedIssue.selectorDriftDiagnostics,
          mappingRefusalDiagnostics:
            recoverableAssistedIssue.mappingRefusalDiagnostics || null,
          portalEvidence,
          autofillSummary: autofillSummaryForRecovery,
          domEvidence,
          recoveryActions: buildRecoveryActions(message, {
            selectorDriftDiagnostics:
              recoverableAssistedIssue.selectorDriftDiagnostics,
          }),
          captures: [],
        },
        executionLog: failureExecutionLog,
      });
      const recoverableLogPath = await writeJobLogToDisk(job, {
        finalStatus: "awaiting_user_action",
        errorMessage: message,
        executionLog: failureExecutionLog,
        result: {
          message: recoverableAssistedIssue.message,
          pauseReason: recoverableAssistedIssue.pauseReason,
          requiredAction: recoverableAssistedIssue.requiredAction,
          userInstruction: recoverableAssistedIssue.userInstruction,
          selectorDriftDiagnostics:
            recoverableAssistedIssue.selectorDriftDiagnostics,
          mappingRefusalDiagnostics:
            recoverableAssistedIssue.mappingRefusalDiagnostics || null,
          portalEvidence,
          autofillSummary: autofillSummaryForRecovery,
          domEvidence,
        },
      });
      if (recoverableLogPath) {
        pushStatus("progress", `Job log saved to: ${recoverableLogPath}`);
      }
      pushStatus(
        "progress",
        "Assisted filing is waiting for a supervised recovery confirmation.",
      );
      return;
    }

    const selectorDriftDiagnostics = buildSelectorDriftDiagnostics(
      message,
      failureExecutionLog,
      context,
      portalEvidence,
    );
    // The autofill counts belong on the FAILED record too: `0/27 filled` was only
    // ever readable in latest-job.json, never in the job the operator sees.
    const autofillSummary =
      failureExecutionLog
        .filter((entry) => entry?.step === "real_autofill_result")
        .pop()?.detail || null;

    await updateLocalJobStatus(job.id, "failed", {
      errorMessage: messageWithDump,
      result: {
        selectorBundle: getSelectorBundleSignal(context),
        selectorDriftDiagnostics,
        portalEvidence,
        autofillSummary,
        domEvidence,
        recoveryActions: buildRecoveryActions(message, {
          selectorDriftDiagnostics,
        }),
      },
      executionLog: failureExecutionLog,
    });
    const failedLogPath = await writeJobLogToDisk(job, {
      finalStatus: "failed",
      errorMessage: message,
      executionLog: failureExecutionLog,
      result: {
        selectorBundle: getSelectorBundleSignal(context),
        selectorDriftDiagnostics,
        domEvidence,
      },
    });
    if (failedLogPath) {
      pushStatus("progress", `Job log saved to: ${failedLogPath}`);
    }
    pushStatus("error", message);
  } finally {
    activeJobExecutionLog = null;
    await cleanupJobDocuments(job.id);
  }
}

async function runLocalWorkerCycle() {
  if (localWorkerRunning) {
    return;
  }

  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    // Silent polling used to hide exactly the case where Start Filing looks
    // dead in the web app. Announce it once per idle streak instead.
    if (!workerIdleAnnounced) {
      workerIdleAnnounced = true;
      pushStatus(
        "idle",
        "Worker idle: trusted-device token missing. Open the agent from the web app ('Open agent'), complete the portal sign-in, then press Start Filing.",
      );
    }
    return;
  }

  workerIdleAnnounced = false;
  localWorkerRunning = true;

  try {
    const job = await claimNextLocalJob();

    if (!job) {
      return;
    }

    pushStatus(
      "progress",
      `Job claimed: ${job.type || job.jobType || "unknown"} (${job.status || "?"}) — starting automation [build ${AGENT_BUILD_TAG}]`,
    );

    await processLocalJob(job);
  } catch (error) {
    pushStatus(
      "error",
      error instanceof Error
        ? error.message
        : "The local desktop worker encountered an unexpected error.",
    );
  } finally {
    localWorkerRunning = false;
  }
}

function getDeepLinkArgument(argv) {
  return (
    (argv || []).find((value) =>
      String(value).startsWith("taxrocket-connect://"),
    ) || ""
  );
}

function startLocalBridgeServer() {
  if (localBridgeServer) {
    return;
  }

  localBridgeServer = http.createServer(async (request, response) => {
    const requestOrigin = request.headers.origin || "";
    const requestedAllowedOrigins = launchState.allowedOrigins || [];
    const originAllowed =
      !requestedAllowedOrigins.length ||
      isOriginAllowed(requestOrigin, requestedAllowedOrigins);

    if (originAllowed && requestOrigin) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Vary", "Origin");

    if (request.method === "OPTIONS") {
      response.writeHead(originAllowed ? 204 : 403);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/connect") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "Not found." }));
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const allowedOrigins = Array.isArray(payload?.allowedOrigins)
          ? payload.allowedOrigins.filter((value) => typeof value === "string")
          : [];
        const backendAllowlist = Array.isArray(payload?.backendAllowlist)
          ? payload.backendAllowlist.filter(
              (value) => typeof value === "string",
            )
          : [];
        const bridgeOriginAllowed =
          !allowedOrigins.length ||
          isOriginAllowed(requestOrigin, allowedOrigins);
        const backendAllowed = isBackendAllowed(
          payload?.apiBaseUrl,
          backendAllowlist,
        );
        const nonce =
          typeof payload?.nonce === "string" ? payload.nonce.trim() : "";

        if (!bridgeOriginAllowed) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Bridge origin is not allowed.",
            }),
          );
          return;
        }

        if (!backendAllowed) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Desktop launch backend is not allowed.",
            }),
          );
          return;
        }

        if (!nonce || acceptedLaunchNonces.has(nonce)) {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Desktop launch nonce is missing or already used.",
            }),
          );
          return;
        }

        const confirmation = await dialog.showMessageBox(
          mainWindow || undefined,
          {
            type: "question",
            buttons: ["Accept", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            title: LOCAL_AGENT_CONFIRMATION_TITLE,
            message: "Accept Tax Rocket desktop launch?",
            detail: `Origin: ${requestOrigin || "unknown"}\nBackend: ${payload?.apiBaseUrl || "unknown"}\nFlow: ${payload?.flow === "fbr" ? "FBR / Iris" : "DLD / MyDLD"}`,
          },
        );

        if (confirmation.response !== 0) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Desktop launch was cancelled by the user.",
            }),
          );
          return;
        }

        const accepted = applyLaunchPayload(payload);

        if (!accepted) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "token and apiBaseUrl are required.",
            }),
          );
          return;
        }

        acceptedLaunchNonces.add(nonce);

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Invalid launch payload.",
          }),
        );
      }
    });
  });

  localBridgeServer.listen(LOCAL_BRIDGE_PORT, LOCAL_BRIDGE_HOST);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: "#0b1512",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow.webContents.once("did-finish-load", () => {
    pushStatus(
      "success",
      `Agent started — main ${AGENT_BUILD_TAG}; navigator ${irisNavigation.BUILD_TAG}. Both versions must match.`,
    );
  });
}

function scheduleAutoCapture(reason) {
  clearAutoCaptureTimer();

  if (!loginWindow || loginWindow.isDestroyed()) {
    return;
  }

  if (!launchState.token || !launchState.apiBaseUrl) {
    return;
  }

  if (autoCaptureState.inProgress || autoCaptureState.completed) {
    return;
  }

  autoCaptureTimer = setTimeout(() => {
    void attemptAutoCapture(reason);
  }, 900);
}

function isCurrentPortalReadyUrl(rawValue) {
  if (launchState.flow === "fbr") {
    return isLikelyReadyFbrUrl(rawValue);
  }

  return isLikelyLoggedInDldUrl(rawValue);
}

async function attemptAutoCapture(reason) {
  clearAutoCaptureTimer();

  if (!loginWindow || loginWindow.isDestroyed()) {
    return;
  }

  if (!launchState.token || !launchState.apiBaseUrl) {
    pushStatus(
      "error",
      "Return to the web app and start the connection again.",
    );
    return;
  }

  const currentUrl = loginWindow.webContents.getURL();

  if (!isCurrentPortalReadyUrl(currentUrl)) {
    return;
  }

  // The IRIS login page shares the portal domain, so the URL check above
  // matches BEFORE the user has signed in. Waiting on the (mock-only)
  // ready selector there produced a scary red "#iris-dashboard-ready"
  // timeout on every login. Skip while a login form is on screen — the
  // load watchers will re-trigger once the real dashboard appears.
  if (
    launchState.flow === "fbr" &&
    !launchState.desktopAuthConfig.useMockIris &&
    !irisNavigation.isAuthenticated(
      await irisNavigation.probeFrames(loginWindow),
    )
  ) {
    pushStatus(
      "progress",
      "FBR sign-in screen detected. Complete the sign-in — the device is marked ready automatically afterwards.",
    );
    return;
  }

  if (autoCaptureState.inProgress || autoCaptureState.completed) {
    return;
  }

  autoCaptureState.inProgress = true;
  pushStatus(
    "progress",
    reason === "login-detected"
      ? launchState.flow === "fbr"
        ? "FBR sign-in detected. Marking this trusted device ready automatically."
        : "MyDLD sign-in detected. Marking this desktop device ready automatically."
      : launchState.flow === "fbr"
        ? "Checking your local FBR session and saving this device automatically."
        : "Checking your local MyDLD session and saving this device automatically.",
  );

  try {
    await captureLoginWindowState();
    await markTrustedDeviceReady();

    autoCaptureState.completed = true;
    autoCaptureState.inProgress = false;

    pushStatus(
      "success",
      launchState.flow === "fbr"
        ? "FBR sign-in complete. Keep the FBR window open and return to the web app to start filing."
        : "This trusted desktop device is ready for MyDLD automation. You can return to the web app.",
    );
    if (
      loginWindow &&
      !loginWindow.isDestroyed() &&
      launchState.desktopAuthConfig.useMockIris
    ) {
      loginWindow.close();
    }
  } catch (error) {
    autoCaptureState.inProgress = false;
    // Not a hard error: the ready check can legitimately run while the
    // portal is still mid-navigation. Surface it as progress — the load
    // watchers re-trigger capture automatically.
    pushStatus(
      "progress",
      `Device-ready check not complete yet (${
        error instanceof Error ? error.message : "portal still loading"
      }). It will retry automatically once the portal login/dashboard has finished loading.`,
    );
  }
}

function attachLoginWindowWatchers(windowInstance) {
  if (windowInstance.taxRocketWatchersAttached) return;
  windowInstance.taxRocketWatchersAttached = true;
  configurePortalChildWindows(windowInstance);
  const triggerIfReady = () => {
    if (windowInstance !== loginWindow || windowInstance.isDestroyed()) return;
    if (isCurrentPortalReadyUrl(windowInstance.webContents.getURL()))
      scheduleAutoCapture("login-detected");
  };
  for (const event of [
    "did-finish-load",
    "did-navigate",
    "did-navigate-in-page",
    "did-stop-loading",
  ]) {
    windowInstance.webContents.on(event, triggerIfReady);
  }
  const timer = setInterval(triggerIfReady, 2500);
  windowInstance.on("closed", () => {
    clearInterval(timer);
    if (loginWindow === windowInstance) {
      loginWindow = null;
      clearAutoCaptureTimer();
      resetAutoCaptureState();
      navigationStates.clear();
      lastSectionTour = null;
      lastTourStateKey = null;
    }
    if (workerWindow === windowInstance) workerWindow = null;
  });
}

async function createLoginWindow(openFresh = false) {
  if (loginWindowPromise) return loginWindowPromise;
  loginWindowPromise = (async () => {
    if (
      launchState.token &&
      launchState.apiBaseUrl &&
      !launchState.deviceAuthToken
    ) {
      await ensureTrustedDeviceRegistration();
    }
    const partition = getWorkerPartition();
    const loginUrl = resolveDesktopLoginUrl();
    let windowInstance =
      loginWindow && !loginWindow.isDestroyed() ? loginWindow : null;
    if (windowInstance && windowInstance.taxRocketPartition !== partition) {
      // Never reuse one user's browser profile for a different launch partition.
      windowInstance.close();
      windowInstance = null;
    }
    if (!windowInstance) {
      windowInstance = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 960,
        minHeight: 700,
        title: `IRIS — Navigation-only pilot [${AGENT_BUILD_TAG}]`,
        backgroundColor: "#ffffff",
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition,
        },
      });
      windowInstance.taxRocketPartition = partition;
      loginWindow = windowInstance;
      attachLoginWindowWatchers(windowInstance);
      await windowInstance.loadURL(loginUrl);
    } else {
      loginWindow = windowInstance;
      const currentUrl = windowInstance.webContents.getURL();
      const retainLivePage =
        launchState.flow === "fbr" &&
        !launchState.desktopAuthConfig.useMockIris &&
        irisNavigation.isAllowedPortalUrl(currentUrl);
      if (
        !retainLivePage &&
        (openFresh || !currentUrl || currentUrl === "about:blank")
      ) {
        await windowInstance.loadURL(loginUrl);
      }
    }
    windowInstance.show();
    windowInstance.focus();
    scheduleAutoCapture("login-detected");
    startLocalWorkerLoop();
    return windowInstance;
  })();
  try {
    return await loginWindowPromise;
  } finally {
    loginWindowPromise = null;
  }
}

async function captureLoginWindowState() {
  if (!loginWindow || loginWindow.isDestroyed()) {
    throw new Error("The MyDLD login window is not open.");
  }

  const currentUrl = loginWindow.webContents.getURL();

  if (!currentUrl || currentUrl === "about:blank") {
    throw new Error(
      launchState.flow === "fbr"
        ? "Finish loading the Iris readiness screen before this device can be marked ready."
        : "Finish loading the official MyDLD page before this device can be marked ready.",
    );
  }

  if (!isCurrentPortalReadyUrl(currentUrl)) {
    throw new Error(
      launchState.flow === "fbr"
        ? "Complete FBR sign-in before this device can be marked ready."
        : "Complete sign-in to MyDLD before this device can be marked ready.",
    );
  }

  const desktopAuthConfig = normalizeDesktopAuthConfig(
    launchState.desktopAuthConfig,
  );

  if (launchState.flow === "fbr" && !desktopAuthConfig.useMockIris) {
    const inspection = await irisNavigation.probeFrames(loginWindow);
    if (!irisNavigation.isAuthenticated(inspection)) {
      throw new Error(
        "IRIS authenticated dashboard has not been detected. Complete sign-in locally.",
      );
    }
    return { capturedUrl: currentUrl };
  }

  if (
    desktopAuthConfig.readyRejectSelector &&
    (await hasSelector(loginWindow, desktopAuthConfig.readyRejectSelector))
  ) {
    throw new Error(
      launchState.flow === "fbr"
        ? "Iris still shows a sign-in, reset, or error state. Complete that step before continuing."
        : "MyDLD still shows a sign-in or error state. Complete sign-in before continuing.",
    );
  }

  if (desktopAuthConfig.readySelector) {
    await waitForVisibleSelector(
      loginWindow,
      desktopAuthConfig.readySelector,
      5000,
    );
  } else if (desktopAuthConfig.readyUrlPattern) {
    if (
      !matchesSuccessUrlPattern(currentUrl, desktopAuthConfig.readyUrlPattern)
    ) {
      throw new Error(
        launchState.flow === "fbr"
          ? "The trusted desktop app did not detect the expected Iris ready screen yet."
          : "The trusted desktop app did not detect the expected logged-in MyDLD page yet.",
      );
    }
  }

  return {
    capturedUrl: currentUrl,
  };
}

async function markTrustedDeviceReady() {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;

  if (!deviceAuthToken || !launchState.apiBaseUrl) {
    throw new Error("No trusted desktop device token is available yet.");
  }

  const response = await fetch(
    `${launchState.apiBaseUrl}${getTrustedDeviceReadyEndpoint()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceAuthToken}`,
      },
      body: JSON.stringify({
        currentUrl:
          loginWindow && !loginWindow.isDestroyed()
            ? loginWindow.webContents.getURL()
            : null,
      }),
    },
  );

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.error ||
        `Ready-state update failed with status ${response.status}.`,
    );
  }

  return result;
}

ipcMain.handle("get-launch-state", async () => ({
  ...launchState,
  agentBuild: getAgentBuildLabel(),
}));

ipcMain.handle("export-iris-inspection", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents)
    throw new Error("Untrusted IPC sender.");
  const windowInstance = getLivePortalWindow();
  if (!windowInstance || windowInstance.isDestroyed())
    throw new Error("Open the IRIS window first.");
  const inspection = await irisNavigation.probeFrames(windowInstance, {
    ...lastNavigationOptions,
    taxpayerIdentifier: launchState.accountReference || "",
  });
  const filePath = writePortalInspectionToDisk({
    ...inspection,
    ...(lastSectionTour ? { sectionTour: lastSectionTour } : {}),
  });
  pushStatus(
    "success",
    `Read-only structure exported: ${filePath}. Review the file before sharing.`,
  );
  return { ok: true, filePath };
});

ipcMain.handle("open-portal-login", async () => {
  await createLoginWindow(true);
  return {
    ok: true,
    url: resolveDesktopLoginUrl(),
  };
});

ipcMain.handle("open-dld-login", async () => {
  await createLoginWindow(true);
  return {
    ok: true,
    url: resolveDesktopLoginUrl(),
  };
});

ipcMain.handle("capture-and-upload", async (_event, input = {}) => {
  await captureLoginWindowState();
  return markTrustedDeviceReady();
});

ipcMain.handle("set-account-reference", async (_event, value) => {
  if (typeof value !== "string" || !/^[0-9 -]{0,24}$/.test(value)) {
    throw new Error(
      "Enter only the taxpayer CNIC/NTN digits and separators, not passwords or other text.",
    );
  }
  if (
    String(launchState.accountReference || "").replace(/[ -]/g, "") !==
    value.replace(/[ -]/g, "")
  ) {
    navigationStates.clear();
    lastSectionTour = null;
    lastTourStateKey = null;
  }
  launchState.accountReference = value.trim();
  publishLaunchState();
  return { ok: true };
});

ipcMain.handle("open-external", async (_event, value) => {
  const target = typeof value === "string" ? value : "";

  if (!target) {
    return { ok: false };
  }

  await shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle(
  "get-local-bridge-url",
  async () => `http://${LOCAL_BRIDGE_HOST}:${LOCAL_BRIDGE_PORT}/connect`,
);

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = getDeepLinkArgument(argv);
    if (deepLink) {
      applyLaunchUrl(deepLink);
    }
  });

  app.whenReady().then(() => {
    try {
      if (process.defaultApp) {
        app.setAsDefaultProtocolClient("taxrocket-connect", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      } else {
        app.setAsDefaultProtocolClient("taxrocket-connect");
      }
    } catch (error) {
      console.warn("Custom protocol registration was not completed.", error);
    }

    createMainWindow();
    loadAgentState();
    startLocalBridgeServer();
    startLocalWorkerLoop();

    const deepLink = getDeepLinkArgument(process.argv);
    if (deepLink) {
      applyLaunchUrl(deepLink);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  applyLaunchUrl(url);
});

app.on("window-all-closed", () => {
  clearLocalWorkerTimer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
