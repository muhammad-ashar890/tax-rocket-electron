/**
 * Cut the employer capture down to committable fixtures for the employer driver
 * tests (scripts/verify-iris-employer-driver.cjs). Classes are kept; Angular
 * noise is stripped.
 *
 *   node scripts/extract-iris-employer-fixtures.cjs [sourceDir]   (default ~/uploads)
 *
 * Writes test-fixtures/iris/employer/:
 *   salary-employer-panel.html   the "Employer Details" bar and its (empty) list
 *   modal-add-employer.html      the "Add Employer" dialog
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { JSDOM } = require("jsdom");

const SOURCE_DIR = process.argv[2] || path.join(os.homedir(), "uploads");
const OUT_DIR = path.join(__dirname, "..", "test-fixtures", "iris", "employer");
const SOURCE = "employer details modal IRIS 2.0.html";

function clean(el) {
  for (const attr of [...el.attributes]) {
    if (/^(_ngcontent|_nghost|ng-reflect|mattooltip|style$|aria-|onkeypress|tabindex|data-mat)/.test(attr.name))
      el.removeAttribute(attr.name);
  }
}
function cleanTree(root) {
  clean(root);
  for (const child of root.querySelectorAll("*")) clean(child);
  for (const svg of [...root.querySelectorAll("svg")]) svg.remove();
  const walker = root.ownerDocument.createTreeWalker(root, 128);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());
}
const wrap = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>\n` +
  `<!-- IRIS 2.0 employer fixture derived from "${SOURCE}" by scripts/extract-iris-employer-fixtures.cjs. -->\n` +
  body +
  `\n</body></html>\n`;

const file = path.join(SOURCE_DIR, SOURCE);
if (!fs.existsSync(file)) {
  console.error(`${SOURCE} not found in ${SOURCE_DIR}`);
  process.exit(1);
}
const html = fs.readFileSync(file, "utf8").replace(/<style[\s\S]*?<\/style>/g, "");
const doc = new JSDOM(html).window.document;
fs.mkdirSync(OUT_DIR, { recursive: true });

const header = doc.querySelector(".salary-employer-header");
if (!header) throw new Error("no .salary-employer-header in the capture");
const panel = header.parentElement; // the expansion-panel body: header + list
const panelClone = panel.cloneNode(true);
cleanTree(panelClone);
fs.writeFileSync(
  path.join(OUT_DIR, "salary-employer-panel.html"),
  wrap("salary-employer-panel", `<div class="iris-data">${panelClone.outerHTML}</div>`),
);

const dialog = doc.querySelector("app-add-employer").closest("mat-dialog-container");
const dialogClone = dialog.cloneNode(true);
cleanTree(dialogClone);
fs.writeFileSync(
  path.join(OUT_DIR, "modal-add-employer.html"),
  wrap("modal-add-employer", dialogClone.outerHTML),
);
console.log(`employer fixtures written to ${OUT_DIR}`);
