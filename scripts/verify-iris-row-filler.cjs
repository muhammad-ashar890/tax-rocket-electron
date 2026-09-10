/**
 * Phase 1 gate: exercise the real-portal row filler against the ACTUAL IRIS 2.0
 * DOM captured from the live portal.
 *
 * These fixtures are the ground truth for how IRIS renders data rows, so this
 * suite is what stops us from shipping a filler that writes into the wrong
 * cell. Every assertion below encodes a fact observed in the captured HTML.
 *
 * Run: node --test scripts/verify-iris-row-filler.cjs
 * Requires: jsdom (devDependency), fixtures in test-fixtures/iris/.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const filler = require("../electron-connect/iris-row-filler.js");

const FIXTURE_DIR = path.join(__dirname, "..", "test-fixtures", "iris");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error(
    "jsdom is required for this suite. Install it: npm install --save-dev jsdom",
  );
  process.exit(1);
}

function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing fixture ${name}. Regenerate with scripts/extract-iris-fixtures.cjs`,
    );
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Execute the in-page script against a fixture, mimicking what
 * webContents.executeJavaScript does inside the real portal.
 */
function runFill(fixtureName, fields, options = {}) {
  const dom = new JSDOM(loadFixture(fixtureName), {
    runScripts: "outside-only",
  });
  const prepared = fields.map(filler.prepareField);
  const script = filler.buildInPageFillScript(prepared, options);
  const results = dom.window.eval(script);
  return {
    results,
    dom,
    byKey: Object.fromEntries(results.map((r) => [r.key, r])),
  };
}

function field(key, irisCode, column, value, label) {
  return { key, irisCode, column, value: String(value), label: label || key };
}

// ───────────────────────────────────────────────────────────────
// Column alias resolution (pure, no DOM)
// ───────────────────────────────────────────────────────────────

test("packet column vocabulary maps onto IRIS's rendered header dialect", () => {
  const I = filler.COLUMN_INTENT;

  // Our packet's names (lib/tax/portal-field-map.ts)
  assert.equal(filler.resolveColumnIntent("Total Amount"), I.TOTAL);
  assert.equal(
    filler.resolveColumnIntent(
      "Amount Exempt from Tax / Subject to Fixed / Final Tax",
    ),
    I.EXEMPT_OR_FINAL,
  );
  assert.equal(
    filler.resolveColumnIntent("Amount Subject to Normal Tax"),
    I.NORMAL,
  );
  assert.equal(
    filler.resolveColumnIntent("Tax Collected / Deducted"),
    I.TAX_COLLECTED,
  );
  assert.equal(filler.resolveColumnIntent("Amount"), I.AMOUNT);

  // IRIS's actual rendered headers — deliberately different wording.
  // Salary says "Income" where Computations says "Tax" for the same column.
  assert.equal(
    filler.resolveColumnIntent("Subject to Normal Income"),
    I.NORMAL,
    "Salary's 'Subject to Normal Income' must resolve like 'Subject to Normal Tax'",
  );
  assert.equal(filler.resolveColumnIntent("Subject to Normal Tax"), I.NORMAL);
  assert.equal(
    filler.resolveColumnIntent("Subject to Final Tax"),
    I.EXEMPT_OR_FINAL,
  );
  assert.equal(
    filler.resolveColumnIntent("Subject to Exemption"),
    I.EXEMPT_OR_FINAL,
  );
  assert.equal(filler.resolveColumnIntent("Taxable Amount"), I.TOTAL);
  assert.equal(filler.resolveColumnIntent("Tax Deducted"), I.TAX_COLLECTED);
});

test("unknown column labels resolve to null rather than a wrong guess", () => {
  assert.equal(filler.resolveColumnIntent("Wildly Unrelated Column"), null);
  assert.equal(filler.resolveColumnIntent(""), null);
  assert.equal(filler.resolveColumnIntent(null), null);
});

// ───────────────────────────────────────────────────────────────
// Salary section — the 4-column [E D E D] grid
// ───────────────────────────────────────────────────────────────

test("salary: writes into the editable Total column of row #1009", () => {
  const { byKey } = runFill("salary.html", [
    field("salary.pay", "1009", "Total Amount", 1250000, "Pay, Wages"),
  ]);
  const r = byKey["salary.pay"];
  assert.equal(r.status, filler.FILL_STATUS.FILLED, JSON.stringify(r));
  assert.equal(r.columnIndex, 0);
  assert.equal(r.readback, "1250000");
  assert.match(r.rowDescription, /Pay, Wages/);
});

test("salary: 'Subject to Normal Income' is IRIS-derived and must be refused", () => {
  // Captured DOM for the Salary grid:
  //   col0 "Total Income"             editable
  //   col1 "Subject to Final Tax"     DISABLED
  //   col2 "Subject to Exemption"     editable
  //   col3 "Subject to Normal Income" DISABLED   <- IRIS computes this
  //
  // Our packet calls this column "Amount Subject to Normal Tax". It resolves
  // correctly to index 3 via header text, and index 3 is disabled — IRIS
  // derives it as Total minus Final minus Exemption. Pushing a value here is
  // never right, so the filler must report the reason instead of writing.
  const { byKey } = runFill("salary.html", [
    field("salary.normal", "1009", "Amount Subject to Normal Tax", 900000),
  ]);
  const r = byKey["salary.normal"];
  assert.equal(r.status, filler.FILL_STATUS.COLUMN_DISABLED, JSON.stringify(r));
  assert.equal(r.columnIndex, 3, "resolved by header text, not by position");
  assert.equal(r.matchedBy, "header_exact");
  assert.ok(!("readback" in r), "must not have written into a derived cell");
});

test("salary: the editable pair on row #1009 is Total (col0) and Exemption (col2)", () => {
  // Guards the [E D E D] shape the filler depends on. If IRIS ever re-orders
  // or re-enables these columns, this is the test that should fail first.
  const { byKey } = runFill("salary.html", [
    field("total", "1009", "Total Amount", 1250000),
    field(
      "exempt",
      "1009",
      "Amount Exempt from Tax / Subject to Fixed / Final Tax",
      50000,
    ),
  ]);
  assert.equal(byKey.total.status, filler.FILL_STATUS.FILLED);
  assert.equal(byKey.total.columnIndex, 0);

  // "Exempt from Tax / Subject to Fixed / Final Tax" resolves onto col1
  // ("Subject to Final Tax"), which IRIS renders disabled on this row.
  assert.equal(byKey.exempt.status, filler.FILL_STATUS.COLUMN_DISABLED);
  assert.equal(byKey.exempt.columnIndex, 1);
});

test("salary: refuses the fully-calculated summary row #1000 instead of corrupting it", () => {
  // #1000 "Total Income from Salary" is [D D D D] — IRIS derives every cell.
  const { byKey } = runFill("salary.html", [
    field("salary.total", "1000", "Total Amount", 5000000),
  ]);
  const r = byKey["salary.total"];
  // Reported as a fully-derived ROW, not as a per-column refusal: that is the
  // distinction which stops a computed row from being misdiagnosed as "selector
  // drift" in the operator log (the live run logged 12 × column_disabled for #1000).
  assert.equal(r.status, filler.FILL_STATUS.NO_EDITABLE_CELL, JSON.stringify(r));
  assert.equal(r.hint, "computed_row");
  assert.ok(!("readback" in r), "must not have written anything");
});

test("salary: a disabled target reports the reason and leaves the DOM untouched", () => {
  const { byKey, dom } = runFill("salary.html", [
    field("salary.exempt", "1009", "Subject to Final Tax", 42),
  ]);
  const r = byKey["salary.exempt"];
  assert.equal(r.status, filler.FILL_STATUS.COLUMN_DISABLED);
  assert.equal(r.columnIndex, 1);

  const wrappers = dom.window.document
    .getElementById("1009")
    .querySelectorAll(".data-middle-child-wapper");
  assert.equal(
    wrappers[1].querySelector("input").value,
    "",
    "disabled cell must remain empty",
  );
});

test("salary: multiple rows fill independently in one pass", () => {
  const { byKey } = runFill("salary.html", [
    field("pay", "1009", "Total Amount", 1250000),
    field("allow", "1049", "Total Amount", 300000),
    field("pension", "1008", "Total Amount", 150000),
  ]);
  for (const key of ["pay", "allow", "pension"]) {
    assert.equal(
      byKey[key].status,
      filler.FILL_STATUS.FILLED,
      `${key}: ${JSON.stringify(byKey[key])}`,
    );
  }
  assert.match(byKey.allow.rowDescription, /Allowances/);
  assert.match(byKey.pension.rowDescription, /Pension/);
});

// ───────────────────────────────────────────────────────────────
// Withholding — duplicate row ids
// ───────────────────────────────────────────────────────────────

test("withholding: duplicate code #64150002 picks the editable child row, not the disabled summary", () => {
  // The fixture contains #64150002 twice: a [D D] summary and an [E E] child.
  // document.getElementById() would return the summary and silently no-op.
  const { byKey } = runFill("withholding.html", [
    field("wht.cellphone", "64150002", "Tax Collected / Deducted", 62500),
  ]);
  const r = byKey["wht.cellphone"];
  assert.equal(r.status, filler.FILL_STATUS.FILLED, JSON.stringify(r));
  assert.equal(r.readback, "62500");
});

test("withholding: 'Tax Collected / Deducted' resolves against header 'Tax Deducted'", () => {
  const { byKey } = runFill("withholding.html", [
    field("wht.remit", "64151905", "Tax Collected / Deducted", 8000),
  ]);
  const r = byKey["wht.remit"];
  assert.equal(r.status, filler.FILL_STATUS.FILLED, JSON.stringify(r));
  assert.equal(r.intent, filler.COLUMN_INTENT.TAX_COLLECTED);
});

test("withholding: taxable amount and tax deducted land in different columns", () => {
  const { byKey } = runFill("withholding.html", [
    field("amt", "64151905", "Total Amount", 500000),
    field("tax", "64151905", "Tax Collected / Deducted", 8000),
  ]);
  assert.equal(byKey.amt.status, filler.FILL_STATUS.FILLED);
  assert.equal(byKey.tax.status, filler.FILL_STATUS.FILLED);
  assert.notEqual(
    byKey.amt.columnIndex,
    byKey.tax.columnIndex,
    "amount and tax must not collapse onto the same cell",
  );
});

// ───────────────────────────────────────────────────────────────
// Single-column sections
// ───────────────────────────────────────────────────────────────

test("assets: single-column row #7012 fills without needing header matching", () => {
  const { byKey } = runFill("assets.html", [
    field("assets.cash", "7012", "Amount", 450000, "Cash in hand"),
  ]);
  const r = byKey["assets.cash"];
  assert.equal(r.status, filler.FILL_STATUS.FILLED, JSON.stringify(r));
  assert.equal(r.columnIndex, 0);
  assert.equal(r.matchedBy, "single_column");
  assert.match(r.rowDescription, /Cash in hand/);
});

test("assets: derived totals like #7019 stay protected", () => {
  const { byKey } = runFill("assets.html", [
    field("assets.total", "7019", "Amount", 9999999),
  ]);
  assert.equal(
    byKey["assets.total"].status,
    filler.FILL_STATUS.NO_EDITABLE_CELL,
    "a whole-row derived figure is reported as such",
  );
});

test("reconciliation: editable inflow #7031 fills, derived #703000 refuses", () => {
  const { byKey } = runFill("reconciliation.html", [
    field("recon.income", "7031", "Amount", 2000000),
    field("recon.unreconciled", "703000", "Amount", 1),
  ]);
  assert.equal(byKey["recon.income"].status, filler.FILL_STATUS.FILLED);
  assert.equal(
    byKey["recon.unreconciled"].status,
    filler.FILL_STATUS.NO_EDITABLE_CELL,
    "unreconciled amount is IRIS-derived and must never be written",
  );
});

// ───────────────────────────────────────────────────────────────
// Failure modes
// ───────────────────────────────────────────────────────────────

test("a code absent from the current section reports row_not_found, not a crash", () => {
  const { byKey } = runFill("salary.html", [
    field("ghost", "999999999", "Total Amount", 100),
  ]);
  assert.equal(byKey.ghost.status, filler.FILL_STATUS.ROW_NOT_FOUND);
});

test("blank and missing values are skipped rather than clearing portal cells", () => {
  const { byKey } = runFill("salary.html", [
    field("blank", "1009", "Total Amount", ""),
    { key: "nocode", irisCode: null, column: "Total Amount", value: "5" },
  ]);
  assert.equal(byKey.blank.status, filler.FILL_STATUS.EMPTY_VALUE);
  assert.equal(byKey.nocode.status, filler.FILL_STATUS.MISSING_CODE);
});

test("dryRun reports the exact target without mutating the page", () => {
  const { byKey, dom } = runFill(
    "salary.html",
    [field("pay", "1009", "Total Amount", 777)],
    { dryRun: true },
  );
  const r = byKey.pay;
  assert.equal(r.status, filler.FILL_STATUS.FILLED);
  assert.equal(r.dryRun, true);
  assert.equal(r.columnIndex, 0);

  const input = dom.window.document
    .getElementById("1009")
    .querySelectorAll(".data-middle-child-wapper")[0]
    .querySelector("input");
  assert.equal(input.value, "", "dry run must not write");
});

test("filling dispatches input+change so Angular recalculates", () => {
  const dom = new JSDOM(loadFixture("salary.html"), {
    runScripts: "outside-only",
  });
  const input = dom.window.document
    .getElementById("1009")
    .querySelectorAll(".data-middle-child-wapper")[0]
    .querySelector("input");

  const seen = [];
  for (const evt of ["input", "change", "blur"]) {
    input.addEventListener(evt, () => seen.push(evt));
  }

  const script = filler.buildInPageFillScript(
    [filler.prepareField(field("pay", "1009", "Total Amount", 123))],
    {},
  );
  dom.window.eval(script);

  assert.ok(seen.includes("input"), "Angular needs an input event");
  assert.ok(seen.includes("change"), "Angular needs a change event");
});

// ───────────────────────────────────────────────────────────────
// Summary reporting
// ───────────────────────────────────────────────────────────────

test("summary counts successes and itemises every skip reason", () => {
  const { results } = runFill("salary.html", [
    field("ok", "1009", "Total Amount", 100),
    field("calc", "1000", "Total Amount", 200),
    field("ghost", "888888", "Total Amount", 300),
  ]);
  const summary = filler.summarise(results);

  assert.equal(summary.total, 3);
  assert.equal(summary.filled, 1);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.byStatus[filler.FILL_STATUS.NO_EDITABLE_CELL], 1);
  assert.equal(summary.byStatus[filler.FILL_STATUS.ROW_NOT_FOUND], 1);

  const text = filler.describeFillSummary(summary);
  assert.match(text, /1\/3 fields filled/);
  assert.match(text, /no_editable_cell/);
  assert.match(text, /row_not_found/);
});

test("an all-skip run is reported honestly, never as success", () => {
  const { results } = runFill("salary.html", [
    field("calc", "1000", "Total Amount", 1),
  ]);
  const summary = filler.summarise(results);
  assert.equal(summary.filled, 0);
  assert.match(filler.describeFillSummary(summary), /0\/1 fields filled/);
});

// ───────────────────────────────────────────────────────────────
// P1: what the filler refuses to WRITE (a dry run cannot prove these)
// ───────────────────────────────────────────────────────────────

function withDom(fixtureName) {
  return new JSDOM(loadFixture(fixtureName), { runScripts: "outside-only" });
}

function evalIn(dom, fields, options) {
  const script = filler.buildInPageFillScript(
    fields.map((f) => filler.prepareField(f)),
    options,
  );
  return dom.window.eval(script);
}

test("live: a cell reached only by elimination is refused, not guessed into", () => {
  // #923184 on the computations fixture resolves no header at all, so col 0 comes
  // from `sole_editable` — a guess about which column the taxpayer meant. Harmless
  // in a dry run, unacceptable in a live write: the wrong column is a wrong return.
  const dom = withDom("computations.html");
  const results = evalIn(
    dom,
    [field("comp.guess", "923184", "Zzz No Such Column", 5000)],
    { dryRun: false },
  );
  const r = results.find((entry) => entry.key === "comp.guess");
  assert.equal(r.matchedBy, "sole_editable", JSON.stringify(r));
  assert.equal(r.status, filler.FILL_STATUS.UNVERIFIED_TARGET, JSON.stringify(r));
  assert.match(
    filler.describeFillSummary(filler.summarise(results)),
    /unverified_target/,
  );
});

test("dry: the same guess is still reported, because dry runs exist to inspect it", () => {
  const dom = withDom("computations.html");
  const results = evalIn(
    dom,
    [field("comp.guess", "923184", "Zzz No Such Column", 5000)],
    { dryRun: true },
  );
  const r = results.find((entry) => entry.key === "comp.guess");
  assert.equal(r.status, filler.FILL_STATUS.FILLED);
  assert.equal(r.dryRun, true);
  assert.equal(r.previousValue, r.previousValue ?? "");
});

test("live: an explicit opt-in lets an operator accept a guessed cell", () => {
  const dom = withDom("computations.html");
  const results = evalIn(
    dom,
    [field("comp.guess", "923184", "Zzz No Such Column", 5000)],
    { dryRun: false, allowUnverifiedTargets: true },
  );
  assert.equal(
    results.find((entry) => entry.key === "comp.guess").status,
    filler.FILL_STATUS.FILLED,
  );
});

test("live: a write the portal did not keep is a mismatch, never a fill", () => {
  // salary #1009 col 0 is reached by header_exact and is editable, so every guard
  // passes and only the read-back can catch the portal reverting our value.
  const dom = withDom("salary.html");
  const input = dom.window.document
    .getElementById("1009")
    .querySelectorAll("input")[0];
  assert.equal(input.disabled, false, "fixture must expose an editable target");
  let stored = input.value;
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => "0", // the portal "kept" something else
    set: (next) => {
      stored = next;
    },
  });
  const results = evalIn(
    dom,
    [field("salary.readback", "1009", "Total Amount", 250000)],
    { dryRun: false },
  );
  const r = results.find((entry) => entry.key === "salary.readback");
  assert.equal(r.status, filler.FILL_STATUS.READBACK_MISMATCH, JSON.stringify(r));
  assert.equal(r.readback, "0", "report what the portal actually holds");
  assert.equal(stored, "250000", "the write was attempted exactly once");
});

test("live: a mismatch on one field does not abandon the fields after it", () => {
  const dom = withDom("salary.html");
  const first = dom.window.document
    .getElementById("1009")
    .querySelectorAll("input")[0];
  Object.defineProperty(first, "value", {
    configurable: true,
    get: () => "0",
    set: () => {},
  });
  const results = evalIn(
    dom,
    [
      field("salary.readback", "1009", "Total Amount", 250000),
      field("salary.next", "1010", "Total Amount", 1000),
    ],
    { dryRun: false },
  );
  assert.equal(results.length, 2, "both fields must be itemised");
  assert.equal(
    results.find((entry) => entry.key === "salary.next").status,
    filler.FILL_STATUS.FILLED,
  );
});

test("fillIrisRows: amounts the portal could never take are refused before the DOM is touched", async () => {
  const queued = [];
  const windowInstance = {
    webContents: {
      executeJavaScript: async (script) => {
        queued.push(script);
        return []; // the caller only needs to know which fields reached the page
      },
    },
  };
  const { results, summary } = await filler.fillIrisRows(
    windowInstance,
    [
      field("salary.paisa", "1010", "Total Amount", 1000.75),
      field("salary.junk", "1049", "Total Amount", "1,000 rupees"),
      field("salary.blank", "1089", "Total Amount", ""),
      field("salary.ok", "1009", "Total Amount", "5,000,000"),
    ],
    { dryRun: true },
  );
  assert.equal(queued.length, 1, "exactly one script is injected");
  // #1049 is carried ONLY by the unparseable value, so its absence from the
  // injected script proves the pre-filter ran (keys survive for queued fields).
  assert.ok(!queued[0].includes('"1049"'), "an unusable amount must never reach the page");
  assert.ok(queued[0].includes('"1009"'), "valid fields still go through");
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(byKey["salary.junk"].status, "unparseable_amount");
  assert.equal(byKey["salary.blank"].status, filler.FILL_STATUS.EMPTY_VALUE);
  // The mocked page returns nothing, so the summary holds the pre-rejections only.
  assert.equal(summary.total, 2);
  assert.equal(summary.skipped, 2);
  // A paisa amount is not refused — the portal has no paisa, so it is rounded.
  assert.ok(queued[0].includes('"value":"1001"'), "1000.75 rounds up, exactly once");
});

test("prepareField normalises to the portal's whole-rupee digits-only form", () => {
  const whole = filler.prepareField({
    key: "k",
    irisCode: "1009",
    column: "Total Amount",
    value: "1,250,000.00",
  });
  assert.equal(whole.amountValid, true);
  assert.equal(whole.value, "1250000");
  assert.equal(whole.amountExact, true);

  const paisa = filler.prepareField({
    key: "k2",
    irisCode: "1009",
    column: "Total Amount",
    value: 1250000.4,
  });
  assert.equal(paisa.value, "1250000");
  assert.equal(paisa.amountExact, false);
  assert.equal(paisa.roundedFrom, "1250000.4");

  const exponent = filler.prepareField({
    key: "k3",
    irisCode: "1009",
    column: "Total Amount",
    value: 1e21,
  });
  assert.equal(exponent.amountValid, false, "String(1e21) is not a portal amount");
  assert.equal(exponent.amountReason, "unparseable_amount");
});
