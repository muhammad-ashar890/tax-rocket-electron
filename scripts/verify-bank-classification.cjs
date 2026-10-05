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
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    filename,
  );
};

const rules = require(path.join(root, "lib/tax/bank-classification-rules.ts"));
const matching = require(path.join(root, "lib/tax/bank-transfer-matching.ts"));
const gift = require(path.join(root, "lib/tax/gift-income.ts"));
const { buildPortalFieldMap, flattenPortalFieldMap } = require(path.join(root, "lib/tax/portal-field-map.ts"));

const tx = (description, { debit = null, credit = null, id = "t1", bankAccountId = "a1", date = "2026-01-10" } = {}) => ({
  id, bankAccountId, transactionDate: new Date(date), description, debit, credit,
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
    assert.notEqual(out.category, wrongCategory, `${description} must not be ${wrongCategory}`);
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
  assert.equal(classify("Salary October", { credit: "1000" }).category, "SALARY");
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
  assert.equal(matching.hasInternalTransferLanguage("IBFT12345 to my account"), true);
  assert.equal(matching.hasInternalTransferLanguage("Fund Transfer from HBL"), true);
  assert.equal(matching.hasInternalTransferLanguage("Parents hospital"), false);
});

test("gift: a credit that says gift is suggested as a gift received", () => {
  for (const description of ["Gift from brother", "IBFT Gift from Ali", "Eid gift - Parents", "Hiba from uncle"]) {
    const out = classify(description, { credit: "50000" });
    assert.deepEqual(
      { status: out.status, entryType: out.entryType, category: out.category },
      { status: "SUGGESTED", entryType: "INCOME", category: "GIFT" },
      description,
    );
  }
});

test("gift: only credits; a debit is never suggested as a gift; a plain credit still needs a decision", () => {
  assert.notEqual(classify("Gift shop purchase", { debit: "5000" }).category, "GIFT");
  assert.equal(classify("Transfer from Ali", { credit: "5000" }).category, "INTERNAL_TRANSFER");
  const plain = classify("Deposit 4411", { credit: "5000" });
  assert.equal(plain.status, "POTENTIAL_INCOME");
  assert.notEqual(plain.category, "GIFT");
  assert.equal(classify("Giftwrap Mart", { credit: "5000" }).category !== "GIFT", true, "whole word only");
});

test("other classes are unchanged: cash movement, paired internal transfer", () => {
  assert.equal(classify("ATM Cash Withdrawal", { debit: "20000" }).status, "POTENTIAL_CASH_MOVEMENT");
  const out = rules.classifyTransaction(
    tx("Payment to savings", { debit: "10000", id: "a", bankAccountId: "a1" }),
    [{ ...tx("Transfer from salary", { credit: "10000", id: "b", bankAccountId: "a2" }) }],
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
    ledgerEntries: [{ id: "g1", entryType: "INCOME", category: "GIFT", description: "Gift from Ali", amount: 50000 }],
  });
  const gap = map.mappingGaps.unmappedCategories.find((c) => c.category === "GIFT");
  assert.ok(gap, "gift is listed as a manual item");
  assert.equal(gap.totalAmount, 50000);
  assert.match(gap.reason, /7037/);
  assert.equal(map.incomeFields.length, 0, "nothing is typed as income");
  const source = fs.readFileSync(path.join(root, "app/actions/tax-calculation.ts"), "utf8");
  assert.match(source, /entry\.entryType === "INCOME" && !isGiftCategory\(entry\.category\)/);
});

const row = (id, account, description, { debit = null, credit = null, status = "APPROVED", date = "2026-02-12" } = {}) => ({
  ...tx(description, { debit, credit, id, bankAccountId: account, date }),
  classificationStatus: status,
});
const hblIn = (status) => row("h", "hbl", "IBFT TRANSFER FROM OWN SCB ACCOUNT", { credit: "25000", status });
const scbOut = (status) => row("s", "scb", "IBFT TRANSFER TO OWN HBL ACCOUNT", { debit: "25000", status });

test("transfer lookalike: a transfer booked as income on one side and an expense on the other is found", () => {
  const pairs = matching.findTransferLookalikePairs([hblIn("APPROVED"), scbOut("APPROVED")]);
  assert.equal(pairs.length, 1, "one pair, not two (A-B and B-A)");
  assert.deepEqual([pairs[0].first.id, pairs[0].second.id].sort(), ["h", "s"]);
  // One side booked, the other still open: still wrong, still found.
  assert.equal(matching.findTransferLookalikePairs([hblIn("APPROVED"), scbOut("POTENTIAL_TRANSFER")]).length, 1);
});

test("transfer lookalike: a proper transfer, an untouched pair, or unrelated rows are not flagged", () => {
  assert.equal(matching.findTransferLookalikePairs([hblIn("TRANSFER"), scbOut("TRANSFER")]).length, 0);
  assert.equal(matching.findTransferLookalikePairs([hblIn("POTENTIAL_TRANSFER"), scbOut("POTENTIAL_TRANSFER")]).length, 0, "nothing booked yet");
  assert.equal(matching.findTransferLookalikePairs([hblIn("REJECTED"), scbOut("REJECTED")]).length, 0, "excluded both sides");
  // Salary that merely says IBFT, next to an unrelated debit of the same amount.
  const salary = row("a", "hbl", "IBFT SALARY CREDIT", { credit: "25000" });
  const rent = row("b", "scb", "HOUSE RENT PAYMENT", { debit: "25000" });
  assert.equal(matching.findTransferLookalikePairs([salary, rent]).length, 0, "wording needed on both sides");
  // Same amount in the SAME account is never a transfer.
  const sameAccount = row("c", "hbl", "IBFT TRANSFER TO OWN HBL ACCOUNT", { debit: "25000" });
  assert.equal(matching.findTransferLookalikePairs([hblIn("APPROVED"), sameAccount]).length, 0);
  // Too far apart in time.
  const late = row("d", "scb", "IBFT TRANSFER TO OWN HBL ACCOUNT", { debit: "25000", date: "2026-03-20" });
  assert.equal(matching.findTransferLookalikePairs([hblIn("APPROVED"), late]).length, 0);
});

test("transfer lookalike: single-row check used by the click actions", () => {
  assert.equal(matching.isTransferLookalike(hblIn("SUGGESTED"), [scbOut("POTENTIAL_TRANSFER")]), true);
  assert.equal(matching.isTransferLookalike(hblIn("SUGGESTED"), []), false);
  assert.equal(
    matching.isTransferLookalike(row("a", "hbl", "IBFT SALARY CREDIT", { credit: "1" }), [row("b", "scb", "HOUSE RENT", { debit: "1" })]),
    false,
  );
});

test("transfer lookalike: wired into the Continue gate, both click actions and Approve All Safe", () => {
  const gate = fs.readFileSync(path.join(root, "lib/tax/filing-completeness.ts"), "utf8");
  assert.match(gate, /findTransferLookalikePairs\(transactions\)/);
  assert.match(gate, /booked as income or an expense/);
  const actions = fs.readFileSync(path.join(root, "app/actions/bank-classification.ts"), "utf8");
  assert.equal((actions.match(/error: TRANSFER_LOOKALIKE_ERROR/g) || []).length, 2, "manual and approve clicks");
  assert.match(actions, /heldBackAsTransfers/);
});

test("undo: a row goes back to what the rules say, not to the taxpayer's own earlier manual choice", () => {
  const actions = fs.readFileSync(path.join(root, "app/actions/bank-classification.ts"), "utf8");
  const undo = actions.slice(
    actions.indexOf("export async function undoBankTransactionClassificationAction"),
    actions.indexOf("export async function manuallyClassifyBankTransactionAction"),
  );
  assert.match(undo, /classifyTransaction\(affected, transferCandidates\)/);
  assert.match(undo, /suggestedEntryType: fresh\.entryType/);
  assert.doesNotMatch(undo, /reviewedStatusForUndo/);
  // What the rules give the transfer from the report: back to a transfer suggestion.
  const out = rules.classifyTransaction(hblIn("APPROVED"), [scbOut("APPROVED")]);
  assert.equal(out.status, "POTENTIAL_TRANSFER");
  assert.equal(out.category, "INTERNAL_TRANSFER");
});

test("gift: the packet notice says where a gift goes instead of asking for a field", () => {
  const { describeUnmappedPortalSources } = require(path.join(root, "lib/tax/portal-field-map.ts"));
  const only = describeUnmappedPortalSources({ unmappedCategories: [{ category: "GIFT", totalAmount: 65000 }] });
  assert.ok(only.refusal.startsWith("Your filing packet needs a manual IRIS entry for gift (PKR 65,000)"));
  assert.match(only.refusal, /Inflows > Gift \(7037\)/);
  assert.match(only.refusal, /not income/);
  assert.ok(!only.refusal.includes("which FBR/IRIS field should receive"));
  // With another unmapped source the generic question is kept.
  const mixed = describeUnmappedPortalSources({
    unmappedCategories: [{ category: "GIFT", totalAmount: 1 }, { category: "CAPITAL_GAINS", totalAmount: 2 }],
  });
  assert.ok(mixed.refusal.includes("which FBR/IRIS field should receive this amount"));
});

test("gift donor: IRIS needs the donor's CNIC or registration number; typing slips are refused", () => {
  const ok = (v) => gift.validateGiftDonorId(v);
  assert.deepEqual([ok("42101-1234567-1").valid, ok("42101-1234567-1").id], [true, "4210112345671"]);
  assert.equal(ok("1234567").valid, true, "NTN, 7 digits");
  assert.equal(ok("ab1234567").valid, true, "passport style, letters and digits");
  assert.equal(ok("").valid, false);
  assert.equal(ok(undefined).valid, false);
  assert.equal(ok("421011234567").valid, false, "12 digits is a slip, not a CNIC");
  assert.equal(ok("12345").valid, false, "5 digits is neither an NTN nor a CNIC");
  assert.equal(ok("42101123456712").valid, false, "more than IRIS accepts (13)");
  assert.equal(ok("AB12").valid, false, "too short");
  assert.match(ok("421011234567").error, /13 digits/);
});

test("gift donor: a gift with a donor becomes a 7037 Wealth row (one per donor and date); it is still not income", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "INDIVIDUAL",
    taxpayerListStatus: "ACTIVE",
    ledgerEntries: [
      { id: "g1", entryType: "INCOME", category: "GIFT", description: "IBFT gift from brother", amount: 50000, giftDonorId: "4210112345671", date: new Date("2026-01-15T00:00:00Z") },
      { id: "g2", entryType: "INCOME", category: "GIFT", description: "Gift top-up", amount: 15000, giftDonorId: "4210112345671", date: "2026-01-15" },
      { id: "g3", entryType: "INCOME", category: "GIFT", description: "Gift again", amount: 20000, giftDonorId: "4210112345671", date: "2026-03-01" },
      { id: "g4", entryType: "INCOME", category: "GIFT", description: "Gift undated", amount: 7000, giftDonorId: "1234567" },
    ],
  });
  const gifts = map.wealthFields.filter((f) => f.irisCode === "7037");
  assert.equal(gifts.length, 3, "same donor and date merge; another date is another row");
  const first = gifts.find((f) => f.giftDescription === "Gift received on 2026-01-15 from 4210112345671");
  assert.ok(first, JSON.stringify(gifts.map((f) => f.giftDescription)));
  assert.equal(first.ourAmount, 65000);
  assert.equal(first.sourceEntryCount, 2);
  assert.equal(first.rowDescriptionIncludes, first.giftDescription, "the typed text is the row hint");
  assert.equal(first.section, "Reconciliation of Net Assets");
  assert.ok(gifts.some((f) => f.giftDescription === "Gift received during the tax year from 1234567" && f.ourAmount === 7000));
  const auto = flattenPortalFieldMap(map).filter((f) => f.irisCode === "7037");
  assert.equal(auto.length, 3);
  const autoFirst = auto.find((f) => f.giftDescription === first.giftDescription);
  assert.equal(autoFirst.giftDonorId, "4210112345671");
  assert.equal(autoFirst.rowDescriptionIncludes, first.giftDescription);
  assert.equal(autoFirst.sourceGroup, "wealthFields");
  assert.equal(autoFirst.column, "Amount");
  assert.equal(map.incomeFields.length, 0, "nothing is typed as income");
  assert.equal(map.mappingGaps.unmappedCategories.some((c) => c.category === "GIFT"), false, "covered, so no manual gap");
  assert.equal(map.computationHints.totalIncome, 0);
});

test("gift donor: a gift with no donor id is never queued; it stays a manual gap", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "INDIVIDUAL",
    taxpayerListStatus: "ACTIVE",
    ledgerEntries: [{ id: "g2", entryType: "INCOME", category: "GIFT", description: "Deposit 88123", amount: 15000, giftDonorId: null }],
  });
  assert.equal(map.wealthFields.filter((f) => f.irisCode === "7037").length, 0);
  const gap = map.mappingGaps.unmappedCategories.find((c) => c.category === "GIFT");
  assert.ok(gap && gap.totalAmount === 15000);
});

test("gift donor: stored on the transaction, required by both click paths and by the Continue gate", () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(read("prisma/schema.prisma"), /giftDonorId\s+String\?/);
  const migrations = fs.readdirSync(path.join(root, "prisma/migrations")).filter((d) => d.includes("gift_donor"));
  assert.equal(migrations.length, 1);
  assert.match(read(`prisma/migrations/${migrations[0]}/migration.sql`), /ADD COLUMN\s+"giftDonorId" TEXT/);
  const actions = read("app/actions/bank-classification.ts");
  assert.match(actions, /validateGiftDonorId\(giftDonorId\)/, "manual decision");
  assert.match(actions, /validateGiftDonorId\(transaction\.giftDonorId\)\.valid/, "approve click");
  assert.match(actions, /giftDonorId: donorId/, "stored with the decision");
  assert.match(read("lib/tax/filing-completeness.ts"), /Gift needs the donor's CNIC or registration number/);
  assert.match(read("app/actions/bank-transactions.ts"), /giftDonorId: transaction\.giftDonorId/);
  assert.match(read("app/actions/packet.ts"), /giftDonorByTransaction/);
  const ui = read("components/tax/filing/wizard-bank-intelligence-step.tsx");
  assert.match(ui, /Donor CNIC \(13 digits\)/);
  assert.match(ui, /openManualPanel\(\s*row,\s*event\.currentTarget,\s*\{ entryType: "INCOME", category: "GIFT" \}/, "approving a gift suggestion opens the panel");
});

test("unexplained credit: it can never be approved or classified under the placeholder category", () => {
  assert.equal(rules.PLACEHOLDER_INCOME_CATEGORY, "POTENTIAL_INCOME");
  assert.equal(rules.isPlaceholderIncomeCategory(" potential_income "), true);
  assert.equal(rules.isPlaceholderIncomeCategory("SALARY"), false);
  // The rules still produce it for a generic credit, so the guards below are needed.
  assert.equal(classify("Deposit 88123", { credit: "15000" }).category, rules.PLACEHOLDER_INCOME_CATEGORY);
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const actions = read("app/actions/bank-classification.ts");
  assert.equal((actions.match(/isPlaceholderIncomeCategory\(/g) || []).length, 2, "approve click and manual save both refuse it");
  assert.match(read("lib/tax/filing-completeness.ts"), /isPlaceholderIncomeCategory\(transaction\.suggestedCategory\)/, "the Continue gate names an already-approved one");
  const ui = read("components/tax/filing/wizard-bank-intelligence-step.tsx");
  assert.match(ui, /"Choose what this income is"/);
  assert.doesNotMatch(ui, /"Approve as income"/);
});
