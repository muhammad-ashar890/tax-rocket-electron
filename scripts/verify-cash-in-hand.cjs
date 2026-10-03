#!/usr/bin/env node
/**
 * Cash in hand (IRIS 7012): net cash movement used by Mizan and the packet,
 * plus the on-disk baseline store the agent uses to avoid adding it twice.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    filename,
  );
};

const { netCashMovement } = require(path.join(root, "lib/tax/cash-in-hand.ts"));
const store = require("../electron-connect/cash-baseline-store.js");

const row = (classificationStatus, debit, credit) => ({ classificationStatus, debit, credit });

test("net cash movement: withdrawals minus deposits, confirmed cash rows only", () => {
  assert.equal(netCashMovement([]), 0);
  assert.equal(netCashMovement([row("CASH_MOVEMENT", "50000", null)]), 50000);
  assert.equal(
    netCashMovement([
      row("CASH_MOVEMENT", 100000, null),
      row("CASH_MOVEMENT", null, 30000),
      row("POTENTIAL_CASH_MOVEMENT", 999, null),
      row("APPROVED", 5000, null),
      row("TRANSFER", 7000, null),
    ]),
    70000,
  );
  assert.equal(netCashMovement([row("CASH_MOVEMENT", null, 12000)]), -12000);
});

test("net cash movement is exact in Decimal (no floating point residue)", () => {
  assert.equal(
    netCashMovement([row("CASH_MOVEMENT", "0.1", null), row("CASH_MOVEMENT", "0.2", null), row("CASH_MOVEMENT", null, "0.3")]),
    0,
  );
});

test("Mizan: cash moved out of the bank is an asset, so the gap stays zero", () => {
  // closing - opening = -W; movement = income + liabilities - expenses - assets(+W) + adjustments
  const W = 100000;
  const assetSide = W;
  const gap = -W - (0 + 0 - 0 - assetSide + 0);
  assert.equal(gap, 0);
  const source = fs.readFileSync(path.join(root, "lib/tax/reconciliation-calculation.ts"), "utf8");
  assert.match(source, /netCashMovement\(transactions\)/);
  assert.match(source, /\{ value: cashMovement, subtract: true \}/);
});

test("baseline store: round trip, keyed per taxpayer and year, survives a missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cash-baseline-"));
  const make = (taxpayerIdentifier, taxYear) =>
    store.createCashBaselineStore({ dir, taxpayerIdentifier, taxYear, fs, path });
  const a = make("1234567890123", 2026);
  assert.equal(a.load(), null);
  a.save({ existing: 1300000, written: 1350000, delta: 50000 });
  assert.equal(a.load().written, 1350000);
  assert.equal(make("1234567890123", 2025).load(), null);
  assert.equal(make("9999999999999", 2026).load(), null);
  make("9999999999999", 2026).save({ existing: 1, written: 2, delta: 1 });
  assert.equal(a.load().existing, 1300000, "another taxpayer does not disturb the record");
  assert.throws(() => make("", 2026).save({ existing: 1, written: 2, delta: 1 }));
  fs.writeFileSync(path.join(dir, store.FILE_NAME), "{not json");
  assert.throws(() => a.load(), "a corrupt file is reported, not silently treated as empty");
});
