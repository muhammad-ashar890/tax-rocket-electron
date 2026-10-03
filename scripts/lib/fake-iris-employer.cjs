/**
 * A small stand-in for the IRIS Salary page's employer panel, built from the
 * real capture in test-fixtures/iris/employer/. It reproduces what the employer
 * driver depends on and nothing more:
 *
 *   + Add Employer Details -> "Add Employer" dialog (the real captured markup)
 *   typing a name          -> autocomplete options "NAME | REGNO" taken from the
 *                             registry given to the constructor (substring match)
 *   choosing an option     -> name field takes the NAME, registration field takes
 *                             the REGNO and is greyed
 *   Add                    -> needs both; closes the dialog and appends an employer
 *                             card (format selectable to test card detection)
 *   Cancel                 -> closes the dialog
 *
 * Every click is recorded so tests can prove which controls were (not) touched.
 * The CARD markup is a guess (only its CSS classes were captured), and so is the
 * option markup; the first supervised live run is what proves those two.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const DIR = path.join(
  __dirname,
  "..",
  "..",
  "test-fixtures",
  "iris",
  "employer",
);
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");
const bodyOf = (html) => new JSDOM(html).window.document.body;

class FakeIrisEmployer {
  constructor({
    registry = [],
    existing = [],
    cardFormat = "name_reg",
    rejectAdd = false,
    cardMarkup = "named", // "named" | "plain" (unknown class names) | "none" (no card ever shown)
    optionsMarkup = "mat-option",
    // Observed live: when the typed text matches exactly one company, IRIS fills
    // the full name and the greyed registration number itself and lists nothing.
    autoResolveSingle = false,
  } = {}) {
    this.autoResolveSingle = autoResolveSingle;
    this.registry = registry; // [{ name, regNo }]
    this.cardFormat = cardFormat;
    this.rejectAdd = rejectAdd;
    this.cardMarkup = cardMarkup;
    this.optionsMarkup = optionsMarkup;
    this.clicks = [];
    this.dom = new JSDOM(
      `<!doctype html><html><body>
        <div class="top-bar"><button id="calc">Calculate</button><button id="save">Save</button><button id="submit">Submit</button></div>
        <div class="iris-data"></div>
        <div class="cdk-overlay-container"></div></body></html>`,
      { runScripts: "outside-only" },
    );
    this.window = this.dom.window;
    this.document = this.window.document;
    const panel = bodyOf(read("salary-employer-panel.html")).querySelector(
      ".iris-data",
    );
    this.document.querySelector(".iris-data").innerHTML = panel.innerHTML;
    this.modalHtml = bodyOf(read("modal-add-employer.html")).querySelector(
      "mat-dialog-container",
    ).outerHTML;
    for (const item of existing) this.appendCard(item);
    this.document.addEventListener(
      "click",
      (event) => this.onClick(event),
      true,
    );
    this.document.addEventListener("input", (event) => this.onInput(event));
    this.webContents = {
      executeJavaScript: async (script) => this.window.eval(script),
    };
  }

  list() {
    return this.document.querySelector(".panel-body");
  }
  cards() {
    return [...this.list().children];
  }
  cardTexts() {
    return this.cards().map((c) =>
      c.textContent
        .replace(/\s+/g, " ")
        .replace(/edit\s*delete\s*$|edit\s*$/i, "")
        .trim(),
    );
  }
  modal() {
    return this.document.querySelector("mat-dialog-container");
  }
  name() {
    return (
      this.modal() &&
      this.modal().querySelector('input[formcontrolname="employerName"]')
    );
  }
  reg() {
    return (
      this.modal() &&
      this.modal().querySelector('input[formcontrolname="employerRegNo"]')
    );
  }

  appendCard({ name, regNo }) {
    const text =
      this.cardFormat === "reg_only"
        ? regNo
        : this.cardFormat === "name_only"
          ? name
          : `${name} | ${regNo}`;
    if (this.cardMarkup === "none") return;
    const card = this.document.createElement("div");
    if (this.cardMarkup === "plain") {
      card.className = "emp-tile";
      card.innerHTML = `<p>${text}</p><mat-icon>edit</mat-icon>`;
      this.list().appendChild(card);
      return;
    }
    card.className = "salary-employer-card";
    card.innerHTML = `<span class="salary-employer-card-text">${text}</span><mat-icon class="salary-employer-edit-icon">edit</mat-icon><mat-icon class="salary-employer-delete-icon">delete</mat-icon>`;
    this.list().appendChild(card);
  }

  describe(el) {
    return {
      tag: el.tagName,
      id: el.id || null,
      cls: String(el.className || ""),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      inDialog: Boolean(el.closest && el.closest("mat-dialog-container")),
    };
  }

  showOptions(typed) {
    const overlay = this.document.querySelector(".cdk-overlay-container");
    overlay.innerHTML = "";
    // Stand-in for the observed behaviour: registered names are upper case and
    // a lower-case search listed nothing for "systems limited".
    const needle = String(typed || "").trim();
    if (!needle) return;
    const hits = this.registry
      .filter((r) => r.name.includes(needle))
      .slice(0, 10);
    if (!hits.length) return;
    const panel = this.document.createElement("div");
    panel.className = "mat-mdc-autocomplete-panel";
    for (const hit of hits) {
      const option = this.document.createElement(this.optionsMarkup);
      if (this.optionsMarkup !== "mat-option")
        option.setAttribute("role", "option");
      option.className = "mat-mdc-option";
      option.dataset.regNo = hit.regNo;
      option.dataset.name = hit.name;
      option.innerHTML = `<span class="mdc-list-item__primary-text">${hit.name} | ${hit.regNo}</span>`;
      panel.appendChild(option);
    }
    overlay.appendChild(panel);
  }

  onInput(event) {
    const el = event.target;
    if (
      el &&
      el.getAttribute &&
      el.getAttribute("formcontrolname") === "employerName"
    ) {
      // Editing the name drops a registration number IRIS filled earlier.
      const reg = this.reg();
      if (reg && reg.disabled) {
        reg.value = "";
        reg.disabled = false;
      }
      const needle = String(el.value || "").trim();
      const hits = needle
        ? this.registry.filter((r) => r.name.includes(needle))
        : [];
      if (this.autoResolveSingle && hits.length === 1) {
        this.document.querySelector(".cdk-overlay-container").innerHTML = "";
        el.value = hits[0].name;
        reg.value = hits[0].regNo;
        reg.disabled = true;
        return;
      }
      this.showOptions(el.value);
    }
  }

  onClick(event) {
    const el = event.target;
    this.clicks.push(this.describe(el));
    const button = el.closest && el.closest("button");
    if (button && button.classList.contains("salary-employer-add-btn")) {
      if (!this.modal())
        this.document.body.insertAdjacentHTML("beforeend", this.modalHtml);
      return;
    }
    const option = el.closest && el.closest(this.optionsMarkup);
    if (option && option.dataset.regNo !== undefined) {
      this.name().value = option.dataset.name;
      this.reg().value = option.dataset.regNo;
      this.reg().disabled = true;
      this.document.querySelector(".cdk-overlay-container").innerHTML = "";
      return;
    }
    if (button && button.closest("mat-dialog-actions")) {
      const label = button.textContent
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (label === "cancel") {
        this.modal().remove();
      } else if (label === "add") {
        if (this.rejectAdd || !this.name().value || !this.reg().value) return;
        this.appendCard({ name: this.name().value, regNo: this.reg().value });
        this.modal().remove();
      }
    }
  }
}

module.exports = { FakeIrisEmployer };
