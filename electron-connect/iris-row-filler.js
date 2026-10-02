/**
 * IRIS 2.0 real-portal row filler.
 *
 * Phase 1 — replaces the mock-only `[data-tax-field-key="..."]` strategy for
 * live IRIS. Built from DOM evidence captured off the real portal (see
 * FBR_PHASES_2026-09-08.md), not guesswork.
 *
 * Key facts this module encodes:
 *
 *  1. A data row's container `id` IS the IRIS system code:
 *       <div class="row v-padding-5 tableRows dataRow" id="1009">
 *     So `#1009` == "Pay, Wages or Other Remuneration".
 *
 *  2. The amount inputs carry NO id/name/data-* hook. The only way to address a
 *     column is POSITIONAL, via the wrappers:
 *       row.querySelectorAll('.data-middle-child-wapper')[columnIndex]
 *
 *  3. Calculated/derived cells are rendered `disabled`. Salary row #1009 is
 *     [editable, disabled, editable, disabled]. Writing into a disabled cell is
 *     never correct — IRIS recomputes it and our value is silently lost.
 *
 *  4. Real column headers do NOT match our packet's column names. The packet
 *     says "Amount Subject to Normal Tax"; Salary renders "Subject to Normal
 *     Income"; Withholding renders "Tax Collected / Deducted". Hence the alias
 *     layer below.
 *
 *  5. Row ids are NOT guaranteed unique. Withholding fixture form5 has #64150002
 *     twice: a disabled summary row and an editable child row. `getElementById`
 *     would grab the summary. We disambiguate by preferring the row that has an
 *     editable cell.
 *
 * Design rule: never write into a cell we are not confident about. Every field
 * resolves to either a concrete (row, columnIndex) target or an explicit reason
 * code. Silent wrong-cell writes are the one outcome we refuse.
 */

"use strict";

const ROW_SELECTOR = ".tableRows.dataRow[id]";
const CELL_WRAPPER_SELECTOR = ".data-middle-child-wapper";
const DESCRIPTION_SELECTOR = ".row-description-text";

/**
 * Must equal AGENT_BUILD_TAG in main.js and BUILD_TAG in iris-navigation.js.
 * This file holds the in-page script that decides which cell a rupee lands in, so
 * a stale copy is a correctness risk, not a cosmetic one — main.js refuses to run
 * the real-portal flow when the three files disagree.
 */
const BUILD_TAG = "fix34-tax-year-employer-20261002";

/** Outcome reason codes. `filled` is the only success. */
const FILL_STATUS = {
  FILLED: "filled",
  ROW_NOT_FOUND: "row_not_found",
  AMBIGUOUS_ROW: "ambiguous_row",
  COLUMN_NOT_FOUND: "column_not_found",
  COLUMN_DISABLED: "column_disabled",
  NO_EDITABLE_CELL: "no_editable_cell",
  EMPTY_VALUE: "empty_value",
  MISSING_CODE: "missing_code",
  /**
   * The cell was located only by POSITION (4-column fallback) or by being the
   * sole editable box, so its column identity was never proven against a header.
   * Fine to report in a dry run; never good enough to write into a live return.
   */
  UNVERIFIED_TARGET: "unverified_target",
  /** The element no longer holds what we wrote (Angular rewrote/rejected it). */
  READBACK_MISMATCH: "readback_mismatch",
  /**
   * The cell already holds a DIFFERENT non-empty figure. IRIS (or the taxpayer)
   * put it there, so it is treated as authoritative: never silently replaced.
   */
  OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
  /** The cell already holds exactly the planned figure; nothing to write. */
  ALREADY_CORRECT: "already_correct",
};

/** Statuses that mean "the cell ends up holding the packet value". */
const SUCCESS_STATUSES = new Set(["filled", "already_correct"]);

/**
 * Amounts the portal will actually accept. The captured amount inputs are
 * `type=text` with `onkeypress="if (event.which > 57) return false;"` and a
 * `thousandseparator` attribute, i.e. plain digits only — so a value like
 * `1e+21` (what String(1e21) produces) or "1,234.50" would be silently mangled.
 */
function normalisePortalAmount(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { ok: false, reason: FILL_STATUS.EMPTY_VALUE, value: "" };
  }
  const raw = String(value).trim().replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return { ok: false, reason: "unparseable_amount", value: raw };
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount)) {
    return { ok: false, reason: "unparseable_amount", value: raw };
  }
  // IRIS renders whole rupees; half-up on the paisa keeps us aligned with the
  // engine's own rounding rather than JS banker's rounding.
  const rounded = Math.round(amount);
  return { ok: true, value: String(rounded), exact: rounded === amount };
}

/**
 * Canonical column intents. Our packet's column vocabulary and IRIS's rendered
 * headers are different dialects of the same idea, so we normalise both sides
 * to one of these before matching.
 */
const COLUMN_INTENT = {
  TOTAL: "total",
  EXEMPT_OR_FINAL: "exempt_or_final",
  NORMAL: "normal",
  TAX_COLLECTED: "tax_collected",
  AMOUNT: "amount",
};

/**
 * Header text (lowercased, whitespace-collapsed) -> intent.
 * Left side = strings actually observed in the captured IRIS 2.0 DOM, plus the
 * packet-side column names from lib/tax/portal-field-map.ts.
 */
const COLUMN_ALIASES = [
  // ── single-column sections (Personal Assets, Reconciliation) ──
  { intent: COLUMN_INTENT.AMOUNT, patterns: ["amount"] },

  // ── "total" family ──
  {
    intent: COLUMN_INTENT.TOTAL,
    patterns: [
      "total amount",
      "total income",
      "total amount/ receipts / value",
      "total amount / receipts / value",
      "taxable amount",
      "taxable values",
      "eligible amount",
      "total",
    ],
  },

  // ── exempt / fixed / final ──
  {
    intent: COLUMN_INTENT.EXEMPT_OR_FINAL,
    patterns: [
      "amount exempt from tax / subject to fixed / final tax",
      "subject to final tax",
      "subject to exemption",
      "amount exempt from tax",
      "inadmissible",
      "ineligible amount",
    ],
  },

  // ── normal tax ──
  {
    intent: COLUMN_INTENT.NORMAL,
    patterns: [
      "amount subject to normal tax",
      "subject to normal tax",
      // Salary renders "Income" instead of "Tax" for the same column:
      "subject to normal income",
      "amount subject to normal income",
      "admissible",
    ],
  },

  // ── tax collected / deducted ──
  {
    intent: COLUMN_INTENT.TAX_COLLECTED,
    patterns: [
      "tax collected / deducted",
      "tax collected/deducted",
      "tax deducted",
      "tax collected",
      "tax credit",
      "tax reducted", // observed IRIS typo in "Allowances, Reductions and Credits"
    ],
  },
];

/**
 * Where a given intent sits when the section renders the standard
 * 4-column income grid: [Total, Final, Exemption, Normal].
 * Used only as a fallback when header text is unavailable.
 */
const FOUR_COLUMN_FALLBACK = {
  [COLUMN_INTENT.TOTAL]: 0,
  [COLUMN_INTENT.EXEMPT_OR_FINAL]: 1,
  [COLUMN_INTENT.NORMAL]: 3,
};

function normaliseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Map any column label (ours or IRIS's) onto a canonical intent. */
function resolveColumnIntent(label) {
  const text = normaliseText(label);
  if (!text) return null;

  // Exact match wins over substring, so "total amount" doesn't get stolen by
  // a looser "amount" rule.
  for (const { intent, patterns } of COLUMN_ALIASES) {
    if (patterns.some((p) => p === text)) return intent;
  }
  for (const { intent, patterns } of COLUMN_ALIASES) {
    if (patterns.some((p) => text.includes(p))) return intent;
  }
  return null;
}

/**
 * Browser-side script source. This runs inside the IRIS page via
 * `webContents.executeJavaScript`, so it must be fully self-contained — no
 * closure over Node scope. Exported as a string factory for that reason.
 *
 * Returns a plain-serialisable report per field.
 */
function buildInPageFillScript(fields, options) {
  const payload = {
    fields,
    dryRun: Boolean(options && options.dryRun),
    // Live mode may not write to a cell whose column identity was only guessed.
    allowUnverifiedTargets: Boolean(options && options.allowUnverifiedTargets),
    rowSelector: ROW_SELECTOR,
    cellSelector: CELL_WRAPPER_SELECTOR,
    descriptionSelector: DESCRIPTION_SELECTOR,
    status: FILL_STATUS,
  };

  return `
  (() => {
    const CFG = ${JSON.stringify(payload)};
    const S = CFG.status;

    const norm = (v) => String(v == null ? "" : v).replace(/\\s+/g, " ").trim().toLowerCase();

    const cellsOf = (row) => Array.from(row.querySelectorAll(CFG.cellSelector));

    const inputOf = (wrapper) =>
      wrapper.querySelector('input:not([type="hidden"]), select, textarea');

    const isEditable = (el) => Boolean(el) && !el.disabled && !el.readOnly;

    // Row ids repeat (summary row + child row share a code). Prefer a row that
    // actually has an editable cell; that is the data-entry row.
    const findRows = (code, descriptionIncludes) =>
      Array.from(document.querySelectorAll(CFG.rowSelector)).filter(
        (r) =>
          r.id === String(code) &&
          // Rows that share a code (one 7030 row per bank account) are told
          // apart by text IRIS prints in the row, e.g. the IBAN.
          (!descriptionIncludes ||
            norm(descOf(r)).includes(norm(descriptionIncludes)))
      );

    const pickRow = (rows) => {
      if (rows.length <= 1) return { row: rows[0] || null, ambiguous: false };
      const editable = rows.filter((r) =>
        cellsOf(r).some((w) => isEditable(inputOf(w)))
      );
      if (editable.length === 1) return { row: editable[0], ambiguous: false };
      if (editable.length === 0) return { row: rows[0], ambiguous: false };
      return { row: editable[0], ambiguous: true };
    };

    const descOf = (row) => {
      const el = row.querySelector(CFG.descriptionSelector);
      return el ? el.textContent.replace(/\\s+/g, " ").trim() : "";
    };

    // Header labels for the table this row belongs to, so we can match a
    // column by TEXT rather than trusting a hardcoded index.
    //
    // A panel render contains SEVERAL heading bars: the section's own grid plus
    // the depreciation/amortisation sub-tables (the live capture of the Salary
    // view had 3, the Withholding view had 6). Taking "the last bar in the
    // parent" can therefore label a row with a different table's columns, so we
    // collect every candidate bar, keep only those whose value-label count
    // equals the row's cell count, and prefer the nearest one to the row.
    const barsFor = (scope) => Array.from(scope.querySelectorAll(".heading-bar"));

    const labelCountOf = (bar) => {
      const direct = Array.from(bar.children);
      let best = [];
      for (const child of direct) {
        const labels = Array.from(child.children)
          .map((c) => c.textContent.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (labels.length > best.length) best = labels;
      }
      const labels = best.length > 1
        ? best
        : direct.map((c) => c.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
      return labels.filter(
        (h) => norm(h) !== "description" && norm(h) !== "code" && norm(h) !== "action"
      );
    };

    const nearestBars = (row) => {
      const out = [];
      // Walk the sibling chain WITHOUT stopping at data rows: in the captured
      // IRIS markup the heading bar and the rows are siblings of the same grid
      // container, so row #2's previous sibling is row #1, not the bar.
      let node = row.previousElementSibling;
      let step = 0;
      while (node) {
        if (node.classList && node.classList.contains("heading-bar")) {
          out.push({ bar: node, distance: step, side: "before" });
          break;
        }
        node = node.previousElementSibling;
        step += 1;
      }
      node = row.nextElementSibling;
      step = 0;
      while (node) {
        if (node.classList && node.classList.contains("heading-bar")) {
          out.push({ bar: node, distance: step, side: "after" });
          break;
        }
        node = node.nextElementSibling;
        step += 1;
      }
      if (!out.length) {
        // Some live IRIS sections render the sticky header in a sibling card,
        // not in the row's own parent or a mat-expansion-panel. Walk upward to
        // the nearest ancestor that owns heading bars. This is still scoped to
        // the row's section; it does not search the whole document, so a salary
        // row cannot borrow a header from another active section.
        let scope = row.parentElement;
        let depth = 0;
        while (scope && scope !== document.body) {
          const bars = barsFor(scope);
          if (bars.length) {
            bars.forEach((bar, index) => {
              out.push({
                bar,
                distance: 100 + depth * 10 + index,
                side: "owner",
              });
            });
            break;
          }
          scope = scope.parentElement;
          depth += 1;
        }
      }
      return out;
    };

    // Prefer the bar that describes this row: first the nearest one before it
    // (a grid's own header), then its own header; among those, prefer a bar whose
    // value-label count equals the row's cell count, and only then accept a
    // differently-sized header (a single-column grid can legitimately render more
    // labels than cells).
    const headerLabelsFor = (row, expectedCount) => {
      const found = nearestBars(row)
        .map((entry) => ({ entry, labels: labelCountOf(entry.bar) }))
        .filter((c) => c.labels.length);
      if (!found.length) return [];
      const rank = (c) =>
        (c.entry.side === "before" ? 0 : 1) * 100 +
        (expectedCount && c.labels.length === expectedCount ? 0 : 10) +
        c.entry.distance;
      found.sort((a, b) => rank(a) - rank(b) || a.labels.length - b.labels.length);
      return found[0].labels;
    };


    const results = [];

    for (const field of CFG.fields) {
      const base = {
        key: field.key,
        irisCode: field.irisCode,
        label: field.label,
        requestedColumn: field.column,
        intent: field.intent,
        value: field.value,
      };

      if (!field.irisCode) {
        results.push({ ...base, status: S.MISSING_CODE });
        continue;
      }
      // Values are normalised Node-side (prepareField) so this script — which
      // runs inside the IRIS page and cannot see module scope — receives a plain
      // digit string it can write verbatim. The guards here are deliberate
      // duplicates: buildInPageFillScript is also called directly by the suites.
      if (
        field.amountValid === false ||
        field.value === null ||
        field.value === undefined ||
        String(field.value).trim() === ""
      ) {
        results.push({
          ...base,
          status: field.amountReason && field.amountReason !== S.EMPTY_VALUE
            ? field.amountReason
            : S.EMPTY_VALUE,
        });
        continue;
      }
      const amount = { value: String(field.value) };
      if (field.roundedFrom) base.roundedFrom = field.roundedFrom;

      const rows = findRows(field.irisCode, field.rowDescriptionIncludes);
      if (!rows.length) {
        results.push({ ...base, status: S.ROW_NOT_FOUND });
        continue;
      }

      const picked = pickRow(rows);
      const row = picked.row;
      if (picked.ambiguous) {
        results.push({
          ...base,
          status: S.AMBIGUOUS_ROW,
          rowCount: rows.length,
          rowDescription: descOf(row),
        });
        continue;
      }

      const wrappers = cellsOf(row);
      if (!wrappers.length) {
        results.push({ ...base, status: S.COLUMN_NOT_FOUND, rowDescription: descOf(row) });
        continue;
      }
      if (!wrappers.some((w) => isEditable(inputOf(w)))) {
        // IRIS derives every cell of this row (e.g. #1000 "Total Income from
        // Salary", #640000 "Adjustable Tax"). Naming it as a derived row instead
        // of "column_disabled" is the difference between "the packet targeted a
        // computed row" and "the selector bundle is stale" for the operator.
        results.push({
          ...base,
          status: S.NO_EDITABLE_CELL,
          rowDescription: descOf(row),
          columnCount: wrappers.length,
          hint: "computed_row",
        });
        continue;
      }

      // Single-column sections (Assets, Reconciliation): only one place to go.
      let index = -1;
      let matchedBy = null;

      if (wrappers.length === 1) {
        index = 0;
        matchedBy = "single_column";
      }

      // Preferred: match the rendered header text to our intent.
      if (index < 0) {
        const headers = headerLabelsFor(row, wrappers.length);
        // headers usually start with Description, Code, then the value columns
        const valueHeaders = headers.filter(
          (h) => norm(h) !== "description" && norm(h) !== "code" && norm(h) !== "action"
        );
        if (valueHeaders.length === wrappers.length) {
          for (let i = 0; i < valueHeaders.length; i += 1) {
            if (field.headerPatterns.some((p) => norm(valueHeaders[i]) === p)) {
              index = i; matchedBy = "header_exact"; break;
            }
          }
          if (index < 0) {
            for (let i = 0; i < valueHeaders.length; i += 1) {
              if (field.headerPatterns.some((p) => norm(valueHeaders[i]).includes(p))) {
                index = i; matchedBy = "header_partial"; break;
              }
            }
          }
        }
      }

      // Fallback: standard 4-column income grid positions.
      if (index < 0 && wrappers.length === 4 && Number.isInteger(field.fallbackIndex)) {
        index = field.fallbackIndex;
        matchedBy = "position_fallback";
      }

      // Last resort: if exactly one cell is editable, that is unambiguous.
      if (index < 0) {
        const editableIdx = wrappers
          .map((w, i) => (isEditable(inputOf(w)) ? i : -1))
          .filter((i) => i >= 0);
        if (editableIdx.length === 1) {
          index = editableIdx[0];
          matchedBy = "sole_editable";
        }
      }

      if (index < 0 || index >= wrappers.length) {
        results.push({
          ...base,
          status: S.COLUMN_NOT_FOUND,
          rowDescription: descOf(row),
          columnCount: wrappers.length,
        });
        continue;
      }

      const input = inputOf(wrappers[index]);
      if (!input) {
        results.push({
          ...base, status: S.COLUMN_NOT_FOUND, columnIndex: index,
          rowDescription: descOf(row), matchedBy,
        });
        continue;
      }

      if (!isEditable(input)) {
        // Calculated cell. IRIS derives it; writing here is always wrong.
        results.push({
          ...base, status: S.COLUMN_DISABLED, columnIndex: index,
          rowDescription: descOf(row), matchedBy,
        });
        continue;
      }

      // Overwrite guard. A non-empty cell is somebody's data. Identical figure:
      // nothing to do. Different figure: stop and report both values; the
      // operator decides. Empty or "0" is IRIS's blank state, safe to fill.
      const existingDigits = (input.value || "").replace(/[\\s,]/g, "");
      const existingIsBlank = existingDigits === "" || /^0+(\\.0+)?$/.test(existingDigits);
      if (!existingIsBlank) {
        const sameFigure = existingDigits === amount.value;
        if (sameFigure) {
          results.push({
            ...base, status: S.ALREADY_CORRECT, columnIndex: index, matchedBy,
            rowDescription: descOf(row), existingValue: input.value,
            plannedValue: amount.value, dryRun: Boolean(CFG.dryRun),
          });
          continue;
        }
        results.push({
          ...base, status: S.OVERWRITE_NEEDS_CONFIRMATION, columnIndex: index,
          matchedBy, rowDescription: descOf(row), existingValue: input.value,
          plannedValue: amount.value, dryRun: Boolean(CFG.dryRun),
        });
        continue;
      }

      if (CFG.dryRun) {
        results.push({
          ...base, status: S.FILLED, columnIndex: index, matchedBy,
          rowDescription: descOf(row), dryRun: true,
          plannedValue: amount.value,
          previousValue: input.value || "",
        });
        continue;
      }

      if (
        !CFG.dryRun &&
        !CFG.allowUnverifiedTargets &&
        (matchedBy === "position_fallback" || matchedBy === "sole_editable")
      ) {
        results.push({
          ...base,
          status: S.UNVERIFIED_TARGET,
          columnIndex: index,
          matchedBy,
          rowDescription: descOf(row),
        });
        continue;
      }

      const previousValue = input.value || "";
      // scrollIntoView/focus are convenience only — never let them abort a fill.
      try { if (typeof input.scrollIntoView === "function") input.scrollIntoView({ block: "center" }); } catch (e) {}
      try { if (typeof input.focus === "function") input.focus(); } catch (e) {}
      const target = amount.value;
      input.value = target;
      // Angular needs both to update its model and run recalculation.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      try { if (typeof input.blur === "function") input.blur(); } catch (e) {}
      input.dispatchEvent(new Event("blur", { bubbles: true }));

      const readback = (input.value || "").replace(/\s+/g, "").replace(/,/g, "");
      if (readback !== target) {
        // The portal kept a different figure (reformatted, clamped, or reverted).
        // Reporting "filled" here would be the worst possible outcome. Use
        // continue, never return: the remaining fields must still be attempted.
        results.push({
          ...base, status: S.READBACK_MISMATCH, columnIndex: index, matchedBy,
          rowDescription: descOf(row), previousValue, readback: input.value,
        });
        continue;
      }

      results.push({
        ...base, status: S.FILLED, columnIndex: index, matchedBy,
        rowDescription: descOf(row), previousValue,
        readback: input.value,
      });
    }

    return results;
  })()
  `;
}

/**
 * READ-ONLY snapshot of every data row on the screen: code, description and the
 * current value of each cell. It never focuses, types, clicks or dispatches an
 * event, so it is safe to run before any write and in dry-run mode.
 */
function buildInPageSnapshotScript() {
  return `
  (() => {
    const clean = (v) => String(v == null ? "" : v).replace(/\\s+/g, " ").trim();
    return Array.from(document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)})).map((row) => {
      const desc = row.querySelector(${JSON.stringify(DESCRIPTION_SELECTOR)});
      const cells = Array.from(row.querySelectorAll(${JSON.stringify(CELL_WRAPPER_SELECTOR)})).map((w) => {
        const el = w.querySelector('input:not([type="hidden"]), select, textarea');
        return el
          ? { value: clean(el.value), editable: !el.disabled && !el.readOnly }
          : null;
      });
      return { code: row.id, description: desc ? clean(desc.textContent) : "", cells };
    });
  })()
  `;
}

/** A cell value that is neither empty nor IRIS's zero placeholder. */
function isNonBlankAmount(value) {
  const digits = String(value == null ? "" : value).replace(/[\s,]/g, "");
  return digits !== "" && !/^0+(\.0+)?$/.test(digits);
}

/**
 * Compare a snapshot against the packet. Returns the rows that already carry a
 * figure IRIS (or the taxpayer) entered but which the packet does not cover, so
 * the operator is warned instead of the agent assuming the draft is clean.
 */
function findUnexpectedPrefill(snapshot, plannedCodes) {
  const planned = new Set((plannedCodes || []).map((c) => String(c)));
  const out = [];
  for (const row of snapshot || []) {
    if (planned.has(String(row.code))) continue;
    const filledEditable = (row.cells || [])
      .map((cell, columnIndex) => ({ cell, columnIndex }))
      .filter(
        ({ cell }) => cell && cell.editable && isNonBlankAmount(cell.value),
      );
    if (!filledEditable.length) continue;
    out.push({
      code: row.code,
      description: row.description,
      cells: filledEditable.map(({ cell, columnIndex }) => ({
        columnIndex,
        value: cell.value,
      })),
    });
  }
  return out;
}

async function snapshotIrisRows(windowInstance) {
  return windowInstance.webContents.executeJavaScript(
    buildInPageSnapshotScript(),
  );
}

/**
 * Turn a packet autofill field into the shape the in-page script consumes.
 * Column resolution happens here (Node side) so the alias table stays in one
 * place and is unit-testable without a browser.
 */
function prepareField(field) {
  const irisCode = field.irisCode || null;
  const column = field.column || null;
  const intent = resolveColumnIntent(column);
  const amount = normalisePortalAmount(field.value);

  const headerPatterns = [];
  if (intent) {
    for (const alias of COLUMN_ALIASES) {
      if (alias.intent === intent) headerPatterns.push(...alias.patterns);
    }
  }
  if (column) headerPatterns.push(normaliseText(column));

  return {
    key: field.key,
    irisCode,
    label: field.label || "",
    column,
    intent,
    value: amount.ok ? amount.value : field.value,
    amountValid: amount.ok,
    amountReason: amount.ok ? null : amount.reason,
    amountExact: amount.ok ? amount.exact : false,
    roundedFrom: amount.ok && !amount.exact ? String(field.value) : undefined,
    rowDescriptionIncludes: field.rowDescriptionIncludes || undefined,
    headerPatterns: Array.from(new Set(headerPatterns)),
    fallbackIndex: intent != null ? FOUR_COLUMN_FALLBACK[intent] : undefined,
  };
}

/**
 * Fill a batch of packet fields into the live IRIS page.
 *
 * @param {import('electron').BrowserWindow} windowInstance
 * @param {Array} portalFieldMap flat PortalAutofillField[] from the packet
 * @param {{ dryRun?: boolean, section?: string|null }} [options]
 * @returns {Promise<{results: Array, summary: object}>}
 */
async function fillIrisRows(windowInstance, portalFieldMap, options = {}) {
  const prepared = (portalFieldMap || [])
    .filter((f) => f && f.irisCode)
    .map(prepareField);
  // Amounts the portal could never accept are refused here, so the in-page
  // script only ever sees values it can write verbatim.
  const rejected = prepared
    .filter((f) => !f.amountValid)
    .map((f) => ({
      key: f.key,
      irisCode: f.irisCode,
      label: f.label,
      requestedColumn: f.column,
      status:
        f.value === null ||
        f.value === undefined ||
        String(f.value).trim() === ""
          ? FILL_STATUS.EMPTY_VALUE
          : f.amountReason,
    }));
  const fields = prepared.filter((f) => f.amountValid);

  if (!fields.length) {
    const results = rejected;
    return { results, summary: summarise(results) };
  }

  const script = buildInPageFillScript(fields, options);
  const filled = await windowInstance.webContents.executeJavaScript(script);
  const results = [...filled, ...rejected];
  return { results, summary: summarise(results) };
}

function summarise(results) {
  const byStatus = {};
  for (const r of results || []) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  const filled = Array.from(SUCCESS_STATUSES).reduce(
    (sum, status) => sum + (byStatus[status] || 0),
    0,
  );
  return {
    total: (results || []).length,
    filled,
    alreadyCorrect: byStatus[FILL_STATUS.ALREADY_CORRECT] || 0,
    skipped: (results || []).length - filled,
    byStatus,
  };
}

/**
 * Human-readable one-liner for the execution log / audit trail.
 * Deliberately explicit about what did NOT get filled.
 */
function describeFillSummary(summary) {
  if (!summary || !summary.total)
    return "No IRIS-coded fields were available to fill.";
  const parts = [`${summary.filled}/${summary.total} fields filled`];
  if (summary.alreadyCorrect)
    parts.push(`${summary.alreadyCorrect} already correct (left untouched)`);
  const skips = Object.entries(summary.byStatus || {})
    .filter(([status]) => !SUCCESS_STATUSES.has(status))
    .map(([status, count]) => `${count} ${status}`);
  if (skips.length) parts.push(`skipped: ${skips.join(", ")}`);
  return parts.join("; ");
}

module.exports = {
  BUILD_TAG,
  FILL_STATUS,
  normalisePortalAmount,
  COLUMN_INTENT,
  COLUMN_ALIASES,
  FOUR_COLUMN_FALLBACK,
  ROW_SELECTOR,
  CELL_WRAPPER_SELECTOR,
  resolveColumnIntent,
  normaliseText,
  prepareField,
  buildInPageFillScript,
  buildInPageSnapshotScript,
  snapshotIrisRows,
  findUnexpectedPrefill,
  isNonBlankAmount,
  SUCCESS_STATUSES,
  fillIrisRows,
  summarise,
  describeFillSummary,
};
