// Shared browser harness for the UI walkthrough tests.
//
// Google OAuth cannot complete inside this sandbox: the client ID's registered
// redirect URI is http://localhost:3000/..., and a headless browser cannot pass
// Google's interactive consent screen anyway. So the sign-in *transport* is
// verified separately (verify-auth-login.cjs) and every page test starts from a
// real NextAuth session cookie minted with the app's own encoder and secret --
// the identical token Google would have produced. Everything after the redirect
// back from Google is therefore exercised for real.
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..", "..");
const BASE = process.env.UI_BASE_URL || "http://localhost:3000";
const PREVIEW_HOST =
  process.env.UI_PREVIEW_HOST || "3000-ij7d7yrshnpnlx8r8y9yy.e2b.app";

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const { PrismaClient } = require(path.join(ROOT, "node_modules/@prisma/client"));
const { encode } = require(path.join(ROOT, "node_modules/next-auth/jwt"));
const { chromium } = require(path.join(ROOT, "node_modules/playwright"));

const prisma = new PrismaClient();

let passed = 0;
const failures = [];
const notes = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}\n          expected: ${expected}\n          actual:   ${actual}`);
    console.log(`  FAIL  ${label}  (expected ${expected}, got ${actual})`);
  }
  return ok;
}

function checkTrue(label, condition, detail = "") {
  return check(label + (detail ? ` (${detail})` : ""), Boolean(condition), true);
}

function note(text) {
  notes.push(text);
  console.log(`  NOTE  ${text}`);
}

function section(title) {
  console.log(`\n${title}`);
}

async function createTestUser(email, extra = {}) {
  await prisma.user.deleteMany({ where: { email } });
  return prisma.user.create({ data: { email, name: "UI Test", ...extra } });
}

async function deleteTestUser(email) {
  await prisma.user.deleteMany({ where: { email } });
}

async function sessionCookie(user) {
  const token = await encode({
    token: { name: user.name, email: user.email, sub: user.id, id: user.id },
    secret: process.env.NEXTAUTH_SECRET,
  });
  // NEXTAUTH_URL is http on localhost, so NextAuth reads the unprefixed cookie.
  return {
    name: "next-auth.session-token",
    value: token,
    domain: new URL(BASE).hostname,
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  };
}

async function openBrowser(user) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 1000 },
  });
  if (user) await context.addCookies([await sessionCookie(user)]);
  // Next.js dev compiles each route on first request; that can exceed the
  // 30s default on a cold page. Production `next start` is far faster, but the
  // walkthrough must not fail for a reason that is not a defect.
  context.setDefaultNavigationTimeout(120_000);
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  return { browser, context, page, consoleErrors };
}

function finish(suiteName) {
  console.log(`\n${"-".repeat(60)}`);
  if (failures.length) {
    console.log(`${suiteName}: ${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log(`  FAIL  ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`${suiteName}: ${passed} assertions passed`);
  }
  if (notes.length) {
    console.log("\nNotes:");
    for (const n of notes) console.log(`  - ${n}`);
  }
}

module.exports = {
  ROOT,
  BASE,
  PREVIEW_HOST,
  prisma,
  check,
  checkTrue,
  note,
  section,
  finish,
  openBrowser,
  sessionCookie,
  createTestUser,
  deleteTestUser,
  counters: () => ({ passed, failures: failures.length }),
};
