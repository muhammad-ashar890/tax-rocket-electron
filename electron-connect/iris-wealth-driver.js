"use strict";

/**
 * Wealth Statement driver (Stage 2).
 *
 * The Salary rows already exist in the IRIS grid, so the row filler can just
 * type into them. The Wealth Statement rows do NOT: each one is created through
 * a modal first —
 *
 *   Reconciliation of Net Assets
 *     `+ Expenses`  (row 7089)  -> "Add Personal Expenses" -> tick categories -> ADD
 *     `+` icon on "Adjustments in Outflows" (row 7098)
 *                               -> description -> SAVE        (a modal-local SAVE)
 *   Personal Assets / Liabilities
 *     `+ Assets`    (row 999901) -> "Add Financial Assets & Investments" -> tick
 *                                   "Bank Account(s)" -> ADD   (creates summary row 7030)
 *     `+` icon on "Bank Account(s)" (row 7030)
 *                               -> "Bank Account" modal -> IBAN -> search -> ADD
 *
 * Evidence for every selector below is the 2026-10-01 capture set in
 * ~/uploads ("expense modal", "Adjustments in Outflows modal", "Bank Account(s)
 * modal", "Add Financial Assets & Investments modal", "7098 added", "bank
 * account field visible"). Fixtures cut from them live in test-fixtures/iris/.
 *
 * HARD LIMITS (the README rules still stand):
 *   - The page-side operations can click ONLY: the two `+ Expenses` / `+ Assets`
 *     section buttons, the purple "add" icon of rows 7098 and 7030, a category
 *     or "Bank Account(s)" checkbox inside the matching modal, and that modal's
 *     ADD / SAVE / CLOSE / Cancel button. Never the red delete icon, the orange
 *     edit icon, a `btn-section-delete` button, or the return's Save / Submit /
 *     Calculate controls — they are not reachable from here by construction and
 *     the test suite proves it.
 *   - Modal SAVE exists only for the "Adjustments in Outflows" dialog. It
 *     records one description row; it does not save the return.
 *   - Anything unexpected (another dialog already open, a label or row that is
 *     not there, an IBAN IRIS cannot resolve) STOPS that step and is reported.
 *     Nothing is guessed and nothing is retried after a click was dispatched.
 *   - Dry mode never clicks inside the page; it only reads and reports.
 */

const BUILD_TAG = "fix39-gift-keywords-20261003";

// Kept in step with lib/tax/wealth-rows.ts. A test compares the two, so a
// category added on one side without the other fails the build.
const EXPENSE_ROWS = Object.freeze({
  "7066": "Asset Insurance / Security",
  "7070": "Medical",
  "7071": "Educational",
  "7072": "Club",
  "7073": "Functions / Gatherings",
  "7076":
    "Donation, Zakat, Annuity, Profit on Debt, Life Insurance Premium, etc.",
  "7087": "Other Personal / Household Expenses",
  "705601": "Foreign Traveling",
  "7056": "Local Traveling",
  "7051": "Rent",
  "707302": "Wedding Events",
  "707301": "Other Events / Functions / Gathering",
  "7052": "Rates / Taxes / Charge / Cess",
  "7055": "Vehicle Running / Maintenance",
  "7058": "Electricity",
  "7059": "Water",
  "7060": "Gas",
  "7061": "Telephone",
});

const BANK_CODE = "7030";
const OUTFLOW_CODE = "7098";
const CASH_CODE = "7012";
const CASH_VALUE_MODE = "add_to_iris_value";
const EXPENSES_ROW_ID = "7089";
const FINANCIAL_ASSETS_ROW_ID = "999901";

const DIALOG_TITLES = Object.freeze({
  expenses: "Add Personal Expenses",
  financialAssets: "Add Financial Assets & Investments (Non-Business)",
  outflow: "Adjustments in Outflows",
  bank: "Bank Account",
});

const SECTION_IDS = Object.freeze({
  assets: "wealth_assets",
  reconciliation: "wealth_reconciliation",
});

/** Statuses this module adds on top of the row filler's. None is a success. */
const WEALTH_STATUS = Object.freeze({
  SETUP_FAILED: "wealth_setup_failed",
  SECTION_UNAVAILABLE: "wealth_section_unavailable",
  UNSUPPORTED: "wealth_unsupported_row",
  /** Dry run: the modal step that would create this row has not been done. */
  DRY_ROW_MISSING: "wealth_row_missing_dry_run",
  /** Cash in hand: adding the movement would make the figure negative. */
  CASH_NEGATIVE: "wealth_cash_would_be_negative",
  /** Cash in hand: the cell holds something that is not a plain amount. */
  CASH_UNREADABLE: "wealth_cash_unreadable",
});

/** Same text as the row filler's status; used when the driver itself refuses. */
const OVERWRITE_STATUS = "overwrite_needs_confirmation";

/** The only page operations that exist. Anything else is refused in Node. */
const PAGE_OPS = Object.freeze([
  "inspect",
  "open_section_add",
  "open_row_add",
  "dialog_tick",
  "dialog_set",
  "dialog_search",
  "dialog_state",
  "dialog_click",
]);

/** Which button labels may be pressed, and in which dialog. */
const DIALOG_BUTTONS = Object.freeze({
  add: [
    DIALOG_TITLES.expenses,
    DIALOG_TITLES.financialAssets,
    DIALOG_TITLES.bank,
  ],
  cancel: [DIALOG_TITLES.expenses, DIALOG_TITLES.financialAssets],
  close: [DIALOG_TITLES.outflow, DIALOG_TITLES.bank],
  save: [DIALOG_TITLES.outflow],
});

/**
 * Runs INSIDE the IRIS page (it is stringified and sent through
 * executeJavaScript), so it must not touch any Node-side variable. One call =
 * one operation = at most one click.
 */
function wealthPageOp(step) {
  const CFG = step.cfg;
  const norm = (v) =>
    String(v == null ? "" : v)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
    }
    return true;
  };
  const rowsById = (id) =>
    Array.from(document.querySelectorAll(CFG.rowSelector)).filter(
      (row) => row.id === String(id),
    );
  const descOf = (row) => {
    const el = row.querySelector(CFG.descriptionSelector);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  };
  const inputsOf = (row) =>
    Array.from(
      row.querySelectorAll(
        CFG.cellSelector + ' input:not([type="hidden"]), ' + CFG.cellSelector + " textarea",
      ),
    );
  const isEditable = (el) => Boolean(el) && !el.disabled && !el.readOnly;
  const rowEditable = (row) => inputsOf(row).some(isEditable);
  const dialogs = () =>
    Array.from(document.querySelectorAll("mat-dialog-container")).filter(
      visible,
    );
  const dialogTitle = (dialog) => {
    const span = dialog.querySelector(
      "[mat-dialog-title] .left, .mat-mdc-dialog-title .left, h6 .left",
    );
    if (span) return norm(span.textContent);
    const head = dialog.querySelector("[mat-dialog-title], h6");
    return head ? norm(head.textContent.replace(/close\s*$/i, "")) : "";
  };
  const findDialog = (title) =>
    dialogs().find((dialog) => dialogTitle(dialog) === norm(title)) || null;
  const buttonsOf = (dialog) =>
    Array.from(
      dialog.querySelectorAll("mat-dialog-actions button, .dialog-footer button"),
    );
  const buttonLabel = (button) => norm(button.textContent);
  const setNative = (el, value) => {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    try {
      el.focus();
    } catch (e) {}
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
    try {
      el.blur();
    } catch (e) {}
  };
  const addEnabled = (dialog) => {
    const add = buttonsOf(dialog).find((b) => buttonLabel(b) === "add");
    return Boolean(add) && !add.disabled;
  };
  const saveEnabled = (dialog) => {
    const save = buttonsOf(dialog).find((b) => buttonLabel(b) === "save");
    return Boolean(save) && !save.disabled;
  };

  const op = step.op;

  if (op === "inspect") {
    const rows = {};
    for (const code of step.codes || []) {
      rows[code] = rowsById(code).map((row) => {
        const inputs = inputsOf(row);
        const first = inputs[0];
        return {
          description: descOf(row),
          editable: rowEditable(row),
          value: first ? String(first.value || "") : "",
          hasAddIcon: Boolean(row.querySelector("mat-icon.btn-purple")),
        };
      });
    }
    return {
      status: "ok",
      dialogs: dialogs().map(dialogTitle),
      sectionButtons: Array.from(
        document.querySelectorAll(CFG.rowSelector + " button.btn-section-add"),
      ).map((button) => ({
        rowId: button.closest(CFG.rowSelector).id,
        label: button.textContent.replace(/\s+/g, " ").trim(),
      })),
      rows,
    };
  }

  if (op === "open_section_add") {
    if (dialogs().length) return { status: "dialog_already_open" };
    const row = rowsById(step.rowId)[0];
    if (!row) return { status: "row_not_found" };
    const buttons = Array.from(
      row.querySelectorAll("button.btn-section-add"),
    ).filter((button) => norm(button.textContent) === norm(step.label));
    if (buttons.length !== 1)
      return { status: buttons.length ? "ambiguous_button" : "button_not_found" };
    if (buttons[0].disabled) return { status: "button_disabled" };
    buttons[0].click();
    return { status: "clicked" };
  }

  if (op === "open_row_add") {
    if (dialogs().length) return { status: "dialog_already_open" };
    // The summary row is the one with no editable cell; only it carries the
    // purple "add" icon. Orange (edit) and red (delete) icons are never touched.
    const summaries = rowsById(step.rowId).filter(
      (row) => !rowEditable(row) && row.querySelector("mat-icon.btn-purple"),
    );
    if (summaries.length !== 1)
      return {
        status: summaries.length ? "ambiguous_row" : "add_icon_not_found",
      };
    const icons = summaries[0].querySelectorAll("mat-icon.btn-purple");
    if (icons.length !== 1) return { status: "ambiguous_icon" };
    icons[0].click();
    return { status: "clicked" };
  }

  if (op === "dialog_tick") {
    const dialog = findDialog(step.title);
    if (!dialog) return { status: "dialog_not_open" };
    const outcome = {};
    for (const label of step.labels || []) {
      const cards = Array.from(dialog.querySelectorAll(".source-card")).filter(
        (card) => {
          const p = card.querySelector("p");
          return p && norm(p.textContent) === norm(label);
        },
      );
      if (cards.length !== 1) {
        outcome[label] = cards.length ? "ambiguous_label" : "label_not_found";
        continue;
      }
      const box = cards[0].querySelector('input[type="checkbox"]');
      if (!box) {
        outcome[label] = "checkbox_not_found";
      } else if (box.disabled) {
        outcome[label] = box.checked ? "already_present" : "disabled";
      } else if (box.checked) {
        outcome[label] = "already_checked";
      } else {
        box.click();
        outcome[label] = box.checked ? "ticked" : "tick_failed";
      }
    }
    return { status: "ok", outcome, addEnabled: addEnabled(dialog) };
  }

  if (op === "dialog_set") {
    const dialog = findDialog(step.title);
    if (!dialog) return { status: "dialog_not_open" };
    const selector =
      step.field === "description"
        ? 'textarea[formcontrolname="description"]'
        : step.field === "iban"
          ? 'input[placeholder="IBAN"]'
          : null;
    if (!selector) return { status: "unsupported_field" };
    const el = dialog.querySelector(selector);
    if (!el || el.disabled || el.readOnly) return { status: "field_not_found" };
    setNative(el, String(step.value));
    return { status: "set", readback: el.value };
  }

  if (op === "dialog_search") {
    const dialog = findDialog(step.title);
    if (!dialog) return { status: "dialog_not_open" };
    const buttons = Array.from(
      dialog.querySelectorAll(".mat-mdc-form-field-icon-suffix button"),
    ).filter((button) => /search/i.test(button.textContent));
    if (buttons.length !== 1)
      return { status: buttons.length ? "ambiguous_button" : "button_not_found" };
    buttons[0].click();
    return { status: "clicked" };
  }

  if (op === "dialog_state") {
    const dialog = findDialog(step.title);
    if (!dialog) return { status: "dialog_not_open" };
    const valueOf = (selector) => {
      const el = dialog.querySelector(selector);
      return el ? String(el.value || "") : "";
    };
    return {
      status: "ok",
      addEnabled: addEnabled(dialog),
      saveEnabled: saveEnabled(dialog),
      accountTitle: valueOf('input[placeholder="Account Title"]'),
      bankName: valueOf('input[placeholder="Bank Name"]'),
      iban: valueOf('input[placeholder="IBAN"]'),
      description: valueOf('textarea[formcontrolname="description"]'),
    };
  }

  if (op === "dialog_click") {
    const dialog = findDialog(step.title);
    if (!dialog) return { status: "dialog_not_open" };
    const wanted = norm(step.button);
    const matches = buttonsOf(dialog).filter(
      (button) => buttonLabel(button) === wanted,
    );
    if (matches.length !== 1)
      return { status: matches.length ? "ambiguous_button" : "button_not_found" };
    if (matches[0].disabled) return { status: "button_disabled" };
    matches[0].click();
    return { status: "clicked" };
  }

  return { status: "unsupported_op" };
}

const PAGE_CFG = Object.freeze({
  rowSelector: ".tableRows.dataRow[id]",
  cellSelector: ".data-middle-child-wapper",
  descriptionSelector: ".row-description-text",
});

/** Refuses anything outside the documented click surface BEFORE it reaches the page. */
function assertAllowedStep(step) {
  if (!step || !PAGE_OPS.includes(step.op))
    throw new Error(`wealth driver: operation "${step && step.op}" is not allowed`);
  const norm = (v) => String(v || "").trim().toLowerCase();
  if (step.op === "open_section_add") {
    const ok =
      (step.rowId === EXPENSES_ROW_ID && norm(step.label) === "+ expenses") ||
      (step.rowId === FINANCIAL_ASSETS_ROW_ID && norm(step.label) === "+ assets");
    if (!ok)
      throw new Error(
        `wealth driver: section button ${step.rowId} "${step.label}" is not allowed`,
      );
  }
  if (step.op === "open_row_add" && ![OUTFLOW_CODE, BANK_CODE].includes(step.rowId))
    throw new Error(`wealth driver: add icon on row ${step.rowId} is not allowed`);
  const knownTitles = Object.values(DIALOG_TITLES);
  if (
    step.title !== undefined &&
    !knownTitles.some((title) => norm(title) === norm(step.title))
  )
    throw new Error(`wealth driver: dialog "${step.title}" is not allowed`);
  if (step.op === "dialog_click") {
    const allowed = DIALOG_BUTTONS[norm(step.button)];
    if (!allowed || !allowed.some((title) => norm(title) === norm(step.title)))
      throw new Error(
        `wealth driver: button "${step.button}" in "${step.title}" is not allowed`,
      );
  }
  if (step.op === "dialog_tick") {
    const labels = step.labels || [];
    if (norm(step.title) === norm(DIALOG_TITLES.expenses)) {
      const known = new Set(Object.values(EXPENSE_ROWS).map(norm));
      if (!labels.length || !labels.every((label) => known.has(norm(label))))
        throw new Error("wealth driver: unknown expense category label");
    } else if (norm(step.title) === norm(DIALOG_TITLES.financialAssets)) {
      if (labels.length !== 1 || norm(labels[0]) !== "bank account(s)")
        throw new Error("wealth driver: only Bank Account(s) may be ticked");
    } else {
      throw new Error("wealth driver: nothing may be ticked in this dialog");
    }
  }
  if (step.op === "dialog_set") {
    const ok =
      (step.field === "description" &&
        norm(step.title) === norm(DIALOG_TITLES.outflow)) ||
      (step.field === "iban" && norm(step.title) === norm(DIALOG_TITLES.bank));
    if (!ok) throw new Error("wealth driver: that field may not be set here");
  }
  if (
    step.op === "dialog_search" &&
    norm(step.title) !== norm(DIALOG_TITLES.bank)
  )
    throw new Error("wealth driver: search is only for the Bank Account dialog");
}

function buildPageScript(step) {
  assertAllowedStep(step);
  return `(${wealthPageOp.toString()})(${JSON.stringify({ ...step, cfg: PAGE_CFG })})`;
}

/**
 * Group the prepared wealth fields by the IRIS section that owns them and
 * separate anything this driver cannot place. Pure.
 */
function planWealthWork(fields) {
  const plan = {
    expenses: [],
    outflows: [],
    banks: [],
    cash: [],
    unsupported: [],
  };
  for (const field of fields || []) {
    const code = String(field && field.irisCode ? field.irisCode : "");
    if (Object.prototype.hasOwnProperty.call(EXPENSE_ROWS, code)) {
      plan.expenses.push(field);
    } else if (code === OUTFLOW_CODE) {
      plan.outflows.push(field);
    } else if (code === BANK_CODE && field.rowDescriptionIncludes) {
      plan.banks.push(field);
    } else if (
      code === CASH_CODE &&
      field.valueMode === CASH_VALUE_MODE &&
      plan.cash.length === 0
    ) {
      plan.cash.push(field);
    } else {
      plan.unsupported.push(field);
    }
  }
  return plan;
}

/** Digits of a cell value, or null when it is not a plain whole-rupee amount. */
function readCashCell(text) {
  const raw = String(text == null ? "" : text).replace(/[\s,]/g, "");
  if (raw === "") return 0;
  if (!/^\d+(\.0+)?$/.test(raw)) return null;
  return Number(raw.split(".")[0]);
}

/**
 * Decide what Cash in hand (7012) should become. Pure.
 *
 * The packet carries a MOVEMENT (delta), because IRIS owns the opening figure.
 * The target is `baseline + delta`. The baseline is what IRIS held before this
 * agent first wrote the row; it is remembered in `record` so a re-run does not
 * add the movement twice:
 *
 *   cell == record.written   our own earlier write: baseline = record.existing
 *   cell == record.existing  the earlier write never landed: same baseline
 *   anything else            somebody edited the cell: refuse, never overwrite
 *   no record                the cell itself is the baseline
 *
 * Returns { action: "write", baseline, target, replaceOnlyIfExisting } or
 * { action: "conflict" | "negative" | "unreadable", ... }.
 */
function planCashTarget({ delta, current, record }) {
  const change = Number(delta);
  const cell = readCashCell(current);
  if (!Number.isFinite(change) || change === 0)
    return { action: "unreadable", reason: "cash_delta_invalid" };
  if (cell === null) return { action: "unreadable", reason: "cash_cell_not_a_number" };

  const valid =
    record &&
    Number.isFinite(Number(record.existing)) &&
    Number.isFinite(Number(record.written));
  let baseline = cell;
  if (valid) {
    const existing = Number(record.existing);
    const written = Number(record.written);
    if (cell === written || cell === existing) {
      baseline = existing;
    } else {
      return {
        action: "conflict",
        reason: "cash_cell_changed_by_user",
        baseline: existing,
        target: existing + change,
      };
    }
  }
  const target = baseline + change;
  if (target < 0)
    return { action: "negative", reason: "cash_would_be_negative", baseline, target };
  return {
    action: "write",
    baseline,
    target,
    // A blank cell is written by the filler anyway; a filled one may only be
    // replaced when it holds exactly the figure proven to be ours or IRIS's.
    replaceOnlyIfExisting: cell > 0 ? String(cell) : undefined,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive the Wealth Statement for one packet.
 *
 * options:
 *   mode            "live" | "dry"
 *   navigate(id)    -> { ok, status }   opens a wealth section (navigateToSection)
 *   fillRows(fields, {dryRun}) -> { results }   the row filler
 *   beforeStep()    awaited before every page operation (job-cancel check)
 *   onStep(step, detail)
 *   sleep(ms), timeoutMs
 *
 * Returns { results, setup } where `results` has one entry per input field.
 */
async function runWealthDriver(windowInstance, fields, options = {}) {
  const {
    mode = "dry",
    navigate,
    fillRows,
    beforeStep = async () => {},
    onStep = () => {},
    sleep = defaultSleep,
    timeoutMs = 8000,
    cashStore = null,
  } = options;
  const live = mode === "live";
  const plan = planWealthWork(fields);
  const results = [];
  const setup = [];
  const note = (step, detail) => {
    setup.push({ step, detail });
    onStep(`wealth_${step}`, detail);
  };

  const run = async (step) => {
    await beforeStep();
    const script = buildPageScript(step);
    return windowInstance.webContents.executeJavaScript(script);
  };
  const waitFor = async (producer, accept) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await producer();
      if (accept(last)) return { ok: true, value: last };
      await sleep(250);
    } while (Date.now() < deadline);
    return { ok: false, value: last };
  };
  const failAll = (group, status, setupStatus, extra = {}) => {
    for (const field of group)
      results.push({ ...field, status, setupStatus, ...extra });
  };

  for (const field of plan.unsupported)
    results.push({
      ...field,
      status: WEALTH_STATUS.UNSUPPORTED,
      setupStatus: "no_driver_for_this_row",
    });

  const openSection = async (sectionId, group) => {
    if (!group.length) return false;
    let moved;
    try {
      moved = await navigate(sectionId);
    } catch (error) {
      moved = { ok: false, status: `navigation_error: ${error && error.message}` };
    }
    if (!moved || !moved.ok) {
      note(
        "section_unavailable",
        `${sectionId}: could not be opened (${moved && moved.status}). Make sure the Wealth Statement choice is Yes on the Summary of Economic Transactions page. ${group.length} figure(s) left untouched.`,
      );
      failAll(group, WEALTH_STATUS.SECTION_UNAVAILABLE, moved && moved.status);
      return false;
    }
    note("section_open", `${sectionId}: ${moved.status}.`);
    const probe = await run({ op: "inspect", codes: [] });
    if (probe.dialogs.length) {
      note(
        "unexpected_dialog",
        `${sectionId}: a dialog ("${probe.dialogs.join('", "')}") is already open; nothing was clicked.`,
      );
      failAll(group, WEALTH_STATUS.SETUP_FAILED, "unexpected_dialog_open");
      return false;
    }
    return true;
  };

  // Close a dialog we opened but cannot complete, so the page is left clean.
  const abandon = async (title, button) => {
    if (!live) return;
    try {
      await run({ op: "dialog_click", title, button });
    } catch (error) {
      note("abandon_failed", `${title}: could not be closed (${error && error.message}).`);
    }
  };

  const fillGroup = async (group) => {
    const outcome = await fillRows(group, { dryRun: !live });
    for (const entry of outcome.results) results.push(entry);
  };

  // ── Reconciliation: expenses (7089) and tax outflow (7098) ──────────────
  const reconGroup = [...plan.expenses, ...plan.outflows];
  if (await openSection(SECTION_IDS.reconciliation, reconGroup)) {
    let ready = [...plan.expenses, ...plan.outflows];

    if (plan.expenses.length) {
      const codes = plan.expenses.map((f) => String(f.irisCode));
      const seen = await run({ op: "inspect", codes });
      const missing = plan.expenses.filter(
        (f) =>
          !(seen.rows[String(f.irisCode)] || []).some((row) => row.editable),
      );
      if (!missing.length) {
        note("expenses_present", "Every expense row already exists; no modal needed.");
      } else if (!live) {
        note(
          "expenses_would_add",
          `DRY: would tick ${missing
            .map((f) => EXPENSE_ROWS[String(f.irisCode)])
            .join(", ")} in "+ Expenses". Nothing clicked.`,
        );
        failAll(missing, WEALTH_STATUS.DRY_ROW_MISSING, "expense_row_needs_modal");
        ready = ready.filter((f) => !missing.includes(f));
      } else {
        const failed = await addExpenseRows(missing);
        if (failed) {
          failAll(missing, WEALTH_STATUS.SETUP_FAILED, failed);
          ready = ready.filter((f) => !missing.includes(f));
        }
      }
    }

    if (plan.outflows.length) {
      const f = plan.outflows[0];
      const hint = String(f.rowDescriptionIncludes || "");
      const matching = (rows) =>
        (rows[OUTFLOW_CODE] || []).filter(
          (row) =>
            row.editable &&
            (!hint || row.description.toLowerCase().includes(hint.toLowerCase())),
        );
      const seen = await run({ op: "inspect", codes: [OUTFLOW_CODE] });
      if (matching(seen.rows).length) {
        note("outflow_present", "The tax-outflow row already exists; no modal needed.");
      } else if (!live) {
        note("outflow_would_add", `DRY: would add "${hint}" under Adjustments in Outflows.`);
        failAll(plan.outflows, WEALTH_STATUS.DRY_ROW_MISSING, "outflow_row_needs_modal");
        ready = ready.filter((x) => !plan.outflows.includes(x));
      } else {
        const failed = await addOutflowRow(hint || "Income tax deducted u/s 149", matching);
        if (failed) {
          failAll(plan.outflows, WEALTH_STATUS.SETUP_FAILED, failed);
          ready = ready.filter((x) => !plan.outflows.includes(x));
        }
      }
    }

    if (ready.length) await fillGroup(ready);
  }

  // ── Assets: bank accounts (7030) ────────────────────────────────────────
  if (await openSection(SECTION_IDS.assets, [...plan.banks, ...plan.cash])) {
    let ready = [...plan.banks];
    const hasChild = (rows, iban) =>
      (rows[BANK_CODE] || []).some(
        (row) =>
          row.editable && row.description.toLowerCase().includes(iban.toLowerCase()),
      );
    let seen = await run({ op: "inspect", codes: [BANK_CODE] });
    const missing = plan.banks.filter(
      (f) => !hasChild(seen.rows, String(f.rowDescriptionIncludes)),
    );

    if (missing.length && !live) {
      note(
        "banks_would_add",
        `DRY: would add ${missing.length} bank account(s) by IBAN. Nothing clicked.`,
      );
      failAll(missing, WEALTH_STATUS.DRY_ROW_MISSING, "bank_row_needs_modal");
      ready = ready.filter((f) => !missing.includes(f));
    } else if (missing.length) {
      // The 7030 summary row (with its add icon) only exists once
      // "Bank Account(s)" has been ticked in "+ Assets".
      if (!(seen.rows[BANK_CODE] || []).some((row) => row.hasAddIcon)) {
        const failed = await addBankSummaryRow();
        if (failed) {
          failAll(missing, WEALTH_STATUS.SETUP_FAILED, failed);
          ready = ready.filter((f) => !missing.includes(f));
        }
      }
      for (const field of missing) {
        if (!ready.includes(field)) continue;
        const failed = await addBankAccount(String(field.rowDescriptionIncludes));
        if (failed) {
          failAll([field], WEALTH_STATUS.SETUP_FAILED, failed);
          ready = ready.filter((f) => f !== field);
        }
      }
    }
    if (ready.length) await fillGroup(ready);
    if (plan.cash.length) await fillCash(plan.cash[0]);
  }

  // ── step implementations ────────────────────────────────────────────────
  // Cash in hand (7012): add the movement to the figure IRIS already holds.
  async function fillCash(field) {
    const delta = Number(field.value);
    const seen = await run({ op: "inspect", codes: [CASH_CODE] });
    const editable = (seen.rows[CASH_CODE] || []).filter((row) => row.editable);
    if (editable.length !== 1) {
      // Missing or ambiguous: the row filler reports it in its own words.
      note(
        "cash_row_unavailable",
        `Cash in hand (7012): ${editable.length} editable row(s) found, expected exactly one.`,
      );
      await fillGroup([field]);
      return;
    }
    const current = editable[0].value;
    let record = null;
    try {
      record = cashStore ? cashStore.load() : null;
    } catch (error) {
      // Without the baseline the driver cannot tell its own write from IRIS's
      // figure, and guessing could add the movement twice.
      note(
        "cash_baseline_unreadable",
        `The saved Cash in hand baseline could not be read (${error && error.message}). Cash in hand (7012) was left untouched.`,
      );
      results.push({
        ...field,
        status: WEALTH_STATUS.CASH_UNREADABLE,
        setupStatus: "cash_baseline_unreadable",
        existingValue: current,
      });
      return;
    }
    const decision = planCashTarget({ delta, current, record });
    const carry = { cashDelta: delta, baselineValue: decision.baseline };
    if (decision.action !== "write") {
      const status =
        decision.action === "conflict"
          ? OVERWRITE_STATUS
          : decision.action === "negative"
            ? WEALTH_STATUS.CASH_NEGATIVE
            : WEALTH_STATUS.CASH_UNREADABLE;
      note(
        "cash_not_written",
        decision.action === "conflict"
          ? `Cash in hand (7012) holds ${current} now, which is neither the figure IRIS had (${record && record.existing}) nor the figure this agent wrote (${record && record.written}). Left untouched.`
          : decision.action === "negative"
            ? `Cash in hand (7012): ${decision.baseline} plus the movement ${delta} would be ${decision.target}, below zero. Left untouched; check the cash movements and the Cash in hand figure.`
            : `Cash in hand (7012) was not written (${decision.reason}).`,
      );
      results.push({
        ...field,
        ...carry,
        value: decision.target === undefined ? field.value : String(decision.target),
        status,
        setupStatus: decision.reason,
        existingValue: current,
        plannedValue: decision.target === undefined ? undefined : String(decision.target),
      });
      return;
    }
    const before = results.length;
    await fillGroup([
      {
        ...field,
        ...carry,
        value: String(decision.target),
        replaceOnlyIfExisting: decision.replaceOnlyIfExisting,
      },
    ]);
    const outcome = results.slice(before)[0];
    if (outcome) Object.assign(outcome, carry);
    note(
      "cash_planned",
      `Cash in hand (7012): IRIS shows ${decision.baseline}; adding the movement ${delta} gives ${decision.target}.`,
    );
    if (live && cashStore && outcome && (outcome.status === "filled" || outcome.status === "already_correct")) {
      try {
        cashStore.save({
          existing: decision.baseline,
          written: decision.target,
          delta,
        });
      } catch (error) {
        note("cash_baseline_not_saved", `Cash in hand baseline could not be saved (${error && error.message}). A re-run on this machine could add the movement again.`);
      }
    }
  }

  async function addExpenseRows(missing) {
    const labels = missing.map((f) => EXPENSE_ROWS[String(f.irisCode)]);
    const opened = await run({
      op: "open_section_add",
      rowId: EXPENSES_ROW_ID,
      label: "+ Expenses",
    });
    if (opened.status !== "clicked") {
      note("expenses_open_failed", `"+ Expenses": ${opened.status}.`);
      return `expenses_button_${opened.status}`;
    }
    const dialog = await waitFor(
      () => run({ op: "dialog_state", title: DIALOG_TITLES.expenses }),
      (state) => state.status === "ok",
    );
    if (!dialog.ok) {
      note("expenses_dialog_missing", "The Add Personal Expenses dialog did not appear.");
      return "expenses_dialog_not_shown";
    }
    const ticked = await run({
      op: "dialog_tick",
      title: DIALOG_TITLES.expenses,
      labels,
    });
    const bad = Object.entries(ticked.outcome || {}).filter(
      ([, state]) => !["ticked", "already_checked"].includes(state),
    );
    if (bad.length) {
      note(
        "expenses_tick_failed",
        `Could not tick: ${bad.map(([label, state]) => `${label} (${state})`).join("; ")}. Dialog closed, nothing added.`,
      );
      await abandon(DIALOG_TITLES.expenses, "Cancel");
      return `expense_tick_${bad[0][1]}`;
    }
    if (!ticked.addEnabled) {
      note("expenses_add_disabled", "ADD stayed disabled after ticking; dialog closed.");
      await abandon(DIALOG_TITLES.expenses, "Cancel");
      return "expenses_add_disabled";
    }
    const added = await run({
      op: "dialog_click",
      title: DIALOG_TITLES.expenses,
      button: "ADD",
    });
    if (added.status !== "clicked") return `expenses_add_${added.status}`;
    const codes = missing.map((f) => String(f.irisCode));
    const appeared = await waitFor(
      () => run({ op: "inspect", codes }),
      (state) =>
        !state.dialogs.length &&
        codes.every((code) => (state.rows[code] || []).some((row) => row.editable)),
    );
    if (!appeared.ok) {
      note("expenses_rows_missing", "The expense rows did not appear after ADD.");
      return "expense_rows_not_created";
    }
    note("expenses_added", `Added expense rows: ${labels.join(", ")}.`);
    return null;
  }

  async function addOutflowRow(description, matching) {
    const opened = await run({ op: "open_row_add", rowId: OUTFLOW_CODE });
    if (opened.status !== "clicked") {
      note("outflow_open_failed", `Adjustments in Outflows add icon: ${opened.status}.`);
      return `outflow_icon_${opened.status}`;
    }
    const dialog = await waitFor(
      () => run({ op: "dialog_state", title: DIALOG_TITLES.outflow }),
      (state) => state.status === "ok",
    );
    if (!dialog.ok) return "outflow_dialog_not_shown";
    const set = await run({
      op: "dialog_set",
      title: DIALOG_TITLES.outflow,
      field: "description",
      value: description,
    });
    if (set.status !== "set" || set.readback !== description) {
      await abandon(DIALOG_TITLES.outflow, "CLOSE");
      return `outflow_description_${set.status}`;
    }
    const enabled = await waitFor(
      () => run({ op: "dialog_state", title: DIALOG_TITLES.outflow }),
      (state) => state.status === "ok" && state.saveEnabled,
    );
    if (!enabled.ok) {
      await abandon(DIALOG_TITLES.outflow, "CLOSE");
      return "outflow_save_disabled";
    }
    const saved = await run({
      op: "dialog_click",
      title: DIALOG_TITLES.outflow,
      button: "SAVE",
    });
    if (saved.status !== "clicked") return `outflow_save_${saved.status}`;
    const appeared = await waitFor(
      () => run({ op: "inspect", codes: [OUTFLOW_CODE] }),
      (state) => !state.dialogs.length && matching(state.rows).length > 0,
    );
    if (!appeared.ok) return "outflow_row_not_created";
    note("outflow_added", `Added "${description}" under Adjustments in Outflows.`);
    return null;
  }

  async function addBankSummaryRow() {
    const opened = await run({
      op: "open_section_add",
      rowId: FINANCIAL_ASSETS_ROW_ID,
      label: "+ Assets",
    });
    if (opened.status !== "clicked") return `assets_button_${opened.status}`;
    const dialog = await waitFor(
      () => run({ op: "dialog_state", title: DIALOG_TITLES.financialAssets }),
      (state) => state.status === "ok",
    );
    if (!dialog.ok) return "assets_dialog_not_shown";
    const ticked = await run({
      op: "dialog_tick",
      title: DIALOG_TITLES.financialAssets,
      labels: ["Bank Account(s)"],
    });
    const state = (ticked.outcome || {})["Bank Account(s)"];
    if (state === "already_present") {
      await abandon(DIALOG_TITLES.financialAssets, "Cancel");
      return null;
    }
    if (state !== "ticked" && state !== "already_checked") {
      await abandon(DIALOG_TITLES.financialAssets, "Cancel");
      return `bank_checkbox_${state}`;
    }
    const added = await run({
      op: "dialog_click",
      title: DIALOG_TITLES.financialAssets,
      button: "ADD",
    });
    if (added.status !== "clicked") return `assets_add_${added.status}`;
    const appeared = await waitFor(
      () => run({ op: "inspect", codes: [BANK_CODE] }),
      (s) =>
        !s.dialogs.length && (s.rows[BANK_CODE] || []).some((row) => row.hasAddIcon),
    );
    if (!appeared.ok) return "bank_summary_row_not_created";
    note("bank_summary_added", "Bank Account(s) row created via + Assets.");
    return null;
  }

  async function addBankAccount(iban) {
    const opened = await run({ op: "open_row_add", rowId: BANK_CODE });
    if (opened.status !== "clicked") {
      note("bank_open_failed", `Bank Account(s) add icon: ${opened.status}.`);
      return `bank_icon_${opened.status}`;
    }
    const dialog = await waitFor(
      () => run({ op: "dialog_state", title: DIALOG_TITLES.bank }),
      (state) => state.status === "ok",
    );
    if (!dialog.ok) return "bank_dialog_not_shown";
    const set = await run({
      op: "dialog_set",
      title: DIALOG_TITLES.bank,
      field: "iban",
      value: iban,
    });
    if (set.status !== "set" || set.readback !== iban) {
      await abandon(DIALOG_TITLES.bank, "CLOSE");
      return `bank_iban_${set.status}`;
    }
    const searched = await run({ op: "dialog_search", title: DIALOG_TITLES.bank });
    if (searched.status !== "clicked") {
      await abandon(DIALOG_TITLES.bank, "CLOSE");
      return `bank_search_${searched.status}`;
    }
    const resolved = await waitFor(
      () => run({ op: "dialog_state", title: DIALOG_TITLES.bank }),
      (state) => state.status === "ok" && state.accountTitle && state.addEnabled,
    );
    if (!resolved.ok) {
      note(
        "bank_iban_unresolved",
        `IRIS did not return an account title for IBAN ${iban}; dialog closed, nothing added. Check the IBAN against the bank statement.`,
      );
      await abandon(DIALOG_TITLES.bank, "CLOSE");
      return "bank_iban_not_resolved";
    }
    const added = await run({
      op: "dialog_click",
      title: DIALOG_TITLES.bank,
      button: "ADD",
    });
    if (added.status !== "clicked") return `bank_add_${added.status}`;
    const appeared = await waitFor(
      () => run({ op: "inspect", codes: [BANK_CODE] }),
      (state) =>
        !state.dialogs.length &&
        (state.rows[BANK_CODE] || []).some(
          (row) =>
            row.editable && row.description.toLowerCase().includes(iban.toLowerCase()),
        ),
    );
    if (!appeared.ok) return "bank_row_not_created";
    note("bank_added", `Added bank account ${iban} (${resolved.value.accountTitle}).`);
    return null;
  }

  return { results, setup };
}

module.exports = {
  BUILD_TAG,
  EXPENSE_ROWS,
  DIALOG_TITLES,
  SECTION_IDS,
  WEALTH_STATUS,
  PAGE_OPS,
  PAGE_CFG,
  wealthPageOp,
  assertAllowedStep,
  buildPageScript,
  planWealthWork,
  planCashTarget,
  CASH_CODE,
  CASH_VALUE_MODE,
  runWealthDriver,
};
