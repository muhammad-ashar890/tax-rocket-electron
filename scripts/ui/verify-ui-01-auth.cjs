// UI Test 1 -- Authentication and route protection, in a real browser.
//
// What this proves that no existing suite proves: verify-route-protection.cjs
// reads middleware.ts as source text. This one drives Chromium against the
// running server and asserts a signed-out browser is actually bounced off
// every /tax page, and a signed-in one is actually let through.
const h = require("./_harness.cjs");

const EMAIL = "ui-auth@taxrocket.test";
const PROTECTED = [
  "/tax/dashboard",
  "/tax/new",
  "/tax/history",
  "/tax/profile",
  "/tax/settings",
  "/tax/fbr-connect",
];

(async () => {
  h.section("1. Signed-OUT browser is bounced off every protected page");
  {
    const { browser, page } = await h.openBrowser(null);
    for (const route of PROTECTED) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      const landed = new URL(page.url()).pathname;
      h.check(`${route} redirects a signed-out visitor to /login`, landed, "/login");
    }
    await page.goto("/", { waitUntil: "domcontentloaded" });
    h.check(
      "/ redirects a signed-out visitor to /login",
      new URL(page.url()).pathname,
      "/login",
    );
    await browser.close();
  }

  h.section("2. The login page renders and offers Google sign-in");
  {
    const { browser, page, consoleErrors } = await h.openBrowser(null);
    await page.goto("/login", { waitUntil: "networkidle" });
    h.check("Login page loads", new URL(page.url()).pathname, "/login");
    const body = await page.textContent("body");
    h.checkTrue("Login page mentions Google", /google/i.test(body));
    const buttons = await page.locator("button, a").count();
    h.checkTrue("Login page renders clickable controls", buttons > 0, `${buttons} found`);
    h.check("Login page raises no console errors", consoleErrors.length, 0);
    await browser.close();
  }

  h.section("3. Google provider is wired");
  {
    const { browser, page } = await h.openBrowser(null);
    const res = await page.request.get("/api/auth/providers");
    h.check("/api/auth/providers responds 200", res.status(), 200);
    const providers = await res.json();
    h.checkTrue("Google provider is registered", Boolean(providers.google));
    h.check("Provider type is oauth", providers.google?.type, "oauth");
    h.check(
      "The sign-in callback path is the one Google must have registered",
      new URL(providers.google.callbackUrl).pathname,
      "/api/auth/callback/google",
    );

    // The live credential probe only runs when a client ID is actually
    // configured. Skipping must be explicit: an earlier version of this test
    // sent an EMPTY client_id to Google and still recorded a pass, which is
    // exactly the kind of hollow green tick that hides a broken login.
    const cid = process.env.GOOGLE_CLIENT_ID || "";
    if (cid.length < 20) {
      h.note(
        "GOOGLE_CLIENT_ID is empty, so the live Google credential probe was " +
          "SKIPPED (not passed). Run `npm run check:oauth <url>` with the real " +
          "credential to verify the deployed callback is registered.",
      );
    } else {
      const redirect = `${new URL(providers.google.callbackUrl).origin}/api/auth/callback/google`;
      const probe = await page.request.get(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=" +
          encodeURIComponent(cid) +
          "&redirect_uri=" +
          encodeURIComponent(redirect) +
          "&response_type=code&scope=openid%20email%20profile&state=probe",
        { maxRedirects: 5 },
      );
      const seen = probe.url() + (await probe.text());
      h.checkTrue(
        "Google accepts the client ID as a real credential",
        !/invalid_client|deleted_client/i.test(seen),
      );
      if (/redirect_uri_mismatch/.test(probe.url())) {
        h.note(
          `Google returns redirect_uri_mismatch for ${redirect}. The credential ` +
            "is valid but this URL is not registered. Add it in Google Cloud " +
            "Console before go-live, then confirm with `npm run check:oauth`.",
        );
      }
    }
    await browser.close();
  }

  h.section("4. A signed-IN browser reaches every protected page");
  {
    const user = await h.createTestUser(EMAIL);
    const { browser, page, consoleErrors } = await h.openBrowser(user);
    for (const route of PROTECTED) {
      const res = await page.goto(route, { waitUntil: "domcontentloaded" });
      h.check(`${route} loads for a signed-in user`, res.status(), 200);
      h.check(`${route} stays on its own URL`, new URL(page.url()).pathname, route);
      const text = await page.textContent("body");
      h.checkTrue(
        `${route} renders no crash screen`,
        !/Application error|Internal Server Error|Unhandled Runtime/i.test(text),
      );
    }
    const session = await (await page.request.get("/api/auth/session")).json();
    h.check("Session reports the signed-in email", session?.user?.email, EMAIL);
    h.check("Session carries the database user id", session?.user?.id, user.id);
    const fatal = consoleErrors.filter((e) => !/favicon|404/i.test(e));
    h.check("No fatal console errors across all six pages", fatal.length, 0);
    if (fatal.length) h.note("Console: " + fatal.slice(0, 3).join(" | "));
    await browser.close();
    await h.deleteTestUser(EMAIL);
  }

  h.section("5. A tampered session cookie is rejected");
  {
    const user = await h.createTestUser(EMAIL);
    const { browser, context, page } = await h.openBrowser(user);
    const cookies = await context.cookies();
    const real = cookies.find((c) => c.name.includes("session-token"));
    await context.clearCookies();
    await context.addCookies([
      { ...real, value: real.value.slice(0, -6) + "AAAAAA" },
    ]);
    await page.goto("/tax/dashboard", { waitUntil: "domcontentloaded" });
    h.check(
      "A forged session token cannot reach the dashboard",
      new URL(page.url()).pathname,
      "/login",
    );
    await browser.close();
    await h.deleteTestUser(EMAIL);
  }

  h.finish("UI 1 -- Authentication");
  await h.prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await h.prisma.$disconnect();
  process.exit(1);
});
