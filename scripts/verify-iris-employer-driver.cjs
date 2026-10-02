#!/usr/bin/env node
/**
 * Employer driver (electron-connect/iris-employer-driver.js).
 *
 * Runs the REAL driver against a stand-in IRIS built from the real employer
 * capture (scripts/lib/fake-iris-employer.cjs). Pins:
 *   - the name rule (exact registered name, small normalisation, never the first
 *     option, never a registration number typed by us),
 *   - what the driver may click (Save / Submit / Calculate / delete / edit are
 *     unreachable),
 *   - idempotence (a second run clicks nothing),
 *   - dry mode never clicks,
 *   - every failure cancels the dialog and is reported.
 */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const driver = require("../electron-connect/iris-employer-driver.js");
const { FakeIrisEmployer } = require("./lib/fake-iris-employer.cjs");

const { EMPLOYER_STATUS: S } = driver;
const REGISTRY = [
  { name: "HASEEB KHAN (PVT.) LIMITED", regNo: "7367741" },
  { name: "HASEEB KHAN TRADERS", regNo: "5550001" },
  { name: "SYSTEMS LIMITED", regNo: "1000001" },
  { name: "TWIN CORP", regNo: "2000001" },
  { name: "TWIN CORP", regNo: "2000002" },
  { name: "AT&T PAKISTAN", regNo: "3000001" },
];

const navigateOk = async () => ({ ok: true, status: "opened" });
const run = (fake, names, extra = {}) =>
  driver.runEmployerDriver(fake, names, {
    mode: "live",
    navigate: navigateOk,
    sleep: async () => {},
    timeoutMs: 40,
    ...extra,
  });
const statuses = (outcome) => outcome.results.map((r) => r.status);
const clickLabels = (fake) => fake.clicks.map((c) => `${c.tag}:${c.text}`);
const FORBIDDEN = /calculate|save|submit|delete|edit/i;

test("name key forgives case, punctuation and the usual abbreviations, nothing else", () => {
  const key = driver.employerNameKey;
  assert.equal(
    key("Haseeb Khan (Pvt.) Ltd."),
    key("HASEEB KHAN PRIVATE LIMITED"),
  );
  assert.equal(key("AT&T Pakistan"), key("AT AND T PAKISTAN"));
  assert.notEqual(key("HASEEB KHAN"), key("HASEEB KHAN TRADERS"));
  assert.notEqual(key("SYSTEMS LIMITED"), key("SYSTEM LIMITED"));
  assert.equal(key(""), "");
});

test("chooseEmployerOption: one exact match, none, or ambiguous - never the first option", () => {
  const options = REGISTRY.map((r) => `${r.name} | ${r.regNo}`);
  const match = driver.chooseEmployerOption(options, "Systems Limited");
  assert.equal(match.kind, "match");
  assert.equal(match.option.regNo, "1000001");
  const none = driver.chooseEmployerOption(options, "HASEEB");
  assert.equal(none.kind, "none");
  assert.ok(none.candidates.length > 0 && none.candidates.length <= 5);
  const twin = driver.chooseEmployerOption(options, "TWIN CORP");
  assert.equal(twin.kind, "ambiguous");
  assert.deepEqual(twin.options.sort(), [
    "TWIN CORP | 2000001",
    "TWIN CORP | 2000002",
  ]);
  // The same registration listed twice is still one match.
  assert.equal(
    driver.chooseEmployerOption(
      ["SYSTEMS LIMITED | 1", "SYSTEMS LIMITED | 1"],
      "systems limited",
    ).kind,
    "match",
  );
  assert.equal(driver.chooseEmployerOption([], "X").kind, "none");
  assert.equal(driver.chooseEmployerOption(["| 1"], "").kind, "none");
});

test("planEmployers drops blanks and duplicates and caps the list", () => {
  assert.deepEqual(
    driver.planEmployers([" Acme  Ltd ", "ACME LIMITED", "", null, "Beta"]),
    ["Acme Ltd", "Beta"],
  );
  assert.equal(
    driver.planEmployers(Array.from({ length: 30 }, (_, i) => `Co ${i}`))
      .length,
    10,
  );
  assert.deepEqual(driver.planEmployers(undefined), []);
});

test("click surface: only the documented controls can be requested", () => {
  for (const button of [
    "save",
    "submit",
    "calculate",
    "delete",
    "edit",
    "close",
    "",
  ]) {
    assert.throws(
      () => driver.buildPageScript({ op: "modal_click", button }),
      /not allowed/,
    );
  }
  assert.throws(
    () => driver.buildPageScript({ op: "click_anything" }),
    /not allowed/,
  );
  assert.throws(
    () => driver.buildPageScript({ op: "modal_type_name", value: "  " }),
    /empty or too long/,
  );
  assert.throws(
    () => driver.buildPageScript({ op: "modal_pick_option", optionText: "" }),
    /no option text/,
  );
  assert.doesNotThrow(() =>
    driver.buildPageScript({ op: "modal_click", button: "Cancel" }),
  );
});

test("live: adds one employer by exact registered name and touches only allowed controls", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["haseeb khan (pvt.) limited"]);
  assert.deepEqual(statuses(outcome), [S.ADDED]);
  assert.equal(outcome.results[0].regNo, "7367741");
  assert.deepEqual(fake.cardTexts(), ["HASEEB KHAN (PVT.) LIMITED | 7367741"]);
  assert.equal(fake.modal(), null, "dialog is closed");
  assert.equal(fake.clicks.length, 3, `clicks: ${clickLabels(fake)}`);
  for (const click of fake.clicks)
    assert.doesNotMatch(click.text + click.cls, FORBIDDEN);
});

test("live: a different spelling of the abbreviations is found by widening the search to the first two words", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["Haseeb Khan Private Limited"]);
  assert.deepEqual(statuses(outcome), [S.ADDED]);
  assert.equal(outcome.results[0].regNo, "7367741");
  assert.deepEqual(driver.employerQueries("Haseeb Khan Private Limited"), [
    "Haseeb Khan Private Limited",
    "Haseeb Khan",
  ]);
  assert.deepEqual(driver.employerQueries("Systems"), ["Systems"]);
});

test("live: the registration number is never typed by the agent", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const typed = [];
  const original = fake.webContents.executeJavaScript;
  fake.webContents.executeJavaScript = async (script) => {
    if (/"op":"modal_type_name"/.test(script)) typed.push(script);
    return original(script);
  };
  await run(fake, ["SYSTEMS LIMITED"]);
  assert.equal(typed.length, 1);
  assert.match(typed[0], /SYSTEMS LIMITED/);
  assert.doesNotMatch(typed[0], /1000001/);
});

test("live: re-running adds nothing and clicks nothing", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  await run(fake, ["SYSTEMS LIMITED"]);
  fake.clicks.length = 0;
  const again = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(again), [S.ALREADY_LISTED]);
  assert.equal(fake.clicks.length, 0);
  assert.equal(fake.cards().length, 1);
});

test("live: an employer listed before the run is left alone", async () => {
  const fake = new FakeIrisEmployer({
    registry: REGISTRY,
    existing: [{ name: "SYSTEMS LIMITED", regNo: "1000001" }],
  });
  const outcome = await run(fake, ["Systems Ltd"]);
  assert.deepEqual(statuses(outcome), [S.ALREADY_LISTED]);
  assert.equal(fake.clicks.length, 0);
});

test("live: a card that shows only the registration number is still recognised on re-run", async () => {
  const fake = new FakeIrisEmployer({
    registry: REGISTRY,
    cardFormat: "reg_only",
  });
  const first = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(first), [S.ADDED]);
  const again = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(again), [S.ALREADY_LISTED]);
  assert.equal(fake.cards().length, 1, "no duplicate card");
  assert.equal(fake.modal(), null, "the probing dialog was cancelled");
});

test("live: several employers are all added, in order", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["SYSTEMS LIMITED", "AT&T Pakistan"]);
  assert.deepEqual(statuses(outcome), [S.ADDED, S.ADDED]);
  assert.deepEqual(fake.cardTexts(), [
    "SYSTEMS LIMITED | 1000001",
    "AT&T PAKISTAN | 3000001",
  ]);
});

test("live: no exact match cancels the dialog and reports what IRIS offered", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["HASEEB"]);
  assert.deepEqual(statuses(outcome), [S.NO_EXACT_MATCH]);
  assert.ok(outcome.results[0].candidates.some((c) => c.includes("7367741")));
  assert.equal(fake.cards().length, 0);
  assert.equal(fake.modal(), null);
  const picked = fake.clicks.filter((c) => /mat-option/i.test(c.tag));
  assert.equal(picked.length, 0, "no option was chosen");
  assert.match(
    driver.describeEmployerIssues(outcome.results)[0],
    /not an exact match/,
  );
});

test("the cards IRIS shows are logged so a missed card can be diagnosed", async () => {
  const fake = new FakeIrisEmployer({
    registry: REGISTRY,
    existing: [{ name: "SYSTEMS LIMITED", regNo: "1000001" }],
  });
  const steps = [];
  await run(fake, ["SYSTEMS LIMITED"], {
    onStep: (step, detail) => steps.push([step, detail]),
  });
  const seen = steps.find(([step]) => step === "employer_cards_seen");
  assert.ok(seen, "cards_seen was logged");
  assert.match(
    seen[1],
    /1 employer card\(s\) visible.*SYSTEMS LIMITED \| 1000001/,
  );
});

test("the issue text names the problem and leaves the instruction to the caller", () => {
  const text = driver.describeEmployerIssues([
    { name: "X", status: S.NO_EXACT_MATCH, candidates: ["X PVT | 1"] },
  ])[0];
  assert.doesNotMatch(text, /Pick the right/);
  assert.match(text, /"X" is not an exact match/);
});

test("live: a name IRIS knows nothing about is reported with an empty list", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["NOBODY AT ALL"]);
  assert.deepEqual(statuses(outcome), [S.NO_EXACT_MATCH]);
  assert.deepEqual(outcome.results[0].candidates, []);
  assert.match(
    driver.describeEmployerIssues(outcome.results)[0],
    /IRIS offered nothing/,
  );
  assert.equal(fake.modal(), null);
});

test("live: two registrations with the same name are never guessed between", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["TWIN CORP"]);
  assert.deepEqual(statuses(outcome), [S.AMBIGUOUS]);
  assert.equal(fake.cards().length, 0);
  assert.equal(fake.modal(), null);
  assert.match(
    driver.describeEmployerIssues(outcome.results)[0],
    /Several IRIS registrations/,
  );
});

test("live: one employer failing does not stop the next one", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["TWIN CORP", "SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(outcome), [S.AMBIGUOUS, S.ADDED]);
});

test("live: cards with unfamiliar markup are still recognised from the list body", async () => {
  const fake = new FakeIrisEmployer({
    registry: REGISTRY,
    cardMarkup: "plain",
  });
  const outcome = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(outcome), [S.ADDED]);
  const again = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(again), [S.ALREADY_LISTED]);
});

test("live: an unconfirmed card does not stop the next employer from being tried", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY, cardMarkup: "none" });
  const steps = [];
  const outcome = await run(fake, ["SYSTEMS LIMITED", "AT&T Pakistan"], {
    onStep: (step, detail) => steps.push([step, detail]),
  });
  assert.deepEqual(statuses(outcome), [S.ADDED_UNVERIFIED, S.ADDED_UNVERIFIED]);
  assert.equal(fake.modal(), null);
  assert.ok(
    steps.some(
      ([step, detail]) =>
        step === "employer_added_unverified" && /panel-body/.test(detail),
    ),
    "the employer list markup is logged when a card cannot be confirmed",
  );
});

test("live: an employer skipped after a dialog failure says so in plain words", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY, rejectAdd: true });
  const outcome = await run(fake, ["SYSTEMS LIMITED", "AT&T Pakistan"]);
  const lines = driver.describeEmployerIssues(outcome.results);
  assert.match(lines[1], /was not attempted because/);
  assert.doesNotMatch(lines[1], /stopped_the_run/);
});

test("live: IRIS keeping the dialog open after Add is reported and stops the run", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY, rejectAdd: true });
  const outcome = await run(fake, ["SYSTEMS LIMITED", "AT&T Pakistan"]);
  assert.deepEqual(statuses(outcome), [S.SETUP_FAILED, S.SETUP_FAILED]);
  assert.equal(outcome.results[0].setupStatus, "add_rejected_by_iris");
  assert.equal(fake.modal(), null, "the dialog was cancelled");
  const adds = fake.clicks.filter((c) => c.inDialog && /^add$/i.test(c.text));
  assert.equal(adds.length, 1, "Add pressed once, never retried");
});

test("live: options with role=option markup are chosen too", async () => {
  const fake = new FakeIrisEmployer({
    registry: REGISTRY,
    optionsMarkup: "div",
  });
  const outcome = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(outcome), [S.ADDED]);
});

test("dry: nothing is clicked and the employer is reported as would-add", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["SYSTEMS LIMITED"], { mode: "dry" });
  assert.deepEqual(statuses(outcome), [S.WOULD_ADD]);
  assert.equal(fake.clicks.length, 0);
  assert.equal(fake.cards().length, 0);
  assert.equal(driver.summariseEmployers(outcome.results).needsReview, 0);
});

test("the Salary page not opening leaves everything untouched", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  const outcome = await run(fake, ["SYSTEMS LIMITED"], {
    navigate: async () => ({ ok: false, status: "tab_not_found" }),
  });
  assert.deepEqual(statuses(outcome), [S.SECTION_UNAVAILABLE]);
  assert.equal(fake.clicks.length, 0);
  assert.match(
    driver.describeEmployerIssues(outcome.results)[0],
    /tab_not_found/,
  );
});

test("a missing Add Employer Details button is reported, not guessed around", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  fake.document.querySelector(".salary-employer-add-btn").remove();
  const outcome = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(outcome), [S.SECTION_UNAVAILABLE]);
  assert.equal(outcome.results[0].setupStatus, "add_button_not_found");
  assert.equal(fake.clicks.length, 0);
});

test("a dialog that is already open stops the run before any click", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  fake.document.body.insertAdjacentHTML(
    "beforeend",
    '<mat-dialog-container><h6 mat-dialog-title><span class="left">Something else</span></h6></mat-dialog-container>',
  );
  const outcome = await run(fake, ["SYSTEMS LIMITED"]);
  assert.deepEqual(statuses(outcome), [S.SETUP_FAILED]);
  assert.equal(outcome.results[0].setupStatus, "unexpected_dialog_open");
  assert.equal(fake.clicks.length, 0);
});

test("beforeStep runs before every page operation (job-cancel check)", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  let calls = 0;
  await run(fake, ["SYSTEMS LIMITED"], {
    beforeStep: async () => {
      calls += 1;
    },
  });
  assert.ok(calls >= 8, `beforeStep ran ${calls} times`);
  const cancelled = new FakeIrisEmployer({ registry: REGISTRY });
  await assert.rejects(
    run(cancelled, ["SYSTEMS LIMITED"], {
      beforeStep: async () => {
        throw new Error("job cancelled");
      },
    }),
    /job cancelled/,
  );
  assert.equal(cancelled.clicks.length, 0);
});

test("no employers means no navigation and no clicks", async () => {
  const fake = new FakeIrisEmployer({ registry: REGISTRY });
  let navigated = 0;
  const outcome = await run(fake, [], {
    navigate: async () => {
      navigated += 1;
      return { ok: true };
    },
  });
  assert.deepEqual(outcome.results, []);
  assert.equal(navigated, 0);
});
