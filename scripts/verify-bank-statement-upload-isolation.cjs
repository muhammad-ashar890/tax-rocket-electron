const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalTsLoader = Module._extensions[".ts"];
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

let assertionCount = 0;
function equal(actual, expected, label) {
  assertionCount += 1;
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}
function includes(source, fragment, label) {
  assertionCount += 1;
  if (!source.includes(fragment)) {
    throw new Error(`${label}: missing ${fragment}`);
  }
}
function excludes(source, fragment, label) {
  assertionCount += 1;
  if (source.includes(fragment)) {
    throw new Error(`${label}: unexpected ${fragment}`);
  }
}

try {
  const {
    buildBankStatementCleanupWhere,
    buildFilingDocumentSlotWhere,
    resolveFilingDocumentSlot,
  } = require(path.join(root, "lib", "tax", "document-upload-slot.ts"));

  const missingPlainAccount = resolveFilingDocumentSlot("bank_statement", "");
  equal(missingPlainAccount.success, false, "Plain bank slot requires account");

  const missingEmbeddedAccount = resolveFilingDocumentSlot(
    "bank_statement:   ",
    "",
  );
  equal(
    missingEmbeddedAccount.success,
    false,
    "Embedded bank slot requires account",
  );

  const embedded = resolveFilingDocumentSlot("bank_statement:account-hbl", "");
  equal(embedded.success, true, "Embedded account slot accepted");
  if (embedded.success) {
    equal(embedded.documentType, "bank_statement", "Bank type normalized");
    equal(embedded.bankAccountId, "account-hbl", "Embedded account preserved");
  }

  const supplied = resolveFilingDocumentSlot(
    "bank_statement",
    " account-meezan ",
  );
  equal(supplied.success, true, "Explicit account slot accepted");
  if (supplied.success) {
    equal(supplied.bankAccountId, "account-meezan", "Explicit account trimmed");
  }

  const matchingDuplicate = resolveFilingDocumentSlot(
    "bank_statement:account-hbl",
    "account-hbl",
  );
  equal(
    matchingDuplicate.success,
    true,
    "Matching embedded and supplied account accepted",
  );

  const conflictingAccount = resolveFilingDocumentSlot(
    "bank_statement:account-hbl",
    "account-meezan",
  );
  equal(
    conflictingAccount.success,
    false,
    "Conflicting bank account IDs rejected",
  );

  const nonBank = resolveFilingDocumentSlot("cnic", "");
  equal(nonBank.success, true, "Normal non-bank slot accepted");
  if (nonBank.success) {
    equal(nonBank.bankAccountId, null, "Non-bank slot has no account lineage");
  }

  const linkedNonBank = resolveFilingDocumentSlot(
    "salary_certificate",
    "account-hbl",
  );
  equal(linkedNonBank.success, false, "Non-bank account linkage rejected");

  // Two-account regression: selecting and cleaning the HBL replacement slot
  // must not match the Meezan document or any of its extracted statements.
  const draftId = "draft-2026";
  const userId = "user-a";
  const accountHbl = "account-hbl";
  const accountMeezan = "account-meezan";
  const documentHbl = "document-hbl";
  const documentMeezan = "document-meezan";

  const hblDocumentWhere = buildFilingDocumentSlotWhere(
    draftId,
    userId,
    "bank_statement",
    accountHbl,
  );
  equal(
    hblDocumentWhere.bankAccountId,
    accountHbl,
    "Previous-document scope retains HBL account",
  );

  const documents = [
    {
      id: documentHbl,
      filingDraftId: draftId,
      userId,
      documentType: "bank_statement",
      bankAccountId: accountHbl,
    },
    {
      id: documentMeezan,
      filingDraftId: draftId,
      userId,
      documentType: "bank_statement",
      bankAccountId: accountMeezan,
    },
  ];
  const selectedDocumentIds = documents
    .filter((document) =>
      Object.entries(hblDocumentWhere).every(
        ([key, value]) => document[key] === value,
      ),
    )
    .map((document) => document.id);
  equal(
    selectedDocumentIds.join(","),
    documentHbl,
    "HBL replacement cannot select the Meezan document",
  );

  const cleanupWhere = buildBankStatementCleanupWhere(
    draftId,
    userId,
    accountHbl,
    documentHbl,
  );
  equal(
    cleanupWhere.OR[1].bankAccountId,
    accountHbl,
    "Statement cleanup retains HBL account",
  );
  const statements = [
    {
      id: "statement-hbl-by-document",
      filingDraftId: draftId,
      userId,
      bankAccountId: accountHbl,
      sourceDocumentId: documentHbl,
    },
    {
      id: "statement-hbl-by-account",
      filingDraftId: draftId,
      userId,
      bankAccountId: accountHbl,
      sourceDocumentId: "older-document-hbl",
    },
    {
      id: "statement-meezan",
      filingDraftId: draftId,
      userId,
      bankAccountId: accountMeezan,
      sourceDocumentId: documentMeezan,
    },
  ];
  const cleanupStatementIds = statements
    .filter(
      (statement) =>
        statement.filingDraftId === cleanupWhere.filingDraftId &&
        statement.userId === cleanupWhere.userId &&
        cleanupWhere.OR.some((condition) =>
          "sourceDocumentId" in condition
            ? statement.sourceDocumentId === condition.sourceDocumentId
            : statement.bankAccountId === condition.bankAccountId,
        ),
    )
    .map((statement) => statement.id);
  equal(
    cleanupStatementIds.join(","),
    "statement-hbl-by-document,statement-hbl-by-account",
    "HBL cleanup excludes the Meezan statement",
  );
  equal(
    statements
      .filter((statement) => !cleanupStatementIds.includes(statement.id))
      .map((statement) => statement.id)
      .join(","),
    "statement-meezan",
    "Meezan statement remains untouched",
  );

  const actionSource = fs.readFileSync(
    path.join(root, "app", "actions", "documents.ts"),
    "utf8",
  );
  includes(
    actionSource,
    "resolveFilingDocumentSlot",
    "Upload action uses authoritative slot resolver",
  );
  includes(
    actionSource,
    "where: buildFilingDocumentSlotWhere(",
    "Previous-document query uses exact slot builder",
  );
  includes(
    actionSource,
    "where: buildBankStatementCleanupWhere(",
    "Statement cleanup uses exact account builder",
  );
  includes(
    actionSource,
    "previousDocument.bankAccountId !== bankAccountId",
    "Replacement verifies previous document account",
  );
  includes(
    actionSource,
    'isolationLevel: "Serializable"',
    "Replacement uses serializable transaction",
  );
  excludes(
    actionSource,
    "{ filingDraftId: draft.id }, // fallback",
    "Action has no filing-wide statement cleanup fallback",
  );

  const transactionActionSource = fs.readFileSync(
    path.join(root, "app", "actions", "bank-transactions.ts"),
    "utf8",
  );
  includes(
    transactionActionSource,
    'orderBy: [\n          { transactionDate: "asc" },\n          { createdAt: "asc" },',
    "Bank transaction lists sort chronologically by transactionDate",
  );

  console.log("Bank-statement upload isolation checks passed.");
  console.log(JSON.stringify({ assertionCount }, null, 2));
} finally {
  if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
  else delete Module._extensions[".ts"];
}
