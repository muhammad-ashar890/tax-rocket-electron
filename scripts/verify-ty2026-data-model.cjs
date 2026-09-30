const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const migration = fs.readFileSync(
  path.join(
    root,
    "prisma",
    "migrations",
    "20260815120000_add_ty2026_tax_foundation",
    "migration.sql",
  ),
  "utf8",
);
const constants = fs.readFileSync(
  path.join(root, "lib", "tax", "tax-data-model.ts"),
  "utf8",
);

const requiredSchemaFragments = [
  "taxpayerListStatus",
  "taxpayerListStatusSource",
  "taxpayerListStatusCheckedAt",
  "taxRuleSetVersion",
  "taxCalculationRevision",
  "model FilingIncomeSelection",
  "model FilingIncomeRecord",
  "model FilingTaxCredit",
  "model FilingTaxCalculationLine",
  "grossAmount",
  "taxableAmount",
  "taxBase",
  "calculatedTax",
  "@db.Decimal(18, 2)",
  '@relation("IncomeRecordSourceDocument"',
  '@relation("IncomeRecordSourceTransaction"',
  '@relation("TaxCreditSourceDocument"',
  '@relation("TaxCreditSourceTransaction"',
];

const legacySchemaFragments = [
  "incomeSources",
  "salaryPercentage",
  "taxWithheld",
  "taxPayable",
  "refundDue",
  "model BankAccount",
  "model BankStatement",
  "model BankTransaction",
  "model LedgerEntry",
];

const requiredMigrationFragments = [
  'ADD COLUMN "taxpayerListStatus" TEXT',
  'CREATE TABLE "FilingIncomeSelection"',
  'CREATE TABLE "FilingIncomeRecord"',
  'CREATE TABLE "FilingTaxCredit"',
  'CREATE TABLE "FilingTaxCalculationLine"',
  "DECIMAL(18,2)",
  "ON DELETE CASCADE",
  "ON DELETE SET NULL",
];

const requiredConstantFragments = [
  'TY2026_RULE_SET_VERSION = "TY2026-WHT-RATE-CARD-2025-06-30"',
  '"ATL"',
  '"NON_ATL"',
  '"LATE_FILER"',
  '"MANUAL"',
  '"FBR"',
  '"ADJUSTABLE"',
  '"FINAL"',
  '"MINIMUM"',
  "parseManualTaxpayerListStatus",
];

const failures = [];
for (const fragment of requiredSchemaFragments) {
  if (!schema.includes(fragment)) failures.push(`Schema missing: ${fragment}`);
}
for (const fragment of legacySchemaFragments) {
  if (!schema.includes(fragment)) failures.push(`Legacy schema contract removed: ${fragment}`);
}
for (const fragment of requiredMigrationFragments) {
  if (!migration.includes(fragment)) failures.push(`Migration missing: ${fragment}`);
}
for (const fragment of requiredConstantFragments) {
  if (!constants.includes(fragment)) failures.push(`Constants missing: ${fragment}`);
}
if (/\bDROP\s+(TABLE|COLUMN)\b/i.test(migration)) {
  failures.push("Migration must be additive and cannot drop existing tables/columns");
}

const modelCount = (
  schema.match(
    /model Filing(?:IncomeSelection|IncomeRecord|TaxCredit|TaxCalculationLine)\s*\{/g,
  ) || []
).length;
if (modelCount !== 4) {
  failures.push(`Expected 4 tax-foundation models, found ${modelCount}`);
}

if (failures.length) {
  console.error("TY2026 data-model verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("TY2026 data-model foundation is valid.");
console.log(
  JSON.stringify(
    {
      filingStatusFields: 5,
      newModels: 4,
      moneyStorage: "Decimal(18,2)",
      migrationType: "additive",
      legacyContractsPreserved: legacySchemaFragments.length,
    },
    null,
    2,
  ),
);
