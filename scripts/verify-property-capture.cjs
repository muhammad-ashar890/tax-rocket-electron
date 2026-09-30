#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const projectRoot = path.resolve(__dirname, "..");
const captureRoot = process.env.IRIS_CAPTURE_DIR || path.join(require("node:os").homedir(), "uploads");
const files = {
  receipts: path.join(
    captureRoot,
    "Property Receipts-Deductions sidebar tab.html",
  ),
  taxDeductions: path.join(captureRoot, "Property - Tax Deductions.html"),
  selectionPopup: path.join(captureRoot, "seelect property popup.html"),
};

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const load = (file) => {
  expect(fs.existsSync(file), `missing capture: ${file}`);
  return new JSDOM(fs.readFileSync(file, "utf8")).window.document;
};
const visible = (element) => {
  if (!element) return false;
  const style = element.getAttribute("style") || "";
  return !element.hasAttribute("hidden") && !/display\s*:\s*none/i.test(style);
};
const activeBody = (document) =>
  document.querySelector("app-nitr-wf-body .body.interface_21.active") ||
  document.querySelector(".body.interface_21.active");
const row = (body, code) =>
  [...body.querySelectorAll("[id]")].find(
    (element) => element.id === code && /(?:^|\s)dataRow(?:\s|$)/.test(element.className),
  );
const rowInputs = (element) =>
  [...element.querySelectorAll("input")].filter((input) => input.type !== "hidden");
const writableIndexes = (element) =>
  rowInputs(element)
    .map((input, index) => (!input.disabled && !input.readOnly ? index : null))
    .filter((index) => index !== null);
const rowLabels = (body) =>
  [...body.querySelectorAll(".dataRow[id]")].map((element) => element.id);
const controlTexts = (body) =>
  [...body.querySelectorAll("button, a, input[type=button]")]
    .filter(visible)
    .map((element) => (element.textContent || element.value || "").replace(/\s+/g, " ").trim());

const receipts = load(files.receipts);
const receiptsBody = activeBody(receipts);
expect(receiptsBody, "receipts: active IRIS data body not found");
if (receiptsBody) {
  const expectedRows = {
    "2000": [],
    "2029": [],
    "2001": [],
    "2002": [0],
    "2003": [0],
    "2004": [0, 1],
    "2005": [0, 1],
    "2099": [],
    "2031": [],
  };
  const expectedRowOrder = [
    "2000",
    "2029",
    "2001",
    "2002",
    "2003",
    "2004",
    "2005",
    "2099",
    "2031",
  ];
  expect(
    JSON.stringify(rowLabels(receiptsBody)) === JSON.stringify(expectedRowOrder),
    `receipts: row order/codes changed: ${JSON.stringify(rowLabels(receiptsBody))}`,
  );
  for (const [code, expected] of Object.entries(expectedRows)) {
    const element = row(receiptsBody, code);
    expect(element, `receipts: row ${code} not rendered`);
    if (element)
      expect(
        JSON.stringify(writableIndexes(element)) === JSON.stringify(expected),
        `receipts: row ${code} writable indexes were ${JSON.stringify(writableIndexes(element))}, expected ${JSON.stringify(expected)}`,
      );
  }
  const headings = [...receiptsBody.querySelectorAll(".heading-bar strong")]
    .map((element) => element.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  expect(
    JSON.stringify(headings.slice(-3)) ===
      JSON.stringify(["Total Amount", "Subject to Exemption", "Subject to Normal Tax"]),
    `receipts: amount headers changed: ${JSON.stringify(headings)}`,
  );
  const text = receiptsBody.textContent.replace(/\s+/g, " ");
  expect(/\+\s*Property/.test(text), "receipts: + Property control not present");
  expect(/\+\s*Deduction/.test(text), "receipts: + Deduction control not present");
  expect(/NEXT/.test(text), "receipts: NEXT navigation control not present");
  expect(/BACK/.test(text), "receipts: BACK navigation control not present");
  const addProperty = [...receiptsBody.querySelectorAll("button")].find(
    (button) => button.textContent.replace(/\s+/g, " ").trim() === "+ Property",
  );
  const addDeduction = [...receiptsBody.querySelectorAll("button")].find(
    (button) => button.textContent.replace(/\s+/g, " ").trim() === "+ Deduction",
  );
  expect(addProperty, "receipts: + Property button not found");
  expect(addDeduction, "receipts: + Deduction button not found");
  if (addProperty) {
    expect(addProperty.getAttribute("type"), "button", "receipts: + Property type");
    expect(addProperty.getAttribute("title"), "Select Property", "receipts: + Property title");
    expect(addProperty.classList.contains("btn-section-add"), "receipts: + Property class");
  }
  if (addDeduction) {
    expect(addDeduction.getAttribute("type"), "button", "receipts: + Deduction type");
    expect(addDeduction.getAttribute("title"), "Add Section", "receipts: + Deduction title");
    expect(addDeduction.classList.contains("btn-section-add"), "receipts: + Deduction class");
  }
  expect(
    writableIndexes(row(receiptsBody, "2001"))?.length === 0,
    "receipts: 2001 must remain held in the no-selected-property capture",
  );
}

const taxDeductions = load(files.taxDeductions);
const taxBody = activeBody(taxDeductions);
expect(taxBody, "tax deductions: active IRIS data body not found");
if (taxBody) {
  const expectedRows = { "999912": [], "64080001": [0, 1] };
  expect(
    JSON.stringify(rowLabels(taxBody)) === JSON.stringify(Object.keys(expectedRows)),
    `tax deductions: row order/codes changed: ${JSON.stringify(rowLabels(taxBody))}`,
  );
  for (const [code, expected] of Object.entries(expectedRows)) {
    const element = row(taxBody, code);
    expect(element, `tax deductions: row ${code} not rendered`);
    if (element)
      expect(
        JSON.stringify(writableIndexes(element)) === JSON.stringify(expected),
        `tax deductions: row ${code} writable indexes were ${JSON.stringify(writableIndexes(element))}, expected ${JSON.stringify(expected)}`,
      );
  }
  const headings = [...taxBody.querySelectorAll(".heading-bar strong")]
    .map((element) => element.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  expect(
    JSON.stringify(headings.slice(-2)) === JSON.stringify(["Taxable Amount", "Tax Deducted"]),
    `tax deductions: amount headers changed: ${JSON.stringify(headings)}`,
  );
}

const selectionPopup = load(files.selectionPopup);
const dialog = selectionPopup.querySelector('mat-dialog-container[role="dialog"]');
const propertyComponent = selectionPopup.querySelector("app-select-property");
expect(dialog, "property selection popup: dialog container not found");
expect(propertyComponent, "property selection popup: app-select-property not found");
if (dialog) {
  expect(dialog.getAttribute("aria-modal") === "true", "property selection popup: aria-modal");
  expect(
    dialog.getAttribute("aria-labelledby") === "mat-mdc-dialog-title-2",
    "property selection popup: labelled-by binding",
  );
}
if (propertyComponent) {
  const title = propertyComponent.querySelector("[mat-dialog-title]");
  const search = propertyComponent.querySelector('input[type="text"][placeholder="Search Property"]');
  const empty = propertyComponent.querySelector(".empty-state");
  const preExisting = propertyComponent.querySelector("#pre-existing-section");
  expect(
    title?.querySelector(".left")?.textContent.replace(/\s+/g, " ").trim() ===
      "Select Property",
    "property selection popup: title",
  );
  expect(search, "property selection popup: Search Property input not found");
  if (search) {
    expect(search.getAttribute("aria-invalid") === "false", "property selection popup: search aria-invalid");
    expect(search.getAttribute("aria-required") === "false", "property selection popup: search aria-required");
  }
  expect(empty, "property selection popup: empty-state not found");
  if (empty) {
    expect(
      empty.querySelector(".title")?.textContent.replace(/\s+/g, " ").trim() ===
        "Can't find properties?",
      "property selection popup: empty title",
    );
    expect(
      empty.querySelector(".description")?.textContent.replace(/\s+/g, " ").trim() ===
        "Please add through Wealth Statement/ balance sheet/ Immoveable properties (For Non-Resident only).",
      "property selection popup: empty guidance",
    );
  }
  expect(preExisting, "property selection popup: pre-existing-section not found");
  expect(
    (preExisting ? preExisting.children.length : 0) === 0,
    "property selection popup: no property records should be rendered",
  );
}

const fileInputs = [...taxDeductions.querySelectorAll('input[type="file"]')];
expect(
  JSON.stringify(fileInputs.map((input) => input.id).sort()) ===
    JSON.stringify(["doc_3000", "doc_3003", "doc_9230"].sort()),
  `property certificate audit: unexpected file inputs ${JSON.stringify(fileInputs.map((input) => input.id))}`,
);
expect(
  !fileInputs.some((input) => /property|rent|certificate/i.test(`${input.id} ${input.name} ${input.getAttribute("formcontrolname") || ""}`)),
  "property certificate audit: a Property-specific certificate input appeared",
);
const angularMetadata = [...taxDeductions.querySelectorAll(
  "[formcontrolname], [ng-reflect-name], [ng-reflect-form-control-name]",
)].map((element) =>
  [
    element.getAttribute("formcontrolname"),
    element.getAttribute("ng-reflect-name"),
    element.getAttribute("ng-reflect-form-control-name"),
  ]
    .filter(Boolean)
    .join(" "),
);
expect(
  angularMetadata.every((value) => !/property|rent|salary\s*certificate|withholding\s*certificate/i.test(value)),
  `property certificate audit: certificate-like Angular metadata appeared: ${JSON.stringify(angularMetadata)}`,
);

if (failures.length) {
  console.error(`Property capture verification failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Property capture verification passed: receipts and tax deductions contracts match the supplied authoritative HTML.");
