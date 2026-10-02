"use strict";

/**
 * Employer driver.
 *
 * IRIS 2.0 asks a salaried filer to list each employer on Employment > Salary:
 *
 *   "Employer Details" bar -> `+ Add Employer Details`
 *     -> "Add Employer" dialog (<app-add-employer>)
 *          Employer Registration No.   (filled and greyed by IRIS when a name is chosen)
 *          Add Employer Name           (autocomplete; options read "NAME | REGNO")
 *          Add / Cancel
 *
 * The client's rule (2026-10-02): adding the employer BY NAME is enough, and the
 * name must match the company's registered name. So this driver never types a
 * registration number and never guesses:
 *
 *   - It types the full name, waits for IRIS's own list, and picks an option only
 *     when exactly one registered name equals the packet's name (after a
 *     deliberately small normalisation: case, punctuation, "&"/"AND",
 *     "LTD"/"LIMITED", "PVT"/"PRIVATE").
 *   - No exact match, or several different registrations with the same name:
 *     it presses Cancel, reports the candidates, and the job pauses so the
 *     taxpayer can pick the right company in IRIS. Never the first option.
 *   - An employer already listed is left alone, so a re-run adds nothing.
 *
 * HARD LIMITS (the README rules still stand):
 *   - The only controls the page operations can click are: the
 *     `+ Add Employer Details` button, one autocomplete option inside the open
 *     Add Employer dialog, and that dialog's Add or Cancel button. The red
 *     delete icon, the edit icon on an employer card, and the return's Save,
 *     Submit and Calculate controls are unreachable by construction, and the
 *     test suite proves it.
 *   - Add is pressed only after the dialog shows the chosen registered name and a
 *     registration number that IRIS filled in. After Add nothing is retried: if
 *     the new card cannot be confirmed the employer is reported for review.
 *   - Dry mode never clicks inside the page; it only reads and reports.
 */

const BUILD_TAG = "fix34-tax-year-employer-20261002";

const EMPLOYER_STATUS = Object.freeze({
  ALREADY_LISTED: "already_listed",
  ADDED: "added",
  /** Dry run: this employer would be added. Nothing was clicked. */
  WOULD_ADD: "would_add_dry_run",
  NO_EXACT_MATCH: "employer_no_exact_match",
  AMBIGUOUS: "employer_ambiguous_match",
  SECTION_UNAVAILABLE: "employer_section_unavailable",
  SETUP_FAILED: "employer_setup_failed",
  /** The dialog closed after Add but the card could not be confirmed. */
  ADDED_UNVERIFIED: "employer_added_unverified",
});

const SUCCESS_STATUSES = new Set([
  EMPLOYER_STATUS.ALREADY_LISTED,
  EMPLOYER_STATUS.ADDED,
  EMPLOYER_STATUS.WOULD_ADD,
]);

const SECTION_ID = "salary";
const MAX_EMPLOYERS = 10;

/** The only page operations that exist. Anything else is refused in Node. */
const PAGE_OPS = Object.freeze([
  "inspect",
  "open_add",
  "modal_state",
  "modal_type_name",
  "modal_pick_option",
  "modal_click",
]);

const MODAL_BUTTONS = Object.freeze(["add", "cancel"]);

/**
 * Runs INSIDE the IRIS page (it is stringified and sent through
 * executeJavaScript), so it must not touch any Node-side variable. One call =
 * one operation = at most one click.
 */
function employerPageOp(step) {
  const norm = (v) =>
    String(v == null ? "" : v)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    for (
      let node = el;
      node && node.nodeType === 1;
      node = node.parentElement
    ) {
      if (node.hidden) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
    }
    return true;
  };
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  const addButtons = () =>
    Array.from(
      document.querySelectorAll("button.salary-employer-add-btn"),
    ).filter(visible);
  // Cards are normally ".salary-employer-card". When IRIS marks them up
  // differently, the children of the list body that follows the section header
  // (".salary-employer-header" + ".panel-body" in the real capture) are the cards.
  const cards = () => {
    const named = Array.from(
      document.querySelectorAll(".salary-employer-card"),
    ).filter(visible);
    if (named.length) return named;
    const header = document.querySelector(".salary-employer-header");
    const body = header && header.nextElementSibling;
    if (!body) return [];
    return Array.from(body.children).filter(
      (child) => visible(child) && text(child),
    );
  };
  const cardText = (card) =>
    text(card.querySelector(".salary-employer-card-text") || card);
  const modals = () =>
    Array.from(document.querySelectorAll("app-add-employer")).filter(visible);
  const otherDialogTitles = () =>
    Array.from(document.querySelectorAll("mat-dialog-container"))
      .filter(visible)
      .filter((dialog) => !dialog.querySelector("app-add-employer"))
      .map((dialog) => {
        const head = dialog.querySelector("[mat-dialog-title], h6");
        return head
          ? text(head)
              .replace(/close\s*$/i, "")
              .trim()
          : "dialog";
      });
  const nameInput = (modal) =>
    modal.querySelector('input[formcontrolname="employerName"]');
  const regInput = (modal) =>
    modal.querySelector('input[formcontrolname="employerRegNo"]');
  const optionEls = () =>
    Array.from(document.querySelectorAll('mat-option, [role="option"]')).filter(
      visible,
    );
  const actionButtons = (modal) => {
    const dialog = modal.closest("mat-dialog-container") || modal;
    return Array.from(dialog.querySelectorAll("mat-dialog-actions button"));
  };
  const setNative = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    try {
      el.focus();
    } catch (e) {}
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    // No blur: the autocomplete list stays open while the field has focus.
  };

  const op = step.op;

  if (op === "inspect") {
    return {
      status: "ok",
      addButtonCount: addButtons().length,
      cards: cards().map(cardText),
      // Kept short; logged only when a card cannot be confirmed, so the real
      // card markup can be seen afterwards.
      listHtml: (() => {
        const header = document.querySelector(".salary-employer-header");
        const body = header && header.nextElementSibling;
        return body ? body.outerHTML.replace(/\s+/g, " ").slice(0, 1200) : "";
      })(),
      modalOpen: modals().length > 0,
      otherDialogs: otherDialogTitles(),
    };
  }

  if (op === "open_add") {
    if (modals().length || otherDialogTitles().length)
      return { status: "dialog_already_open" };
    const buttons = addButtons().filter((button) =>
      /add employer/.test(norm(button.textContent)),
    );
    if (buttons.length !== 1)
      return {
        status: buttons.length ? "ambiguous_button" : "button_not_found",
      };
    if (buttons[0].disabled) return { status: "button_disabled" };
    buttons[0].click();
    return { status: "clicked" };
  }

  if (op === "modal_state") {
    const found = modals();
    if (found.length !== 1)
      return {
        status: found.length ? "ambiguous_dialog" : "dialog_not_open",
        open: false,
      };
    const modal = found[0];
    const name = nameInput(modal);
    const reg = regInput(modal);
    const add = actionButtons(modal).find(
      (button) => norm(button.textContent) === "add",
    );
    return {
      status: "ok",
      open: true,
      name: name ? String(name.value || "") : null,
      regNo: reg ? String(reg.value || "") : null,
      regNoDisabled: Boolean(reg && (reg.disabled || reg.readOnly)),
      addEnabled: Boolean(add) && !add.disabled,
      options: optionEls().map(text),
    };
  }

  if (op === "modal_type_name") {
    const found = modals();
    if (found.length !== 1) return { status: "dialog_not_open" };
    const input = nameInput(found[0]);
    if (!input || input.disabled || input.readOnly)
      return { status: "field_not_found" };
    setNative(input, String(step.value));
    return { status: "set", readback: input.value };
  }

  if (op === "modal_pick_option") {
    if (modals().length !== 1) return { status: "dialog_not_open" };
    const matches = optionEls().filter(
      (option) => norm(text(option)) === norm(step.optionText),
    );
    if (matches.length !== 1)
      return {
        status: matches.length ? "ambiguous_option" : "option_not_found",
      };
    matches[0].click();
    return { status: "clicked" };
  }

  if (op === "modal_click") {
    const found = modals();
    if (found.length !== 1) return { status: "dialog_not_open" };
    const wanted = norm(step.button);
    const matches = actionButtons(found[0]).filter(
      (button) => norm(button.textContent) === wanted,
    );
    if (matches.length !== 1)
      return {
        status: matches.length ? "ambiguous_button" : "button_not_found",
      };
    if (matches[0].disabled) return { status: "button_disabled" };
    matches[0].click();
    return { status: "clicked" };
  }

  return { status: "unsupported_op" };
}

/** Refuses anything outside the documented click surface BEFORE it reaches the page. */
function assertAllowedStep(step) {
  if (!step || !PAGE_OPS.includes(step.op))
    throw new Error(
      `employer driver: operation "${step && step.op}" is not allowed`,
    );
  if (step.op === "modal_click") {
    const button = String(step.button || "")
      .trim()
      .toLowerCase();
    if (!MODAL_BUTTONS.includes(button))
      throw new Error(
        `employer driver: button "${step.button}" is not allowed`,
      );
  }
  if (step.op === "modal_type_name") {
    const value = String(step.value == null ? "" : step.value).trim();
    if (!value || value.length > 200)
      throw new Error(
        "employer driver: the employer name is empty or too long",
      );
  }
  if (step.op === "modal_pick_option" && !String(step.optionText || "").trim())
    throw new Error("employer driver: no option text given");
}

function buildPageScript(step) {
  assertAllowedStep(step);
  return `(${employerPageOp.toString()})(${JSON.stringify(step)})`;
}

/**
 * The comparison key for an employer name. Deliberately small: it forgives case,
 * punctuation and the usual "&"/"AND", "LTD"/"LIMITED", "PVT"/"PRIVATE"
 * spellings, and nothing else. A different company name must stay different.
 */
function employerNameKey(value) {
  const tokens = String(value == null ? "" : value)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,()'"\u2019\-_/\\:;]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) =>
      token === "LTD" ? "LIMITED" : token === "PVT" ? "PRIVATE" : token,
    );
  return tokens.join(" ");
}

/** "NAME | REGNO" -> { text, name, regNo }. A text with no bar has no regNo. */
function parseEmployerOption(optionText) {
  const raw = String(optionText == null ? "" : optionText)
    .replace(/\s+/g, " ")
    .trim();
  const bar = raw.lastIndexOf("|");
  if (bar < 0) return { text: raw, name: raw, regNo: "" };
  return {
    text: raw,
    name: raw.slice(0, bar).trim(),
    regNo: raw.slice(bar + 1).trim(),
  };
}

/**
 * Decide from IRIS's own option list. Pure.
 *   match     exactly one registration has this exact (normalised) name
 *   none      no option has this name; `candidates` lists what IRIS offered
 *   ambiguous several DIFFERENT registrations share the name
 */
function chooseEmployerOption(optionTexts, employerName) {
  const wanted = employerNameKey(employerName);
  const options = Array.from(optionTexts || []).map(parseEmployerOption);
  const exact = options.filter(
    (option) => wanted && employerNameKey(option.name) === wanted,
  );
  const distinct = [];
  for (const option of exact) {
    if (!distinct.some((seen) => seen.regNo === option.regNo))
      distinct.push(option);
  }
  if (distinct.length === 1) return { kind: "match", option: distinct[0] };
  if (distinct.length > 1)
    return { kind: "ambiguous", options: distinct.map((o) => o.text) };
  return {
    kind: "none",
    candidates: options.slice(0, 5).map((option) => option.text),
  };
}

/** The searches to try, in order: the full name, then its first two words. */
function employerQueries(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const queries = [words.join(" ")];
  if (words.length > 2) queries.push(words.slice(0, 2).join(" "));
  return queries;
}

/** True when a card's text names this employer (whole words) or carries its regNo. */
function cardMatchesEmployer(cardText, employerName, regNo) {
  const key = ` ${employerNameKey(cardText)} `;
  const wanted = employerNameKey(employerName);
  if (wanted && key.includes(` ${wanted} `)) return true;
  const reg = String(regNo || "").replace(/\s+/g, "");
  return (
    Boolean(reg) &&
    String(cardText || "")
      .replace(/\s+/g, "")
      .includes(reg)
  );
}

/** Unique, non-empty employer names in packet order. Pure. */
function planEmployers(names) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw == null ? "" : raw)
      .replace(/\s+/g, " ")
      .trim();
    const key = employerNameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, MAX_EMPLOYERS);
}

function summariseEmployers(results) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter((r) => SUCCESS_STATUSES.has(r.status)).length;
  return {
    total: list.length,
    ok,
    needsReview: list.length - ok,
    added: list.filter((r) => r.status === EMPLOYER_STATUS.ADDED).length,
    alreadyListed: list.filter(
      (r) => r.status === EMPLOYER_STATUS.ALREADY_LISTED,
    ).length,
  };
}

/** One sentence per employer that needs the taxpayer. English, user-facing. */
function describeEmployerIssues(results) {
  const lines = [];
  for (const r of results || []) {
    if (SUCCESS_STATUSES.has(r.status)) continue;
    const name = `"${r.name}"`;
    if (r.status === EMPLOYER_STATUS.NO_EXACT_MATCH) {
      lines.push(
        `Employer ${name} is not an exact match for any registered name in IRIS${
          r.candidates && r.candidates.length
            ? ` (IRIS offered: ${r.candidates.join("; ")})`
            : " (IRIS offered nothing)"
        }`,
      );
    } else if (r.status === EMPLOYER_STATUS.AMBIGUOUS) {
      lines.push(
        `Several IRIS registrations are named ${name} (${(
          r.candidates || []
        ).join("; ")})`,
      );
    } else if (r.setupStatus === NOT_ATTEMPTED) {
      lines.push(
        `Employer ${name} was not attempted because the Add Employer dialog could not be used for the previous employer`,
      );
    } else if (r.status === EMPLOYER_STATUS.ADDED_UNVERIFIED) {
      lines.push(
        `Employer ${name} was submitted but its card could not be confirmed in the Employer Details list`,
      );
    } else if (r.status === EMPLOYER_STATUS.SECTION_UNAVAILABLE) {
      lines.push(
        `Employer ${name} was not added because the Employer Details section could not be opened (${
          r.setupStatus || "unknown"
        })`,
      );
    } else {
      lines.push(
        `Employer ${name} was not added (${r.setupStatus || r.status})`,
      );
    }
  }
  return lines;
}

/** setupStatus of an employer skipped because the Add dialog stopped working. */
const NOT_ATTEMPTED = "not_attempted_dialog_unusable";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Add the packet's employers on the IRIS Salary page.
 *
 * options:
 *   mode            "live" | "dry"
 *   navigate(id)    -> { ok, status }   opens a section (navigateToSection)
 *   beforeStep()    awaited before every page operation (job-cancel check)
 *   onStep(step, detail)
 *   sleep(ms), timeoutMs
 *
 * Returns { results, setup }; `results` has one entry per distinct employer.
 */
async function runEmployerDriver(windowInstance, employerNames, options = {}) {
  const {
    mode = "dry",
    navigate,
    beforeStep = async () => {},
    onStep = () => {},
    sleep = defaultSleep,
    timeoutMs = 8000,
  } = options;
  const live = mode === "live";
  const names = planEmployers(employerNames);
  const results = [];
  const setup = [];
  const note = (step, detail) => {
    setup.push({ step, detail });
    onStep(`employer_${step}`, detail);
  };
  if (!names.length) return { results, setup };

  const run = async (step) => {
    await beforeStep();
    return windowInstance.webContents.executeJavaScript(buildPageScript(step));
  };
  const waitFor = async (producer, accept, limitMs = timeoutMs) => {
    const deadline = Date.now() + limitMs;
    let last;
    do {
      last = await producer();
      if (accept(last)) return { ok: true, value: last };
      await sleep(250);
    } while (Date.now() < deadline);
    return { ok: false, value: last };
  };
  const failAll = (status, setupStatus) => {
    for (const name of names) results.push({ name, status, setupStatus });
  };

  let moved;
  try {
    moved = await navigate(SECTION_ID);
  } catch (error) {
    moved = {
      ok: false,
      status: `navigation_error: ${error && error.message}`,
    };
  }
  if (!moved || !moved.ok) {
    note(
      "section_unavailable",
      `Salary page could not be opened (${moved && moved.status}). ${names.length} employer(s) left untouched.`,
    );
    failAll(EMPLOYER_STATUS.SECTION_UNAVAILABLE, moved && moved.status);
    return { results, setup };
  }

  let probe = await run({ op: "inspect" });
  if (probe.modalOpen || (probe.otherDialogs && probe.otherDialogs.length)) {
    note(
      "unexpected_dialog",
      `A dialog is already open on the Salary page; nothing was clicked.`,
    );
    failAll(EMPLOYER_STATUS.SETUP_FAILED, "unexpected_dialog_open");
    return { results, setup };
  }
  if (!probe.addButtonCount) {
    note(
      "section_unavailable",
      `The "+ Add Employer Details" button is not visible on the Salary page. ${names.length} employer(s) left untouched.`,
    );
    failAll(EMPLOYER_STATUS.SECTION_UNAVAILABLE, "add_button_not_found");
    return { results, setup };
  }

  note(
    "cards_seen",
    `${probe.cards.length} employer card(s) visible in IRIS${
      probe.cards.length
        ? `: ${probe.cards.map((card) => `"${card.slice(0, 80)}"`).join("; ")}`
        : ""
    }.`,
  );

  const cancelModal = async () => {
    if (!live) return;
    try {
      await run({ op: "modal_click", button: "cancel" });
    } catch (error) {
      note(
        "cancel_failed",
        `The Add Employer dialog could not be closed (${error && error.message}).`,
      );
    }
  };

  let stop = null; // once set, remaining employers are not attempted
  for (const name of names) {
    if (stop) {
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: stop,
      });
      continue;
    }
    probe = await run({ op: "inspect" });
    if (probe.cards.some((card) => cardMatchesEmployer(card, name))) {
      note(
        "already_listed",
        `"${name}" is already in the Employer Details list.`,
      );
      results.push({ name, status: EMPLOYER_STATUS.ALREADY_LISTED });
      continue;
    }
    if (!live) {
      note(
        "would_add",
        `Dry run: "${name}" would be added by name. Nothing clicked.`,
      );
      results.push({ name, status: EMPLOYER_STATUS.WOULD_ADD });
      continue;
    }
    const cardsBefore = probe.cards.length;

    const opened = await run({ op: "open_add" });
    if (opened.status !== "clicked") {
      note(
        "open_failed",
        `"${name}": the Add Employer dialog did not open (${opened.status}).`,
      );
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: opened.status,
      });
      stop = NOT_ATTEMPTED;
      continue;
    }
    const dialog = await waitFor(
      () => run({ op: "modal_state" }),
      (state) => state.open,
    );
    if (!dialog.ok) {
      note(
        "dialog_timeout",
        `"${name}": the Add Employer dialog never appeared.`,
      );
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: "dialog_not_open",
      });
      stop = NOT_ATTEMPTED;
      continue;
    }

    // IRIS filters its own list as the name is typed. The full name goes first;
    // when that lists nothing exact (IRIS may spell "PVT." where the certificate
    // says "Private"), the first two words are tried once to widen the list. The
    // exact-name rule applies to whatever IRIS lists, so widening never guesses.
    let choice = { kind: "none", candidates: [] };
    let typeFailure = null;
    for (const query of employerQueries(name)) {
      const typed = await run({ op: "modal_type_name", value: query });
      if (typed.status !== "set") {
        typeFailure = typed.status;
        break;
      }
      const listed = await waitFor(
        () => run({ op: "modal_state" }),
        (state) => chooseEmployerOption(state.options, name).kind !== "none",
      );
      choice = chooseEmployerOption((listed.value || {}).options, name);
      if (choice.kind !== "none") break;
    }
    if (typeFailure) {
      note(
        "type_failed",
        `"${name}": the name could not be typed (${typeFailure}).`,
      );
      await cancelModal();
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: typeFailure,
      });
      stop = NOT_ATTEMPTED;
      continue;
    }
    if (choice.kind === "none" || choice.kind === "ambiguous") {
      const ambiguous = choice.kind === "ambiguous";
      note(
        ambiguous ? "ambiguous_match" : "no_exact_match",
        `"${name}": ${
          ambiguous
            ? `several registrations share this name (${choice.options.join("; ")})`
            : `no exact registered-name match (IRIS offered ${
                choice.candidates.length
                  ? choice.candidates.join("; ")
                  : "nothing"
              })`
        }. Dialog cancelled, nothing added.`,
      );
      await cancelModal();
      results.push({
        name,
        status: ambiguous
          ? EMPLOYER_STATUS.AMBIGUOUS
          : EMPLOYER_STATUS.NO_EXACT_MATCH,
        candidates: ambiguous ? choice.options : choice.candidates,
      });
      continue;
    }

    const picked = choice.option;
    // A card for this registration may already exist under a different spelling.
    if (
      probe.cards.some((card) =>
        cardMatchesEmployer(card, picked.name, picked.regNo),
      )
    ) {
      note(
        "already_listed",
        `"${name}" is already listed (registration ${picked.regNo}).`,
      );
      await cancelModal();
      results.push({
        name,
        status: EMPLOYER_STATUS.ALREADY_LISTED,
        regNo: picked.regNo,
      });
      continue;
    }

    const clicked = await run({
      op: "modal_pick_option",
      optionText: picked.text,
    });
    if (clicked.status !== "clicked") {
      note(
        "pick_failed",
        `"${name}": the list option could not be chosen (${clicked.status}).`,
      );
      await cancelModal();
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: clicked.status,
      });
      continue;
    }
    const chosen = await waitFor(
      () => run({ op: "modal_state" }),
      (state) =>
        state.open &&
        employerNameKey(state.name).includes(employerNameKey(picked.name)) &&
        (!picked.regNo ||
          String(state.regNo || "").replace(/\s+/g, "") ===
            picked.regNo.replace(/\s+/g, "")),
    );
    if (!chosen.ok || !chosen.value.addEnabled) {
      note(
        "selection_not_confirmed",
        `"${name}": the dialog did not show the chosen registered name and registration number, so Add was not pressed.`,
      );
      await cancelModal();
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: "selection_not_confirmed",
      });
      continue;
    }

    const added = await run({ op: "modal_click", button: "add" });
    if (added.status !== "clicked") {
      note(
        "add_failed",
        `"${name}": Add could not be pressed (${added.status}).`,
      );
      await cancelModal();
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: added.status,
      });
      continue;
    }
    // Add was pressed. From here nothing is retried.
    const closed = await waitFor(
      () => run({ op: "modal_state" }),
      (state) => !state.open,
    );
    if (!closed.ok) {
      note("add_rejected", `"${name}": IRIS kept the dialog open after Add.`);
      await cancelModal();
      results.push({
        name,
        status: EMPLOYER_STATUS.SETUP_FAILED,
        setupStatus: "add_rejected_by_iris",
        regNo: picked.regNo,
      });
      stop = NOT_ATTEMPTED;
      continue;
    }
    let lastState = null;
    const shown = await waitFor(
      async () => {
        lastState = await run({ op: "inspect" });
        return lastState;
      },
      (state) =>
        state.cards.some((card) =>
          cardMatchesEmployer(card, picked.name, picked.regNo),
        ) || state.cards.length > cardsBefore,
      // IRIS saves the employer on its server before the card is drawn.
      timeoutMs * 2,
    );
    if (shown.ok) {
      note(
        "added",
        `"${name}" added (registration ${picked.regNo || "filled by IRIS"}).`,
      );
      results.push({
        name,
        status: EMPLOYER_STATUS.ADDED,
        regNo: picked.regNo,
      });
    } else {
      note(
        "added_unverified",
        `"${name}": the dialog closed after Add but no new employer card appeared.${
          lastState && lastState.listHtml
            ? ` Employer list markup seen: ${lastState.listHtml}`
            : ""
        }`,
      );
      results.push({
        name,
        status: EMPLOYER_STATUS.ADDED_UNVERIFIED,
        regNo: picked.regNo,
      });
      // The dialog closed cleanly, so the next employer can still be tried.
    }
  }
  return { results, setup };
}

module.exports = {
  BUILD_TAG,
  EMPLOYER_STATUS,
  SUCCESS_STATUSES,
  PAGE_OPS,
  employerPageOp,
  assertAllowedStep,
  buildPageScript,
  employerNameKey,
  employerQueries,
  parseEmployerOption,
  chooseEmployerOption,
  cardMatchesEmployer,
  planEmployers,
  summariseEmployers,
  describeEmployerIssues,
  runEmployerDriver,
};
