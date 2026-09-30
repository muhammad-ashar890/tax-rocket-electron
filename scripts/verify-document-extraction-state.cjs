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
  DOCUMENT_EXTRACTION_LEASE_MS,
  isDocumentExtractionLeaseStale,
} = require(path.join(root, "lib/tax/document-extraction-state.ts"));

const now = Date.now();
assert.equal(isDocumentExtractionLeaseStale("PENDING", null, now), false);
assert.equal(
  isDocumentExtractionLeaseStale("PROCESSING", new Date(now - 1000), now),
  false,
  "a live extraction lease blocks a duplicate request",
);
assert.equal(
  isDocumentExtractionLeaseStale(
    "PROCESSING",
    new Date(now - DOCUMENT_EXTRACTION_LEASE_MS - 1),
    now,
  ),
  true,
  "an abandoned extraction lease becomes retryable",
);
assert.equal(
  isDocumentExtractionLeaseStale("PROCESSING", null, now),
  true,
  "legacy PROCESSING rows without a lease can recover",
);
assert.equal(
  isDocumentExtractionLeaseStale("COMPLETED", new Date(now - 99999999), now),
  false,
);

const geminiAction = fs.readFileSync(
  path.join(root, "app/actions/extraction.ts"),
  "utf8",
);
const structuredAction = fs.readFileSync(
  path.join(root, "app/actions/bank-parser.ts"),
  "utf8",
);
const documentHook = fs.readFileSync(
  path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"),
  "utf8",
);
const documentsStep = fs.readFileSync(
  path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
  "utf8",
);

for (const [name, source] of [
  ["Gemini extraction", geminiAction],
  ["structured bank parsing", structuredAction],
]) {
  assert.match(source, /extractionStartedAt: attemptStartedAt/);
  assert.match(source, /code: "ALREADY_PROCESSING"/);
  assert.match(source, /extractionStatus: "PROCESSING"/);
  assert.match(source, /extractionStartedAt: null/);
  assert.ok(source.includes("updateMany"), `${name} uses conditional ownership writes`);
}
assert.match(documentHook, /getDocumentExtractionAction\(record\.id\)/);
assert.ok(documentHook.includes('["COMPLETED", "MAPPED", "FAILED"]'));
assert.match(documentHook, /recoveringDocumentIds/);
assert.match(documentsStep, /"Retry extraction"/);

console.log("Document extraction lease and recovery checks passed.");
