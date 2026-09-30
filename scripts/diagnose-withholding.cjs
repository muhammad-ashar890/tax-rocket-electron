/**
 * Read-only diagnostic for the withholding figure on a live draft.
 *
 * Prints exactly what the calculation reads, in the order it reads it, so the
 * reason a Tax Payable is non-zero can be pointed at instead of guessed:
 *
 *   1. the draft's stored columns,
 *   2. the salary certificate and whether it counts as MAPPED,
 *   3. every ledger row the resolver considers, with its category,
 *   4. every bank transaction that mentions tax but never became a ledger row,
 *   5. the resolver's own answer for this draft.
 *
 * Writes nothing. Safe to run against real data.
 */

const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const Module = require("module");

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
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
};

const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const { PrismaClient } = require("@prisma/client");
const {
  resolveTaxWithheld,
  normalizeLedgerCategory,
} = require("@/lib/tax/withholding-sources.ts");
const { toMoneyAmount } = require("@/lib/money.ts");

const prisma = new PrismaClient();

/**
 * Mirrors extractMappedSalaryWithholding in app/actions/tax-calculation.ts,
 * which is module-private. Copied deliberately and only here: this file is a
 * diagnostic, not a test, so it must never be the thing that decides whether
 * the production reader is correct.
 */
function readCertificateWithholding(extractedData) {
  if (!extractedData) return null;
  try {
    const payload = JSON.parse(extractedData);
    const field = payload.fields?.find((item) => {
      const label = String(item.label ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_");
      return (
        label.includes("tax_deducted") ||
        label.includes("tax_withheld") ||
        label.includes("income_tax_deducted")
      );
    });
    if (field === undefined) return null;
    const value = field.value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parsed = Number(text.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const money = (value) =>
  value === null || value === undefined
    ? "(none)"
    : Number(toMoneyAmount(value)).toLocaleString("en-US");

function heading(text) {
  console.log(`\n${text}`);
  console.log("-".repeat(text.length));
}

async function main() {
  const draft = await prisma.filingDraft.findFirst({
    orderBy: { updatedAt: "desc" },
    include: { user: { select: { email: true } } },
  });

  if (!draft) {
    console.log("No filing draft found in this database.");
    return;
  }

  heading("DRAFT");
  console.log(`id            ${draft.id}`);
  console.log(`user          ${draft.user?.email ?? "(unknown)"}`);
  console.log(`taxYear       ${draft.taxYear}`);
  console.log(`incomeSources ${draft.incomeSources}`);
  console.log(`taxWithheld   ${money(draft.taxWithheld)}   <- stored column`);
  console.log(`taxPayable    ${money(draft.taxPayable)}   <- what the screen shows`);
  console.log(`refundDue     ${money(draft.refundDue)}`);
  console.log(`calcStatus    ${draft.taxCalculationStatus}`);

  let sources = [];
  try {
    sources = JSON.parse(draft.incomeSources);
  } catch {
    sources = [];
  }
  const isSalariedRoute = sources.includes("salary");
  console.log(`salary route  ${isSalariedRoute}`);

  heading("DOCUMENTS");
  const documents = await prisma.document.findMany({
    where: { filingDraftId: draft.id },
    select: {
      documentType: true,
      fileName: true,
      extractionStatus: true,
      extractedData: true,
    },
  });
  if (documents.length === 0) console.log("(none)");
  for (const doc of documents) {
    console.log(
      `${doc.extractionStatus.padEnd(10)} ${doc.documentType.padEnd(20)} ${doc.fileName}`,
    );
  }

  // The calculation only accepts a certificate whose status is exactly MAPPED.
  const certificate = documents.find(
    (doc) =>
      doc.documentType === "salary_certificate" &&
      doc.extractionStatus === "MAPPED",
  );
  const certificateCandidate = documents.find(
    (doc) => doc.documentType === "salary_certificate",
  );

  heading("SALARY CERTIFICATE (Section 149)");
  if (!certificateCandidate) {
    console.log("No salary_certificate document on this draft.");
  } else if (!certificate) {
    console.log(
      `Found one, but its status is ${certificateCandidate.extractionStatus}, not MAPPED.`,
    );
    console.log("The calculation ignores it until it is mapped.");
  } else {
    console.log("Status MAPPED - the calculation will read it.");
  }

  let certificateTaxWithheld = 0;
  if (isSalariedRoute && certificate) {
    certificateTaxWithheld =
      readCertificateWithholding(certificate.extractedData ?? null) ?? 0;
  }
  console.log(`certificateTaxWithheld = ${money(certificateTaxWithheld)}`);

  heading("LEDGER ROWS THE RESOLVER SEES");
  const entries = await prisma.ledgerEntry.findMany({
    where: { filingDraftId: draft.id, userId: draft.userId },
    select: {
      entryType: true,
      category: true,
      amount: true,
      description: true,
      source: true,
    },
    orderBy: { entryDate: "asc" },
  });
  console.log(`${entries.length} ledger rows in total.`);

  const taxRows = entries.filter(
    (entry) =>
      entry.entryType === "EXPENSE" &&
      normalizeLedgerCategory(entry.category) === "TAX_PAYMENT",
  );
  console.log(`${taxRows.length} of them count as tax deducted:`);
  for (const row of taxRows) {
    console.log(
      `  ${money(row.amount).padStart(12)}  ${(row.category ?? "").padEnd(18)} ${row.description}`,
    );
  }

  // Rows whose wording mentions tax but whose category is something else are
  // the usual reason a deduction never reaches the calculation.
  const nearMisses = entries.filter(
    (entry) =>
      /tax|wht|withhold|151|149/i.test(entry.description ?? "") &&
      !(
        entry.entryType === "EXPENSE" &&
        normalizeLedgerCategory(entry.category) === "TAX_PAYMENT"
      ),
  );
  if (nearMisses.length > 0) {
    console.log(
      `\n${nearMisses.length} row(s) mention tax but are NOT counted, because of their type/category:`,
    );
    for (const row of nearMisses) {
      console.log(
        `  ${money(row.amount).padStart(12)}  ${String(row.entryType).padEnd(10)} ${(row.category ?? "(no category)").padEnd(20)} ${row.description}`,
      );
    }
  }

  heading("BANK TRANSACTIONS THAT MENTION TAX");
  const transactions = await prisma.bankTransaction.findMany({
    where: { filingDraftId: draft.id },
    select: {
      description: true,
      debit: true,
      credit: true,
      classificationStatus: true,
      suggestedEntryType: true,
      suggestedCategory: true,
    },
  });
  const taxLike = transactions.filter((transaction) =>
    /tax|wht|withhold|151|149/i.test(transaction.description ?? ""),
  );
  console.log(
    `${transactions.length} bank transactions; ${taxLike.length} mention tax.`,
  );
  for (const transaction of taxLike) {
    const amount =
      toMoneyAmount(transaction.debit) || toMoneyAmount(transaction.credit);
    console.log(
      `  ${money(amount).padStart(12)}  ${transaction.classificationStatus.padEnd(12)} ` +
        `${String(transaction.suggestedEntryType ?? "-").padEnd(10)} ` +
        `${String(transaction.suggestedCategory ?? "-").padEnd(20)} ${transaction.description}`,
    );
  }
  const unapproved = taxLike.filter(
    (transaction) => transaction.classificationStatus !== "APPROVED",
  );
  if (unapproved.length > 0) {
    console.log(
      `\n${unapproved.length} tax-like transaction(s) are not APPROVED, so they have no ledger row at all.`,
    );
  }

  heading("RESOLVER RESULT");
  const resolution = resolveTaxWithheld({
    certificateTaxWithheld,
    entries,
    storedTaxWithheld: toMoneyAmount(draft.taxWithheld),
  });
  console.log(`certificate  ${money(resolution.certificateTaxWithheld)}`);
  console.log(`ledger       ${money(resolution.ledgerTaxWithheld)}`);
  console.log(`TOTAL        ${money(resolution.taxWithheld)}`);
  console.log(`warning      ${resolution.duplicateWarning ?? "(none)"}`);

  heading("VERDICT");
  if (resolution.ledgerTaxWithheld === 0 && taxLike.length > 0) {
    console.log(
      "The bank's tax rows exist but are NOT reaching the calculation.\n" +
        "Look at the two lists above: either the transactions are not APPROVED,\n" +
        "or they were approved into a category other than TAX_PAYMENT.",
    );
  } else if (resolution.ledgerTaxWithheld > 0) {
    console.log(
      `The resolver is finding ${money(resolution.ledgerTaxWithheld)} of bank withholding.\n` +
        "If the screen still shows tax payable, the page is showing a stored\n" +
        "figure from before the fix - press Calculate again on the Review step.",
    );
  } else {
    console.log(
      "No tax rows found anywhere on this draft. Nothing for the resolver to add.",
    );
  }
}

main()
  .catch((error) => {
    console.error(`\nDiagnostic failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
