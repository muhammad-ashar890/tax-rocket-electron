/**
 * Shared helpers for the verify-sales-tax-*.cjs suites.
 *
 * - Compiles TypeScript on require, the same way the other verify scripts do.
 * - Builds synthetic invoice rows. Every figure used in a test is written by
 *   hand in the test itself; the helpers never calculate tax.
 *
 * All data made here is synthetic. It proves the code only and is never
 * evidence for a real return.
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const Module = require("module");

const projectRoot = path.join(__dirname, "..", "..");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(projectRoot, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

function load(relative) {
  return require(path.join(projectRoot, relative));
}

/** Rupees to paisa for hand-written expectations. */
function R(rupees) {
  return Math.round(rupees * 100);
}

let invoiceCounter = 0;

/** A valid standard-rate sales row. Overrides replace any field. */
function sale(valueRupees, taxRupees, overrides = {}) {
  invoiceCounter += 1;
  return {
    sourceRow: 5 + invoiceCounter,
    buyerRegistrationNo: "1234567890123",
    buyerName: `Buyer ${invoiceCounter}`,
    buyerType: "Registered",
    originProvince: "SINDH",
    destinationProvince: "SINDH",
    documentType: "Sale Invoice",
    documentNo: `INV-${invoiceCounter}`,
    documentDate: "2026-08-10",
    saleType: "Goods at standard rate (default)",
    rate: 0.18,
    valueExclTax: R(valueRupees),
    salesTax: R(taxRupees),
    fixedOrRetailValue: null,
    extraTax: null,
    furtherTax: null,
    totalValuePfad: null,
    stWithheldAtSource: null,
    exemptionSroNo: "",
    exemptionItemSrNo: "",
    invoiceRefNo: "",
    reason: "",
    petroleumLevyRate: "",
    additionalSalesTaxRate: "",
    unreadableFields: [],
    ...overrides,
  };
}

/** A valid standard-rate purchase row from a registered supplier. */
function purchase(valueRupees, taxRupees, overrides = {}) {
  invoiceCounter += 1;
  return {
    sourceRow: 5 + invoiceCounter,
    sellerRegistrationNo: "9876543210987",
    sellerName: `Supplier ${invoiceCounter}`,
    sellerType: "Registered",
    originProvince: "SINDH",
    destinationProvince: "SINDH",
    documentType: "Purchase Invoice",
    documentNo: `PUR-${invoiceCounter}`,
    documentDate: "2026-08-05",
    purchaseType: "Goods at standard rate (default)",
    rate: 0.18,
    valueExclTax: R(valueRupees),
    salesTax: R(taxRupees),
    fixedRetailValue: null,
    extraTax: null,
    fedCharged: null,
    stWithheldAsWhAgent: null,
    exemptionSroNo: "",
    exemptionItemSrNo: "",
    invoiceRefNo: "",
    reason: "",
    unreadableFields: [],
    ...overrides,
  };
}

const PERIOD = { year: 2026, month: 8 };

/** Counts assertions and prints a summary; exits 1 when any check failed. */
function createChecker(suiteName) {
  const failures = [];
  let count = 0;
  function check(label, actual, expected) {
    count += 1;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${label}: expected ${e}, received ${a}`);
  }
  function finish() {
    if (failures.length > 0) {
      console.error(`${suiteName}: ${failures.length} of ${count} checks FAILED`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(`${suiteName}: ${count} checks passed`);
  }
  return { check, finish };
}

module.exports = { load, R, sale, purchase, PERIOD, projectRoot, createChecker };
