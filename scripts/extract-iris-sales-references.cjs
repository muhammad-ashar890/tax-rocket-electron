/**
 * Rebuilds lib/sales-tax/rules/fbr-goods/reference-data.json from the two
 * official FBR invoice templates (Sales and Purchase).
 *
 * Usage:
 *   node scripts/extract-iris-sales-references.cjs <Sales_Invoice_Template.xlsm> <Purchase_Invoice_Template.xlsm>
 *   node scripts/extract-iris-sales-references.cjs <sales> <purchase> --check
 *
 * With --check nothing is written; the script exits with a non-zero code when
 * the committed JSON differs from the templates, and prints what changed.
 *
 * The templates come from the IRIS help page and are the only source for the
 * category lists. Blogs and memory are never used for these lists.
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("@e965/xlsx");

const OUTPUT = path.join(
  __dirname,
  "..",
  "lib",
  "sales-tax",
  "rules",
  "fbr-goods",
  "reference-data.json",
);

function readWorkbook(file) {
  const buffer = fs.readFileSync(file);
  return XLSX.read(buffer, { type: "buffer", cellDates: true });
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * Reads one REFERENCES column: the header text and the values under it.
 * Blank cells inside a list are skipped (the unit of measure list has one),
 * and reading stops at the last row of the sheet.
 */
function referenceColumn(sheet, letter) {
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const values = [];
  for (let row = 1; row <= range.e.r + 1; row += 1) {
    const cell = sheet[`${letter}${row}`];
    if (!cell || cell.v === undefined || cell.v === null || cell.v === "") {
      continue;
    }
    values.push(cell.v);
  }
  return { header: cellText(values[0]), values: values.slice(1) };
}

function headerRows(sheet) {
  const rows = [];
  for (let row = 1; row <= 5; row += 1) {
    const cells = [];
    for (let col = 0; col < 31; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row - 1, c: col });
      const cell = sheet[address];
      cells.push(cell ? cellText(cell.v) : "");
    }
    rows.push(cells);
  }
  return rows;
}

function versionMarker(sheet) {
  const marker = cellText(sheet.B3 && sheet.B3.v);
  const match = /_~_(DSI|DPI)_~_([0-9.]+)$/.exec(marker);
  return {
    kind: match ? match[1] : null,
    version: match ? match[2] : null,
  };
}

function expectHeader(column, expected, file) {
  if (column.header !== expected) {
    throw new Error(
      `${file}: expected the reference column to start with "${expected}" but found "${column.header}". The template layout has changed; review the script before regenerating.`,
    );
  }
}

function extract(file, kind) {
  const workbook = readWorkbook(file);
  const main = workbook.Sheets.SALES_INVOICES;
  const refs = workbook.Sheets.REFERENCES;
  if (!main || !refs) {
    throw new Error(`${file}: SALES_INVOICES or REFERENCES sheet is missing.`);
  }
  const marker = versionMarker(main);
  if (marker.kind !== kind) {
    throw new Error(
      `${file}: expected a ${kind} template but the version marker says ${marker.kind}.`,
    );
  }
  const documentTypes = referenceColumn(refs, "F");
  const buyerTypes = referenceColumn(refs, "L");
  const saleTypes = referenceColumn(refs, "N");
  const reasons = referenceColumn(refs, "T");
  const uoms = referenceColumn(refs, "H");
  const provinces = referenceColumn(refs, "J");
  const rates = referenceColumn(refs, "P");
  const sroNumbers = referenceColumn(refs, "D");
  const itemSerials = referenceColumn(refs, "B");
  expectHeader(documentTypes, "Document Type", file);
  expectHeader(buyerTypes, "Buyer Type", file);
  expectHeader(saleTypes, "Sale Types", file);
  expectHeader(reasons, "Reason", file);
  expectHeader(uoms, "UOM", file);
  expectHeader(provinces, "Province", file);
  expectHeader(rates, "Rate", file);
  expectHeader(sroNumbers, "SRO", file);
  expectHeader(itemSerials, "Item Sr. No.", file);
  return {
    templateFile: path.basename(file),
    templateKind: marker.kind,
    templateVersion: marker.version,
    headerRows: headerRows(main),
    documentTypes: documentTypes.values.map(cellText),
    partyTypes: buyerTypes.values.map(cellText),
    saleTypes: saleTypes.values.map(cellText),
    reasons: reasons.values.map(cellText),
    unitsOfMeasure: uoms.values.map(cellText),
    provinces: provinces.values.map(cellText),
    // Rates are numeric fractions (0.18) or text such as "Exempt" or "Rs.10".
    rates: rates.values.map((value) =>
      typeof value === "number" ? value : cellText(value),
    ),
    sroNumbers: sroNumbers.values.map(cellText),
    itemSerials: itemSerials.values.map(cellText),
  };
}

function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const check = process.argv.includes("--check");
  if (args.length !== 2) {
    console.error(
      "Usage: node scripts/extract-iris-sales-references.cjs <sales template> <purchase template> [--check]",
    );
    process.exit(2);
  }
  const data = {
    note: "Generated by scripts/extract-iris-sales-references.cjs from the official FBR invoice templates. Do not edit by hand.",
    sales: extract(args[0], "DSI"),
    purchase: extract(args[1], "DPI"),
  };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (check) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
    if (current === text) {
      console.log("reference-data.json matches the templates.");
      return;
    }
    const before = current ? JSON.parse(current) : {};
    for (const side of ["sales", "purchase"]) {
      for (const key of Object.keys(data[side])) {
        const a = JSON.stringify((before[side] || {})[key]);
        const b = JSON.stringify(data[side][key]);
        if (a !== b) console.log(`CHANGED ${side}.${key}`);
      }
    }
    process.exit(1);
  }
  fs.writeFileSync(OUTPUT, text);
  console.log(
    `Wrote ${path.relative(process.cwd(), OUTPUT)} (sales ${data.sales.templateVersion}, purchase ${data.purchase.templateVersion}).`,
  );
}

main();
