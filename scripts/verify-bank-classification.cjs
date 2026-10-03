#!/usr/bin/env node
/**
 * Bank Intelligence rules (lib/tax/bank-classification-rules.ts):
 *  - keywords match WHOLE words (no "rent" inside "Parents"),
 *  - a credit that says "gift" is suggested as a gift received,
 *  - a gift is a Wealth Statement inflow, never taxable income.
 */
"use strict";

const fs = require("node:fs");
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
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    filename,
  );
};

const rules = require(path.join(root, "lib/tax/bank-classification-rules.ts"));
const matching = require(path.join(root, "lib/tax/bank-transfer-matching.ts"));
const gift = require(path.join(root, "lib/tax/gift-income.ts"));
const { buildPortalFieldMap } = require(
  path.join(root, "lib/tax/portal-field-map.ts"),
);

const tx = (
  description,
  {
    debit = null,
    credit = null,
    id = "t1",
    bankAccountId = "a1",
    date = "2026-01-10",
  } = {},
) => ({
  id,
  bankAccountId,
  transactionDate: new Date(date),
  description,
  debit,
  credit,
});
const classify = (description, amounts, others = []) =>
  rules.classifyTransaction(tx(description, amounts), others);

test("keywords: whole words only, so ordinary words no longer trigger a rule", () => {
  const falsePositives = [
    ["POS PARENTS HOSPITAL", "UTILITIES_OR_RENT"],
    ["Current account fee review", "UTILITIES_OR_RENT"],
    ["Different Store", "UTILITIES_OR_RENT"],
    ["Careem TAXI ride", "TAX_PAYMENT"],
    ["FedEx courier", "TAX_PAYMENT"],
    ["Seashell cafe", "TRANSPORT"],
    ["Subtotal adjustment", "TRANSPORT"],
    ["Epson printer", "TRANSPORT"],
  ];
  for (const [description, wrongCategory] of falsePositives) {
    const out = classify(description, { debit: "1000" });
    assert.notEqual(
      out.category,
      wrongCategory,
      `${description} must not be ${wrongCategory}`,
    );
  }
});

test("keywords: real matches still work, including plurals and punctuation", () => {
  const cases = [
    ["House Rent Feb", "UTILITIES_OR_RENT"],
    ["Rents paid", "UTILITIES_OR_RENT"],
    ["K-Electric bill", "UTILITIES_OR_RENT"],
    ["Income Tax payment", "TAX_PAYMENT"],
    ["Taxes u/s 236", "TAX_PAYMENT"],
    ["FBR challan", "TAX_PAYMENT"],
    ["PSO fuel", "TRANSPORT"],
    ["Shell Petrol Pump", "TRANSPORT"],
    ["Imtiaz Groceries", "PERSONAL_EXPENSE"],
  ];
  for (const [description, category] of cases) {
    const out = classify(description, { debit: "1000" });
    assert.equal(out.category, category, description);
    assert.equal(out.status, "SUGGESTED", description);
  }
  assert.equal(
    classify("Salary October", { credit: "1000" }).category,
    "SALARY",
  );
});

test("matcher: unit behaviour", () => {
  const m = matching.bankDescriptionMatchesKeyword;
  const n = matching.normalizeBankDescription;
  assert.equal(m(n("parents hospital"), "rent"), false);
  assert.equal(m(n("monthly rent"), "rent"), true);
  assert.equal(m(n("taxes"), "tax"), true);
  assert.equal(m(n("taxi"), "tax"), false);
  assert.equal(m(n("k-electric"), "k electric"), true);
  assert.equal(m(n("pay to ke account"), " ke "), true);
  assert.equal(m(n("keen"), " ke "), false);
});

test("transfer wording still matches glued channel codes", () => {
  assert.equal(
    matching.hasInternalTransferLanguage("IBFT12345 to my account"),
    true,
  );
  assert.equal(
    matching.hasInternalTransferLanguage("Fund Transfer from HBL"),
    true,
  );
  assert.equal(matching.hasInternalTransferLanguage("Parents hospital"), false);
});

test("gift: a credit that says gift is suggested as a gift received", () => {
  for (const description of [
    "Gift from brother",
    "IBFT Gift from Ali",
    "Eid gift - Parents",
    "Hiba from uncle",
  ]) {
    const out = classify(description, { credit: "50000" });
    assert.deepEqual(
      { status: out.status, entryType: out.entryType, category: out.category },
      { status: "SUGGESTED", entryType: "INCOME", category: "GIFT" },
      description,
    );
  }
});

test("gift: only credits; a debit is never suggested as a gift; a plain credit still needs a decision", () => {
  assert.notEqual(
    classify("Gift shop purchase", { debit: "5000" }).category,
    "GIFT",
  );
  assert.equal(
    classify("Transfer from Ali", { credit: "5000" }).category,
    "INTERNAL_TRANSFER",
  );
  const plain = classify("Deposit 4411", { credit: "5000" });
  assert.equal(plain.status, "POTENTIAL_INCOME");
  assert.notEqual(plain.category, "GIFT");
  assert.equal(
    classify("Giftwrap Mart", { credit: "5000" }).category !== "GIFT",
    true,
    "whole word only",
  );
});

test("other classes are unchanged: cash movement, paired internal transfer", () => {
  assert.equal(
    classify("ATM Cash Withdrawal", { debit: "20000" }).status,
    "POTENTIAL_CASH_MOVEMENT",
  );
  const out = rules.classifyTransaction(
    tx("Payment to savings", { debit: "10000", id: "a", bankAccountId: "a1" }),
    [
      {
        ...tx("Transfer from salary", {
          credit: "10000",
          id: "b",
          bankAccountId: "a2",
        }),
      },
    ],
  );
  assert.equal(out.status, "POTENTIAL_TRANSFER");
});

test("gift is excluded from tax and reported as a manual Wealth Statement inflow", () => {
  assert.equal(gift.isGiftCategory("GIFT"), true);
  assert.equal(gift.isGiftCategory("gift received"), true);
  assert.equal(gift.isGiftCategory("OTHER_INCOME"), false);
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "INDIVIDUAL",
    taxpayerListStatus: "ACTIVE",
    ledgerEntries: [
      {
        id: "g1",
        entryType: "INCOME",
        category: "GIFT",
        description: "Gift from Ali",
        amount: 50000,
      },
    ],
  });
  const gap = map.mappingGaps.unmappedCategories.find(
    (c) => c.category === "GIFT",
  );
  assert.ok(gap, "gift is listed as a manual item");
  assert.equal(gap.totalAmount, 50000);
  assert.match(gap.reason, /7037/);
  assert.equal(map.incomeFields.length, 0, "nothing is typed as income");
  const source = fs.readFileSync(
    path.join(root, "app/actions/tax-calculation.ts"),
    "utf8",
  );
  assert.match(
    source,
    /entry\.entryType === "INCOME" && !isGiftCategory\(entry\.category\)/,
  );
});

const row = (
  id,
  account,
  description,
  {
    debit = null,
    credit = null,
    status = "APPROVED",
    date = "2026-02-12",
  } = {},
) => ({
  ...tx(description, { debit, credit, id, bankAccountId: account, date }),
  classificationStatus: status,
});
const hblIn = (status) =>
  row("h", "hbl", "IBFT TRANSFER FROM OWN SCB ACCOUNT", {
    credit: "25000",
    status,
  });
const scbOut = (status) =>
  row("s", "scb", "IBFT TRANSFER TO OWN HBL ACCOUNT", {
    debit: "25000",
    status,
  });

test("transfer lookalike: a transfer booked as income on one side and an expense on the other is found", () => {
  const pairs = matching.findTransferLookalikePairs([
    hblIn("APPROVED"),
    scbOut("APPROVED"),
  ]);
  assert.equal(pairs.length, 1, "one pair, not two (A-B and B-A)");
  assert.deepEqual([pairs[0].first.id, pairs[0].second.id].sort(), ["h", "s"]);
  // One side booked, the other still open: still wrong, still found.
  assert.equal(
    matching.findTransferLookalikePairs([
      hblIn("APPROVED"),
      scbOut("POTENTIAL_TRANSFER"),
    ]).length,
    1,
  );
});

test("transfer lookalike: a proper transfer, an untouched pair, or unrelated rows are not flagged", () => {
  assert.equal(
    matching.findTransferLookalikePairs([hblIn("TRANSFER"), scbOut("TRANSFER")])
      .length,
    0,
  );
  assert.equal(
    matching.findTransferLookalikePairs([
      hblIn("POTENTIAL_TRANSFER"),
      scbOut("POTENTIAL_TRANSFER"),
    ]).length,
    0,
    "nothing booked yet",
  );
  assert.equal(
    matching.findTransferLookalikePairs([hblIn("REJECTED"), scbOut("REJECTED")])
      .length,
    0,
    "excluded both sides",
  );
  // Salary that merely says IBFT, next to an unrelated debit of the same amount.
  const salary = row("a", "hbl", "IBFT SALARY CREDIT", { credit: "25000" });
  const rent = row("b", "scb", "HOUSE RENT PAYMENT", { debit: "25000" });
  assert.equal(
    matching.findTransferLookalikePairs([salary, rent]).length,
    0,
    "wording needed on both sides",
  );
  // Same amount in the SAME account is never a transfer.
  const sameAccount = row("c", "hbl", "IBFT TRANSFER TO OWN HBL ACCOUNT", {
    debit: "25000",
  });
  assert.equal(
    matching.findTransferLookalikePairs([hblIn("APPROVED"), sameAccount])
      .length,
    0,
  );
  // Too far apart in time.
  const late = row("d", "scb", "IBFT TRANSFER TO OWN HBL ACCOUNT", {
    debit: "25000",
    date: "2026-03-20",
  });
  assert.equal(
    matching.findTransferLookalikePairs([hblIn("APPROVED"), late]).length,
    0,
  );
});

test("transfer lookalike: single-row check used by the click actions", () => {
  assert.equal(
    matching.isTransferLookalike(hblIn("SUGGESTED"), [
      scbOut("POTENTIAL_TRANSFER"),
    ]),
    true,
  );
  assert.equal(matching.isTransferLookalike(hblIn("SUGGESTED"), []), false);
  assert.equal(
    matching.isTransferLookalike(
      row("a", "hbl", "IBFT SALARY CREDIT", { credit: "1" }),
      [row("b", "scb", "HOUSE RENT", { debit: "1" })],
    ),
    false,
  );
});

test("transfer lookalike: wired into the Continue gate, both click actions and Approve All Safe", () => {
  const gate = fs.readFileSync(
    path.join(root, "lib/tax/filing-completeness.ts"),
    "utf8",
  );
  assert.match(gate, /findTransferLookalikePairs\(transactions\)/);
  assert.match(gate, /booked as income or an expense/);
  const actions = fs.readFileSync(
    path.join(root, "app/actions/bank-classification.ts"),
    "utf8",
  );
  assert.equal(
    (actions.match(/error: TRANSFER_LOOKALIKE_ERROR/g) || []).length,
    2,
    "manual and approve clicks",
  );
  assert.match(actions, /heldBackAsTransfers/);
});

test("undo: a row goes back to what the rules say, not to the taxpayer's own earlier manual choice", () => {
  const actions = fs.readFileSync(
    path.join(root, "app/actions/bank-classification.ts"),
    "utf8",
  );
  const undo = actions.slice(
    actions.indexOf(
      "export async function undoBankTransactionClassificationAction",
    ),
    actions.indexOf(
      "export async function manuallyClassifyBankTransactionAction",
    ),
  );
  assert.match(undo, /classifyTransaction\(affected, transferCandidates\)/);
  assert.match(undo, /suggestedEntryType: fresh\.entryType/);
  assert.doesNotMatch(undo, /reviewedStatusForUndo/);
  // What the rules give the transfer from the report: back to a transfer suggestion.
  const out = rules.classifyTransaction(hblIn("APPROVED"), [
    scbOut("APPROVED"),
  ]);
  assert.equal(out.status, "POTENTIAL_TRANSFER");
  assert.equal(out.category, "INTERNAL_TRANSFER");
});
