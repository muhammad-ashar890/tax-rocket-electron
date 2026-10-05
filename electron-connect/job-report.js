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
  const taken = (Array.isArray(autofill?.takenOver) ? autofill.takenOver : []).map(
    (item) =>
      item.checked
        ? `  ENTERED BY YOU in FBR (confirmed in TaxRocket): ${item.name} - the agent read it back (read-only) and it matches the approved figure`
        : `  ENTERED BY YOU in FBR (confirmed in TaxRocket): ${item.name} - the agent could not check it`,
  );
  const stoppedNote =
    autofill?.reviewRequired && Array.isArray(autofill?.pendingItems) && autofill.pendingItems.length
      ? [
          `  The agent STOPPED at the first figure it could not enter. Later figures were not touched in this run.`,
        ]
      : [];
  if (!results.length && !taken.length) return ["  No field was attempted in this run."];
  return [...taken, ...stoppedNote, ...results.map((r) => {
    const planned = money(r.plannedValue ?? r.value);
    const isCash = r.cashDelta !== undefined && r.cashDelta !== null;
    const had = isCash && r.baselineValue !== undefined ? r.baselineValue : r.existingValue;
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
  })];
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

// ── Plain-language list of what needs the taxpayer (shown in TaxRocket) ──────
// The raw status codes stay in the log file and the report above. What the
// taxpayer reads must say what happened and what to do, in everyday words.

const DONE_STATUSES = new Set(["filled", "already_correct"]);

const GIFT_HELP =
  "add the gift yourself in IRIS under Reconciliation of Net Assets > Inflows > Gift.";

/** Stable identity of one planned figure (the same rule the agent uses to skip items the taxpayer entered). */
function itemKey(r) {
  return String(
    r.key || `${String(r.irisCode || "")}|${String(r.rowDescriptionIncludes || "")}`,
  );
}

/** { key, name, amount } for one result; amount is a formatted number or null. */
function attentionLine(r) {
  const code = String(r.irisCode || "");
  const hint = String(r.rowDescriptionIncludes || "");
  const amount = r.plannedValue ?? r.value;
  const shown =
    amount === undefined || amount === null || amount === ""
      ? null
      : money(amount);
  let name;
  if (code === "7037") {
    const donor = r.giftDonorId || (/ from (\S+)$/.exec(hint) || [])[1] || "";
    const date = (/ on (\d{4}-\d{2}-\d{2}) from /.exec(hint) || [])[1] || "";
    name = `Gift received${donor ? ` from ${donor}` : ""}${date ? ` on ${date}` : ""}`;
  } else if (code === "7030") name = `Bank account ${hint || ""}`.trim();
  else if (code === "7012") name = "Cash in hand";
  else if (code === "7098") name = "Tax already paid (Adjustments in Outflows)";
  else if (code === "1009") name = "Salary";
  else if (code === "64020004") name = "Salary tax withheld";
  else {
    const label = String(r.rowDescription || r.label || "").trim();
    name = label ? `${label} (row ${code})` : `Row ${code}`;
  }
  return { key: itemKey(r), name, amount: shown };
}

/** { what, todo }: what happened, and what the taxpayer should do about it. */
function attentionReason(r) {
  const setup = String(r.setupStatus || "");
  const donor = r.giftDonorId ? ` ${r.giftDonorId}` : "";
  if (setup === "gift_donor_not_resolved")
    return {
      what: `IRIS did not recognise the donor number${donor}.`,
      todo: `Check the CNIC / NTN of this gift in Bank Intelligence (pencil icon), or ${GIFT_HELP}`,
    };
  if (setup === "gift_row_not_created")
    return {
      what: "The gift was saved in IRIS but the new row was not seen on the page.",
      todo: "Look under Gift in IRIS: if the row is there, type the amount in it; if it is not, add the gift yourself. Do not add it twice.",
    };
  if (setup.startsWith("gift_"))
    return {
      what: "IRIS would not accept the gift details.",
      todo: `Please ${GIFT_HELP}`,
    };
  if (setup === "bank_iban_not_resolved")
    return {
      what: "IRIS did not recognise this IBAN.",
      todo: "Check it against your bank statement, or add the account yourself under Personal Assets > Bank Account(s).",
    };
  if (setup === "unexpected_dialog_open")
    return {
      what: "A pop-up was already open in IRIS.",
      todo: "Close it in IRIS and enter this figure yourself.",
    };
  if (r.status === "takeover_unconfirmed") {
    const planned = money(r.plannedValue ?? r.value);
    const gift = String(r.irisCode) === "7037";
    const where = gift
      ? "under Reconciliation of Net Assets > Inflows > Gift"
      : "in the right row";
    if (r.takeoverReason === "value_differs")
      return {
        what: `You said you entered this yourself, but IRIS shows PKR ${money(r.seenValue)} and the approved figure is PKR ${planned}.`,
        todo: "Correct the amount in IRIS, then press Continue so the agent checks it again. If the approved figure itself is wrong, fix it in TaxRocket and start the filing again.",
      };
    if (r.takeoverReason === "empty")
      return {
        what: "You said you entered this yourself, but the amount in IRIS is still empty.",
        todo: `Type PKR ${planned} ${where}, then press Continue so the agent checks it again.`,
      };
    if (r.takeoverReason === "ambiguous")
      return {
        what: "You said you entered this yourself, but IRIS shows more than one matching row, so the agent cannot tell which one is yours.",
        todo: "Keep only one matching row in IRIS, then press Continue so the agent checks it again.",
      };
    if (r.takeoverReason === "row_missing") {
      const misplaced = r.misplacedGift
        ? ` There is a gift of PKR ${money(r.misplacedGift.value)} under Gift (row ${r.misplacedGift.code}), which is for gifts you GAVE (an outflow), not gifts you received.`
        : "";
      return {
        what: `You said you entered this yourself, but the agent cannot find it in IRIS${gift ? " under Inflows > Gift for this donor" : ""}.${misplaced}`,
        todo: r.misplacedGift
          ? `Delete that row in IRIS (the agent never deletes anything), add the gift ${where} with PKR ${planned} and the donor number shown above, then press Continue so the agent checks it again.`
          : `Add it ${where} with PKR ${planned}, then press Continue so the agent checks it again.`,
      };
    }
    return {
      what: "You said you entered this yourself, but the agent could not read it back from IRIS.",
      todo: "Check that it is in the right place with the right amount, then press Continue so the agent checks it again.",
    };
  }
  switch (r.status) {
    case "wealth_section_unavailable":
      return {
        what: "The agent could not open this part of the IRIS Wealth Statement.",
        todo: "Close any pop-up that is open in IRIS, make sure Wealth Statement is set to Yes, then enter this figure yourself.",
      };
    case "wealth_setup_failed":
      return {
        what: "IRIS did not let the agent add this row.",
        todo: "Add the row yourself in the Wealth Statement and type the amount.",
      };
    case "wealth_unsupported_row":
      return {
        what: "The agent does not enter this kind of row.",
        todo: "Please enter it yourself in IRIS.",
      };
    case "wealth_row_missing_dry_run":
      return {
        what: "This was a practice run, so the row was not created.",
        todo: "Run the live filing to create it.",
      };
    case "wealth_cash_would_be_negative":
      return {
        what: "Adding this would make Cash in hand negative.",
        todo: "Check the Cash in hand figure in IRIS.",
      };
    case "wealth_cash_unreadable":
      return {
        what: "Cash in hand in IRIS is not a plain number.",
        todo: "Check it and enter the right figure yourself.",
      };
    case "row_not_found":
      return {
        what: "IRIS does not show this row on the page.",
        todo: "Enter the amount yourself if the row exists.",
      };
    case "ambiguous_row":
      return {
        what: "IRIS shows more than one matching row, so the agent did not guess.",
        todo: "Enter the amount in the right row yourself.",
      };
    case "column_not_found":
    case "column_disabled":
    case "no_editable_cell":
      return {
        what: "IRIS does not let anyone type in this cell.",
        todo: "Check the row in IRIS.",
      };
    case "unverified_target":
    case "readback_mismatch":
      return {
        what: "The agent could not confirm that the number landed in the right cell.",
        todo: "Please check this row and enter the amount yourself.",
      };
    case "empty_value":
    case "missing_code":
      return {
        what: "This figure has no usable amount or row in your packet.",
        todo: "Check the packet and enter it yourself.",
      };
    default:
      return {
        what: "The agent could not enter this safely.",
        todo: "Please enter it yourself in IRIS.",
      };
  }
}

/**
 * Structured version, for the TaxRocket page.
 *   { done, total, items: [{ kind, lines: [{name, amount}], what, todo }] }
 * Items that failed for the same reason share one entry. kind is "problem",
 * "conflict" (IRIS holds another figure; never overwritten) or "prefill"
 * (IRIS holds a figure the packet does not cover).
 */
function buildAttentionReport(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  // Figures the taxpayer entered themselves count as done; figures the agent
  // has not reached yet (it stops at the first problem) are "remaining".
  const alreadyDone = Math.max(0, Number(options.alreadyDone) || 0);
  const remaining = Math.max(0, Number(options.remaining) || 0);
  const done =
    list.filter((r) => DONE_STATUSES.has(r.status)).length + alreadyDone;
  const groups = new Map();
  for (const r of list) {
    if (DONE_STATUSES.has(r.status) || r.status === "overwrite_needs_confirmation")
      continue;
    const reason = attentionReason(r);
    const key = `${reason.what}|${reason.todo}`;
    if (!groups.has(key)) groups.set(key, { kind: "problem", lines: [], ...reason });
    groups.get(key).lines.push(attentionLine(r));
  }
  const items = [...groups.values()];
  for (const r of list) {
    if (r.status !== "overwrite_needs_confirmation") continue;
    items.push({
      kind: "conflict",
      lines: [attentionLine({ ...r, plannedValue: undefined, value: undefined })],
      what: `IRIS already shows PKR ${money(r.existingValue)}; your packet has PKR ${money(r.plannedValue ?? r.value)}.`,
      todo: "The agent never overwrites a figure in IRIS. Decide which figure is right and correct it in the FBR window.",
    });
  }
  for (const row of Array.isArray(options.unexpectedPrefill) ? options.unexpectedPrefill : []) {
    const values = (row.cells || []).map((cell) => money(cell.value)).join(" / ");
    items.push({
      kind: "prefill",
      lines: [{ key: `prefill|${row.code}`, name: `Row ${row.code}`, amount: values || null }],
      what: "IRIS already holds a figure that your packet does not cover.",
      todo: "The IRIS total will differ from the packet until you have checked it.",
    });
  }
  return { done, total: list.length + alreadyDone + remaining, remaining, items };
}

/**
 * Plain-text version of the same list (older pages, logs). Overwrite conflicts
 * and pre-filled rows are NOT included: the caller words those.
 * Returns { text, itemCount }.
 */
function buildAttentionMessage(results, options = {}) {
  const report = buildAttentionReport(results, options);
  const problems = report.items.filter((item) => item.kind === "problem");
  if (!problems.length) return { text: "", itemCount: 0 };
  const count = problems.reduce((sum, item) => sum + item.lines.length, 0);
  const lines = [
    report.remaining > 0
      ? `${report.done} of ${report.total} figures are in IRIS. The agent stopped at the first one it could not enter (${report.remaining} more come after it):`
      : `${report.done} of ${report.total} figures are in IRIS. ${count} could not be entered by the agent:`,
  ];
  for (const item of problems) {
    const names = item.lines
      .map((line) => (line.amount ? `${line.name} (PKR ${line.amount})` : line.name))
      .join("; ");
    lines.push(`\u2022 ${names}: ${item.what} ${item.todo}`);
  }
  lines.push(
    options.noRetryHint
      ? "Enter these in the FBR window yourself."
      : `Enter this in the FBR window yourself, tick the confirmation and press Continue. The agent then carries on from here.`,
  );
  return { text: lines.join("\n"), itemCount: count };
}

module.exports = { buildJobReport, buildAttentionMessage, buildAttentionReport };
