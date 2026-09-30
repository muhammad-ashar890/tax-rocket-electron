#!/usr/bin/env node
/**
 * Replay the agent's REAL autofill against the operator's REAL capture (read-only).
 *
 *   node scripts/replay-agent-autofill.cjs \
 *     --captures <dir with the saved "IRIS 2.0 *.html" pages> \
 *     --job <TaxRocketAgentLogs/latest-job.json>
 *
 * It rebuilds the packet's portalFieldMap from the section codes the live run placed,
 * then runs the shipping `electron-connect/iris-row-filler.js` (the same in-page script
 * the agent injects) over each captured section, in dry-run mode. Nothing is written
 * anywhere; this only reports what the portal would have accepted.
 *
 * Why it exists: the live pilot recorded `0/27 fields filled`. That number could only
 * be reproduced with the operator's DOM, and the DOM cannot be committed to the repo.
 * Keeping the replay in the repo means the next pilot run can be checked in seconds
 * instead of by reading a JSON dump.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { JSDOM, VirtualConsole } = require("jsdom");

// The captured pages carry Angular SCSS that jsdom's CSS parser rejects; that noise
// would bury the report this script exists to produce.
const silentConsole = new VirtualConsole();

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
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    filename,
  );
};

const filler = require(path.join(projectRoot, "electron-connect/iris-row-filler.js"));
const { IRIS_CODES } = require(path.join(projectRoot, "lib/tax/iris-field-codes.ts"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CAPTURE_DIR = arg("captures", path.join(process.env.HOME || "/home/user", "uploads"));
const JOB_FILE = arg("job", "");

// Captured sections in the operator's run, by their real filename, plus the section
// the tour placed them in. Kept explicit so a missing capture is visible, not silent.
const SECTION_CAPTURES = [
  { sectionId: "salary", file: "IRIS 2.0 form3.html" },
  { sectionId: "tax_deductions", file: "IRIS 2.0-form.html" },
  { sectionId: "allowance_credits", file: "IRIS 2.0 form4.html" },
  { sectionId: "withholding", file: "IRIS 2.0 form 5.html" },
  { sectionId: "computations", file: "IRIS 2.0 form 6.html" },
];

function rowCodesFor(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  return new Set([...html.matchAll(/class="[^"]*tableRows[^"]*"\s+id="(\d+)"/g)].map((m) => m[1]));
}

function packetFieldsForSection(codes) {
  // Mirror what `buildPortalFieldMap` v1.1.0 emits for a salaried+X taxpayer:
  // one aggregated field per (code, column), line items only, entered column.
  const fields = [];
  for (const code of codes) {
    const def = Object.values(IRIS_CODES).find((c) => c.code === code);
    if (!def || def.rowLevel === "Summary") continue;
    fields.push({
      key: `${code}:replay`,
      irisCode: code,
      label: def.description,
      column: "Total Amount",
      value: "100000",
      isTaxField: false,
    });
  }
  return fields;
}

async function runSection(htmlPath, fields) {
  const dom = new JSDOM(fs.readFileSync(htmlPath, "utf8"), {
    virtualConsole: silentConsole,
  });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Event = dom.window.Event;
  const script = filler.buildInPageFillScript(
    fields.map((f) => filler.prepareField(f)),
    { dryRun: true },
  );
  // The in-page script is an async IIFE; convert it into a thenable of THIS realm.
  return await Promise.resolve(dom.window.eval(script));
}

async function main() {
let job = null;
if (JOB_FILE && fs.existsSync(JOB_FILE)) {
  try {
    job = JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
  } catch (error) {
    console.warn(`(could not read ${JOB_FILE}: ${error.message})`);
  }
}

console.log("=== portal structure replay (dry-run, no writes) ===");
console.log(`captures: ${CAPTURE_DIR}\n`);

const totals = { filled: 0, refused: {}, rows: 0 };
for (const { sectionId, file } of SECTION_CAPTURES) {
  const htmlPath = path.join(CAPTURE_DIR, file);
  if (!fs.existsSync(htmlPath)) {
    console.log(`${sectionId.padEnd(18)} SKIP  (capture "${file}" not found)`);
    continue;
  }
  const codes = rowCodesFor(htmlPath);
  const fields = packetFieldsForSection(codes);
  const results = await runSection(htmlPath, fields);
  const filled = results.filter((r) => r.status === filler.FILL_STATUS.FILLED);
  for (const r of results) {
    if (r.status === filler.FILL_STATUS.FILLED) continue;
    totals.refused[r.status] = (totals.refused[r.status] || 0) + 1;
  }
  totals.filled += filled.length;
  totals.rows += codes.size;
  console.log(
    `${sectionId.padEnd(18)} rows:${String(codes.size).padStart(3)}  queuable:${String(fields.length).padStart(3)}  fillable:${String(filled.length).padStart(3)}  ` +
      `columns=${JSON.stringify([...new Set(results.map((r) => r.columnIndex))])}` +
      (fields.length > 0 && filled.length === 0
        ? "  ← the portal accepted none of these targets"
        : ""),
  );
  const other = results.filter(
    (r) => r.status !== filler.FILL_STATUS.FILLED && r.status !== filler.FILL_STATUS.NO_EDITABLE_CELL,
  );
  for (const r of other.slice(0, 4)) {
    console.log(`   ${r.irisCode} ${r.status}${r.columnIndex != null ? ` col=${r.columnIndex}` : ""} ${r.matchedBy || ""}`);
  }
}

console.log(
  `\n=== summary ===\nwriteable targets found by replay: ${totals.filled} ` +
    `(over ${totals.rows} captured rows)\nnon-computed refusals: ${JSON.stringify(totals.refused)}\n`,
);

if (job?.result?.autofill?.summary) {
  const s = job.result.autofill.summary;
  console.log("=== the run that was recorded ===");
  console.log(
    `${s.filled}/${s.total} filled; skipped ${JSON.stringify(s.byStatus)}\n` +
      `  build: ${job.build} | navigator: ${job.navigatorBuild}\n` +
      `  → compare the two numbers above before and after a re-run.`,
  );
}
}

main().catch((error) => { console.error(error); process.exit(1); });
