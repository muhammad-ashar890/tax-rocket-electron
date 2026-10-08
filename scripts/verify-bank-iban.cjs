#!/usr/bin/env node
/**
 * Bank account IBAN is a REQUIRED field (decision 2026-10-01).
 *
 * IRIS lists a bank in the Wealth Statement through "+ Assets" -> Bank
 * Account(s), whose modal takes the IBAN (maxlength 24) and fetches the title.
 * TaxRocket therefore has to hold a valid IBAN for every account, or the
 * Wealth Statement cannot be completed. This suite pins:
 *   - the IBAN validator (format + ISO 7064 mod-97),
 *   - the shared completeness gate refusing accounts with a missing/bad IBAN
 *     and statements with no transactions,
 *   - the packet carrying one 7030 field per IBAN with a row-match hint.
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
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(output, filename);
};

const { normalizeIban, validatePakistaniIban } = require(path.join(root, "lib/tax/iban.ts"));
const { buildPortalFieldMap, flattenPortalFieldMap } = require(path.join(root, "lib/tax/portal-field-map.ts"));

const VALID = "PK36SCBL0000001123456702";

test("a well-formed PK IBAN is accepted, with spaces/lower case normalised", () => {
  assert.deepEqual(validatePakistaniIban(VALID), { valid: true, iban: VALID, error: "" });
  assert.equal(normalizeIban("pk36 scbl 0000 0011 2345 6702"), VALID);
  assert.equal(validatePakistaniIban("pk36-scbl-0000-0011-2345-6702").valid, true);
});

test("missing, short, long, foreign and mistyped IBANs are each refused with a reason", () => {
  const bad = (value) => {
    const r = validatePakistaniIban(value);
    assert.equal(r.valid, false, `${value} should be refused`);
    return r.error;
  };
  assert.match(bad(""), /required/);
  assert.match(bad(null), /required/);
  assert.match(bad("GB82WEST12345698765432"), /start with PK/);
  assert.match(bad(VALID.slice(0, 23)), /24 characters/);
  assert.match(bad(VALID + "1"), /24 characters/);
  assert.match(bad("PK36SCBL000000112345670!"), /format/);
  assert.match(bad("PK36SCBL0000001123456703"), /check digits/); // one digit off
  assert.match(bad("PK35HABB0000001234567801"), /check digits/); // IRIS test-capture value, not a real IBAN
});

// --- completeness gate with an injected database ---------------------------
const { validateFilingCompleteness } = require(path.join(root, "lib/tax/filing-completeness.ts"));

function fakeDb({ accounts, transactions = [] }) {
  const doc = (a) => ({ id: `doc-${a.id}`, documentType: "bank_statement", bankAccountId: a.id, extractionStatus: "MAPPED" });
  const stmt = (a) => ({
    id: `st-${a.id}`, bankAccountId: a.id, sourceDocumentId: `doc-${a.id}`, currency: "PKR",
    periodStart: new Date(Date.UTC(2025, 6, 1)), periodEnd: new Date(Date.UTC(2026, 5, 30)),
  });
  return {
    filingDraft: { findFirst: async () => ({ id: "d1", userId: "u1", taxYear: 2026, incomeSources: JSON.stringify(["bank_profit"]) }) },
    bankAccount: { findMany: async () => accounts },
    document: {
      findMany: async () => [
        ...accounts.map(doc),
        // Unrelated required slots, present so only the bank rules are under test.
        { id: "doc-cnic", documentType: "cnic", bankAccountId: null, extractionStatus: "MAPPED" },
        { id: "doc-cert", documentType: "bank_certificate", bankAccountId: null, extractionStatus: "MAPPED" },
      ],
    },
    bankStatement: { findMany: async () => accounts.map(stmt) },
    bankTransaction: { findMany: async () => transactions },
  };
}
const account = (extra = {}) => ({ id: "a1", bankName: "SCB", accountLabel: "Salary", currency: "PKR", iban: VALID, ...extra });
const txn = (extra = {}) => ({
  id: "t1", bankAccountId: "a1", bankStatementId: "st-a1", transactionDate: new Date(Date.UTC(2025, 8, 1)),
  description: "x", debit: 0, credit: 10, classificationStatus: "APPROVED", ...extra,
});
const blockersFor = async (db) => (await validateFilingCompleteness({ draftId: "d1", userId: "u1" }, db)).blockers;

test("gate: an account without an IBAN blocks, and names the account", async () => {
  const blockers = await blockersFor(fakeDb({ accounts: [account({ iban: null })], transactions: [txn()] }));
  assert.ok(blockers.some((b) => b.includes("SCB") && /IBAN is required/.test(b)), JSON.stringify(blockers));
});

test("gate: a mistyped IBAN blocks", async () => {
  const blockers = await blockersFor(fakeDb({ accounts: [account({ iban: "PK36SCBL0000001123456703" })], transactions: [txn()] }));
  assert.ok(blockers.some((b) => /check digits/.test(b)), JSON.stringify(blockers));
});

test("gate: a statement with no transactions blocks", async () => {
  const blockers = await blockersFor(fakeDb({ accounts: [account()], transactions: [] }));
  assert.ok(blockers.some((b) => /import the transactions/.test(b)), JSON.stringify(blockers));
});

test("gate: IBAN present, statement and transactions present -> no IBAN/transaction blocker", async () => {
  const blockers = await blockersFor(fakeDb({ accounts: [account()], transactions: [txn()] }));
  assert.deepEqual(blockers, []);
});

// --- packet ------------------------------------------------------------------
const bank = (iban, closingBalance, bankName = "SCB") => ({ iban, bankName, accountLabel: "Main", closingBalance });

test("packet: each IBAN becomes its own 7030 wealth field carrying the row-match hint; never 7012", () => {
  const map = buildPortalFieldMap({
    taxYear: 2026, filerType: "INDIVIDUAL", taxpayerListStatus: null, ledgerEntries: [],
    bankAccounts: [bank(VALID, "2100000.40"), bank("PK35HABB0000001234567801", 750000, "HBL"), bank("PK00ZERO0000000000000000", 0)],
  });
  const banks = map.wealthFields.filter((f) => f.irisCode === "7030");
  assert.equal(banks.length, 2, "zero-balance account is not written");
  const hbl = banks.find((f) => f.rowDescriptionIncludes === "PK35HABB0000001234567801");
  const scb = banks.find((f) => f.rowDescriptionIncludes === VALID);
  assert.equal(scb.ourAmount, 2100000);
  assert.equal(hbl.ourAmount, 750000);
  assert.ok(!map.wealthFields.some((f) => f.irisCode === "7012"));

  const flat = flattenPortalFieldMap(map).filter((f) => f.irisCode === "7030");
  assert.equal(flat.length, 2);
  assert.equal(new Set(flat.map((f) => f.key)).size, 2, "keys must be unique per IBAN");
  assert.ok(flat.every((f) => f.sourceGroup === "wealthFields" && f.rowDescriptionIncludes));
});

const {
  ensureBankStatementReviewFields,
  findPakistaniIbans,
  hasRequiredBankStatementIban,
  isBankStatementIbanLabel,
  validateBankStatementIban,
} = require(path.join(root, "lib/tax/bank-statement-fields.ts"));

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const ibanField = (payload) => payload.fields.find((f) => isBankStatementIbanLabel(f.label));

test("statement review: a statement without an IBAN gets a visible blank REQUIRED IBAN field", () => {
  const out = ensureBankStatementReviewFields({
    documentType: "bank_statement",
    fields: [
      { label: "Currency", value: "PKR", confidence: 1 },
      { label: "Opening Balance", value: 500000, confidence: 1 },
    ],
  });
  const field = ibanField(out);
  assert.ok(field, "blank IBAN field added");
  assert.equal(field.value, null);
  assert.equal(hasRequiredBankStatementIban(out.fields), false);
  assert.equal(validateBankStatementIban(out.fields).error, "IBAN is required");
  // Existing fields are untouched and the placeholder is added once.
  assert.equal(out.fields.length, 3);
  assert.equal(ensureBankStatementReviewFields(out).fields.length, 3);
});

test("statement review: an extracted IBAN satisfies it; a mistyped one does not", () => {
  const good = ensureBankStatementReviewFields({ fields: [{ label: "IBAN", value: "pk36 scbl 0000 0011 2345 6702" }] });
  assert.equal(hasRequiredBankStatementIban(good.fields), true);
  assert.equal(validateBankStatementIban(good.fields).iban, VALID);
  const bad = ensureBankStatementReviewFields({ fields: [{ label: "IBAN", value: "PK35HABB0000001234567801" }] });
  assert.equal(hasRequiredBankStatementIban(bad.fields), false, "check digits must match");
  assert.equal(bad.fields.length, 1, "an existing (wrong) IBAN field is not duplicated");
});

test("statement review: an IBAN printed as the Account Number is promoted, not asked for again", () => {
  const out = ensureBankStatementReviewFields({
    fields: [{ label: "Account Number", value: "PK36 SCBL 0000 0011 2345 6702" }],
  });
  assert.equal(validateBankStatementIban(out.fields).iban, VALID);
  // A plain account number is never turned into an IBAN.
  const plain = ensureBankStatementReviewFields({ fields: [{ label: "Account Number", value: "0123456789" }] });
  assert.equal(ibanField(plain).value, null);
});

test("statement review: IBANs are found in free text only when the check digits hold", () => {
  assert.deepEqual(findPakistaniIbans(`Account Title: X  IBAN: PK36 SCBL 0000 0011 2345 6702  Branch 12`), [VALID]);
  assert.deepEqual(findPakistaniIbans("PK35HABB0000001234567801"), []);
  assert.deepEqual(findPakistaniIbans("Ref 123456789012345678901234"), []);
  assert.ok(!isBankStatementIbanLabel("Account Number"));
  assert.ok(isBankStatementIbanLabel("Account IBAN"));
});

test("wiring: the IBAN is read from the statement, required before mapping, and stored on the account", () => {
  const extraction = read("app/actions/extraction.ts");
  // Extractor is told to return it; all three read/save paths add the blank placeholder.
  assert.match(extraction, /"Currency", "IBAN", "Opening Balance"/);
  assert.equal((extraction.match(/ensureReviewFields\(/g) || []).length >= 4, true);
  assert.match(extraction, /ensureBankStatementReviewFields\(extracted\)/);
  // Mapping refuses without a valid IBAN and writes it to the account.
  assert.match(extraction, /const ibanResolution = await resolveStatementIban/);
  assert.match(extraction, /data: \{ iban: ibanResolution\.iban \}/);
  assert.match(extraction, /already belongs to/);
  // Already-mapped statements get a light "save IBAN" that does not re-map.
  assert.match(extraction, /export async function saveBankStatementIbanAction/);
  // Spreadsheet imports pick up a header IBAN, else leave it to the blank field.
  assert.match(read("app/actions/bank-parser.ts"), /ibansInSheet\.length === 1/);
});

test("wiring: the upload card shows the IBAN as a required field and blocks Map until valid", () => {
  const card = read("components/tax/filing/wizard-documents-step.tsx");
  assert.match(card, /const requiredIbanReady =\s+!isBankStatement \|\| hasRequiredBankStatementIban/);
  assert.match(card, /!requiredSalaryAmountsReady \|\|\s+!requiredSalaryEmployerReady \|\|\s+!requiredSalaryTaxYearReady \|\|\s+!requiredIbanReady/);
  assert.match(card, /isBankStatementIbanLabel\(field\.label\) && \(/);
  assert.match(card, /handleSaveStatementIban\(slotKey\)/);
  // The separate IBAN panel is gone; there is no second place to type it.
  assert.ok(!fs.existsSync(path.join(root, "components/tax/filing/wizard-bank-iban-panel.tsx")));
  assert.ok(!/iban/i.test(read("components/tax/filing/wizard-setup-step.tsx").replace(/iban: ""/g, "").replace(/the IBAN is read from each statement/g, "")));
});

test("setup step: bank accounts no longer need an IBAN, and re-saving never erases a statement's IBAN", () => {
  const { isBankAccountComplete } = require(path.join(root, "components/tax/filing/config/bank-account-types.ts"));
  assert.equal(isBankAccountComplete({ clientId: "a", bankName: "HBL", accountLabel: "Account 1", iban: "" }), true);
  const actions = read("app/actions/bank-accounts.ts");
  assert.match(actions, /existingIbanById/);
  assert.match(actions, /Never null out an IBAN already read from a statement/);
});

test("pipeline gate: an account still lacking an IBAN disables Continue (documents → reconciliation)", () => {
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.match(wizard, /if \(ibanGatedStep && accountsMissingIban\.length > 0\) return false;/);
  assert.ok(
    wizard.indexOf("ibanGatedStep && accountsMissingIban.length > 0) return false") <
      wizard.indexOf('currentStepKey === "documents" ||\n      currentStepKey === "bank_intelligence"'),
    "must be decided before the keep-clickable-for-feedback shortcut",
  );
  assert.match(wizard, /IBAN is required for \$\{noIban/);
  // After mapping or saving the IBAN the account list is re-read, so the gate releases.
  assert.match(wizard, /onBankAccountsChanged: refreshBankAccountsFromServer/);
  assert.match(read("components/tax/filing/hooks/use-filing-documents.ts"), /onBankAccountsChanged\?\.\(\)/);
});
