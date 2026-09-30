/**
 * Phase 2 — verifies the housekeeping fixes stay fixed.
 *
 * Every check here guards a defect that was found by reading the code, so the
 * assertions deliberately inspect structure (ordering, guards, argument lists)
 * rather than only checking that a string appears somewhere in the file. A
 * substring match alone is not evidence that a call actually runs.
 */

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");

const failures = [];
let assertionCount = 0;

function check(label, actual, expected) {
  assertionCount += 1;
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function listSourceFiles(dir, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, collected);
    } else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) {
      collected.push(full);
    }
  }
  return collected;
}

const sourceFiles = listSourceFiles(projectRoot);

// ---------------------------------------------------------------------------
// 1 — dead demo modules are gone and nothing reaches for them
// ---------------------------------------------------------------------------

for (const deadFile of ["lib/demo-store.ts", "lib/demo-auth.ts"]) {
  check(
    `${deadFile} has been deleted`,
    fs.existsSync(path.join(projectRoot, deadFile)),
    false,
  );
}

const importsDemoModules = sourceFiles.filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return /(from|require\()\s*["'][^"']*demo-(store|auth)["']/.test(source);
});
check(
  "No module imports the deleted demo helpers",
  importsDemoModules.map((f) => path.relative(projectRoot, f)).join(", "),
  "",
);

// ---------------------------------------------------------------------------
// 2 — draft deletion removes files that live in a subdirectory
//
// The bug: fileUrl values look like "packets/<id>.pdf" or "profile/<id>.png",
// but the unlink used path.basename(fileUrl), which dropped the directory and
// tried to delete uploads/<id>.pdf. That file never exists, the catch swallowed
// the error, and every packet PDF survived deletion of its draft forever.
// ---------------------------------------------------------------------------

const filingSource = read("app/actions/filing.ts");
const deleteDraftStart = filingSource.indexOf("export async function deleteFilingDraft");
check("deleteFilingDraft exists", deleteDraftStart >= 0, true);

const deleteDraftBody = filingSource.slice(
  deleteDraftStart,
  filingSource.indexOf("export async function", deleteDraftStart + 10),
);

check(
  "deleteFilingDraft no longer flattens the stored path with path.basename",
  /path\.basename/.test(deleteDraftBody),
  false,
);
check(
  "deleteFilingDraft normalises the stored relative path",
  /path\.normalize\(\s*fileUrl\s*\)/.test(deleteDraftBody),
  true,
);
check(
  "deleteFilingDraft refuses absolute paths",
  /path\.isAbsolute\(\s*relativePath\s*\)/.test(deleteDraftBody),
  true,
);
check(
  "deleteFilingDraft refuses paths escaping the uploads root",
  /relativePath\.startsWith\(\s*"\.\."\s*\)/.test(deleteDraftBody),
  true,
);
check(
  "The traversal guard returns before unlinking",
  deleteDraftBody.indexOf("isAbsolute") < deleteDraftBody.indexOf("unlink("),
  true,
);
check(
  "The unlink joins the uploads root to the normalised path",
  /unlink\(\s*\n?\s*path\.join\(process\.cwd\(\),\s*"uploads",\s*relativePath,?\s*\)/.test(
    deleteDraftBody,
  ),
  true,
);
check(
  "Packet PDFs are included in the deletion list, not just documents",
  /filingPackets\.map\(\(packet\) => packet\.fileUrl\)/.test(deleteDraftBody),
  true,
);
check(
  "Files are removed after the database row, so a failed delete leaves them intact",
  deleteDraftBody.indexOf("filingDraft.delete") < deleteDraftBody.indexOf("unlink("),
  true,
);

// ---------------------------------------------------------------------------
// 3 — Gemini transaction classification is rate limited and batch capped
// ---------------------------------------------------------------------------

const classificationSource = read("app/actions/bank-classification.ts");

check(
  "bank-classification imports the shared rate limiter",
  /import\s*\{[^}]*consumeRateLimit[^}]*\}\s*from\s*"@\/lib\/rate-limit"/.test(
    classificationSource,
  ),
  true,
);

const geminiFnStart = classificationSource.indexOf(
  "async function classifyAmbiguousTransactionsWithGemini",
);
check("The Gemini orchestrator exists", geminiFnStart >= 0, true);

const geminiFnBody = classificationSource.slice(geminiFnStart);

check(
  "The orchestrator takes the userId it needs to key the budget",
  /userId:\s*string,/.test(geminiFnBody),
  true,
);

// --- the whole statement is classified, not just the first chunk ------------
//
// The defect being guarded: an earlier version did
// `transactions.slice(0, LIMIT)` and sent only that. A full tax year of
// activity would have been silently truncated, so most of the statement would
// never reach the model at all.

check(
  "The orchestrator does not truncate the transaction list",
  /transactions\.slice\(\s*0\s*,/.test(geminiFnBody),
  false,
);
check(
  "Chunks are cut with a moving offset that walks the whole list",
  /transactions\.slice\(\s*\n?\s*index,\s*index \+ GEMINI_CLASSIFICATION_CHUNK_SIZE,?\s*\n?\s*\)/.test(
    geminiFnBody,
  ),
  true,
);
check(
  "The chunk loop advances until the end of the list",
  /index < transactions\.length;\s*\n?\s*index \+= GEMINI_CLASSIFICATION_CHUNK_SIZE/.test(
    geminiFnBody,
  ),
  true,
);
check(
  "Results from every chunk are merged into one map",
  /merged\.set\(id, classification\)/.test(geminiFnBody),
  true,
);
// The accumulator must be created once, outside the loop, and never reset —
// otherwise only the final chunk survives and the earlier ones are silently
// discarded, which looks identical to truncation from the caller's side.
check(
  "The accumulator is declared before the chunk loop",
  geminiFnBody.indexOf("const merged = new Map") <
    geminiFnBody.indexOf("for ("),
  true,
);
check(
  "The accumulator is never reset between chunks",
  /merged\.(clear|delete)\(/.test(geminiFnBody),
  false,
);
check(
  "The accumulator is only ever reassigned by set()",
  (geminiFnBody.match(/\bmerged\s*=/g) ?? []).length,
  1,
);
check(
  "Chunks are sent concurrently",
  /Promise\.all\(\s*\n?\s*affordable\.map\(/.test(geminiFnBody),
  true,
);

const chunkSizeMatch = classificationSource.match(
  /const GEMINI_CLASSIFICATION_CHUNK_SIZE = (\d+);/,
);
check("A chunk size is declared", Boolean(chunkSizeMatch), true);
check("The chunk size is 100 rows", chunkSizeMatch ? Number(chunkSizeMatch[1]) : null, 100);

const concurrencyMatch = classificationSource.match(
  /const GEMINI_CLASSIFICATION_CONCURRENCY = (\d+);/,
);
check("A concurrency limit is declared", Boolean(concurrencyMatch), true);
check(
  "Concurrency stays modest so a large statement does not open hundreds of connections",
  concurrencyMatch ? Number(concurrencyMatch[1]) >= 1 && Number(concurrencyMatch[1]) <= 8 : false,
  true,
);

// --- the budget is generous enough for real use ----------------------------
//
// A budget that blocks an ordinary taxpayer mid-statement is a bug, not a
// safeguard. One chunk is 100 rows, so the budget is asserted in ROWS.

const budgetMatch = classificationSource.match(
  /const GEMINI_CLASSIFICATION_CHUNK_BUDGET = (\d+);/,
);
check("A per-user chunk budget is declared", Boolean(budgetMatch), true);

const chunkBudget = budgetMatch ? Number(budgetMatch[1]) : 0;
const chunkSize = chunkSizeMatch ? Number(chunkSizeMatch[1]) : 0;
const rowsPerWindow = chunkBudget * chunkSize;

check(
  "The budget covers at least a full year of ambiguous rows (>= 5000)",
  rowsPerWindow >= 5000,
  true,
);
check(
  "The budget is still bounded, so a runaway loop cannot bill indefinitely",
  chunkBudget < 100000,
  true,
);

check(
  "The budget is charged per chunk, so cost tracks real model usage",
  /consumeRateLimit\(\s*\n?\s*`gemini-classification:\$\{userId\}`,\s*\n?\s*GEMINI_CLASSIFICATION_CHUNK_BUDGET,\s*\n?\s*GEMINI_CLASSIFICATION_WINDOW_MS,?\s*\n?\s*\)/.test(
    geminiFnBody,
  ),
  true,
);
check(
  "The budget is consumed inside the chunk loop, not once per invocation",
  geminiFnBody.indexOf("for (") < geminiFnBody.indexOf("consumeRateLimit("),
  true,
);
check(
  "Exhausting the budget returns what was classified rather than throwing",
  /if \(affordable\.length === 0\) \{[\s\S]{0,400}?break;/.test(geminiFnBody),
  true,
);
check(
  "Running out of budget is logged so it is diagnosable",
  /console\.warn\([\s\S]{0,200}?budget exhausted/.test(geminiFnBody),
  true,
);

// --- per-chunk request ------------------------------------------------------

const chunkFnStart = classificationSource.indexOf(
  "async function classifyChunkWithGemini",
);
check("The per-chunk request helper exists", chunkFnStart >= 0, true);

const chunkFnBody = classificationSource.slice(chunkFnStart, geminiFnStart);

const promptStart = chunkFnBody.indexOf("const prompt");
const promptEnd = chunkFnBody.indexOf("generateContent");
const promptBody = chunkFnBody.slice(promptStart, promptEnd);
check("The prompt body was located", promptStart >= 0 && promptEnd > promptStart, true);
check("The prompt serialises the chunk it was given", /batch\.map\(/.test(promptBody), true);
// Prose in the prompt legitimately contains the word "transactions", so this
// looks for the identifier being *used* — serialised, mapped or indexed.
check(
  "The chunk helper cannot reach the full transaction list",
  /\btransactions\s*[.[)]/.test(chunkFnBody) ||
    /JSON\.stringify\(\s*\n?\s*transactions\b/.test(chunkFnBody),
  false,
);
check(
  "A failed chunk degrades to rule-based instead of losing the whole run",
  /catch \(error\) \{[\s\S]{0,300}?return new Map<string, GeminiClassification>\(\);/.test(
    chunkFnBody,
  ),
  true,
);

// Call site
const callSiteMatch = classificationSource.match(
  /await classifyAmbiguousTransactionsWithGemini\(([\s\S]{0,220}?)\);/,
);
check("The classifier is called", Boolean(callSiteMatch), true);
check(
  "The call site forwards the owning user id",
  callSiteMatch ? /userId|draft\.userId|session\.user\.id/.test(callSiteMatch[1]) : false,
  true,
);

// ---------------------------------------------------------------------------
// 4 — documented Gemini model matches the code default
// ---------------------------------------------------------------------------

const codeDefaults = new Set();
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  const matches = source.matchAll(/process\.env\.GEMINI_MODEL \|\| "([^"]+)"/g);
  for (const match of matches) codeDefaults.add(match[1]);
}
check("Every GEMINI_MODEL fallback agrees", codeDefaults.size, 1);

const codeDefaultModel = [...codeDefaults][0];
const readme = read("README.md");
const readmeModelMatch = readme.match(/GEMINI_MODEL="([^"]+)"/);
check("README documents GEMINI_MODEL", Boolean(readmeModelMatch), true);
check(
  "README documents the model the code actually falls back to",
  readmeModelMatch ? readmeModelMatch[1] : null,
  codeDefaultModel ?? null,
);

// ---------------------------------------------------------------------------
// 5 — lint is runnable non-interactively
//
// Without a config file `next lint` drops into an interactive setup prompt and
// therefore cannot run in CI at all.
// ---------------------------------------------------------------------------

const eslintConfigPath = path.join(projectRoot, ".eslintrc.json");
check("An ESLint config is committed", fs.existsSync(eslintConfigPath), true);

const eslintConfig = JSON.parse(fs.readFileSync(eslintConfigPath, "utf8"));
check(
  "The config extends the Next.js preset",
  Array.isArray(eslintConfig.extends) &&
    eslintConfig.extends.includes("next/core-web-vitals"),
  true,
);

const packageJson = JSON.parse(read("package.json"));
const devDeps = packageJson.devDependencies ?? {};
check("eslint is a devDependency", Boolean(devDeps.eslint), true);
check("eslint-config-next is a devDependency", Boolean(devDeps["eslint-config-next"]), true);
check("A lint script is defined", packageJson.scripts?.lint, "next lint");
check(
  "This suite is wired into verify:all",
  (packageJson.scripts?.["verify:all"] ?? "").includes("verify:cleanup-hygiene"),
  true,
);

if (failures.length > 0) {
  console.error("Cleanup hygiene checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Cleanup hygiene checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      deletedDeadModules: ["lib/demo-store.ts", "lib/demo-auth.ts"],
      geminiClassification: {
        chunkSize,
        concurrency: concurrencyMatch ? Number(concurrencyMatch[1]) : null,
        chunkBudgetPer10Min: chunkBudget,
        rowsCoveredPer10Min: rowsPerWindow,
        note: "Every ambiguous row is classified; chunking is a prompt-size limit, not a cap on coverage.",
        onExceeded: "remaining rows keep the rule-based result",
      },
      geminiModelDefault: codeDefaultModel,
      note: "Draft deletion now removes files stored under a subdirectory, so packet PDFs no longer accumulate.",
    },
    null,
    2,
  ),
);
