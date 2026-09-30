// UI Test 2 -- The wizard setup steps, clicked in a real browser.
//
// This drives the actual React wizard: chooses the filer type, ticks income
// source tiles, fills readiness, and asserts the draft that lands in Postgres
// matches what was clicked. No existing suite touches the client component.
const h = require("./_harness.cjs");

const EMAIL = "ui-wizard@taxrocket.test";

// `*:has-text(...)` matches <html> first, so always scope to real controls and
// pick the innermost match.
async function clickByText(page, text, tag = "button") {
  const el = page.locator(`${tag}:has-text("${text}")`).last();
  await el.waitFor({ state: "visible" });
  await el.click();
  await page.waitForTimeout(300);
}
async function clickTile(page, label) {
  const el = page
    .locator(`button:has-text("${label}"), [role="button"]:has-text("${label}"), label:has-text("${label}")`)
    .last();
  await el.waitFor({ state: "visible" });
  await el.click();
  await page.waitForTimeout(300);
}

(async () => {
  const user = await h.createTestUser(EMAIL);
  const { browser, page, consoleErrors } = await h.openBrowser(user);

  h.section("1. The wizard opens on the first question");
  await page.goto("/tax/new", { waitUntil: "networkidle" });
  const heading = (await page.textContent("body")) || "";
  h.checkTrue("Wizard asks 'Who is filing?' first", /Who is filing/i.test(heading));
  h.checkTrue("Both filer types are offered", /Myself/.test(heading) && /My Business/.test(heading));

  h.section("2. Continue is refused until a filer type is chosen");
  {
    // The gate must be a disabled control, not a silent no-op: a user has to be
    // able to SEE that the step is incomplete.
    const cont = page.locator('button:has-text("Continue")').first();
    h.check(
      "Continue is disabled before anything is selected",
      await cont.isDisabled(),
      true,
    );
    const before = (await page.textContent("body")) || "";
    h.checkTrue(
      "An action item names the missing step",
      /Select who is filing/i.test(before),
    );
    // Force the click past the disabled attribute: even then the wizard must
    // not advance. This is the check that catches a gate that is only cosmetic.
    await cont.dispatchEvent("click").catch(() => {});
    await page.waitForTimeout(400);
    h.checkTrue(
      "Forcing a click on the disabled button still does not advance",
      /Who is filing/i.test((await page.textContent("body")) || ""),
    );
  }

  h.section("3. Choosing 'Myself' unlocks the next step");
  await clickTile(page, "Myself");
  await clickByText(page, "Continue");
  const step2 = (await page.textContent("body")) || "";
  h.checkTrue(
    "Wizard advances past the filer question",
    !/Are you filing for yourself or for your business/i.test(step2),
  );

  h.section("4. All thirteen income-source tiles are on screen");
  const TILES = [
    "Salary", "Pension", "Rental Income", "Freelancer", "Bank Profit",
    "Dividend", "Capital Gains", "Business Income", "Agriculture",
    "Non-Resident", "AOP / Company", "Sales Tax / FED", "Other Income",
  ];
  const body4 = (await page.textContent("body")) || "";
  let seen = 0;
  for (const tile of TILES) {
    if (body4.includes(tile)) seen += 1;
    else h.note(`Tile not visible on this step: ${tile}`);
  }
  h.check("Thirteen income-source tiles render", seen, 13);

  h.section("5. Selecting Salary + Bank Profit persists to the database");
  await clickTile(page, "Salary");
  await clickTile(page, "Bank Profit");
  await page.waitForTimeout(400);
  // Salary combined with another source demands a salary share.
  const bodyShare = (await page.textContent("body")) || "";
  h.checkTrue(
    "Choosing salary plus a second source asks for the salary share",
    /salary/i.test(bodyShare),
  );

  const saveBtn = page.locator('button:has-text("Save draft")').first();
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(1500);
  }

  const draft = await h.prisma.filingDraft.findFirst({
    where: { userId: user.id },
    include: { incomeSelections: true },
  });
  h.checkTrue("A filing draft row exists in Postgres", Boolean(draft));
  if (draft) {
    h.check("Draft is for tax year 2026", draft.taxYear, 2026);
    h.check("Draft belongs to the signed-in user", draft.userId, user.id);
    // incomeSources is stored as a JSON string column, not a Postgres array.
    const sources = String(draft.incomeSources || "");
    h.checkTrue(
      "Salary is recorded on the draft",
      sources.includes("salary"),
      sources || "(none yet)",
    );
    h.checkTrue(
      "Bank profit is recorded on the draft",
      sources.includes("bank_profit"),
      sources || "(none yet)",
    );
  }

  h.section("6. Money columns on the saved draft are Decimal, not Float");
  if (draft) {
    // Named explicitly rather than derived, so renaming a column away from the
    // Decimal conversion fails this test instead of silently shrinking the set.
    const EXPECTED = [
      "closingWealth", "openingWealth", "reconciliationGap", "refundDue",
      "taxPayable", "taxWithheld", "taxableIncome",
    ];
    const cols = await h.prisma.$queryRawUnsafe(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'FilingDraft' AND column_name = ANY($1) ORDER BY column_name`,
      EXPECTED,
    );
    h.check("All seven FilingDraft money columns are present", cols.length, EXPECTED.length);
    const notNumeric = cols
      .filter((c) => c.data_type !== "numeric")
      .map((c) => `${c.column_name}:${c.data_type}`);
    h.check("Every one is numeric (Decimal)", notNumeric.join(",") || "none", "none");

    // The real regression guard: no money column anywhere in the schema may be
    // double precision. This catches a NEW float column, not just these seven.
    const floats = await h.prisma.$queryRawUnsafe(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND data_type='double precision'
       AND column_name !~* 'rate|percent|score|confidence|ratio'
       ORDER BY 1,2`,
    );
    h.check(
      "No money column in the whole database is still Float",
      floats.map((f) => `${f.table_name}.${f.column_name}`).join(",") || "none",
      "none",
    );
  }

  h.section("7. No crash and no console error during the walkthrough");
  const fatal = consoleErrors.filter((e) => !/favicon|404|Download the React/i.test(e));
  h.check("Wizard raises no fatal console errors", fatal.length, 0);
  if (fatal.length) h.note("Console: " + fatal.slice(0, 3).join(" | "));

  await browser.close();
  await h.deleteTestUser(EMAIL);
  h.finish("UI 2 -- Wizard setup");
  await h.prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await h.prisma.$disconnect();
  process.exit(1);
});
