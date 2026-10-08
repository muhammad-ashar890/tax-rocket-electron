/**
 * Sales tax rules: money helpers, official template lists, rules catalog and
 * the plain-language message table.
 *
 * Counts and values below were read from the official FBR templates (Sales
 * DSI 1.0.44, Purchase DPI 1.0.29) and the Sales Tax Act 1990 (updated to
 * 30-06-2026) by hand, not taken from the code under test.
 */

const fs = require("fs");
const path = require("path");
const { load, projectRoot, createChecker } = require("./lib/sales-tax-test-kit.cjs");

const money = load("lib/sales-tax/money.ts");
const catalog = load("lib/sales-tax/rules/fbr-goods/catalog.ts");
const { validateCatalog } = load("lib/sales-tax/rules/fbr-goods/validate-catalog.ts");
const { SALES_TEMPLATE, PURCHASE_TEMPLATE } = load("lib/sales-tax/rules/fbr-goods/reference.ts");
const { makeProblem, PROBLEM_CODES } = load("lib/sales-tax/problems.ts");

const { check, finish } = createChecker("verify-sales-tax-rules");

// ---------------------------------------------------------------------------
// 1. Money: whole paisa, no floating point drift
// ---------------------------------------------------------------------------

for (const [input, expected] of [
  [0, 0], [1, 100], [1.5, 150], [1234.56, 123456], [0.01, 1], [0.1, 10], [0.29, 29], [19.99, 1999],
  [1.005, 101], [2.675, 268], [1.004, 100], [-5.5, -550], ["1,234.50", 123450], [" 7 ", 700],
  ["0.005", 1], ["0.004", 0], ["12.", 1200], [".5", 50], ["+3", 300], [1e9, 100000000000],
]) {
  check(`toPaisa(${JSON.stringify(input)})`, money.toPaisa(input), expected);
}
for (const bad of ["", "abc", "1.2.3", "--1", null, undefined, NaN, Infinity, {}, [], true, ".", "1e5"]) {
  check(`toPaisa(${String(bad)}) is null`, money.toPaisa(bad), null);
}
check("0.1 + 0.2 in paisa", money.toPaisa(0.1) + money.toPaisa(0.2), 30);
{
  // 100,000 steps of Rs 0.01 must give exactly Rs 1,000.00.
  let total = 0;
  for (let i = 0; i < 100000; i += 1) total += money.toPaisa(0.01);
  check("100,000 x Rs 0.01", total, 100000);
  check("sumPaisa", money.sumPaisa([1, 2, 3, -1]), 5);
  check("sumPaisa of nothing", money.sumPaisa([]), 0);
}
check("paisaToRupees 12,345 paisa", money.paisaToRupees(12345), 123);
check("paisaToRupees 12,350 paisa rounds up", money.paisaToRupees(12350), 124);
check("paisaToRupees 12,349", money.paisaToRupees(12349), 123);
check("paisaToRupees negative -12,350", money.paisaToRupees(-12350), -124);
check("paisaToRupees zero", money.paisaToRupees(0), 0);
check("formatRupees", money.formatRupees(123456789), "Rs 1,234,567.89");
check("formatRupees small", money.formatRupees(5), "Rs 0.05");
check("formatRupees negative", money.formatRupees(-150), "-Rs 1.50");
check("formatRupees zero", money.formatRupees(0), "Rs 0.00");
check("formatRupees exact thousand", money.formatRupees(100000), "Rs 1,000.00");
// 18% of Rs 100,000.00 is Rs 18,000.00; 18% of Rs 100.10 is 18.018 -> Rs 18.02.
check("applyRate 18% of 1,000,000 paisa", money.applyRate(10000000, 0.18), 1800000);
check("applyRate 18% of 100.10", money.applyRate(10010, 0.18), 1802);
check("applyRate 0.25% of 1,000", money.applyRate(100000, 0.0025), 250);
check("applyRate zero rate", money.applyRate(12345, 0), 0);
check("applyRate half rounds up", money.applyRate(250, 0.01), 3); // 2.5 paisa -> 3
check("applyRate 17% of 3 paisa", money.applyRate(3, 0.17), 1); // 0.51 -> 1
check("applyRate negative amount", money.applyRate(-10010, 0.18), -1802);
check("percentOfFloor 90% of 1,234,567", money.percentOfFloor(1234567, 90), 1111110);
check("percentOfFloor 90% of 100", money.percentOfFloor(100, 90), 90);
check("percentOfFloor 95% of 1", money.percentOfFloor(1, 95), 0);
check("percentOfFloor of zero", money.percentOfFloor(0, 90), 0);
check("percentOfFloor 100%", money.percentOfFloor(999, 100), 999);

// ---------------------------------------------------------------------------
// 2. Official template lists
// ---------------------------------------------------------------------------

check("sales template version", SALES_TEMPLATE.templateVersion, "1.0.44");
check("sales template kind", SALES_TEMPLATE.templateKind, "DSI");
check("purchase template version", PURCHASE_TEMPLATE.templateVersion, "1.0.29");
check("purchase template kind", PURCHASE_TEMPLATE.templateKind, "DPI");
check("sales document types", SALES_TEMPLATE.documentTypes, ["Sale Invoice", "Credit Note", "Debit Note", "STWH"]);
check("purchase document types", PURCHASE_TEMPLATE.documentTypes, ["Purchase Invoice", "STWH", "Credit Note", "Debit Note"]);
check("sales party types", SALES_TEMPLATE.partyTypes, ["Registered", "Unregistered", "Unregistered Distributor", "Retail Consumer"]);
check("purchase party types", PURCHASE_TEMPLATE.partyTypes, ["Registered", "Unregistered"]);
check("sales sale types count", SALES_TEMPLATE.saleTypes.length, 27);
check("purchase sale types count", PURCHASE_TEMPLATE.saleTypes.length, 30);
check("sales rates count", SALES_TEMPLATE.rates.length, 114);
check("purchase rates count", PURCHASE_TEMPLATE.rates.length, 99);
check("sales sro count", SALES_TEMPLATE.sroNumbers.length, 96);
check("purchase sro count", PURCHASE_TEMPLATE.sroNumbers.length, 15);
check("sales item serials count", SALES_TEMPLATE.itemSerials.length, 729);
check("purchase item serials count", PURCHASE_TEMPLATE.itemSerials.length, 659);
check("sales uom count", SALES_TEMPLATE.unitsOfMeasure.length, 30);
check("sales provinces", SALES_TEMPLATE.provinces, ["AZAD JAMMU AND KASHMIR", "BALOCHISTAN", "CAPITAL TERRITORY", "GILGIT BALTISTAN", "KHYBER PAKHTUNKHWA", "PUNJAB", "SINDH", "FATA/PATA"]);
check("purchase provinces equal sales provinces", PURCHASE_TEMPLATE.provinces, SALES_TEMPLATE.provinces);
check("reasons", SALES_TEMPLATE.reasons, ["Cancellation of supply", "Return of goods", "Change in nature of supply", "Change in value of supply", "Change in amount of tax", "Others", "Adjustment given to Steel Melters"]);
check("reasons equal in purchase", PURCHASE_TEMPLATE.reasons, SALES_TEMPLATE.reasons);
check("sales rates include 0.18 and 0", [SALES_TEMPLATE.rates.includes(0.18), SALES_TEMPLATE.rates.includes(0)], [true, true]);
check("sales rates include Exempt", SALES_TEMPLATE.rates.includes("Exempt"), true);
check("sale types include the five supported ones", catalog.SUPPORTED_SALE_TYPES.every((n) => SALES_TEMPLATE.saleTypes.includes(n) && PURCHASE_TEMPLATE.saleTypes.includes(n)), true);
check("no list has duplicates", [SALES_TEMPLATE, PURCHASE_TEMPLATE].every((t) => ["saleTypes", "documentTypes", "partyTypes", "provinces", "reasons", "sroNumbers"].every((k) => new Set(t[k]).size === t[k].length)), true);
check("header rows carry 5 rows of 31 cells", [SALES_TEMPLATE, PURCHASE_TEMPLATE].every((t) => t.headerRows.length === 5 && t.headerRows.every((r) => r.length === 31)), true);

// ---------------------------------------------------------------------------
// 3. Sale type decisions: every official type has an explicit treatment
// ---------------------------------------------------------------------------

const SUPPORTED = new Map([
  ["Goods at standard rate (default)", "standard"],
  ["Goods at Reduced Rate", "reduced"],
  ["Goods at zero-rate", "zero_rated"],
  ["Exempt goods", "exempt"],
  ["3rd Schedule Goods", "third_schedule"],
]);
for (const name of new Set([...SALES_TEMPLATE.saleTypes, ...PURCHASE_TEMPLATE.saleTypes])) {
  check(`treatment of "${name}"`, catalog.saleTypeTreatment(name), SUPPORTED.get(name) || "unsupported");
}
check("unknown sale type is unsupported", catalog.saleTypeTreatment("Made up"), "unsupported");
check("blank sale type is unsupported", catalog.saleTypeTreatment(""), "unsupported");
check("exactly five supported sale types", catalog.SUPPORTED_SALE_TYPES.length, 5);
for (const risky of ["Petroleum Products", "Services", "Services (FED in ST Mode)", "Goods (FED in ST Mode)", "Electric Vehicle", "Cement /Concrete Block", "Cement/Concrete Block", "Mobile Phones", "SIM", "Steel melting and re-rolling", "Ship breaking", "Non-Adjustable Supplies", "Toll Manufacturing", "CNG Sales", "Gas to CNG stations", "DTRE goods", "Cotton ginners"]) {
  check(`risky type "${risky}" is never supported`, catalog.saleTypeTreatment(risky), "unsupported");
}

// ---------------------------------------------------------------------------
// 4. Catalog: valid, dated, sourced
// ---------------------------------------------------------------------------

check("shipped catalog is valid", validateCatalog(catalog.FBR_GOODS_RULES, SALES_TEMPLATE, PURCHASE_TEMPLATE), []);
check("every rule has a source, a section and a verified date", catalog.FBR_GOODS_RULES.every((r) => r.source.length > 20 && r.section.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(r.verifiedOn)), true);
check("every required id exists", catalog.REQUIRED_RULE_IDS.every((id) => catalog.FBR_GOODS_RULES.some((r) => r.id === id)), true);
check("no blog is cited as a source", catalog.FBR_GOODS_RULES.some((r) => /blog|paktaxcalc|pakera|bacoconsultants|allpktaxes|legalpk|kambohassociates/i.test(r.source)), false);

// Rule values by date. Dates are the first and last days each row applies.
const num = (id, date) => catalog.findRuleNumber(id, date);
check("standard rate before 2023-02-14", num("fbr.rate.standard", "2023-02-13"), null);
check("standard rate on 2023-02-14", num("fbr.rate.standard", "2023-02-14"), 0.18);
check("standard rate Aug 2026", num("fbr.rate.standard", "2026-08-31"), 0.18);
check("further tax before 2023-07-01", num("fbr.rate.further_tax", "2023-06-30"), null);
check("further tax on 2023-07-01", num("fbr.rate.further_tax", "2023-07-01"), 0.04);
check("cap percent Aug 2026", num("fbr.s8b.cap_percent", "2026-08-31"), 90);
check("capital goods outside cap", catalog.findRule("fbr.s8b.capital_goods_outside_cap", "2026-08-31").value, true);
check("annex-c day", num("fbr.due.annex_c_day", "2026-08-31"), 10);
check("payment day", num("fbr.due.payment_day", "2026-08-31"), 15);
check("return day", num("fbr.due.return_day", "2026-08-31"), 18);
check("penalty before 2026-07-01 is not loaded", num("fbr.penalty.late_return.fixed", "2026-06-30"), null);
check("penalty on 2026-07-01", num("fbr.penalty.late_return.fixed", "2026-07-01"), 50000);
check("per day penalty", num("fbr.penalty.late_return.per_day", "2026-07-01"), 2000);
check("per day window", num("fbr.penalty.late_return.per_day_window", "2026-07-01"), 10);
check("surcharge annual", num("fbr.default_surcharge.annual_percent", "2026-08-31"), 12);
check("surcharge margin", num("fbr.default_surcharge.kibor_margin", "2026-08-31"), 3);
check("unknown rule id", num("fbr.nothing", "2026-08-31"), null);
check("a flag is not a number", num("fbr.s8b.capital_goods_outside_cap", "2026-08-31"), null);

// A later row takes over on its start date; overlapping rows are caught.
{
  const base = catalog.FBR_GOODS_RULES.find((r) => r.id === "fbr.rate.standard");
  const rows = [
    { ...base, effectiveFrom: "2023-02-14", effectiveTo: "2027-06-30", value: 0.18 },
    { ...base, effectiveFrom: "2027-07-01", effectiveTo: null, value: 0.17 },
  ];
  check("old row on its last day", catalog.findRuleNumber("fbr.rate.standard", "2027-06-30", rows), 0.18);
  check("new row on its first day", catalog.findRuleNumber("fbr.rate.standard", "2027-07-01", rows), 0.17);
  let threw = false;
  try {
    catalog.findRuleNumber("fbr.rate.standard", "2027-01-01", [rows[0], { ...rows[0], value: 0.2 }]);
  } catch (error) {
    threw = true;
  }
  check("overlapping rows make the lookup throw", threw, true);
}

// ---------------------------------------------------------------------------
// 5. A bad catalog is rejected for each kind of fault
// ---------------------------------------------------------------------------

function faults(mutate) {
  const rules = catalog.FBR_GOODS_RULES.map((r) => ({ ...r }));
  mutate(rules);
  return validateCatalog(rules, SALES_TEMPLATE, PURCHASE_TEMPLATE);
}
const std = (rules) => rules.find((r) => r.id === "fbr.rate.standard");
const has = (list, text) => list.some((p) => p.includes(text));

check("missing source", has(faults((r) => { std(r).source = ""; }), "missing source"), true);
check("missing section", has(faults((r) => { std(r).section = ""; }), "missing section"), true);
check("missing title", has(faults((r) => { std(r).title = ""; }), "missing title"), true);
check("bad start date", has(faults((r) => { std(r).effectiveFrom = "2023-13-40"; }), "effectiveFrom"), true);
check("bad end date", has(faults((r) => { std(r).effectiveTo = "soon"; }), "effectiveTo is not"), true);
check("end before start", has(faults((r) => { std(r).effectiveTo = "2020-01-01"; }), "before effectiveFrom"), true);
check("bad verified date", has(faults((r) => { std(r).verifiedOn = ""; }), "verifiedOn"), true);
check("fraction above 1", has(faults((r) => { std(r).value = 18; }), "fraction"), true);
check("negative value", has(faults((r) => { std(r).value = -0.18; }), "negative"), true);
check("non finite value", has(faults((r) => { std(r).value = NaN; }), "finite"), true);
check("text where a number is needed", has(faults((r) => { std(r).value = "0.18"; }), "numeric value"), true);
check("flag with a number", has(faults((r) => { r.find((x) => x.unit === "flag").value = 1; }), "flag"), true);
check("percent above 100", has(faults((r) => { r.find((x) => x.id === "fbr.s8b.cap_percent").value = 190; }), "percent"), true);
check("due day 31 refused", has(faults((r) => { r.find((x) => x.id === "fbr.due.return_day").value = 31; }), "due day"), true);
check("missing required rule", has(faults((r) => { r.splice(r.findIndex((x) => x.id === "fbr.rate.further_tax"), 1); }), "Required rule fbr.rate.further_tax"), true);
check("overlapping rows", has(faults((r) => { r.push({ ...std(r), value: 0.17 }); }), "same days"), true);
check("standard rate not in the official list", has(faults((r) => { std(r).value = 0.1801; }), "standard rate is not in the official sales rate list"), true);
check("no id", has(faults((r) => { std(r).id = ""; }), "no id"), true);
check("template without a supported sale type", validateCatalog(catalog.FBR_GOODS_RULES, { ...SALES_TEMPLATE, saleTypes: SALES_TEMPLATE.saleTypes.filter((n) => n !== "Exempt goods") }, PURCHASE_TEMPLATE).some((p) => p.includes("Exempt goods")), true);
check("template without the Exempt rate", validateCatalog(catalog.FBR_GOODS_RULES, { ...SALES_TEMPLATE, rates: SALES_TEMPLATE.rates.filter((x) => x !== "Exempt") }, PURCHASE_TEMPLATE).some((p) => p.includes("Exempt")), true);

// ---------------------------------------------------------------------------
// 6. Messages
// ---------------------------------------------------------------------------

{
  const everything = {
    field: "Value", value: "x", found: "1.0.1", expected: "1.0.44", count: 2, party: "buyer",
    stated: "Rs 1.00", rate: "18%", saleType: "Goods", detail: "Detail.", kind: "reduced-rate",
    noteKind: "credit note", firstRow: 6, gdNo: "G1", documentNo: "E1", rule: "x",
  };
  for (const code of PROBLEM_CODES) {
    const problem = makeProblem(code, "sales", 9, everything);
    check(`message ${code} has text`, problem.message.length > 10 && problem.action.length > 5, true);
    check(`message ${code} has no placeholder leak`, /undefined|\[object|NaN|\$\{/.test(problem.message + problem.action), false);
    check(`message ${code} severity`, ["refuse", "error", "warning"].includes(problem.severity), true);
  }
  let threw = false;
  try { makeProblem("not_a_code", "sales", 1); } catch (e) { threw = true; }
  check("unknown code throws", threw, true);
  check("override severity", makeProblem("row_tax_mismatch", "sales", 1, everything, "warning").severity, "warning");
  check("row is kept", makeProblem("row_tax_mismatch", "sales", 12, everything).row, 12);
  check("row null for sheet problem", makeProblem("template_layout_changed", "template", null, { sheet: "sales" }).row, null);
}

// Every code used in the library exists in the message table.
{
  const dir = path.join(projectRoot, "lib", "sales-tax");
  const used = new Set();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && entry.name !== "problems.ts") {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/makeProblem\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
        for (const m of text.matchAll(/add\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
      }
    }
  };
  walk(dir);
  check("library uses at least 30 message codes", used.size >= 30, true);
  check("every used code is defined", [...used].filter((c) => !PROBLEM_CODES.includes(c)), []);
  check("every defined code is used", PROBLEM_CODES.filter((c) => !used.has(c)), []);
}

// ---------------------------------------------------------------------------
// 7. Code hygiene: no Roman Urdu or Urdu script in the new library
// ---------------------------------------------------------------------------

{
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|cjs|json)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(projectRoot, "lib", "sales-tax"));
  const urduScript = /[\u0600-\u06FF]/;
  const romanUrdu = /\b(hai|nahi|nahin|kya|kro|krna|mujhe|apna|yeh|woh|bina|puchy|abhi|lekin|matlab)\b/i;
  const bad = files.filter((f) => {
    const text = fs.readFileSync(f, "utf8");
    return urduScript.test(text) || romanUrdu.test(text);
  });
  check("no Urdu script or Roman Urdu in lib/sales-tax", bad.map((f) => path.relative(projectRoot, f)), []);
}

finish();
