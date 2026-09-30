#!/usr/bin/env node
//
// Checks whether a redirect URI is actually registered on the Google OAuth
// client, WITHOUT needing anyone to log in and without the client secret.
//
// Why this exists: the app's Google credential only has
// http://localhost:3000/api/auth/callback/google registered. On the deployed
// domain, sign-in fails with redirect_uri_mismatch and nobody can log in.
// Someone with Google Cloud Console access must add the production callback.
// This script tells you, in one command, whether that has been done -- so the
// fix is verified rather than assumed.
//
// It only uses the CLIENT ID, which is a public value. It never needs and
// never reads GOOGLE_CLIENT_SECRET.
//
// Usage:
//   node scripts/check-oauth-callback.cjs https://your-domain.com
//   node scripts/check-oauth-callback.cjs            (reads NEXTAUTH_URL from .env)

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const clientId = process.env.GOOGLE_CLIENT_ID || "";
const baseUrl = (process.argv[2] || process.env.NEXTAUTH_URL || "").replace(/\/+$/, "");

if (!clientId) {
  console.error("GOOGLE_CLIENT_ID is empty. Set it in .env, then run this again.");
  process.exit(2);
}
if (!baseUrl) {
  console.error("No URL given. Pass one, e.g.:");
  console.error("  node scripts/check-oauth-callback.cjs https://your-domain.com");
  process.exit(2);
}

const redirectUri = `${baseUrl}/api/auth/callback/google`;

async function probe(uri) {
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(uri)}` +
    "&response_type=code&scope=openid%20email%20profile&state=probe";

  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    return { verdict: "NETWORK", detail: String(err.message || err) };
  }

  // Google reports the problem by redirecting to its own error page and
  // packing a base64 protobuf into the authError query parameter.
  const finalUrl = res.url || "";
  if (!/authError/.test(finalUrl)) {
    return { verdict: "REGISTERED", detail: "Google accepted this redirect URI" };
  }

  let decoded = "";
  try {
    const b64 = new URL(finalUrl).searchParams.get("authError") || "";
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    decoded = finalUrl;
  }

  if (/redirect_uri_mismatch/.test(decoded)) {
    return { verdict: "NOT_REGISTERED", detail: "redirect_uri_mismatch" };
  }
  if (/deleted_client/.test(decoded)) {
    return { verdict: "BAD_CLIENT", detail: "The OAuth client has been deleted" };
  }
  if (/invalid_client/.test(decoded)) {
    return { verdict: "BAD_CLIENT", detail: "Google does not recognise this client ID" };
  }
  if (/admin_policy_enforced|org_internal/.test(decoded)) {
    return {
      verdict: "RESTRICTED",
      detail: "The client is limited to one Google Workspace organisation",
    };
  }
  return { verdict: "OTHER", detail: decoded.slice(0, 300) };
}

(async () => {
  console.log("");
  console.log(`Client ID : ${clientId.slice(0, 24)}...`);
  console.log(`Checking  : ${redirectUri}`);
  console.log("");

  const result = await probe(redirectUri);

  switch (result.verdict) {
    case "REGISTERED":
      console.log("  RESULT: REGISTERED");
      console.log("");
      console.log("  Sign-in will work on this URL.");
      console.log("");
      console.log("  Still confirm on the server itself:");
      console.log(`    NEXTAUTH_URL must be exactly ${baseUrl}`);
      console.log("    NEXTAUTH_SECRET must be a strong value, not the local dev one.");
      process.exit(0);

    case "NOT_REGISTERED":
      console.log("  RESULT: NOT REGISTERED  -- sign-in WILL FAIL on this URL");
      console.log("");
      console.log("  Someone with Google Cloud Console access must add it:");
      console.log("");
      console.log("    1. https://console.cloud.google.com/apis/credentials");
      console.log("    2. Open the OAuth 2.0 Client ID shown above");
      console.log("    3. Under 'Authorised redirect URIs' click ADD URI and paste");
      console.log("       EXACTLY this, with no trailing slash:");
      console.log("");
      console.log(`         ${redirectUri}`);
      console.log("");
      console.log("    4. Under 'Authorised JavaScript origins' add:");
      console.log("");
      console.log(`         ${baseUrl}`);
      console.log("");
      console.log("    5. Save, wait about a minute, then run this command again.");
      process.exit(1);

    case "BAD_CLIENT":
      console.log(`  RESULT: BAD CLIENT ID  -- ${result.detail}`);
      console.log("");
      console.log("  GOOGLE_CLIENT_ID is wrong, or the credential was deleted or");
      console.log("  regenerated. Copy the current client ID from Google Cloud Console.");
      process.exit(1);

    case "RESTRICTED":
      console.log(`  RESULT: RESTRICTED  -- ${result.detail}`);
      console.log("");
      console.log("  Only users inside that Workspace organisation can sign in.");
      console.log("  Set the OAuth consent screen to External if the public must log in.");
      process.exit(1);

    case "NETWORK":
      console.log(`  RESULT: COULD NOT REACH GOOGLE  -- ${result.detail}`);
      console.log("  This machine has no internet access to accounts.google.com.");
      process.exit(2);

    default:
      console.log(`  RESULT: UNEXPECTED  -- ${result.detail}`);
      process.exit(1);
  }
})();
