#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
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

const {
  ensureSalaryCertificateReviewFields,
  extractSalaryCertificateAmounts,
  getSalaryCertificateFieldKind,
  hasRequiredSalaryCertificateAmounts,
  resolveSalaryTaxableIncome,
} = require(path.join(root, "lib/tax/salary-certificate-fields.ts"));

const payload = {
  documentType: "salary_certificate",
  fields: [
    { label: "Employer Name", value: "Example Employer", confidence: 0.99 },
    { label: "Gross Salary (Annual PKR)", value: "PKR 3,420,000", confidence: 0.99 },
    { label: "Tax Deducted u/s 149 (Annual PKR)", value: "210,000", confidence: 0.99 },
  ],
  notes: ["Synthetic test only"],
};

const amounts = extractSalaryCertificateAmounts(JSON.stringify(payload));
assert.deepEqual(amounts, { grossSalary: 3420000, taxWithheld: 210000 });
assert.equal(hasRequiredSalaryCertificateAmounts(payload.fields), true);
assert.equal(getSalaryCertificateFieldKind("Gross Salary (Monthly PKR)"), null);

const ready = ensureSalaryCertificateReviewFields({
  fields: [{ label: "Employer Name", value: "Example Employer" }],
});
assert.equal(ready.fields.length, 3, "missing annual fields are added without removing optional fields");
assert.equal(ready.fields[0].label, "Employer Name", "optional extracted details are preserved");
assert.equal(hasRequiredSalaryCertificateAmounts(ready.fields), false);
assert.deepEqual(extractSalaryCertificateAmounts("not-json"), {
  grossSalary: null,
  taxWithheld: null,
});

assert.equal(
  resolveSalaryTaxableIncome({
    ledgerSalaryRemainder: 3210000,
    bankSalaryIncome: 3210000,
    certificateGrossSalary: 3420000,
  }),
  3420000,
  "Case B taxable salary uses certificate gross rather than net deposits",
);
assert.equal(
  resolveSalaryTaxableIncome({
    ledgerSalaryRemainder: 3210000,
    bankSalaryIncome: 3210000,
    certificateGrossSalary: 3210000,
  }),
  3210000,
  "Case A remains unchanged when certificate and bank amounts match",
);
assert.equal(
  resolveSalaryTaxableIncome({
    ledgerSalaryRemainder: 3300000,
    bankSalaryIncome: 3210000,
    certificateGrossSalary: 3420000,
  }),
  3510000,
  "ordinary ledger income outside salary bank deposits is preserved",
);
assert.equal(
  resolveSalaryTaxableIncome({
    ledgerSalaryRemainder: 3210000,
    bankSalaryIncome: 3210000,
    certificateGrossSalary: null,
  }),
  3210000,
  "legacy/unmapped certificate falls back to ledger salary",
);

console.log("Salary-certificate field and gross-source checks passed.");
