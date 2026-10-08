/**
 * Sales Tax invoice upload (Phase 2B).
 *
 *   1. Workbook reading: a real .xlsx built with exceljs from the synthetic
 *      month fixtures must give exactly the same result as the fixture's cell
 *      grid, including the merged header cells a real FBR template has.
 *   2. Refusals: files that are not Excel, have no SALES_INVOICES sheet, are
 *      too long, are the wrong kind, or are for another client or month.
 *   3. The REAL server actions against a REAL PostgreSQL database (skipped
 *      cleanly when none is reachable): upload, replace, remove, ownership,
 *      draft-only, cascade, and re-checking when the business details change.
 *
 * All data is synthetic. It proves the code only.
 */

const path = require("path");
const fs = require("fs");
const Module = require("module");
const ExcelJS = require("exceljs");

const kit = require("./lib/sales-tax-test-kit.cjs");
const { check, finish } = kit.createChecker("verify-sales-tax-uploads");
const root = kit.projectRoot;
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
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

const { readInvoiceWorkbook, MAX_DATA_ROWS, MAX_UPLOAD_BYTES } = kit.load(
  "lib/sales-tax/workbook.ts",
);
const { analyzeUploads, isUploadKind } = kit.load(
  "lib/sales-tax/analyze-uploads.ts",
);

const fixture = (name) =>
  require(path.join(root, `test-fixtures/sales-tax/${name}.json`));
const august = fixture("month-2026-08");

/**
 * Writes a cell grid as a real workbook. The header merges of the official
 * templates are reproduced, because they change what a reader sees: a merged
 * cell keeps its text in the top-left cell only.
 */
async function gridToWorkbook(
  grid,
  { sheetName = "SALES_INVOICES", merges = true, mutate } = {},
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  grid.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === "" || value === null || value === undefined) return;
      let written = value;
      // Excel stores real dates as dates, not text.
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        written = new Date(`${value}T00:00:00.000Z`);
      }
      sheet.getCell(rowIndex + 1, columnIndex + 1).value = written;
    });
  });
  if (merges) {
    sheet.mergeCells("A4:A5");
    sheet.mergeCells("B4:D4");
    sheet.mergeCells("E4:E5");
    sheet.mergeCells("F4:F5");
    sheet.mergeCells("G4:J4");
    sheet.mergeCells("K4:K5");
    sheet.mergeCells("L4:L5");
    sheet.mergeCells("W4:X4");
  }
  if (mutate) mutate(sheet);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function problemKey(problem) {
  return `${problem.code}|${problem.sheet}|${problem.row}`;
}

async function runWorkbookChecks() {
  const owner = {
    registrationNo: august.registrationNo,
    period: august.period,
  };

  // --- A real workbook gives the same answer as the grid it came from. ---
  const salesFile = await gridToWorkbook(august.salesGrid);
  const purchaseFile = await gridToWorkbook(august.purchaseGrid);
  const sales = await readInvoiceWorkbook(salesFile);
  const purchases = await readInvoiceWorkbook(purchaseFile);
  check("a sales workbook is opened", sales.ok, true);
  check("a purchase workbook is opened", purchases.ok, true);

  const direct = analyzeUploads({
    ...owner,
    salesGrid: august.salesGrid,
    purchaseGrid: august.purchaseGrid,
  });
  const viaFile = analyzeUploads({
    ...owner,
    salesGrid: sales.grid,
    purchaseGrid: purchases.grid,
  });
  check(
    "the sales file is readable after a round trip through Excel",
    viaFile.sales.readable,
    true,
  );
  check(
    "the purchase file is readable after a round trip through Excel",
    viaFile.purchases.readable,
    true,
  );
  check(
    "the sales invoice count survives",
    viaFile.sales.invoiceCount,
    direct.sales.invoiceCount,
  );
  check(
    "the sales totals survive",
    [viaFile.sales.valuePaisa, viaFile.sales.taxPaisa],
    [direct.sales.valuePaisa, direct.sales.taxPaisa],
  );
  check(
    "the purchase totals survive",
    [viaFile.purchases.valuePaisa, viaFile.purchases.taxPaisa],
    [direct.purchases.valuePaisa, direct.purchases.taxPaisa],
  );
  check(
    "the same problems are found in the file and in the grid",
    viaFile.problems.map(problemKey),
    direct.problems.map(problemKey),
  );
  check(
    "the sales invoice count is not zero",
    viaFile.sales.invoiceCount > 0,
    true,
  );

  // The vertical merge of the "Rate" header must not look like a changed layout.
  check(
    "a merged header does not count as a changed layout",
    viaFile.problems.some((p) => p.code === "template_layout_changed"),
    false,
  );
  const withoutMerges = await readInvoiceWorkbook(
    await gridToWorkbook(august.salesGrid, { merges: false }),
  );
  check(
    "a file without the header merges is read the same way",
    analyzeUploads({
      ...owner,
      salesGrid: withoutMerges.grid,
      purchaseGrid: null,
    }).sales.invoiceCount,
    direct.sales.invoiceCount,
  );

  // A blank header cell is a changed layout, except under a downward merge.
  const blankHeader = (rowIndex, columnIndex) => {
    const copy = august.salesGrid.map((row) => [...row]);
    copy[rowIndex][columnIndex] = "";
    return analyzeUploads({ ...owner, salesGrid: copy, purchaseGrid: null });
  };
  check(
    "a blank 'Sale Type' header is a changed layout",
    blankHeader(3, 10).problems.some(
      (p) => p.code === "template_layout_changed",
    ),
    true,
  );
  check(
    "a blank 'Value' header is a changed layout",
    blankHeader(3, 15).problems.some(
      (p) => p.code === "template_layout_changed",
    ),
    true,
  );
  check(
    "a blank 'Rate' header (top cell) is a changed layout",
    blankHeader(3, 11).problems.some(
      (p) => p.code === "template_layout_changed",
    ),
    true,
  );
  check(
    "a blank cell under the merged 'Rate' header is accepted",
    blankHeader(4, 11).problems.some(
      (p) => p.code === "template_layout_changed",
    ),
    false,
  );
  check(
    "a blank 'Registration No' sub-header is a changed layout",
    blankHeader(4, 1).problems.some(
      (p) => p.code === "template_layout_changed",
    ),
    true,
  );

  // Cell types: dates become text, formulas give their result, rich text is joined.
  const typed = await readInvoiceWorkbook(
    await gridToWorkbook(august.salesGrid, {
      mutate: (sheet) => {
        sheet.getCell("AG6").value = { formula: "1+1", result: 2 };
        sheet.getCell("AH6").value = {
          richText: [{ text: "Rich " }, { text: "text" }],
        };
        sheet.getCell("AI6").value = {
          text: "link",
          hyperlink: "https://example.invalid",
        };
      },
    }),
  );
  check("a date cell becomes YYYY-MM-DD text", typed.grid[1][5], "2026-08-01");
  check("a formula cell gives its result", typed.grid[5][32], 2);
  check("a rich text cell is joined", typed.grid[5][33], "Rich text");
  check("a hyperlink cell gives its text", typed.grid[5][34], "link");
  check(
    "every row has the full width",
    typed.grid.every((row) => row.length === 0 || row.length === 37),
    true,
  );

  // --- Refusals. ---
  const notExcel = await readInvoiceWorkbook(
    new TextEncoder().encode("a,b,c\n1,2,3\n"),
  );
  check("a text file is refused", notExcel.ok, false);
  check(
    "the refusal explains what to upload",
    /\.xlsx or \.xlsm/.test(notExcel.error),
    true,
  );
  check(
    "an empty file is refused",
    (await readInvoiceWorkbook(new Uint8Array(0))).ok,
    false,
  );
  const brokenZip = Uint8Array.from([
    0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  check(
    "a damaged Excel file is refused",
    (await readInvoiceWorkbook(brokenZip)).ok,
    false,
  );

  const wrongSheet = await readInvoiceWorkbook(
    await gridToWorkbook(august.salesGrid, { sheetName: "Sheet1" }),
  );
  check(
    "a workbook without the SALES_INVOICES sheet is refused",
    wrongSheet.ok,
    false,
  );
  check(
    "the refusal names the missing sheet",
    /SALES_INVOICES/.test(wrongSheet.error),
    true,
  );
  const lowerCase = await readInvoiceWorkbook(
    await gridToWorkbook(august.salesGrid, { sheetName: "sales_invoices" }),
  );
  check("the sheet name is matched without regard to case", lowerCase.ok, true);

  const tooLong = await readInvoiceWorkbook(
    await gridToWorkbook(august.salesGrid, {
      mutate: (sheet) => {
        sheet.getCell(5 + MAX_DATA_ROWS + 1, 2).value = "1234567";
      },
    }),
  );
  check("a file with too many invoice rows is refused", tooLong.ok, false);
  check("the refusal gives the limit", /20,000/.test(tooLong.error), true);
  const formattingOnly = await readInvoiceWorkbook(
    await gridToWorkbook(august.salesGrid, {
      mutate: (sheet) => {
        sheet.getCell(5 + MAX_DATA_ROWS + 50, 2).value = "";
        sheet.getCell(5 + MAX_DATA_ROWS + 50, 3).value = null;
      },
    }),
  );
  check(
    "empty cells far below the data are not counted",
    formattingOnly.ok,
    true,
  );

  // --- Checks on what the file says about itself. ---
  const wrongKind = analyzeUploads({
    ...owner,
    salesGrid: null,
    purchaseGrid: sales.grid,
  });
  check(
    "a sales file uploaded as purchases is not readable",
    wrongKind.purchases.readable,
    false,
  );
  check(
    "the wrong-kind problem is reported",
    wrongKind.problems.some((p) => p.code === "template_wrong_kind"),
    true,
  );
  const otherClient = analyzeUploads({
    registrationNo: "9999999",
    period: august.period,
    salesGrid: sales.grid,
    purchaseGrid: null,
  });
  check(
    "a file for another client is reported",
    otherClient.problems.some(
      (p) => p.code === "template_registration_mismatch",
    ),
    true,
  );
  check(
    "the mismatch message names the sales file",
    /sales file/.test(
      otherClient.problems.find(
        (p) => p.code === "template_registration_mismatch",
      ).message,
    ),
    true,
  );
  const otherMonth = analyzeUploads({
    registrationNo: august.registrationNo,
    period: { year: 2026, month: 9 },
    salesGrid: sales.grid,
    purchaseGrid: null,
  });
  check(
    "a file for another month is reported",
    otherMonth.problems.some((p) => p.code === "template_period_mismatch"),
    true,
  );
  check(
    "the purchase mismatch names the purchases file",
    /purchases file/.test(
      analyzeUploads({
        registrationNo: "9999999",
        period: august.period,
        salesGrid: null,
        purchaseGrid: purchases.grid,
      }).problems.find((p) => p.code === "template_registration_mismatch")
        .message,
    ),
    true,
  );
  check(
    "only file-level problems are listed",
    direct.problems.every((p) =>
      ["sales", "purchases", "template"].includes(p.sheet),
    ),
    true,
  );
  check(
    "no files give no problems and no totals",
    analyzeUploads({ ...owner, salesGrid: null, purchaseGrid: null }),
    { sales: null, purchases: null, problems: [] },
  );
  check(
    "upload kinds are SALES and PURCHASES only",
    [
      isUploadKind("SALES"),
      isUploadKind("PURCHASES"),
      isUploadKind("sales"),
      isUploadKind(undefined),
    ],
    [true, true, false, false],
  );

  // Real FBR templates, when the research copies are on this machine.
  const researchDir = "/home/user/sales-tax-research/iris-help";
  const realSales = path.join(researchDir, "Sales_Invoice_Template.xlsm");
  const realPurchases = path.join(
    researchDir,
    "Purchase_Invoice_Template.xlsm",
  );
  if (fs.existsSync(realSales) && fs.existsSync(realPurchases)) {
    const s = await readInvoiceWorkbook(
      new Uint8Array(fs.readFileSync(realSales)),
    );
    const p = await readInvoiceWorkbook(
      new Uint8Array(fs.readFileSync(realPurchases)),
    );
    check("the official sales template (.xlsm) is opened", s.ok, true);
    check("the official purchase template (.xlsm) is opened", p.ok, true);
    const realOwner = { registrationNo: "1000000000000" };
    check(
      "the official sales template passes the layout check",
      analyzeUploads({
        ...realOwner,
        period: { year: 2026, month: 8 },
        salesGrid: s.grid,
        purchaseGrid: null,
      }).sales.readable,
      true,
    );
    check(
      "the official purchase template passes the layout check",
      analyzeUploads({
        ...realOwner,
        period: { year: 2026, month: 7 },
        salesGrid: null,
        purchaseGrid: p.grid,
      }).purchases.readable,
      true,
    );
  }

  return {
    salesFile,
    purchaseFile,
    wrongSheetFile: await gridToWorkbook(august.salesGrid, {
      sheetName: "Other",
    }),
  };
}

function runSourceChecks() {
  const actions = code("app/actions/sales-tax.ts");
  check(
    "uploads never touch income-tax drafts",
    /filingDraft|FilingDraft/.test(actions),
    false,
  );
  check(
    "the upload action limits the file size",
    /file\.size > MAX_UPLOAD_BYTES/.test(actions),
    true,
  );
  check(
    "the upload action checks the file extension",
    /ALLOWED_EXTENSION\.test\(file\.name\)/.test(actions),
    true,
  );
  check(
    "a file is stored per month and kind",
    /filingId_kind/.test(actions),
    true,
  );
  check(
    "only a draft month accepts uploads",
    (
      actions.match(/Files can only be changed while the month is a draft/g) ??
      []
    ).length,
    2,
  );
  check(
    "a month is looked up for the signed-in user only",
    (
      actions.match(
        /where: \{ id: (filingId|String\(filingId \?\? ""\)), userId \}/g,
      ) ?? []
    ).length >= 3,
    true,
  );
  check(
    "an unreadable file is refused before anything is stored",
    actions.indexOf("!stats.readable") > -1 &&
      actions.indexOf("!stats.readable") <
        actions.indexOf("prisma.salesTaxUpload.upsert"),
    true,
  );
  check(
    "exceljs is a declared dependency",
    /"exceljs"/.test(read("package.json")),
    true,
  );
  check(
    "exceljs stays out of the browser bundle",
    /serverComponentsExternalPackages: \["pdfkit", "exceljs"\]/.test(
      read("next.config.mjs"),
    ),
    true,
  );
  check(
    "the workbook reader is not imported by client code",
    /workbook/.test(
      read("components/tax/sales-tax/invoice-steps.tsx") +
        read("components/tax/sales-tax/sales-tax-wizard.tsx"),
    ),
    false,
  );
  check(
    "the upload size limit is below the server action limit",
    MAX_UPLOAD_BYTES < 12 * 1024 * 1024,
    true,
  );
  const schema = read("prisma/schema.prisma");
  check(
    "one file per month and kind",
    /model SalesTaxUpload \{[\s\S]*?@@unique\(\[filingId, kind\]\)/.test(
      schema,
    ),
    true,
  );
  check(
    "uploads are removed with their month",
    /model SalesTaxUpload \{[\s\S]*?onDelete: Cascade/.test(schema),
    true,
  );
  const migrations = fs.readdirSync(path.join(root, "prisma", "migrations"));
  check(
    "a migration creates the upload table",
    migrations.some(
      (name) =>
        /sales_tax_uploads/.test(name) &&
        /CREATE TABLE "SalesTaxUpload"/.test(
          read(`prisma/migrations/${name}/migration.sql`),
        ),
    ),
    true,
  );

  const wizard = read("components/tax/sales-tax/sales-tax-wizard.tsx");
  const steps = read("components/tax/sales-tax/invoice-steps.tsx");
  check(
    "the invoice steps come after Review in the same wizard",
    /INVOICE_STEPS = \["Sales invoices", "Purchase invoices", "Check problems"\] as const/.test(
      wizard,
    ),
    true,
  );
  check(
    "the wizard shows the setup steps first and then the invoice steps",
    /inInvoices/.test(wizard) && /SETUP_STEPS\.length/.test(wizard),
    true,
  );
  check(
    "the invoice steps never touch income-tax drafts",
    /actions\/filing"|FilingDraft/.test(steps),
    false,
  );
  check(
    "the upload step sends the month and kind with the file",
    /form\.set\("filingId", filingId\)/.test(steps) &&
      /form\.set\("kind", kind\)/.test(steps),
    true,
  );
  check(
    "removing a file asks first",
    /window\.confirm\("Remove this file/.test(steps),
    true,
  );
  check(
    "the old separate month wizard is gone",
    fs.existsSync(path.join(root, "components/tax/sales-tax/month-wizard.tsx")),
    false,
  );
}

async function runDatabaseChecks(files) {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log(
      "Sales tax upload database checks skipped: Prisma client is not generated.",
    );
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log(
      "Sales tax upload database checks skipped (no database reachable).",
    );
    return;
  }
  const tables = await probe.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'SalesTaxUpload'`,
  );
  await probe.$disconnect();
  if (tables.length !== 1) {
    check(
      "the database has the SalesTaxUpload table: run `npx prisma migrate deploy`",
      tables.length,
      1,
    );
    return;
  }

  const { prisma } = kit.load("lib/prisma.ts");
  const actions = kit.load("app/actions/sales-tax.ts");
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `sales-tax-up-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };
  const fileOf = (bytes, name) =>
    new File([bytes], name, { type: "application/octet-stream" });
  const form = (filingId, kind, file) => {
    const data = new FormData();
    if (filingId !== undefined) data.set("filingId", filingId);
    if (kind !== undefined) data.set("kind", kind);
    if (file !== undefined) data.set("file", file);
    return data;
  };
  const profile = {
    businessName: "Acme Traders",
    registrationNo: august.registrationNo,
    authorities: ["FBR"],
  };

  try {
    sessionEmail = newEmail("owner");
    await actions.saveSalesTaxProfileAction(profile);
    const started = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...august.period,
    });
    check("the August 2026 month is started", started.success, true);
    const filingId = started.id;

    const countUploads = () =>
      prisma.salesTaxUpload.count({ where: { filingId } });

    // Before anything is uploaded.
    const before = await actions.getSalesTaxFilingAction(filingId);
    check(
      "a new month has no files and no problems",
      [
        before.invoices.sales,
        before.invoices.purchases,
        before.invoices.problems,
      ],
      [null, null, []],
    );

    // Refusals leave nothing behind.
    const refusals = [
      ["no kind", form(filingId, undefined, fileOf(files.salesFile, "a.xlsx"))],
      [
        "an unknown kind",
        form(filingId, "OTHER", fileOf(files.salesFile, "a.xlsx")),
      ],
      ["no file", form(filingId, "SALES")],
      [
        "an empty file",
        form(filingId, "SALES", fileOf(new Uint8Array(0), "a.xlsx")),
      ],
      [
        "a CSV file",
        form(
          filingId,
          "SALES",
          fileOf(new TextEncoder().encode("a,b"), "a.csv"),
        ),
      ],
      [
        "a text file named .xlsx",
        form(
          filingId,
          "SALES",
          fileOf(new TextEncoder().encode("a,b"), "a.xlsx"),
        ),
      ],
      [
        "a workbook without the sheet",
        form(filingId, "SALES", fileOf(files.wrongSheetFile, "a.xlsx")),
      ],
      [
        "a sales file sent as purchases",
        form(filingId, "PURCHASES", fileOf(files.salesFile, "a.xlsx")),
      ],
      [
        "a purchase file sent as sales",
        form(filingId, "SALES", fileOf(files.purchaseFile, "a.xlsx")),
      ],
      [
        "a file over the size limit",
        form(
          filingId,
          "SALES",
          fileOf(new Uint8Array(MAX_UPLOAD_BYTES + 1), "big.xlsx"),
        ),
      ],
    ];
    for (const [label, data] of refusals) {
      const result = await actions.uploadSalesTaxInvoicesAction(data);
      check(
        `${label} is refused with a message`,
        [
          result.success,
          typeof result.error === "string" && result.error.length > 10,
        ],
        [false, true],
      );
    }
    check("nothing was stored after the refusals", await countUploads(), 0);

    // A good sales file.
    const first = await actions.uploadSalesTaxInvoicesAction(
      form(filingId, "SALES", fileOf(files.salesFile, "august-sales.xlsx")),
    );
    check("a good sales file is accepted", first.success, true);
    check(
      "the file name is kept",
      first.invoices.sales.fileName,
      "august-sales.xlsx",
    );
    check(
      "the invoice count is shown",
      first.invoices.sales.invoiceCount > 0,
      true,
    );
    check("the purchases slot is still empty", first.invoices.purchases, null);
    check("one file is stored", await countUploads(), 1);
    const stored = await prisma.salesTaxUpload.findFirst({
      where: { filingId, kind: "SALES" },
    });
    check(
      "the stored row count matches",
      stored.rowCount,
      first.invoices.sales.invoiceCount,
    );
    check(
      "the cells are stored as an array of rows",
      Array.isArray(stored.grid) && Array.isArray(stored.grid[5]),
      true,
    );

    // Replacing keeps one row and changes the file.
    const second = await actions.uploadSalesTaxInvoicesAction(
      form(filingId, "SALES", fileOf(files.salesFile, "august-sales-v2.xlsx")),
    );
    check("a replacement is accepted", second.success, true);
    check(
      "still one sales file",
      await prisma.salesTaxUpload.count({ where: { filingId, kind: "SALES" } }),
      1,
    );
    check(
      "the new name replaces the old",
      second.invoices.sales.fileName,
      "august-sales-v2.xlsx",
    );

    // A refused upload keeps the saved file.
    const refused = await actions.uploadSalesTaxInvoicesAction(
      form(
        filingId,
        "SALES",
        fileOf(new TextEncoder().encode("nope"), "bad.xlsx"),
      ),
    );
    check("a bad replacement is refused", refused.success, false);
    const kept = await prisma.salesTaxUpload.findFirst({
      where: { filingId, kind: "SALES" },
    });
    check(
      "the saved file is untouched by a refused replacement",
      kept.fileName,
      "august-sales-v2.xlsx",
    );

    // Purchases.
    const bought = await actions.uploadSalesTaxInvoicesAction(
      form(
        filingId,
        "PURCHASES",
        fileOf(files.purchaseFile, "august-purchases.xlsx"),
      ),
    );
    check("a good purchase file is accepted", bought.success, true);
    check(
      "both files are listed",
      [bought.invoices.sales !== null, bought.invoices.purchases !== null],
      [true, true],
    );

    const loaded = await actions.getSalesTaxFilingAction(filingId);
    check(
      "opening the month returns both files",
      [loaded.invoices.sales.fileName, loaded.invoices.purchases.fileName],
      ["august-sales-v2.xlsx", "august-purchases.xlsx"],
    );
    check(
      "a matching client and month shows no template problems",
      loaded.invoices.problems.some(
        (p) =>
          p.sheet === "template" &&
          /registration|period|is for/.test(p.code + p.message),
      ),
      false,
    );

    // The checks run again when the business details change.
    await actions.saveSalesTaxProfileAction({
      ...profile,
      registrationNo: "7654321",
    });
    const mismatch = await actions.getSalesTaxFilingAction(filingId);
    check(
      "a changed registration number is reported against both files",
      mismatch.invoices.problems.filter(
        (p) => p.code === "template_registration_mismatch",
      ).length,
      2,
    );
    await actions.saveSalesTaxProfileAction(profile);
    const fixed = await actions.getSalesTaxFilingAction(filingId);
    check(
      "the report clears when the number matches again",
      fixed.invoices.problems.some(
        (p) => p.code === "template_registration_mismatch",
      ),
      false,
    );

    // Another user can do nothing with this month.
    sessionEmail = newEmail("other");
    await actions.saveSalesTaxProfileAction(profile);
    const intruder = await actions.uploadSalesTaxInvoicesAction(
      form(filingId, "SALES", fileOf(files.salesFile, "x.xlsx")),
    );
    check(
      "another user cannot upload into this month",
      [intruder.success, intruder.error],
      [false, "This month was not found."],
    );
    const intruderRemove = await actions.removeSalesTaxUploadAction(
      filingId,
      "SALES",
    );
    check(
      "another user cannot remove its files",
      intruderRemove.success,
      false,
    );
    check(
      "another user cannot read its files",
      (await actions.getSalesTaxFilingAction(filingId)).success,
      false,
    );
    check("the files are still there", await countUploads(), 2);

    // A signed-out caller can do nothing.
    sessionEmail = null;
    check(
      "without a login nothing can be uploaded",
      (
        await actions.uploadSalesTaxInvoicesAction(
          form(filingId, "SALES", fileOf(files.salesFile, "x.xlsx")),
        )
      ).success,
      false,
    );
    check(
      "without a login nothing can be removed",
      (await actions.removeSalesTaxUploadAction(filingId, "SALES")).success,
      false,
    );

    // Removing.
    sessionEmail = emails[0];
    check(
      "an unknown kind cannot be removed",
      (await actions.removeSalesTaxUploadAction(filingId, "OTHER")).success,
      false,
    );
    const removed = await actions.removeSalesTaxUploadAction(filingId, "SALES");
    check(
      "a file can be removed",
      [
        removed.success,
        removed.invoices.sales,
        removed.invoices.purchases !== null,
      ],
      [true, null, true],
    );
    check("only that file was removed", await countUploads(), 1);
    check(
      "removing a file that is not there is harmless",
      (await actions.removeSalesTaxUploadAction(filingId, "SALES")).success,
      true,
    );

    // Only a draft month can change.
    await prisma.salesTaxFiling.update({
      where: { id: filingId },
      data: { status: "FILED" },
    });
    const locked = await actions.uploadSalesTaxInvoicesAction(
      form(filingId, "SALES", fileOf(files.salesFile, "late.xlsx")),
    );
    check(
      "a month that is not a draft refuses uploads",
      [locked.success, locked.error],
      [false, "Files can only be changed while the month is a draft."],
    );
    check(
      "a month that is not a draft refuses removal",
      (await actions.removeSalesTaxUploadAction(filingId, "PURCHASES")).success,
      false,
    );
    check("nothing changed on the locked month", await countUploads(), 1);
    await prisma.salesTaxFiling.update({
      where: { id: filingId },
      data: { status: "DRAFT" },
    });

    // Deleting the month removes its files.
    const deleted = await actions.deleteSalesTaxMonthAction(filingId);
    check("the draft month is deleted", deleted.success, true);
    check("its files are deleted with it", await countUploads(), 0);

    // Deleting a user removes everything.
    const again = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...august.period,
    });
    await actions.uploadSalesTaxInvoicesAction(
      form(again.id, "SALES", fileOf(files.salesFile, "again.xlsx")),
    );
    const ownerRow = await prisma.user.findUnique({
      where: { email: emails[0] },
    });
    await prisma.user.delete({ where: { id: ownerRow.id } });
    check(
      "files are removed with the user",
      await prisma.salesTaxUpload.count({ where: { filingId: again.id } }),
      0,
    );
  } finally {
    sessionEmail = null;
    await prisma.user
      .deleteMany({ where: { email: { in: emails } } })
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  const files = await runWorkbookChecks();
  runSourceChecks();
  await runDatabaseChecks(files);
  finish();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
