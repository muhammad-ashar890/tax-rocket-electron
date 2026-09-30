/**
 * Locks in the dependency remediation so it cannot silently regress.
 *
 * The three findings this guards:
 *   1. @auth/prisma-adapter was installed but never imported, and was the only
 *      reason a second copy of the auth stack was in the tree.
 *   2. @auth/core reached the tree at 0.34.3 through next-auth. It is an
 *      optional peer used only for TypeScript types, so an override pins it to
 *      a patched release without a breaking next-auth upgrade.
 *   3. The npm `xlsx` package is abandoned at 0.18.5 with an unfixed
 *      prototype-pollution advisory. It is reachable here because bank
 *      statements uploaded by users are parsed with it, so it was replaced by
 *      the maintained @e965/xlsx fork.
 */

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);

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

const dependencies = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
};

// ---------------------------------------------------------------------------
// 1. The unused adapter must stay out
// ---------------------------------------------------------------------------

check(
  "@auth/prisma-adapter is not a declared dependency",
  "@auth/prisma-adapter" in dependencies,
  false,
);

function collectSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectSourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const sourceFiles = ["app", "components", "lib", "scripts"].flatMap((directory) =>
  collectSourceFiles(path.join(projectRoot, directory)),
);

check("Source files were discovered", sourceFiles.length > 0, true);

const sources = sourceFiles.map((file) => ({
  file: path.relative(projectRoot, file),
  text: fs.readFileSync(file, "utf8"),
}));

check(
  "Nothing imports @auth/prisma-adapter",
  sources.some((s) => s.text.includes("@auth/prisma-adapter")),
  false,
);
check(
  "Nothing references PrismaAdapter",
  sources.some((s) => s.text.includes("PrismaAdapter")),
  false,
);

// ---------------------------------------------------------------------------
// 2. The overrides that pin transitive packages to patched releases
// ---------------------------------------------------------------------------

const overrides = packageJson.overrides ?? {};

check("An overrides block exists", Object.keys(overrides).length > 0, true);
check("@auth/core is pinned to a patched release", overrides["@auth/core"], "0.41.3");
check("cookie is pinned above the advisory", overrides["cookie"], "^0.7.2");
check("postcss follows the direct dependency", overrides["postcss"], "$postcss");

// The pin only makes sense while next-auth still treats @auth/core as an
// optional peer. If a future upgrade makes it a hard runtime dependency the
// override becomes a real version constraint and must be re-reviewed.
const nextAuthManifestPath = path.join(
  projectRoot,
  "node_modules/next-auth/package.json",
);

if (fs.existsSync(nextAuthManifestPath)) {
  const nextAuthManifest = JSON.parse(fs.readFileSync(nextAuthManifestPath, "utf8"));
  check(
    "next-auth still declares @auth/core as a peer, not a dependency",
    "@auth/core" in (nextAuthManifest.dependencies ?? {}),
    false,
  );
  check(
    "That peer is still optional",
    nextAuthManifest.peerDependenciesMeta?.["@auth/core"]?.optional,
    true,
  );
}

// The installed tree must reflect the override.
const installedAuthCorePath = path.join(
  projectRoot,
  "node_modules/@auth/core/package.json",
);
if (fs.existsSync(installedAuthCorePath)) {
  const installed = JSON.parse(fs.readFileSync(installedAuthCorePath, "utf8"));
  check("The installed @auth/core is the patched build", installed.version, "0.41.3");
}

// ---------------------------------------------------------------------------
// 3. The spreadsheet parser
// ---------------------------------------------------------------------------

check("The abandoned xlsx package is gone", "xlsx" in dependencies, false);
check(
  "The maintained fork is declared",
  typeof dependencies["@e965/xlsx"] === "string",
  true,
);

// The fork must be past 0.19.3, where the prototype-pollution fix landed.
const forkRange = dependencies["@e965/xlsx"] ?? "";
const forkMajorMinor = forkRange.replace(/^[^0-9]*/, "").split(".").slice(0, 2).join(".");
check("The fork is at least the 0.20 line", Number(forkMajorMinor) >= 0.2, true);

// No source file may import the abandoned package name.
const staleXlsxImports = sources.filter(
  (s) => /from\s+["']xlsx["']|require\(["']xlsx["']\)/.test(s.text),
);
check(
  `No source imports the bare xlsx package (found: ${staleXlsxImports.map((s) => s.file).join(", ") || "none"})`,
  staleXlsxImports.length,
  0,
);

// The parser that reads user-supplied spreadsheets must use the fork.
const bankParserSource = fs.readFileSync(
  path.join(projectRoot, "app/actions/bank-parser.ts"),
  "utf8",
);
check(
  "The bank statement parser uses the maintained fork",
  bankParserSource.includes('from "@e965/xlsx"'),
  true,
);
check(
  "The reason for the swap is recorded in the source",
  bankParserSource.includes("CVE-2023-30533"),
  true,
);

// ---------------------------------------------------------------------------
// 4. Framework version floors
// ---------------------------------------------------------------------------

function minimumVersion(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(range, major, minor, patch) {
  const version = minimumVersion(range);
  if (!version) return false;
  const [a, b, c] = version;
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

// Next.js stays on the 14 line deliberately: the remaining advisory is only
// resolved by Next 16, which is a breaking upgrade and needs its own change.
// The floor below keeps the 14 line at its latest patch.
check("Next.js is at or above 14.2.35", atLeast(dependencies.next, 14, 2, 35), true);
check("next-auth is at or above 4.24.14", atLeast(dependencies["next-auth"], 4, 24, 14), true);

if (failures.length > 0) {
  console.error("Dependency health checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Dependency health checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      removed: ["@auth/prisma-adapter (unused)", "xlsx (abandoned, unfixed advisory)"],
      added: ["@e965/xlsx (maintained SheetJS fork)"],
      overrides,
      remaining: {
        next: "1 high advisory, resolved only by Next 16 (breaking) - tracked separately",
      },
    },
    null,
    2,
  ),
);
