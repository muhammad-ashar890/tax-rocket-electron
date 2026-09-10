"use strict";

// Navigation-only live pilot. Only allowlisted dashboard/menu/edit controls
// and a positively identified promotional dialog Close button may be clicked.
// An explicitly matched existing draft can now be opened. When no matching
// draft exists, the agent may advance only the exact, packet-derived original
// TY2026+ return setup steps that do not require legal/financial judgement.
// Create/Save/Submit/payment controls and all financial inputs remain off
// limits until the engine/mapping audit is resolved.
const BUILD_TAG = "fix17-setup-continue-20260910";
const DEFAULT_HOSTS = ["iris.fbr.gov.pk"];
const SECTION_TOUR = Object.freeze([
  { id: "salary", group: "Employment", tab: "Salary" },
  {
    id: "withholding",
    group: "Tax Chargeable / Payments",
    tab: "Withholding Tax",
  },
  {
    id: "computations",
    group: "Tax Chargeable / Payments",
    tab: "Computations",
  },
  {
    id: "wealth_assets",
    group: "116 - Wealth Statement",
    tab: "Personal Assets / Liabilities",
  },
  {
    id: "wealth_reconciliation",
    group: "116 - Wealth Statement",
    tab: "Reconciliation of Net Assets",
  },
]);

const ALL_SECTION_TOUR = Object.freeze([
  SECTION_TOUR[0],
  { id: "tax_deductions", group: "Employment", tab: "Tax Deductions" },
  {
    id: "allowance_credits",
    group: "Tax Chargeable / Payments",
    tab: "Allowances, Reductions and Credits",
  },
  ...SECTION_TOUR.slice(1),
  { id: "payment", group: "Top tabs", tab: "Payment" },
  { id: "attachment", group: "Top tabs", tab: "Attachment" },
]);
const ALL_SECTION_IDS = Object.freeze(
  ALL_SECTION_TOUR.map((section) => section.id),
);
// The 116 Wealth Statement sections are NOT panels inside the 114(1) workflow.
// Dry-run 2026-09-09 captured only two expansion panels on the opened return --
// "Employment" and "Tax Chargeable / Payments" -- so both wealth profiles report
// panelFound:false and the tour correctly refuses to guess, blocking every later
// section. Assets/Reconciliation live in a separate document (form 116, reached
// via the "Assets Declaration" menu) and are tracked as their own phase. This
// plan covers the income/tax views that autofill actually needs.
const WEALTH_SECTION_IDS = Object.freeze([
  "wealth_assets",
  "wealth_reconciliation",
]);
const INCOME_SECTION_IDS = Object.freeze(
  ALL_SECTION_IDS.filter((id) => !WEALTH_SECTION_IDS.includes(id)),
);

/**
 * Sections that must render data rows when the return is open. Payment and
 * Attachment do not own grids, so their emptiness proves nothing — that is the
 * difference between "IRIS changed" and "this page has no table here".
 */
const ROW_BEARING_SECTION_IDS = Object.freeze([
  "salary",
  "tax_deductions",
  "allowance_credits",
  "withholding",
  "computations",
  "wealth_assets",
  "wealth_reconciliation",
]);

function normalizeSetupLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getExpectedOriginalTaxPeriod(taxYear) {
  const year = Number(taxYear);
  if (!Number.isInteger(year) || year < 2001) return null;
  const startYear = year - 1;
  return {
    startIso: `${startYear}-07-01`,
    endIso: `${year}-06-30`,
    startLabel: `01-Jul-${startYear}`,
    endLabel: `30-Jun-${year}`,
    longStartLabel: `01-July-${startYear}`,
    longEndLabel: `30-June-${year}`,
  };
}

function classifyNewReturnSetupStage(input = {}) {
  if (input.documentPresent) return null;
  const prompts = new Set(
    (input.prompts || []).map((value) => normalizeSetupLabel(value)),
  );
  const actions = new Set(
    (input.actions || []).map((value) => normalizeSetupLabel(value)),
  );
  const nodeLabels = new Set(
    (input.nodeLabels || []).map((value) => normalizeSetupLabel(value)),
  );

  if (nodeLabels.has("normal return (ind/aop/coy)")) return "menu";
  if (prompts.has("normal return") && prompts.has("simplified return"))
    return "return_type";
  if (prompts.has("resident") || prompts.has("non-resident"))
    return "residency";
  if (actions.has("accept and continue")) return "accept_continue";
  // The TY2026 dialog labels its field "Tax Period"; the dashboard period screen
  // says "Period"/"Tax Year". All three are the same stage — this used to be the
  // only reason the agent stopped at the dialog without clicking Continue.
  if (
    (prompts.has("tax year") || prompts.has("period") || prompts.has("tax period")) &&
    actions.has("continue")
  )
    return "period";

  return null;
}

function isRecognizedNewReturnSetup(input = {}) {
  return Boolean(classifyNewReturnSetupStage(input));
}

// Phase 1.5b. The blue dashboard tile lands on
// /nitr/summary-economic-transactions: a pre-filing gate that asks for income
// sources and residency before "Start Return Filling" becomes enabled. The
// agent must NEVER answer it (residency is a legal determination under ITO
// s.82-84 and the source ticks decide which schedules IRIS opens). It only
// recognises the gate and tells the operator exactly what is outstanding.
function describeEconomicTransactionsGate(gate) {
  if (!gate || !gate.present) return null;
  const sources = Array.isArray(gate.sources) ? gate.sources : [];
  const selected = sources.filter((source) => source && source.checked);
  const missing = [];
  if (!selected.length) missing.push("income sources");
  if (!gate.residencySelected) missing.push("tax residency");
  return {
    ready: Boolean(gate.startEnabled),
    selectedSources: selected.map((source) => source.label).filter(Boolean),
    availableSources: sources.map((source) => source.label).filter(Boolean),
    residencySelected: Boolean(gate.residencySelected),
    startPresent: Boolean(gate.startPresent),
    startEnabled: Boolean(gate.startEnabled),
    missing,
  };
}

function isSafeAutoAdvanceNewReturnStage(stage) {
  return ["menu", "return_type", "period", "accept_continue"].includes(stage);
}

function isManualNewReturnStage(stage) {
  return stage === "residency";
}

// Phase 2a. Dry-run 2026-09-09 filled 0/27: the section tour leaves the portal
// on its LAST view (Attachment, which has no data rows), and the row filler only
// ever sees the section currently on screen. Codes that genuinely exist and are
// editable -- 1000 and 1009 on Salary -- were reported row_not_found purely
// because the wrong grid was showing.
//
// These helpers turn a completed section tour into a per-section fill plan, so
// the agent can return to the section that owns each code before filling it.
// Pure functions over already-captured metadata: they read no live DOM and make
// no navigation decision of their own.

/** Map every IRIS code observed during the tour to the section that showed it. */
function buildSectionCodeIndex(sectionTour) {
  const index = new Map();
  for (const section of sectionTour?.sections || []) {
    if (!section || !section.id) continue;
    for (const row of section.rows || []) {
      const code = String(row?.code || "").trim();
      if (!code || index.has(code)) continue;
      index.set(code, section.id);
    }
  }
  return index;
}

/**
 * Group packet fields by the section that owns their code, preserving the tour
 * order so navigation moves forward through the return rather than jumping
 * about. Codes never seen during the tour are returned separately and are NEVER
 * guessed into a section.
 */
function planSectionFills(fields, sectionTour) {
  const index = buildSectionCodeIndex(sectionTour);
  const order = (sectionTour?.sections || [])
    .map((section) => section?.id)
    .filter(Boolean);
  const bySection = new Map();
  const unlocated = [];
  for (const field of fields || []) {
    const code = String(field?.irisCode || "").trim();
    const sectionId = code ? index.get(code) : null;
    if (!sectionId) {
      unlocated.push(field);
      continue;
    }
    if (!bySection.has(sectionId)) bySection.set(sectionId, []);
    bySection.get(sectionId).push(field);
  }
  const groups = order
    .filter((id) => bySection.has(id))
    .map((id) => ({ sectionId: id, fields: bySection.get(id) }));
  return { groups, unlocated };
}

function isAllowedPortalUrl(value, hosts = DEFAULT_HOSTS) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && hosts.includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

// Runs in the portal renderer, including allowed child frames. Keep this
// function self-contained: Electron serializes it, not the Node module scope.
function portalProbe(options = {}) {
  const normalize = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  // In-page mirror of classifyNewReturnSetupStage/isSafeAutoAdvanceNewReturnStage.
  // Electron serializes this function, so the module-scope originals are not
  // reachable here. scripts/verify-iris-navigation.cjs asserts the two stay in
  // agreement so this copy can never silently drift.
  const setupLabel = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const classifySetupStage = (input) => {
    if (input.documentPresent) return null;
    const prompts = new Set((input.prompts || []).map(setupLabel));
    const actions = new Set((input.actions || []).map(setupLabel));
    const nodeLabels = new Set((input.nodeLabels || []).map(setupLabel));
    if (nodeLabels.has("normal return (ind/aop/coy)")) return "menu";
    if (prompts.has("normal return") && prompts.has("simplified return"))
      return "return_type";
    if (prompts.has("resident") || prompts.has("non-resident"))
      return "residency";
    if (actions.has("accept and continue")) return "accept_continue";
    if (
      (
        prompts.has("tax year") ||
        prompts.has("period") ||
        prompts.has("tax period")
      ) &&
      actions.has("continue")
    )
      return "period";
    return null;
  };
  // Material renders field captions as <mat-label>/<mdc-floating-label>, never as
  // a bare <label>, so a selector limited to label/legend sees nothing in the
  // Normal Return dialog. One constant for both prompt sources so they cannot
  // drift apart again.
  const SETUP_LABEL_SELECTOR =
    'label,mat-label,.mat-mdc-form-field-label,.mdc-floating-label,legend,[role="heading"],h1,h2,h3,h4,.mat-mdc-dialog-title,.mdc-dialog__title,.dialog-title';
  // A recognised setup stage may already carry portal-filled fields (the TY2026
  // dialog shows Person + Tax Period and asks only for Continue): those are not
  // waiting for a human. An EMPTY editable box is, and so is a 4-digit period
  // that names a different year than the packet's. Values are compared inside
  // the page; only the verdict is returned, never the value.
  const setupFieldsAwaitHuman = (scope) =>
    Array.from(scope.querySelectorAll("input, textarea"))
      .filter(visible)
      .some((input) => {
        const type = input.getAttribute("type") || "text";
        if (/^(?:radio|checkbox|button|submit|hidden)$/i.test(type)) return false;
        // An OTP/password box is a human question even when the page happens to
        // show a setup caption next to it and the box is already filled.
        if (
          type === "password" ||
          input.getAttribute("autocomplete") === "one-time-code"
        )
          return true;
        if (input.disabled || input.readOnly) return false;
        const value = String(input.value || "").trim();
        if (!value) return true;
        return (
          /^20\d\d$/.test(value) &&
          Number(options.taxYear) > 0 &&
          Number(value) !== Number(options.taxYear)
        );
      });
  const isSafeAutoAdvanceStage = (stage) =>
    ["menu", "return_type", "period", "accept_continue"].includes(stage);
  const attribute = (s) =>
    normalize(s)
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
      .replace(/\b\d{5}-?\d{7}-?\d\b/g, "[identifier]")
      .replace(/\d{7,}/g, "[number]")
      .replace(/[a-f0-9]{24,}/gi, "[identifier]")
      .slice(0, 140);
  const safeUrl = (s) => {
    try {
      const u = new URL(s, location.href);
      if (!/^https?:$/.test(u.protocol)) return "[non-http]";
      return `${u.origin}${attribute(u.pathname)}`; // no query, hash or credentials
    } catch {
      return "[unavailable]";
    }
  };
  const visible = (el) => {
    if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]'))
      return false;
    const content = el.closest(".mat-expansion-panel-content");
    const owningPanel = content?.closest("mat-expansion-panel");
    const owningHeader = owningPanel?.querySelector(
      ":scope > mat-expansion-panel-header",
    );
    if (
      owningHeader &&
      !owningHeader.classList.contains("mat-expanded") &&
      owningHeader.getAttribute("aria-expanded") !== "true"
    )
      return false;
    const tab = el.closest(".custom-tabs .body");
    if (
      tab &&
      Array.from(tab.classList).some((name) => /^interface_\d+$/.test(name)) &&
      !tab.classList.contains("active")
    )
      return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number(s.opacity) !== 0
    );
  };
  const controls = (root = document) =>
    Array.from(
      root.querySelectorAll(
        'a, button, [role="button"], [role="tab"], [role="menuitem"]',
      ),
    ).filter(visible);
  const text = (el) => {
    // Menu icons and CSS text-transform are decoration, not part of a label.
    // Read a detached control clone, never mutate the portal or read inputs.
    if (
      el.matches('a, button, [role="button"], [role="tab"], [role="menuitem"]')
    ) {
      const copy = el.cloneNode(true);
      copy
        .querySelectorAll(
          'mat-icon, .mat-icon, i, svg, input, select, textarea, [aria-hidden="true"]',
        )
        .forEach((icon) => icon.remove());
      return normalize(copy.textContent || "");
    }
    return normalize(el.innerText || el.textContent || "");
  };
  const active = (el) =>
    el.getAttribute("aria-selected") === "true" ||
    el.classList.contains("active");
  let interaction = null;
  const clickable = (el) => {
    const rounded = (rect) =>
      Object.fromEntries(
        ["left", "top", "right", "bottom", "width", "height"].map((key) => [
          key,
          Math.round(rect[key] || 0),
        ]),
      );
    interaction = {
      target: el ? descriptor(el) : null,
      reason: "not_visible",
      samples: [],
    };
    if (!el || !el.isConnected || !visible(el)) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      interaction.reason = "disabled";
      return false;
    }
    if (getComputedStyle(el).pointerEvents === "none") {
      interaction.reason = "pointer_events_none";
      return false;
    }
    // Default/auto can inherit CSS smooth scrolling. Do not hit-test an old
    // off-screen rect while the scroll animation is still travelling.
    try {
      el.scrollIntoView({
        behavior: "instant",
        block: "center",
        inline: "nearest",
      });
      interaction.scrollMode = "instant";
    } catch {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      interaction.scrollMode = "auto_fallback";
    }
    const rect = el.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    let area = {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(width, rect.right),
      bottom: Math.min(height, rect.bottom),
    };
    // Intersect actual scroll/clip ancestors too: a header can be inside an
    // inner scroller while its geometric centre is outside the visible slice.
    for (
      let parent = el.parentElement;
      parent && parent !== document.documentElement && parent !== document.body;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      const sx = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
      const sy = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        const left = bounds.left + parent.clientLeft * sx;
        area.left = Math.max(area.left, left);
        area.right = Math.min(area.right, left + parent.clientWidth * sx);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        const top = bounds.top + parent.clientTop * sy;
        area.top = Math.max(area.top, top);
        area.bottom = Math.min(area.bottom, top + parent.clientHeight * sy);
      }
    }
    area = {
      ...area,
      width: area.right - area.left,
      height: area.bottom - area.top,
    };
    interaction.viewport = { width, height };
    interaction.bounds = rounded(rect);
    interaction.visibleBounds = rounded(area);
    if (area.width < 2 || area.height < 2) {
      interaction.reason = "outside_visible_area";
      return false;
    }
    const points = [
      [0.5, 0.5],
      [0.15, 0.5],
      [0.85, 0.5],
      [0.5, 0.2],
      [0.5, 0.8],
    ];
    for (const [px, py] of points) {
      const x = area.left + area.width * px;
      const y = area.top + area.height * py;
      const top = document.elementFromPoint(x, y);
      const nested = top?.closest(
        'a,button,input,select,textarea,[role="button"]',
      );
      const hitsTarget = Boolean(top && (top === el || el.contains(top)));
      const independentChild = Boolean(
        nested && nested !== el && el.contains(nested),
      );
      interaction.samples.push({
        x: Math.round(x),
        y: Math.round(y),
        hit: top ? descriptor(top) : null,
        hitsTarget,
        independentChild,
      });
      if (hitsTarget && !independentChild) {
        interaction.reason = "interactable";
        return true;
      }
    }
    // No forced DOM click when an overlay/other element intercepts every
    // tested point. Diagnostics omit text and values, including the blocker.
    interaction.reason = "obstructed";
    return false;
  };
  const descriptor = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: attribute(el.id),
    classes: attribute(
      typeof el.className === "string" ? el.className : el.className?.baseVal,
    ),
    role: attribute(el.getAttribute("role")),
  });

  // Only recognized UI labels are exported. Never export arbitrary body text,
  // account names, input values, HTML, storage, cookies or event handlers.
  const formLabel = (value) => {
    const t = normalize(value);
    const codes = Array.from(
      new Set(
        t.match(
          /\b(?:114|116|165|149)\s*\(\s*\d+[a-z]?\s*\)(?:\s*\(\s*\d+\s*\))?/gi,
        ) || [],
      ),
    );
    const descriptions = [
      "Return of Income filed voluntarily for complete year",
      "Return of Income filed voluntarily",
      "Wealth Statement",
      "Simplified Return",
      "Salaried Person",
      "Income Tax Return",
      "Return of Income",
      "Revised Return",
    ].filter((p) => t.toLowerCase().includes(p.toLowerCase()));
    if (!codes.length && !descriptions.length) return null;
    return {
      codes: codes.map((c) => c.replace(/\s+/g, "")),
      description: descriptions[0] || null,
      revised: /\brevised\b/i.test(t),
      salaried: /\bsalaried\b|\bsalary\b/i.test(t),
    };
  };
  const uiLabel = (value) => {
    const t = normalize(value);
    const known = [
      "Declaration",
      "Assets Declaration",
      "Draft (Unsubmitted Documents)",
      "IT DECLARATION",
      "Completed Tasks",
      "Income Tax Return",
      "Tax Year",
      "Inbox (Correspondence from FBR)",
      "Outbox (Awaiting Actions by FBR)",
      "FILTERS",
      "Employment",
      "Salary",
      "Property",
      "Other Sources",
      "Adjustable Tax",
      "Wealth Statement",
      "Computation",
      "Calculate",
      "Save",
      "Submit",
      "Close",
      "Cancel",
      "Continue",
      "Login",
      "Sign In",
      "Tax Chargeable / Payments",
      "Withholding Tax",
      "Computations",
      "116 - Wealth Statement",
      "Personal Assets / Liabilities",
      "Reconciliation of Net Assets",
      "Return Statements (Original for TY 2026 and onwards)",
      "Normal Return (Ind/AOP/COY)",
      "Accept and Continue",
      "Resident",
      "Non-Resident",
      "Period",
    ];
    return (
      known.find((p) => t.toLowerCase() === p.toLowerCase()) ||
      (/^IT DECLARATION\s*\(\d+\)$/i.test(t) ? t : null)
    );
  };
  const allControls = controls();
  const visibleInputs = Array.from(
    document.querySelectorAll("input, textarea, select"),
  ).filter(visible);
  const passwordVisible = visibleInputs.some(
    (el) => el.getAttribute("type") === "password",
  );
  const loginVisible =
    passwordVisible &&
    (allControls.some((el) => /^(?:log\s*in|sign\s*in)$/i.test(text(el))) ||
      /forgot password|taxpayer login/i.test(document.body?.innerText || ""));
  const draftTabs = allControls.filter((el) =>
    /^Draft \(Unsubmitted Documents\)$/i.test(text(el)),
  );
  const declarationMenus = allControls.filter(
    (el) => text(el).toLowerCase() === "declaration",
  );
  const home = Array.from(document.querySelectorAll('a[id="homeLink"]')).some(
    (el) =>
      visible(el) &&
      /\/dashboard(?:$|[?#])/.test(el.getAttribute("href") || ""),
  );
  const accountMenu = allControls.some((el) =>
    /person_pin/.test(el.textContent || ""),
  );
  const dashboardTable = document.querySelector("#dashboardTable");
  const dashboardColumns = dashboardTable
    ? Array.from(dashboardTable.querySelectorAll('th,[role="columnheader"]'))
        .filter(visible)
        .map((el) => text(el).toLowerCase())
    : [];
  const completedTabPresent = allControls.some((el) =>
    /^completed tasks$/i.test(text(el)),
  );
  const incomeDeclarationPresent = allControls.some((el) =>
    /^IT DECLARATION(?:\s*\(\d+\))?$/i.test(text(el)),
  );
  const emptyPaginatorPresent = Array.from(
    document.querySelectorAll(
      ".mat-mdc-paginator-range-label,.mat-paginator-range-label",
    ),
  )
    .filter(visible)
    .some((el) => /^0(?:\s*[-–]\s*0)?\s+of\s+0$/i.test(text(el)));
  // Private workspace evidence is independent of the responsive header. The
  // supplied failing log has this complete grid but no recognized nav labels.
  const dashboardWorkspace = Boolean(
    dashboardTable &&
    visible(dashboardTable) &&
    draftTabs.length > 0 &&
    completedTabPresent &&
    (incomeDeclarationPresent || emptyPaginatorPresent) &&
    dashboardColumns.includes("task") &&
    (dashboardColumns.includes("period") ||
      dashboardColumns.includes("tax period")) &&
    (dashboardColumns.includes("action") ||
      dashboardColumns.includes("actions")),
  );
  // Phase 1.5b. The pre-filing gate reached from the blue dashboard tile.
  // Presence and enablement ONLY: never read or write the taxpayer's answers.
  const gateHost = Array.from(
    document.querySelectorAll("app-summary-economic-transactions"),
  ).find(visible);
  const gateStartButton = gateHost
    ? Array.from(gateHost.querySelectorAll("button")).find(
        (el) =>
          visible(el) &&
          /^start\s+return\s+fill?ing$/i.test(
            normalize(el.getAttribute("aria-label") || text(el)),
          ),
      )
    : null;
  const economicTransactionsGate = gateHost
    ? {
        present: true,
        // Path only. The query string carries an opaque session token.
        path: (() => {
          try {
            return new URL(location.href).pathname;
          } catch {
            return null;
          }
        })(),
        sources: Array.from(gateHost.querySelectorAll("app-source-checkbox"))
          .filter(visible)
          .map((host) => {
            const input = host.querySelector('input[type="checkbox"]');
            return {
              label: text(host).slice(0, 80),
              checked: Boolean(input && input.checked),
            };
          }),
        residencySelected: Array.from(
          gateHost.querySelectorAll(
            'mat-radio-group input[type="radio"], mat-radio-button input[type="radio"]',
          ),
        ).some((el) => el.checked),
        startPresent: Boolean(gateStartButton),
        startEnabled: Boolean(
          gateStartButton &&
          !gateStartButton.disabled &&
          gateStartButton.getAttribute("aria-disabled") !== "true",
        ),
      }
    : null;
  const workflow = Array.from(
    document.querySelectorAll("app-nitr-workflow"),
  ).find(visible);
  const workflowHeader = workflow?.querySelector("app-wf-header");
  const workflowYear = Boolean(
    workflowHeader &&
    Array.from(workflowHeader.querySelectorAll("h6"))
      .filter(visible)
      .some((el) => /^Year\s+20\d{2}$/i.test(text(el))),
  );
  const workflowDocument = Boolean(
    workflowHeader &&
    Array.from(workflowHeader.querySelectorAll("span,p"))
      .filter(visible)
      .some((el) => {
        const label = text(el);
        return (
          label.length < 220 && /\b(?:114|116)\s*\(\s*\d+\s*\)/i.test(label)
        );
      }),
  );
  const workflowRegistration = Boolean(
    workflowHeader &&
    Array.from(workflowHeader.querySelectorAll("p"))
      .filter(visible)
      .some((el) => /^Registration\s*(?:No|Number)\s*:/i.test(text(el))),
  );
  const returnWorkspace = Boolean(
    workflow && workflowYear && workflowDocument && workflowRegistration,
  );
  const sessionExpired = Array.from(
    document.querySelectorAll(
      '[role="alert"],.alert,[role="dialog"],.modal.show,.session-error',
    ),
  )
    .filter(visible)
    .some((el) =>
      /(?:session (?:has )?(?:expired|timed out|is invalid)|please (?:log|sign)\s*in again)/i.test(
        text(el),
      ),
    );
  const headerWorkspace =
    home &&
    declarationMenus.length > 0 &&
    (draftTabs.length > 0 || accountMenu);
  // A hostname/body/search box alone still NEVER proves readiness. Explicit
  // login/expiry prompts override otherwise cached dashboard/return content.
  // The gate page is served only to a signed-in taxpayer but renders none of
  // the dashboard chrome (no homeLink, Declaration menu, person_pin or
  // #dashboardTable). Without this it would be reported as unverified.
  const gateWorkspace = Boolean(
    economicTransactionsGate &&
    economicTransactionsGate.startPresent &&
    economicTransactionsGate.sources.length > 0,
  );
  const authenticated =
    !loginVisible &&
    !sessionExpired &&
    (dashboardWorkspace || returnWorkspace || headerWorkspace || gateWorkspace);
  const readiness = {
    state: authenticated
      ? "ready"
      : loginVisible || sessionExpired
        ? "login_required"
        : "unverified",
    evidence: authenticated
      ? dashboardWorkspace
        ? "dashboard_workspace"
        : returnWorkspace
          ? "return_workspace"
          : headerWorkspace
            ? "header_workspace"
            : "economic_transactions_gate"
      : null,
    homeDashboardLink: home,
    declarationMenuCount: declarationMenus.length,
    draftTabPresent: draftTabs.length > 0,
    completedTabPresent,
    incomeDeclarationPresent,
    dashboardWorkspace,
    returnWorkspace,
    loginFormVisible: loginVisible,
    explicitSessionExpired: sessionExpired,
  };

  const dialogNodes = Array.from(
    document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .ui-dialog, .modal, mat-dialog-container, ' +
        '.mat-mdc-dialog-container, [class*="welcome-popup" i], [class*="welcomePopup" i], ' +
        '[class*="popup" i]',
    ),
  ).filter(visible);
  // A parent and its nested Material dialog are one dialog, not two.
  const dialogs = dialogNodes.filter(
    (el) => !dialogNodes.some((other) => other !== el && el.contains(other)),
  );
  const kindOfDialog = (el) => {
    const t = text(el).toLowerCase();
    const dialogControls = controls(el);
    const commitControlPresent = dialogControls.some((control) =>
      /^(?:submit|confirm|pay|i agree)$/i.test(text(control)),
    );
    const verificationSignature =
      /\botp\b|captcha|\bpin\b|password|\bpsid\b|\bpayment\b/i.test(t);
    // Phase 1.5a. The agent opens the "Normal Return (Ind/AOP/COY)" setup
    // dialog itself, then its own sensitiveControl heuristic below classifies
    // it as protected and every navigation retry deadlocks on it. Exempt ONLY
    // a dialog whose visible labels classify as a known, auto-advanceable
    // setup stage and that carries no verification or commit control. The
    // heuristic itself stays untouched for every other dialog.
    const setupDescriptor = {
      documentPresent: false,
      prompts: Array.from(el.querySelectorAll(SETUP_LABEL_SELECTOR))
        .filter(visible)
        .map(text),
      actions: dialogControls.map(text),
      nodeLabels: dialogControls.map(text),
    };
    const setupStage = classifySetupStage(setupDescriptor);
    if (
      setupStage &&
      isSafeAutoAdvanceStage(setupStage) &&
      !verificationSignature &&
      !commitControlPresent &&
      // A setup stage may show prefilled boxes, but nothing may still be waiting
      // to be typed by a human (see setupFieldsAwaitHuman).
      !setupFieldsAwaitHuman(el)
    )
      return "setup";
    // A real entry/verification field inside a dialog makes dismissal a
    // human decision, even when its name/label is unfamiliar.
    const sensitiveControl = Array.from(
      el.querySelectorAll("input, textarea, select"),
    ).some(visible);
    if (sensitiveControl || verificationSignature) return "protected";
    const imageText = Array.from(el.querySelectorAll("img"))
      .map((img) => img.getAttribute("alt") || "")
      .join(" ")
      .toLowerCase();
    const signature = `${t} ${imageText}`;
    // Confirmed in the supplied dashboard HTML: image text is NOT DOM text;
    // its alt is merely "Help Image". Require the exact image + close class
    // inside MDB's visible modal, not a generic image-only dialog.
    const knownBanner =
      el.matches("mdb-modal-container.modal.show") &&
      Array.from(el.querySelectorAll("img")).some((img) => {
        try {
          return (
            new URL(img.getAttribute("src") || "", location.href).pathname
              .split("/")
              .pop() === "nitr-banner-submission.png"
          );
        } catch {
          return false;
        }
      }) &&
      el.querySelector("a.mainDashboardHelpDlgClose");
    const welcome =
      knownBanner ||
      (signature.includes("submit your income tax return") &&
        (signature.includes("last date") || signature.includes("tax year")));
    if (welcome && !commitControlPresent) return "welcome";
    return "unknown";
  };
  const dialogKinds = dialogs.map(kindOfDialog);
  const blockers = Array.from(
    document.querySelectorAll(
      ".ui-widget-overlay, .modal-backdrop, .cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
    ),
  ).filter(
    (el) => visible(el) && getComputedStyle(el).pointerEvents !== "none",
  );
  // Phase 1.5a. A recognised setup dialog the agent itself opened is a stage to
  // advance, not an obstacle to pause on. Every other dialog kind -- protected,
  // welcome, unknown -- still blocks exactly as before.
  const setupDialogOnly =
    dialogs.length > 0 && dialogKinds.every((kind) => kind === "setup");
  const blocking =
    dialogKinds.some((kind) => kind !== "setup") || blockers.length > 0;
  // `blocking` keeps its original meaning (any live backdrop counts), because
  // fill and readiness consumers rely on that being conservative. Advancing a
  // setup dialog is the one thing allowed through it: IRIS dialogs are Material
  // overlays, so the dialog's OWN backdrop used to make its Continue button
  // permanently unreachable — the loop tolerated it (frame.setupDialogOnly),
  // the action path did not, and the two disagreed on every retry.
  const setupAdvanceAllowed = setupDialogOnly;
  const isClose = (el) => {
    const label = normalize(
      el.getAttribute("aria-label") || el.getAttribute("title") || text(el),
    );
    return (
      el.matches("a.mainDashboardHelpDlgClose") ||
      /^(?:close(?: dialog| popup| window)?|dismiss|x|×|✕)$/i.test(label) ||
      /(?:^|\s)(?:ui-dialog-titlebar-close|btn-close|close-icon)(?:\s|$)/.test(
        String(el.className),
      )
    );
  };

  const expectedIdentifier = normalize(options.taxpayerIdentifier).replace(
    /[ -]/g,
    "",
  );
  const identityConfigured = /^(?:\d{7}|\d{8}|\d{13})$/.test(
    expectedIdentifier,
  );
  const identifiersIn = (t) =>
    (
      normalize(t).match(
        /(?<!\d)(?:\d{5}-\d{7}-\d|\d{7}-\d|\d{13}|\d{8}|\d{7})(?!\d)/g,
      ) || []
    ).map((value) => value.replace(/-/g, ""));
  const identityStatus = (t) => {
    if (!identityConfigured) return "not_configured";
    const ids = Array.from(new Set(identifiersIn(t)));
    return ids.length === 0
      ? "unknown"
      : ids.length === 1 && ids[0] === expectedIdentifier
        ? "match"
        : "mismatch";
  };
  const isOriginalFullYear = (t) =>
    /114\s*\(\s*1\s*\)/i.test(t) &&
    /return of income filed voluntarily for complete year/i.test(t) &&
    !/revised/i.test(t);
  const isoDate = (value) => {
    let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return value;
    match = value.match(/^(\d{1,2})[-/. ]([a-z]+|\d{1,2})[-/. ](20\d{2})$/i);
    if (!match) return null;
    const month = /^\d+$/.test(match[2])
      ? Number(match[2])
      : [
          "jan",
          "feb",
          "mar",
          "apr",
          "may",
          "jun",
          "jul",
          "aug",
          "sep",
          "oct",
          "nov",
          "dec",
        ].indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
    return month > 0 && month <= 12
      ? `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`
      : null;
  };
  const rowFacts = (row) => {
    const t = text(row);
    const yearMatch = t.match(/tax\s*year\s*:?\s*(20\d{2})/i);
    const dateStrings =
      t.match(
        /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[-/.](?:[a-z]+|\d{1,2})[-/.]20\d{2})(?!\d)/gi,
      ) || [];
    const start = isoDate(dateStrings[0] || "");
    const end = isoDate(dateStrings[1] || "");
    const periodMatch =
      start === `${Number(options.taxYear) - 1}-07-01` &&
      end === `${options.taxYear}-06-30`;
    const year = yearMatch
      ? Number(yearMatch[1])
      : periodMatch
        ? Number(options.taxYear)
        : null;
    return {
      originalFullYear: isOriginalFullYear(t),
      taxYear: year,
      periodStart: start,
      periodEnd: end,
      periodMatch,
      identityStatus: identityStatus(t),
    };
  };
  const dashboardRows = Array.from(
    document.querySelectorAll("#dashboardTable tr.doubleclick"),
  ).filter(visible);
  const currentYearRows = dashboardRows.filter((row) => {
    const f = rowFacts(row);
    return f.originalFullYear && f.taxYear === Number(options.taxYear);
  });
  const matchingRows = currentYearRows.filter((row) => {
    const f = rowFacts(row);
    return f.periodMatch && f.identityStatus === "match";
  });
  const grid = document.querySelector("#dashboardTable");
  const itTab = allControls.find((el) =>
    /^IT DECLARATION(?:\s*\(\d+\))?$/i.test(text(el)),
  );
  const countMatch = itTab && text(itTab).match(/\((\d+)\)/);
  const declaredCount = countMatch ? Number(countMatch[1]) : null;
  const range = Array.from(
    document.querySelectorAll(
      ".mat-mdc-paginator-range-label, .mat-paginator-range-label",
    ),
  )
    .filter(visible)
    .map(text)
    .join(" ");
  const rangeMatch = range.match(/(?:(\d+)\s*[-–]\s*)?(\d+)\s+of\s+(\d+)/i);
  const pageTotal = rangeMatch ? Number(rangeMatch[3]) : null;
  const filtersPresent = Array.from(
    document.querySelectorAll(
      '#dashboardTable .mat-mdc-chip, .filter-applied, [data-filter-active="true"]',
    ),
  ).some(visible);
  const completeGrid = Boolean(
    grid &&
    visible(grid) &&
    !filtersPresent &&
    draftTabs.some(active) &&
    ((declaredCount !== null &&
      declaredCount === dashboardRows.length &&
      (pageTotal === null || pageTotal === declaredCount)) ||
      (declaredCount === null &&
        pageTotal === 0 &&
        dashboardRows.length === 0)),
  );
  const head = document.querySelector("app-wf-header");
  const returnShell = Array.from(
    document.querySelectorAll("app-nitr-workflow"),
  ).find(visible);
  const yearHeading =
    head &&
    Array.from(head.querySelectorAll("h6"))
      .map(text)
      .find((t) => /^Year\s+20\d{2}$/i.test(t));
  const documentYear = yearHeading
    ? Number(yearHeading.match(/20\d{2}/)[0])
    : null;
  // Compare only the labelled Registration No, never a name, random reference
  // or financial amount. The actual identifier is NEVER included in results.
  const registrationText =
    head &&
    Array.from(head.querySelectorAll("p"))
      .map(text)
      .find((t) => /^Registration\s*(?:No|Number)\s*:/i.test(t));
  const titleCandidates = head
    ? Array.from(head.querySelectorAll("span.h-padding-5, span, p")).filter(
        (el) =>
          !el.closest(".dropdown-menu,.megamenu-dropdown-section") &&
          /^(?:114|116)\s*\(/.test(text(el)) &&
          text(el).length < 220,
      )
    : [];
  const titleLabels = Array.from(new Set(titleCandidates.map(text)));
  const actualTitle = titleLabels.length === 1 ? titleLabels[0] : null;
  const documentInfo = {
    present: Boolean(returnShell),
    taxYear: documentYear,
    titleDetected: Boolean(actualTitle),
    formCode:
      actualTitle
        ?.match(/^(?:114|116)\s*\(\s*\d+\s*\)/)?.[0]
        .replace(/\s+/g, "") || null,
    originalFullYear: Boolean(actualTitle && isOriginalFullYear(actualTitle)),
    identityStatus: identityStatus(registrationText || ""),
  };
  const salary = document.querySelector(
    "app-nitr-wf-body .body.interface_21.active",
  );
  const headings = salary
    ? Array.from(
        salary.querySelectorAll(
          ".wf-sticky-toolbar.salary .heading-bar strong",
        ),
      )
        .map(text)
        .slice(2)
    : [];
  const expectedHeadings = [
    "Total Income",
    "Subject to Final Tax",
    "Subject to Exemption",
    "Subject to Normal Income",
  ];
  const salaryRows = salary
    ? Array.from(salary.querySelectorAll(".dataRow[id]"))
        .filter(visible)
        .map((row) => ({
          code: /^(1000|1009|1049|1010|1008|1059|1089|1099)$/.test(row.id)
            ? row.id
            : "[unrecognized]",
          cells: Array.from(
            row.querySelectorAll(
              ".columns-parent > .data-middle-child-wapper input",
            ),
          ).map((input, index) => ({
            column: expectedHeadings.includes(headings[index])
              ? headings[index]
              : null,
            position: index + 1,
            disabled: Boolean(input.disabled),
            readOnly: Boolean(input.readOnly),
          })),
        }))
    : [];
  const wages = salaryRows.find((row) => row.code === "1009");
  const total = salaryRows.find((row) => row.code === "1000");
  const salaryVerified =
    JSON.stringify(headings) === JSON.stringify(expectedHeadings) &&
    wages?.cells.length === 4 &&
    !wages.cells[0].disabled &&
    !wages.cells[2].disabled &&
    wages.cells[1].disabled &&
    wages.cells[3].disabled &&
    total?.cells.length === 4 &&
    total.cells.every((cell) => cell.disabled);

  // Fixed navigation registry: callers cannot supply a selector or turn a
  // section name into a Create/Save/Submit/Calculate action.
  const sectionProfiles = {
    salary: { group: "Employment", tab: "Salary" },
    tax_deductions: { group: "Employment", tab: "Tax Deductions" },
    allowance_credits: {
      group: "Tax Chargeable / Payments",
      tab: "Allowances, Reductions and Credits",
    },
    payment: { group: "Top tabs", tab: "Payment", top: true, interface: "61" },
    attachment: {
      group: "Top tabs",
      tab: "Attachment",
      top: true,
      interface: "204",
    },
    withholding: { group: "Tax Chargeable / Payments", tab: "Withholding Tax" },
    computations: { group: "Tax Chargeable / Payments", tab: "Computations" },
    wealth_assets: {
      group: "116 - Wealth Statement",
      tab: "Personal Assets / Liabilities",
    },
    wealth_reconciliation: {
      group: "116 - Wealth Statement",
      tab: "Reconciliation of Net Assets",
    },
  };
  const dataBody = document.querySelector(
    "app-nitr-wf-body .body.interface_21.active",
  );
  const dataButtons = dataBody
    ? Array.from(dataBody.querySelectorAll("button.data-tab-left-btn")).filter(
        visible,
      )
    : [];
  const topTab = (profile) =>
    profile?.top
      ? Array.from(
          document.querySelectorAll(
            "app-nitr-wf-body .custom-tabs > .sticky-tabs-head > .head .title",
          ),
        ).filter((el) => visible(el) && text(el) === profile.tab)
      : [];
  const getPanel = (profile) => {
    if (profile?.top) {
      const tabs = topTab(profile);
      return tabs.length === 1 ? tabs[0] : null;
    }
    if (!dataBody || !profile) return null;
    const matches = Array.from(
      dataBody.querySelectorAll("mat-expansion-panel-header"),
    ).filter((header) => visible(header) && text(header) === profile.group);
    return matches.length === 1 ? matches[0] : null;
  };
  const panelExpanded = (header) =>
    Boolean(
      header &&
      (header.matches(".sticky-tabs-head .title") ||
        header.classList.contains("mat-expanded") ||
        header.getAttribute("aria-expanded") === "true"),
    );
  const matchingSectionButtons = (profile) => {
    if (profile?.top) return topTab(profile);
    const header = getPanel(profile);
    const panel = panelExpanded(header)
      ? header.closest("mat-expansion-panel")
      : null;
    return panel
      ? Array.from(panel.querySelectorAll("button.data-tab-left-btn")).filter(
          (button) => visible(button) && text(button) === profile.tab,
        )
      : [];
  };
  const currentSectionIds = Object.entries(sectionProfiles)
    .filter(([, profile]) => matchingSectionButtons(profile).some(active))
    .map(([id]) => id);
  const currentSectionId =
    currentSectionIds.length === 1 ? currentSectionIds[0] : null;
  const requestedSection = Object.prototype.hasOwnProperty.call(
    sectionProfiles,
    options.sectionId || "",
  )
    ? sectionProfiles[options.sectionId]
    : null;
  const sectionNavigation = Object.entries(sectionProfiles).map(
    ([id, profile]) => {
      const header = getPanel(profile);
      const buttons = matchingSectionButtons(profile);
      return {
        id,
        group: profile.group,
        tab: profile.tab,
        panelFound: Boolean(header),
        panelExpanded: panelExpanded(header),
        tabFound: buttons.length === 1,
        active: buttons.length === 1 && active(buttons[0]),
      };
    },
  );

  // PUBLIC_CODE_SET and PUBLIC_COLUMN_LABELS are generated from the supplied
  // public field-code catalog, plus the observed modern Salary labels. They
  // are metadata allowlists, NOT calculation or filing rules.
  const PUBLIC_CODE_SET = new Set([
    "1000",
    "1008",
    "1009",
    "1010",
    "1049",
    "1059",
    "1089",
    "1099",
    "2000",
    "2001",
    "2002",
    "2003",
    "2004",
    "2005",
    "2029",
    "2031",
    "2032",
    "2033",
    "2034",
    "2035",
    "2036",
    "2037",
    "2038",
    "2039",
    "2097",
    "2098",
    "2099",
    "3000",
    "3009",
    "3019",
    "3029",
    "3030",
    "3039",
    "3059",
    "3071",
    "3072",
    "3073",
    "3074",
    "3076",
    "3077",
    "3083",
    "3087",
    "3088",
    "3099",
    "3100",
    "3101",
    "3115",
    "3116",
    "3123",
    "3128",
    "3129",
    "3131",
    "3141",
    "3151",
    "3152",
    "3154",
    "3155",
    "3158",
    "3162",
    "3165",
    "3166",
    "3168",
    "3170",
    "3171",
    "3172",
    "3174",
    "3178",
    "3180",
    "3186",
    "3187",
    "3195",
    "319501",
    "3196",
    "3197",
    "3198",
    "3199",
    "3200",
    "3201",
    "3202",
    "3203",
    "3204",
    "3205",
    "3206",
    "3207",
    "3208",
    "3209",
    "320901",
    "3210",
    "3211",
    "3212",
    "3213",
    "3215",
    "3216",
    "3217",
    "3218",
    "3219",
    "3220",
    "3224",
    "3225",
    "3226",
    "3227",
    "322901",
    "322902",
    "322903",
    "322904",
    "322905",
    "3230",
    "3231",
    "3234",
    "3235",
    "3236",
    "3237",
    "3238",
    "3239",
    "3245",
    "3246",
    "3247",
    "3248",
    "324802",
    "3250",
    "3254",
    "3255",
    "3256",
    "3257",
    "3258",
    "3259",
    "3260",
    "3270",
    "327020",
    "327021",
    "327022",
    "327023",
    "327024",
    "3301",
    "3302",
    "33020405",
    "330205",
    "3303",
    "33030105",
    "33030205",
    "33030305",
    "33030405",
    "33030605",
    "330308",
    "3304105",
    "3304205",
    "3304305",
    "3304405",
    "3305",
    "330516",
    "3306",
    "3307",
    "3312",
    "3315",
    "3319",
    "3348",
    "3349",
    "3352",
    "3371",
    "3384",
    "3398",
    "3399",
    "3401",
    "3402",
    "3403",
    "4000",
    "4006",
    "4016",
    "4017",
    "4026",
    "4036",
    "4037",
    "5000",
    "5002",
    "5003041",
    "500312",
    "5004",
    "5005",
    "5006",
    "5007",
    "5016",
    "5028",
    "5029",
    "5088",
    "5089",
    "6000",
    "6011",
    "6029",
    "6039",
    "6049",
    "6059",
    "6100",
    "640000",
    "64000101",
    "64000102",
    "64000103",
    "64010002",
    "64010004",
    "64010006",
    "64010008",
    "64010009",
    "64010011",
    "64010012",
    "64010033",
    "64010037",
    "64010052",
    "64010054",
    "64010058",
    "64010061",
    "64010062",
    "64010084",
    "64020004",
    "64020005",
    "64020007",
    "64040001",
    "64040002",
    "64040003",
    "64040004",
    "64050007",
    "64050008",
    "64050009",
    "64050012",
    "64050013",
    "64050050",
    "64050051",
    "64050052",
    "64050053",
    "64050054",
    "64050055",
    "64050056",
    "64050095",
    "64050098",
    "64060002",
    "64060003",
    "64060005",
    "64060009",
    "64060051",
    "64060052",
    "64060053",
    "64060055",
    "64060059",
    "64060061",
    "64060082",
    "64060083",
    "64060084",
    "64060116",
    "64060151",
    "64060152",
    "64060153",
    "64060156",
    "64060158",
    "64060170",
    "64060172",
    "64060266",
    "64060270",
    "64060283",
    "64060285",
    "64060290",
    "64060352",
    "64060555",
    "64070054",
    "64070151",
    "64070152",
    "64070153",
    "64070154",
    "64070155",
    "64080001",
    "64090151",
    "64100101",
    "64100301",
    "64100302",
    "64100303",
    "64100304",
    "64100306",
    "64100308",
    "64100309",
    "64100310",
    "64100311",
    "64100312",
    "64100313",
    "64100314",
    "64100315",
    "64100316",
    "64100317",
    "64100318",
    "64100319",
    "64100320",
    "64100321",
    "64100322",
    "64100323",
    "64100324",
    "64100325",
    "64100326",
    "64120045",
    "64120046",
    "64120047",
    "64120048",
    "64120049",
    "64120050",
    "64120060",
    "64120066",
    "64120070",
    "64120074",
    "64120087",
    "64120088",
    "64130001",
    "64130002",
    "64130003",
    "64140051",
    "64140052",
    "64140053",
    "64150001",
    "64150002",
    "64150003",
    "64150004",
    "64150005",
    "64150006",
    "64150101",
    "64150301",
    "64150302",
    "64150303",
    "64150407",
    "64150507",
    "64150509",
    "64150510",
    "64150701",
    "64150702",
    "64150803",
    "64151101",
    "64151905",
    "64151907",
    "64210051",
    "64210054",
    "6421005401",
    "64210056",
    "6421005601",
    "64220160",
    "64310010",
    "64310011",
    "64320051",
    "64320053",
    "64340210",
    "64340211",
    "7001",
    "7002",
    "7003",
    "700302",
    "7004",
    "7005",
    "7006",
    "7007",
    "7008",
    "7009",
    "7010",
    "7011",
    "7012",
    "7013",
    "7014",
    "7015",
    "7016",
    "7018",
    "7019",
    "7020",
    "7021",
    "7022",
    "7029",
    "703000",
    "703001",
    "703002",
    "703003",
    "703004",
    "7031",
    "7032",
    "7033",
    "7034",
    "7035",
    "7036",
    "7037",
    "7038",
    "7039",
    "7043",
    "7048",
    "7049",
    "7051",
    "7052",
    "7055",
    "7056",
    "7058",
    "7059",
    "7060",
    "7061",
    "7066",
    "7070",
    "7071",
    "7072",
    "7073",
    "7076",
    "7087",
    "7088",
    "7089",
    "7091",
    "7092",
    "7098",
    "7099",
    "7100",
    "7101",
    "7102",
    "7103",
    "7104",
    "7105",
    "7106",
    "7107",
    "7108",
    "9000",
    "9001",
    "9002",
    "9008",
    "900801",
    "9009",
    "9010",
    "9012",
    "9100",
    "9200",
    "920000",
    "920001",
    "920002",
    "9201",
    "920100",
    "9202",
    "92022",
    "92025",
    "92026",
    "92027",
    "9203",
    "9204",
    "920900",
    "9210",
    "92101",
    "923152",
    "923161",
    "923168",
    "9231822",
    "923183",
    "923184",
    "923189",
    "923193",
    "923194",
    "923198",
    "923201",
    "923206",
    "930101",
    "9302",
    "930201",
    "930701",
    "930702",
    "9309",
    "9311",
    "9313",
    "931901",
    "931902",
    "931903",
    "9320",
    "9321",
    "9323",
    "9328",
    "9329",
    "9331",
    "9332",
    "999901",
    "999902",
    "999903",
    "999905",
    "999909",
    "999910",
    "999911",
  ]);
  const PUBLIC_COLUMN_LABELS = [
    "Addition (New)",
    "Addition (Used in Pakistan)",
    "Admissible",
    "Amortization",
    "Amount",
    "Amount Exempt from Tax / Subject to Fixed / Final Tax",
    "Amount Exempt from Tax / Subject to Fixed / Final Tax/ Tax Collected / Deducted",
    "Amount Subject to Normal Tax",
    "Amount Subject to Normal Tax / Tax Chargeable",
    "Attributable Taxable Income",
    "Closing",
    "Code",
    "Cost / Declared Value",
    "Current Year",
    "Deemed Income",
    "Deletion",
    "Depreciation",
    "Description",
    "Difference (Option Valid if <=0)",
    "Difference of Minimum Tax Chargeable",
    "Eligible Amount",
    "Exempt Agriculture Income",
    "Extent of Use",
    "Fair Market Value",
    "Inadmissible",
    "Ineligible Amount",
    "Initial Allowance",
    "Opening",
    "Previous Year",
    "Receipts / Value",
    "Remaining Useful Years",
    "Subject to Exemption",
    "Subject to Final Tax",
    "Subject to Normal Income",
    "Subject to Normal Tax",
    "Tax Chargeable",
    "Tax Collected / Deducted",
    "Tax Collected / Deducted / Paid",
    "Tax Credit",
    "Tax Deducted",
    "Tax Paid",
    "Tax Paid in Province",
    "Tax Reducted",
    "Tax Withheld",
    "Tax on Attributable Taxable Income",
    "Taxable Amount",
    "Taxable Value",
    "Taxable Values",
    "Total",
    "Total Agriculture Income",
    "Total Amount",
    "Total Amount/ Receipts / Value",
    "Total Income",
    "WDV (BF)",
    "WDV (CF)",
  ];
  const safeColumn = (value) =>
    PUBLIC_COLUMN_LABELS.find(
      (label) =>
        normalize(label).toLowerCase() === normalize(value).toLowerCase(),
    ) || "[unrecognized heading]";
  const busy = Array.from(
    document.querySelectorAll(
      '[aria-busy="true"], app-global-loader [role="progressbar"], .loading-overlay',
    ),
  ).some(visible);
  const sensitiveInputVisible = visibleInputs.some(
    (input) =>
      input.getAttribute("type") === "password" ||
      input.getAttribute("autocomplete") === "one-time-code",
  );
  // Evidence from the supplied HTML: WHT and deductions contain multiple
  // .mat-expansion-panel-body grids, each with its OWN .heading-bar.
  const headerElements = dataBody
    ? Array.from(dataBody.querySelectorAll(".heading-bar"))
        .filter(visible)
        .filter((bar) =>
          Array.from(bar.querySelectorAll("strong")).some((el) =>
            /^code$/i.test(text(el)),
          ),
        )
    : [];
  const divRows = dataBody
    ? Array.from(
        dataBody.querySelectorAll(".dataRow[id], .tableRows[id]"),
      ).filter(visible)
    : [];
  const headerForRow = (row) => {
    for (
      let parent = row.parentElement;
      parent && dataBody?.contains(parent);
      parent = parent.parentElement
    ) {
      const owned = headerElements.filter((header) => parent.contains(header));
      if (owned.length === 1) return owned[0];
      if (owned.length > 1 || parent === dataBody) return null;
    }
    return null;
  };
  const fieldPanels = dataBody
    ? Array.from(
        dataBody.querySelectorAll(
          ".wf-section-modal-accordion > mat-expansion-panel",
        ),
      ).filter(visible)
    : [];
  const knownGridTitles = [
    "Adjustable Tax",
    "Average Tax",
    "Deductible Allowances",
    "Final Tax",
    "Minimum Tax",
    "Tax Credits",
    "Tax Reductions",
  ];
  const fieldPanelHeader = (panel) =>
    panel.querySelector(":scope > mat-expansion-panel-header");
  const fieldPanelTitle = (panel) => {
    const header = fieldPanelHeader(panel);
    const label = header ? text(header) : "";
    return (
      knownGridTitles.find(
        (candidate) => candidate.toLowerCase() === label.toLowerCase(),
      ) || null
    );
  };
  const fieldGridPanels = fieldPanels.map((panel, index) => ({
    index,
    title: fieldPanelTitle(panel),
    expanded: panelExpanded(fieldPanelHeader(panel)),
    recognized: Boolean(fieldPanelTitle(panel)),
  }));
  const grids = headerElements.map((header, index) => {
    const labels = Array.from(header.querySelectorAll("strong")).map(text);
    const panel = header.closest(
      ".wf-section-modal-accordion > mat-expansion-panel",
    );
    return {
      id: `grid-${index + 1}`,
      title: panel ? fieldPanelTitle(panel) : null,
      columns: labels
        .filter((label) => !/^(description|code|actions?)$/i.test(label))
        .map(safeColumn),
      headerAssociation: panel
        ? "owning_accordion_body"
        : "nearest_single_header_ancestor",
    };
  });
  const amountHeaders = grids.length === 1 ? grids[0].columns : [];
  const metadataRows = [];
  for (const row of divRows.slice(0, 200)) {
    const knownCode = PUBLIC_CODE_SET.has(row.id);
    const code = knownCode ? row.id : "[unrecognized code]";
    const header = headerForRow(row);
    const group = header ? grids[headerElements.indexOf(header)] : null;
    const ownedRows = header
      ? divRows.filter((candidate) => headerForRow(candidate) === header)
      : [];
    const codeRows = ownedRows.filter((candidate) => candidate.id === row.id);
    const detail = row.classList.contains("section-detail-child-row");
    const rowRole = detail
      ? "detail"
      : row.classList.contains("form-head")
        ? "summary"
        : "primary";
    // An observed detail class differentiates duplicate summary/detail codes.
    // Never fabricate a unique selector just by choosing the first occurrence.
    const rowClass = row.classList.contains("dataRow")
      ? "dataRow"
      : "tableRows";
    const roleSelector = detail
      ? ".section-detail-child-row"
      : ":not(.section-detail-child-row)";
    const rowSelector = knownCode
      ? `app-nitr-wf-body .body.interface_21.active [id="${code}"].${rowClass}${roleSelector}`
      : null;
    const uniqueRow = Boolean(
      rowSelector && document.querySelectorAll(rowSelector).length === 1,
    );
    const wrappers = Array.from(
      row.querySelectorAll(
        ":scope > .columns-parent > .data-middle-child-wapper",
      ),
    );
    const cells = wrappers.map((wrapper, index) => {
      const candidates = Array.from(
        wrapper.querySelectorAll("input,select,textarea"),
      ).filter(visible);
      const input = candidates.length === 1 ? candidates[0] : null;
      const displayed = Array.from(
        wrapper.querySelectorAll(".amount-cell-value"),
      ).some(visible);
      return {
        position: index + 1,
        column: group?.columns[index] || "[unrecognized heading]",
        kind: input
          ? input.tagName.toLowerCase()
          : displayed
            ? "display"
            : "unverified",
        type: input ? attribute(input.getAttribute("type")) : null,
        disabled: input ? Boolean(input.disabled) : null,
        readOnly: input ? Boolean(input.readOnly) : null,
        selector:
          uniqueRow && input && group
            ? `${rowSelector} > .columns-parent > .data-middle-child-wapper:nth-child(${index + 1}) ${input.tagName.toLowerCase()}`
            : null,
        selectorUniqueInCapture: Boolean(uniqueRow && input && group),
      };
    });
    metadataRows.push({
      code,
      gridId: group?.id || null,
      gridTitle: group?.title || null,
      rowRole,
      occurrenceCount: codeRows.length,
      occurrenceInGrid: codeRows.indexOf(row) + 1,
      headerMatched: Boolean(group),
      expectedCellCount: group?.columns.length ?? null,
      layout: "div",
      cells,
    });
  }
  const tables = dataBody
    ? Array.from(dataBody.querySelectorAll("table")).filter(visible)
    : [];
  const tableMetadata = [];
  if (!metadataRows.length) {
    for (const [tableIndex, table] of tables.entries()) {
      const labels = Array.from(table.querySelectorAll("thead th")).map(text);
      const codeIndex = labels.findIndex((label) => /^code$/i.test(label));
      if (codeIndex < 0) continue;
      const columns = labels
        .slice(codeIndex + 1)
        .filter((label) => !/^actions?$/i.test(label))
        .map(safeColumn);
      tableMetadata.push({ tableIndex, columns });
      for (const [rowIndex, row] of Array.from(
        table.querySelectorAll("tbody tr"),
      )
        .filter(visible)
        .entries()) {
        const code = normalize(row.cells[codeIndex]?.textContent);
        if (!/^\d{4,9}$/.test(code)) continue;
        metadataRows.push({
          code: PUBLIC_CODE_SET.has(code) ? code : "[unrecognized code]",
          layout: "table",
          tableIndex,
          rowIndex,
          gridId: `table-${tableIndex + 1}`,
          headerMatched: true,
          expectedCellCount: columns.length,
          cells: columns.map((column, index) => {
            const cell = row.cells[codeIndex + 1 + index];
            const inputs = cell
              ? Array.from(
                  cell.querySelectorAll("input,select,textarea"),
                ).filter(visible)
              : [];
            const control = inputs.length === 1 ? inputs[0] : null;
            return {
              position: index + 1,
              column,
              kind: control ? control.tagName.toLowerCase() : "display",
              disabled: control ? Boolean(control.disabled) : null,
              readOnly: control ? Boolean(control.readOnly) : null,
              selector: null,
              selectorUniqueInCapture: false,
            };
          }),
        });
        if (metadataRows.length >= 200) break;
      }
    }
  }
  const emptyNotice = Boolean(
    dataBody &&
    Array.from(
      dataBody.querySelectorAll(
        ".no-data,.no-records,.empty-state,[data-empty-state],td,p,span",
      ),
    )
      .filter(visible)
      .some((el) =>
        /^(?:no (?:data|records?|entries|results|tax records?|withholding(?: tax)? records?)(?: available| found| to display)?)[.!]?$/i.test(
          text(el),
        ),
      ),
  );
  const unboundRows = metadataRows.filter(
    (row) => !row.headerMatched || row.cells.length !== row.expectedCellCount,
  ).length;
  const collapsedGridCount = fieldGridPanels.filter(
    (panel) => !panel.expanded,
  ).length;
  const structurePresent =
    metadataRows.length > 0 &&
    unboundRows === 0 &&
    collapsedGridCount === 0 &&
    metadataRows.every((row) => row.cells.length > 0);
  const paymentRoot = document.querySelector(
    "app-payment .body.interface_61.active",
  );
  const attachmentRoot = document.querySelector(
    "app-attachment .body.interface_204.active",
  );
  const paymentPanels = paymentRoot
    ? ["Unclaimed Payments", "Claimed Payments", "Payment Summary"].map(
        (label) => ({
          label,
          present: Array.from(paymentRoot.querySelectorAll("h4"))
            .filter(visible)
            .some((el) => text(el) === label),
        }),
      )
    : [];
  const attachmentSlots = attachmentRoot
    ? Array.from(attachmentRoot.querySelectorAll('input[type="file"]')).map(
        (input) => ({
          slot: ["doc_9230", "doc_3000", "doc_3003"].includes(input.id)
            ? input.id
            : "[unrecognized slot]",
          fileInputPresent: true,
          hidden: input.hasAttribute("hidden"),
          // Do not read input.files, file names, URLs or values.
        }),
      )
    : [];
  const paymentReady = Boolean(
    paymentRoot &&
    visible(paymentRoot) &&
    paymentPanels.length === 3 &&
    paymentPanels.every((panel) => panel.present),
  );
  const attachmentReady = Boolean(
    attachmentRoot &&
    visible(attachmentRoot) &&
    Array.from(attachmentRoot.querySelectorAll("h5")).some(
      (el) => text(el) === "Attachments",
    ) &&
    attachmentSlots.length > 0,
  );
  const section = {
    id: currentSectionId,
    dataViewActive: Boolean(dataBody),
    ambiguousSelection: currentSectionIds.length > 1,
    navigation: sectionNavigation,
    columns: amountHeaders,
    grids,
    tables: tableMetadata,
    rows: metadataRows,
    fieldGridPanels,
    collapsedGridCount,
    headerBindingErrors: unboundRows,
    panels: paymentPanels,
    attachmentSlots,
    busy,
    sensitiveInputVisible,
    explicitEmpty: emptyNotice && metadataRows.length === 0,
    structurePresent: structurePresent || paymentReady || attachmentReady,
    unknownCodeCount: metadataRows.filter(
      (row) => row.code === "[unrecognized code]",
    ).length,
    unknownColumnCount: [
      ...grids.flatMap((grid) => grid.columns),
      ...tableMetadata.flatMap((table) => table.columns),
    ].filter((column) => column === "[unrecognized heading]").length,
    unverifiedControlCount: metadataRows
      .flatMap((row) => row.cells)
      .filter((cell) => cell.kind === "unverified").length,
    structureKey: JSON.stringify({
      grids,
      tables: tableMetadata,
      rows: metadataRows.map((row) => ({
        code: row.code,
        gridId: row.gridId,
        role: row.rowRole,
        cells: row.cells.map((cell) => ({ column: cell.column })),
      })),
      panels: paymentPanels,
      slots: attachmentSlots.map((slot) => slot.slot),
      empty: emptyNotice,
    }),
  };

  let actionResult = {
    action: options.action || "inspect",
    status: "read_only",
  };
  if (options.action === "close-welcome") {
    if (dialogs.length === 1 && kindOfDialog(dialogs[0]) === "welcome") {
      const matches = controls(dialogs[0]).filter(isClose);
      if (matches.length === 1 && clickable(matches[0])) {
        matches[0].click();
        actionResult.status = "clicked";
      } else {
        actionResult.status = "manual_close_required";
      }
    } else {
      actionResult.status = blocking ? "manual_close_required" : "not_present";
    }
  } else if (
    [
      "open-matching-draft",
      "declaration-hover",
      "new-return-category",
      "new-return-form",
      "new-return-continue",
      "new-return-residency",
      "expand-employment",
      "salary-tab",
      "section-panel",
      "section-tab",
      "section-grid-expand",
      "data-tab",
    ].includes(options.action)
  ) {
    actionResult.status = "not_found";
    let matches = [];
    if (!options.openReturn) actionResult.status = "navigation_not_enabled";
    else if (!authenticated) actionResult.status = "login_required";
    else if ((blocking && !setupAdvanceAllowed) || sensitiveInputVisible)
      actionResult.status = "blocked_by_dialog";
    else if (!identityConfigured) actionResult.status = "identity_required";
    else {
      if (options.action === "open-matching-draft") {
        // Require the ENTIRE unfiltered grid to be represented. Do not pick
        // the first row on a paginated/filtered view, or create a duplicate.
        if (!completeGrid) actionResult.status = "grid_incomplete";
        else if (matchingRows.length > 1) actionResult.status = "ambiguous";
        else if (
          currentYearRows.some(
            (row) => rowFacts(row).identityStatus === "mismatch",
          )
        )
          actionResult.status = "identity_mismatch";
        else if (matchingRows.length === 1) {
          const row = matchingRows[0];
          matches = Array.from(row.querySelectorAll('i.editicon[title="Edit"]'))
            .map((icon) => icon.closest("a"))
            .filter(Boolean);
        } else if (currentYearRows.length)
          actionResult.status = "row_unverified";
        else actionResult.status = "no_matching_draft";
      } else if (options.action === "declaration-hover") {
        matches = declarationMenus;
      } else if (options.action === "new-return-category") {
        const declaration =
          declarationMenus.length === 1
            ? declarationMenus[0].closest("li")
            : null;
        // Evidence: id=2001 is repeated; target the exact TY2026+ label.
        matches = declaration
          ? Array.from(
              declaration.querySelectorAll("a.megamenu-sidebarlinks"),
            ).filter(
              (el) =>
                visible(el) &&
                text(el) ===
                  "Return Statements (Original for TY 2026 and onwards)",
            )
          : [];
      } else if (options.action === "new-return-form") {
        matches = allControls.filter((el) => {
          const label = text(el);
          return (
            label === "Normal Return (Ind/AOP/COY)" || label === "Normal Return"
          );
        });
      } else if (options.action === "new-return-continue") {
        const continueControls = allControls.filter((el) => {
          const label = text(el);
          return label === "Continue" || label === "Accept and Continue";
        });
        const acceptAndContinue = continueControls.filter(
          (el) => text(el) === "Accept and Continue",
        );
        matches =
          acceptAndContinue.length === 1 ? acceptAndContinue : continueControls;
      } else if (options.action === "new-return-residency") {
        const targetResidency = String(options.residencyStatus || "").trim();
        matches = targetResidency
          ? allControls.filter((el) => text(el) === targetResidency)
          : [];
      } else if (options.action === "data-tab") {
        if (
          !documentInfo.present ||
          !documentInfo.originalFullYear ||
          documentInfo.taxYear !== Number(options.taxYear)
        )
          actionResult.status = "document_mismatch";
        else if (documentInfo.identityStatus !== "match")
          actionResult.status = "identity_mismatch";
        else {
          matches = Array.from(
            document.querySelectorAll(
              "app-nitr-wf-body .custom-tabs > .sticky-tabs-head > .head .title",
            ),
          ).filter((el) => visible(el) && text(el) === "Data");
          if (matches.length === 1 && active(matches[0])) {
            actionResult.status = "already_active";
            matches = [];
          }
        }
      } else if (
        options.action === "section-panel" ||
        options.action === "section-tab" ||
        options.action === "section-grid-expand"
      ) {
        if (
          !documentInfo.present ||
          !documentInfo.originalFullYear ||
          documentInfo.taxYear !== Number(options.taxYear)
        )
          actionResult.status = "document_mismatch";
        else if (documentInfo.identityStatus !== "match")
          actionResult.status = "identity_mismatch";
        else if (!requestedSection) actionResult.status = "unsupported_section";
        else if (busy) actionResult.status = "page_busy";
        else if (options.action === "section-grid-expand") {
          const pinned = options.gridTarget;
          const candidates = pinned
            ? fieldPanels.filter(
                (panel, index) =>
                  index === pinned.index &&
                  fieldPanelTitle(panel) === pinned.title,
              )
            : fieldPanels.filter(
                (panel) => !panelExpanded(fieldPanelHeader(panel)),
              );
          if (pinned && candidates.length !== 1)
            actionResult.status = "target_changed";
          else if (!candidates.length) actionResult.status = "already_active";
          else if (!fieldPanelTitle(candidates[0]))
            actionResult.status = "unsupported_grid";
          else {
            actionResult.gridTarget = {
              index: fieldPanels.indexOf(candidates[0]),
              title: fieldPanelTitle(candidates[0]),
            };
            if (panelExpanded(fieldPanelHeader(candidates[0])))
              actionResult.status = "already_active";
            else matches = [fieldPanelHeader(candidates[0])];
          }
        } else if (options.action === "section-panel") {
          const header = getPanel(requestedSection);
          if (panelExpanded(header)) actionResult.status = "already_active";
          else if (header) matches = [header];
        } else {
          const header = getPanel(requestedSection);
          if (!panelExpanded(header))
            actionResult.status = "panel_not_expanded";
          else {
            matches = matchingSectionButtons(requestedSection);
            if (matches.length === 1 && active(matches[0])) {
              actionResult.status = "already_active";
              matches = [];
            }
          }
        }
      } else {
        if (
          !documentInfo.present ||
          !documentInfo.originalFullYear ||
          documentInfo.taxYear !== Number(options.taxYear)
        )
          actionResult.status = "document_mismatch";
        else if (documentInfo.identityStatus !== "match")
          actionResult.status = "identity_mismatch";
        else {
          const header = Array.from(
            document.querySelectorAll("mat-expansion-panel-header"),
          ).find((el) => visible(el) && text(el) === "Employment");
          if (options.action === "expand-employment") {
            if (
              header &&
              (header.classList.contains("mat-expanded") ||
                header.getAttribute("aria-expanded") === "true")
            )
              actionResult.status = "already_active";
            else if (header) matches = [header];
          } else if (header) {
            const panel = header.closest("mat-expansion-panel");
            matches = Array.from(
              panel.querySelectorAll("button.data-tab-left-btn"),
            ).filter((el) => visible(el) && text(el) === "Salary");
            if (matches.length === 1 && active(matches[0])) {
              actionResult.status = "already_active";
              matches = [];
            }
          }
        }
      }
      if (matches.length > 1) actionResult.status = "ambiguous";
      else if (matches.length === 1) {
        if (!clickable(matches[0])) actionResult.status = "not_interactable";
        else if (options.action === "declaration-hover") {
          matches[0].dispatchEvent(
            new MouseEvent("mouseover", { bubbles: true }),
          );
          matches[0].dispatchEvent(
            new MouseEvent("mouseenter", { bubbles: false }),
          );
          actionResult.status = "hovered";
        } else {
          matches[0].click();
          actionResult.status = "clicked";
        }
      }
    }
  } else if (options.action && options.action !== "inspect") {
    // Hard whitelist: never accept a caller-provided selector/action to click.
    const targets = {
      "draft-tab": draftTabs,
      "it-declaration-tab": allControls.filter((el) =>
        /^IT DECLARATION(?:\s*\(\d+\))?$/i.test(text(el)),
      ),
      "declaration-menu": declarationMenus,
    };
    const matches = targets[options.action];
    if (!matches) actionResult.status = "unsupported_action";
    else if (!authenticated) actionResult.status = "login_required";
    else if (blocking) actionResult.status = "blocked_by_dialog";
    else if (matches.length !== 1)
      actionResult.status = matches.length ? "ambiguous" : "not_found";
    else if (options.action !== "declaration-menu" && active(matches[0]))
      actionResult.status = "already_active";
    else if (options.action === "it-declaration-tab" && !draftTabs.some(active))
      actionResult.status = "draft_tab_not_active";
    else if (!clickable(matches[0])) actionResult.status = "not_interactable";
    else {
      matches[0].click();
      actionResult.status = "clicked";
    }
  }

  const rows = Array.from(document.querySelectorAll("tr, [role='row']"))
    .filter(visible)
    .filter((row) => !row.closest('[role="dialog"], .modal, .ui-dialog'))
    .map((row) => {
      const label = formLabel(text(row));
      if (!label || !label.codes.some((code) => /^(114|116)\(/.test(code)))
        return null;
      const t = text(row);
      // These are candidates, NOT proof of the document's period or identity.
      const years = Array.from(new Set(t.match(/\b20\d{2}\b/g) || [])).map(
        Number,
      );
      const periods = Array.from(
        new Set(
          t.match(
            /\b(?:\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}|20\d{2}-\d{2}-\d{2}|\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ]20\d{2})\b/gi,
          ) || [],
        ),
      );
      return {
        ...descriptor(row),
        form: label,
        candidateYears: years,
        candidatePeriods: periods,
        ...(row.matches("#dashboardTable tr.doubleclick") ? rowFacts(row) : {}),
        requestedYearMentioned: years.includes(Number(options.taxYear)),
        controls: controls(row).map((el) => ({
          ...descriptor(el),
          label: uiLabel(text(el)),
        })),
      };
    })
    .filter(Boolean)
    .slice(0, 30);
  const knownColumns =
    /^(?:task|form|description|code|period|tax period|tax year|year|from|to|status|action|actions|document|total amount|amount|tax collected.*|amount exempt.*|amount subject.*)$/i;
  const columns = Array.from(
    document.querySelectorAll("th, [role='columnheader']"),
  )
    .filter(visible)
    .map(text)
    .filter((s) => knownColumns.test(s))
    .slice(0, 40);
  const nodes = allControls
    .map((el) => ({
      ...descriptor(el),
      label: uiLabel(text(el)),
      form: formLabel(text(el)),
      selected: active(el),
    }))
    .filter((node) => node.label || node.form)
    .slice(0, 100);
  const inputs = visibleInputs
    .map((el) => ({
      ...descriptor(el),
      type: attribute(el.getAttribute("type")),
      name: attribute(el.getAttribute("name")),
      formControlName: attribute(el.getAttribute("formcontrolname")),
      disabled: Boolean(el.disabled),
      readOnly: Boolean(el.readOnly),
      // Do not read .value, defaultValue, placeholder, options or textContent.
    }))
    .slice(0, 100);
  const newReturnPrompts = [
    "Tax Year",
    "Tax Period",
    "Period",
    "Normal Return",
    "Simplified Return",
    "Resident",
    "Non-Resident",
  ].filter((label) =>
    Array.from(document.querySelectorAll(SETUP_LABEL_SELECTOR))
      .filter(visible)
      .some((el) => text(el).toLowerCase() === label.toLowerCase()),
  );
  const newReturnActions = allControls
    .map(text)
    .filter((label) =>
      /^(Next|Continue|Create|Accept and Continue)$/i.test(label),
    );
  const newReturnSetup = !documentInfo.present
    ? {
        // Presence only. Never read field values. The navigation pilot may
        // only click exact, allowlisted setup controls for the packet route.
        prompts: newReturnPrompts,
        actions: newReturnActions,
      }
    : null;
  return {
    schemaVersion: 2,
    url: safeUrl(location.href),
    actionResult: { ...actionResult, ...(interaction ? { interaction } : {}) },
    identityConfigured,
    document: documentInfo,
    section,
    newReturnSetup,
    grid: {
      present: Boolean(grid && visible(grid)),
      rowCount: dashboardRows.length,
      declaredCount,
      pageTotal,
      complete: completeGrid,
      filtersPresent,
    },
    salary: {
      active: Boolean(salary && currentSectionId === "salary"),
      columns: headings.filter((h) => expectedHeadings.includes(h)),
      rows: currentSectionId === "salary" ? salaryRows : [],
      verified: Boolean(salaryVerified && currentSectionId === "salary"),
    },
    authenticated,
    readiness,
    loginVisible,
    hasBlockingOverlay: blocking,
    setupDialogOnly,
    economicTransactionsGate,
    draftTabActive: draftTabs.some(active),
    itDeclarationTabActive: allControls.some(
      (el) => /^IT DECLARATION(?:\s*\(\d+\))?$/i.test(text(el)) && active(el),
    ),
    dialogs: dialogs.map((el, index) => ({
      ...descriptor(el),
      kind: dialogKinds[index],
      imageCount: el.querySelectorAll("img").length,
      closeControls: controls(el).filter(isClose).map(descriptor),
    })),
    blockingBackdropCount: blockers.length,
    nodes,
    rows,
    columns,
    inputs,
  };
}

async function probeFrames(
  windowInstance,
  options = {},
  hosts = DEFAULT_HOSTS,
) {
  windowInstance =
    typeof windowInstance === "function" ? windowInstance() : windowInstance;
  if (!windowInstance || windowInstance.isDestroyed())
    return { frames: [], unavailable: "window_closed" };
  const wc = windowInstance.webContents;
  const main = wc.mainFrame;
  const frames = main ? Array.from(main.framesInSubtree || [main]) : [wc];
  let actionFrame = null;
  if (
    frames.length > 1 &&
    [
      "open-matching-draft",
      "declaration-hover",
      "new-return-category",
      "new-return-form",
      "new-return-continue",
      "new-return-residency",
      "expand-employment",
      "salary-tab",
      "section-panel",
      "section-tab",
      "section-grid-expand",
      "data-tab",
    ].includes(options.action)
  ) {
    const before = await probeFrames(
      windowInstance,
      { ...options, action: "inspect" },
      hosts,
    );
    const eligible = before.frames
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame.authenticated);
    if (
      eligible.length !== 1 ||
      before.frames.some(
        (frame) =>
          (frame.hasBlockingOverlay && !frame.setupDialogOnly) ||
          frame.loginVisible ||
          frame.readiness?.explicitSessionExpired,
      )
    ) {
      return {
        frames: before.frames.map((frame) => ({
          ...frame,
          actionResult: { action: options.action, status: "ambiguous" },
        })),
      };
    }
    actionFrame = frames[eligible[0].index];
  }
  const results = [];
  for (const frame of frames.slice(0, 12)) {
    if (actionFrame && frame !== actionFrame) continue;
    const url = frame === wc ? wc.getURL() : frame.url;
    if (!isAllowedPortalUrl(url, hosts)) {
      results.push({
        skipped: "unapproved_origin",
        main: frame === main || frame === wc,
      });
      continue;
    }
    try {
      const snapshot = await frame.executeJavaScript(
        `(${portalProbe.toString()})(${JSON.stringify(options)})`,
        Boolean(options.action && options.action !== "inspect"),
      );
      results.push({ ...snapshot, main: frame === main || frame === wc });
    } catch {
      results.push({
        unavailable: "frame_navigating",
        main: frame === main || frame === wc,
      });
    }
  }
  return { frames: results };
}

/**
 * Phase 2a. Bring a named section on screen so the row filler addresses the
 * grid that actually owns the codes. Uses the same allowlisted, read-only
 * actions as the section tour ("data-tab", "section-panel", "section-tab") and
 * confirms the switch by reading back `section.id`. It clicks no amount input,
 * no Calculate, no Save and no Submit.
 *
 * Returns { ok, status, inspection }. A false `ok` is always reported to the
 * caller rather than filling whatever happens to be showing.
 */
async function navigateToSection(
  windowInstance,
  { sectionId, taxYear, taxpayerIdentifier = "", hosts = DEFAULT_HOSTS } = {},
) {
  const profile = ALL_SECTION_TOUR.find((entry) => entry.id === sectionId);
  if (!profile) return { ok: false, status: "unsupported_section" };
  // openReturn is what unlocks the navigation action allowlist in portalProbe.
  // Without it every section click returns "navigation_not_enabled".
  const options = { taxYear, taxpayerIdentifier, openReturn: true };
  const read = () => probeFrames(windowInstance, options, hosts);
  const current = (snapshot) =>
    snapshot.frames.find((frame) => frame.document?.present);
  const runAction = async (action) => {
    const response = await probeFrames(
      windowInstance,
      { ...options, action, sectionId },
      hosts,
    );
    return {
      response,
      status: current(response)?.actionResult?.status || "not_found",
    };
  };

  let snapshot = await read();
  let frame = current(snapshot);
  if (!frame)
    return { ok: false, status: "document_not_open", inspection: snapshot };
  if (frame.section?.id === sectionId && !frame.section?.busy)
    return { ok: true, status: "already_active", inspection: snapshot };

  if (profile.group !== "Top tabs" && frame.section?.dataViewActive === false) {
    const data = await runAction("data-tab");
    if (!["clicked", "already_active"].includes(data.status))
      return {
        ok: false,
        status: `data_tab_${data.status}`,
        inspection: data.response,
      };
    await delay(400);
  }

  const panel = await runAction("section-panel");
  if (!["clicked", "already_active"].includes(panel.status))
    return {
      ok: false,
      status: `panel_${panel.status}`,
      inspection: panel.response,
    };

  // Wait for the panel to finish expanding without re-clicking the toggle.
  for (let i = 0; i < 16; i++) {
    snapshot = await read();
    const entry = current(snapshot)?.section?.navigation?.find(
      (nav) => nav.id === sectionId,
    );
    if (entry?.panelExpanded) break;
    await delay(300);
  }

  const tab = await runAction("section-tab");
  if (!["clicked", "already_active"].includes(tab.status))
    return { ok: false, status: `tab_${tab.status}`, inspection: tab.response };

  // Require the section to actually be the active one, twice, before trusting
  // it. A slow Angular swap can briefly report the previous grid.
  let stable = 0;
  for (let i = 0; i < 24; i++) {
    snapshot = await read();
    const metadata = current(snapshot)?.section;
    if (
      metadata?.id === sectionId &&
      !metadata.busy &&
      metadata.structurePresent
    ) {
      stable += 1;
      if (stable >= 2)
        return { ok: true, status: "switched", inspection: snapshot };
    } else {
      stable = 0;
    }
    await delay(300);
  }
  return { ok: false, status: "section_not_settled", inspection: snapshot };
}

function isAuthenticated(inspection) {
  const frames = inspection?.frames || [];
  return (
    !frames.some(
      (frame) => frame.loginVisible || frame.readiness?.explicitSessionExpired,
    ) && frames.some((frame) => frame.authenticated)
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inspectNavigation(
  windowInstance,
  {
    taxYear,
    hosts = DEFAULT_HOSTS,
    onStep = () => {},
    openReturn = false,
    taxpayerIdentifier = "",
    newReturnContext = {},
    state = {},
    inspectSections = false,
    sectionIds = null,
    beforeStep = async () => {},
    onSectionCaptured = async () => {},
  } = {},
) {
  const options = { taxYear, openReturn, taxpayerIdentifier };
  const normalizedResidencyStatus = /non\s*-?resident/i.test(
    String(newReturnContext?.residencyStatus || ""),
  )
    ? "Non-Resident"
    : /resident/i.test(String(newReturnContext?.residencyStatus || ""))
      ? "Resident"
      : null;
  const expectedPeriod = getExpectedOriginalTaxPeriod(taxYear);
  const setupContext = {
    routeFamily: newReturnContext?.routeFamily || null,
    filingIntent:
      String(newReturnContext?.filingIntent || "original")
        .trim()
        .toLowerCase() || "original",
    residencyStatus: normalizedResidencyStatus,
    expectedPeriod,
  };
  const tourPlan =
    sectionIds === null
      ? SECTION_TOUR
      : sectionIds.map((id) =>
          ALL_SECTION_TOUR.find((section) => section.id === id),
        );
  if (
    !tourPlan.length ||
    tourPlan[0]?.id !== "salary" ||
    tourPlan.some((section) => !section) ||
    new Set(tourPlan.map((section) => section.id)).size !== tourPlan.length
  ) {
    throw new Error("Unsupported or ambiguous section inspection plan.");
  }
  const read = async () => {
    await beforeStep();
    return probeFrames(windowInstance, options, hosts);
  };
  const act = async (action, extra = {}) => {
    // Retry only a result which guarantees no click was dispatched. Never
    // repeat a click after success, an unknown execution outcome or a guard.
    const deadline = Date.now() + 4000;
    let pinned = { ...extra };
    let response;
    for (let attempt = 1; attempt <= 10; attempt++) {
      await beforeStep(); // backend cancellation + target checks on EVERY retry
      response = await probeFrames(
        windowInstance,
        { ...options, ...pinned, action },
        hosts,
      );
      const results = response.frames
        .map((frame) => frame.actionResult)
        .filter(Boolean);
      if (
        results.some((result) =>
          ["clicked", "already_active", "hovered"].includes(result.status),
        )
      )
        return response;
      const retryable =
        results.length > 0 &&
        results.every((result) =>
          ["not_interactable", "page_busy"].includes(result.status),
        );
      const detail =
        results.find((result) => result.interaction || result.gridTarget) ||
        results[0];
      if (retryable && detail) {
        const entry = {
          action,
          attempt,
          status: detail.status,
          gridTarget: detail.gridTarget || null,
          interaction: detail.interaction || null,
        };
        state.interactionDiagnostics = [
          ...(state.interactionDiagnostics || []),
          entry,
        ].slice(-6);
        if (action === "section-grid-expand" && detail.gridTarget)
          pinned.gridTarget = detail.gridTarget;
        onStep(
          "interaction_wait",
          `${action}${detail.gridTarget?.title ? " / " + detail.gridTarget.title : ""}: ${detail.interaction?.reason || detail.status}; no click dispatched (attempt ${attempt}/10).`,
        );
      }
      if (!retryable || attempt === 10 || Date.now() >= deadline) {
        if (detail?.interaction)
          onStep(
            "interaction_diagnostics",
            JSON.stringify(state.interactionDiagnostics?.slice(-1) || []),
          );
        return response;
      }
      await delay(300);
    }
    return response;
  };
  const requiresLogin = (snapshot) =>
    snapshot.frames.some(
      (frame) => frame.loginVisible || frame.readiness?.explicitSessionExpired,
    );
  const logReadiness = (snapshot) => {
    const states = snapshot.frames.map((frame) =>
      frame.readiness
        ? {
            ...frame.readiness,
            identityConfigured: Boolean(frame.identityConfigured),
            matchingDraftCount: (frame.rows || []).filter(
              (row) =>
                row.identityStatus === "match" &&
                row.periodMatch &&
                row.taxYear === Number(taxYear),
            ).length,
          }
        : {
            unavailable: frame.unavailable || frame.skipped || "unknown_frame",
          },
    );
    onStep("readiness_evidence", JSON.stringify(states));
  };
  const waitForDocument = async () => {
    for (let i = 0; i < 24; i++) {
      const result = await read();
      if (
        result.frames.some(
          (f) => f.document?.present || f.hasBlockingOverlay || f.loginVisible,
        )
      )
        return result;
      await delay(500);
    }
    return read();
  };
  const publicTour = () =>
    state.sectionTour
      ? {
          complete: state.sectionTour.complete === true,
          currentSection: tourPlan[state.sectionTour.cursor]?.id || null,
          sections: state.sectionTour.sections,
        }
      : null;
  const attachTour = (snapshot) => ({
    ...snapshot,
    ...(publicTour() ? { sectionTour: publicTour() } : {}),
    ...(state.interactionDiagnostics?.length
      ? { interactionDiagnostics: state.interactionDiagnostics }
      : {}),
  });
  const frameIssue = (snapshot) => {
    if (requiresLogin(snapshot)) return "session_reconnect";
    if (
      snapshot.frames.some(
        (frame) =>
          frame.hasBlockingOverlay || frame.section?.sensitiveInputVisible,
      )
    )
      return "portal_popup";
    const frame = snapshot.frames.find((f) => f.document?.present);
    if (!frame) return "portal_navigation";
    if (
      frame.document.titleDetected === false ||
      frame.document.taxYear === null
    )
      return "portal_readiness_unverified";
    if (
      !frame.document.originalFullYear ||
      frame.document.taxYear !== Number(taxYear)
    )
      return "portal_document_mismatch";
    if (frame.document.identityStatus !== "match")
      return "portal_taxpayer_mismatch";
    return null;
  };
  const ensureDataTab = async (snapshot) => {
    const current = snapshot.frames.find((frame) => frame.document?.present);
    if (current?.section?.dataViewActive !== false)
      return { snapshot, issue: null };
    const result = await act("data-tab");
    const status = result.frames.find((frame) => frame.document?.present)
      ?.actionResult?.status;
    if (!["clicked", "already_active"].includes(status))
      return { snapshot: result, issue: "portal_section_navigation" };
    for (let i = 0; i < 16; i++) {
      await delay(300);
      snapshot = await read();
      const issue = frameIssue(snapshot);
      if (issue) return { snapshot, issue };
      if (snapshot.frames.some((frame) => frame.section?.dataViewActive))
        return { snapshot, issue: null };
    }
    return { snapshot, issue: "portal_section_navigation" };
  };
  const captureSection = async (profile, snapshot, transition) => {
    const frame = snapshot.frames.find((f) => f.document?.present);
    const metadata = frame?.section || {};
    const record = {
      id: profile.id,
      group: profile.group,
      tab: profile.tab,
      capturedAt: new Date().toISOString(),
      status: metadata.explicitEmpty ? "empty" : "captured",
      transition,
      columns: metadata.columns || [],
      grids: metadata.grids || [],
      tables: metadata.tables || [],
      rows: metadata.rows || [],
      panels: metadata.panels || [],
      attachmentSlots: metadata.attachmentSlots || [],
      headerBindingErrors: metadata.headerBindingErrors || 0,
      unknownCodeCount: metadata.unknownCodeCount || 0,
      unknownColumnCount: metadata.unknownColumnCount || 0,
      unverifiedControlCount: metadata.unverifiedControlCount || 0,
      mappingVerified:
        profile.id === "salary" && frame?.salary?.verified === true,
    };
    state.sectionTour.sections = [
      ...state.sectionTour.sections.filter((entry) => entry.id !== profile.id),
      record,
    ];
    onStep(
      "section_captured",
      `${profile.tab}: ${record.grids.length} grid(s), ${record.rows.length} field row(s), ${record.panels.length} panel(s), ${record.attachmentSlots.length} attachment slot(s) captured. No values read or entered.`,
    );
    await onSectionCaptured(attachTour(snapshot), record);
  };
  const runSectionTour = async (initial) => {
    let snapshot = initial;
    if (!state.sectionTour || state.sectionTour.complete) {
      state.sectionTour = {
        cursor: 1,
        sections: [],
        complete: false,
        pending: null,
      };
      await captureSection(tourPlan[0], snapshot, "salary_verified");
    }
    while (state.sectionTour.cursor < tourPlan.length) {
      const profile = tourPlan[state.sectionTour.cursor];
      onStep(
        "section_navigation",
        `Opening ${profile.group} → ${profile.tab}.`,
      );
      snapshot = await read();
      let issue = frameIssue(snapshot);
      if (issue)
        return { inspection: attachTour(snapshot), requiredAction: issue };
      if (profile.group !== "Top tabs") {
        const dataTab = await ensureDataTab(snapshot);
        snapshot = dataTab.snapshot;
        if (dataTab.issue)
          return {
            inspection: attachTour(snapshot),
            requiredAction: dataTab.issue,
          };
      }
      let frame = snapshot.frames.find((f) => f.document?.present);
      for (let i = 0; i < 16 && frame.section?.busy; i++) {
        await delay(300);
        snapshot = await read();
        issue = frameIssue(snapshot);
        if (issue)
          return { inspection: attachTour(snapshot), requiredAction: issue };
        frame = snapshot.frames.find((f) => f.document?.present);
      }
      if (frame.section?.busy)
        return {
          inspection: attachTour(snapshot),
          requiredAction: "portal_section_capture",
        };
      if (
        !state.sectionTour.pending ||
        state.sectionTour.pending.id !== profile.id
      ) {
        state.sectionTour.pending = {
          id: profile.id,
          fromKey: frame.section?.structureKey || null,
          needsChange: frame.section?.id !== profile.id,
        };
      }
      const pending = state.sectionTour.pending;
      let lastAction = null;
      const action = async (name) => {
        const response = await act(name, { sectionId: profile.id });
        lastAction =
          response.frames.find((f) => f.document?.present)?.actionResult ||
          null;
        return lastAction?.status || "not_found";
      };
      let status = await action("section-panel");
      if (!["clicked", "already_active"].includes(status)) {
        onStep("section_pause", `${profile.tab}: section panel ${status}.`);
        return {
          inspection: attachTour(await read()),
          requiredAction: "portal_section_navigation",
        };
      }
      // Wait for expansion without clicking the toggle repeatedly.
      let expanded = false;
      for (let i = 0; i < 16; i++) {
        snapshot = await read();
        issue = frameIssue(snapshot);
        if (issue)
          return { inspection: attachTour(snapshot), requiredAction: issue };
        frame = snapshot.frames.find((f) => f.document?.present);
        if (
          frame.section?.navigation?.find((entry) => entry.id === profile.id)
            ?.panelExpanded
        ) {
          expanded = true;
          break;
        }
        await delay(300);
      }
      if (!expanded)
        return {
          inspection: attachTour(snapshot),
          requiredAction: "portal_section_navigation",
        };
      status = await action("section-tab");
      if (!["clicked", "already_active"].includes(status)) {
        onStep("section_pause", `${profile.tab}: section tab ${status}.`);
        return {
          inspection: attachTour(await read()),
          requiredAction: "portal_section_navigation",
        };
      }
      // Require the selected tab, a loaded structure/explicit empty state and
      // TWO stable observations. Changing only the active button is not enough.
      let stableKey = null;
      let stableCount = 0;
      let loaded = false;
      for (let i = 0; i < 24; i++) {
        snapshot = await read();
        issue = frameIssue(snapshot);
        if (issue)
          return { inspection: attachTour(snapshot), requiredAction: issue };
        frame = snapshot.frames.find((f) => f.document?.present);
        const metadata = frame.section;
        // A successful dispatch must be acknowledged before choosing another
        // collapsed header. Otherwise a slow animation can get clicked twice
        // and toggle closed again. The marker survives a paused Retry.
        if (pending.gridExpansion) {
          const target = pending.gridExpansion;
          let acknowledged = false;
          for (let wait = 0; wait < 12; wait++) {
            snapshot = await read();
            issue = frameIssue(snapshot);
            if (issue)
              return {
                inspection: attachTour(snapshot),
                requiredAction: issue,
              };
            const current = snapshot.frames.find(
              (f) => f.document?.present,
            )?.section;
            const panel = current?.fieldGridPanels?.find(
              (panel) =>
                panel.index === target.index && panel.title === target.title,
            );
            if (current?.id === profile.id && panel?.expanded) {
              acknowledged = true;
              break;
            }
            await delay(250);
          }
          if (!acknowledged) {
            const pauseMessage = `${profile.tab} / ${target.title}: the click was sent but expansion was not confirmed. No repeated toggle was sent. Open this header locally, then Retry.`;
            onStep("section_pause", pauseMessage);
            return {
              inspection: attachTour(snapshot),
              requiredAction: "portal_section_capture",
              pauseMessage,
            };
          }
          onStep(
            "grid_expansion_confirmed",
            `${profile.tab} / ${target.title}: expanded.`,
          );
          pending.gridExpansion = null;
          stableCount = 0;
          stableKey = null;
          continue;
        }
        if (
          metadata?.id === profile.id &&
          metadata.collapsedGridCount > 0 &&
          !metadata.busy
        ) {
          const expanded = await action("section-grid-expand");
          if (!["clicked", "already_active"].includes(expanded)) {
            const pauseMessage = `${profile.tab}${lastAction?.gridTarget?.title ? " / " + lastAction.gridTarget.title : ""}: the header could not be safely expanded (${expanded}) after the bounded interaction check. No click-through or forced expansion was used. Export the interaction diagnostics for review.`;
            onStep("section_pause", pauseMessage);
            return {
              inspection: attachTour(await read()),
              requiredAction: "portal_section_capture",
              pauseMessage,
            };
          }
          if (expanded === "clicked" && lastAction?.gridTarget)
            pending.gridExpansion = lastAction.gridTarget;
          stableCount = 0;
          stableKey = null;
          await delay(250);
          continue;
        }
        const changed =
          !pending.needsChange || metadata?.structureKey !== pending.fromKey;
        const ready =
          metadata?.id === profile.id &&
          !metadata.busy &&
          !metadata.ambiguousSelection &&
          (metadata.structurePresent || metadata.explicitEmpty) &&
          changed;
        if (ready) {
          stableCount =
            stableKey === metadata.structureKey ? stableCount + 1 : 1;
          stableKey = metadata.structureKey;
          if (stableCount >= 2) {
            loaded = true;
            break;
          }
        } else {
          stableCount = 0;
          stableKey = null;
        }
        await delay(350);
      }
      if (!loaded) {
        onStep(
          "section_pause",
          `${profile.tab}: the new field structure did not settle. Previous section data was not recorded as this section.`,
        );
        return {
          inspection: attachTour(snapshot),
          requiredAction: "portal_section_capture",
        };
      }
      await captureSection(
        profile,
        snapshot,
        pending.needsChange ? "structure_changed" : "already_active",
      );
      state.sectionTour.cursor++;
      state.sectionTour.pending = null;
    }
    state.sectionTour.complete = true;
    onStep(
      "section_tour_complete",
      `${tourPlan.length} requested views were inspected, including their visible grids/panels. Filling, uploads, payments, Save and Submit remain disabled.`,
    );
    await onSectionCaptured(attachTour(snapshot), null);
    return {
      inspection: attachTour(snapshot),
      requiredAction: "portal_sections_inspected",
    };
  };

  const verifyDocument = async (snapshot) => {
    const frame = snapshot.frames.find((f) => f.document?.present);
    if (!frame)
      return { inspection: snapshot, requiredAction: "portal_navigation" };
    if (
      frame.document.titleDetected === false ||
      frame.document.taxYear === null
    )
      return {
        inspection: snapshot,
        requiredAction: "portal_readiness_unverified",
      };
    if (
      !frame.document.originalFullYear ||
      frame.document.taxYear !== Number(taxYear)
    )
      return {
        inspection: snapshot,
        requiredAction: "portal_document_mismatch",
      };
    if (frame.document.identityStatus !== "match")
      return {
        inspection: snapshot,
        requiredAction: "portal_taxpayer_mismatch",
      };
    state.newEntryOpened = false;
    onStep(
      "document_verified",
      `Original 114(1) return, TY${taxYear}, and the locally entered taxpayer identifier match.`,
    );
    if (inspectSections && state.sectionTour && !state.sectionTour.complete)
      return runSectionTour(snapshot);
    const dataTab = await ensureDataTab(snapshot);
    snapshot = dataTab.snapshot;
    if (dataTab.issue)
      return { inspection: snapshot, requiredAction: dataTab.issue };
    for (const action of ["expand-employment", "salary-tab"]) {
      const result = await act(action);
      const status = result.frames.find((f) => f.document?.present)
        ?.actionResult?.status;
      onStep(action.replace(/-/g, "_"), `${action}: ${status || "not_found"}.`);
      if (!["clicked", "already_active"].includes(status))
        return {
          inspection: await read(),
          requiredAction: "portal_fields_unverified",
        };
      await delay(700);
    }
    let result;
    for (let i = 0; i < 16; i++) {
      result = await read();
      if (
        result.frames.some(
          (f) => f.salary?.verified || f.hasBlockingOverlay || f.loginVisible,
        )
      )
        break;
      await delay(400);
    }
    const verified = result.frames.some(
      (f) =>
        !f.hasBlockingOverlay &&
        !f.loginVisible &&
        f.salary?.verified &&
        f.document?.originalFullYear &&
        f.document?.identityStatus === "match" &&
        f.document?.taxYear === Number(taxYear),
    );
    onStep(
      "salary_structure",
      verified
        ? "Salary columns and editable/calculated cells verified. No amounts entered; Save/Submit untouched."
        : "Salary field structure needs inspection. No values were entered.",
    );
    if (verified && inspectSections) return runSectionTour(result);
    return {
      inspection: result,
      requiredAction: verified
        ? "portal_fields_verified"
        : "portal_fields_unverified",
    };
  };
  const getActionStatus = (response, action) =>
    response.frames.find(
      (frame) =>
        frame.actionResult?.action === action &&
        frame.actionResult?.status !== "read_only",
    )?.actionResult?.status || "not_found";
  const describeSetupSnapshot = (snapshot) => {
    const candidates = snapshot.frames
      .filter(
        (frame) =>
          frame.authenticated &&
          // Phase 1.5a: a frame whose only dialog IS the setup dialog is the
          // frame we must classify. Excluding it made the stage undiscoverable.
          (!frame.hasBlockingOverlay || frame.setupDialogOnly) &&
          !frame.document?.present,
      )
      .map((frame) => {
        const nodeLabels = (frame.nodes || [])
          .map((node) => node.label)
          .filter(Boolean);
        const descriptor = {
          documentPresent: frame.document?.present,
          prompts: frame.newReturnSetup?.prompts || [],
          actions: frame.newReturnSetup?.actions || [],
          nodeLabels,
        };
        return {
          frame,
          nodeLabels,
          descriptor,
          stage: classifyNewReturnSetupStage(descriptor),
        };
      })
      .filter(
        (entry) =>
          entry.frame.newReturnSetup ||
          isRecognizedNewReturnSetup(entry.descriptor),
      );
    const recognized = candidates.filter((entry) => entry.stage);
    return {
      candidates,
      recognized,
      current:
        recognized.length === 1
          ? recognized[0]
          : recognized.length === 0 && candidates.length === 1
            ? candidates[0]
            : null,
      ambiguous: recognized.length > 1 || candidates.length > 1,
    };
  };
  const advanceNewReturnSetup = async (initialSnapshot) => {
    let snapshot = initialSnapshot;
    for (let attempt = 1; attempt <= 8; attempt++) {
      snapshot = snapshot || (await read());
      if (requiresLogin(snapshot))
        return { inspection: snapshot, requiredAction: "session_reconnect" };
      if (
        snapshot.frames.some(
          (frame) => frame.hasBlockingOverlay && !frame.setupDialogOnly,
        )
      )
        return { inspection: snapshot, requiredAction: "portal_popup" };
      if (!isAuthenticated(snapshot))
        return {
          inspection: snapshot,
          requiredAction: "portal_readiness_unverified",
        };
      if (snapshot.frames.some((frame) => frame.document?.present))
        return verifyDocument(snapshot);
      const setup = describeSetupSnapshot(snapshot);
      if (setup.ambiguous)
        return { inspection: snapshot, requiredAction: "portal_navigation" };
      if (!setup.current) {
        onStep(
          "new_return_setup_wait",
          "TY2026+ new-return setup did not stabilize on the authenticated frame.",
        );
        return {
          inspection: snapshot,
          requiredAction: "portal_new_return_setup",
        };
      }
      const stage = setup.current.stage;
      const labels = [
        ...(setup.current.descriptor.prompts || []),
        ...(setup.current.descriptor.actions || []),
      ].join(", ");
      onStep(
        "new_return_setup_stage",
        `TY${taxYear} setup stage ${stage || "unclassified"}${labels ? ` (${labels})` : ""}.`,
      );
      if (!stage)
        return {
          inspection: snapshot,
          requiredAction: "portal_new_return_setup",
        };
      if (stage === "residency") {
        if (!setupContext.residencyStatus) {
          onStep(
            "new_return_setup_pause",
            "Residency choice is visible, but the approved packet/context does not yet provide Resident vs Non-Resident for safe auto-clicking.",
          );
          return {
            inspection: snapshot,
            requiredAction: "portal_new_return_setup",
          };
        }
        const result = await act("new-return-residency", {
          residencyStatus: setupContext.residencyStatus,
        });
        const status = getActionStatus(result, "new-return-residency");
        onStep(
          "new_return_setup_action",
          `residency (${setupContext.residencyStatus}): ${status}.`,
        );
        if (!["clicked", "already_active"].includes(status))
          return {
            inspection: result,
            requiredAction: "portal_new_return_setup",
          };
        state.newEntryOpened = true;
        await delay(900);
        snapshot = null;
        continue;
      }
      if (!isSafeAutoAdvanceNewReturnStage(stage))
        return {
          inspection: snapshot,
          requiredAction: "portal_new_return_setup",
        };
      if (stage === "return_type" && setupContext.filingIntent !== "original") {
        onStep(
          "new_return_setup_pause",
          `Unsupported filing intent for the TY2026+ wizard: ${setupContext.filingIntent || "unknown"}.`,
        );
        return {
          inspection: snapshot,
          requiredAction: "portal_new_return_setup",
        };
      }
      if (stage === "period" && setupContext.expectedPeriod) {
        onStep(
          "new_return_setup_context",
          `Proceeding only for the original full-year period ${setupContext.expectedPeriod.startLabel} to ${setupContext.expectedPeriod.endLabel}.`,
        );
      }
      const action =
        stage === "menu" || stage === "return_type"
          ? "new-return-form"
          : "new-return-continue";
      const result = await act(action);
      const status = getActionStatus(result, action);
      onStep("new_return_setup_action", `${stage}: ${action} ${status}.`);
      if (!["clicked", "already_active"].includes(status))
        return {
          inspection: result,
          requiredAction: "portal_new_return_setup",
        };
      state.newEntryOpened = true;
      await delay(stage === "accept_continue" ? 1200 : 900);
      snapshot = null;
    }
    const finalSnapshot = await read();
    return {
      inspection: finalSnapshot,
      requiredAction: "portal_new_return_setup",
    };
  };
  let inspection = await read();
  onStep("readiness_check", "Checking the official IRIS screen.");
  if (requiresLogin(inspection)) {
    logReadiness(inspection);
    return { inspection, requiredAction: "session_reconnect" };
  }

  // Bounded retries, never an in-page timer, Escape key, CSS hiding or removal.
  // A setup-only dialog is deliberately NOT retried here: close-welcome cannot
  // dismiss it and never could, which is what made "Retry navigation check"
  // loop forever. It is handled as a stage further down instead.
  for (let i = 0; i < 4; i++) {
    const blocked = inspection.frames.some(
      (frame) => frame.hasBlockingOverlay && !frame.setupDialogOnly,
    );
    if (!blocked) break;
    await act("close-welcome");
    await delay(500);
    inspection = await read();
  }
  if (
    inspection.frames.some(
      (frame) => frame.hasBlockingOverlay && !frame.setupDialogOnly,
    )
  ) {
    onStep(
      "portal_popup",
      "A dialog/backdrop remains. No navigation behind it was attempted.",
    );
    return { inspection, requiredAction: "portal_popup" };
  }
  onStep(
    "welcome_popup_check",
    "No blocking dialog detected. No protected dialogs were dismissed.",
  );
  // Give Angular a bounded render window. An unavailable/incomplete frame is
  // not the same as a visible login prompt and must not be reported as logout.
  for (
    let i = 0;
    i < 10 && !isAuthenticated(inspection) && !requiresLogin(inspection);
    i++
  ) {
    await delay(400);
    inspection = await read();
    if (
      inspection.frames.some(
        (frame) => frame.hasBlockingOverlay && !frame.setupDialogOnly,
      )
    )
      break;
  }
  logReadiness(inspection);
  if (requiresLogin(inspection))
    return { inspection, requiredAction: "session_reconnect" };
  if (
    inspection.frames.some(
      (frame) => frame.hasBlockingOverlay && !frame.setupDialogOnly,
    )
  )
    return { inspection, requiredAction: "portal_popup" };
  if (!isAuthenticated(inspection))
    return { inspection, requiredAction: "portal_readiness_unverified" };

  // Phase 1.5b. The pre-filing gate reached from the blue dashboard tile. It
  // is read-only to the agent: the taxpayer's income sources and residency are
  // legal determinations, so we report exactly what is outstanding and stop.
  const gateFrame = inspection.frames.find(
    (frame) => frame.economicTransactionsGate?.present,
  );
  if (gateFrame) {
    const gate = describeEconomicTransactionsGate(
      gateFrame.economicTransactionsGate,
    );
    if (!gate.ready) {
      onStep(
        "economic_transactions_gate",
        `IRIS is asking for ${gate.missing.join(" and ")} before "Start Return Filling" is enabled. The agent does not answer this screen.`,
      );
      return {
        inspection,
        requiredAction: "portal_economic_transactions_gate",
        economicTransactionsGate: gate,
      };
    }
    onStep(
      "economic_transactions_gate",
      `Income sources (${gate.selectedSources.join(", ") || "none listed"}) and residency are answered; "Start Return Filling" is enabled. Click it locally to continue, then Retry.`,
    );
    return {
      inspection,
      requiredAction: "portal_economic_transactions_gate",
      economicTransactionsGate: gate,
    };
  }

  if (openReturn && !inspection.frames.some((f) => f.identityConfigured))
    return { inspection, requiredAction: "portal_identity_required" };
  if (openReturn && inspection.frames.some((f) => f.document?.present))
    return verifyDocument(inspection);
  if (
    openReturn &&
    (state.newEntryOpened ||
      inspection.frames.some((frame) => frame.setupDialogOnly))
  )
    return advanceNewReturnSetup(inspection);

  for (const action of ["draft-tab", "it-declaration-tab"]) {
    // Angular may render the next control after the click has returned.
    let status = "not_found";
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await act(action);
      const matching = response.frames.find((frame) =>
        ["clicked", "already_active"].includes(frame.actionResult?.status),
      );
      status =
        matching?.actionResult.status ||
        response.frames.find((frame) => frame.authenticated)?.actionResult
          ?.status ||
        "not_found";
      if (["clicked", "already_active"].includes(status)) break;
      if (
        [
          "blocked_by_dialog",
          "ambiguous",
          "not_interactable",
          "login_required",
        ].includes(status)
      )
        break;
      await delay(350);
    }
    onStep(action.replace(/-/g, "_"), `${action}: ${status}.`);
    if (!["clicked", "already_active"].includes(status)) {
      inspection = await read();
      // An explicitly empty Draft grid may omit the IT Declaration tab.
      // Absence of the tab alone is never evidence that no draft exists.
      if (
        openReturn &&
        action === "it-declaration-tab" &&
        inspection.frames.some(
          (f) =>
            f.grid?.complete && f.grid.pageTotal === 0 && f.grid.rowCount === 0,
        )
      ) {
        onStep(
          "empty_draft_grid",
          "The Draft paginator explicitly reports zero records.",
        );
        continue;
      }
      return {
        inspection,
        requiredAction: inspection.frames.some(
          (frame) => frame.hasBlockingOverlay,
        )
          ? "portal_popup"
          : "portal_inspection",
      };
    }
    await delay(500);
  }
  // Wait a bounded interval for the document grid, not a guessed input count.
  for (let i = 0; i < 8; i++) {
    inspection = await read();
    if (inspection.frames.some((frame) => frame.rows?.length)) break;
    await delay(400);
  }
  onStep("draft_inventory", "Draft form codes and period candidates captured.");
  if (!openReturn) return { inspection, requiredAction: "portal_inspection" };
  const response = await act("open-matching-draft");
  const statuses = response.frames.map((f) => f.actionResult?.status);
  if (statuses.includes("clicked")) {
    onStep(
      "existing_draft_open",
      `Opened the matching taxpayer / 114(1) / TY${taxYear} draft using its pencil action.`,
    );
    return verifyDocument(await waitForDocument());
  }
  if (statuses.includes("identity_mismatch"))
    return { inspection: response, requiredAction: "portal_taxpayer_mismatch" };
  if (statuses.includes("ambiguous"))
    return { inspection: response, requiredAction: "portal_draft_ambiguous" };
  if (statuses.includes("row_unverified"))
    return { inspection: response, requiredAction: "portal_document_mismatch" };
  if (statuses.includes("grid_incomplete"))
    return {
      inspection: response,
      requiredAction: "portal_draft_list_incomplete",
    };
  if (!statuses.includes("no_matching_draft"))
    return { inspection: response, requiredAction: "portal_navigation" };

  onStep(
    "no_matching_draft",
    "No matching draft found in the complete displayed IT Declaration list. Starting the guarded TY2026+ original return setup flow.",
  );
  await act("declaration-hover");
  await delay(300);
  let opened = await act("new-return-category");
  if (!opened.frames.some((f) => f.actionResult?.status === "clicked")) {
    opened = await act("declaration-menu");
    if (!opened.frames.some((f) => f.actionResult?.status === "clicked"))
      return { inspection: opened, requiredAction: "portal_navigation" };
    await delay(700);
    opened = await act("new-return-category");
  }
  for (let i = 0; i < 10; i++) {
    if (opened.frames.some((f) => f.actionResult?.status === "clicked")) {
      state.newEntryOpened = true;
      onStep(
        "new_return_menu",
        "Declaration → Return Statements (Original for TY 2026 and onwards) opened. Continuing the guarded TY2026+ original setup flow.",
      );
      await delay(800);
      return advanceNewReturnSetup(await read());
    }
    if (
      opened.frames.some((f) =>
        ["ambiguous", "blocked_by_dialog"].includes(f.actionResult?.status),
      )
    )
      break;
    await delay(350);
    opened = await act("new-return-category");
  }
  return { inspection: await read(), requiredAction: "portal_navigation" };
}


/**
 * "Selector drift" has to be an evidenced conclusion, not a string match.
 *
 * The captured section tour is the only ground truth the agent has: it says which
 * panels were found and how many rows each rendered. Drift means rows that MUST be
 * there are missing. `structure_changed` (the tour could not bind headers to rows)
 * is a different failure — the DOM is present, our packet's claim about it is not
 * verified — and telling an operator to rewrite selectors for that wastes a real
 * filing window.
 */
function buildPortalEvidenceDiagnostics(sectionTour, rowBearingIds) {
  const rowBearing = rowBearingIds || ROW_BEARING_SECTION_IDS;
  const sections = Array.isArray(sectionTour && sectionTour.sections)
    ? sectionTour.sections
    : [];
  if (!sections.length) {
    return { state: "no_evidence", sections: [], drifted: [], unverified: [] };
  }

  const summary = sections.map((section) => ({
    id: section && section.id != null ? section.id : null,
    status: (section && section.status) || null,
    transition: (section && section.transition) || null,
    rowCount: Array.isArray(section && section.rows) ? section.rows.length : 0,
    gridCount: Array.isArray(section && section.grids) ? section.grids.length : 0,
    mappingVerified: Boolean(section && section.mappingVerified),
  }));

  const drifted = summary.filter(
    (section) =>
      rowBearing.includes(section.id) &&
      section.rowCount === 0 &&
      section.status === "captured",
  );
  const unverified = summary.filter(
    (section) =>
      section.rowCount > 0 &&
      section.mappingVerified === false &&
      String(section.transition || "").includes("structure_changed"),
  );

  return {
    state: drifted.length
      ? "rows_missing"
      : unverified.length
        ? "structure_unverified"
        : "structure_present",
    sections: summary,
    drifted: drifted.map((section) => section.id),
    unverified: unverified.map((section) => section.id),
  };
}

/**
 * The one predicate that says "this page IS the return workspace", as an in-page script.
 *
 * `countVisibleInputs() > 0` is NOT readiness: the Summary-of-Economic-Transactions
 * gate renders ten visible inputs, so an agent waiting on that signal happily reports
 * a form that was never opened. This is the same evidence `classifyPage` uses for
 * `readiness.returnWorkspace`, exported so the autofill runner and the dashboard
 * flow cannot drift into disagreeing about what "ready" means.
 */
const RETURN_WORKSPACE_PROBE = `(() => {
  const clip = (t) => String(t == null ? '' : t).replace(/\\s+/g, ' ').trim();
  // textContent, NOT innerText: innerText is undefined outside a browser and
  // silently turns every label match into a false negative.
  const labelled = (el) => clip(el && (el.innerText || el.textContent));
  // Only explicit DOM markers count as hidden. A zero-width box is a stylesheet
  // that failed to load, not evidence that the return is closed.
  const isHidden = (el) => {
    if (!el) return true;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
    const panel = el.closest('mat-expansion-panel');
    const header = panel && panel.querySelector(':scope > mat-expansion-panel-header');
    if (header && !header.classList.contains('mat-expanded') &&
        header.getAttribute('aria-expanded') !== 'true') return true;
    try {
      const s = (typeof getComputedStyle === 'function' ? getComputedStyle(el) : null);
      if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
    } catch (e) {}
    return false;
  };
  const visible = (list) => {
    const shown = list.filter((el) => !isHidden(el));
    return shown.length ? shown : list;
  };
  const countInputs = (root) => (root ? root.querySelectorAll('input:not([type="hidden"])') : []).length;
  const workflow = visible(Array.from(document.querySelectorAll('app-nitr-workflow')))[0];
  if (!workflow) {
    return { returnWorkspace: false, reason: 'app-nitr-workflow-absent', inputs: countInputs(document) };
  }
  const header = workflow.querySelector('app-wf-header');
  if (!header) {
    return { returnWorkspace: false, reason: 'app-wf-header-absent', inputs: countInputs(workflow) };
  }
  const year = visible(Array.from(header.querySelectorAll('h6')))
    .some((el) => /^Year\\s+20\\d{2}$/i.test(labelled(el)));
  const returnDocument = visible(Array.from(header.querySelectorAll('p,span')))
    .some((el) => {
      const label = labelled(el);
      return label.length < 220 && /\\b(?:114|116)\\s*\\(\\s*\\d+\\s*\\)/i.test(label);
    });
  const registration = visible(Array.from(header.querySelectorAll('p')))
    .some((el) => /^Registration\\s*(?:No|Number)\\s*:/i.test(labelled(el)));
  return {
    returnWorkspace: Boolean(year && returnDocument && registration),
    evidence: { year, returnDocument, registration },
    reason: year && returnDocument && registration ? null : 'workflow-header-incomplete',
    inputs: countInputs(workflow),
  };
})()`;


module.exports = {
  BUILD_TAG,
  DEFAULT_HOSTS,
  SECTION_TOUR,
  ALL_SECTION_TOUR,
  ALL_SECTION_IDS,
  WEALTH_SECTION_IDS,
  INCOME_SECTION_IDS,
  normalizeSetupLabel,
  getExpectedOriginalTaxPeriod,
  classifyNewReturnSetupStage,
  isRecognizedNewReturnSetup,
  isSafeAutoAdvanceNewReturnStage,
  isManualNewReturnStage,
  describeEconomicTransactionsGate,
  buildSectionCodeIndex,
  planSectionFills,
  isAllowedPortalUrl,
  portalProbe,
  probeFrames,
  navigateToSection,
  isAuthenticated,
  inspectNavigation,
  ROW_BEARING_SECTION_IDS,
  buildPortalEvidenceDiagnostics,
  RETURN_WORKSPACE_PROBE,
};
