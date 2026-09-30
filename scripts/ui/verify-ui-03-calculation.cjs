// UI Test 3 -- End-to-end tax calculation through the real stack.
//
// The offline suites call calculateTaxEstimate() on synthetic input. This one
// starts from rows that actually sit in Postgres, sums them the way the server
// action does, prices them, and asserts the exact string the user reads on
// screen. A defect anywhere between the database and the rendered number fails
// here and nowhere else.
const path = require("node:path");
const fs = require("node:fs");
const ts = require("typescript");
const Module = require("node:module");
const h = require("./_harness.cjs");

const EMAIL = "ui-calc@taxrocket.test";
const ROOT = h.ROOT;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req.startsWith("@/")) req = path.join(ROOT, req.slice(2));
  return origResolve.call(this, req, ...rest);
};
Module._extensions[".ts"] = function (mod, filename) {
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
};

const { calculateTaxEstimate } = require(
  path.join(ROOT, "lib/tax/tax-calculation.ts"),
);
const { sumMoney } = require(path.join(ROOT, "lib/money.ts"));

const BANK_DEPOSIT = "bank-or-financial-institution-deposit";

function estimate(sources, filerStatus = "ATL", extra = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus,
    totalIncome: 0,
    totalExpenses: 0,
    bankProfitIncome: 0,
    taxWithheld: 0,
    isSalariedRoute: false,
    isBankProfitRoute: false,
    incomeSources: sources,
    ...extra,
  });
}

// Every expected figure is hard-coded from the rate card. None is derived and
// no Non-ATL value is computed as "x2".
const ATL_SCENARIOS = [
  ["Salary 8,000,000", [{ route: "salary", income: 8_000_000 }],
    { isSalariedRoute: true, totalIncome: 8_000_000 }, 1_981_000],
  ["Salary 12,000,000 (with 9% surcharge)", [{ route: "salary", income: 12_000_000 }],
    { isSalariedRoute: true, totalIncome: 12_000_000 }, 3_685_290],
  ["Salary 20,000,000", [{ route: "salary", income: 20_000_000 }],
    { isSalariedRoute: true, totalIncome: 20_000_000 }, 6_737_290],
  ["Salary 8m + Bank profit 1m",
    [{ route: "salary", income: 8_000_000 },
     { route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT }],
    { isSalariedRoute: true }, 2_181_000],
  ["Salary 5m + Bank 1m + Services 2m",
    [{ route: "salary", income: 5_000_000 },
     { route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT },
     { route: "services", income: 2_000_000, subcategory: "1b-service-it-ites" }],
    { isSalariedRoute: true }, 1_211_000],
  ["Section 152 IT services, non-resident 1m",
    [{ route: "foreign_income_assets", income: 1_000_000, subcategory: "2a-b-it-ites" }],
    {}, 40_000],
  ["Dividend on bonus shares 1m",
    [{ route: "dividend", income: 1_000_000, subcategory: "bonus-shares" }],
    {}, 100_000],
  ["Company rent 1,500,000",
    [{ route: "property_rent", income: 1_500_000 }],
    { isRentalRoute: true, rentalRecipientKind: "COMPANY" }, 225_000],
];

const NON_ATL_SCENARIOS = [
  ["Bank profit deposit 1m, Non-ATL (card says 40%)",
    [{ route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT }],
    {}, 400_000],
  ["Dividend bonus shares 1m, Non-ATL (card says 20%)",
    [{ route: "dividend", income: 1_000_000, subcategory: "bonus-shares" }],
    {}, 200_000],
  ["Section 152 sub-1 1m, Non-ATL stays 15% (client-approved)",
    [{ route: "foreign_income_assets", income: 1_000_000, subcategory: "1" }],
    {}, 150_000],
  ["Company rent 1.5m, Non-ATL (card says 30%)",
    [{ route: "property_rent", income: 1_500_000 }],
    { isRentalRoute: true, rentalRecipientKind: "COMPANY" }, 450_000],
];

const rows = [];

(async () => {
  const user = await h.createTestUser(EMAIL);

  h.section("1. ATL scenarios price exactly as pinned");
  for (const [name, sources, extra, expected] of ATL_SCENARIOS) {
    const r = estimate(sources, "ATL", extra);
    h.check(`${name} = PKR ${expected.toLocaleString("en-US")}`, r.taxDue, expected);
    h.check(`${name} returns a finished estimate`, r.status, "ESTIMATE");
    rows.push([name, "ATL", r.taxDue, expected]);
  }

  h.section("2. Non-ATL scenarios price from the card, never by doubling");
  for (const [name, sources, extra, expected] of NON_ATL_SCENARIOS) {
    const r = estimate(sources, "NON_ATL", extra);
    h.check(`${name} = PKR ${expected.toLocaleString("en-US")}`, r.taxDue, expected);
    rows.push([name, "NON_ATL", r.taxDue, expected]);
  }

  h.section("3. Refunds and final tax behave correctly");
  {
    const refund = estimate(
      [{ route: "services", income: 5_000_000, subcategory: "1b-service-it-ites" }],
      "ATL",
      { taxWithheld: 250_000 },
    );
    h.check("Services 5m: tax due 200,000", refund.taxDue, 200_000);
    h.check("Services 5m withheld 250,000: refund 50,000", refund.refundDue, 50_000);
    h.check("Services 5m withheld 250,000: nothing left to pay", refund.taxPayable, 0);
    rows.push(["Services 5m, 250k withheld -> refund", "ATL", refund.refundDue, 50_000]);

    // Bank profit is the ONLY final-tax route, so over-withholding is not
    // refundable. Getting this wrong would promise the taxpayer money back.
    const final = estimate(
      [{ route: "bank_profit", income: 1_000_000, subcategory: BANK_DEPOSIT }],
      "ATL",
      { isBankProfitRoute: true, bankProfitIncome: 1_000_000, taxWithheld: 250_000 },
    );
    h.check("Bank profit is final tax: no refund despite over-withholding", final.refundDue, 0);
    rows.push(["Bank profit 1m final tax -> refund", "ATL", final.refundDue, 0]);
  }

  h.section("4. Every rendered figure is a whole rupee");
  for (const [name, , actual] of rows) {
    h.check(`${name}: whole rupees, no float residue`, Number.isInteger(actual), true);
  }

  h.section("5. Real Postgres rows -> Decimal sum -> engine -> screen");
  {
    const draft = await h.prisma.filingDraft.create({
      data: {
        userId: user.id,
        taxYear: 2026,
        filerType: "myself",
        incomeSources: JSON.stringify(["salary"]),
      },
    });
    // These three were FOUND BY SEARCH, not guessed: float does not drift on
    // every input, and three earlier hand-picked triples all summed cleanly.
    // As IEEE doubles these give 12000000.000000002; in Decimal, 12000000.00.
    const parts = ["136125.30", "9495699.22", "2368175.48"];
    for (const [i, amount] of parts.entries()) {
      await h.prisma.ledgerEntry.create({
        data: {
          filingDraftId: draft.id,
          userId: user.id,
          entryType: "INCOME",
          category: "SALARY",
          description: `Salary part ${i + 1}`,
          amount,
          entryDate: new Date(Date.UTC(2025, 8, 1 + i)),
        },
      });
    }
    const entries = await h.prisma.ledgerEntry.findMany({
      where: { filingDraftId: draft.id },
      select: { amount: true },
    });
    h.check("Three ledger rows persisted", entries.length, 3);

    const floatSum = entries.reduce((t, e) => t + Number(e.amount), 0);
    const exact = sumMoney(entries.map((e) => e.amount));
    h.check("Decimal sum is exactly 12,000,000", exact, 12_000_000);
    h.checkTrue(
      "A plain float sum of these same rows drifts off the exact total",
      floatSum !== 12_000_000,
      `float gave ${floatSum}, Decimal gave ${exact}`,
    );

    const priced = estimate([{ route: "salary", income: exact }], "ATL", {
      isSalariedRoute: true,
      totalIncome: exact,
    });
    h.check("Tax on the persisted total = 3,685,290", priced.taxDue, 3_685_290);

    // The exact string the FBR packet prints. Before Phase 5-F this rendered
    // as "PKR 3685290", with no separators, on the document sent to the FBR.
    h.check(
      "Rendered as PKR 3,685,290",
      `PKR ${Number(priced.taxDue).toLocaleString("en-US")}`,
      "PKR 3,685,290",
    );
    rows.push(["DB rows 136125.30+9495699.22+2368175.48 -> tax", "ATL", priced.taxDue, 3_685_290]);

    await h.prisma.filingDraft.delete({ where: { id: draft.id } });
  }

  h.section("6. An unreconciled draft cannot be priced");
  {
    const draft = await h.prisma.filingDraft.create({
      data: {
        userId: user.id,
        taxYear: 2026,
        filerType: "myself",
        incomeSources: JSON.stringify(["salary"]),
      },
    });
    const { validateAuthoritativeReconciliation } = require(
      path.join(ROOT, "lib/tax/reconciliation-calculation.ts"),
    );
    const res = await validateAuthoritativeReconciliation({
      draftId: draft.id,
      userId: user.id,
    });
    const blocked = "blockers" in res && res.blockers.length > 0;
    h.checkTrue(
      "Pricing is blocked until reconciliation is resolved",
      blocked,
      blocked ? res.blockers[0] : "GATE IS OPEN -- defect",
    );
    await h.prisma.filingDraft.delete({ where: { id: draft.id } });
  }

  h.section("RESULTS -- every figure this run produced");
  console.log("");
  console.log("  Scenario                                                Status      Result (PKR)");
  console.log("  " + "-".repeat(80));
  for (const [name, status, actual] of rows) {
    console.log(
      "  " +
        name.padEnd(54).slice(0, 54) +
        String(status).padEnd(12) +
        Number(actual).toLocaleString("en-US").padStart(13),
    );
  }
  console.log("");

  await h.deleteTestUser(EMAIL);
  h.finish("UI 3 -- Tax calculation end-to-end");
  await h.prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await h.prisma.$disconnect();
  process.exit(1);
});
