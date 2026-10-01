/**
 * A small stand-in for the IRIS Wealth Statement pages, built from the real
 * captures in test-fixtures/iris/wealth/. It reproduces the behaviour the
 * driver depends on and nothing more:
 *
 *   + Expenses      -> "Add Personal Expenses" dialog; ADD enables once a box is ticked;
 *                      ADD creates one editable row per ticked category
 *   (+) on 7098     -> "Adjustments in Outflows" dialog; SAVE enables once a
 *                      description is typed; SAVE creates the child 7098 row
 *   + Assets        -> "Add Financial Assets" dialog; ticking Bank Account(s)
 *                      and ADD creates the 7030 summary row
 *   (+) on 7030     -> "Bank Account" dialog; the search button resolves a KNOWN
 *                      IBAN into title + bank; ADD creates the child 7030 row
 *
 * It records every click so tests can prove which controls were (not) touched.
 * It cannot prove that real IRIS behaves like this — the first supervised live
 * run does. It proves the driver's own logic, ordering and safety rules.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const DIR = path.join(__dirname, "..", "..", "test-fixtures", "iris", "wealth");
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");

const EXPENSE_LABEL_TO_CODE = {};

function rowsOf(doc) {
  return [...doc.querySelectorAll(".tableRows.dataRow[id]")];
}

class FakeIris {
  constructor({ knownIbans = {}, modalOverrides = {} } = {}) {
    this.knownIbans = knownIbans;
    this.clicks = [];
    this.dom = new JSDOM(
      `<!doctype html><html><body>
        <div class="top-bar"><button id="calc">Calculate</button><button id="save">Save</button><button id="submit">Submit</button></div>
        <div class="iris-data"></div></body></html>`,
      { runScripts: "outside-only" },
    );
    this.window = this.dom.window;
    this.document = this.window.document;
    this.modalHtml = {
      expenses: read("modal-expenses.html"),
      financial: read("modal-financial-assets.html"),
      outflow: read("modal-outflow.html"),
      bank: read("modal-bank.html"),
      ...modalOverrides,
    };
    const full = new JSDOM(read("reconciliation-with-expenses-and-outflow.html")).window.document;
    this.templates = {};
    for (const row of rowsOf(full)) {
      (this.templates[row.id] ||= []).push(row);
    }
    const bankPage = new JSDOM(read("assets-with-bank.html")).window.document;
    this.bankRows = rowsOf(bankPage).filter((r) => r.id === "7030");
    this.sections = {
      wealth_reconciliation: read("reconciliation-default.html"),
      wealth_assets: read("assets-default.html"),
    };
    this.saved = {};
    this.current = null;
    this.document.addEventListener("click", (event) => this.onClick(event), true);
    this.document.addEventListener("change", (event) => this.onChange(event));
    this.document.addEventListener("input", (event) => this.onChange(event));
    this.webContents = {
      executeJavaScript: async (script) => this.window.eval(script),
    };
  }

  container() {
    return this.document.querySelector(".iris-data");
  }

  show(sectionId) {
    // Sections are kept as live DOM (not re-serialised) so typed values survive
    // navigating away and back, as they do in the real Angular app.
    const holder = this.container();
    if (this.current) {
      const keep = this.document.createDocumentFragment();
      while (holder.firstChild) keep.appendChild(holder.firstChild);
      this.saved[this.current] = keep;
    }
    this.current = sectionId;
    if (!this.saved[sectionId]) {
      const fresh = new JSDOM(this.sections[sectionId]).window.document.querySelector(".iris-data");
      const frag = this.document.createDocumentFragment();
      for (const child of [...fresh.childNodes]) frag.appendChild(this.document.importNode(child, true));
      this.saved[sectionId] = frag;
    }
    holder.appendChild(this.saved[sectionId]);
  }

  row(id, index = 0) {
    return [...this.container().querySelectorAll(".tableRows.dataRow[id]")].filter((r) => r.id === id)[index];
  }
  rowsWithId(id) {
    return [...this.container().querySelectorAll(".tableRows.dataRow[id]")].filter((r) => r.id === id);
  }
  inputValue(row) {
    const input = row.querySelector(".data-middle-child-wapper input");
    return input ? input.value : null;
  }
  dialogs() {
    return [...this.document.querySelectorAll("mat-dialog-container")];
  }

  // ── behaviour ──────────────────────────────────────────────────────────
  describe(el) {
    const row = el.closest && el.closest(".tableRows");
    return {
      tag: el.tagName,
      id: el.id || null,
      cls: String(el.className || ""),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      rowId: row ? row.id : null,
      inDialog: Boolean(el.closest && el.closest("mat-dialog-container")),
    };
  }

  openDialog(kind) {
    const src = new JSDOM(this.modalHtml[kind]).window.document.querySelector("mat-dialog-container");
    const dialog = this.document.importNode(src, true);
    dialog.dataset.kind = kind;
    this.document.body.appendChild(dialog);
    if (kind === "expenses") {
      // Categories already added come back ticked and disabled, as IRIS does.
      for (const card of dialog.querySelectorAll(".source-card")) {
        const label = card.querySelector("p").textContent.trim();
        const code = Object.keys(this.expenseCodes()).find((c) => this.expenseCodes()[c] === label);
        if (code && this.rowsWithId(code).length) {
          const box = card.querySelector("input[type=checkbox]");
          box.checked = true;
          box.disabled = true;
        }
      }
    }
    this.refreshButtons(dialog);
  }

  expenseCodes() {
    if (!this._codes) {
      this._codes = {};
      for (const [code, rows] of Object.entries(this.templates)) {
        const desc = rows[0].querySelector(".row-description-text");
        if (desc && rows[0].querySelector("button.btn-section-delete")) this._codes[code] = desc.textContent.trim();
      }
    }
    return this._codes;
  }

  refreshButtons(dialog) {
    const kind = dialog.dataset.kind;
    const buttons = [...dialog.querySelectorAll("mat-dialog-actions button, .dialog-footer button")];
    const byText = (t) => buttons.find((b) => b.textContent.trim().toLowerCase() === t);
    if (kind === "expenses" || kind === "financial") {
      const any = [...dialog.querySelectorAll(".source-card input[type=checkbox]")].some((b) => b.checked && !b.disabled);
      byText("add").disabled = !any;
    } else if (kind === "outflow") {
      const text = dialog.querySelector("textarea").value.trim();
      byText("save").disabled = !text;
    } else if (kind === "bank") {
      const title = dialog.querySelector('input[placeholder="Account Title"]').value;
      byText("add").disabled = !title;
    }
  }

  onChange(event) {
    const dialog = event.target.closest && event.target.closest("mat-dialog-container");
    if (dialog) this.refreshButtons(dialog);
  }

  insertAfter(newRow, ref) {
    ref.parentNode.insertBefore(newRow, ref.nextSibling);
  }

  cloneTemplate(rowTemplate) {
    const row = this.container().ownerDocument.importNode(rowTemplate, true);
    for (const input of row.querySelectorAll(".data-middle-child-wapper input")) {
      input.value = "";
      input.removeAttribute("value");
    }
    return row;
  }

  onClick(event) {
    const el = event.target;
    this.clicks.push(this.describe(el));
    const dialog = el.closest("mat-dialog-container");
    const row = el.closest(".tableRows");

    if (!dialog && el.matches("button.btn-section-add") && row) {
      if (row.id === "7089") this.openDialog("expenses");
      if (row.id === "999901") this.openDialog("financial");
      return;
    }
    if (!dialog && el.matches("mat-icon.btn-purple") && row) {
      if (row.id === "7098") this.openDialog("outflow");
      if (row.id === "7030") this.openDialog("bank");
      return;
    }
    if (!dialog) return;

    const kind = dialog.dataset.kind;
    const button = el.closest("button");
    const label = button ? button.textContent.trim().toLowerCase() : "";
    if (button && button.disabled) return;

    if (kind === "bank" && button && /search/i.test(button.textContent)) {
      const iban = dialog.querySelector('input[placeholder="IBAN"]').value;
      const known = this.knownIbans[iban];
      if (known) {
        dialog.querySelector('input[placeholder="Account Title"]').value = known.title;
        dialog.querySelector('input[placeholder="Bank Name"]').value = known.bank;
        this.refreshButtons(dialog);
      }
      return;
    }
    if (label === "cancel" || label === "close") {
      dialog.remove();
      return;
    }
    if (label === "add" && kind === "expenses") {
      let anchor = this.row("7089");
      for (const card of dialog.querySelectorAll(".source-card")) {
        const box = card.querySelector("input[type=checkbox]");
        if (!box.checked || box.disabled) continue;
        const name = card.querySelector("p").textContent.trim();
        const code = Object.keys(this.expenseCodes()).find((c) => this.expenseCodes()[c] === name);
        const fresh = this.cloneTemplate(this.templates[code][0]);
        this.insertAfter(fresh, anchor);
        anchor = fresh;
      }
      dialog.remove();
      return;
    }
    if (label === "save" && kind === "outflow") {
      const text = dialog.querySelector("textarea").value.trim();
      const summary = this.row("7098");
      const childTemplate = this.templates["7098"].find((r) => r.querySelector(".data-middle-child-wapper input:not([disabled])"));
      const fresh = this.cloneTemplate(childTemplate);
      fresh.querySelector(".row-description-text").textContent = `Adjustments in Outflows - ${text}`;
      this.insertAfter(fresh, this.rowsWithId("7098").slice(-1)[0] || summary);
      dialog.remove();
      return;
    }
    if (label === "add" && kind === "financial") {
      const wantsBank = [...dialog.querySelectorAll(".source-card")].some((card) => {
        const box = card.querySelector("input[type=checkbox]");
        return box.checked && !box.disabled && /bank account/i.test(card.querySelector("p").textContent);
      });
      if (wantsBank) {
        const summary = this.cloneTemplate(this.bankRows[0]);
        this.insertAfter(summary, this.row("999901"));
      }
      dialog.remove();
      return;
    }
    if (label === "add" && kind === "bank") {
      const iban = dialog.querySelector('input[placeholder="IBAN"]').value;
      const known = this.knownIbans[iban];
      const fresh = this.cloneTemplate(this.bankRows[1]);
      fresh.querySelector(".row-description-text").textContent =
        `Bank Account(s) - ${iban} - ${known.title} - ${known.bank}`;
      this.insertAfter(fresh, this.rowsWithId("7030").slice(-1)[0]);
      dialog.remove();
    }
  }
}

module.exports = { FakeIris };
