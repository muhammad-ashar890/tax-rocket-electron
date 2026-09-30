const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

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

try {
  const validatorPath = path.join(
    __dirname,
    "..",
    "lib",
    "tax",
    "rules",
    "ty2026",
    "validate-catalog.ts",
  );
  const { validateTy2026RateCardCatalog } = require(validatorPath);
  const result = validateTy2026RateCardCatalog();

  if (!result.valid) {
    console.error("TY2026 rate-card catalog validation failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    const testsPath = path.join(
      __dirname,
      "..",
      "lib",
      "tax",
      "rules",
      "ty2026",
      "catalog-tests.ts",
    );
    const { runTy2026RateCardCatalogTests } = require(testsPath);
    const testResult = runTy2026RateCardCatalogTests();

    console.log("TY2026 rate-card catalog is valid.");
    console.log(JSON.stringify({ ...result.summary, ...testResult }, null, 2));
  }
} finally {
  if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
  else delete Module._extensions[".ts"];
}
