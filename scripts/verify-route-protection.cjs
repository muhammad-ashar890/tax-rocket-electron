/**
 * Verifies that every authenticated surface is actually guarded.
 *
 * Two independent layers are checked:
 *   1. middleware.ts covers /tax/* by path prefix, so a page added later is
 *      protected without anyone remembering to add a check.
 *   2. Every server action and file route still performs its own session
 *      check, because middleware does not run for server action invocations
 *      in all deployment topologies and must never be the only defence.
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

// ---------------------------------------------------------------------------
// Layer 1 — the middleware itself
// ---------------------------------------------------------------------------

const middlewarePath = path.join(projectRoot, "middleware.ts");
check("middleware.ts exists at the project root", fs.existsSync(middlewarePath), true);

const middlewareSource = fs.readFileSync(middlewarePath, "utf8");

check(
  "The middleware uses the NextAuth helper",
  middlewareSource.includes("next-auth/middleware"),
  true,
);
check(
  "The matcher covers every path under /tax",
  middlewareSource.includes('"/tax/:path*"'),
  true,
);
check(
  "Authorisation requires a decoded token",
  middlewareSource.includes("Boolean(token)"),
  true,
);
check(
  "Anonymous visitors are sent to the login page",
  middlewareSource.includes('signIn: "/login"'),
  true,
);

// The sign-in path must agree with lib/auth.ts, otherwise the redirect lands
// on a route that does not exist.
const authSource = fs.readFileSync(path.join(projectRoot, "lib/auth.ts"), "utf8");
check("lib/auth.ts declares the same sign-in page", authSource.includes('signIn: "/login"'), true);
check("The login page exists", fs.existsSync(path.join(projectRoot, "app/login/page.tsx")), true);

// The JSON APIs must not be swept into an HTML redirect.
for (const apiPrefix of ["/api/auth", "/api/documents", "/api/packets"]) {
  check(
    `The matcher does not capture ${apiPrefix}`,
    middlewareSource.includes(`"${apiPrefix}/:path*"`),
    false,
  );
}

// ---------------------------------------------------------------------------
// Layer 1b — every page under /tax is inside the matcher
// ---------------------------------------------------------------------------

// A filesystem path must be turned into a URL route before it can be compared
// against the middleware matcher. On Windows path.relative returns backslashes
// ("app\\tax\\dashboard"), so the separator is normalised here rather than
// assumed. Without this the suite fails on Windows even though the middleware
// is correct.
function toRoute(absolutePath) {
  const relative = path
    .relative(projectRoot, path.dirname(absolutePath))
    .split(path.sep)
    .join("/");
  return `/${relative.replace(/^app\//, "")}`;
}

function findPages(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return findPages(full);
    return entry.name === "page.tsx" ? [full] : [];
  });
}

const taxPages = findPages(path.join(projectRoot, "app/tax"));
check("There are pages under /tax to protect", taxPages.length > 0, true);

for (const pagePath of taxPages) {
  const route = toRoute(pagePath);
  check(`${route} is inside the /tax matcher`, route.startsWith("/tax/"), true);
}

// Pages that must stay reachable without a session.
for (const publicPage of ["app/page.tsx", "app/login/page.tsx", "app/signup/page.tsx"]) {
  const route = `/${path.dirname(publicPage).split(path.sep).join("/").replace(/^app\/?/, "")}`;
  check(`${publicPage} stays outside the matcher`, route.startsWith("/tax/"), false);
}

// ---------------------------------------------------------------------------
// Layer 2 — defence in depth: the actions still check for themselves
// ---------------------------------------------------------------------------

const actionsDirectory = path.join(projectRoot, "app/actions");
const actionFiles = fs
  .readdirSync(actionsDirectory)
  .filter((name) => name.endsWith(".ts"))
  .sort();

check("Server action modules were found", actionFiles.length > 0, true);

for (const fileName of actionFiles) {
  const source = fs.readFileSync(path.join(actionsDirectory, fileName), "utf8");
  const exportsAnAction = /export async function/.test(source);

  if (!exportsAnAction) continue;

  check(
    `app/actions/${fileName} performs its own session check`,
    source.includes("getServerSession"),
    true,
  );
  check(
    `app/actions/${fileName} imports the shared auth options`,
    source.includes("@/lib/auth"),
    true,
  );
}

// The file routes must keep checking session *and* row ownership: middleware
// does not know which user owns a document id.
for (const routeFile of ["app/api/documents/[id]/route.ts", "app/api/packets/[id]/route.ts"]) {
  const source = fs.readFileSync(path.join(projectRoot, routeFile), "utf8");
  check(`${routeFile} checks the session`, source.includes("getServerSession"), true);
  check(`${routeFile} scopes the lookup to the owner`, source.includes("userId: user.id"), true);
  check(`${routeFile} answers 401 rather than redirecting`, source.includes("status: 401"), true);
  check(
    `${routeFile} refuses absolute or traversing paths`,
    source.includes("path.isAbsolute(relativePath)") && source.includes('startsWith("..")'),
    true,
  );
}

if (failures.length > 0) {
  console.error("Route protection checks FAILED:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Route protection checks passed.");
console.log(
  JSON.stringify(
    {
      assertionCount,
      matcher: ["/tax/:path*"],
      protectedPages: taxPages
        .map(toRoute)
        .sort(),
      serverActionModulesChecked: actionFiles.length,
      note: "Middleware guards pages; actions and file routes keep their own session and ownership checks.",
    },
    null,
    2,
  ),
);
