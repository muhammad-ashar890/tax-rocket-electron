/**
 * Sales Tax review and approval (Phase 3).
 *
 *   1. The figures form: every amount, row number, import and export is
 *      read or refused with a plain message; nothing is guessed.
 *   2. The estimate with typed figures, against numbers worked out by hand
 *      from the synthetic August 2026 month.
 *   3. The approval packet and its fingerprint.
 *   4. The REAL server actions against a REAL PostgreSQL database (skipped
 *      cleanly when none is reachable): saving figures, approving, losing
 *      the approval when anything changes, ownership, draft-only.
 *   5. The screens: estimate wording, the "I have reviewed" box, the steps.
 *
 * All data is synthetic. It proves the code only.
 */

const path = require("path");
const fs = require("fs");
const Module = require("module");
const ExcelJS = require("exceljs");

const kit = require("./lib/sales-tax-test-kit.cjs");
const { check, finish } = kit.createChecker("verify-sales-tax-review");
const root = kit.projectRoot;
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const R = kit.R;
const code = (relativePath) =>
  read(relativePath)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

let sessionEmail = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "next/cache") return { revalidatePath() {} };
  if (request === "next-auth/next") {
    return {
      getServerSession: async () =>
        sessionEmail ? { user: { email: sessionEmail, name: "Test" } } : null,
    };
  }
  if (request === "server-only") return {};
  if (request === "@/lib/auth" || request === path.join(root, "lib/auth")) {
    return { authOptions: {} };
  }
  return originalLoad.call(this, request, ...rest);
};

const figuresLib = kit.load("lib/sales-tax/figures.ts");
const estimateLib = kit.load("lib/sales-tax/estimate.ts");
const { validateFiguresForm, parseStoredFigures, figuresToForm, emptyFigures, emptyFiguresForm, ADJUSTMENT_FIELDS } = figuresLib;
const { buildEstimate, buildApprovalPacket, checkCapitalRows, fingerprintOf, isApprovalCurrent } = estimateLib;

const august = require(path.join(root, "test-fixtures/sales-tax/month-2026-08.json"));
const owner = { registrationNo: august.registrationNo, period: august.period };

function form(overrides = {}) {
  const base = emptyFiguresForm();
  return { ...base, ...overrides, adjustments: { ...base.adjustments, ...(overrides.adjustments || {}) } };
}
function figures(overrides = {}) {
  const base = emptyFigures();
  return { ...base, ...overrides, adjustments: { ...base.adjustments, ...(overrides.adjustments || {}) } };
}
const estimate = (f) =>
  buildEstimate({ ...owner, salesGrid: august.salesGrid, purchaseGrid: august.purchaseGrid, figures: f });
const tax = (result, sr) => result.bySr[sr].salesTax;

function runFiguresChecks() {
  // --- Blank and typed amounts. ---
  const blank = validateFiguresForm(form());
  check("an empty form is valid and means nothing entered", [blank.ok, blank.value], [true, emptyFigures()]);
  const typed = validateFiguresForm(form({ adjustments: { creditBroughtForward: "12,500.50", arrears23: " 1000 " } }));
  check("amounts with commas and spaces are read", [typed.value.adjustments.creditBroughtForward, typed.value.adjustments.arrears23], [R(12500.5), R(1000)]);
  for (const bad of ["abc", "-5", "1e5", "12.5.5", "Rs 5", "1,2,3x"]) {
    const result = validateFiguresForm(form({ adjustments: { inadmissible6a: bad } }));
    check(`the amount "${bad}" is refused`, [result.ok, typeof result.error === "string" && /Line 6a/.test(result.error)], [false, true]);
  }
  check("an amount that is far too large is refused", validateFiguresForm(form({ adjustments: { allowance7b: "99999999999999999" } })).ok, false);
  check("a non-object input is refused", [validateFiguresForm(null).ok, validateFiguresForm("x").ok, validateFiguresForm(undefined).ok], [false, false, false]);
  check("a missing adjustments object means zeros", validateFiguresForm({ excludedFrom8B: false }).ok, true);
  check("every adjustment field has a label and a hint", ADJUSTMENT_FIELDS.every((f) => f.label && f.hint && f.sr), true);
  check("the eight adjustment fields cover every engine adjustment", ADJUSTMENT_FIELDS.map((f) => f.key).sort(), Object.keys(emptyFigures().adjustments).sort());

  // --- Section 8B answer. ---
  check("excluded is only true when it is exactly true", [validateFiguresForm(form({ excludedFrom8B: true })).value.excludedFrom8B, validateFiguresForm(form({ excludedFrom8B: "true" })).value.excludedFrom8B, validateFiguresForm(form({ excludedFrom8B: 1 })).value.excludedFrom8B], [true, false, false]);

  // --- Fixed asset rows. ---
  check("row numbers are split on commas and spaces, sorted and de-duplicated", validateFiguresForm(form({ capitalGoodsRows: "9, 7 7;8" })).value.capitalGoodsRows, [7, 8, 9]);
  for (const bad of ["x", "7.5", "-7", "5", "0", "7,abc", "99999999"]) {
    const result = validateFiguresForm(form({ capitalGoodsRows: bad }));
    check(`the fixed asset rows "${bad}" are refused`, [result.ok, typeof result.error === "string" && /Fixed assets/.test(result.error)], [false, true]);
  }
  check("more than 500 fixed asset rows are refused", validateFiguresForm(form({ capitalGoodsRows: Array.from({ length: 501 }, (_, i) => i + 6).join(",") })).ok, false);

  // --- Imports. ---
  const importRow = (o = {}) => ({ gdNo: "KAPE-1", gdDate: "2026-08-14", taxableValue: "50,000", salesTaxPaid: "9000", isCapitalGoods: false, ...o });
  const goodImport = validateFiguresForm(form({ imports: [importRow()] }));
  check("a good import is read in paisa", goodImport.value.imports, [{ gdNo: "KAPE-1", gdDate: "2026-08-14", taxableValue: R(50000), salesTaxPaid: R(9000), valueAdditionTaxPaid: 0, isCapitalGoods: false }]);
  check("a completely blank import row is ignored", validateFiguresForm(form({ imports: [{ gdNo: "", gdDate: "", taxableValue: "", salesTaxPaid: "", isCapitalGoods: false }] })).value.imports, []);
  check("an import without a GD number is refused", validateFiguresForm(form({ imports: [importRow({ gdNo: "  " })] })).ok, false);
  check("an import with a bad date is refused", validateFiguresForm(form({ imports: [importRow({ gdDate: "14/08/2026" })] })).ok, false);
  check("an import with an impossible date is refused", validateFiguresForm(form({ imports: [importRow({ gdDate: "2026-02-30" })] })).ok, false);
  check("an import date may be left blank", validateFiguresForm(form({ imports: [importRow({ gdDate: "" })] })).value.imports[0].gdDate, null);
  check("an import without a value is refused", validateFiguresForm(form({ imports: [importRow({ taxableValue: "" })] })).ok, false);
  check("an import without a tax amount is refused (zero must be typed)", validateFiguresForm(form({ imports: [importRow({ salesTaxPaid: "" })] })).ok, false);
  check("an import tax of 0 is accepted", validateFiguresForm(form({ imports: [importRow({ salesTaxPaid: "0" })] })).ok, true);
  check("a negative import value is refused", validateFiguresForm(form({ imports: [importRow({ taxableValue: "-1" })] })).ok, false);
  check("the import error names the import", /Import 2/.test(validateFiguresForm(form({ imports: [importRow(), importRow({ gdNo: "" })] })).error), true);
  check("an import marked as a fixed asset keeps the mark", validateFiguresForm(form({ imports: [importRow({ isCapitalGoods: true })] })).value.imports[0].isCapitalGoods, true);
  check("more than 200 imports are refused", validateFiguresForm(form({ imports: Array.from({ length: 201 }, (_, i) => importRow({ gdNo: `GD${i}` })) })).ok, false);
  check("exactly 200 imports are accepted", validateFiguresForm(form({ imports: Array.from({ length: 200 }, (_, i) => importRow({ gdNo: `GD${i}` })) })).ok, true);
  check("a malformed imports list is treated as none", validateFiguresForm({ ...form(), imports: "nope" }).value.imports, []);

  // --- Exports. ---
  const exportRow = (o = {}) => ({ documentNo: "EXP-1", documentDate: "2026-08-20", valueExclTax: "10,000", ...o });
  check("a good export is read in paisa", validateFiguresForm(form({ exports: [exportRow()] })).value.exports, [{ documentNo: "EXP-1", documentDate: "2026-08-20", valueExclTax: R(10000) }]);
  check("an export without a number is refused", validateFiguresForm(form({ exports: [exportRow({ documentNo: "" })] })).ok, false);
  check("an export without a value is refused", validateFiguresForm(form({ exports: [exportRow({ valueExclTax: "" })] })).ok, false);
  check("an export with a bad date is refused", validateFiguresForm(form({ exports: [exportRow({ documentDate: "tomorrow" })] })).ok, false);
  check("a blank export row is ignored", validateFiguresForm(form({ exports: [{ documentNo: "", documentDate: "", valueExclTax: "" }] })).value.exports, []);
  check("more than 200 exports are refused", validateFiguresForm(form({ exports: Array.from({ length: 201 }, (_, i) => exportRow({ documentNo: `E${i}` })) })).ok, false);

  // --- Round trip and stored data. ---
  const full = validateFiguresForm(form({
    adjustments: { creditBroughtForward: "100000", refundClaimed29: "0.05" },
    excludedFrom8B: true,
    capitalGoodsRows: "7",
    imports: [importRow()],
    exports: [exportRow()],
  })).value;
  check("figures survive the trip through the form", validateFiguresForm(figuresToForm(full)).value, full);
  check("stored figures are read back as they were", parseStoredFigures(JSON.parse(JSON.stringify(full))), full);
  check("nothing stored means nothing entered", [parseStoredFigures(null), parseStoredFigures(undefined), parseStoredFigures("x"), parseStoredFigures(5)], [emptyFigures(), emptyFigures(), emptyFigures(), emptyFigures()]);
  const damaged = parseStoredFigures({ adjustments: { arrears23: -5, refundClaimed29: 1.5, allowance7b: "9" }, excludedFrom8B: "yes", capitalGoodsRows: [7, "8", 2, 9.5], imports: [null, { gdNo: 5, taxableValue: -1, gdDate: "bad" }], exports: "no" });
  check("damaged stored figures become zero, never invented numbers", [damaged.adjustments.arrears23, damaged.adjustments.refundClaimed29, damaged.adjustments.allowance7b, damaged.excludedFrom8B, damaged.capitalGoodsRows, damaged.imports, damaged.exports], [0, 0, 0, false, [7], [{ gdNo: "", gdDate: null, taxableValue: 0, salesTaxPaid: 0, valueAdditionTaxPaid: 0, isCapitalGoods: false }], []]);
  check("a zero adjustment shows as a blank box", figuresToForm(emptyFigures()).adjustments.arrears23, "");
  check("a paisa amount shows with two decimals", figuresToForm(figures({ adjustments: { arrears23: 123450 } })).adjustments.arrears23, "1234.50");
}

function runEstimateChecks() {
  // Worked out by hand from the August month: output tax 8,100,000 + 4,959,000
  // + 2,236,509 + 1,440,000 paisa; input tax 5,400,000 + 3,247,200; further tax 320,000.
  const base = estimate(emptyFigures());
  check("the August month can be estimated", base.canEstimate, true);
  check("output tax is the sum of the four sales invoices", tax(base, "15"), 16735509);
  check("input tax is the sum of the two registered purchases", tax(base, "5"), 8647200);
  check("with nothing else typed the balance payable is 8,408,309 paisa", base.balancePayable, 8408309);

  check("excluding the business from the 8B limit changes nothing here", estimate(figures({ excludedFrom8B: true })).balancePayable, 8408309);
  check("arrears of Rs 1,000 raise the balance by Rs 1,000", estimate(figures({ adjustments: { arrears23: R(1000) } })).balancePayable, 8408309 + R(1000));

  const credit = estimate(figures({ adjustments: { creditBroughtForward: R(100000) } }));
  check("a credit brought forward is added to input tax", tax(credit, "8"), 18647200);
  check("the 90% limit caps the input tax used (floor of 90% of 16,735,509)", tax(credit, "25"), 15061958);
  check("the rest of the credit is not adjusted this month", tax(credit, "26"), 3585242);
  check("the balance after the limit is hand-worked 1,993,551", credit.balancePayable, 1993551);
  const free = estimate(figures({ adjustments: { creditBroughtForward: R(100000) }, excludedFrom8B: true }));
  check("when excluded, all input tax is used up to the output tax", tax(free, "25"), 18647200);
  check("when excluded, nothing is payable but the further tax", free.balancePayable, 320000);

  const assets = estimate(figures({ adjustments: { creditBroughtForward: R(100000) }, capitalGoodsRows: [7] }));
  check("a fixed asset sits outside the cap", [tax(assets, "4"), tax(assets, "25"), tax(assets, "26")], [3247200, 16735509, 1911691]);
  check("with the asset outside the cap only the further tax is payable", assets.balancePayable, 320000);

  const imported = estimate(figures({ imports: [{ gdNo: "KAPE-1", gdDate: "2026-08-14", taxableValue: R(50000), salesTaxPaid: R(9000), valueAdditionTaxPaid: 0 }] }));
  check("an import adds its sales tax to input tax", [tax(imported, "3"), tax(imported, "5")], [R(9000), 8647200 + R(9000)]);
  check("the balance falls by the import tax", imported.balancePayable, 8408309 - R(9000));
  const exported = estimate(figures({ exports: [{ documentNo: "EXP-1", documentDate: "2026-08-20", valueExclTax: R(10000) }] }));
  check("an export is shown on line 11 and does not change the tax", [exported.bySr["11"].grossValue, exported.balancePayable], [R(10000), 8408309]);

  const refund = estimate(figures({ adjustments: { creditBroughtForward: R(100000), refundClaimed29: R(1) } }));
  check("a refund claim leaves the month estimable and adds the Annex-H reminder", [refund.canEstimate, refund.problems.some((p) => p.code === "refund_needs_annex_h")], [true, true]);
  const tooMuch = estimate(figures({ adjustments: { inadmissible6a: R(999999) } }));
  check("adjustments larger than the input tax stop the estimate", [tooMuch.canEstimate, tooMuch.balancePayable], [false, null]);

  // Fixed asset row checks.
  check("no fixed asset rows is fine", checkCapitalRows(august.purchaseGrid, []), null);
  check("a registered purchase row can be a fixed asset", checkCapitalRows(august.purchaseGrid, [7]), null);
  check("a row that is not in the file is refused", /row 40 is not an invoice/.test(checkCapitalRows(august.purchaseGrid, [40])), true);
  check("a row from an unregistered supplier is refused", /unregistered supplier/.test(checkCapitalRows(august.purchaseGrid, [8])), true);
  check("rows without a purchases file are refused", /no purchases file/.test(checkCapitalRows(null, [7])), true);
  check("rows with an unreadable purchases file are refused", /could not be read/.test(checkCapitalRows([["not", "a", "template"]], [7])), true);
}

function runPacketChecks() {
  const f = figures({ adjustments: { arrears23: R(1000) } });
  const result = estimate(f);
  const files = { sales: { fileName: "s.xlsx", invoiceCount: 4, valuePaisa: 1, taxPaisa: 2 }, purchases: { fileName: "p.xlsx", invoiceCount: 3, valuePaisa: 3, taxPaisa: 4 } };
  const at = new Date("2026-10-09T10:00:00.000Z");
  const built = buildApprovalPacket({ approvedAt: at, authority: "FBR", period: august.period, businessName: "Acme", registrationNo: august.registrationNo, figures: f, files, result });
  check("an estimable return gives a packet", built.ok, true);
  const packet = built.packet;
  check("the packet records who, what and when", [packet.version, packet.approvedAt, packet.authority, packet.period, packet.businessName, packet.registrationNo], [1, at.toISOString(), "FBR", august.period, "Acme", august.registrationNo]);
  check("the packet carries the balance and the typed figures", [packet.balancePayable, packet.figures], [8408309 + R(1000), f]);
  check("the packet carries every return line with its IRIS code", [packet.lines.length, packet.lines.find((l) => l.sr === "37").code, packet.lines.find((l) => l.sr === "15").salesTax], [result.lines.length, "100406", 16735509]);
  check("the packet is plain JSON", JSON.parse(JSON.stringify(packet)), packet);
  check("a return that cannot be estimated gives no packet", buildApprovalPacket({ approvedAt: at, authority: "FBR", period: august.period, businessName: "A", registrationNo: "1", figures: f, files, result: estimate(figures({ adjustments: { inadmissible6a: R(999999) } })) }).ok, false);

  const same = fingerprintOf({ period: august.period, registrationNo: august.registrationNo, figures: f, files, result });
  check("the fingerprint is stable", fingerprintOf({ period: august.period, registrationNo: august.registrationNo, figures: f, files, result: estimate(f) }), same);
  check("the fingerprint matches the one in the packet", packet.fingerprint, same);
  check("the fingerprint ignores dashes in the registration number", fingerprintOf({ period: august.period, registrationNo: "1000-0000-00000", figures: f, files, result }), same === fingerprintOf({ period: august.period, registrationNo: "1000-0000-00000", figures: f, files, result }) ? same : "differs");
  const changed = (patch) => fingerprintOf({ period: august.period, registrationNo: august.registrationNo, figures: patch.figures || f, files: patch.files || files, result: patch.result || result });
  check("another figure changes the fingerprint", changed({ figures: figures({ adjustments: { arrears23: R(1001) } }), result: estimate(figures({ adjustments: { arrears23: R(1001) } })) }) !== same, true);
  check("another file name changes the fingerprint", changed({ files: { ...files, sales: { ...files.sales, fileName: "s2.xlsx" } } }) !== same, true);
  check("another invoice total changes the fingerprint", changed({ files: { ...files, purchases: { ...files.purchases, taxPaisa: 5 } } }) !== same, true);
  check("a stored packet is current only with the same fingerprint", [isApprovalCurrent(packet, { fingerprint: same }), isApprovalCurrent(packet, { fingerprint: "other" }), isApprovalCurrent(null, { fingerprint: same }), isApprovalCurrent({}, { fingerprint: same }), isApprovalCurrent("x", { fingerprint: same })], [true, false, false, false, false]);
}

function runSourceChecks() {
  const actions = read("app/actions/sales-tax.ts");
  const wizard = read("components/tax/sales-tax/sales-tax-wizard.tsx");
  const reviewStep = read("components/tax/sales-tax/review-step.tsx");
  const figuresStep = read("components/tax/sales-tax/figures-step.tsx");
  check("approving needs the box to be ticked on the server too", /confirmed !== true/.test(actions), true);
  check("approving works the estimate out again on the server", /async function approveSalesTaxReturnAction[\s\S]*computeReview\(filing, figures/.test(actions) && /buildApprovalPacket\(/.test(actions), true);
  check("approving takes no figures from the browser", /approveSalesTaxReturnAction\(filingId: string, confirmed: boolean\)/.test(actions), true);
  check("figures are validated before they are stored", /validateFiguresForm\(form\)[\s\S]*salesTaxFiling\.update/.test(actions), true);
  check("the review never touches income-tax drafts", /actions\/filing"|FilingDraft/.test(code("app/actions/sales-tax.ts") + code("components/tax/sales-tax/sales-tax-wizard.tsx") + code("components/tax/sales-tax/review-step.tsx") + code("components/tax/sales-tax/figures-step.tsx")), false);
  check("the screen calls the figures an estimate and says IRIS decides", /estimate/i.test(reviewStep) && /IRIS calculates the final amounts/.test(reviewStep) && /nothing has been sent to FBR/i.test(reviewStep), true);
  check("the approve button stays off until the box is ticked", /disabled=\{[\s\S]{0,120}!reviewed/.test(wizard), true);
  check("the wizard has the two final steps", /FINAL_STEPS = \["Your figures", "Review return"\] as const/.test(wizard), true);
  check("continuing from the figures step saves them first", /step === FIGURES_STEP\)[\s\S]{0,80}handleSaveFigures/.test(wizard), true);
  check("the review step is reached only after the steps before it", /index >= FIGURES_STEP && index > furthest/.test(wizard), true);
  check("the review shows each return line in IRIS order", /SECTIONS/.test(reviewStep) && /"37"/.test(reviewStep), true);
  check("estimate lines carry an Estimate label", /Estimate\s*<\/span>/.test(reviewStep), true);
  check("a client page does not import the Node-only estimate module", /from "@\/lib\/sales-tax\/estimate"/.test(wizard + reviewStep + figuresStep), false);
  const migrations = fs.readdirSync(path.join(root, "prisma", "migrations"));
  check("a migration adds the figures and approval columns", migrations.some((name) => /sales_tax_review/.test(name) && /"approvedPacket" JSONB/.test(read(`prisma/migrations/${name}/migration.sql`)) && /"figures" JSONB/.test(read(`prisma/migrations/${name}/migration.sql`)) && /"approvedAt" TIMESTAMP/.test(read(`prisma/migrations/${name}/migration.sql`))), true);
  check("the schema has the three new columns", /figures\s+Json\?/.test(read("prisma/schema.prisma")) && /approvedAt\s+DateTime\?/.test(read("prisma/schema.prisma")) && /approvedPacket\s+Json\?/.test(read("prisma/schema.prisma")), true);
}

async function gridToWorkbook(grid) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("SALES_INVOICES");
  grid.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === "" || value === null || value === undefined) return;
      let written = value;
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) written = new Date(`${value}T00:00:00.000Z`);
      sheet.getCell(rowIndex + 1, columnIndex + 1).value = written;
    });
  });
  sheet.mergeCells("A4:A5"); sheet.mergeCells("B4:D4"); sheet.mergeCells("E4:E5"); sheet.mergeCells("F4:F5");
  sheet.mergeCells("G4:J4"); sheet.mergeCells("K4:K5"); sheet.mergeCells("L4:L5"); sheet.mergeCells("W4:X4");
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function runDatabaseChecks() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log("Sales tax review database checks skipped: Prisma client is not generated.");
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log("Sales tax review database checks skipped (no database reachable).");
    return;
  }
  const columns = await probe.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'SalesTaxFiling' AND column_name IN ('figures','approvedAt','approvedPacket')`);
  await probe.$disconnect();
  if (columns.length !== 3) {
    check("the database has the review columns: run `npx prisma migrate deploy`", columns.length, 3);
    return;
  }

  const { prisma } = kit.load("lib/prisma.ts");
  const actions = kit.load("app/actions/sales-tax.ts");
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `sales-tax-rv-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };
  const upload = (filingId, kind, bytes, name) => {
    const data = new FormData();
    data.set("filingId", filingId);
    data.set("kind", kind);
    data.set("file", new File([bytes], name, { type: "application/octet-stream" }));
    return actions.uploadSalesTaxInvoicesAction(data);
  };
  const profile = { businessName: "Acme Traders", registrationNo: august.registrationNo, authorities: ["FBR"] };

  try {
    sessionEmail = newEmail("owner");
    await actions.saveSalesTaxProfileAction(profile);
    const started = await actions.startSalesTaxMonthAction({ authority: "FBR", ...august.period });
    const filingId = started.id;

    // A new month: nothing entered, nothing approved.
    const fresh = await actions.getSalesTaxFilingAction(filingId);
    check("a new month has empty figures and no approval", [fresh.review.figures, fresh.review.approval], [emptyFigures(), null]);
    check("an empty month is estimated as a nil return with a reminder", [fresh.review.estimate.canEstimate, fresh.review.estimate.balancePayable, fresh.review.estimate.problems.some((p) => p.code === "no_invoices")], [true, 0, true]);

    const salesFile = await gridToWorkbook(august.salesGrid);
    const purchaseFile = await gridToWorkbook(august.purchaseGrid);
    await upload(filingId, "SALES", salesFile, "august-sales.xlsx");
    await upload(filingId, "PURCHASES", purchaseFile, "august-purchases.xlsx");

    const loaded = await actions.getSalesTaxFilingAction(filingId);
    check("with both files the estimate is the hand-worked one", [loaded.review.estimate.canEstimate, loaded.review.estimate.balancePayable], [true, 8408309]);
    check("the review carries only return-level problems", loaded.review.estimate.problems.every((p) => !["sales", "purchases", "template"].includes(p.sheet)), true);
    check("no file problem blocks this month", loaded.review.fileProblemsBlocking, 0);

    // Approval needs the tick.
    check("approving without the tick is refused", (await actions.approveSalesTaxReturnAction(filingId, false)).success, false);
    check("approving with a non-boolean tick is refused", (await actions.approveSalesTaxReturnAction(filingId, "yes")).success, false);
    check("nothing was stored by the refusals", (await prisma.salesTaxFiling.findUnique({ where: { id: filingId } })).approvedAt, null);

    // Saving figures.
    const badFigures = await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { arrears23: "abc" } }));
    check("bad figures are refused with a message", [badFigures.success, /Line 23/.test(badFigures.error)], [false, true]);
    check("bad figures store nothing", (await prisma.salesTaxFiling.findUnique({ where: { id: filingId } })).figures, null);
    const noRow = await actions.saveSalesTaxFiguresAction(filingId, form({ capitalGoodsRows: "40" }));
    check("a fixed asset row that is not in the file is refused", [noRow.success, /row 40/.test(noRow.error)], [false, true]);
    const unreg = await actions.saveSalesTaxFiguresAction(filingId, form({ capitalGoodsRows: "8" }));
    check("a fixed asset row from an unregistered supplier is refused", unreg.success, false);
    check("refused figures leave the stored figures alone", (await prisma.salesTaxFiling.findUnique({ where: { id: filingId } })).figures, null);

    const saved = await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { arrears23: "1000" } }));
    check("good figures are saved and the estimate follows", [saved.success, saved.review.estimate.balancePayable], [true, 8408309 + R(1000)]);
    const stored = await prisma.salesTaxFiling.findUnique({ where: { id: filingId } });
    check("the stored figures are paisa", stored.figures.adjustments.arrears23, R(1000));
    check("the figures come back when the month is opened again", (await actions.getSalesTaxFilingAction(filingId)).review.figures.adjustments.arrears23, R(1000));

    // Approval.
    const approved = await actions.approveSalesTaxReturnAction(filingId, true);
    check("a reviewed return is approved", [approved.success, approved.review.approval.current], [true, true]);
    const row = await prisma.salesTaxFiling.findUnique({ where: { id: filingId } });
    check("the approval time and packet are stored", [row.approvedAt instanceof Date, row.approvedPacket.version, row.approvedPacket.balancePayable, row.approvedPacket.files.sales.fileName, row.approvedPacket.figures.adjustments.arrears23, row.status], [true, 1, 8408309 + R(1000), "august-sales.xlsx", R(1000), "DRAFT"]);
    check("the packet lists the return lines", row.approvedPacket.lines.find((l) => l.sr === "37").salesTax, 8408309 + R(1000));
    check("opening the month later shows a current approval", (await actions.getSalesTaxFilingAction(filingId)).review.approval.current, true);

    // Anything that changes loses the approval; nothing is silently kept.
    await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { arrears23: "1001" } }));
    check("a changed figure makes the approval stale", (await actions.getSalesTaxFilingAction(filingId)).review.approval.current, false);
    check("the stale approval is still on record", (await actions.getSalesTaxFilingAction(filingId)).review.approval.approvedAt.length > 10, true);
    await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { arrears23: "1000" } }));
    check("putting the figure back makes the same approval current again", (await actions.getSalesTaxFilingAction(filingId)).review.approval.current, true);
    // An answer that does not move any number still changes what was approved.
    await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { arrears23: "1000" }, excludedFrom8B: true }));
    const sameNumbers = await actions.getSalesTaxFilingAction(filingId);
    check("a changed answer with the same numbers still makes the approval stale", [sameNumbers.review.estimate.balancePayable, sameNumbers.review.approval.current], [8408309 + R(1000), false]);
    await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { arrears23: "1000" } }));
    check("putting the answer back makes the approval current again", (await actions.getSalesTaxFilingAction(filingId)).review.approval.current, true);
    await upload(filingId, "SALES", salesFile, "august-sales-renamed.xlsx");
    check("replacing a file makes the approval stale", (await actions.getSalesTaxFilingAction(filingId)).review.approval.current, false);
    const again = await actions.approveSalesTaxReturnAction(filingId, true);
    check("the return can be approved again", [again.success, again.review.approval.current], [true, true]);
    await actions.removeSalesTaxUploadAction(filingId, "PURCHASES");
    const afterRemove = await actions.getSalesTaxFilingAction(filingId);
    check("removing a file makes the approval stale and changes the estimate", [afterRemove.review.approval.current, afterRemove.review.estimate.balancePayable === 8408309 + R(1000)], [false, false]);
    await upload(filingId, "PURCHASES", purchaseFile, "august-purchases.xlsx");
    await actions.approveSalesTaxReturnAction(filingId, true);

    // A change of business details that breaks the checks stops approval.
    await actions.saveSalesTaxProfileAction({ ...profile, registrationNo: "7654321" });
    const mismatch = await actions.getSalesTaxFilingAction(filingId);
    check("a wrong registration number blocks the estimate and stales the approval", [mismatch.review.estimate.canEstimate, mismatch.review.fileProblemsBlocking > 0, mismatch.review.approval.current], [false, true, false]);
    const blocked = await actions.approveSalesTaxReturnAction(filingId, true);
    check("a return that cannot be estimated cannot be approved", [blocked.success, typeof blocked.error === "string"], [false, true]);
    check("the earlier approval is not replaced by a failed one", (await prisma.salesTaxFiling.findUnique({ where: { id: filingId } })).approvedPacket.balancePayable, 8408309 + R(1000));
    await actions.saveSalesTaxProfileAction(profile);
    check("the approval is current again once the number matches", (await actions.getSalesTaxFilingAction(filingId)).review.approval.current, true);

    // Fixed asset row changes the estimate through the whole path.
    await actions.saveSalesTaxFiguresAction(filingId, form({ adjustments: { creditBroughtForward: "100000" }, capitalGoodsRows: "7" }));
    const asset = await actions.getSalesTaxFilingAction(filingId);
    check("a fixed asset row is stored and used", [asset.review.figures.capitalGoodsRows, asset.review.estimate.bySr["4"].salesTax], [[7], 3247200]);

    // Another user can do nothing with this month.
    sessionEmail = newEmail("other");
    await actions.saveSalesTaxProfileAction(profile);
    check("another user cannot save figures", (await actions.saveSalesTaxFiguresAction(filingId, form())).error, "This month was not found.");
    check("another user cannot approve", (await actions.approveSalesTaxReturnAction(filingId, true)).error, "This month was not found.");
    check("another user cannot read the review", (await actions.getSalesTaxFilingAction(filingId)).success, false);

    // Signed out.
    sessionEmail = null;
    check("without a login nothing can be saved", (await actions.saveSalesTaxFiguresAction(filingId, form())).success, false);
    check("without a login nothing can be approved", (await actions.approveSalesTaxReturnAction(filingId, true)).success, false);

    // Draft only.
    sessionEmail = emails[0];
    await prisma.salesTaxFiling.update({ where: { id: filingId }, data: { status: "FILED" } });
    check("a month that is not a draft refuses figures", (await actions.saveSalesTaxFiguresAction(filingId, form())).success, false);
    check("a month that is not a draft refuses approval", (await actions.approveSalesTaxReturnAction(filingId, true)).success, false);
    await prisma.salesTaxFiling.update({ where: { id: filingId }, data: { status: "DRAFT" } });

    // Unknown month.
    check("an unknown month is not found", (await actions.saveSalesTaxFiguresAction("nope", form())).error, "This month was not found.");
    check("an unknown month cannot be approved", (await actions.approveSalesTaxReturnAction("nope", true)).error, "This month was not found.");

    // Deleting the month removes its approval with it.
    check("the draft month is deleted", (await actions.deleteSalesTaxMonthAction(filingId)).success, true);
    check("its approval is gone with it", await prisma.salesTaxFiling.count({ where: { id: filingId } }), 0);
  } finally {
    sessionEmail = null;
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  runFiguresChecks();
  runEstimateChecks();
  runPacketChecks();
  runSourceChecks();
  await runDatabaseChecks();
  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
