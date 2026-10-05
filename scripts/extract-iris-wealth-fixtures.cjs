/**
 * Cut the Wealth Statement captures down to committable fixtures for the
 * wealth driver tests (scripts/verify-iris-wealth-driver.cjs).
 *
 * Unlike extract-iris-fixtures.cjs this KEEPS class names: the driver tells the
 * purple "add" icon from the orange "edit" and red "delete" icons, and the
 * `+ Expenses` / `+ Assets` buttons from `btn-section-delete`, by class.
 *
 *   node scripts/extract-iris-wealth-fixtures.cjs [sourceDir]   (default ~/uploads)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { JSDOM } = require("jsdom");

const SOURCE_DIR = process.argv[2] || path.join(os.homedir(), "uploads");
const OUT_DIR = path.join(__dirname, "..", "test-fixtures", "iris", "wealth");

const PAGES = [
  [
    "data 116 - Wealth Statement — Reconconciliation of Net Assets IRIS 2.0.html",
    "reconciliation-default.html",
  ],
  ["7098 added IRIS 2.0.html", "reconciliation-with-expenses-and-outflow.html"],
  [
    "data 116 - Wealth Statement — Personal Assets  Liabilities IRIS 2.0.html",
    "assets-default.html",
  ],
  ["bank account field visibleIRIS 2.0.html", "assets-with-bank.html"],
  // A real gift saved through the 7037 dialog: the child row reads
  // "Gift - <donor id> - <donor name> - <description>" and has an editable amount.
  ["7037 capture IRIS 2.0.html", "reconciliation-with-gift.html"],
];
const MODALS = [
  ["expense modal IRIS 2.0.html", "modal-expenses.html"],
  [
    "Add Financial Assets & Investments modal IRIS 2.0.html",
    "modal-financial-assets.html",
  ],
  ["Adjustments in Outflows modal IRIS 2.0.html", "modal-outflow.html"],
  ["Bank Account(s) modal IRIS 2.0.html", "modal-bank.html"],
  ["gift inflows popup IRIS 2.0.html", "modal-gift.html"],
];

function load(file) {
  const src = path.join(SOURCE_DIR, file);
  if (!fs.existsSync(src)) {
    console.warn(`  SKIP  ${file} (not found in ${SOURCE_DIR})`);
    return null;
  }
  const html = fs
    .readFileSync(src, "utf8")
    .replace(/<style[\s\S]*?<\/style>/g, "");
  return new JSDOM(html).window.document;
}

function clean(el) {
  for (const attr of [...el.attributes]) {
    if (
      /^(_ngcontent|_nghost|ng-reflect|mattooltip|style$|aria-|onkeypress|tabindex|data-mat)/.test(
        attr.name,
      )
    )
      el.removeAttribute(attr.name);
  }
  for (const svg of [...el.querySelectorAll("svg")]) svg.remove();
  const walker = el.ownerDocument.createTreeWalker(el, 128 /* comments */);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());
}

function wrap(title, bodyHtml, source) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>\n` +
    `<!-- IRIS 2.0 wealth fixture derived from "${source}" by scripts/extract-iris-wealth-fixtures.cjs. Classes kept; Angular noise stripped. -->\n` +
    bodyHtml +
    `\n</body></html>\n`
  );
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let written = 0;

for (const [file, out] of PAGES) {
  const d = load(file);
  if (!d) continue;
  const nodes = [...d.querySelectorAll(".tableRows.dataRow[id]")];
  const holder = d.createElement("div");
  holder.className = "iris-data";
  for (const node of nodes) {
    if (nodes.some((o) => o !== node && o.contains(node))) continue;
    const clone = node.cloneNode(true);
    clean(clone);
    for (const child of clone.querySelectorAll("*")) clean(child);
    holder.appendChild(clone);
  }
  fs.writeFileSync(path.join(OUT_DIR, out), wrap(out, holder.outerHTML, file));
  console.log(`  OK    ${out} (${nodes.length} rows)`);
  written += 1;
}

for (const [file, out] of MODALS) {
  const d = load(file);
  if (!d) continue;
  const dialog = d.querySelector("mat-dialog-container");
  if (!dialog) {
    console.warn(`  SKIP  ${file} (no dialog)`);
    continue;
  }
  const clone = dialog.cloneNode(true);
  clean(clone);
  for (const child of clone.querySelectorAll("*")) clean(child);
  fs.writeFileSync(path.join(OUT_DIR, out), wrap(out, clone.outerHTML, file));
  console.log(`  OK    ${out}`);
  written += 1;
}
console.log(
  `\n${written}/${PAGES.length + MODALS.length} wealth fixtures written to ${OUT_DIR}`,
);
