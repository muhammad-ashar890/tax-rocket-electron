"use strict";

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
