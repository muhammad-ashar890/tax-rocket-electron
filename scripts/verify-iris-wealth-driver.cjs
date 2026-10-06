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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const driver = require("../electron-connect/iris-wealth-driver.js");
const filler = require("../electron-connect/iris-row-filler.js");
const { FakeIris } = require("./lib/fake-iris-wealth.cjs");
const { WEALTH_EXPENSE_ROWS } = require(
  path.join(root, "lib/tax/wealth-rows.ts"),
);
const { buildPortalFieldMap, flattenPortalFieldMap } = require(
  path.join(root, "lib/tax/portal-field-map.ts"),
);

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

function harness({ mode = "live", fields, iris, navigate, cashStore } = {}) {
  const fake = iris || new FakeIris({ knownIbans: KNOWN });
  const steps = [];
  const options = {
    mode,
    cashStore,
    navigate:
      navigate ||
      (async (sectionId) => {
        fake.show(sectionId);
        return { ok: true, status: "switched" };
      }),
    fillRows: (group, opts) =>
      filler.fillIrisRows(
        fake,
        group.map((f) => ({ ...f })),
        { dryRun: opts.dryRun, sectionVerified: true },
      ),
    onStep: (step, detail) => steps.push({ step, detail }),
    sleep: () => new Promise((r) => setTimeout(r, 2)),
    timeoutMs: 80,
  };
  return {
    fake,
    steps,
    run: (list) =>
      driver.runWealthDriver(fake, list || Object.values(FIELDS), options),
    runStepwise: (list, extra = {}) =>
      driver.runWealthDriverStepwise(fake, list || Object.values(FIELDS), {
        ...options,
        isSuccess: (status) => filler.SUCCESS_STATUSES.has(status),
        ...extra,
      }),
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
    FIELDS.rent,
    FIELDS.outflow,
    FIELDS.hbl,
    wf("7030", 5),
    wf("7012", 9),
    wf("7089", 1),
  ]);
  assert.deepEqual(
    plan.expenses.map((f) => f.irisCode),
    ["7051"],
  );
  assert.deepEqual(
    plan.outflows.map((f) => f.irisCode),
    ["7098"],
  );
  assert.deepEqual(
    plan.banks.map((f) => f.irisCode),
    ["7030"],
  );
  assert.deepEqual(plan.unsupported.map((f) => f.irisCode).sort(), [
    "7012",
    "7030",
    "7089",
  ]);
});

test("drift guard: the driver's expense labels equal lib/tax/wealth-rows.ts", () => {
  const ts = Object.fromEntries(
    Object.entries(WEALTH_EXPENSE_ROWS).map(([c, v]) => [c, v.label]),
  );
  assert.deepEqual({ ...driver.EXPENSE_ROWS }, ts);
});

test("drift guard: dialog titles and labels are the ones in the captured modals", () => {
  const titleOf = (name) => {
    const html = fs.readFileSync(
      path.join(root, "test-fixtures/iris/wealth", name),
      "utf8",
    );
    return new JSDOM(html).window.document
      .querySelector("[mat-dialog-title] .left")
      .textContent.trim();
  };
  assert.equal(titleOf("modal-expenses.html"), driver.DIALOG_TITLES.expenses);
  assert.equal(
    titleOf("modal-financial-assets.html"),
    driver.DIALOG_TITLES.financialAssets,
  );
  assert.equal(titleOf("modal-outflow.html"), driver.DIALOG_TITLES.outflow);
  assert.equal(titleOf("modal-bank.html"), driver.DIALOG_TITLES.bank);
  assert.equal(titleOf("modal-gift.html"), driver.DIALOG_TITLES.gift);
  const html = fs.readFileSync(
    path.join(root, "test-fixtures/iris/wealth/modal-expenses.html"),
    "utf8",
  );
  const doc = new JSDOM(html).window.document;
  const labels = [...doc.querySelectorAll(".source-card p")].map((p) =>
    p.textContent.trim(),
  );
  assert.deepEqual(labels.sort(), Object.values(driver.EXPENSE_ROWS).sort());
});

test("safety: the only clicks the driver can request are on the documented surface", () => {
  const bad = [
    { op: "click", selector: "button" },
    { op: "open_section_add", rowId: "7089", label: "Save" },
    { op: "open_section_add", rowId: "7012", label: "+ Assets" },
    { op: "open_row_add", rowId: "7012" },
    { op: "open_row_add", rowId: "7089" },
    { op: "open_row_add", rowId: "7091" }, // Gift GIVEN (outflow): never used
    { op: "open_row_add", rowId: "7035" },
    { op: "open_row_add", rowId: "7036" },
    { op: "dialog_click", title: "Gift", button: "ADD" },
    { op: "dialog_click", title: "Gift", button: "Delete" },
    { op: "dialog_set", title: "Gift", field: "iban", value: "x" },
    { op: "dialog_set", title: "Bank Account", field: "donor_id", value: "x" },
    { op: "dialog_tick", title: "Gift", labels: ["Rent"] },
    { op: "dialog_click", title: "Adjustments in Outflows", button: "ADD" },
    { op: "dialog_click", title: "Add Personal Expenses", button: "SAVE" },
    { op: "dialog_click", title: "Bank Account", button: "Submit" },
    { op: "dialog_click", title: "Payment Confirmation", button: "ADD" },
    {
      op: "dialog_tick",
      title: "Add Personal Expenses",
      labels: ["Delete everything"],
    },
    {
      op: "dialog_tick",
      title: "Add Financial Assets & Investments (Non-Business)",
      labels: ["Investments / Stocks / Bonds / etc."],
    },
    { op: "dialog_tick", title: "Bank Account", labels: ["Joint Account"] },
    {
      op: "dialog_set",
      title: "Add Personal Expenses",
      field: "description",
      value: "x",
    },
    { op: "dialog_search", title: "Adjustments in Outflows" },
  ];
  for (const step of bad)
    assert.throws(
      () => driver.buildPageScript(step),
      /wealth driver/,
      JSON.stringify(step),
    );
  const good = [
    { op: "inspect", codes: ["7098"] },
    { op: "open_section_add", rowId: "7089", label: "+ Expenses" },
    { op: "open_section_add", rowId: "999901", label: "+ Assets" },
    { op: "open_row_add", rowId: "7098" },
    { op: "open_row_add", rowId: "7030" },
    { op: "open_row_add", rowId: "7037" },
    {
      op: "dialog_set",
      title: "Gift",
      field: "donor_id",
      value: "4220180718935",
    },
    {
      op: "dialog_set",
      title: "Gift",
      field: "description",
      value: "Gift received",
    },
    { op: "dialog_search", title: "Gift" },
    { op: "dialog_click", title: "Gift", button: "SAVE" },
    { op: "dialog_click", title: "Gift", button: "CLOSE" },
    { op: "dialog_click", title: "Adjustments in Outflows", button: "SAVE" },
    { op: "dialog_click", title: "Bank Account", button: "ADD" },
    { op: "dialog_tick", title: "Add Personal Expenses", labels: ["Rent"] },
    {
      op: "dialog_tick",
      title: "Add Financial Assets & Investments (Non-Business)",
      labels: ["Bank Account(s)"],
    },
  ];
  for (const step of good)
    assert.doesNotThrow(
      () => driver.buildPageScript(step),
      JSON.stringify(step),
    );
});

test("page op: the add icon is the purple one on the summary row, never edit (orange) or delete (red)", async () => {
  const fake = new FakeIris({ knownIbans: KNOWN });
  fake.show("wealth_reconciliation");
  // Use the capture that already has a child 7098 row carrying orange + red icons.
  const full = new JSDOM(
    fs.readFileSync(
      path.join(
        root,
        "test-fixtures/iris/wealth/reconciliation-with-expenses-and-outflow.html",
      ),
      "utf8",
    ),
  ).window.document;
  fake.container().innerHTML = full.querySelector(".iris-data").innerHTML;
  const r = await fake.webContents.executeJavaScript(
    driver.buildPageScript({ op: "open_row_add", rowId: "7098" }),
  );
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
  const r = await fake.webContents.executeJavaScript(
    driver.buildPageScript({
      op: "open_section_add",
      rowId: "7089",
      label: "+ Expenses",
    }),
  );
  assert.equal(r.status, "dialog_already_open");
  assert.equal(fake.clicks.length, before);
});

// ── live runs ──────────────────────────────────────────────────────────────
test("live: expenses, the outflow and two banks are created through their modals and filled", async () => {
  const h = harness();
  const { results } = await h.run();
  const r = byCode(results);
  for (const key of [
    "7051",
    "7058",
    "7055",
    "7087",
    "7098",
    `7030@${HBL}`,
    `7030@${SCB}`,
  ]) {
    assert.equal(
      r[key].status,
      filler.FILL_STATUS.FILLED,
      `${key}: ${JSON.stringify(r[key])}`,
    );
  }
  // Values landed on the right rows.
  h.fake.show("wealth_reconciliation");
  assert.equal(h.fake.inputValue(h.fake.row("7051")), "960000");
  assert.equal(h.fake.inputValue(h.fake.row("7058")), "180000");
  assert.equal(h.fake.inputValue(h.fake.row("7055")), "240000");
  assert.equal(h.fake.inputValue(h.fake.row("7087")), "1080000");
  const outflowChild = h.fake.rowsWithId("7098")[1];
  assert.match(
    outflowChild.querySelector(".row-description-text").textContent,
    /Income tax deducted u\/s 149/,
  );
  assert.equal(h.fake.inputValue(outflowChild), "210000");
  assert.equal(
    h.fake.inputValue(h.fake.rowsWithId("7098")[0]),
    "",
    "the summary row is never written",
  );
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
      (/Calculate|Save|Submit/i.test(c.text) && !c.inDialog) ||
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
    (c) =>
      (/Calculate|Save|Submit/i.test(c.text) && !c.inDialog) ||
      ["calc", "save", "submit"].includes(c.id),
  );
  assert.equal(caught.length, 1);
});

test("live: ticks only what the packet needs", async () => {
  const h = harness({});
  await h.run([FIELDS.rent, FIELDS.electricity]);
  h.fake.show("wealth_reconciliation");
  const codes =
    h.fake.container() &&
    [...h.fake.container().querySelectorAll(".tableRows[id]")].map((r) => r.id);
  assert.ok(codes.includes("7051") && codes.includes("7058"));
  for (const other of ["7055", "7087", "7070", "7061"])
    assert.ok(!codes.includes(other), `${other} must not be added`);
});

test("live: a second run clicks nothing and reports already_correct", async () => {
  const h = harness();
  await h.run();
  const clicksBefore = h.fake.clicks.length;
  const second = await h.run();
  assert.equal(h.fake.clicks.length, clicksBefore, "no new clicks on a re-run");
  for (const entry of second.results)
    assert.equal(
      entry.status,
      filler.FILL_STATUS.ALREADY_CORRECT,
      JSON.stringify(entry),
    );
});

test("live: a figure IRIS already holds is not overwritten", async () => {
  const h = harness();
  await h.run([FIELDS.rent]);
  h.fake.show("wealth_reconciliation");
  const input = h.fake
    .row("7051")
    .querySelector(".data-middle-child-wapper input");
  input.value = "111";
  const again = await h.run([{ ...FIELDS.rent, value: "960000" }]);
  assert.equal(
    again.results[0].status,
    filler.FILL_STATUS.OVERWRITE_NEEDS_CONFIRMATION,
  );
  assert.equal(input.value, "111");
});

// ── dry runs ───────────────────────────────────────────────────────────────
test("dry: nothing is clicked inside the page; missing rows are reported, not created", async () => {
  const h = harness({ mode: "dry" });
  const { results } = await h.run();
  assert.equal(h.fake.clicks.length, 0);
  assert.equal(h.fake.dialogs().length, 0);
  for (const entry of results)
    assert.equal(
      entry.status,
      driver.WEALTH_STATUS.DRY_ROW_MISSING,
      JSON.stringify(entry),
    );
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
  assert.equal(
    live.fake.inputValue(live.fake.row("7051")),
    "960000",
    "dry run must not write",
  );
});

// ── failures stop the step and are reported ────────────────────────────────
test("failure: a section that will not open leaves its figures untouched", async () => {
  const h = harness({
    navigate: async () => ({ ok: false, status: "panel_not_found" }),
  });
  const { results } = await h.run();
  assert.ok(
    results.every((r) => r.status === driver.WEALTH_STATUS.SECTION_UNAVAILABLE),
  );
  assert.equal(h.fake.clicks.length, 0);
});

test("failure: an unexpected dialog already on screen stops everything with zero clicks", async () => {
  const fake = new FakeIris({ knownIbans: KNOWN });
  const h = harness({
    iris: fake,
    navigate: async (id) => {
      fake.show(id);
      fake.openDialog("bank");
      return { ok: true, status: "switched" };
    },
  });
  const { results } = await h.run([FIELDS.rent]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.equal(results[0].setupStatus, "unexpected_dialog_open");
  assert.equal(fake.clicks.length, 0);
});

test("failure: a category missing from the modal cancels it, adds nothing, and says why", async () => {
  const raw = fs.readFileSync(
    path.join(root, "test-fixtures/iris/wealth/modal-expenses.html"),
    "utf8",
  );
  const doc = new JSDOM(raw);
  const card = [...doc.window.document.querySelectorAll(".source-card")].find(
    (c) => c.querySelector("p").textContent.trim() === "Rent",
  );
  card.remove();
  const fake = new FakeIris({
    knownIbans: KNOWN,
    modalOverrides: { expenses: doc.serialize() },
  });
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
  const unknown = wf("7030", 5000, {
    rowDescriptionIncludes: "PK00NOPE0000000000000000",
  });
  const { results } = await h.run([unknown, FIELDS.hbl]);
  const r = byCode(results);
  assert.equal(
    r["7030@PK00NOPE0000000000000000"].status,
    driver.WEALTH_STATUS.SETUP_FAILED,
  );
  assert.equal(
    r["7030@PK00NOPE0000000000000000"].setupStatus,
    "bank_iban_not_resolved",
  );
  // The next, resolvable account is still completed.
  assert.equal(r[`7030@${HBL}`].status, filler.FILL_STATUS.FILLED);
  assert.equal(h.fake.dialogs().length, 0);
  h.fake.show("wealth_assets");
  assert.equal(
    h.fake.rowsWithId("7030").length,
    2,
    "summary + the resolvable bank only",
  );
});

test("failure: if the 7098 description is not accepted nothing is saved", async () => {
  const raw = fs.readFileSync(
    path.join(root, "test-fixtures/iris/wealth/modal-outflow.html"),
    "utf8",
  );
  const doc = new JSDOM(raw);
  doc.window.document.querySelector("textarea").setAttribute("disabled", "");
  const fake = new FakeIris({
    knownIbans: KNOWN,
    modalOverrides: { outflow: doc.serialize() },
  });
  const h = harness({ iris: fake });
  const { results } = await h.run([FIELDS.outflow]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.equal(fake.dialogs().length, 0);
  assert.equal(fake.clicks.filter((c) => /^save$/i.test(c.text)).length, 0);
});

// ── packet side: the 7098 row is addressed by its description ──────────────
test("packet: the 7098 field carries the description hint so a hand-made 7098 row is never filled", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "INDIVIDUAL",
    taxpayerListStatus: null,
    ledgerEntries: [],
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
  mine.querySelector(".row-description-text").textContent =
    "Adjustments in Outflows - Something else";
  mine.querySelector(".data-middle-child-wapper input").value = "";
  h.fake.rowsWithId("7098")[1].after(mine);
  const out = await filler.fillIrisRows(h.fake, [{ ...FIELDS.outflow }], {
    dryRun: false,
    sectionVerified: true,
  });
  assert.equal(out.results[0].status, filler.FILL_STATUS.ALREADY_CORRECT);
  assert.equal(
    mine.querySelector(".data-middle-child-wapper input").value,
    "",
    "their row stays empty",
  );
});

// ── Cash in hand (7012): a movement added to IRIS's own figure ─────────────
const CASH = (delta) => wf("7012", delta, { valueMode: "add_to_iris_value" });
function memoryStore(initial = null) {
  const store = {
    record: initial,
    saves: 0,
    load: () => store.record,
    save: (record) => {
      store.record = { ...record };
      store.saves += 1;
    },
  };
  return store;
}
function cashCell(h) {
  h.fake.show("wealth_assets");
  return h.fake.row("7012").querySelector(".data-middle-child-wapper input");
}
function prefillCash(h, value) {
  const input = cashCell(h);
  input.value = value;
  return input;
}

test("cash planning: only a 7012 field marked add_to_iris_value is driven; a bare 7012 stays held", () => {
  const plan = driver.planWealthWork([CASH(50000), wf("7012", 9)]);
  assert.deepEqual(
    plan.cash.map((f) => f.value),
    ["50000"],
  );
  assert.deepEqual(
    plan.unsupported.map((f) => f.irisCode),
    ["7012"],
  );
});

test("cash target: baseline plus movement; own earlier write is recognised; a foreign edit is refused", () => {
  const plan = (current, record, delta = 50000) =>
    driver.planCashTarget({ delta, current, record });
  assert.deepEqual(plan("1,300,000", null), {
    action: "write",
    baseline: 1300000,
    target: 1350000,
    replaceOnlyIfExisting: "1300000",
  });
  assert.equal(plan("", null).target, 50000);
  assert.equal(plan("", null).replaceOnlyIfExisting, undefined);
  const record = { existing: 1300000, written: 1350000 };
  assert.equal(
    plan("1350000", record).target,
    1350000,
    "own write: same target, not 1,400,000",
  );
  assert.equal(
    plan("1300000", record).target,
    1350000,
    "write never landed: same baseline",
  );
  assert.equal(
    plan("1350000", record, 80000).target,
    1380000,
    "a changed movement is re-based",
  );
  assert.equal(plan("999", record).action, "conflict");
  assert.equal(plan("3", null, -5).action, "negative");
  assert.equal(plan("12abc", null).action, "unreadable");
});

test("live cash: adds the movement to the figure IRIS holds and remembers the baseline", async () => {
  const store = memoryStore();
  const h = harness({ cashStore: store });
  const input = prefillCash(h, "1,300,000");
  const out = await h.run([CASH(50000)]);
  assert.equal(out.results.length, 1);
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.FILLED,
    JSON.stringify(out.results[0]),
  );
  assert.equal(input.value, "1350000");
  assert.equal(out.results[0].baselineValue, 1300000);
  assert.deepEqual(
    {
      existing: store.record.existing,
      written: store.record.written,
      delta: store.record.delta,
    },
    { existing: 1300000, written: 1350000, delta: 50000 },
  );
});

test("live cash: a re-run does not add the movement twice", async () => {
  const store = memoryStore();
  const h = harness({ cashStore: store });
  const input = prefillCash(h, "1300000");
  await h.run([CASH(50000)]);
  const again = await h.run([CASH(50000)]);
  assert.equal(
    again.results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(again.results[0]),
  );
  assert.equal(input.value, "1350000");
  assert.equal(store.record.existing, 1300000);
});

test("live cash: a changed movement is re-based on the original IRIS figure", async () => {
  const store = memoryStore();
  const h = harness({ cashStore: store });
  const input = prefillCash(h, "1300000");
  await h.run([CASH(50000)]);
  const again = await h.run([CASH(80000)]);
  assert.equal(
    again.results[0].status,
    filler.FILL_STATUS.FILLED,
    JSON.stringify(again.results[0]),
  );
  assert.equal(input.value, "1380000");
  assert.equal(store.record.written, 1380000);
});

test("live cash: a figure the taxpayer edited after our write is never overwritten", async () => {
  const store = memoryStore();
  const h = harness({ cashStore: store });
  const input = prefillCash(h, "1300000");
  await h.run([CASH(50000)]);
  input.value = "999";
  const again = await h.run([CASH(50000)]);
  assert.equal(
    again.results[0].status,
    filler.FILL_STATUS.OVERWRITE_NEEDS_CONFIRMATION,
  );
  assert.equal(input.value, "999");
  assert.equal(
    store.record.written,
    1350000,
    "the baseline is not rewritten on a conflict",
  );
});

test("live cash: without a saved baseline the figure on screen is the baseline", async () => {
  const h = harness({ cashStore: memoryStore() });
  const input = prefillCash(h, "200000");
  const out = await h.run([CASH(-50000)]);
  assert.equal(out.results[0].status, filler.FILL_STATUS.FILLED);
  assert.equal(input.value, "150000", "net deposits lower the figure");
});

test("live cash: a movement that would make cash negative is refused and nothing is typed", async () => {
  const store = memoryStore();
  const h = harness({ cashStore: store });
  const input = prefillCash(h, "20000");
  const out = await h.run([CASH(-50000)]);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.CASH_NEGATIVE);
  assert.equal(input.value, "20000");
  assert.equal(store.saves, 0);
});

test("dry cash: reports the planned figure, types nothing, saves nothing", async () => {
  const store = memoryStore();
  const h = harness({ mode: "dry", cashStore: store });
  const input = prefillCash(h, "1300000");
  const out = await h.run([CASH(50000)]);
  assert.equal(out.results[0].plannedValue, "1350000");
  assert.equal(input.value, "1300000");
  assert.equal(store.saves, 0);
});

test("cash: the 7012 row is missing -> reported by the row filler, nothing created", async () => {
  const h = harness({ cashStore: memoryStore() });
  h.fake.show("wealth_assets");
  h.fake.row("7012").remove();
  const out = await h.run([CASH(50000)]);
  assert.notEqual(out.results[0].status, filler.FILL_STATUS.FILLED);
});

test("cash: the packet emits a 7012 movement field, and nothing when the movement is zero", () => {
  const base = {
    taxYear: 2026,
    filerType: "INDIVIDUAL",
    taxpayerListStatus: "ACTIVE",
    ledgerEntries: [],
  };
  const withCash = buildPortalFieldMap({ ...base, netCashMovement: 50000 });
  const field = withCash.wealthFields.find((f) => f.irisCode === "7012");
  assert.equal(field.ourAmount, 50000);
  assert.equal(field.valueMode, "add_to_iris_value");
  const flat = flattenPortalFieldMap(withCash).find(
    (f) => f.irisCode === "7012",
  );
  assert.equal(flat.valueMode, "add_to_iris_value");
  assert.equal(flat.value, "50000");
  const deposit = buildPortalFieldMap({ ...base, netCashMovement: -12000 });
  assert.equal(
    deposit.wealthFields.find((f) => f.irisCode === "7012").ourAmount,
    -12000,
  );
  for (const none of [0, null, undefined])
    assert.ok(
      !buildPortalFieldMap({
        ...base,
        netCashMovement: none,
      }).wealthFields.some((f) => f.irisCode === "7012"),
    );
});

test("live cash: an unreadable saved baseline stops the step instead of guessing", async () => {
  const broken = {
    load: () => {
      throw new Error("corrupt");
    },
    save: () => {
      throw new Error("no");
    },
  };
  const h = harness({ cashStore: broken });
  const input = prefillCash(h, "1350000");
  const out = await h.run([CASH(50000)]);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.CASH_UNREADABLE);
  assert.equal(input.value, "1350000");
});

// ── 7037 Gift ──────────────────────────────────────────────────────────────
const DONOR = "4220180718935";
const DONOR_NAME = "MUHAMMAD ASHAR";
const GIFT_TEXT = `Gift received on 2026-01-15 from ${DONOR}`;
const giftField = (value = 65000, extra = {}) =>
  wf("7037", value, {
    ourCategory: "GIFT_RECEIVED",
    giftDonorId: DONOR,
    giftDescription: GIFT_TEXT,
    rowDescriptionIncludes: GIFT_TEXT,
    ...extra,
  });
const giftHarness = (opts = {}) =>
  harness({
    ...opts,
    iris: new FakeIris({
      knownIbans: KNOWN,
      knownDonors: { [DONOR]: DONOR_NAME, 4220100000001: "SECOND DONOR" },
    }),
  });

test("gift planning: only a gift with a donor id and a description hint is driven", () => {
  const plan = driver.planWealthWork([
    giftField(),
    wf("7037", 5), // no donor
    wf("7037", 5, { giftDonorId: DONOR }), // no description hint
    wf("7091", 5), // gifts GIVEN
  ]);
  assert.equal(plan.gifts.length, 1);
  assert.deepEqual(plan.unsupported.map((f) => f.irisCode).sort(), [
    "7037",
    "7037",
    "7091",
  ]);
});

test("live gift: the dialog is completed through the donor search, saved, and the amount lands on the child row", async () => {
  const h = giftHarness();
  const { results } = await h.run([giftField()]);
  assert.equal(results.length, 1);
  assert.equal(
    results[0].status,
    filler.FILL_STATUS.FILLED,
    JSON.stringify(results[0]),
  );
  h.fake.show("wealth_reconciliation");
  const rows = h.fake.rowsWithId("7037");
  assert.equal(rows.length, 2, "summary + one child");
  assert.equal(
    h.fake.inputValue(rows[0]),
    "",
    "the summary row is never written",
  );
  assert.equal(
    rows[1].querySelector(".row-description-text").textContent,
    `Gift - ${DONOR} - ${DONOR_NAME} - ${GIFT_TEXT}`,
  );
  assert.equal(h.fake.inputValue(rows[1]), "65000");
  assert.equal(h.fake.dialogs().length, 0);
  // Search was pressed before SAVE.
  const labels = h.fake.clicks.map((c) => c.text.toLowerCase());
  const search = h.fake.clicks.findIndex(
    (c) => c.inDialog && /search/i.test(c.text),
  );
  const save = labels.lastIndexOf("save");
  assert.ok(search >= 0 && save > search, "search must come before SAVE");
});

test("live gift: only the add icon, search, and the dialog's own SAVE are clicked; 7091 and the other inflow rows are untouched", async () => {
  const h = giftHarness();
  await h.run([giftField()]);
  const forbidden = h.fake.clicks.filter(
    (c) =>
      (/Calculate|Save|Submit/i.test(c.text) && !c.inDialog) ||
      /btn-red|btn-orange|btn-section-delete/.test(c.cls) ||
      ["calc", "save", "submit"].includes(c.id) ||
      (c.rowId && !c.inDialog && c.rowId !== "7037"),
  );
  assert.deepEqual(forbidden, []);
  const saves = h.fake.clicks.filter((c) => /^save$/i.test(c.text));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].inDialog, true);
});

test("live gift: a re-run clicks nothing and reports already_correct", async () => {
  const h = giftHarness();
  await h.run([giftField()]);
  h.fake.clicks.length = 0;
  const { results } = await h.run([giftField()]);
  assert.equal(
    results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(results[0]),
  );
  assert.equal(h.fake.clicks.length, 0);
  h.fake.show("wealth_reconciliation");
  assert.equal(h.fake.rowsWithId("7037").length, 2, "no duplicate child row");
});

test("live gift: a changed amount on an existing gift row pauses with a conflict instead of overwriting", async () => {
  const h = giftHarness();
  await h.run([giftField(65000)]);
  const { results } = await h.run([giftField(70000)]);
  assert.equal(
    results[0].status,
    filler.FILL_STATUS.OVERWRITE_NEEDS_CONFIRMATION,
    JSON.stringify(results[0]),
  );
  h.fake.show("wealth_reconciliation");
  assert.equal(h.fake.inputValue(h.fake.rowsWithId("7037")[1]), "65000");
});

test("live gift: two donors become two rows, each with its own amount", async () => {
  const h = giftHarness();
  const second = giftField(30000, {
    giftDonorId: "4220100000001",
    giftDescription: "Gift received on 2026-02-01 from 4220100000001",
    rowDescriptionIncludes: "Gift received on 2026-02-01 from 4220100000001",
    key: "7037:second",
  });
  const first = giftField(65000, { key: "7037:first" });
  const { results } = await h.run([first, second]);
  assert.deepEqual(
    results.map((r) => r.status),
    [filler.FILL_STATUS.FILLED, filler.FILL_STATUS.FILLED],
  );
  h.fake.show("wealth_reconciliation");
  const rows = h.fake.rowsWithId("7037");
  assert.equal(rows.length, 3);
  assert.equal(h.fake.inputValue(rows[1]), "65000");
  assert.equal(h.fake.inputValue(rows[2]), "30000");
});

test("dry gift: nothing is clicked; the missing row is reported", async () => {
  const h = giftHarness({ mode: "dry" });
  const { results } = await h.run([giftField()]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
  assert.equal(results[0].setupStatus, "gift_row_needs_modal");
  assert.equal(h.fake.clicks.length, 0);
});

test("failure: a donor id IRIS cannot resolve closes the dialog, saves nothing and says why", async () => {
  const h = giftHarness();
  const unknown = giftField(65000, {
    giftDonorId: "4220199999999",
    giftDescription: "Gift received on 2026-01-15 from 4220199999999",
    rowDescriptionIncludes: "Gift received on 2026-01-15 from 4220199999999",
  });
  const { results } = await h.run([unknown]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.equal(results[0].setupStatus, "gift_donor_not_resolved");
  assert.equal(h.fake.dialogs().length, 0);
  assert.equal(h.fake.clicks.filter((c) => /^save$/i.test(c.text)).length, 0);
  h.fake.show("wealth_reconciliation");
  assert.equal(h.fake.rowsWithId("7037").length, 1, "no child row was created");
  assert.ok(h.steps.some((s) => s.step === "wealth_gift_donor_unresolved"));
});

test("failure: a description IRIS does not accept closes the dialog without saving", async () => {
  const raw = fs.readFileSync(
    path.join(root, "test-fixtures/iris/wealth/modal-gift.html"),
    "utf8",
  );
  const dom = new JSDOM(raw);
  dom.window.document.querySelector("textarea").setAttribute("disabled", "");
  const fake = new FakeIris({
    knownIbans: KNOWN,
    knownDonors: { [DONOR]: DONOR_NAME },
    modalOverrides: { gift: dom.serialize() },
  });
  const h = harness({ iris: fake });
  const { results } = await h.run([giftField()]);
  assert.equal(results[0].status, driver.WEALTH_STATUS.SETUP_FAILED);
  assert.match(results[0].setupStatus, /^gift_description_/);
  assert.equal(fake.dialogs().length, 0);
  assert.equal(fake.clicks.filter((c) => /^save$/i.test(c.text)).length, 0);
});

test("gift: a hand-made gift row for another description is not filled; ours is created", async () => {
  const fake = new FakeIris({
    knownIbans: KNOWN,
    knownDonors: { [DONOR]: DONOR_NAME },
  });
  fake.show("wealth_reconciliation");
  const hand = fake.cloneTemplate(fake.giftChild);
  hand.querySelector(".row-description-text").textContent =
    "Gift - 4220100000001 - OTHER - by hand";
  fake.insertAfter(hand, fake.row("7037"));
  const h = harness({ iris: fake });
  const { results } = await h.run([giftField()]);
  assert.equal(results[0].status, filler.FILL_STATUS.FILLED);
  const rows = fake.rowsWithId("7037");
  assert.equal(rows.length, 3);
  assert.equal(fake.inputValue(rows[1]), "", "the hand-made row stays empty");
  assert.equal(fake.inputValue(rows[2]), "65000");
});

// ── regression from the first live gift run: Assets would not open after a refused donor ──
test("gift refused by IRIS, then Assets: the dialog is gone first, and the bank accounts are still filled", async () => {
  const h = giftHarness();
  const unknown = giftField(15000, {
    giftDonorId: "4220180715236",
    giftDescription: "Gift received on 2025-10-20 from 4220180715236",
    rowDescriptionIncludes: "Gift received on 2025-10-20 from 4220180715236",
  });
  const { results } = await h.run([unknown, FIELDS.hbl]);
  const r = byCode(results);
  assert.equal(r["7037"].setupStatus, "gift_donor_not_resolved");
  assert.equal(r[`7030@${HBL}`].status, filler.FILL_STATUS.FILLED);
  assert.equal(h.fake.dialogs().length, 0);
});

test("navigation: 'document not open' is IRIS still rendering, so it is retried a few times, then reported", async () => {
  let calls = 0;
  const fake = new FakeIris({ knownIbans: KNOWN });
  const flaky = harness({
    iris: fake,
    navigate: async (sectionId) => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: "document_not_open" };
      fake.show(sectionId);
      return { ok: true, status: "switched" };
    },
  });
  const { results } = await flaky.run([FIELDS.hbl]);
  assert.equal(calls, 3, "two transient failures, then success");
  assert.equal(results[0].status, filler.FILL_STATUS.FILLED);
  assert.ok(flaky.steps.some((s) => s.step === "wealth_section_retry"));

  let always = 0;
  const stuck = harness({
    iris: new FakeIris({ knownIbans: KNOWN }),
    navigate: async () => {
      always += 1;
      return { ok: false, status: "document_not_open" };
    },
  });
  const out = await stuck.run([FIELDS.hbl]);
  assert.equal(always, 4, "bounded: four attempts in all");
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.SECTION_UNAVAILABLE);

  let hard = 0;
  const refused = harness({
    iris: new FakeIris({ knownIbans: KNOWN }),
    navigate: async () => {
      hard += 1;
      return { ok: false, status: "unsupported_section" };
    },
  });
  await refused.run([FIELDS.hbl]);
  assert.equal(hard, 1, "a real refusal is never retried");
});

// ── one figure at a time, stopping at the first problem ─────────────────────
test("stepwise: with nothing wrong it enters every figure, with the same outcome as the all-at-once run", async () => {
  const batch = harness();
  const all = await batch.run();
  const step = harness();
  const out = await step.runStepwise();
  assert.equal(out.stopped, false);
  assert.equal(out.notAttempted, 0);
  const status = (results) =>
    Object.fromEntries(
      Object.entries(byCode(results)).map(([k, v]) => [k, v.status]),
    );
  assert.deepEqual(status(out.results), status(all.results));
  assert.ok(
    Object.values(status(out.results)).every(
      (v) => v === filler.FILL_STATUS.FILLED,
    ),
  );
  // Nothing may be saved, calculated or submitted either way.
  assert.equal(
    step.fake.clicks.filter((c) => /^(calculate|submit)$/i.test(c.text)).length,
    0,
  );
});

test("stepwise: it stops at the first figure IRIS refuses and does not touch anything after it", async () => {
  const h = giftHarness();
  const unknown = giftField(15000, {
    giftDonorId: "4220180715236",
    giftDescription: "Gift received on 2025-10-20 from 4220180715236",
    rowDescriptionIncludes: "Gift received on 2025-10-20 from 4220180715236",
  });
  const out = await h.runStepwise([FIELDS.hbl, unknown, FIELDS.scb]);
  // Order is expenses, outflow, gifts, banks: the gift comes first and stops the run.
  assert.equal(out.stopped, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].setupStatus, "gift_donor_not_resolved");
  assert.equal(out.notAttempted, 2);
  assert.equal(h.fake.dialogs().length, 0);
  h.fake.show("wealth_assets");
  assert.equal(
    h.fake.rowsWithId("7030").length <= 1,
    true,
    "no bank row was added after the stop",
  );
});

test("stepwise: dry mode never stops early and never clicks", async () => {
  const h = harness({ mode: "dry" });
  const out = await h.runStepwise(undefined, { stopOnProblem: false });
  assert.equal(out.stopped, false);
  assert.equal(out.results.length, Object.keys(FIELDS).length);
  assert.equal(
    h.fake.clicks.filter(
      (c) => c.tag === "MAT-ICON" || /^(save|add)$/i.test(c.text),
    ).length,
    0,
  );
});

// ── a gift the taxpayer typed by hand is READ back, never written ─────────
function handGift(
  fake,
  {
    id = "7037",
    donor = DONOR,
    name = DONOR_NAME,
    amount = "65000",
    text = "gift",
  } = {},
) {
  fake.show("wealth_reconciliation");
  const child = fake.cloneTemplate(fake.giftChild);
  child.id = id;
  child.querySelector(".row-description-text").textContent =
    `Gift - ${donor} - ${name} - ${text}`;
  const input = child.querySelector("input");
  if (input) input.value = amount;
  fake.insertAfter(child, fake.row(id));
  return child;
}
const verifyOpts = {
  verifyOnly: () => true,
  checkEntry: (entry) =>
    entry.status === "already_correct"
      ? { ...entry, takenOverChecked: true }
      : entry,
};

test("verify a hand-typed gift: right row under Inflows > Gift, right amount -> read back as matching, nothing clicked", async () => {
  const h = giftHarness();
  handGift(h.fake);
  h.fake.clicks.length = 0;
  const out = await h.runStepwise([giftField()], verifyOpts);
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(out.results[0]),
  );
  assert.equal(out.results[0].takenOverChecked, true);
  assert.equal(h.fake.clicks.length, 0, "read-only");
});

test("verify a hand-typed gift: wrong amount -> reported with both figures, never overwritten", async () => {
  const h = giftHarness();
  const child = handGift(h.fake, { amount: "5000" });
  const out = await h.runStepwise([giftField()], verifyOpts);
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.OVERWRITE_NEEDS_CONFIRMATION,
  );
  assert.equal(out.stopped, true);
  assert.equal(
    h.fake.inputValue(child),
    "5000",
    "the taxpayer's figure is untouched",
  );
});

test("verify a hand-typed gift: typed under 7091 (gifts GIVEN) instead of 7037 -> not found, and the misplaced row is named", async () => {
  const h = giftHarness();
  handGift(h.fake, { id: "7091", amount: "15000" });
  const out = await h.runStepwise([giftField(15000)], verifyOpts);
  assert.equal(out.stopped, true);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
  assert.equal(out.results[0].misplacedGift.code, "7091");
  assert.equal(out.results[0].misplacedGift.value, "15000");
  assert.equal(
    h.fake.rowsWithId("7037").length,
    1,
    "no 7037 child was created",
  );
  assert.equal(h.fake.dialogs().length, 0);
});

test("verify a hand-typed gift: nothing typed anywhere -> not found, no misplaced hint", async () => {
  const h = giftHarness();
  const out = await h.runStepwise([giftField(15000)], verifyOpts);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
  assert.equal(out.results[0].misplacedGift, undefined);
});

// ── IRIS only accepts donors it knows, so a hand-typed gift may carry another
//    donor number than the statement. Place and amount decide; the donor is reported.
const OTHER_DONOR = "4220144218163";

test("verify a hand-typed gift: another donor number, right place, right amount -> accepted, and the donor shown in IRIS is reported", async () => {
  const h = giftHarness();
  handGift(h.fake, {
    donor: OTHER_DONOR,
    name: "SOME OTHER PERSON",
    amount: "50000",
  });
  h.fake.clicks.length = 0;
  const out = await h.runStepwise([giftField(50000)], verifyOpts);
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(out.results[0]),
  );
  assert.equal(out.results[0].takenOverChecked, true);
  assert.equal(out.results[0].giftDonorSeen, OTHER_DONOR);
  assert.equal(
    out.results[0].giftDonorId,
    DONOR,
    "the statement's donor is still the planned one",
  );
  assert.equal(h.fake.clicks.length, 0, "read-only");
});

test("verify a hand-typed gift: another donor number AND another amount -> not accepted", async () => {
  const h = giftHarness();
  handGift(h.fake, { donor: OTHER_DONOR, amount: "7000" });
  const out = await h.runStepwise([giftField(50000)], verifyOpts);
  assert.equal(out.stopped, true);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
});

test("verify a hand-typed gift: another donor number typed under 7091 with the same amount -> the misplaced row is named", async () => {
  const h = giftHarness();
  handGift(h.fake, { id: "7091", donor: OTHER_DONOR, amount: "50000" });
  const out = await h.runStepwise([giftField(50000)], verifyOpts);
  assert.equal(out.stopped, true);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
  assert.equal(out.results[0].misplacedGift.code, "7091");
  assert.equal(out.results[0].misplacedGift.value, "50000");
});

test("verify hand-typed gifts: one IRIS row is never matched to two planned gifts of the same amount", async () => {
  const h = giftHarness();
  handGift(h.fake, { donor: OTHER_DONOR, amount: "50000" });
  const second = giftField(50000, {
    giftDonorId: "4220100000001",
    giftDescription: "Gift received on 2026-02-01 from 4220100000001",
    rowDescriptionIncludes: "Gift received on 2026-02-01 from 4220100000001",
    key: "second",
  });
  const out = await h.runStepwise([giftField(50000), second], {
    ...verifyOpts,
    stopOnProblem: false,
  });
  assert.equal(out.results[0].status, filler.FILL_STATUS.ALREADY_CORRECT);
  assert.equal(
    out.results[1].status,
    driver.WEALTH_STATUS.DRY_ROW_MISSING,
    "the same row cannot count twice",
  );
});

test("a live gift is never matched by amount: the agent adds its own row", async () => {
  const h = giftHarness();
  handGift(h.fake, {
    donor: OTHER_DONOR,
    name: "SOME OTHER PERSON",
    amount: "65000",
  });
  const out = await h.runStepwise([giftField(65000)], { stopOnProblem: true });
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.FILLED,
    JSON.stringify(out.results[0]),
  );
  assert.equal(out.results[0].giftDonorSeen, undefined);
});

test("verify hand-typed gifts: two rows with the SAME donor number but different text and amounts are told apart, not read as ambiguous", async () => {
  const h = giftHarness();
  handGift(h.fake, {
    donor: OTHER_DONOR,
    name: "SOME OTHER PERSON",
    amount: "50000",
    text: "gift",
  });
  handGift(h.fake, {
    donor: OTHER_DONOR,
    name: "SOME OTHER PERSON",
    amount: "15000",
    text: "brother",
  });
  const second = giftField(15000, {
    giftDonorId: "4220100000001",
    giftDescription: "Gift received on 2026-02-01 from 4220100000001",
    rowDescriptionIncludes: "Gift received on 2026-02-01 from 4220100000001",
    key: "second",
  });
  const out = await h.runStepwise([giftField(50000), second], {
    ...verifyOpts,
    stopOnProblem: false,
  });
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(out.results[0]),
  );
  assert.equal(
    out.results[1].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(out.results[1]),
  );
  assert.equal(out.results[0].giftDonorSeen, OTHER_DONOR);
  assert.equal(out.results[1].giftDonorSeen, OTHER_DONOR);
});

// ── Same idea for bank accounts: IRIS only accepts IBANs it knows, so a
//    hand-entered account may carry another IBAN than the statement.
const OTHER_SCB = "PK71SCBL0000001303338401";
const OTHER_MEZ = "PK12MEZN0000001303338499";
const bankHandHarness = async (amount, iban) => {
  const h = harness({
    iris: new FakeIris({
      knownIbans: {
        ...KNOWN,
        [OTHER_SCB]: { title: "Someone", bank: "SCB" },
        [OTHER_MEZ]: { title: "Someone", bank: "MEZ" },
      },
    }),
  });
  // Stands in for the taxpayer typing the account in IRIS themselves.
  await h.runStepwise([wf("7030", amount, { rowDescriptionIncludes: iban })]);
  return h;
};

test("verify a hand-entered bank account: another IBAN, same bank, same amount -> accepted, IBAN shown in IRIS reported, nothing clicked", async () => {
  const h = await bankHandHarness(75000, OTHER_SCB);
  h.fake.clicks.length = 0;
  const out = await h.runStepwise(
    [wf("7030", 75000, { rowDescriptionIncludes: SCB })],
    verifyOpts,
  );
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(out.results[0]),
  );
  assert.equal(out.results[0].takenOverChecked, true);
  assert.equal(out.results[0].bankIbanSeen, OTHER_SCB);
  assert.equal(out.results[0].bankIbanPlanned, SCB);
  assert.equal(h.fake.clicks.length, 0, "read-only");
});

test("verify a hand-entered bank account: another IBAN at ANOTHER bank is not accepted", async () => {
  const h = await bankHandHarness(75000, OTHER_MEZ);
  const out = await h.runStepwise(
    [wf("7030", 75000, { rowDescriptionIncludes: SCB })],
    verifyOpts,
  );
  assert.equal(out.stopped, true);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
});

test("verify a hand-entered bank account: another IBAN, same bank, different amount is not accepted", async () => {
  const h = await bankHandHarness(70000, OTHER_SCB);
  const out = await h.runStepwise(
    [wf("7030", 75000, { rowDescriptionIncludes: SCB })],
    verifyOpts,
  );
  assert.equal(out.stopped, true);
  assert.equal(out.results[0].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
});

test("verify hand-entered bank accounts: one IRIS row never counts for two planned accounts", async () => {
  const h = await bankHandHarness(75000, OTHER_SCB);
  const out = await h.runStepwise(
    [
      wf("7030", 75000, { rowDescriptionIncludes: SCB }),
      wf("7030", 75000, { rowDescriptionIncludes: "PK99SCBL0000009999999999" }),
    ],
    { ...verifyOpts, stopOnProblem: false },
  );
  assert.equal(out.results[0].status, filler.FILL_STATUS.ALREADY_CORRECT);
  assert.equal(out.results[1].status, driver.WEALTH_STATUS.DRY_ROW_MISSING);
});

// ── Tax-paid outflow (7098): the taxpayer may word the description their own way.
const handOutflowHarness = async (amount, text) => {
  const h = harness();
  await h.runStepwise([wf("7098", amount, { rowDescriptionIncludes: text })]);
  return h;
};

test("verify a hand-added tax outflow: own wording, same amount -> accepted, nothing clicked", async () => {
  const h = await handOutflowHarness(210000, "Tax paid by my employer");
  h.fake.clicks.length = 0;
  const out = await h.runStepwise(
    [wf("7098", 210000, { rowDescriptionIncludes: OUTFLOW_HINT })],
    verifyOpts,
  );
  assert.equal(
    out.results[0].status,
    filler.FILL_STATUS.ALREADY_CORRECT,
    JSON.stringify(out.results[0]),
  );
  assert.equal(out.results[0].takenOverChecked, true);
  assert.equal(h.fake.clicks.length, 0, "read-only");
});

test("verify a hand-added tax outflow: own wording and a different amount -> not accepted", async () => {
  const h = await handOutflowHarness(100000, "Tax paid by my employer");
  const out = await h.runStepwise(
    [wf("7098", 210000, { rowDescriptionIncludes: OUTFLOW_HINT })],
    verifyOpts,
  );
  assert.equal(out.stopped, true);
  assert.notEqual(out.results[0].status, filler.FILL_STATUS.ALREADY_CORRECT);
});
