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
const SYNC_STAMP = "gift-7037-20261005";
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
      "Review and submit it yourself",
      "submit the return yourself in the FBR",
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
    [
      "buildJobReport",
      "NEVER DONE BY THE AGENT",
      "buildAttentionMessage",
      "buildAttentionReport",
    ],
    "the plain-language job report",
  ],
  [
    "electron-connect/iris-employer-driver.js",
    ["runEmployerDriver", "fix40-gift-7037-20261005"],
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
      "fix40-gift-7037-20261005",
      "collectAcknowledgedAutofillItems",
      "real_autofill_stopped",
      "checkTakenOverEntry",
      "runWealthDriverStepwise",
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
  [
    "electron-connect/iris-row-filler.js",
    ["replaceOnlyIfExisting"],
    "Cash in hand: a cell may be replaced only when it holds the proven baseline",
  ],
  [
    "electron-connect/iris-wealth-driver.js",
    ["planCashTarget", "add_to_iris_value"],
    "Cash in hand (7012): baseline plus movement, never a bare overwrite",
  ],
  [
    "electron-connect/iris-wealth-driver.js",
    [
      "addGiftRow",
      "gift_donor_not_resolved",
      "Open pop-up(s) in IRIS",
      "TRANSIENT_NAVIGATION",
      "runWealthDriverStepwise",
      "misplacedGift",
    ],
    "7037 Gift: donor id, search, description, SAVE of the dialog, then the amount",
  ],
  [
    "electron-connect/cash-baseline-store.js",
    ["createCashBaselineStore"],
    "the saved Cash in hand baseline that stops a re-run adding the movement twice",
  ],
  [
    "lib/tax/cash-in-hand.ts",
    ["export function netCashMovement"],
    "net cash movement shared by Mizan and the packet",
  ],
  [
    "lib/tax/gift-income.ts",
    ["export function isGiftCategory"],
    "a gift is a Wealth Statement inflow, not income",
  ],
  [
    "lib/tax/bank-classification-rules.ts",
    ["GIFT_KEYWORDS", "export function classifyTransaction"],
    "Bank Intelligence rules (whole-word keywords, gift suggestion)",
  ],
  [
    "lib/tax/bank-transfer-matching.ts",
    ["bankDescriptionContainsPhrase", "findTransferLookalikePairs"],
    "whole-word keyword matching",
  ],
  [
    "lib/tax/reconciliation-calculation.ts",
    ["netCashMovement(transactions)"],
    "Mizan counts cash moved out of the bank as Cash in hand",
  ],
  [
    "app/actions/tax-calculation.ts",
    ["isGiftCategory(entry.category)"],
    "a gift never reaches a tax figure",
  ],
  [
    "app/actions/bank-classification.ts",
    ['from "@/lib/tax/bank-classification-rules"'],
    "the action uses the shared rules file",
  ],
  [
    "components/tax/filing/wizard-bank-intelligence-step.tsx",
    ['"GIFT",', "bankAccounts.length > 1"],
    "Gift in the category dropdown; transfer button only with two accounts",
  ],
  [
    "lib/tax/portal-field-map.ts",
    ["valueMode: VALUE_MODE_ADD_TO_IRIS", "isGiftCategory", "giftAgg"],
    "the 7012 movement field, the gift exclusion and the 7037 gift rows",
  ],
  [
    "prisma/schema.prisma",
    ["giftDonorId          String?"],
    "the gift donor column (run the migration after copying)",
  ],
  [
    "prisma/migrations/20261003120000_add_bank_transaction_gift_donor/migration.sql",
    ['"giftDonorId" TEXT'],
    "the migration that adds it",
  ],
  [
    "lib/tax/gift-income.ts",
    ["export function validateGiftDonorId"],
    "donor number rules for the IRIS Gift dialog",
  ],
  [
    "app/actions/packet.ts",
    ["giftDonorByTransaction", "date: e.entryDate"],
    "the packet carries each gift with its donor and booking date",
  ],
  [
    "lib/tax/filing-completeness.ts",
    ["findTransferLookalikePairs(transactions)"],
    "the Continue gate refuses an own-account transfer booked as income or an expense",
  ],
  [
    "test-fixtures/iris/employer/salary-employer-panel.html",
    ["salary-employer-add-btn"],
    "fixture read by the employer driver tests (a missing folder fails 24 tests with ENOENT)",
  ],
  [
    "test-fixtures/iris/employer/modal-add-employer.html",
    ["mat-dialog-container"],
    "fixture read by the employer driver tests",
  ],
  [
    "scripts/lib/fake-iris-employer.cjs",
    ["class FakeIrisEmployer"],
    "the fake IRIS employer page the driver tests run against",
  ],
  [
    "scripts/lib/fake-iris-wealth.cjs",
    ["class FakeIris {", "knownDonors"],
    "the fake IRIS Wealth Statement page the driver tests run against (with the Gift dialog)",
  ],
  [
    "lib/tax/bank-classification-rules.ts",
    ["isPlaceholderIncomeCategory", "PLACEHOLDER_INCOME_ERROR"],
    "an unexplained credit can never be approved as income",
  ],
  [
    "app/actions/bank-classification.ts",
    ["isPlaceholderIncomeCategory(transaction.suggestedCategory)"],
    "the approve click refuses an unexplained credit",
  ],
  [
    "lib/tax/filing-completeness.ts",
    ["isPlaceholderIncomeCategory(transaction.suggestedCategory)"],
    "the Continue gate names an unexplained credit approved as income",
  ],
  [
    "components/tax/fbr-attention-panel.tsx",
    ["FbrAttentionPanel", "What to do: "],
    "the review pause shown as a list: what happened, what to do (new file)",
  ],
  [
    "app/actions/fbr-jobs.ts",
    ["readJobAttention", 'requiredAction === "portal_autofill_review"'],
    "the job list passes the attention list to the page as plain text; the missing-items pause needs a ticked confirmation",
  ],
  [
    "scripts/verify-iris-wealth-driver.cjs",
    ["gift planning:"],
    "the 7037 Gift driver tests",
  ],
  [
    "scripts/verify-bank-classification.cjs",
    ["becomes a 7037 Wealth row"],
    "the packet test for gifts that carry a donor",
  ],
  [
    "test-fixtures/iris/wealth/modal-gift.html",
    ["app-nitr-gift-dialog"],
    "fixture: the Gift dialog (new in this round)",
  ],
  [
    "test-fixtures/iris/wealth/reconciliation-with-gift.html",
    ["sub-child"],
    "fixture: a saved Gift child row (new in this round)",
  ],
  [
    "test-fixtures/iris/wealth/modal-bank.html",
    ["mat-dialog-container"],
    "fixture read by the wealth driver tests",
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
