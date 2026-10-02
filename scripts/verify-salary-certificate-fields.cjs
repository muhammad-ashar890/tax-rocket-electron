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
  extractSalaryCertificateEmployers,
  getSalaryCertificateFieldKind,
  hasRequiredSalaryCertificateAmounts,
  hasRequiredSalaryCertificateEmployer,
  isSalaryCertificateRequiredField,
  planSalaryCertificateEmployerUpdate,
  resolveSalaryTaxableIncome,
  parseSalaryCertificateTaxYear,
  checkSalaryCertificateTaxYear,
  salaryCertificateEmployerSignature,
} = require(path.join(root, "lib/tax/salary-certificate-fields.ts"));

const payload = {
  documentType: "salary_certificate",
  fields: [
    { label: "Employer Name", value: "Example Employer", confidence: 0.99 },
    {
      label: "Gross Salary (Annual PKR)",
      value: "PKR 3,420,000",
      confidence: 0.99,
    },
    {
      label: "Tax Deducted u/s 149 (Annual PKR)",
      value: "210,000",
      confidence: 0.99,
    },
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
assert.equal(
  ready.fields.length,
  5,
  "missing annual fields, Tax Year and the optional other-employers field are added without removing extracted fields",
);
assert.equal(
  ready.fields[0].label,
  "Employer Name",
  "optional extracted details are preserved",
);
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

// Employer names: IRIS needs each employer added by its registered name.
assert.equal(getSalaryCertificateFieldKind("Employer Name"), "employer_name");
assert.equal(
  getSalaryCertificateFieldKind("Employer Name (as registered with FBR)"),
  "employer_name",
);
assert.equal(
  getSalaryCertificateFieldKind(
    "Other Employer Names (optional, separate with ;)",
  ),
  "other_employers",
);
for (const notAName of [
  "Employer NTN",
  "Employer Address",
  "Employer Name/NTN",
  "Employer Registration No.",
]) {
  assert.equal(getSalaryCertificateFieldKind(notAName), null, notAName);
}
assert.equal(isSalaryCertificateRequiredField("Employer Name"), true);
assert.equal(
  isSalaryCertificateRequiredField(
    "Other Employer Names (optional, separate with ;)",
  ),
  false,
);
assert.equal(
  isSalaryCertificateRequiredField("Gross Salary (Annual PKR)"),
  true,
);
assert.equal(isSalaryCertificateRequiredField("Basic Pay"), false);

const noEmployer = ensureSalaryCertificateReviewFields({
  fields: [{ label: "Gross Salary (Annual PKR)", value: "3420000" }],
});
assert.equal(
  hasRequiredSalaryCertificateEmployer(noEmployer.fields),
  false,
  "a blank employer field is required",
);
assert.ok(
  noEmployer.fields.some(
    (f) =>
      f.label === "Employer Name (as registered with FBR)" && f.value === null,
  ),
);
assert.equal(
  hasRequiredSalaryCertificateEmployer([
    { label: "Employer Name", value: "   " },
  ]),
  false,
  "whitespace is not a name",
);
assert.equal(
  hasRequiredSalaryCertificateEmployer([
    { label: "Employer Name", value: "ACME (PRIVATE) LIMITED" },
  ]),
  true,
);
assert.deepEqual(extractSalaryCertificateEmployers(JSON.stringify(payload)), [
  "Example Employer",
]);
assert.deepEqual(
  extractSalaryCertificateEmployers(
    JSON.stringify({
      fields: [
        { label: "Employer Name", value: " Acme  Ltd " },
        {
          label: "Other Employer Names (optional, separate with ;)",
          value: "Beta Corp; acme ltd;\nGamma Co",
        },
        { label: "Employer NTN", value: "1234567-8" },
      ],
    }),
  ),
  ["Acme Ltd", "Beta Corp", "Gamma Co"],
  "main employer first, extras split on ; or new lines, duplicates dropped, NTN ignored",
);
assert.deepEqual(extractSalaryCertificateEmployers("not-json"), []);
assert.deepEqual(extractSalaryCertificateEmployers(null), []);

// Editing the employer names of an already-mapped certificate.
{
  const mapped = JSON.stringify({
    fields: [
      {
        label: "Gross Salary (Annual PKR)",
        value: "3420000",
        confidence: 0.99,
      },
      {
        label: "Tax Deducted u/s 149 (Annual PKR)",
        value: "210000",
        confidence: 0.99,
      },
      {
        label: "Employer Name (as registered with FBR)",
        value: "HASEEB KHAN",
        confidence: 0.95,
      },
      { label: "Employer NTN", value: "1234567-8", confidence: 0.99 },
    ],
    notes: ["kept"],
  });
  const plan = planSalaryCertificateEmployerUpdate(mapped, {
    employerName: "  HASEEB KHAN BRAND (SMC-PRIVATE) LIMITED ",
    otherEmployerNames: "Beta Corp; Gamma Co",
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.employers, [
    "HASEEB KHAN BRAND (SMC-PRIVATE) LIMITED",
    "Beta Corp",
    "Gamma Co",
  ]);
  const next = JSON.parse(plan.extractedData);
  assert.deepEqual(next.notes, ["kept"], "other payload keys survive");
  const amounts = extractSalaryCertificateAmounts(plan.extractedData);
  assert.equal(amounts.grossSalary, 3420000, "amounts are untouched");
  assert.equal(amounts.taxWithheld, 210000);
  assert.equal(
    next.fields.find((f) => f.label === "Employer NTN").value,
    "1234567-8",
    "the NTN field is not treated as an employer name",
  );
  assert.equal(
    next.fields.filter(
      (f) => getSalaryCertificateFieldKind(f.label) === "employer_name",
    ).length,
    1,
    "exactly one main employer field remains",
  );
  // No other employers: the optional field is emptied, not left stale.
  const cleared = planSalaryCertificateEmployerUpdate(plan.extractedData, {
    employerName: "Acme Ltd",
    otherEmployerNames: "",
  });
  assert.deepEqual(cleared.employers, ["Acme Ltd"]);
  // Refusals.
  assert.equal(
    planSalaryCertificateEmployerUpdate(mapped, { employerName: "" }).ok,
    false,
  );
  assert.equal(
    planSalaryCertificateEmployerUpdate(mapped, { employerName: "A; B" }).ok,
    false,
    "one name only in the main field",
  );
  assert.equal(
    planSalaryCertificateEmployerUpdate(mapped, {
      employerName: "x".repeat(201),
    }).ok,
    false,
  );
  assert.equal(
    planSalaryCertificateEmployerUpdate("not-json", { employerName: "A" }).ok,
    false,
  );
}

// Tax Year: required, readable, and equal to the return's tax year.
assert.equal(getSalaryCertificateFieldKind("Tax Year"), "tax_year");
assert.equal(
  isSalaryCertificateRequiredField("Tax Year"),
  true,
  "Tax Year is required",
);
assert.equal(
  getSalaryCertificateFieldKind("Tax Deducted u/s 149 (Annual PKR)"),
  "tax_withheld",
  "Tax Year does not capture the tax field",
);
assert.equal(
  getSalaryCertificateFieldKind("Salary Period"),
  null,
  "Salary Period stays optional",
);
assert.ok(
  ready.fields.some((f) => f.label === "Tax Year" && f.value === null),
  "a blank Tax Year field is added",
);
for (const [text, year] of [
  ["2026", 2026],
  ["TY2026", 2026],
  ["Tax Year 2026", 2026],
  ["2025-26", 2026],
  ["2025/26", 2026],
  ["01 July 2025 to 30 June 2026", 2026],
  ["01-07-2025 - 30-06-2026", 2026],
  ["", null],
  [null, null],
  ["next year", null],
  ["12345", null],
]) {
  assert.equal(parseSalaryCertificateTaxYear(text), year, String(text));
}
{
  const withYear = (value) => [{ label: "Tax Year", value }];
  assert.equal(checkSalaryCertificateTaxYear(withYear("2026"), 2026).ok, true);
  assert.equal(
    checkSalaryCertificateTaxYear(withYear("July 2025 to June 2026"), 2026).ok,
    true,
  );
  const wrong = checkSalaryCertificateTaxYear(withYear("2025"), 2026);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.certificateTaxYear, 2025);
  assert.match(wrong.error, /tax year 2025.*tax year 2026/);
  const missing = checkSalaryCertificateTaxYear(withYear(null), 2026);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Enter the tax year/);
  assert.equal(checkSalaryCertificateTaxYear(undefined, 2026).ok, false);
}

// A comma separates OTHER employers only; the main name stays one name.
assert.deepEqual(
  extractSalaryCertificateEmployers(
    JSON.stringify({
      fields: [
        { label: "Employer Name", value: "Acme Ltd" },
        {
          label: "Other Employer Names (optional, separate with ; or ,)",
          value: "technexia, systems limited",
        },
      ],
    }),
  ),
  ["Acme Ltd", "technexia", "systems limited"],
);
assert.deepEqual(
  extractSalaryCertificateEmployers(
    JSON.stringify({
      fields: [{ label: "Employer Name", value: "Smith, Jones and Co" }],
    }),
  ),
  ["Smith, Jones and Co"],
  "a comma in the main name is not a separator",
);
assert.equal(
  planSalaryCertificateEmployerUpdate("{}", {
    employerName: "Acme",
    otherEmployerNames: "B, C",
  }).employers.length,
  3,
);

// Unsaved-edit detection: same names (any spacing or separator) are the same.
{
  const base = [
    { label: "Employer Name", value: "Acme Ltd" },
    {
      label: "Other Employer Names (optional, separate with ;)",
      value: "Beta Corp; Gamma Co",
    },
  ];
  const sig = salaryCertificateEmployerSignature(base);
  assert.equal(
    salaryCertificateEmployerSignature([
      { label: "Employer Name", value: " Acme   Ltd " },
      {
        label: "Other Employer Names (optional, separate with ; or ,)",
        value: "Beta Corp, Gamma Co",
      },
    ]),
    sig,
    "spacing and the separator typed do not count as an edit",
  );
  assert.notEqual(
    salaryCertificateEmployerSignature([
      { label: "Employer Name", value: "Acme Limited" },
      base[1],
    ]),
    sig,
    "a changed name is an edit",
  );
  assert.notEqual(
    salaryCertificateEmployerSignature([base[0]]),
    sig,
    "removing the others is an edit",
  );
}

console.log("Salary-certificate field and gross-source checks passed.");
