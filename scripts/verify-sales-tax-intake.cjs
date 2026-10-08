/**
 * Sales tax intake: template reading, header checks, invoice row checks and
 * the three synthetic month fixtures worked end to end.
 *
 * Each row check is exercised twice: a clean row must raise nothing, and a
 * row broken in exactly one way must raise exactly the matching problem.
 * All data is synthetic.
 */

const fs = require("fs");
const path = require("path");
const { load, R, sale, purchase, PERIOD, projectRoot, createChecker } = require("./lib/sales-tax-test-kit.cjs");

const reader = load("lib/sales-tax/template-reader.ts");
const checks = load("lib/sales-tax/invoice-checks.ts");
const { prepareMonth } = load("lib/sales-tax/prepare-month.ts");
const { SALES_TEMPLATE, PURCHASE_TEMPLATE } = load("lib/sales-tax/rules/fbr-goods/reference.ts");

const { check, finish } = createChecker("verify-sales-tax-intake");

const REG = "1000000000000";

// ---------------------------------------------------------------------------
// Grid helpers: official header rows plus caller-supplied cells.
// ---------------------------------------------------------------------------

function grid(ref, kind, period, version, dataRows, overrides = {}) {
  const rows = ref.headerRows.map((r) => r.slice());
  rows[1][2] = overrides.registration !== undefined ? overrides.registration : REG;
  rows[1][5] = overrides.periodCell !== undefined ? overrides.periodCell : new Date(Date.UTC(period.year, period.month - 1, 1));
  rows[2][1] = overrides.marker !== undefined ? overrides.marker : `${REG}-01/${String(period.month).padStart(2, "0")}/${period.year}_~_${kind}_~_${version}`;
  rows[2][9] = overrides.invalid !== undefined ? overrides.invalid : 0;
  if (overrides.mutateHeader) overrides.mutateHeader(rows);
  return [...rows, ...dataRows];
}

function salesCells(o = {}) {
  const c = reader.SALES_COLUMNS;
  const r = new Array(31).fill(null);
  r[c.sr] = 1;
  r[c.partyRegistrationNo] = "1234567";
  r[c.partyName] = "Al-Noor Traders";
  r[c.partyType] = "Registered";
  r[c.originProvince] = "SINDH";
  r[c.destinationProvince] = "SINDH";
  r[c.documentType] = "Sale Invoice";
  r[c.documentNo] = "INV-1";
  r[c.documentDate] = new Date(Date.UTC(2026, 7, 10));
  r[c.saleType] = "Goods at standard rate (default)";
  r[c.rate] = 0.18;
  r[c.value] = 1000;
  r[c.salesTax] = 180;
  for (const [key, value] of Object.entries(o)) r[c[key]] = value;
  return r;
}

function purchaseCells(o = {}) {
  const c = reader.PURCHASE_COLUMNS;
  const r = new Array(31).fill(null);
  r[c.sr] = 1;
  r[c.partyRegistrationNo] = "9988776";
  r[c.partyName] = "Sindh Wholesale";
  r[c.partyType] = "Registered";
  r[c.originProvince] = "SINDH";
  r[c.destinationProvince] = "SINDH";
  r[c.documentType] = "Purchase Invoice";
  r[c.documentNo] = "PI-1";
  r[c.documentDate] = new Date(Date.UTC(2026, 7, 5));
  r[c.purchaseType] = "Goods at standard rate (default)";
  r[c.rate] = 0.18;
  r[c.value] = 500;
  r[c.salesTax] = 90;
  for (const [key, value] of Object.entries(o)) r[c[key]] = value;
  return r;
}

const codesOf = (problems) => problems.map((p) => p.code);

// ---------------------------------------------------------------------------
// A. Reading the template
// ---------------------------------------------------------------------------

{
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [salesCells()]);
  const out = reader.readSalesSheet(g);
  check("A1 readable", out.readable, true);
  check("A1 no read problems", out.problems, []);
  check("A1 one row", out.rows.length, 1);
  const row = out.rows[0];
  check("A1 source row number", row.sourceRow, 6);
  check("A1 buyer id kept as text", row.buyerRegistrationNo, "1234567");
  check("A1 date", row.documentDate, "2026-08-10");
  check("A1 value paisa", row.valueExclTax, 100000);
  check("A1 tax paisa", row.salesTax, 18000);
  check("A1 blank amount stays null", row.furtherTax, null);
  check("A1 rate is a number", row.rate, 0.18);
  check("A1 header registration", out.header.registrationNo, REG);
  check("A1 header period", out.header.taxPeriod, { year: 2026, month: 8 });
  check("A1 header version", out.header.version, "1.0.44");
  check("A1 header kind", out.header.markerKind, "DSI");
  check("A1 invalid records", out.header.invalidRecordsReported, 0);
}

{
  // A2: moved column header means the file cannot be read.
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [salesCells()], {
    mutateHeader: (rows) => { rows[3][15] = "Value incl. tax"; },
  });
  const out = reader.readSalesSheet(g);
  check("A2 not readable", out.readable, false);
  check("A2 no rows", out.rows.length, 0);
  check("A2 code", codesOf(out.problems), ["template_layout_changed"]);
}

{
  // A3: a version we have not checked.
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.45", [salesCells()], {
    marker: `${REG}-01/08/2026_~_DSI_~_1.0.45`,
  });
  const out = reader.readSalesSheet(g);
  check("A3 not readable", out.readable, false);
  check("A3 code", codesOf(out.problems), ["template_version_unsupported"]);
  check("A3 message names both versions", /1\.0\.45/.test(out.problems[0].message) && /1\.0\.44/.test(out.problems[0].action), true);
}

{
  // A4: a purchase file given as a sales file.
  const g = grid(SALES_TEMPLATE, "DPI", PERIOD, "1.0.29", [salesCells()], {
    marker: `${REG}-01/08/2026_~_DPI_~_1.0.29`,
  });
  const out = reader.readSalesSheet(g);
  check("A4 code", codesOf(out.problems), ["template_wrong_kind"]);
  check("A4 not readable", out.readable, false);
}

{
  // A5: no version marker at all.
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [salesCells()], { marker: "" });
  const out = reader.readSalesSheet(g);
  check("A5 not readable", out.readable, false);
  check("A5 code", codesOf(out.problems), ["template_layout_changed"]);
}

{
  // A6: empty rows and pre-numbered blank rows are skipped.
  const blank = new Array(31).fill(null);
  const numberedOnly = new Array(31).fill(null);
  numberedOnly[0] = 2;
  const whitespace = new Array(31).fill(null);
  whitespace[1] = "   ";
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [blank, salesCells(), numberedOnly, whitespace, []]);
  const out = reader.readSalesSheet(g);
  check("A6 only the real row", out.rows.map((r) => r.sourceRow), [7]);
}

{
  // A7: dates as Excel serial, DD/MM/YYYY text and ISO text.
  const serial = Math.round((Date.UTC(2026, 7, 10) - Date.UTC(1899, 11, 30)) / 86400000);
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [
    salesCells({ documentDate: serial }),
    salesCells({ documentDate: "10/08/2026", documentNo: "INV-2" }),
    salesCells({ documentDate: "2026-08-10", documentNo: "INV-3" }),
  ]);
  const out = reader.readSalesSheet(g);
  check("A7 three dates equal", out.rows.map((r) => r.documentDate), ["2026-08-10", "2026-08-10", "2026-08-10"]);
}

{
  // A8: unreadable date and amount are reported once and not also called "missing".
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [
    salesCells({ documentDate: "tomorrow", value: "abc" }),
  ]);
  const out = reader.readSalesSheet(g);
  check("A8 read problems", codesOf(out.problems), ["row_unreadable_cell", "row_unreadable_cell"]);
  check("A8 flags", out.rows[0].unreadableFields, ["Date", "Value of Sales Excluding Sales Tax"]);
  const rowProblems = checks.checkSalesRows(out.rows, PERIOD);
  check("A8 not double reported as missing", rowProblems.some((p) => p.code === "row_missing_field"), false);
}

{
  // A9: registration number typed as a number keeps every digit; amounts as text with commas.
  const g = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [
    salesCells({ partyRegistrationNo: 4210112345671, value: "1,234.50", salesTax: "222.21" }),
  ]);
  const out = reader.readSalesSheet(g);
  check("A9 id digits", out.rows[0].buyerRegistrationNo, "4210112345671");
  check("A9 text amount", out.rows[0].valueExclTax, 123450);
}

{
  // A10: the purchase sheet.
  const g = grid(PURCHASE_TEMPLATE, "DPI", PERIOD, "1.0.29", [purchaseCells()]);
  const out = reader.readPurchaseSheet(g);
  check("A10 readable", out.readable, true);
  check("A10 problems", out.problems, []);
  check("A10 value", out.rows[0].valueExclTax, 50000);
  check("A10 type", out.rows[0].purchaseType, "Goods at standard rate (default)");
  check("A10 seller type", out.rows[0].sellerType, "Registered");
  const bad = reader.readPurchaseSheet(grid(PURCHASE_TEMPLATE, "DPI", PERIOD, "1.0.30", [purchaseCells()], { marker: `${REG}-01/08/2026_~_DPI_~_1.0.30` }));
  check("A10 version refused", codesOf(bad.problems), ["template_version_unsupported"]);
}

{
  // A11: a layout test against the real header text: each expected column holds the expected header.
  const headers = SALES_TEMPLATE.headerRows;
  const c = reader.SALES_COLUMNS;
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  check("A11 value column header", norm(headers[3][c.value]), "Value of Sales Excluding Sales Tax");
  check("A11 sales tax column header", norm(headers[3][c.salesTax]), "Sales Tax/ FED in ST Mode");
  check("A11 further tax header", norm(headers[3][c.furtherTax]), "Further Tax");
  check("A11 withheld header", norm(headers[3][c.stWithheld]), "ST Withheld at Source");
  check("A11 sale type header", norm(headers[3][c.saleType]), "Sale Type");
  check("A11 rate header", norm(headers[3][c.rate]), "Rate");
  check("A11 document no header", norm(headers[4][c.documentNo]), "Number");
  check("A11 document date header", norm(headers[4][c.documentDate]), "Date");
  check("A11 buyer id header", norm(headers[4][c.partyRegistrationNo]), "Registration No");
  check("A11 reason header", norm(headers[3][c.reason]), "Reasons");
  check("A11 invoice ref header", norm(headers[3][c.invoiceRefNo]), "Invoice Reference No.");
  check("A11 sro header", norm(headers[4][c.exemptionSroNo]), "SRO No./ Schedule No.");
  const p = PURCHASE_TEMPLATE.headerRows;
  const pc = reader.PURCHASE_COLUMNS;
  check("A11 purchase value header", norm(p[3][pc.value]), "Value of Purchases");
  check("A11 purchase withheld header", norm(p[3][pc.stWithheld]), "ST Withheld as WH Agent");
  check("A11 purchase fed header", norm(p[3][pc.fedCharged]), "FED Charged");
  check("A11 purchase type header", norm(p[3][pc.purchaseType]), "Purchase Type");
}

// ---------------------------------------------------------------------------
// B. Header against client and month
// ---------------------------------------------------------------------------

{
  const owner = { registrationNo: "1000000000000", period: PERIOD };
  const header = { registrationNo: "1000000000000", taxPeriod: PERIOD, invalidRecordsReported: 0 };
  check("B1 clean header", checks.checkSheetHeader(header, "sales", owner), []);
  check("B2b same digits with dashes", checks.checkSheetHeader({ ...header, registrationNo: "10-00-00-0000-000" }, "sales", { ...owner, registrationNo: "1000000000000" }), []);
  check("B3 other client", codesOf(checks.checkSheetHeader({ ...header, registrationNo: "2000000000000" }, "sales", owner)), ["template_registration_mismatch"]);
  check("B4 other month", codesOf(checks.checkSheetHeader({ ...header, taxPeriod: { year: 2026, month: 7 } }, "sales", owner)), ["template_period_mismatch"]);
  check("B5 other year", codesOf(checks.checkSheetHeader({ ...header, taxPeriod: { year: 2025, month: 8 } }, "purchases", owner)), ["template_period_mismatch"]);
  check("B6 blank period", codesOf(checks.checkSheetHeader({ ...header, taxPeriod: null }, "sales", owner)), ["template_period_mismatch"]);
  const warn = checks.checkSheetHeader({ ...header, invalidRecordsReported: 3 }, "sales", owner);
  check("B7 invalid rows reported", warn.map((p) => [p.code, p.severity]), [["template_reports_invalid_rows", "warning"]]);
}

// ---------------------------------------------------------------------------
// C. Row checks: clean row raises nothing, each break raises its own problem.
// ---------------------------------------------------------------------------

function salesProblems(rows) {
  return checks.checkSalesRows(rows, PERIOD);
}
function purchaseProblems(rows) {
  return checks.checkPurchaseRows(rows, PERIOD);
}
const only = (problems) => codesOf(problems).sort();

check("C0 clean sale raises nothing", only(salesProblems([sale(1000, 180)])), []);
check("C0 clean registered purchase only the supplier note", only(purchaseProblems([purchase(500, 90)])), ["purchase_supplier_status_unknown"]);

// Missing required fields.
for (const [field, label] of [
  ["buyerType", "Buyer type"],
  ["originProvince", "Sale Origination Province of Supplier"],
  ["destinationProvince", "Destination of Supply"],
  ["documentType", "Document Type"],
  ["documentNo", "Document Number"],
  ["saleType", "Sale Type"],
]) {
  const p = salesProblems([sale(1000, 180, { [field]: "" })]);
  check(`C1 missing ${field}`, p.some((x) => x.code === "row_missing_field" && x.message.includes(label)), true);
}
check("C1 missing date", only(salesProblems([sale(1000, 180, { documentDate: null })])), ["row_missing_field"]);
check("C1 missing value", salesProblems([sale(1000, 180, { valueExclTax: null })]).some((x) => x.code === "row_missing_field"), true);
check("C1 missing rate", salesProblems([sale(1000, 180, { rate: null })]).some((x) => x.code === "row_missing_field"), true);
check("C1 missing tax on a taxed row", salesProblems([sale(1000, 180, { salesTax: null })]).some((x) => x.code === "row_missing_field"), true);
check("C1 blank tax on a zero-rated row is zero", only(salesProblems([sale(1000, 0, { salesTax: null, saleType: "Goods at zero-rate", rate: 0, exemptionSroNo: "FIFTH SCHEDULE" })])), []);

// Choices must be in the template lists.
check("C2 unknown province", only(salesProblems([sale(1000, 180, { originProvince: "ATLANTIS" })])), ["row_value_not_in_list"]);
check("C2 unknown buyer type", salesProblems([sale(1000, 180, { buyerType: "Friend" })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C2 unknown document type", salesProblems([sale(1000, 180, { documentType: "Receipt" })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C2 unknown sale type raises only the list problem", only(salesProblems([sale(1000, 180, { saleType: "Goods for friends" })])), ["row_value_not_in_list"]);
check("C2 rate not offered", salesProblems([sale(1000, 173, { rate: 0.173 })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C2 unknown reason", salesProblems([sale(1000, 180, { reason: "Felt like it" })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C2 unknown sro", salesProblems([sale(1000, 180, { exemptionSroNo: "999(I)/1999" })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C2 unknown item serial", salesProblems([sale(1000, 180, { exemptionItemSrNo: "ZZZ" })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C2 known sro and item pass", only(salesProblems([sale(1000, 180, { exemptionSroNo: "237(I)/2020", exemptionItemSrNo: "1" })])), []);

// Negative amounts.
check("C3 negative value", salesProblems([sale(-1000, -180)]).filter((x) => x.code === "row_negative_amount").length, 2);

// Date inside the month.
check("C4 date before month", only(salesProblems([sale(1000, 180, { documentDate: "2026-07-31" })])), ["row_date_outside_period"]);
check("C4 date after month", only(salesProblems([sale(1000, 180, { documentDate: "2026-09-01" })])), ["row_date_outside_period"]);
check("C4 first day ok", only(salesProblems([sale(1000, 180, { documentDate: "2026-08-01" })])), []);
check("C4 last day ok", only(salesProblems([sale(1000, 180, { documentDate: "2026-08-31" })])), []);

// Duplicates and reused numbers.
{
  const a = sale(1000, 180, { documentNo: "X-1" });
  const dup = { ...a, sourceRow: a.sourceRow + 50 };
  check("C5 exact duplicate", salesProblems([a, dup]).map((x) => [x.code, x.row]), [["row_duplicate", dup.sourceRow]]);
  const other = sale(2000, 360, { documentNo: "X-1", buyerName: "Someone else", buyerRegistrationNo: "7654321" });
  check("C5 number reused for another buyer", only(salesProblems([a, other])), ["row_invoice_number_reused"]);
  const lineTwo = sale(500, 90, { documentNo: "X-1", buyerName: a.buyerName, buyerRegistrationNo: a.buyerRegistrationNo, documentDate: a.documentDate });
  check("C5 second item line on the same invoice is fine", only(salesProblems([a, lineTwo])), []);
  const noteSame = sale(100, 18, { documentNo: "X-1", documentType: "Credit Note", invoiceRefNo: "X-1", reason: "Return of goods", buyerName: "Someone else", buyerRegistrationNo: "7654321" });
  check("C5 same number as a different document type is fine", only(salesProblems([a, noteSame])), []);
}

// Credit and debit notes.
check("C6 credit note without reference", only(salesProblems([sale(100, 18, { documentType: "Credit Note" })])), ["row_note_reference_missing"]);
check("C6 credit note with reference only", only(salesProblems([sale(100, 18, { documentType: "Credit Note", invoiceRefNo: "INV-1" })])), ["row_note_reference_missing"]);
check("C6 debit note without reason", only(salesProblems([sale(100, 18, { documentType: "Debit Note", invoiceRefNo: "INV-1" })])), ["row_note_reference_missing"]);
check("C6 complete credit note", only(salesProblems([sale(100, 18, { documentType: "Credit Note", invoiceRefNo: "INV-1", reason: "Return of goods" })])), []);
check("C6 sale invoice needs no reference", only(salesProblems([sale(100, 18)])), []);

// Party registration numbers.
check("C7 registered buyer without id", only(salesProblems([sale(1000, 180, { buyerRegistrationNo: "" })])), ["row_party_id_missing"]);
check("C7 odd id length", only(salesProblems([sale(1000, 180, { buyerRegistrationNo: "12345" })])), ["row_party_id_unusual"]);
check("C7 id with dashes passes by digit count", only(salesProblems([sale(1000, 180, { buyerRegistrationNo: "42101-1234567-1" })])), []);
check("C7 NTN with check digit (8 digits)", only(salesProblems([sale(1000, 180, { buyerRegistrationNo: "1234567-8" })])), []);
check("C7 unregistered without id is a warning", salesProblems([sale(1000, 180, { buyerType: "Unregistered", buyerRegistrationNo: "", furtherTax: R(40) })]).map((x) => [x.code, x.severity]), [["row_unregistered_buyer_without_id", "warning"]]);
check("C7 unregistered distributor without id", salesProblems([sale(1000, 180, { buyerType: "Unregistered Distributor", buyerRegistrationNo: "", furtherTax: R(40) })]).map((x) => x.code), ["row_unregistered_buyer_without_id"]);
check("C7 retail consumer needs no id", only(salesProblems([sale(1000, 180, { buyerType: "Retail Consumer", buyerRegistrationNo: "", furtherTax: R(40) })])), []);
check("C7 purchase from registered seller without id", purchaseProblems([purchase(500, 90, { sellerRegistrationNo: "" })]).some((x) => x.code === "row_party_id_missing"), true);

// Value x rate against stated tax.
check("C8 tax too high", only(salesProblems([sale(1000, 190)])), ["row_tax_mismatch"]);
check("C8 tax too low", only(salesProblems([sale(1000, 170)])), ["row_tax_mismatch"]);
check("C8 within Re 1 passes", only(salesProblems([sale(1000, 180.99)])), []);
check("C8 just over Re 1 fails", only(salesProblems([sale(1000, 181.01)])), ["row_tax_mismatch"]);
check("C8 rounding case 100.10 at 18%", only(salesProblems([sale(100.1, 18.02)])), []);
check("C8 mismatch message shows both figures", /Rs 190\.00/.test(salesProblems([sale(1000, 190)])[0].message) && /Rs 180\.00/.test(salesProblems([sale(1000, 190)])[0].message), true);
check("C8 zero-rated with tax", salesProblems([sale(1000, 10, { saleType: "Goods at zero-rate", rate: 0, exemptionSroNo: "FIFTH SCHEDULE" })]).some((x) => x.code === "row_tax_mismatch"), true);
check("C8 exempt with tax", salesProblems([sale(1000, 10, { saleType: "Exempt goods", rate: "Exempt", exemptionSroNo: "SECTION 49" })]).some((x) => x.code === "row_tax_mismatch"), true);

// Rate must fit the sale type.
check("C9 standard goods at a reduced rate", salesProblems([sale(1000, 50, { rate: 0.05 })]).some((x) => x.code === "row_rate_not_expected"), true);
check("C9 zero-rated at 18%", salesProblems([sale(1000, 180, { saleType: "Goods at zero-rate", rate: 0.18, exemptionSroNo: "FIFTH SCHEDULE" })]).some((x) => x.code === "row_rate_not_expected"), true);
check("C9 exempt without Exempt rate", salesProblems([sale(1000, 0, { saleType: "Exempt goods", rate: 0, exemptionSroNo: "SECTION 49" })]).some((x) => x.code === "row_rate_not_expected"), true);
check("C9 reduced at the standard rate", salesProblems([sale(1000, 180, { saleType: "Goods at Reduced Rate", rate: 0.18, exemptionSroNo: "6th Schd Table I" })]).some((x) => x.code === "row_rate_not_expected"), true);
check("C9 reduced at zero", salesProblems([sale(1000, 0, { saleType: "Goods at Reduced Rate", rate: 0, exemptionSroNo: "6th Schd Table I" })]).some((x) => x.code === "row_rate_not_expected"), true);
check("C9 valid reduced row", only(salesProblems([sale(1000, 50, { saleType: "Goods at Reduced Rate", rate: 0.05, exemptionSroNo: "6th Schd Table I" })])), []);
check("C9 reduced without reference is a warning", salesProblems([sale(1000, 50, { saleType: "Goods at Reduced Rate", rate: 0.05 })]).map((x) => [x.code, x.severity]), [["row_reference_missing", "warning"]]);
check("C9 third schedule without retail price", salesProblems([sale(1000, 180, { saleType: "3rd Schedule Goods" })]).some((x) => x.code === "row_retail_price_missing"), true);
check("C9 third schedule tax on retail price", only(salesProblems([sale(800, 180, { saleType: "3rd Schedule Goods", fixedOrRetailValue: R(1000) })])), []);
check("C9 third schedule tax on wrong base", salesProblems([sale(800, 144, { saleType: "3rd Schedule Goods", fixedOrRetailValue: R(1000) })]).some((x) => x.code === "row_tax_mismatch"), true);

// Further tax (s.3(1A)) on supplies to unregistered buyers.
check("C10 no further tax on unregistered sale", salesProblems([sale(1000, 180, { buyerType: "Unregistered", buyerRegistrationNo: "4210112345671" })]).map((x) => [x.code, x.severity]), [["row_further_tax_missing", "warning"]]);
check("C10 further tax correct", only(salesProblems([sale(1000, 180, { buyerType: "Unregistered", buyerRegistrationNo: "4210112345671", furtherTax: R(40) })])), []);
check("C10 further tax wrong amount", salesProblems([sale(1000, 180, { buyerType: "Unregistered", buyerRegistrationNo: "4210112345671", furtherTax: R(30) })]).map((x) => [x.code, x.severity]), [["row_further_tax_mismatch", "warning"]]);
check("C10 registered buyer needs none", only(salesProblems([sale(1000, 180)])), []);
check("C10 zero-rated sale to unregistered not checked", only(salesProblems([sale(1000, 0, { saleType: "Goods at zero-rate", rate: 0, exemptionSroNo: "FIFTH SCHEDULE", buyerType: "Unregistered", buyerRegistrationNo: "4210112345671" })])), []);
check("C10 further tax uses retail price for third schedule", only(salesProblems([sale(800, 180, { saleType: "3rd Schedule Goods", fixedOrRetailValue: R(1000), buyerType: "Unregistered", buyerRegistrationNo: "4210112345671", furtherTax: R(40) })])), []);

// Unsupported things are refused, never guessed.
for (const saleType of SALES_TEMPLATE.saleTypes) {
  const supported = ["Goods at standard rate (default)", "Goods at Reduced Rate", "Goods at zero-rate", "Exempt goods", "3rd Schedule Goods"].includes(saleType);
  const p = salesProblems([sale(1000, 180, { saleType })]);
  check(`C11 sale type "${saleType}" refused=${!supported}`, p.some((x) => x.code === "row_unsupported_sale_type" && x.severity === "refuse"), !supported);
}
check("C11 withholding document", salesProblems([sale(1000, 180, { documentType: "STWH" })]).some((x) => x.code === "row_withholding_document" && x.severity === "refuse"), true);
check("C11 extra tax", salesProblems([sale(1000, 180, { extraTax: R(5) })]).some((x) => x.code === "row_extra_tax" && x.severity === "refuse"), true);
check("C11 pfad column", salesProblems([sale(1000, 180, { totalValuePfad: R(1000) })]).some((x) => x.code === "row_unsupported_column"), true);
check("C11 petroleum levy", salesProblems([sale(1000, 180, { petroleumLevyRate: "Direct Sale" })]).some((x) => x.code === "row_unsupported_column"), true);
check("C11 No Levy is fine", only(salesProblems([sale(1000, 180, { petroleumLevyRate: "No Levy" })])), []);
check("C11 additional sales tax rate", salesProblems([sale(1000, 180, { additionalSalesTaxRate: "x" })]).some((x) => x.code === "row_unsupported_column"), true);
check("C11 refused sale type needs no further checks", only(salesProblems([sale(1000, 999, { saleType: "Petroleum Products" })])), ["row_unsupported_sale_type"]);

// Purchases.
check("C12 purchase from unregistered with tax", purchaseProblems([purchase(500, 90, { sellerType: "Unregistered", sellerRegistrationNo: "" })]).map((x) => [x.code, x.severity]), [["purchase_unregistered_with_tax", "warning"]]);
check("C12 purchase from unregistered without tax", only(purchaseProblems([purchase(500, 0, { sellerType: "Unregistered", sellerRegistrationNo: "" })])), []);
check("C12 purchase tax mismatch", purchaseProblems([purchase(500, 100)]).some((x) => x.code === "row_tax_mismatch"), true);
check("C12 purchase fed charged", purchaseProblems([purchase(500, 90)].map((r) => ({ ...r, fedCharged: R(5) }))).some((x) => x.code === "row_unsupported_column"), true);
check("C12 purchase extra tax", purchaseProblems([purchase(500, 90, { extraTax: R(5) })]).some((x) => x.code === "row_extra_tax"), true);
check("C12 purchase withholding document", purchaseProblems([purchase(500, 90, { documentType: "STWH" })]).some((x) => x.code === "row_withholding_document"), true);
check("C12 purchase credit note needs reference", purchaseProblems([purchase(500, 90, { documentType: "Credit Note" })]).some((x) => x.code === "row_note_reference_missing"), true);
check("C12 purchase date outside month", purchaseProblems([purchase(500, 90, { documentDate: "2026-09-02" })]).some((x) => x.code === "row_date_outside_period"), true);
check("C12 purchase supplier type list", purchaseProblems([purchase(500, 90, { sellerType: "Unregistered Distributor" })]).some((x) => x.code === "row_value_not_in_list"), true);
check("C12 purchase unsupported type", purchaseProblems([purchase(500, 90, { purchaseType: "Online Marketplace" })]).some((x) => x.code === "row_unsupported_sale_type"), true);

// Imports and exports.
check("C13 import with value addition tax is refused", checks.checkImports([{ gdNo: "G1", gdDate: "2026-08-01", taxableValue: 100, salesTaxPaid: 18, valueAdditionTaxPaid: 3 }]).map((x) => [x.code, x.severity]), [["import_vat_unsupported", "refuse"]]);
check("C13 import negative amount", checks.checkImports([{ gdNo: "G1", gdDate: "2026-08-01", taxableValue: -1, salesTaxPaid: 0, valueAdditionTaxPaid: 0 }]).map((x) => x.code), ["import_invalid_amount"]);
check("C13 import fractional paisa", checks.checkImports([{ gdNo: "G1", gdDate: "2026-08-01", taxableValue: 1.5, salesTaxPaid: 0, valueAdditionTaxPaid: 0 }]).map((x) => x.code), ["import_invalid_amount"]);
check("C13 clean import", checks.checkImports([{ gdNo: "G1", gdDate: "2026-08-01", taxableValue: 100, salesTaxPaid: 18, valueAdditionTaxPaid: 0 }]), []);
check("C13 export negative", checks.checkExports([{ documentNo: "E1", documentDate: "2026-08-01", valueExclTax: -5 }]).map((x) => x.code), ["export_invalid_amount"]);
check("C13 clean export", checks.checkExports([{ documentNo: "E1", documentDate: "2026-08-01", valueExclTax: 5 }]), []);

// Messages are plain English: no snake_case codes leak into what the user reads.
{
  const samples = [
    ...salesProblems([sale(1000, 190), sale(1000, 180, { saleType: "Petroleum Products" }), sale(1000, 180, { buyerRegistrationNo: "" })]),
    ...purchaseProblems([purchase(500, 90, { sellerType: "Unregistered", sellerRegistrationNo: "" })]),
  ];
  const leaked = samples.filter((p) => /[a-z]+_[a-z_]+/.test(p.message + " " + p.action));
  check("C14 no technical codes in messages", leaked.length, 0);
  check("C14 every problem has message and action", samples.every((p) => p.message.length > 10 && p.action.length > 5), true);
}

// Several problems on one sheet are all reported, in row order.
{
  const rows = [sale(1000, 190), sale(1000, 180, { documentDate: "2026-09-09" })];
  const p = salesProblems(rows);
  check("C15 both rows reported", p.map((x) => [x.code, x.row]), [["row_tax_mismatch", rows[0].sourceRow], ["row_date_outside_period", rows[1].sourceRow]]);
}

// ---------------------------------------------------------------------------
// D. prepareMonth end to end on grids
// ---------------------------------------------------------------------------

{
  const okSales = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [salesCells({ value: 1000, salesTax: 180 })]);
  const okPurchases = grid(PURCHASE_TEMPLATE, "DPI", PERIOD, "1.0.29", [purchaseCells({ value: 500, salesTax: 90 })]);
  const r = prepareMonth({ registrationNo: REG, period: PERIOD, salesGrid: okSales, purchaseGrid: okPurchases });
  check("D1 estimate works", r.canEstimate, true);
  check("D1 output tax", r.bySr["15"].salesTax, 18000);
  check("D1 input tax", r.bySr["5"].salesTax, 9000);
  check("D1 line 32", r.bySr["32"].salesTax, 9000);

  const wrongClient = prepareMonth({ registrationNo: "2000000000000", period: PERIOD, salesGrid: okSales, purchaseGrid: okPurchases });
  check("D2 wrong client refused", wrongClient.canEstimate, false);
  check("D2 codes", codesOf(wrongClient.problems).filter((c) => c === "template_registration_mismatch").length, 2);
  check("D2 no figures leak", wrongClient.lines.length + (wrongClient.balancePayable === null ? 0 : 1), 0);

  const wrongMonth = prepareMonth({ registrationNo: REG, period: { year: 2026, month: 9 }, salesGrid: okSales, purchaseGrid: okPurchases });
  check("D3 wrong month refused", wrongMonth.canEstimate, false);

  const brokenLayout = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [salesCells()], { mutateHeader: (rows) => { rows[3][10] = "Kind"; } });
  const broken = prepareMonth({ registrationNo: REG, period: PERIOD, salesGrid: brokenLayout, purchaseGrid: okPurchases });
  check("D4 unreadable sheet refused", broken.canEstimate, false);
  check("D4 layout problem", codesOf(broken.problems).includes("template_layout_changed"), true);

  const noFiles = prepareMonth({ registrationNo: REG, period: PERIOD, salesGrid: null, purchaseGrid: null });
  check("D5 no files is an empty month", [noFiles.canEstimate, codesOf(noFiles.problems)], [true, ["no_invoices"]]);

  const capital = prepareMonth({ registrationNo: REG, period: PERIOD, salesGrid: okSales, purchaseGrid: okPurchases, capitalGoodsRows: [6] });
  check("D6 capital goods flag moves tax to Sr.4", [capital.bySr["1"].salesTax, capital.bySr["4"].salesTax], [0, 9000]);

  const invalidRows = grid(SALES_TEMPLATE, "DSI", PERIOD, "1.0.44", [salesCells()], { invalid: 2 });
  const warn = prepareMonth({ registrationNo: REG, period: PERIOD, salesGrid: invalidRows, purchaseGrid: null });
  check("D7 template-reported invalid rows is only a warning", [warn.canEstimate, codesOf(warn.problems)], [true, ["template_reports_invalid_rows"]]);

  const badPeriod = prepareMonth({ registrationNo: REG, period: { year: 2026, month: 0 }, salesGrid: okSales, purchaseGrid: null });
  check("D8 invalid period", [badPeriod.canEstimate, codesOf(badPeriod.problems)], [false, ["invalid_period"]]);
}

// ---------------------------------------------------------------------------
// E. The three synthetic months, worked by hand.
// ---------------------------------------------------------------------------

function loadMonth(name) {
  const data = JSON.parse(fs.readFileSync(path.join(projectRoot, "test-fixtures", "sales-tax", name), "utf8"));
  const adj = data.adjustments || {};
  const adjustments = {};
  if (adj.creditBroughtForwardRupees) adjustments.creditBroughtForward = R(adj.creditBroughtForwardRupees);
  if (adj.refundClaimed29Rupees) adjustments.refundClaimed29 = R(adj.refundClaimed29Rupees);
  return prepareMonth({
    registrationNo: data.registrationNo,
    period: data.period,
    salesGrid: data.salesGrid,
    purchaseGrid: data.purchaseGrid,
    imports: (data.imports || []).map((i) => ({ gdNo: i.gdNo, gdDate: i.gdDate, taxableValue: R(i.taxableValueRupees), salesTaxPaid: R(i.salesTaxPaidRupees), valueAdditionTaxPaid: R(i.valueAdditionTaxPaidRupees) })),
    exports: (data.exports || []).map((e) => ({ documentNo: e.documentNo, documentDate: e.documentDate, valueExclTax: R(e.valueRupees) })),
    adjustments,
    capitalGoodsRows: data.capitalGoodsRows,
  });
}

// Month A (August 2026), worked by hand.
//   Sales: 450,000 + 275,500 + 124,250.50 + 80,000 = 929,750.50
//   Output tax: 81,000 + 49,590 + 22,365.09 + 14,400 = 167,355.09
//   Further tax: 3,200 (4% of 80,000 to the unregistered buyer)
//   Purchases from registered: 300,000 + 180,400 = 480,400; input tax 54,000 + 32,472 = 86,472
//   Unregistered purchase: 50,000 (line 2, no credit)
//   Cap: 90% of 167,355.09 = 150,619.581 -> 150,619.58. Input 86,472 is below it, so 25 = 86,472.
//   32 = 167,355.09 - 86,472 + 3,200 = 84,083.09
{
  const r = loadMonth("month-2026-08.json");
  check("E-A can estimate", r.canEstimate, true);
  const t = (sr) => r.bySr[sr].salesTax;
  check("E-A Sr.9 gross", r.bySr["9"].grossValue, R(929_750.5));
  check("E-A Sr.9 tax", t("9"), R(167_355.09));
  check("E-A Sr.1 gross", r.bySr["1"].grossValue, R(480_400));
  check("E-A Sr.1 tax", t("1"), R(86_472));
  check("E-A Sr.2 gross", r.bySr["2"].grossValue, R(50_000));
  check("E-A Sr.5", t("5"), R(86_472));
  check("E-A Sr.15", t("15"), R(167_355.09));
  check("E-A Sr.23a", t("23a"), R(3_200));
  check("E-A Sr.25", t("25"), R(86_472));
  check("E-A Sr.26", t("26"), 0);
  check("E-A Sr.32", t("32"), R(84_083.09));
  check("E-A Sr.37", t("37"), R(84_083.09));
  check("E-A only the supplier note", codesOf(r.problems), ["purchase_supplier_status_unknown"]);
}

// Month B (July 2026), worked by hand.
//   Sales 2,000,000 + 1,500,000 - credit note 100,000 = 3,400,000; tax 360,000 + 270,000 - 18,000 = 612,000
//   Withheld by buyer 40,000 so 17 = 572,000
//   Input: ordinary 450,000, capital 180,000 -> 5 = 630,000; carried forward 25,000 -> 8 = 655,000
//   Cap 90% of 612,000 = 550,800. Ordinary part allowed = min(475,000, 550,800, 572,000) = 475,000.
//   Capital part = min(180,000, 655,000 - 475,000) = 180,000. 25 = min(655,000, 572,000) = 572,000.
//   26 = 83,000 carried forward. 32 = 0 (17 equals 25).
{
  const r = loadMonth("month-2026-07.json");
  check("E-B can estimate", r.canEstimate, true);
  const t = (sr) => r.bySr[sr].salesTax;
  check("E-B Sr.9 gross", r.bySr["9"].grossValue, R(3_400_000));
  check("E-B Sr.9 tax", t("9"), R(612_000));
  check("E-B Sr.16", t("16"), R(40_000));
  check("E-B Sr.17", t("17"), R(572_000));
  check("E-B Sr.1", t("1"), R(450_000));
  check("E-B Sr.4", t("4"), R(180_000));
  check("E-B Sr.5", t("5"), R(630_000));
  check("E-B Sr.6", t("6"), R(25_000));
  check("E-B Sr.8", t("8"), R(655_000));
  check("E-B Sr.25", t("25"), R(572_000));
  check("E-B Sr.26", t("26"), R(83_000));
  check("E-B Sr.30", t("30"), R(83_000));
  check("E-B Sr.32", t("32"), 0);
  check("E-B Sr.37", t("37"), 0);
}

// Month C (June 2026), worked by hand.
//   Local sale 200,000 tax 36,000; export 600,000 (line 11).
//   Input: purchase 162,000 + import 90,000 = 5 = 252,000; carried forward 10,000 -> 8 = 262,000
//   Cap 90% of 36,000 = 32,400. 25 = min(262,000, 32,400, 36,000) = 32,400. 26 = 229,600.
//   Refund claimed 100,000 -> 30 = 229,600 - 100,000 = 129,600. 32 = 36,000 - 32,400 = 3,600.
{
  const r = loadMonth("month-2026-06.json");
  check("E-C can estimate", r.canEstimate, true);
  const t = (sr) => r.bySr[sr].salesTax;
  check("E-C Sr.11 gross", r.bySr["11"].grossValue, R(600_000));
  check("E-C Sr.3", t("3"), R(90_000));
  check("E-C Sr.5", t("5"), R(252_000));
  check("E-C Sr.8", t("8"), R(262_000));
  check("E-C Sr.25", t("25"), R(32_400));
  check("E-C Sr.26", t("26"), R(229_600));
  check("E-C Sr.28", t("28"), R(229_600));
  check("E-C Sr.29", t("29"), R(100_000));
  check("E-C Sr.30", t("30"), R(129_600));
  check("E-C Sr.32", t("32"), R(3_600));
  check("E-C Sr.37", t("37"), R(3_600));
  check("E-C refund warning", codesOf(r.problems).includes("refund_needs_annex_h"), true);
}

// The fixtures carry their synthetic label.
for (const name of ["month-2026-06.json", "month-2026-07.json", "month-2026-08.json"]) {
  const data = JSON.parse(fs.readFileSync(path.join(projectRoot, "test-fixtures", "sales-tax", name), "utf8"));
  check(`E fixture ${name} is labelled synthetic`, /SYNTHETIC/.test(data._note), true);
}

finish();
