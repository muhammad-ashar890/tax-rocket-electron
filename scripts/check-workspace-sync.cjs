#!/usr/bin/env node
/**
 * Workspace sync check.
 *
 * The failure this exists for: code, tests and the agent drift apart when a download is
 * copied file-by-file. `verify:portal-field-map` then prints
 * "the action must read the gaps through the shared helper" — which reads like a broken
 * test but means one file in the tree is older than the others.
 *
 * So this checks presence, not behaviour: every file the current round touched must still
 * contain a string only the current version has. Exact bytes are deliberately not
 * compared — line endings and prettier reflows differ between machines, and a marker
 * survives both, while an old copy cannot fake it.
 *
 *   node scripts/check-workspace-sync.cjs
 *   node scripts/check-workspace-sync.cjs --self-test
 *   node scripts/check-workspace-sync.cjs --root "C:\path\to\other\checkout"
 *
 * Exit code is non-zero when anything is STALE or MISSING, so it can gate a deploy.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Round stamp: bump when a new round lands, so `STALE` output names which set to copy.
 * MARKERS: file → strings only the current version contains. Each was taken from the
 * shipped code, never invented; `--self-test` proves that against this tree, so a renamed
 * function has to be updated here in the same commit or this check cries wolf.
 */
const SYNC_STAMP = "packet-coverage-override-20260910";
const MARKERS = [
  [
    "lib/tax/portal-field-map.ts",
    ["export function describeUnmappedPortalSources"],
    "the coverage gate's decision, wording and record all live here",
  ],
  [
    "app/actions/packet.ts",
    [
      "describeUnmappedPortalSources,",
      "describeUnmappedPortalSources(portalFieldMap.mappingGaps)",
      "unmappedPortalSources: coverageGate.blocked",
      "acceptUnmappedPortalSources?: boolean",
    ],
    "the gate refuses unless the operator accepted, and records the verdict",
  ],
  [
    "components/tax/filing/hooks/use-filing-finalization.ts",
    ["const accept = acceptUnmapped === true;", "packetUnmappedSources"],
    "strictly `true`, so a click event can never read as consent",
  ],
  [
    "components/tax/filing/wizard-packet-step.tsx",
    [
      "I have confirmed the FBR/IRIS field for these amounts",
      "packetUnmappedSources.length > 0 && acceptUnmapped",
    ],
    "the override checkbox and the button that sends an explicit boolean",
  ],
  [
    "components/tax/filing/filing-wizard.tsx",
    ["packetUnmappedSources={packetUnmappedSources}"],
    "the refused list has to reach the step",
  ],
  [
    "lib/tax/fbr-agent-config.ts",
    ["isLiveFilingEnabledByDeployment"],
    "the deployment half of the live-write switch",
  ],
  [
    "app/tax/fbr-connect/page.tsx",
    ["liveFilingEnabled={isLiveFilingEnabledByDeployment()}"],
    "the read-only default comes from the server, not the browser",
  ],
  [
    "components/tax/fbr-connect-client.tsx",
    [
      "Start filing",
      "Salary step complete — return",
      "does <strong>not</strong> mean the return was filed",
    ],
    "the flow distinguishes a finished agent task from a filed return",
  ],
  [
    "lib/tax/cnic-profile.ts",
    ["planCnicProfileUpdate"],
    "CNIC → profile plan (an expired card must refuse)",
  ],
  [
    "scripts/verify-portal-field-map.cjs",
    ["describeUnmappedPortalSources"],
    "the gate test; an old copy of this is what makes the code look broken",
  ],
  [
    "scripts/verify-iris-navigation.cjs",
    ["mappingGaps, coverage"],
    "asserts the success payload — stale here means a false failure",
  ],
  [
    "scripts/verify-fbr-contracts.cjs",
    ["TAXROCKET_ALLOW_LIVE_FILING"],
    "proves the env key is read, not hardcoded",
  ],
  [
    "scripts/verify-cnic-profile-plan.cjs",
    ["exactFieldValue"],
    "dashed-CNIC comparison",
  ],
  [
    "electron-connect/job-report.js",
    ["buildJobReport", "NEVER DONE BY THE AGENT"],
    "the plain-language job report",
  ],
  [
    "electron-connect/iris-employer-driver.js",
    ["runEmployerDriver", "fix34-tax-year-employer-20261002"],
    "the employer driver (exact registered name only)",
  ],
  [
    "lib/tax/salary-certificate-fields.ts",
    [
      "extractSalaryCertificateEmployers",
      "hasRequiredSalaryCertificateEmployer",
    ],
    "the employer name is a required review field on the salary certificate",
  ],
  [
    "app/actions/packet.ts",
    ["extractMappedSalaryEmployers("],
    "the packet carries the reviewed employer names to the agent",
  ],
  [
    "electron-connect/main.js",
    [
      "fix34-tax-year-employer-20261002",
      "live_return_autofill",
      "Live entry entered and verified",
    ],
    "build stamp plus a truthful live-entry completion result",
  ],
  [
    "electron-connect/iris-navigation.js",
    ["salaryVerified", "This inspection did not enter values"],
    "the section gate and honest separation between inspection and entry",
  ],
  [
    "electron-connect/iris-row-filler.js",
    ["readback_mismatch"],
    "every write is re-read before it counts",
  ],
];

/** Read-only scan: each result is OK / STALE / MISSING for `markers` under `root`. */
function scan(root, markers) {
  return markers.map(([rel, strings, why]) => {
    const file = path.join(root, rel);
    let text = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return { status: "MISSING", rel, why, missing: strings.slice() };
    }
    const missing = strings.filter((needle) => !text.includes(needle));
    return {
      status: missing.length ? "STALE" : "OK",
      rel,
      why,
      missing,
      bytes: Buffer.byteLength(text),
    };
  });
}

function selfTest() {
  const assert = require("assert");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-selftest-"));
  try {
    fs.mkdirSync(path.join(dir, "a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "a", "current.ts"),
      "export const keep = 1;\n",
    );
    fs.writeFileSync(path.join(dir, "a", "old.ts"), "// an older revision\n");
    // A CRLF copy must not read as staleness — Windows checkouts reflow line endings.
    fs.writeFileSync(
      path.join(dir, "a", "crlf.ts"),
      "export const keep = 1;\r\n",
    );

    const fake = [
      ["a/current.ts", ["export const keep"], "present"],
      ["a/old.ts", ["export const keep"], "removed again by a stale copy"],
      ["a/crlf.ts", ["export const keep"], "CRLF must still match"],
      ["a/gone.ts", ["whatever"], "never copied at all"],
    ];
    const out = scan(dir, fake);
    assert.strictEqual(out[0].status, "OK", "a current file passes");
    assert.strictEqual(out[1].status, "STALE", "a stale file is named");
    assert.deepStrictEqual(
      out[1].missing,
      ["export const keep"],
      "with the string it wanted",
    );
    assert.strictEqual(out[2].status, "OK", "a CRLF file is not called stale");
    assert.strictEqual(
      out[3].status,
      "MISSING",
      "an absent file is MISSING, not STALE",
    );

    // And the real tree has to satisfy its own list, or the markers are invented.
    const here = scan(path.join(__dirname, ".."), MARKERS);
    const wrong = here
      .filter((r) => r.status !== "OK")
      .map((r) => `${r.status} ${r.rel}`);
    assert.deepStrictEqual(
      wrong,
      [],
      "this check would lie about a healthy tree",
    );
    console.log(
      `self-test ok — ${out.length} fake cases, ${here.length} real files matched`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    return 0;
  }

  let root = path.join(__dirname, "..");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      root = path.resolve(args[i + 1]);
      i += 1; // consume the value, or it reads as an unknown flag
    } else if (args[i].startsWith("--root=")) {
      root = path.resolve(args[i].slice("--root=".length));
    } else {
      console.error(
        "usage: node scripts/check-workspace-sync.cjs [--root <dir>] [--self-test]",
      );
      return 2;
    }
  }

  const results = scan(root, MARKERS);
  const bad = results.filter((r) => r.status !== "OK");
  console.log(`workspace sync check — round ${SYNC_STAMP}`);
  console.log(`root: ${root}\n`);
  for (const r of results) {
    const size =
      r.bytes === undefined ? "        -" : `${String(r.bytes).padStart(8)}B`;
    console.log(
      `${r.status === "OK" ? " " : "!"} ${r.status.padEnd(8)}${size}  ${r.rel}`,
    );
    if (r.status !== "OK") {
      console.log(`             why it matters: ${r.why}`);
      console.log(
        `             not found: ${r.missing.map((m) => JSON.stringify(m)).join(", ")}`,
      );
    }
  }
  console.log(
    `\n${results.length - bad.length}/${results.length} files match round ${SYNC_STAMP}` +
      (bad.length
        ? ` — ${bad.length} to copy from the matching download`
        : " — tree is consistent"),
  );
  if (bad.length) {
    console.log(
      "\nCopy these, then re-run this check before the test suites:\n" +
        bad.map((r) => `  ${r.rel}`).join("\n") +
        "\n\nA stale file here is not a failing test: the test is right and the code next to it is old.",
    );
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { scan, MARKERS, SYNC_STAMP };
