"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const { buildJobReport } = require("../electron-connect/job-report.js");

const salaryRows = [
  {
    sectionId: "salary",
    irisCode: "1009",
    rowDescription: "Pay, Wages or Other Remuneration",
    requestedColumn: "Total Amount",
    plannedValue: "3420000",
    existingValue: "3,420,000",
    status: "already_correct",
  },
  {
    sectionId: "tax_deductions",
    irisCode: "64020004",
    rowDescription: "Salary of Employees u/s 149",
    requestedColumn: "Tax Collected / Deducted",
    plannedValue: "210000",
    existingValue: null,
    status: "filled",
  },
  {
    sectionId: "wealth",
    irisCode: "7087",
    rowDescription: "Other Personal / Household Expenses",
    requestedColumn: "Amount",
    plannedValue: "1080000",
    existingValue: "900,000",
    status: "overwrite_needs_confirmation",
  },
];

const text = (lines) => lines.join("\n");

test("completed run: fields say who typed what, employers say who added them", () => {
  const report = buildJobReport({
    savedAt: "2026-10-02T05:51:06.552Z",
    jobId: "job1",
    build: "b1",
    finalStatus: "completed",
    confirmations: [
      {
        action: "portal_employer_review",
        confirmedAt: "2026-10-02T05:30:00Z",
        acknowledgementText: "I added my employer.",
      },
      {
        action: "portal_handoff_review",
        confirmedAt: "2026-10-02T05:40:00Z",
        acknowledgementText: "I reviewed it.",
      },
    ],
    result: {
      autofill: {
        results: salaryRows,
        employers: {
          enabled: false,
          prepared: ["ACME LIMITED"],
          confirmedByTaxpayer: true,
          results: [],
        },
        handoffReviewConfirmed: true,
      },
    },
    executionLog: [
      {
        step: "real_autofill_workspace_confirmed",
        detail: "Return workspace confirmed.",
        at: "2026-10-02T05:50:01Z",
      },
      {
        step: "real_autofill_section",
        detail: "salary: switched; filling 1 field(s).",
        at: "2026-10-02T05:50:02Z",
      },
      { step: "readiness_evidence", detail: "HUGE" },
    ],
  });
  const out = text(report);
  assert.match(report[0], /^RUN COMPLETED/);
  assert.match(
    out,
    /portal_employer_review · Continue pressed 2026-10-02T05:30:00Z · box ticked: "I added my employer\."/,
  );
  assert.match(
    out,
    /1009 Pay, Wages or Other Remuneration .* planned 3,420,000 · IRIS cell had 3,420,000 → ALREADY THERE — the agent typed nothing/,
  );
  assert.match(out, /64020004 .* IRIS cell was empty → TYPED BY THE AGENT/);
  assert.match(
    out,
    /7087 .* IRIS cell had 900,000 → NOT TYPED — IRIS holds a different figure/,
  );
  assert.match(out, /ADDED BY YOU in FBR .*ACME LIMITED/);
  assert.match(out, /Not shown in this run: the return was already open/);
  assert.match(out, /Confirmed by you in TaxRocket/);
  assert.match(out, /Calculate: not pressed by the agent/);
  assert.match(out, /05:50:02Z real_autofill_section — salary: switched/);
  assert.doesNotMatch(out, /HUGE/, "noisy steps are left out");
});

test("paused run: says where it stopped and why, including the income-source page", () => {
  const report = buildJobReport({
    finalStatus: "paused",
    pauseAction: "portal_economic_transactions_gate",
    pauseMessage: "In the FBR window, select only Income from Salary.",
    result: {},
    executionLog: [
      {
        step: "economic_gate_wait",
        detail:
          "The URL is the income-source page but its controls never rendered within the wait.",
        at: "2026-10-02T05:00:00Z",
      },
      {
        step: "economic_transactions_gate",
        detail:
          "IRIS still has income sources; no unverified action was attempted.",
        at: "2026-10-02T05:00:07Z",
      },
    ],
  });
  const out = text(report);
  assert.match(out, /STOPPED HERE: portal_economic_transactions_gate/);
  assert.match(out, /WHY: In the FBR window, select only Income from Salary\./);
  assert.match(
    out,
    /economic_transactions_gate — AGENT STOPPED and left the page untouched/,
  );
  assert.match(out, /economic_gate_wait — Waited for the page to render/);
});

test("employer results name each employer and who handled it", () => {
  const out = text(
    buildJobReport({
      finalStatus: "paused",
      pauseAction: "portal_employer_review",
      result: {
        autofill: {
          employers: {
            enabled: true,
            prepared: ["A", "B", "C"],
            results: [
              { name: "A", status: "added" },
              { name: "B", status: "already_listed" },
              {
                name: "C",
                status: "employer_no_exact_match",
                candidates: ["C PVT | 1", "C LTD | 2"],
              },
            ],
          },
        },
      },
      executionLog: [],
    }),
  );
  assert.match(out, /A → ADDED BY THE AGENT/);
  assert.match(out, /B → ALREADY LISTED/);
  // A name IRIS completed itself is reported with the registered name it used.
  const resolved = buildJobReport({
    savedAt: "2026-10-03T00:00:00Z",
    finalStatus: "paused",
    result: {
      autofill: {
        employers: {
          enabled: true,
          prepared: ["technexia"],
          results: [{ name: "technexia", status: "added", regNo: "7163439", registeredName: "TECHNEXIA (SMC-PVT.) LIMITED" }],
        },
      },
    },
    executionLog: [],
  }).join("\n");
  assert.match(resolved, /technexia → ADDED BY THE AGENT as "TECHNEXIA \(SMC-PVT\.\) LIMITED" \(registration 7163439\)/);
  assert.match(
    out,
    /C → NOT ADDED by the agent \(employer_no_exact_match\) · IRIS offered: C PVT \| 1 \/ C LTD \| 2/,
  );
});

test("the report never throws on an empty or odd outcome", () => {
  assert.ok(buildJobReport().length > 0);
  assert.ok(
    buildJobReport({ result: null, executionLog: null, confirmations: "x" })
      .length > 0,
  );
});

test("report: a Cash in hand row shows IRIS's own figure and the movement added to it", () => {
  const text = buildJobReport({
    finalStatus: "completed",
    result: {
      autofill: {
        results: [
          {
            irisCode: "7012",
            label: "Cash (Non-Business)",
            requestedColumn: "Amount",
            sectionId: "wealth",
            status: "filled",
            value: "1350000",
            baselineValue: 1300000,
            cashDelta: 50000,
          },
        ],
      },
    },
  });
  const joined = text.join("\n");
  assert.match(joined, /7012/);
  assert.match(joined, /IRIS cell had 1,300,000/);
  assert.match(joined, /cash movement \+50,000 added to IRIS's own figure/);
  assert.match(joined, /planned 1,350,000/);
});

// ── plain-language attention message ────────────────────────────────────────
test("attention message: plain words, grouped by cause, no status codes", () => {
  const { buildAttentionMessage } = require("../electron-connect/job-report.js");
  const results = [
    { irisCode: "1009", status: "filled", value: "3420000" },
    { irisCode: "7037", status: "wealth_setup_failed", setupStatus: "gift_donor_not_resolved", giftDonorId: "4220180718935", value: "65000" },
    { irisCode: "7030", status: "wealth_section_unavailable", rowDescriptionIncludes: "PK35HABB0018067900476803", value: "697000" },
    { irisCode: "7030", status: "wealth_section_unavailable", rowDescriptionIncludes: "PK36SCBL0000001123456702", value: "75000" },
    { irisCode: "7012", status: "wealth_section_unavailable", value: "30000" },
    { irisCode: "7051", status: "overwrite_needs_confirmation", value: "1" },
  ];
  const out = buildAttentionMessage(results);
  assert.equal(out.itemCount, 4, "the overwrite conflict is worded by the caller");
  assert.match(out.text, /^1 of 6 figures are in IRIS\. 4 could not be entered by the agent:/);
  assert.match(out.text, /Gift received from 4220180718935 \(PKR 65,000\): IRIS did not recognise the donor number 4220180718935/);
  assert.match(out.text, /Bank account PK35HABB0018067900476803 \(PKR 697,000\); Bank account PK36SCBL0000001123456702 \(PKR 75,000\); Cash in hand \(PKR 30,000\): The agent could not open this part of the IRIS Wealth Statement/);
  assert.equal((out.text.match(/could not open this part/g) || []).length, 1, "one line per cause");
  assert.doesNotMatch(out.text, /wealth_|setup_failed|section_unavailable|gift_donor_not_resolved/, "no internal codes");
  assert.equal(buildAttentionMessage([{ irisCode: "1009", status: "filled" }]).itemCount, 0);
});

test("attention message: every status the row filler and the wealth driver can report has a plain sentence", () => {
  const { buildAttentionMessage } = require("../electron-connect/job-report.js");
  const filler = require("../electron-connect/iris-row-filler.js");
  const driver = require("../electron-connect/iris-wealth-driver.js");
  const statuses = [
    ...Object.values(filler.FILL_STATUS).filter((s) => !filler.SUCCESS_STATUSES.has(s) && s !== "overwrite_needs_confirmation"),
    ...Object.values(driver.WEALTH_STATUS),
  ];
  for (const status of statuses) {
    const { text } = buildAttentionMessage([{ irisCode: "7051", status, value: "5" }]);
    assert.ok(text.length > 0, status);
    assert.doesNotMatch(text, /[a-z]+_[a-z_]+/, `${status}: reads like a code -> ${text}`);
  }
});

test("attention message: main.js uses it for the review pause and the page keeps line breaks", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron-connect/main.js"), "utf8");
  assert.match(main, /buildAttentionMessage\(results, reportOptions\)/);
  assert.match(main, /typeof buildAttentionMessage === "function"/, "safe where the helper is not injected");
  const client = fs.readFileSync(path.join(__dirname, "../components/tax/fbr-connect-client.tsx"), "utf8");
  assert.equal((client.match(/whitespace-pre-line text-muted-foreground/g) || []).length, 2);
});

test("attention report: structured list for the page (what happened, what to do), conflicts and pre-filled rows included", () => {
  const { buildAttentionReport } = require("../electron-connect/job-report.js");
  const report = buildAttentionReport(
    [
      { irisCode: "1009", status: "filled", value: "1" },
      { irisCode: "7037", status: "wealth_setup_failed", setupStatus: "gift_donor_not_resolved", giftDonorId: "4220180715236", rowDescriptionIncludes: "Gift received on 2025-11-05 from 4220180715236", value: "15000" },
      { irisCode: "7030", status: "wealth_setup_failed", setupStatus: "bank_iban_not_resolved", rowDescriptionIncludes: "PK36SCBL0000001123456702", value: "75000" },
      { irisCode: "7087", status: "overwrite_needs_confirmation", existingValue: "1000000", plannedValue: "1130000", label: "Other Personal / Household Expenses" },
    ],
    { unexpectedPrefill: [{ code: "1049", cells: [{ value: "1049" }] }] },
  );
  assert.equal(report.done, 1);
  assert.equal(report.total, 4);
  assert.deepEqual(report.items.map((i) => i.kind), ["problem", "problem", "conflict", "prefill"]);
  const gift = report.items[0];
  assert.deepEqual(gift.lines, [{ key: "7037|Gift received on 2025-11-05 from 4220180715236", name: "Gift received from 4220180715236 on 2025-11-05", amount: "15,000" }]);
  assert.match(gift.what, /did not recognise the donor number 4220180715236/);
  assert.match(gift.todo, /Bank Intelligence/);
  assert.match(report.items[2].what, /IRIS already shows PKR 1,000,000; your packet has PKR 1,130,000/);
  assert.match(report.items[3].what, /does not cover/);
  // JSON-safe: it travels through the job result.
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test("attention panel: the job list passes only plain text, and the page shows the list instead of one text block", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  assert.match(read("app/actions/fbr-jobs.ts"), /readJobAttention\(JSON\.parse\(resultJson \|\| "\{\}"\)\?\.attention\)/);
  const client = read("components/tax/fbr-connect-client.tsx");
  assert.match(client, /<FbrAttentionPanel attention=\{activeJob\.attention\} \/>/);
  assert.match(client, /activeJob\.pauseAction === "portal_autofill_review" &&\s+activeJob\.attention/);
  assert.match(read("components/tax/fbr-attention-panel.tsx"), /What to do: /);
  const main = read("electron-connect/main.js");
  assert.match(main, /attention: attentionReport,/);
  assert.match(main, /attention: reviewRequired \? autofill\?\.result\?\.attention \|\| null : null/);
});

test("attention report: figures the taxpayer entered count as done, and figures after the stop are 'remaining'", () => {
  const { buildAttentionReport, buildAttentionMessage } = require("../electron-connect/job-report.js");
  const results = [
    { irisCode: "1009", status: "filled" },
    { irisCode: "7037", status: "wealth_setup_failed", setupStatus: "gift_donor_not_resolved", giftDonorId: "4220180715236", rowDescriptionIncludes: "Gift received on 2025-11-05 from 4220180715236", value: "15000" },
  ];
  const report = buildAttentionReport(results, { alreadyDone: 3, remaining: 4 });
  assert.equal(report.done, 4);
  assert.equal(report.total, 9);
  assert.equal(report.remaining, 4);
  const text = buildAttentionMessage(results, { alreadyDone: 3, remaining: 4 }).text;
  assert.match(text, /^4 of 9 figures are in IRIS\. The agent stopped at the first one it could not enter \(4 more come after it\):/);
  assert.match(text, /tick the confirmation and press Continue\. The agent then carries on from here\./);
  // Nothing in the plain text promises a retry any more.
  assert.doesNotMatch(text, /tries again|try again/);
});

test("taken over but not confirmed: the message says what the agent saw and what to fix, and names a gift typed under 7091", () => {
  const { buildAttentionReport, buildAttentionMessage } = require("../electron-connect/job-report.js");
  const gift = {
    irisCode: "7037", status: "takeover_unconfirmed", takeoverReason: "row_missing", setupStatus: "gift_row_needs_modal",
    giftDonorId: "4220180715236", rowDescriptionIncludes: "4220180715236", plannedValue: "15000",
    misplacedGift: { code: "7091", description: "Gift - 4220144218163 - X - gift", value: "15,000" },
  };
  const differs = { irisCode: "1009", status: "takeover_unconfirmed", takeoverReason: "value_differs", seenValue: "900", plannedValue: "1000" };
  const empty = { irisCode: "7051", status: "takeover_unconfirmed", takeoverReason: "empty", plannedValue: "960000" };
  const report = buildAttentionReport([gift, differs, empty]);
  assert.match(report.items[0].what, /cannot find a gift of PKR 15,000 under Inflows > Gift in IRIS\. There is a gift of PKR 15,000 under Gift \(row 7091\), which is for gifts you GAVE/);
  assert.match(report.items[0].todo, /Delete that row in IRIS \(the agent never deletes anything\), add the gift under Reconciliation of Net Assets > Inflows > Gift with PKR 15,000/);
  assert.match(report.items[1].what, /IRIS shows PKR 900 and the approved figure is PKR 1,000/);
  assert.match(report.items[2].what, /still empty/);
  assert.match(report.items[2].todo, /Type PKR 960,000/);
  for (const item of report.items) assert.match(item.todo, /Continue/);
  assert.match(buildAttentionMessage([differs]).text, /1009|Salary/);
  assert.doesNotMatch(JSON.stringify(report), /takeover_unconfirmed/);
});
