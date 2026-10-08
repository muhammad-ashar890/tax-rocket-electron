/**
 * Sales tax return (FBR goods, trader): hand-worked months.
 *
 * Every expected figure below was worked out by hand from the IRIS return
 * layout and the Sales Tax Act before the engine was run. The engine is never
 * asked what the answer is; it is asked to match a number worked out
 * independently. All data is synthetic.
 *
 * Line numbers (Sr.) follow the IRIS return. Amounts are in rupees in this
 * file and converted to paisa with R().
 */

const { load, R, sale, purchase, PERIOD, createChecker } = require("./lib/sales-tax-test-kit.cjs");
const { computeSalesTaxReturn } = load("lib/sales-tax/compute-return.ts");

const { check, finish } = createChecker("verify-sales-tax-return");

const STD = "Goods at standard rate (default)";

function run(input) {
  return computeSalesTaxReturn({
    period: PERIOD,
    sales: [],
    purchases: [],
    imports: [],
    exports: [],
    ...input,
  });
}

/** Checks a set of lines: { "9": { tax: 180000 }, "25": { tax: 108000 } } in rupees. */
function expectLines(label, result, expected) {
  check(`${label}: can estimate`, result.canEstimate, true);
  for (const [sr, amounts] of Object.entries(expected)) {
    const found = result.bySr[sr];
    check(`${label}: line ${sr} exists`, !!found, true);
    if (!found) continue;
    if ("tax" in amounts) check(`${label}: Sr.${sr} tax`, found.salesTax, R(amounts.tax));
    if ("gross" in amounts) check(`${label}: Sr.${sr} gross`, found.grossValue, R(amounts.gross));
    if ("taxable" in amounts) check(`${label}: Sr.${sr} taxable`, found.taxableValue, R(amounts.taxable));
  }
}

function codes(result) {
  return result.problems.map((p) => p.code).sort();
}

// M1 -- no activity: everything zero, with a warning to file a null return.
{
  const r = run({});
  expectLines("M1 empty month", r, { "9": { tax: 0, gross: 0 }, "25": { tax: 0 }, "32": { tax: 0 }, "37": { tax: 0 } });
  check("M1 warns", codes(r), ["no_invoices"]);
  check("M1 balance", r.balancePayable, 0);
}

// M2 -- simple month, cap not reached.
// Output 180,000. Input 108,000. Cap 90% of 180,000 = 162,000. 25 = 108,000. 32 = 72,000.
{
  const r = run({ sales: [sale(1_000_000, 180_000)], purchases: [purchase(600_000, 108_000)] });
  expectLines("M2 simple", r, {
    "9": { gross: 1_000_000, taxable: 1_000_000, tax: 180_000 },
    "1": { gross: 600_000, taxable: 600_000, tax: 108_000 },
    "5": { tax: 108_000 }, "8": { tax: 108_000 }, "15": { tax: 180_000 }, "17": { tax: 180_000 },
    "25": { tax: 108_000 }, "26": { tax: 0 }, "28": { tax: 0 }, "30": { tax: 0 },
    "32": { tax: 72_000 }, "35": { tax: 72_000 }, "37": { tax: 72_000 },
  });
  check("M2 balance", r.balancePayable, R(72_000));
  check("M2 problems (supplier status note only)", codes(r), ["purchase_supplier_status_unknown"]);
}

// M3 -- the 90% limit bites.
// Input 198,000 but cap is 162,000. 25 = 162,000. 26 = 36,000 carried. 32 = 180,000 - 162,000 = 18,000.
{
  const r = run({ sales: [sale(1_000_000, 180_000)], purchases: [purchase(1_100_000, 198_000)] });
  expectLines("M3 cap bites", r, {
    "8": { tax: 198_000 }, "25": { tax: 162_000 }, "26": { tax: 36_000 },
    "28": { tax: 36_000 }, "30": { tax: 36_000 }, "32": { tax: 18_000 }, "37": { tax: 18_000 },
  });
}

// M4 -- capital goods sit outside the cap.
// Non-capital input 180,000, capital input 90,000, 8 = 270,000. Cap = 162,000.
// Non-capital part allowed = min(180,000, 162,000, 180,000) = 162,000.
// Capital part = min(90,000, 270,000 - 162,000) = 90,000. 25 = min(252,000, 180,000) = 180,000.
// 26 = 90,000. 32 = 0 because 17 is not above 25.
{
  const r = run({
    sales: [sale(1_000_000, 180_000)],
    purchases: [purchase(1_000_000, 180_000), purchase(500_000, 90_000, { isCapitalGoods: true })],
  });
  expectLines("M4 capital goods", r, {
    "1": { tax: 180_000 }, "4": { tax: 90_000 }, "5": { tax: 270_000 }, "8": { tax: 270_000 },
    "25": { tax: 180_000 }, "26": { tax: 90_000 }, "30": { tax: 90_000 }, "32": { tax: 0 }, "37": { tax: 0 },
  });
}

// M5 -- capital goods larger than output tax: 25 cannot exceed output tax.
// 8 = 180,000, base 0, capital part = min(180,000, 180,000) = 180,000, 25 = min(180,000, 18,000) = 18,000.
{
  const r = run({
    sales: [sale(100_000, 18_000)],
    purchases: [purchase(1_000_000, 180_000, { isCapitalGoods: true })],
  });
  expectLines("M5 capital above output", r, {
    "25": { tax: 18_000 }, "26": { tax: 162_000 }, "30": { tax: 162_000 }, "32": { tax: 0 },
  });
}

// M31 -- capital goods are added on top of the capped ordinary input, not capped with it.
// Ordinary input 90,000 (below the 162,000 cap), capital input 36,000. 8 = 126,000.
// 25 = min(90,000, 162,000) + 36,000 = 126,000. A cap applied to everything would give 162,000.
{
  const r = run({
    sales: [sale(1_000_000, 180_000)],
    purchases: [purchase(500_000, 90_000), purchase(200_000, 36_000, { isCapitalGoods: true })],
  });
  expectLines("M31 capital on top", r, { "8": { tax: 126_000 }, "25": { tax: 126_000 }, "26": { tax: 0 }, "32": { tax: 54_000 } });
}

// M32 -- capital goods and a cap that bites at the same time, with buyer withholding.
// Output 360,000, withheld 60,000 so 17 = 300,000. Ordinary input 400,000 (cap 324,000), capital 50,000.
// 8 = 450,000. 25 = min(min(400,000, 324,000) + 50,000, 300,000) = 300,000. 26 = 150,000. 32 = 0.
{
  const r = run({
    sales: [sale(2_000_000, 360_000, { stWithheldAtSource: R(60_000) })],
    purchases: [purchase(2_222_222.22, 400_000), purchase(277_777.78, 50_000, { isCapitalGoods: true })],
  });
  expectLines("M32 capital, cap and withholding", r, { "17": { tax: 300_000 }, "8": { tax: 450_000 }, "25": { tax: 300_000 }, "26": { tax: 150_000 }, "32": { tax: 0 } });
}

// M6 -- refund month: no sales, input 90,000, whole credit claimed as refund.
// 25 = 0, 26 = 28 = 90,000, claimed 90,000 so 30 = 0.
{
  const r = run({ purchases: [purchase(500_000, 90_000)], adjustments: { refundClaimed29: R(90_000) } });
  expectLines("M6 refund", r, { "15": { tax: 0 }, "25": { tax: 0 }, "28": { tax: 90_000 }, "29": { tax: 90_000 }, "30": { tax: 0 }, "32": { tax: 0 } });
  check("M6 warns about Annex-H", codes(r).includes("refund_needs_annex_h"), true);
}

// M6b -- partial refund: claimed 40,000 so 30 = 90,000 - 40,000 = 50,000.
{
  const r = run({ purchases: [purchase(500_000, 90_000)], adjustments: { refundClaimed29: R(40_000) } });
  expectLines("M6b partial refund", r, { "28": { tax: 90_000 }, "30": { tax: 50_000 } });
}

// M6c -- refund claimed above the credit is an error and gives no figures.
{
  const r = run({ purchases: [purchase(500_000, 90_000)], adjustments: { refundClaimed29: R(90_001) } });
  check("M6c cannot estimate", r.canEstimate, false);
  check("M6c error code", codes(r).includes("refund_exceeds_credit"), true);
  check("M6c no lines", r.lines.length, 0);
}

// M7 -- credit note reduces sales: 1,000,000 - 200,000 = 800,000, tax 180,000 - 36,000 = 144,000.
{
  const note = sale(200_000, 36_000, { documentType: "Credit Note", invoiceRefNo: "INV-1", reason: "Return of goods" });
  const r = run({ sales: [sale(1_000_000, 180_000), note] });
  expectLines("M7 credit note", r, { "9": { gross: 800_000, taxable: 800_000, tax: 144_000 }, "15": { tax: 144_000 }, "32": { tax: 144_000 } });
}

// M8 -- debit note increases sales: 500,000 + 100,000 = 600,000, tax 90,000 + 18,000 = 108,000.
{
  const note = sale(100_000, 18_000, { documentType: "Debit Note", invoiceRefNo: "INV-1", reason: "Change in value of supply" });
  const r = run({ sales: [sale(500_000, 90_000), note] });
  expectLines("M8 debit note", r, { "9": { gross: 600_000, tax: 108_000 }, "15": { tax: 108_000 } });
}

// M9 -- unregistered buyer: further tax 4% of 100,000 = 4,000 goes to Sr.23a and is payable.
// 32 = 18,000 - 0 + 4,000 = 22,000. Sales tax line 9 stays 18,000.
{
  const r = run({ sales: [sale(100_000, 18_000, { buyerType: "Unregistered", buyerRegistrationNo: "4220112345671", furtherTax: R(4_000) })] });
  expectLines("M9 further tax", r, { "9": { tax: 18_000 }, "23a": { tax: 4_000 }, "25": { tax: 0 }, "32": { tax: 22_000 }, "37": { tax: 22_000 } });
  check("M9 no problems", codes(r), []);
}

// M10 -- buyer withholds 20,000: 17 = 180,000 - 20,000 = 160,000.
// Input 72,000; cap = 90% of 180,000 = 162,000; output available 160,000; 25 = 72,000; 32 = 88,000.
{
  const r = run({
    sales: [sale(1_000_000, 180_000, { stWithheldAtSource: R(20_000) })],
    purchases: [purchase(400_000, 72_000)],
  });
  expectLines("M10 withheld", r, { "15": { tax: 180_000 }, "16": { tax: 20_000 }, "17": { tax: 160_000 }, "25": { tax: 72_000 }, "32": { tax: 88_000 }, "37": { tax: 88_000 } });
}

// M10b -- line 36 (already paid) reduces the balance: 88,000 - 10,000 = 78,000.
{
  const r = run({
    sales: [sale(1_000_000, 180_000, { stWithheldAtSource: R(20_000) })],
    purchases: [purchase(400_000, 72_000)],
    adjustments: { taxPaidPreviousReturn36: R(10_000) },
  });
  expectLines("M10b paid already", r, { "35": { tax: 88_000 }, "36": { tax: 10_000 }, "37": { tax: 78_000 } });
}

// M11 -- carry-forward and adjustments.
// 5 = 90,000. 8 = 90,000 + 30,000 + 1,000 - (5,000 + 2,000 + 3,000) = 111,000.
// Cap 162,000, output 180,000, so 25 = 111,000 and 32 = 69,000.
{
  const r = run({
    sales: [sale(1_000_000, 180_000)],
    purchases: [purchase(500_000, 90_000)],
    adjustments: {
      creditBroughtForward: R(30_000), inadmissible6a: R(5_000), nonCreditable7: R(2_000),
      inadmissible7a: R(3_000), allowance7b: R(1_000),
    },
  });
  expectLines("M11 adjustments", r, { "5": { tax: 90_000 }, "8": { tax: 111_000 }, "25": { tax: 111_000 }, "32": { tax: 69_000 } });
}

// M11b -- deductions larger than the input available are refused.
{
  const r = run({ purchases: [purchase(100_000, 18_000)], adjustments: { inadmissible6a: R(18_001) } });
  check("M11b cannot estimate", r.canEstimate, false);
  check("M11b code", codes(r).includes("adjustments_exceed_input"), true);
}

// M12 -- exempt, zero-rated, standard and an export.
// Gross 200,000 + 300,000 + 500,000 = 1,000,000. Taxable 500,000. Tax 90,000.
// Export 400,000 in Sr.11. Input 18,000 so 25 = 18,000 (cap 81,000), 32 = 72,000.
{
  const exempt = sale(200_000, 0, { saleType: "Exempt goods", rate: "Exempt", exemptionSroNo: "SECTION 49" });
  const zero = sale(300_000, 0, { saleType: "Goods at zero-rate", rate: 0, exemptionSroNo: "FIFTH SCHEDULE" });
  const r = run({
    sales: [exempt, zero, sale(500_000, 90_000)],
    purchases: [purchase(100_000, 18_000)],
    exports: [{ documentNo: "EXP-1", documentDate: "2026-08-12", valueExclTax: R(400_000) }],
  });
  expectLines("M12 mixed", r, {
    "9": { gross: 1_000_000, taxable: 500_000, tax: 90_000 }, "11": { gross: 400_000, tax: 0 },
    "25": { tax: 18_000 }, "32": { tax: 72_000 },
  });
  check("M12 exempt warning", codes(r).includes("exempt_supplies_need_apportionment"), true);
}

// M13 -- reduced rate: 5% of 1,000,000 = 50,000. Sr.9 includes it; Sr.10 is the memo.
{
  const reduced = sale(1_000_000, 50_000, { saleType: "Goods at Reduced Rate", rate: 0.05, exemptionSroNo: "6th Schd Table I" });
  const r = run({ sales: [reduced, sale(1_000_000, 180_000)] });
  expectLines("M13 reduced", r, {
    "9": { gross: 2_000_000, taxable: 2_000_000, tax: 230_000 },
    "10": { gross: 1_000_000, taxable: 1_000_000, tax: 50_000 }, "15": { tax: 230_000 },
  });
}

// M14 -- Third Schedule goods are taxed on the retail price: 18% of 100,000 = 18,000.
{
  const third = sale(80_000, 18_000, { saleType: "3rd Schedule Goods", fixedOrRetailValue: R(100_000) });
  const r = run({ sales: [third] });
  expectLines("M14 third schedule", r, { "9": { gross: 80_000, tax: 18_000 }, "15": { tax: 18_000 } });
  check("M14 no problems", codes(r), []);
}

// M15 -- excluded from the limit (Sr.24 Yes): 25 = 198,000; 26 = 198,000 - 180,000 = 18,000; 32 = 0.
{
  const r = run({
    sales: [sale(1_000_000, 180_000)],
    purchases: [purchase(1_100_000, 198_000)],
    section8B: { excluded: true },
  });
  expectLines("M15 excluded", r, { "25": { tax: 198_000 }, "26": { tax: 18_000 }, "28": { tax: 18_000 }, "30": { tax: 18_000 }, "32": { tax: 0 }, "37": { tax: 0 } });
  check("M15 line 24 says Yes", r.bySr["24"].note, "Yes");
}

// M16 -- imports. Non-capital 360,000, capital 180,000; 8 = 540,000. Output 540,000. Cap 486,000.
// Non-capital part = min(360,000, 486,000, 540,000) = 360,000. Capital = min(180,000, 180,000) = 180,000.
// 25 = min(540,000, 540,000) = 540,000. 26 = 0. 32 = 0.
{
  const r = run({
    sales: [sale(3_000_000, 540_000)],
    imports: [
      { gdNo: "GD-1", gdDate: "2026-08-03", taxableValue: R(2_000_000), salesTaxPaid: R(360_000), valueAdditionTaxPaid: 0 },
      { gdNo: "GD-2", gdDate: "2026-08-04", taxableValue: R(1_000_000), salesTaxPaid: R(180_000), valueAdditionTaxPaid: 0, isCapitalGoods: true },
    ],
  });
  expectLines("M16 imports", r, {
    "3": { gross: 2_000_000, taxable: 2_000_000, tax: 360_000 }, "4": { gross: 1_000_000, tax: 180_000 },
    "5": { tax: 540_000 }, "25": { tax: 540_000 }, "26": { tax: 0 }, "32": { tax: 0 },
  });
}

// M17 -- purchases from an unregistered supplier give no credit but show in Sr.2.
// Input only 18,000 (registered). Cap 90% of 72,000 = 64,800. 25 = 18,000. 32 = 54,000.
{
  const unreg = purchase(300_000, 0, { sellerType: "Unregistered", sellerRegistrationNo: "", rate: 0.18 });
  const r = run({ sales: [sale(400_000, 72_000)], purchases: [unreg, purchase(100_000, 18_000)] });
  expectLines("M17 unregistered supplier", r, { "2": { gross: 300_000, taxable: 300_000, tax: 0 }, "1": { tax: 18_000 }, "5": { tax: 18_000 }, "25": { tax: 18_000 }, "32": { tax: 54_000 } });
}

// M18 -- rounding: three rows of 100.10 with tax 18.02 each. Total 54.06 = 5406 paisa exactly.
{
  const rows = [sale(100.1, 18.02), sale(100.1, 18.02), sale(100.1, 18.02)];
  const r = run({ sales: rows });
  expectLines("M18 paisa", r, { "9": { gross: 300.3, tax: 54.06 }, "32": { tax: 54.06 } });
  check("M18 integer paisa", r.bySr["9"].salesTax, 5406);
  check("M18 gross paisa", r.bySr["9"].grossValue, 30030);
}

// M19 -- large values: output 180,000,000, input 90,000,000; 25 = 90,000,000; 32 = 90,000,000.
{
  const r = run({ sales: [sale(1_000_000_000, 180_000_000)], purchases: [purchase(500_000_000, 90_000_000)] });
  expectLines("M19 large", r, { "15": { tax: 180_000_000 }, "25": { tax: 90_000_000 }, "32": { tax: 90_000_000 } });
}

// M20 -- a sale type this version does not support: no figures at all.
{
  const r = run({ sales: [sale(100_000, 18_000, { saleType: "Petroleum Products" })] });
  check("M20 cannot estimate", r.canEstimate, false);
  check("M20 no lines", r.lines.length, 0);
  check("M20 balance is null", r.balancePayable, null);
  check("M20 refuse code", r.problems.map((p) => [p.code, p.severity]), [["row_unsupported_sale_type", "refuse"]]);
}

// M21 -- per-client limit of 95%: cap = 171,000; 25 = 171,000; 26 = 27,000; 32 = 9,000.
{
  const r = run({
    sales: [sale(1_000_000, 180_000)],
    purchases: [purchase(1_100_000, 198_000)],
    section8B: { capPercent: 95 },
  });
  expectLines("M21 95 percent", r, { "25": { tax: 171_000 }, "26": { tax: 27_000 }, "32": { tax: 9_000 } });
  check("M21 note shows 95", r.bySr["24"].note, "No (limit 95% of output tax)");
}

// M22 -- the limit rounds down to a whole paisa.
// Output 12,345.67 = 1,234,567 paisa. 90% = 1,111,110.3 paisa -> 1,111,110 paisa = 11,111.10.
// Input 20,000.00. 25 = 11,111.10. 26 = 8,888.90. 32 = 12,345.67 - 11,111.10 = 1,234.57.
{
  const r = run({ sales: [sale(68_587.06, 12_345.67)], purchases: [purchase(111_111.11, 20_000)] });
  check("M22 output paisa", r.bySr["15"].salesTax, 1234567);
  check("M22 line 25 paisa", r.bySr["25"].salesTax, 1111110);
  check("M22 line 26 paisa", r.bySr["26"].salesTax, 888890);
  check("M22 line 32 paisa", r.bySr["32"].salesTax, 123457);
}

// M23 -- buyer withholds more than the output tax: line 17 negative, warning, nothing to pay.
{
  const r = run({ sales: [sale(100_000, 18_000, { stWithheldAtSource: R(20_000) })] });
  expectLines("M23 over-withheld", r, { "17": { tax: -2_000 }, "25": { tax: 0 }, "32": { tax: 0 } });
  check("M23 warns", codes(r), ["withheld_exceeds_output"]);
}

// M24 -- arrears are added to the payable amount: 18,000 + 5,000 = 23,000.
{
  const r = run({ sales: [sale(100_000, 18_000)], adjustments: { arrears23: R(5_000) } });
  expectLines("M24 arrears", r, { "23": { tax: 5_000 }, "32": { tax: 23_000 } });
}

// M25 -- tax withheld by us as a withholding agent on a purchase is payable by us.
// Input 9,000, output 18,000, 25 = 9,000, 32 = 9,000 + 3,000 = 12,000.
{
  const r = run({
    sales: [sale(100_000, 18_000)],
    purchases: [purchase(50_000, 9_000, { stWithheldAsWhAgent: R(3_000) })],
  });
  expectLines("M25 withholding agent", r, { "22": { tax: 3_000 }, "25": { tax: 9_000 }, "32": { tax: 12_000 } });
}

// M26 -- every figure is labelled an estimate, and Sr.25 says why.
{
  const r = run({ sales: [sale(100_000, 18_000)] });
  check("M26 isEstimate", r.isEstimate, true);
  check("M26 line 25 status", r.bySr["25"].status, "estimate");
  check("M26 line 37 status", r.bySr["37"].status, "estimate");
  check("M26 line 9 status", r.bySr["9"].status, "computed");
}

// M27 -- a bad month number gives no figures.
{
  const r = computeSalesTaxReturn({ period: { year: 2026, month: 13 }, sales: [], purchases: [], imports: [], exports: [] });
  check("M27 cannot estimate", r.canEstimate, false);
  check("M27 code", codes(r), ["invalid_period"]);
}

// M28 -- an invalid limit percentage is refused.
for (const bad of [0, 101, 90.5, -5]) {
  const r = run({ sales: [sale(100_000, 18_000)], section8B: { capPercent: bad } });
  check(`M28 cap ${bad} refused`, r.canEstimate, false);
}

// M29 -- an invalid adjustment is refused (negative or fractional paisa).
for (const bad of [-1, 0.5]) {
  const r = run({ sales: [sale(100_000, 18_000)], adjustments: { creditBroughtForward: bad } });
  check(`M29 adjustment ${bad} refused`, r.canEstimate, false);
}

// M30 -- the engine does not change the input rows.
{
  const rows = [sale(100_000, 18_000)];
  const before = JSON.stringify(rows);
  run({ sales: rows });
  check("M30 input untouched", JSON.stringify(rows), before);
}

finish();
