#!/usr/bin/env node
/**
 * Packet → IRIS field-map contract (Phase 0, 2026-09-09).
 *
 * The operator's live dry run reported `0/27 fields filled; skipped: 24 column_disabled,
 * 3 row_not_found`. Every one of those refusals came from the packet builder, not the
 * filler: it hard-coded `column: "Amount Subject to Normal Tax"` onto a column IRIS
 * derives, emitted one field per ledger row instead of one field per IRIS cell, queued
 * computed summary rows (1000) as if they were enterable, and dumped unmapped categories
 * onto 5028.
 *
 * This suite pins the corrected behaviour and then replays the built map through the
 * agent's REAL filler against the REAL captured portal pages, so the assertions are about
 * what the portal would accept — not about a re-implementation.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const projectRoot = path.join(__dirname, "..");

// Resolve "@/…" and require the real .ts sources (same trick as
// scripts/verify-flat-income-routes.cjs) so this runs the shipping code.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(projectRoot, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const { buildPortalFieldMap, flattenPortalFieldMap } = require(
  path.join(projectRoot, "lib/tax/portal-field-map.ts"),
);
const filler = require(
  path.join(projectRoot, "electron-connect/iris-row-filler.js"),
);

const FIXTURE_DIR = path.join(projectRoot, "test-fixtures", "iris");
const LIVE_CAPTURE_DIR = path.join(os.homedir(), "uploads");
const LIVE_SALARY_CAPTURE = path.join(LIVE_CAPTURE_DIR, "IRIS 2.0 form3.html");

let assertionCount = 0;
function check(label, actual, expected) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, label);
}

/** 13 monthly salary rows — the exact shape the live packet contained. */
function salaryOnlyLedger(rows = 13, per = 100000) {
  return Array.from({ length: rows }, (_, i) => ({
    id: `led-${i + 1}`,
    entryType: "INCOME",
    category: "SALARY",
    description: `Salary month ${i + 1}`,
    amount: per,
  }));
}

function buildOver(entries, extra = {}) {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: entries,
    taxCredits: [],
    taxableIncome: 0,
    taxWithheld: 0,
    ...extra,
  });
  return { map, fields: flattenPortalFieldMap(map) };
}

test("13 salary ledger rows collapse into ONE IRIS cell holding the total", () => {
  const { fields } = buildOver(salaryOnlyLedger(13, 100000));
  const onPayWages = fields.filter((f) => f.irisCode === "1009");
  check("exactly one field targets row 1009", onPayWages.length, 1);
  check(
    "its value is the sum, not the last row",
    onPayWages[0].value,
    "1300000",
  );
  check(
    "the aggregation is countable for audit",
    onPayWages[0].sourceGroup,
    "incomeFields",
  );

  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: salaryOnlyLedger(13, 100000),
  });
  check(
    "the field records how many ledger rows it absorbed",
    map.incomeFields.find((e) => e.irisCode === "1009").sourceEntryCount,
    13,
  );
});

test("the target column is the ENTERED one, never IRIS's derived normal-tax column", () => {
  const { fields } = buildOver(salaryOnlyLedger(1, 500000));
  check("column", fields[0].column, "Total Amount");
  check(
    "no field may ask for a derived column",
    fields.filter(
      (f) => !f.isTaxField && f.column === "Amount Subject to Normal Tax",
    ).length,
    0,
  );
});

test("computed summary rows are skipped and reported, not queued for a write", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: salaryOnlyLedger(2, 250000),
  });
  check(
    "1000 (Total Income from Salary) is not queued",
    map.incomeFields.some((e) => e.irisCode === "1000"),
    false,
  );
  const skipped = map.mappingGaps.skippedComputedCodes.find(
    (s) => s.code === "1000",
  );
  check("…but it is reported with its amount", Boolean(skipped), true);
  check("the reported amount is the aggregated figure", skipped.amount, 500000);
});

test("unmapped categories become a named gap, never 'Other Receipts' 5028", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      {
        id: "b1",
        entryType: "INCOME",
        category: "BANK_PROFIT",
        description: "Bank profit",
        amount: 400000,
      },
      {
        id: "d1",
        entryType: "INCOME",
        category: "DIVIDEND",
        description: "Dividend",
        amount: 150000,
      },
      {
        id: "z1",
        entryType: "INCOME",
        category: "MYSTERY_INCOME",
        description: "??",
        amount: 90000,
      },
    ],
  });
  const fields = flattenPortalFieldMap(map);
  check("nothing is queued for them", fields.length, 0);
  check(
    "every category is reported",
    map.mappingGaps.unmappedCategories.map((g) => g.category).sort(),
    ["BANK_PROFIT", "DIVIDEND", "MYSTERY_INCOME"],
  );
  const bank = map.mappingGaps.unmappedCategories.find(
    (g) => g.category === "BANK_PROFIT",
  );
  check("with its amount", bank.totalAmount, 400000);
  check("with its source rows", bank.entryIds, ["b1"]);
  assert.match(bank.reason, /final-tax/i, "and a reason that says why");
});

test("pension is written once, on one IRIS line", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      {
        id: "p1",
        entryType: "INCOME",
        category: "PENSION",
        description: "Pension",
        amount: 900000,
      },
    ],
    pensionDetails: {
      totalPension: 900000,
      exemptLimit: 600000,
      exemptAmount: 600000,
      taxableAmount: 300000,
      age: 63,
    },
  });
  const fields = flattenPortalFieldMap(map);
  check("one field", fields.length, 1);
  check("on row 1008", fields[0].irisCode, "1008");
  check("whole pension figure", fields[0].value, "900000");
  check(
    "…and 5007 is not touched",
    fields.some((f) => f.irisCode === "5007"),
    false,
  );
  check(
    "the engine split is still visible for the review screen",
    map.computationHints.pensionExemptAmount,
    600000,
  );
});

test("pension split that disagrees with the ledger is surfaced, not resolved silently", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      {
        id: "p1",
        entryType: "INCOME",
        category: "PENSION",
        description: "Pension",
        amount: 900000,
      },
    ],
    pensionDetails: {
      totalPension: 700000,
      exemptLimit: 600000,
      exemptAmount: 600000,
      taxableAmount: 100000,
      age: 63,
    },
  });
  const mismatch = map.mappingGaps.pensionSplitMismatch;
  check("one mismatch entry", mismatch.length, 1);
  check(
    "ledger wins on the portal value",
    flattenPortalFieldMap(map)[0].value,
    "900000",
  );
  check("mismatch recorded", mismatch[0].engineSplitTotal, 700000);
});

test("rent emits its own deduction line and no property summary row", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      {
        id: "r1",
        entryType: "INCOME",
        category: "RENT",
        description: "Flat rent",
        amount: 600000,
      },
    ],
  });
  const fields = flattenPortalFieldMap(map);
  // 2001/2031 are real codes in the client's extract, but no capture ever showed
  // the Property sheet rendering them as an ENTERABLE row. Queuing them produced the
  // `row_not_found` refusals the operator saw; reporting them produces a worksheet.
  check(
    "nothing is queued for rent until a Property capture lands",
    fields.length,
    0,
  );
  const unproven = map.mappingGaps.captureUnverified || [];
  check(
    "both property lines are reported",
    unproven.map((g) => g.code).sort(),
    ["2001", "2031"],
  );
  check(
    "rent amount is reported in full",
    Number(unproven.find((g) => g.code === "2001").amount),
    600000,
  );
  check(
    "…and the 1/5th deduction survives as a number for the operator",
    Number(unproven.find((g) => g.code === "2031").amount),
    120000,
  );
  check(
    "reason names the missing evidence, not a broken selector",
    /never appeared as a rendered row/.test(unproven[0].reason),
    true,
  );
  check(
    "2029/2099 summaries are not queued",
    fields.some((f) => ["2029", "2099"].includes(f.irisCode)),
    false,
  );
});

test("withholding credits still land on the tax column of their own line", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    taxCredits: [
      {
        id: "t1",
        section: "149",
        subcategory: "salary",
        amount: 120000,
        source: "SALARY",
      },
      {
        id: "t2",
        section: "149",
        subcategory: "salary revised",
        amount: 30000,
        source: "SALARY",
      },
      {
        id: "t3",
        section: "999",
        subcategory: "mystery",
        amount: 5000,
        source: "MANUAL",
      },
    ],
  });
  const fields = flattenPortalFieldMap(map);
  // The Adjustable-Tax grid was never captured as an enterable row set, so the
  // section-149 credit is reported for manual entry (with its amount aggregated)
  // rather than queued against a row id no capture has ever shown.
  check("nothing is queued on unproven adjustable-tax rows", fields.length, 0);
  const unproven = map.mappingGaps.captureUnverified || [];
  check(
    "both 149 credits aggregate into one reported line",
    unproven.length,
    1,
  );
  check("…identified by the right code", unproven[0].code, "64020004");
  check("…summed, not dropped", Number(unproven[0].amount), 150000);
  check(
    "an unknown section is a gap, not the 640000 summary row",
    map.mappingGaps.unmappedCategories.map((g) => g.category),
    ["TAX_999"],
  );
  check(
    "640000 is never queued",
    fields.some((f) => f.irisCode === "640000"),
    false,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Replay: built packet → the agent's REAL filler → the REAL captured portal.
// This is the end-to-end check that the fix changes what the portal would accept.
// ───────────────────────────────────────────────────────────────────────────

function runFillerOn(htmlPath, fields) {
  const dom = new JSDOM(fs.readFileSync(htmlPath, "utf8"));
  global.document = dom.window.document;
  global.window = dom.window;
  global.Event = dom.window.Event;
  const script = filler.buildInPageFillScript(
    fields.map((f) => filler.prepareField(f)),
    { dryRun: true },
  );
  return { results: dom.window.eval(script), dom };
}

const salaryLedger = [
  ...salaryOnlyLedger(13, 100000),
  {
    id: "a1",
    entryType: "INCOME",
    category: "SALARY",
    description: "Allowances",
    amount: 60000,
  },
];

test("replay on the repo salary fixture: 1009 fills on the Total column", () => {
  const { fields } = buildOver(salaryLedger);
  const { results } = runFillerOn(
    path.join(FIXTURE_DIR, "salary.html"),
    fields,
  );
  const payWages = results.find((r) => r.irisCode === "1009");
  check("filled", payWages.status, filler.FILL_STATUS.FILLED);
  check("into column 0 (Total Income)", payWages.columnIndex, 0);
  assert.ok(payWages.dryRun, "dry run wrote nothing");
  check(
    "no refusal is left behind for a queued field",
    results
      .filter((r) => r.status !== filler.FILL_STATUS.FILLED)
      .map((r) => r.status),
    [],
  );
});

test("replay against the operator's LIVE capture: the old packet filled 0, the new one fills", () => {
  if (!fs.existsSync(LIVE_SALARY_CAPTURE)) {
    // The IRIS captures live outside the repo (they are not committable). The
    // fixture replay above still covers the contract; this test only runs when
    // the raw capture is available.
    return;
  }

  const oldPacket = [
    {
      key: "1009:income:old",
      irisCode: "1009",
      label: "Pay, Wages",
      value: "1300000",
      column: "Amount Subject to Normal Tax",
    },
  ];
  const oldResults = runFillerOn(LIVE_SALARY_CAPTURE, oldPacket).results;
  check(
    "the shipped behaviour is reproduced: column_disabled on the derived column",
    oldResults[0].status,
    filler.FILL_STATUS.COLUMN_DISABLED,
  );

  const { fields } = buildOver(salaryLedger);
  const liveResults = runFillerOn(LIVE_SALARY_CAPTURE, fields).results;
  const payWages = liveResults.find((r) => r.irisCode === "1009");
  check(
    "the fix fills the same row on the same capture",
    payWages.status,
    filler.FILL_STATUS.FILLED,
  );
  check("…on the entered column", payWages.columnIndex, 0);
});

test("the map is versioned so an old packet cannot masquerade as a new one", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: salaryOnlyLedger(1, 1000),
  });
  check("packet map version", map.version, "1.1.0");
  check(
    "selector bundle stamp",
    map.selectorBundle.version,
    "v1.1-2026-09-09-iris2-capture",
  );
});

test("the agent's completion status and the app's gate agree (no invented 'COMPLETED')", () => {
  // Read statically on purpose: importing the route would need Prisma/DB, and the
  // whole point is a cross-file string contract, not behaviour.
  const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");
  const statusRoute = read("app/api/local-agent/jobs/[jobId]/status/route.ts");
  const statusLib = read("lib/tax/filing-status.ts");
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  const fbrPage = read("app/tax/fbr-connect/page.tsx");

  assert.ok(
    statusRoute.includes('"DRY_RUN_COMPLETED"') &&
      statusRoute.includes('"FILING_COMPLETED"'),
    "the route must keep writing both completion statuses",
  );
  assert.ok(
    /FBR_AGENT_COMPLETED_STATUSES = \[\s*"FILING_COMPLETED",\s*"DRY_RUN_COMPLETED",?\s*\]/.test(
      statusLib,
    ),
    "the centralized helper must accept exactly those two",
  );
  assert.ok(
    !/status:\s*"COMPLETED"/.test(statusRoute),
    '"COMPLETED" must never be written — a gate comparing it is dead code',
  );
  assert.ok(
    wizard.includes("isFbrAgentCompleted(fbrConnectionStatus)"),
    "the wizard rail must use the shared predicate",
  );
  assert.ok(
    !wizard.includes('fbrConnectionStatus === "COMPLETED"'),
    "the wizard must not compare against the invented status again",
  );
  // The standalone page and the wizard must show the same figures on the gate.
  for (const prop of ["taxPayable", "refundDue", "packetVersion"]) {
    assert.ok(
      new RegExp(`${prop}=`).test(fbrPage),
      `standalone FBR page must pass ${prop} to the final gate`,
    );
  }
});

test("an unmapped income category blocks packet generation (never a silent omission)", () => {
  // The gate lives in the packet action, but its INPUT is this map: if salary-only
  // packets reported a gap the wizard would break, and if business income reported
  // none the packet would silently understate the return.
  const salaryOnly = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: salaryOnlyLedger(2, 250000),
  });
  check(
    "salary-only has nothing to block",
    salaryOnly.mappingGaps.unmappedCategories.length,
    0,
  );

  const withBusiness = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "my_business",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      ...salaryOnlyLedger(1, 250000),
      {
        id: "bs1",
        entryType: "INCOME",
        category: "BUSINESS",
        description: "Trading",
        amount: 4000000,
      },
    ],
  });
  const gaps = withBusiness.mappingGaps.unmappedCategories;
  check("business income is reported as one gap", gaps.length, 1);
  check(
    "with its amount for the error message",
    Number(gaps[0].totalAmount),
    4000000,
  );

  // And the decision itself — refusal, acceptance, and what gets recorded — comes
  // from one function, so an override cannot quietly drop what the refusal promised
  // to keep visible.
  const { describeUnmappedPortalSources } = require(
    path.join(projectRoot, "lib/tax/portal-field-map.ts"),
  );

  const clear = describeUnmappedPortalSources(withBusinessLike({}));
  check("no gaps means nothing to refuse", clear.blocked, []);
  check("and no sentence", clear.refusal, "");
  check("and a complete packet", clear.coverage, { mode: "complete" });

  const blocked = describeUnmappedPortalSources({
    unmappedCategories: [
      { category: "CAPITAL_GAINS", totalAmount: 900000 },
      { category: "PROPERTY_RENT", totalAmount: "600000" },
      { category: "DIVIDEND", totalAmount: 0 },
      { category: "", totalAmount: 500000 },
    ],
  });
  check(
    "only non-zero, named categories block",
    blocked.blocked.map((g) => g.category),
    ["CAPITAL_GAINS", "PROPERTY_RENT"],
  );
  check(
    "amounts normalised to numbers",
    blocked.blocked.map((g) => g.totalAmount),
    [900000, 600000],
  );
  check(
    "the sentence opens with the refusal",
    blocked.refusal.startsWith("Packet not generated:"),
    true,
  );
  check(
    "and names every blocked category, lowercased",
    blocked.refusal.includes("capital gains (900,000)") &&
      blocked.refusal.includes("property rent (600,000)"),
    true,
  );
  check(
    "a zero or nameless entry is never mentioned",
    blocked.refusal.includes("dividend") ||
      blocked.refusal.includes("undefined"),
    false,
  );
  check("accepting records exactly what the refusal listed", blocked.coverage, {
    mode: "partial_manual_entry_required",
    acceptedByOperator: true,
    unmappedSources: blocked.blocked,
  });
  // The invariant: the override cannot lose an item. Every category the refusal
  // names is in the coverage record the snapshot will carry.
  for (const gap of blocked.blocked) {
    check(
      `recorded for ${gap.category}`,
      blocked.coverage.unmappedSources.some(
        (entry) => entry.category === gap.category,
      ),
      true,
    );
  }

  // Junk input must not become a crash, nor an invented gap.
  for (const junk of [
    undefined,
    null,
    {},
    { unmappedCategories: null },
    { unmappedCategories: "no" },
  ]) {
    const decision = describeUnmappedPortalSources(junk);
    check(
      `junk ${JSON.stringify(junk)} is treated as no gap`,
      decision.blocked,
      [],
    );
    check("and the packet is complete", decision.coverage.mode, "complete");
  }

  // The action reads the gaps, refuses before any snapshot, and hands the same list
  // to the UI so the override is offered from real numbers.
  const action = fs.readFileSync(
    path.join(projectRoot, "app/actions/packet.ts"),
    "utf8",
  );
  const bodyStart = action.indexOf(
    "export async function generateFilingPacketAction",
  );
  const body = action.slice(
    bodyStart,
    action.indexOf("export async function", bodyStart + 10),
  );
  assert.match(
    body,
    /options\?: \{ acceptUnmappedPortalSources\?: boolean \}/,
    "the override is an explicit argument",
  );
  assert.match(
    body,
    /describeUnmappedPortalSources\(portalFieldMap\.mappingGaps\)/,
    "the action must read the gaps through the shared helper",
  );
  assert.match(
    body,
    /coverageGate\.blocked\.length > 0 && !options\?\.acceptUnmappedPortalSources/,
    "refuse unless the practitioner accepted",
  );
  assert.match(
    body,
    /unmappedPortalSources: coverageGate\.blocked/,
    "and return the list to the UI",
  );
  check(
    "the coverage wording lives in the helper, not the action",
    action.includes('mode: "partial_manual_entry_required"'),
    false,
  );
  const refusalAt = body.indexOf(
    "return {\n        success: false,\n        error: coverageGate.refusal",
  );
  assert.notEqual(
    refusalAt,
    -1,
    "the refusal must exist before anything is stored",
  );
  check(
    "the refusal precedes the snapshot it would otherwise store",
    refusalAt < body.indexOf("const snapshot = {"),
    true,
  );
  assert.match(
    body,
    /coverage,\n    \};/,
    "the snapshot records the coverage verdict",
  );

  // The client cannot accept by accident: a click event is not `true`.
  const hook = fs.readFileSync(
    path.join(
      projectRoot,
      "components/tax/filing/hooks/use-filing-finalization.ts",
    ),
    "utf8",
  );
  assert.match(
    hook,
    /const accept = acceptUnmapped === true;/,
    "strict boolean from the handler",
  );
  assert.match(
    hook,
    /acceptUnmappedPortalSources: accept/,
    "and it is what the action receives",
  );

  const step = fs.readFileSync(
    path.join(projectRoot, "components/tax/filing/wizard-packet-step.tsx"),
    "utf8",
  );
  assert.ok(
    !/onClick=\{onGeneratePacket\}/.test(step),
    "the generate button must never hand the click event to the accept flag",
  );
  assert.match(
    step,
    /packetUnmappedSources\.length > 0 && acceptUnmapped \? true : false/,
    "the override is sent only when the box is ticked",
  );
  assert.match(
    step,
    /role="group"[\s\S]{0,700}Generate anyway — I will enter these in IRIS myself/,
    "the override is labelled as the operator's own decision",
  );
});

function withBusinessLike(extra) {
  return { unmappedCategories: [], ...extra };
}

test("every queued target is a row IRIS has been seen letting a human type into", () => {
  const { PORTAL_WRITEABLE_CODES, PORTAL_ROW_EVIDENCE } = require(
    path.join(projectRoot, "lib/tax/portal-row-evidence.ts"),
  );
  // The evidence file is a census, not a hand-written list: it must cover every
  // row id the captures render — and nothing they do not.
  const seen = new Set();
  const censusDir = LIVE_CAPTURE_DIR;
  if (fs.existsSync(censusDir)) {
    for (const file of fs.readdirSync(censusDir)) {
      if (!file.endsWith(".html")) continue;
      const html = fs.readFileSync(path.join(censusDir, file), "utf8");
      for (const m of html.matchAll(
        /class="[^"]*tableRows dataRow[^"]*"\s+id="(\d+)"/g,
      )) {
        seen.add(m[1]);
      }
    }
  } else {
    // The census half needs the operator's capture folder; the invariant half
    // below only needs the checked-in evidence module, so keep going.
    console.log("# SKIP capture census: no captures under " + censusDir);
  }
  if (seen.size > 0) {
    check(
      "evidence covers every rendered row id",
      seen.size,
      Object.keys(PORTAL_ROW_EVIDENCE).length,
    );
    check(
      "with no invented extras",
      Object.keys(PORTAL_ROW_EVIDENCE).filter((code) => !seen.has(code)),
      [],
    );
  }
  check(
    "the salary summary row 1000 is captured but read-only",
    PORTAL_ROW_EVIDENCE["1000"].writeableInputIndexes,
    [],
  );
  assert.ok(
    !PORTAL_WRITEABLE_CODES.has("1000"),
    "1000 must never be a write target",
  );
  assert.ok(PORTAL_WRITEABLE_CODES.has("1009"), "1009 is proven enterable");
  // A row id that renders only as an Angular shell row (9999xx) is a trap: the
  // client extract does not contain it, so any "trust the CSV" tool would invent it.
  check(
    "UI-shell rows are recorded as never writeable",
    ["999901", "999902", "999903", "999905"].every(
      (code) =>
        PORTAL_ROW_EVIDENCE[code] &&
        PORTAL_ROW_EVIDENCE[code].writeableInputIndexes.length === 0,
    ),
    true,
  );

  // And the rule that matters: no packet, for any shape of ledger, may queue a
  // code outside the writeable set.
  const shapes = [
    [
      {
        id: "a",
        entryType: "INCOME",
        category: "SALARY",
        description: "s",
        amount: 500000,
      },
      {
        id: "b",
        entryType: "INCOME",
        category: "RENT",
        description: "r",
        amount: 600000,
      },
      {
        id: "c",
        entryType: "INCOME",
        category: "CAPITAL_GAIN",
        description: "cg",
        amount: 700000,
      },
      {
        id: "d",
        entryType: "INCOME",
        category: "PENSION",
        description: "p",
        amount: 900000,
      },
      {
        id: "e",
        entryType: "INCOME",
        category: "OTHER_INCOME",
        description: "o",
        amount: 100000,
      },
    ],
    [
      {
        id: "f",
        entryType: "INCOME",
        category: "PROPERTY_SALE",
        description: "sale",
        amount: 4000000,
      },
      {
        id: "g",
        entryType: "INCOME",
        category: "PROPERTY_PURCHASE",
        description: "buy",
        amount: 3000000,
      },
    ],
  ];
  for (const ledgerEntries of shapes) {
    const map = buildPortalFieldMap({
      taxYear: 2026,
      filerType: "my_business",
      taxpayerListStatus: "ATL",
      ledgerEntries,
      taxCredits: [
        {
          id: "t1",
          section: "149",
          subcategory: "salary",
          amount: 1000,
          source: "SALARY",
        },
        {
          id: "t2",
          section: "236C",
          subcategory: "property",
          amount: 2000,
          source: "MANUAL",
        },
      ],
    });
    for (const entry of flattenPortalFieldMap(map)) {
      assert.ok(
        PORTAL_WRITEABLE_CODES.has(String(entry.irisCode)),
        `packet queued ${entry.irisCode} for ${entry.ourCategory} with no captured writeable row`,
      );
    }
  }
});

test("the sync check guards exactly this round's files and is not decorative", () => {
  // This round's failure mode was a half-copied download: the new test file beside an
  // old `app/actions/packet.ts`. `check-workspace-sync.cjs` exists so that diagnosis is
  // one command instead of a bug report, so it has to (a) guard every file the round
  // touched, (b) prove its markers are real, and (c) actually fail a stale tree.
  const { spawnSync } = require("node:child_process");
  const checker = path.join(projectRoot, "scripts/check-workspace-sync.cjs");
  assert.ok(
    fs.existsSync(checker),
    "scripts/check-workspace-sync.cjs must exist",
  );
  const src = fs.readFileSync(checker, "utf8");
  for (const file of [
    "lib/tax/portal-field-map.ts",
    "app/actions/packet.ts",
    "components/tax/filing/hooks/use-filing-finalization.ts",
    "components/tax/filing/wizard-packet-step.tsx",
    "components/tax/filing/filing-wizard.tsx",
  ]) {
    check(`guard listed for ${file}`, src.includes(`"${file}"`), true);
  }
  // The markers must describe the tree as it is, not as someone remembers it.
  const self = spawnSync(process.execPath, [checker, "--self-test"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  check("its own self-test passes", self.status, 0);
  check(
    "reporting the real files it matched",
    /^self-test ok — .*\n$/.test(self.stdout),
    true,
  );

  // And a stale copy has to be caught: marker strings removed, one file absent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-stale-"));
  try {
    fs.mkdirSync(path.join(dir, "app/actions"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app/actions/packet.ts"),
      "// previous revision\n",
    );
    const run = spawnSync(process.execPath, [checker, "--root", dir], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    check("a stale tree exits non-zero", run.status, 1);
    check(
      "and names the offending file",
      /^! STALE.*app\/actions\/packet\.ts$/m.test(run.stdout),
      true,
    );
    // Regression this pins: the value after `--root` used to be read as a second flag,
    // so the checker printed usage and exited 2 — a tool that misparses its own
    // argument is worse than no tool, because STALE output looks like a healthy tree.
    check(
      "the root that was passed is the root that was scanned",
      run.stdout.includes(`root: ${path.resolve(dir)}`),
      true,
    );
    check("and no usage text leaked in", run.stdout.includes("usage:"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
