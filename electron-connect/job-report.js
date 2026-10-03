"use strict";

/**
 * Plain-language report for one agent run, written at the top of the job log
 * file. It answers, without reading raw JSON: which screens the agent visited
 * and in what order, where and why it stopped, which TaxRocket buttons were
 * pressed, what value went into which field and who put it there, how
 * employers and the income-source page were handled, and what the agent never
 * does (Calculate, Save, Submit, payment).
 *
 * Pure: no Electron, no file system. Everything comes from the run's own
 * outcome, so the report can never claim something the run did not record.
 */

const NOISY_STEPS = new Set(["readiness_evidence"]);

function clip(value, max = 300) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clock(iso) {
  const match = /T(\d\d:\d\d:\d\d)/.exec(String(iso || ""));
  return match ? `${match[1]}Z` : "";
}

function money(value) {
  const digits = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!digits || !Number.isFinite(Number(digits))) return String(value ?? "");
  return Number(digits).toLocaleString("en-US");
}

function describeConfirmations(confirmations) {
  const list = Array.isArray(confirmations) ? confirmations : [];
  if (!list.length) {
    return ["  - none (no TaxRocket button was pressed before this run)"];
  }
  return list.map((entry) => {
    const when = entry?.acknowledgedAt || entry?.confirmedAt || "";
    const text = entry?.acknowledgementText
      ? ` · box ticked: "${clip(entry.acknowledgementText, 400)}"`
      : "";
    return `  - ${entry?.action || "continue"} · Continue pressed ${when}${text}`;
  });
}

function describeIncomeSourcePage(executionLog) {
  const steps = executionLog.filter((entry) =>
    /^(economic_|new_return_setup)/.test(String(entry?.step || "")),
  );
  if (!steps.length) {
    const alreadyOpen = executionLog.some((entry) =>
      /^(real_autofill_workspace_confirmed|document_verified)$/.test(
        String(entry?.step || ""),
      ),
    );
    return [
      alreadyOpen
        ? "  Not shown in this run: the return was already open, so the agent selected no income source and answered no residency question."
        : "  No income-source page step was recorded in this run.",
    ];
  }
  const lines = [];
  for (const entry of steps) {
    const step = String(entry.step);
    let verdict = "";
    if (step === "economic_transactions_setup")
      verdict =
        "AGENT answered the income-source / residency questions from the approved packet. ";
    else if (step === "economic_transactions_start")
      verdict = "AGENT pressed Start Return Filling. ";
    else if (step === "economic_transactions_gate")
      verdict = "AGENT STOPPED and left the page untouched: ";
    else if (step === "economic_gate_wait")
      verdict = "Waited for the page to render: ";
    lines.push(
      `  ${clock(entry.at)} ${step} — ${verdict}${clip(entry.detail)}`,
    );
  }
  return lines;
}

function describeEmployers(autofill) {
  const employers = autofill?.employers;
  if (!employers) return ["  No employer information in this run."];
  const names = Array.isArray(employers.prepared) ? employers.prepared : [];
  if (!names.length)
    return ["  No employer names were in the approved packet; nothing to add."];
  if (employers.confirmedByTaxpayer) {
    return [
      `  ADDED BY YOU in FBR (you pressed Continue in TaxRocket). The agent did not search or check: ${names.join("; ")}`,
    ];
  }
  if (!employers.enabled) {
    return [
      `  NOT added: the agent's employer switch was off or this was a dry run. Names in the packet: ${names.join("; ")}`,
    ];
  }
  const lines = [];
  for (const entry of employers.results || []) {
    const who =
      entry.status === "added"
        ? `ADDED BY THE AGENT${
            entry.registeredName
              ? ` as \"${entry.registeredName}\"${entry.regNo ? ` (registration ${entry.regNo})` : ""}`
              : ""
          }`
        : entry.status === "already_listed"
          ? "ALREADY LISTED in IRIS (agent did nothing)"
          : `NOT ADDED by the agent (${entry.status})`;
    const extra =
      Array.isArray(entry.candidates) && entry.candidates.length
        ? ` · IRIS offered: ${entry.candidates.join(" / ")}`
        : "";
    lines.push(`  ${entry.name} → ${who}${extra}`);
  }
  return lines.length
    ? lines
    : [`  Names: ${names.join("; ")} (no result recorded)`];
}

function describeFields(autofill) {
  const results = Array.isArray(autofill?.results) ? autofill.results : [];
  if (!results.length) return ["  No field was attempted in this run."];
  return results.map((r) => {
    const planned = money(r.plannedValue ?? r.value);
    const isCash = r.cashDelta !== undefined && r.cashDelta !== null;
    const had =
      isCash && r.baselineValue !== undefined
        ? r.baselineValue
        : r.existingValue;
    const hadText =
      had === null || had === undefined || had === ""
        ? "IRIS cell was empty"
        : `IRIS cell had ${money(had)}`;
    const cashText = isCash
      ? ` · cash movement ${Number(r.cashDelta) >= 0 ? "+" : "-"}${money(Math.abs(Number(r.cashDelta)))} added to IRIS's own figure`
      : "";
    let who;
    if (r.status === "filled") who = "TYPED BY THE AGENT";
    else if (r.status === "already_correct")
      who =
        "ALREADY THERE — the agent typed nothing (entered by you or by an earlier run)";
    else if (r.status === "overwrite_needs_confirmation")
      who =
        "NOT TYPED — IRIS holds a different figure and it is never overwritten";
    else who = `NOT TYPED (${r.status})`;
    const label = r.rowDescription || r.label || "";
    return `  [${r.sectionId || "?"}] ${r.irisCode} ${label} · ${r.requestedColumn || ""} · planned ${planned} · ${hadText}${cashText} → ${who}`;
  });
}

function describeWealthSetup(autofill) {
  const setup = Array.isArray(autofill?.wealth?.setup)
    ? autofill.wealth.setup
    : [];
  return setup.map((s) => `  ${s.step}: ${clip(s.detail, 200)}`);
}

function describeReview(autofill, pauseAction) {
  if (pauseAction === "portal_handoff_review")
    return [
      "  The agent opened Personal Assets, the Payment tab and Computations (read-only) and is WAITING for you to review them and press Continue in TaxRocket.",
    ];
  if (autofill?.handoffReviewConfirmed)
    return [
      "  Confirmed by you in TaxRocket (box ticked and Continue pressed). The agent filled none of Property, Payments or Computations.",
    ];
  return ["  Not reached in this run."];
}

function buildJobReport(input = {}) {
  const executionLog = Array.isArray(input.executionLog)
    ? input.executionLog
    : [];
  const autofill = input.result?.autofill || input.result || {};
  const status = String(input.finalStatus || "unknown").toUpperCase();
  const lines = [];
  lines.push(
    `RUN ${status} · saved ${input.savedAt || ""} · job ${input.jobId || ""} · build ${input.build || ""}`,
  );
  if (input.pauseAction) {
    lines.push(`STOPPED HERE: ${input.pauseAction}`);
    lines.push(`WHY: ${clip(input.pauseMessage, 900)}`);
  }
  if (input.errorMessage) lines.push(`ERROR: ${clip(input.errorMessage, 900)}`);

  lines.push("", "TAXROCKET BUTTONS PRESSED BEFORE THIS RUN");
  lines.push(...describeConfirmations(input.confirmations));

  lines.push("", "INCOME-SOURCE PAGE (did the agent stop there, and why)");
  lines.push(...describeIncomeSourcePage(executionLog));

  lines.push("", "EMPLOYER DETAILS (manual or agent)");
  lines.push(...describeEmployers(autofill));

  lines.push("", "FIELDS (what value, which row, who put it there)");
  lines.push(...describeFields(autofill));
  const setup = describeWealthSetup(autofill);
  if (setup.length) lines.push("  Wealth setup:", ...setup);
  const conflicts = Array.isArray(autofill?.overwriteConflicts)
    ? autofill.overwriteConflicts
    : [];
  if (conflicts.length)
    lines.push(
      `  Conflicts left for you (IRIS holds another figure): ${conflicts.length}`,
    );

  lines.push("", "PROPERTY / PAYMENTS / COMPUTATIONS REVIEW");
  lines.push(...describeReview(autofill, input.pauseAction));

  lines.push(
    "",
    "NEVER DONE BY THE AGENT",
    "  Calculate: not pressed by the agent. IRIS has an Auto Calculate switch that recalculates when you change tabs; the agent cannot see whether you pressed Calculate yourself.",
    "  Save, Submit, Prepare PSID, payment: never pressed.",
  );

  lines.push("", "SCREENS VISITED AND STEPS, IN ORDER");
  for (const entry of executionLog) {
    if (NOISY_STEPS.has(String(entry?.step))) continue;
    lines.push(
      `  ${clock(entry?.at)} ${entry?.step} — ${clip(entry?.detail)}`.replace(
        /^ {2} /,
        "  ",
      ),
    );
  }
  return lines;
}

module.exports = { buildJobReport };
