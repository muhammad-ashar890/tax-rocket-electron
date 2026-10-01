#!/usr/bin/env node
/**
 * Wealth Statement driver (electron-connect/iris-wealth-driver.js).
 *
 * Runs the REAL driver and the REAL row filler against a stand-in IRIS built
 * from the real captures (scripts/lib/fake-iris-wealth.cjs). Pins:
 *   - what the driver may click (and that Save / Submit / Calculate / delete /
 *     edit controls are unreachable),
 *   - the modal sequences for expenses, the 7098 outflow and bank accounts,
 *   - idempotence (a second run clicks nothing),
 *   - dry mode never clicks,
 *   - every failure stops that step, closes the dialog, and is reported.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(output, filename);
};

const driver = require("../electron-connect/iris-wealth-driver.js");
const filler = require("../electron-connect/iris-row-filler.js");
const { FakeIris } = require("./lib/fake-iris-wealth.cjs");
const { WEALTH_EXPENSE_ROWS } = require(path.join(root, "lib/tax/wealth-rows.ts"));
const { buildPortalFieldMap, flattenPortalFieldMap } = require(path.join(root, "lib/tax/portal-field-map.ts"));

const HBL = "PK35HABB0000001234567801";
const SCB = "PK36SCBL0000001123456702";
const KNOWN = {
  [HBL]: { title: "Ahmed", bank: "HBL" },
  [SCB]: { title: "Ahmed Khan", bank: "SCB" },
};

const wf = (irisCode, value, extra = {}) => ({
  key: `${irisCode}:wealthFields:Amount${extra.rowDescriptionIncludes ? ":" + extra.rowDescriptionIncludes : ""}`,
  irisCode,
  column: "Amount",
  value: String(value),
  label: `wf ${irisCode}`,
  sourceGroup: "wealthFields",
  ...extra,
});
const OUTFLOW_HINT = "Income tax deducted u/s 149";
const FIELDS = {
  rent: wf("7051", 960000),
  electricity: wf("7058", 180000),
  vehicle: wf("7055", 240000),
  other: wf("7087", 1080000),
  outflow: wf("7098", 210000, { rowDescriptionIncludes: OUTFLOW_HINT }),
  hbl: wf("7030", 2100000, { rowDescriptionIncludes: HBL }),
  scb: wf("7030", 750000, { rowDescriptionIncludes: SCB }),
};

function harness({ mode = "live", fields, iris, navigate } = {}) {
  const fake = iris || new FakeIris({ knownIbans: KNOWN });
  const steps = [];
  const options = {
    mode,
    navigate:
      navigate ||
      (async (sectionId) => {
        fake.show(sectionId);
        return { ok: true, status: "switched" };
      }),
    fillRows: (group, opts) =>
      filler.fillIrisRows(fake, group.map((f) => ({ ...f })), { dryRun: opts.dryRun, sectionVerified: true }),
    onStep: (step, detail) => steps.push({ step, detail }),
    sleep: () => new Promise((r) => setTimeout(r, 2)),
    timeoutMs: 80,
  };
  return {
    fake,
    steps,
    run: (list) => driver.runWealthDriver(fake, list || Object.values(FIELDS), options),
  };
}
// Results are keyed like the fields: "<code>" or "<code>@<IBAN>".
const byCode = (results) => {
  const out = {};
  for (const r of results) {
    const hint = String(r.key || "").split(":")[3];
    out[`${r.irisCode}${r.irisCode === "7030" && hint ? "@" + hint : ""}`] = r;
  }
  return out;
};

// ── planning and safety ────────────────────────────────────────────────────
test("planning: expenses, the outflow and IBAN-addressed banks are placed; anything else is held", () => {
  const plan = driver.planWealthWork([
    FIELDS.rent, FIELDS.outflow, FIELDS.hbl, wf("7030", 5), wf("7012", 9), wf("7089", 1),
  ]);
  assert.deepEqual(plan.expenses.map((f) => f.irisCode), ["7051"]);
  assert.deepEqual(plan.outflows.map((f) => f.irisCode), ["7098"]);
  assert.deepEqual(plan.banks.map((f) => f.irisCode), ["7030"]);
  assert.deepEqual(plan.unsupported.map((f) => f.irisCode).sort(), ["7012", "7030", "7089"]);
});

test("drift guard: the driver's expense labels equal lib/tax/wealth-rows.ts", () => {
  const ts = Object.fromEntries(Object.entries(WEALTH_EXPENSE_ROWS).map(([c, v]) => [c, v.label]));
  assert.deepEqual({ ...driver.EXPENSE_ROWS }, ts);
});

test("drift guard: dialog titles and labels are the ones in the captured modals", () => {
  const titleOf = (name) => {
    const html = fs.readFileSync(path.join(root, "test-fixtures/iris/wealth", name), "utf8");
    return new JSDOM(html).window.document.querySelector("[mat-dialog-title] .left").textContent.trim();
  };
  assert.equal(titleOf("modal-expenses.html"), driver.DIALOG_TITLES.expenses);
  assert.equal(titleOf("modal-financial-assets.html"), driver.DIALOG_TITLES.financialAssets);
  assert.equal(titleOf("modal-outflow.html"), driver.DIALOG_TITLES.outflow);
  assert.equal(titleOf("modal-bank.html"), driver.DIALOG_TITLES.bank);
  const html = fs.readFileSync(path.join(root, "test-fixtures/iris/wealth/modal-expenses.html"), "utf8");
  const doc = new JSDOM(html).window.document;
  const labels = [...doc.querySelectorAll(".source-card p")].map((p) => p.textContent.trim());
  assert.deepEqual(labels.sort(), Object.values(driver.EXPENSE_ROWS).sort());
});

test("safety: the only clicks the driver can request are on the documented surface", () => {
  const bad = [
    { op: "click", selector: "button" },
    { op: "open_section_add", rowId: "7089", label: "Save" },
    { op: "open_section_add", rowId: "7012", label: "+ Assets" },
    { op: "open_row_add", rowId: "7012" },
    { op: "open_row_add", rowId: "7089" },
    { op: "dialog_click", title: "Adjustments in Outflows", button: "ADD" },
    { op: "dialog_click", title: "Add Personal Expenses", button: "SAVE" },
    { op: "dialog_click", title: "Bank Account", button: "Submit" },
    { op: "dialog_click", title: "Payment Confirmation", button: "ADD" },
    { op: "dialog_tick", title: "Add Personal Expenses", labels: ["Delete everything"] },
    { op: "dialog_tick", title: "Add Financial Assets & Investments (Non-Business)", labels: ["Investments / Stocks / Bonds / etc."] },
    { op: "dialog_tick", title: "Bank Account", labels: ["Joint Account"] },
    { op: "dialog_set", title: "Add Personal Expenses", field: "description", value: "x" },
    { op: "dialog_search", title: "Adjustments in Outflows" },
  ];
  for (const step of bad) assert.throws(() => driver.buildPageScript(step), /wealth driver/, JSON.stringify(step));
  const good = [
    { op: "inspect", codes: ["7098"] },
    { op: "open_section_add", rowId: "7089", label: "+ Expenses" },
    { op: "open_section_add", rowId: "999901", label: "+ Assets" },
    { op: "open_row_add", rowId: "7098" },
    { op: "open_row_add", rowId: "7030" },
    { op: "dialog_click", title: "Adjustments in Outflows", button: "SAVE" },
    { op: "dialog_click", title: "Bank Account", button: "ADD" },
    { op: "dialog_tick", title: "Add Personal Expenses", labels: ["Rent"] },
    { op: "dialog_tick", title: "Add Financial Assets & Investments (Non-Business)", labels: ["Bank Account(s)"] },
  ];
  for (const step of good) assert.doesNotThrow(() => driver.buildPageScript(step), JSON.stringify(step));
});

test("page op: the add icon is the purple one on the summary row, never edit (orange) or delete (red)", async () => {
  const fake = new FakeIris({ knownIbans: KNOWN });
  fake.show("wealth_reconciliation");
  // Use the capture that already has a child 7098 row carrying orange + red icons.
  const full = new JSDOM(fs.readFileSync(path.join(root, "test-fixtures/iris/wealth/reconciliation-with-expenses-and-outflow.html"), "utf8")).window.document;
  fake.container().innerHTML = full.querySelector(".iris-data").innerHTML;
  const r = await fake.webContents.executeJavaScript(driver.buildPageScript({ op: "open_row_add", rowId: "7098" }));
  assert.equal(r.status, "clicked");
  const clicked = fake.clicks.filter((c) => c.tag === "MAT-ICON");
  assert.equal(clicked.length, 1);
  assert.match(clicked[0].cls, /btn-purple/);
  assert.doesNotMatch(clicked[0].cls, /btn-red|btn-orange/);
});

test("page op: a dialog that is already open blocks every opening click", async () => {
  const fake = new FakeIris({ knownIbans: KNOWN });
  fake.show("wealth_reconciliation");
  fake.openDialog("expenses");
  const before = fake.clicks.length;
  const r = await fake.webContents.executeJavaScript(driver.buildPageScript({ op: "open_section_add", rowId: "7089", label: "+ Expenses" }));
  assert.equal(r.status, "dialog_already_open");
  assert.equal(fake.clicks.length, before);
});

// ── live runs ──────────────────────────────────────────────────────────────
test("live: expenses, the outflow and two banks are created through their modals and filled", async () => {
  const h = harness();
  const { results } = await h.run();
  const r = byCode(results);
  for (const key of ["7051", "7058", "7055", "7087", "7098", `7030@${HBL}`, `7030@${SCB}`]) {
    assert.equal(r[key].status, filler.FILL_STATUS.FILLED, `${key}: ${JSON.stringify(r[key])}`);
  }
  // Values landed on the right rows.
  h.fake.show("wealth_reconciliation");
  assert.equal(h.fake.inputValue(h.fake.row("7051")), "960000");
  assert.equal(h.fake.inputValue(h.fake.row("7058")), "180000");
  assert.equal(h.fake.inputValue(h.fake.row("7055")), "240000");
  assert.equal(h.fake.inputValue(h.fake.row("7087")), "1080000");
  const outflowChild = h.fake.rowsWithId("7098")[1];
  assert.match(outflowChild.querySelector(".row-description-text").textContent, /Income tax deducted u\/s 149/);
  assert.equal(h.fake.inputValue(outflowChild), "210000");
  assert.equal(h.fake.inputValue(h.fake.rowsWithId("7098")[0]), "", "the summary row is never written");
  h.fake.show("wealth_assets");
  const banks = h.fake.rowsWithId("7030");
  assert.equal(banks.length, 3, "summary + one child per bank");
  const child = (iban) => banks.find((b) => b.textContent.includes(iban));
  assert.equal(h.fake.inputValue(child(HBL)), "2100000");
  assert.equal(h.fake.inputValue(child(SCB)), "750000");
  assert.equal(h.fake.dialogs().length, 0, "no dialog left open");
});

test("live: the driver never touches Save, Submit, Calculate, delete, edit or the red icons", async () => {
  const h = harness();
  await h.run();
  const forbidden = h.fake.clicks.filter(
    (c) =>
      /Calculate|Save|Submit/i.test(c.text) && !c.inDialog ||
      /btn-red|btn-orange|btn-section-delete/.test(c.cls) ||
      ["calc", "save", "submit"].includes(c.id),
  );
  assert.deepEqual(forbidden, []);
  // The only 'SAVE' pressed is the modal-local one in Adjustments in Outflows.
  const saves = h.fake.clicks.filter((c) => /^save$/i.test(c.text));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].inDialog, true);
});

test("the click recorder is not vacuous: a click on the return's Save is caught by the same filter", () => {
  const fake = new FakeIris({ knownIbans: KNOWN });
  fake.document.getElementById("save").click();
  const caught = fake.clicks.filter(
    (c) => (/Calculate|Save|Submit/i.test(c.text) && !c.inDialog) || ["calc", "save", "submit"].includes(c.id),
  );
  assert.equal(caught.length, 1);
});

test("live: ticks only what the packet needs", async () => {
  const h = harness({});
  await h.run([FIELDS.rent, FIELDS.electricity]);
  h.fake.show("wealth_reconciliation");
  const codes = h.fake.container() && [...h.fake.container().querySelectorAll(".tableRows[id]")].map((r) => r.id);
  assert.ok(codes.includes("7051") && codes.includes("7058"));
  for (const other of ["7055", "7087", "7070", "7061"]) assert.ok(!codes.includes(other), `${other} must not be added`);
});

test("live: a second run clicks nothing and reports already_correct", async () => {
  const h = harness();
  await h.run();
  const clicksBefore = h.fake.clicks.length;
  const second = await h.run();
  assert.equal(h.fake.clicks.length, clicksBefore, "no new clicks on a re-run");
  for (const entry of second.results) assert.equal(entry.status, filler.FILL_STATUS.ALREADY_CORRECT, JSON.stringify(entry));
});

test("live: a figure IRIS already holds is not overwritten", async () => {
  const h = harness();
  await h.run([FIELDS.rent]);
  h.fake.show("wealth_reconciliation");
  const input = h.fake.row("7051").querySelector(".data-middle-child-wapper input");
  input.value = "111";
  const again = await h.run([{ ...FIELDS.rent, value: "960000" }]);
  assert.equal(again.results[0].status, filler.FILL_STATUS.OVERWRITE_NEEDS_CONFIRMATION);
  assert.equal(input.value, "111");
});

// ── dry runs ───────────────────────────────────────────────────────────────
test("dry: nothing is clicked inside the page; missing rows are reported, not created", async () => {
  const h = harness({ mode: "dry" });
  const { results } = await h.run();
  assert.equal(h.fake.clicks.length, 0);
  assert.equal(h.fake.dialogs().length, 0);
  for (const entry of results) assert.equal(entry.status, driver.WEALTH_STATUS.DRY_ROW_MISSING, JSON.stringify(entry));
  h.fake.show("wealth_reconciliation");
  assert.equal(h.fake.rowsWithId("7051").length, 0);
});

test("dry: rows that already exist are checked with a dry-run fill, not written", async () => {
  const live = harness();
  await live.run([FIELDS.rent]);
  const dry = harness({ mode: "dry", iris: live.fake });
  const clicksBefore = live.fake.clicks.length;
  const { results } = await dry.run([{ ...FIELDS.rent, value: "123" }]);
  assert.equal(live.fake.clicks.length, clicksBefore);
  assert.equal(results[0].dryRun, true);
  live.fake.show("wealth_reconciliation");
  assert.equal(live.fake.inputValue(live.fake.row("7051")), "960000", "dry run must not write");
});

// ── failures stop the step and are reported ────────────────────────────────
test("failure: a section that will not open leaves its figures untouched", async () => {
  const h = harness({ navigate: async () => ({ ok: false, status: "panel_not_found" }) });
  const { results } = await h.run();
  assert.ok(results.every((r) => r.status === driver.WEALTH_STATUS.SECTION_UNAVAILABLE));
  assert.equal(h.fake.clicks.length, 0);
});

test("failure: an unexpected dialog already on screen stops everything with zero clicks", async () => {
  const fake = new FakeIris({ knownIbans: KNOWN });
  const h = harness({ iris: fake, navigate: async (id) => { fake.show(id); fake.openDialog("bank"); return { ok: true, status: "switched" }; } });
  const { results } = await h.run([FIELDS.rent]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.equal(results[0].setupStatus, "unexpected_dialog_open");
  assert.equal(fake.clicks.length, 0);
});

test("failure: a category missing from the modal cancels it, adds nothing, and says why", async () => {
  const raw = fs.readFileSync(path.join(root, "test-fixtures/iris/wealth/modal-expenses.html"), "utf8");
  const doc = new JSDOM(raw);
  const card = [...doc.window.document.querySelectorAll(".source-card")].find((c) => c.querySelector("p").textContent.trim() === "Rent");
  card.remove();
  const fake = new FakeIris({ knownIbans: KNOWN, modalOverrides: { expenses: doc.serialize() } });
  const h = harness({ iris: fake });
  const { results } = await h.run([FIELDS.rent]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.match(results[0].setupStatus, /label_not_found/);
  assert.equal(fake.dialogs().length, 0, "the dialog was cancelled");
  fake.show("wealth_reconciliation");
  assert.equal(fake.rowsWithId("7051").length, 0);
});

test("failure: an IBAN IRIS cannot resolve closes the dialog and adds no bank row", async () => {
  const h = harness();
  const unknown = wf("7030", 5000, { rowDescriptionIncludes: "PK00NOPE0000000000000000" });
  const { results } = await h.run([unknown, FIELDS.hbl]);
  const r = byCode(results);
  assert.equal(r["7030@PK00NOPE0000000000000000"].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.equal(r["7030@PK00NOPE0000000000000000"].setupStatus, "bank_iban_not_resolved");
  // The next, resolvable account is still completed.
  assert.equal(r[`7030@${HBL}`].status, filler.FILL_STATUS.FILLED);
  assert.equal(h.fake.dialogs().length, 0);
  h.fake.show("wealth_assets");
  assert.equal(h.fake.rowsWithId("7030").length, 2, "summary + the resolvable bank only");
});

test("failure: if the 7098 description is not accepted nothing is saved", async () => {
  const raw = fs.readFileSync(path.join(root, "test-fixtures/iris/wealth/modal-outflow.html"), "utf8");
  const doc = new JSDOM(raw);
  doc.window.document.querySelector("textarea").setAttribute("disabled", "");
  const fake = new FakeIris({ knownIbans: KNOWN, modalOverrides: { outflow: doc.serialize() } });
  const h = harness({ iris: fake });
  const { results } = await h.run([FIELDS.outflow]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.equal(fake.dialogs().length, 0);
  assert.equal(fake.clicks.filter((c) => /^save$/i.test(c.text)).length, 0);
});

// ── packet side: the 7098 row is addressed by its description ──────────────
test("packet: the 7098 field carries the description hint so a hand-made 7098 row is never filled", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026, filerType: "INDIVIDUAL", taxpayerListStatus: null, ledgerEntries: [],
    salaryCertificateTaxWithheld: 210000,
  });
  const flat = flattenPortalFieldMap(map).filter((f) => f.irisCode === "7098");
  assert.equal(flat.length, 1);
  assert.equal(flat[0].rowDescriptionIncludes, "Income tax deducted u/s 149");
});

test("row filler: with the hint, a hand-made 7098 row is not selected, ours is", async () => {
  const h = harness();
  await h.run([FIELDS.outflow]);
  h.fake.show("wealth_reconciliation");
  // Simulate the taxpayer adding their own 7098 row with different text.
  const mine = h.fake.rowsWithId("7098")[1].cloneNode(true);
  mine.querySelector(".row-description-text").textContent = "Adjustments in Outflows - Something else";
  mine.querySelector(".data-middle-child-wapper input").value = "";
  h.fake.rowsWithId("7098")[1].after(mine);
  const out = await filler.fillIrisRows(h.fake, [{ ...FIELDS.outflow }], { dryRun: false, sectionVerified: true });
  assert.equal(out.results[0].status, filler.FILL_STATUS.ALREADY_CORRECT);
  assert.equal(mine.querySelector(".data-middle-child-wapper input").value, "", "their row stays empty");
});
