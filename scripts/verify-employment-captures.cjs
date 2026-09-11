#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

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
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    filename,
  );
};

const {
  EMPLOYMENT_SALARY_SPEC,
  EMPLOYMENT_TAX_DEDUCTIONS_SPECS,
  SALARY_CERTIFICATE_TAX_ROW,
} = require(path.join(root, "lib/tax/iris-employment-capture.ts"));

const uploadRoot = process.env.IRIS_CAPTURE_DIR || path.join(require("os").homedir(), "uploads");
const salaryPath = path.join(uploadRoot, "employment salary.html");
const deductionsPath = path.join(uploadRoot, "employment tax deductions.html");

function rowsFor(dom) {
  return [...dom.window.document.querySelectorAll(
    ".body.interface_21.active .dataRow[id], .body.interface_21.active .tableRows[id]",
  )];
}

function cellState(row) {
  const wrappers = row.querySelector(".columns-parent")?.querySelectorAll(
    ":scope > .data-middle-child-wapper",
  ) ?? [];
  return [...wrappers].map((wrapper) => {
    const input = wrapper.querySelector("input");
    return Boolean(input && !input.disabled && !input.readOnly);
  });
}

function checkCapture(file, expectedHeaders, expectedRows) {
  const dom = new JSDOM(fs.readFileSync(file, "utf8"));
  const body = dom.window.document.querySelector(".body.interface_21.active");
  assert.ok(body, `${path.basename(file)} has an active Data body`);
  const headings = [...body.querySelectorAll(".heading-bar")].map((heading) =>
    heading.textContent
      .replace(/\s+/g, " ")
      .replace(/Description\s*Code/i, "Description Code")
      .trim(),
  );
  const compactHeadings = headings.map((heading) => heading.replace(/\s+/g, "").toLowerCase());
  for (const header of expectedHeaders) {
    assert.ok(
      compactHeadings.includes(header.replace(/\s+/g, "").toLowerCase()),
      `${path.basename(file)} contains header: ${header}`,
    );
  }

  const rows = new Map(rowsFor(dom).map((row) => [row.id, row]));
  assert.deepEqual(
    [...rows.keys()].filter((code) => Object.hasOwn(expectedRows, code)).sort(),
    Object.keys(expectedRows).sort(),
    `${path.basename(file)} has every expected employment row exactly once`,
  );
  for (const [code, state] of Object.entries(expectedRows)) {
    const actual = cellState(rows.get(code));
    assert.deepEqual(
      actual,
      actual.map((_, index) => state.includes(index)),
      `${path.basename(file)} row ${code} editability`,
    );
  }
  return dom;
}

if (!fs.existsSync(salaryPath) || !fs.existsSync(deductionsPath)) {
  console.log(`SKIP: expected captures are not under ${uploadRoot}`);
  process.exit(0);
}

checkCapture(
  salaryPath,
  ["Description Code Total Income Subject to Final Tax Subject to Exemption Subject to Normal Income"],
  EMPLOYMENT_SALARY_SPEC.rows,
);
checkCapture(
  deductionsPath,
  [
    "Description Code Taxable Amount Tax Deducted",
    "Description Code Taxable Amount Tax Deducted Tax Chargeable",
  ],
  {
    ...EMPLOYMENT_TAX_DEDUCTIONS_SPECS.adjustable.rows,
    ...EMPLOYMENT_TAX_DEDUCTIONS_SPECS.final.rows,
    ...EMPLOYMENT_TAX_DEDUCTIONS_SPECS.average.rows,
  },
);

const deductionsDom = new JSDOM(fs.readFileSync(deductionsPath, "utf8"));
const deductionsBody = deductionsDom.window.document.querySelector(".body.interface_21.active");
const certificatePattern = /(?:salary|withholding|tax)\s*certificate|certificate\s*(?:of\s*)?(?:salary|withholding|tax)/i;
const certificateControlCandidates = [...deductionsBody.querySelectorAll(
  'input, select, textarea, button, [role="button"], [formcontrolname], label',
)].map((el) => {
  const labelFor = el.getAttribute("for");
  const associatedLabel = labelFor
    ? [...deductionsBody.querySelectorAll("label")].find(
        (label) => label.getAttribute("for") === labelFor,
      )
    : el.closest("label");
  return [
    el.getAttribute("aria-label"),
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("formcontrolname"),
    el.getAttribute("ng-reflect-name"),
    el.getAttribute("ng-reflect-model"),
    associatedLabel?.textContent,
    el.textContent,
  ].filter(Boolean).join(" ");
});
assert.equal(
  certificateControlCandidates.some((value) => certificatePattern.test(value)),
  false,
  "Tax Deductions has no salary-certificate control in labels, hidden controls, or Angular metadata",
);
assert.equal(
  deductionsBody.querySelectorAll('input[type="file"]').length,
  0,
  "Tax Deductions has no file input",
);
assert.deepEqual(
  SALARY_CERTIFICATE_TAX_ROW,
  { code: "64020004", column: "Tax Deducted", cellIndex: 1 },
  "certificate maps only after the DOM proves the row and cell",
);
console.log("employment capture contract ok — Salary and Tax Deductions HTML validated");
