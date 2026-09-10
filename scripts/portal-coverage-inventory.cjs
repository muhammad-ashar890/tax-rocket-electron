#!/usr/bin/env node
/**
 * Portal coverage inventory — what this codebase can prove about IRIS's real DOM,
 * and exactly which captures would close each gap.
 *
 *   HOME=<dir with "IRIS 2.0 *.html"> node scripts/portal-coverage-inventory.cjs
 *   npm run inventory:portal-coverage -- --csv IRIS_System_Field_Codes_Extracted.csv
 *
 * Why this exists: the map of IRIS codes we write against comes from a client CSV
 * (463 codes) and only a fraction of those have ever been SEEN rendered in a real
 * page. "Seen" is the only standard that matters here — an unverified code must not
 * be guessed into a taxpayer's return, so every unmapped category has to stay a
 * reported manual-entry gap until a capture proves it. This script turns that
 * situation into a concrete shopping list instead of a vague "needs more captures".
 *
 * Read-only: nothing here writes, navigates, or changes the packet.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(projectRoot, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    filename,
  );
};

const { IRIS_CODES, CATEGORY_TO_IRIS_MAP } = require(path.join(
  projectRoot,
  "lib/tax/iris-field-codes.ts",
));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CAPTURE_DIR = arg("captures", process.env.CAPTURE_DIR || path.join(os.homedir(), "uploads"));
const CSV_CANDIDATES = [
  arg("csv", ""),
  path.join(CAPTURE_DIR, "IRIS_System_Field_Codes_Extracted.csv"),
  path.join(projectRoot, "IRIS_System_Field_Codes_Extracted.csv"),
].filter(Boolean);
const CSV = CSV_CANDIDATES.find((file) => fs.existsSync(file)) || CSV_CANDIDATES[0];

const ROW_RE = /class="[^"]*tableRows[^"]*"\s+id="(\d+)"/g;

function readCaptures(dir) {
  if (!fs.existsSync(dir)) return null;
  const byFile = new Map();
  const all = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => /\.html$/i.test(f))) {
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    const codes = new Set([...html.matchAll(ROW_RE)].map((m) => m[1]));
    if (codes.size) {
      byFile.set(file, codes);
      for (const code of codes) all.add(code);
    }
  }
  return { byFile, seen: all };
}

function readCsvCodes(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const codes = new Set();
  // The client extract is TAB-separated (despite the .csv name) with the code in a
  // `System_Code` column, and some fields contain "|" and quotes. A naive
  // leading-column regex silently returns zero codes, which reads as "nothing is
  // verified" — so locate the column from the header instead.
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) return null;
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(delimiter).map((cell) =>
    cell.trim().replace(/^"|"$/g, "").toLowerCase(),
  );
  const index = header.findIndex(
    (cell) => cell === "system_code" || cell === "code" || cell === "iris_code",
  );
  if (index < 0) return null;
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter);
    const value = String(cells[index] || "").trim().replace(/^"|"$/g, "");
    if (/^\d{3,10}$/.test(value)) codes.add(value);
  }
  return codes.size ? codes : null;
}

const captures = readCaptures(CAPTURE_DIR);
if (!captures) {
  console.error(
    `No captures found at ${CAPTURE_DIR}.\n` +
      `Point at the folder holding the saved "IRIS 2.0 *.html" pages:\n` +
      `  HOME=/path/to/captures npm run inventory:portal-coverage`,
  );
  process.exit(1);
}

const catalog = readCsvCodes(CSV);
const mapped = Object.values(IRIS_CODES);
const mappedCodes = new Set(mapped.map((c) => c.code));

const areas = new Map();
for (const entry of mapped) {
  const area = entry.portalArea || "(unlabelled)";
  if (!areas.has(area)) areas.set(area, { have: [], missing: [], summary: [] });
  const bucket = areas.get(area);
  if (entry.rowLevel === "Summary") bucket.summary.push(entry);
  if (captures.seen.has(entry.code)) bucket.have.push(entry);
  else bucket.missing.push(entry);
}

if (process.argv.includes("--emit-evidence")) {
  const rows = readRowCells(CAPTURE_DIR);
  if (rows.size === 0) {
    console.error(`no rendered grid rows under ${CAPTURE_DIR} — refusing to write an empty evidence file`);
    process.exit(1);
  }
  const target = path.join(projectRoot, "lib", "tax", "portal-row-evidence.ts");
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const after = renderEvidenceFile(rows);
  if (before === after) {
    console.log(`
evidence: unchanged (${rows.size} rendered rows) at lib/tax/portal-row-evidence.ts`);
  } else {
    fs.writeFileSync(target, after);
    const writeable = [...rows.values()].filter((r) => r.writeable.size).length;
    console.log(
      `\nevidence: wrote lib/tax/portal-row-evidence.ts — ${rows.size} rendered rows, ` +
        `${writeable} writeable, ${rows.size - writeable} computed/read-only`,
    );
    console.log("          re-run the packet afterwards: held codes become targets only through this file.");
  }
}

console.log("=== IRIS coverage inventory ===");
console.log(`captures:   ${CAPTURE_DIR} (${captures.byFile.size} pages with data rows)`);
console.log(`rows seen:  ${captures.seen.size} distinct row ids rendered by the portal`);
if (catalog) {
  const unseen = [...catalog].filter((code) => !captures.seen.has(code));
  console.log(
    `client csv:   ${catalog.size} codes; ${unseen.length} of them have never been ` +
      `seen rendered (${((unseen.length / catalog.size) * 100).toFixed(0)}% unverified)`,
  );
  const unmapped = [...catalog].filter((code) => !mappedCodes.has(code));
  console.log(
    `            ${unmapped.length} codes exist in the portal extract but this agent ` +
      `has no IRIS_CODES entry (never written, never reported as a gap either)`,
  );
}
console.log(`this map:   ${mapped.length} codes the agent is allowed to write`);
if (fs.existsSync(path.join(projectRoot, "lib/tax/portal-row-evidence.ts"))) {
  let PORTAL_WRITEABLE_CODES, PORTAL_ROW_EVIDENCE;
  try {
    ({ PORTAL_WRITEABLE_CODES, PORTAL_ROW_EVIDENCE } = require(path.join(
      projectRoot,
      "lib/tax/portal-row-evidence.ts",
    )));
  } catch (error) {
    console.log(
      `evidence:   lib/tax/portal-row-evidence.ts is unreadable (${error.message.split("\n")[0]}) — re-run with --emit-evidence`,
    );
    PORTAL_WRITEABLE_CODES = null;
  }
  if (!PORTAL_WRITEABLE_CODES) {
    process.exitCode = 1;
  } else {
  const writeable = mapped.filter((c) => PORTAL_WRITEABLE_CODES.has(c.code));
  const computedHere = mapped.filter(
    (c) => !PORTAL_WRITEABLE_CODES.has(c.code) && PORTAL_ROW_EVIDENCE[c.code],
  );
  const unseen = mapped.filter((c) => !PORTAL_ROW_EVIDENCE[c.code]);
  console.log(
    `evidence:   ${writeable.length} codes proven enterable (targeted), ` +
      `${unseen.length} never rendered (held as manual-entry), ` +
      `${computedHere.length} rendered but read-only ` +
      `(${Object.values(PORTAL_ROW_EVIDENCE).filter((e) => e.writeableInputIndexes.length === 0).length}/${Object.keys(PORTAL_ROW_EVIDENCE).length} captured rows are computed)`,
  );
  }
}
console.log("");
console.log("area                              written-where  verified  deliberately-skipped");
for (const [area, bucket] of [...areas.entries()].sort()) {
  const skippedSummary = bucket.summary
    .filter((entry) => !captures.seen.has(entry.code))
    .map((entry) => entry.code);
  console.log(
    area.padEnd(32) +
      `${String(bucket.have.length).padStart(3)}/${String(bucket.have.length + bucket.missing.length).padEnd(3)}` +
      `          ${(bucket.missing.length === 0 ? "complete" : `${bucket.missing.length} gap(s)`).padEnd(12)}` +
      `${skippedSummary.length ? `summary rows never rendered: ${skippedSummary.join(", ")}` : "—"}`,
  );
}

// The shopping list: one line per capture that would actually unlock a route.
const NEEDS = [
  {
    page: "Property receipts / deductions (Income from Property)",
    unlocks: ["2001", "2031"],
    note: "rent receipts and the 1/5th repair deduction; 2000/2029/2099 are computed and must stay unwritten",
  },
  {
    page: "Other Sources receipts (bank profit, dividends, annuity)",
    unlocks: ["500312", "5003041", "5005", "5007", "5028"],
    note: "this is what today turns BANK_PROFIT/DIVIDEND into a reported gap instead of a fill",
  },
  {
    page: "Capital Gain (securities held long term and short term)",
    unlocks: ["4006", "4016", "4017", "4026", "4036", "4037"],
    note: "net-gain rows are derived — the capture shows which of the six are enterable",
  },
  {
    page: "Adjustable Tax grid: bank profit / rent / imports / 231AB / 236C / 236K / 236Y rows",
    unlocks: [
      "64040002",
      "64040001",
      "64080001",
      "64010002",
      "64100101",
      "64150301",
      "64151101",
    ],
    note: "tax-deduction credits other than s.149 cannot be queued until their row ids are seen",
  },
  {
    page: "116 Wealth Statement (assets + liabilities + reconciliation)",
    unlocks: ["7001", "7002", "7006", "7008"],
    note: "116 is a separate document; the 114 tour cannot reach it, so this needs its own capture set",
  },
];

const unresolved = NEEDS.filter((item) =>
  item.unlocks.some((code) => !captures.seen.has(code)),
);
console.log("");
console.log("=== captures that would move the needle (in order of taxpayer volume) ===");
for (const item of unresolved) {
  const stillMissing = item.unlocks.filter((code) => !captures.seen.has(code));
  console.log(`\n${item.page}`);
  console.log(`  codes: ${stillMissing.join(", ")}`);
  console.log(`  why:   ${item.note}`);
  const files = [...captures.byFile.entries()]
    .filter(([, codes]) => item.unlocks.some((code) => codes.has(code)))
    .map(([file]) => file);
  console.log(
    `  already partly covered by: ${files.length ? files.join(", ") : "no capture in this folder"}`,
  );
}

// Categories the packet builder treats as gaps only because no verified code exists.
const gapCategories = Object.keys(CATEGORY_TO_IRIS_MAP || {}).length;
console.log("");
console.log(
  `category map: ${gapCategories} ledger categories have a verified IRIS line; ` +
    `everything else is reported in portalFieldMap.mappingGaps and entered manually.`,
);
console.log(
  "Until a capture above lands, DO NOT add codes for these — the agent will write a\n" +
    "wrong number into a government return, which is worse than filling nothing.",
);

/* ------------------------------------------------------------------ *
 * Evidence census (lib/tax/portal-row-evidence.ts)                   *
 * ------------------------------------------------------------------ */

/**
 * The packet map may only target row ids that a capture has proven ENTERABLE.
 * That list lives in lib/tax/portal-row-evidence.ts and must never be edited by
 * hand — `--emit-evidence` regenerates it from whatever HTML is in the captures
 * folder, so a new capture is the only way a code becomes fillable.
 */
function readRowCells(dir) {
  const rows = new Map();
  if (!fs.existsSync(dir)) return rows;
  for (const file of fs.readdirSync(dir).filter((f) => /\.html$/i.test(f))) {
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of html.matchAll(/class="[^"]*tableRows dataRow[^"]*"\s+id="(\d+)"/g)) {
      const rowEnd = match.index + match[0].length;
      let segment = html.slice(rowEnd, rowEnd + 3000);
      const next = segment.search(/tableRows dataRow/);
      if (next > -1) segment = segment.slice(0, next);
      const inputs = [...segment.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
      const writeable = inputs
        .map((tag, index) =>
          !/disabled/.test(tag) && !/type="hidden"/.test(tag) ? index : null,
        )
        .filter((index) => index !== null);
      const cells = (segment.match(/data-middle-child-wapper/g) || []).length;
      const entry = rows.get(match[1]) || {
        captures: new Set(),
        inputs: 0,
        writeable: new Set(),
        cells: 0,
      };
      entry.captures.add(file);
      entry.inputs = Math.max(entry.inputs, inputs.length);
      entry.cells = Math.max(entry.cells, cells);
      for (const index of writeable) entry.writeable.add(index);
      rows.set(match[1], entry);
    }
  }
  return rows;
}

function renderEvidenceFile(rows) {
  const lines = [];
  for (const code of [...rows.keys()].sort((a, b) => Number(a) - Number(b))) {
    const entry = rows.get(code);
    lines.push(
      `  "${code}": { writeableInputIndexes: [${[...entry.writeable]
        .sort((a, b) => a - b)
        .join(", ")}], captureCount: ${entry.captures.size} },`,
    );
  }
  return `// GENERATED — do not edit by hand.
// Source: the portal capture folder, via:
//   npm run inventory:portal-coverage -- --emit-evidence
// Regenerate it whenever new IRIS captures land; that is the ONLY way an IRIS code
// becomes eligible for auto-fill in lib/tax/portal-field-map.ts.

/** What a captured IRIS grid row allowed a human to do. */
export type PortalRowEvidence = {
  /**
   * Indexes of the row's <input> elements that were NOT disabled — the cells a
   * person could actually type into. Empty means the row renders but IRIS
   * computes it, so nothing may be entered there.
   */
  writeableInputIndexes: number[];
  /** How many capture files showed this row (1 = single sighting). */
  captureCount: number;
};

/**
 * Every row id ever observed as a rendered IRIS grid row. ${rows.size} rows from
 * the captures folder as of generation time.
 */
export const PORTAL_ROW_EVIDENCE: Record<string, PortalRowEvidence> = {
${lines.join("\n")}
};

/** Row ids proven writeable — the packet map may only target these. */
export const PORTAL_WRITEABLE_CODES: ReadonlySet<string> = new Set(
  Object.entries(PORTAL_ROW_EVIDENCE)
    .filter(([, evidence]) => evidence.writeableInputIndexes.length > 0)
    .map(([code]) => code),
);

/** Row ids that render but are computed by IRIS: present, never enterable. */
export const PORTAL_DISABLED_CODES: ReadonlySet<string> = new Set(
  Object.entries(PORTAL_ROW_EVIDENCE)
    .filter(([, evidence]) => evidence.writeableInputIndexes.length === 0)
    .map(([code]) => code),
);

export function portalCodeHasCaptureEvidence(code: string): boolean {
  return PORTAL_WRITEABLE_CODES.has(String(code));
}
`;
}


