/**
 * The rules an approved CNIC may apply to the profile, and the rules that let an
 * already-approved card be reused for the next tax year instead of asking for it
 * again — offline because the whole point is that no card, no vision call and no
 * database are needed to prove the decisions.
 *
 *   npm run verify:cnic-profile-plan
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const { readFileSync } = fs;

// Resolve "@/..." and compile TypeScript on require, like the other verify scripts.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(root, request.slice(2));
  }
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    filename,
  );
};
const {
  readCnicValidity,
  planCnicProfileUpdate,
  describeCnicProfilePlan,
  formatCnicNumber,
  planIdentityCarryForward,
  describeIdentityCarryForward,
  CARRY_FORWARD_DOCUMENT_TYPES,
} = require(path.join(root, "lib/tax/cnic-profile.ts"));

let assertions = 0;
const check = (fn) => {
  assertions += 1;
  return fn();
};

test("a fresh profile gets every identity field the card carries", () => {
  const plan = planCnicProfileUpdate({
    profile: { name: null, cnic: null, dateOfBirth: null, address: null },
    extracted: {
      name: "Ayesha  Malik",
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14T00:00:00.000Z"),
      address: "House 12, Street 4, DHA Phase 5, Lahore",
    },
  });

  check(() => assert.equal(plan.missingDateOfBirth, false));
  check(() => assert.equal(plan.update.name, "Ayesha Malik", "whitespace collapsed"));
  check(() =>
    assert.equal(plan.update.cnic, "42201-4421816-3", "stored in the profile form's format"),
  );
  check(() => assert.equal(plan.update.address.includes("Lahore"), true));
  check(() => assert.ok(plan.update.dateOfBirth instanceof Date));
  check(() =>
    assert.deepEqual(plan.filled.slice().sort(), ["address", "cnic", "dateOfBirth", "name"]),
  );
  // "father name" is deliberately absent — the User model has no such column.
  check(() => assert.equal(JSON.stringify(plan.update).includes("father"), false));
  check(() => assert.deepEqual(plan.skipped, []));
  check(() => assert.deepEqual(plan.overwritten, []));
});

test("the card's name wins over a login-supplied one, and the change is reported", () => {
  const plan = planCnicProfileUpdate({
    profile: {
      name: "Ali Raza Khan",
      cnic: null,
      dateOfBirth: null,
      address: null,
    },
    extracted: {
      name: "Ayesha Malik",
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14T00:00:00.000Z"),
      address: null,
    },
  });

  // The identity document, not the Google account, defines the legal name.
  check(() => assert.equal(plan.update.name, "Ayesha Malik"));
  check(() =>
    assert.deepEqual(plan.overwritten, [
      { field: "name", previous: "Ali Raza Khan" },
    ]),
  );
  // The person is told what was replaced, never left to discover it later.
  const note = describeCnicProfilePlan(plan);
  check(() => assert.ok(note.includes("legal name (was Ali Raza Khan)"), note));
});

test("an identical name is not rewritten, only confirmed", () => {
  const plan = planCnicProfileUpdate({
    profile: { name: "ayesha malik", cnic: null, dateOfBirth: null, address: null },
    extracted: { name: "Ayesha Malik" },
  });

  check(() => assert.equal(plan.update.name, undefined));
  check(() => assert.deepEqual(plan.overwritten, []));
  check(() =>
    assert.equal(
      plan.skipped.find((entry) => entry.field === "name")?.reason,
      "The profile already carries this name.",
    ),
  );
});

test("a card with no readable date of birth is a refusal, not a guess", () => {
  const plan = planCnicProfileUpdate({
    profile: { name: "Ayesha Malik", cnic: "42201-4421816-3", dateOfBirth: null },
    extracted: { name: "Ayesha  Malik", cnic: "422014421816 3", dateOfBirth: null },
  });

  check(() => assert.equal(plan.missingDateOfBirth, true));
  check(() => assert.equal(plan.update.dateOfBirth, undefined));
  // Nothing is written for fields that already match, so the update can be empty.
  check(() => assert.deepEqual(plan.update, {}));
});

test("a 13-digit CNIC is stored dashed and compared on digits", () => {
  check(() => assert.equal(formatCnicNumber("4220144218163"), "42201-4421816-3"));
  check(() => assert.equal(formatCnicNumber("42201 4421816 3"), "42201-4421816-3"));
  check(() => assert.equal(formatCnicNumber("42201-4421816-3"), "42201-4421816-3"));
  check(() => assert.equal(formatCnicNumber("12345"), "12345", "junk is not formatted"));

  const plan = planCnicProfileUpdate({
    profile: { name: null, cnic: "4220144218163", dateOfBirth: null },
    extracted: { cnic: "42201-4421816-3", dateOfBirth: new Date("1988-03-14") },
  });
  check(() => assert.equal(plan.update.cnic, undefined, "same number, different punctuation"));
  check(() =>
    assert.equal(
      plan.skipped.find((entry) => entry.field === "cnic")?.reason,
      "The profile already carries this CNIC.",
    ),
  );
});

test("the card's CNIC replaces a wrong one, unless another account claims it", () => {
  const corrected = planCnicProfileUpdate({
    profile: { name: "Ayesha Malik", cnic: "42201-1111111-1", dateOfBirth: null },
    extracted: {
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14"),
    },
  });
  check(() => assert.equal(corrected.update.cnic, "42201-4421816-3"));
  check(() =>
    assert.deepEqual(corrected.overwritten, [
      { field: "cnic", previous: "42201-1111111-1" },
    ]),
  );

  const refused = planCnicProfileUpdate({
    profile: { name: "Ayesha Malik", cnic: "42201-1111111-1", dateOfBirth: null },
    extracted: {
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14"),
    },
    cnicTakenByOtherAccount: true,
  });
  check(() => assert.equal(refused.update.cnic, undefined, "never a database collision"));
  check(() =>
    assert.ok(
      refused.skipped.find((entry) => entry.field === "cnic").reason.includes("Another account"),
    ),
  );
});

test("an address already on the profile survives a card that has gone stale", () => {
  const plan = planCnicProfileUpdate({
    profile: { name: null, cnic: null, dateOfBirth: null, address: "Flat 2, Karachi" },
    extracted: { address: "House 12, Lahore", dateOfBirth: new Date("1988-03-14") },
  });

  check(() => assert.equal(plan.update.address, undefined));
  check(() =>
    assert.equal(
      plan.skipped.find((entry) => entry.field === "address")?.reason,
      "The profile already has an address; a CNIC goes stale, so it was kept.",
    ),
  );
});

test("a profile that already matches the card is confirmed, not re-announced", () => {
  const dob = new Date("1988-03-14T00:00:00.000Z");
  const plan = planCnicProfileUpdate({
    profile: {
      name: "Ayesha Malik",
      cnic: "42201-4421816-3",
      dateOfBirth: dob,
      address: "House 12, Lahore",
    },
    extracted: {
      name: "Ayesha Malik",
      cnic: "4220144218163",
      dateOfBirth: dob,
      address: "House 12, Lahore",
      expiryDate: "2029-01-31",
    },
    today: new Date("2026-09-10T09:00:00.000Z"),
  });

  check(() => assert.deepEqual(plan.update, {}, "nothing to write"));
  const note = describeCnicProfilePlan(plan);
  check(() =>
    assert.equal(note, "Nothing new was written to your profile. Left as you had it: date of birth, legal name, CNIC number and address."),
  );
  // The date is compared on the calendar day, not on the timestamp string.
  check(() =>
    assert.equal(
      planIdentityCarryForward({
        documentType: "cnic",
        draftAlreadyHasIt: false,
        profileVerified: true,
        hasPriorUpload: true,
        priorTaxYear: 2026,
      }).copy,
      true,
      "and the card is still reusable for the next year",
    ),
  );
});

test("a refused number is explained in the note, not swallowed", () => {
  const plan = planCnicProfileUpdate({
    profile: { name: "Ayesha Malik", cnic: "42201-1111111-1", dateOfBirth: null, address: null },
    extracted: {
      name: "Ayesha Malik",
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14"),
      address: null,
    },
    cnicTakenByOtherAccount: true,
  });

  check(() => assert.equal(plan.update.cnic, undefined));
  check(() =>
    assert.equal(
      plan.skipped.find((entry) => entry.field === "cnic")?.kind,
      "refused",
    ),
  );
  const note = describeCnicProfilePlan(plan);
  check(() => assert.ok(note.includes("Another account already uses this CNIC"), note));
  check(() => assert.ok(note.includes("upload was not rejected"), note));
});

test("the note names the rewrites and what was left alone", () => {
  const plan = planCnicProfileUpdate({
    profile: {
      name: "Ali Raza Khan",
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14"),
      address: "Flat 2, Karachi",
    },
    extracted: {
      name: "Ayesha Malik",
      cnic: "42201-4421816-3",
      dateOfBirth: new Date("1988-03-14"),
      address: "House 12, Lahore",
      expiryDate: "2029-01-31",
    },
    today: new Date("2026-09-10T09:00:00.000Z"),
  });

  const note = describeCnicProfilePlan(plan);
  check(() =>
    assert.equal(
      note,
      "Profile updated from the CNIC: legal name (was Ali Raza Khan). Left as you had it: date of birth, CNIC number and address.",
    ),
  );
  check(() => assert.ok(note.includes("legal name (was Ali Raza Khan)"), note));
  // The plan's reason strings are not the note's wording; the note must not leak them.
  check(() => assert.equal(note.includes("profile already carries"), false));

  check(() => assert.equal(describeCnicProfilePlan(null), null));
  check(() => assert.equal(describeCnicProfilePlan({ filled: [], skipped: [] }), null));
  const filledOnly = describeCnicProfilePlan({ filled: ["dateOfBirth"], skipped: [] });
  check(() =>
    assert.equal(filledOnly, "Profile updated from the CNIC: date of birth."),
  );
});

/* ------------------------------------------------------------------ *
 * reusing the approved card for the next filing year                   *
 * ------------------------------------------------------------------ */

test("an approved CNIC carries forward to a new tax year", () => {
  const plan = planIdentityCarryForward({
    documentType: "cnic",
    draftAlreadyHasIt: false,
    profileVerified: true,
    hasPriorUpload: true,
    priorTaxYear: 2026,
  });

  check(() => assert.equal(plan.copy, true));
  check(() => assert.equal(plan.reason, "copied"));
  const note = describeIdentityCarryForward([plan]);
  check(() => assert.ok(note.includes("CNIC number reused from your Tax Year 2026 filing"), note));
  check(() => assert.ok(note.includes("do not need to upload it again"), note));
});

test("a filing that already has the card, or has nothing to reuse, says nothing", () => {
  const already = planIdentityCarryForward({
    documentType: "cnic",
    draftAlreadyHasIt: true,
    profileVerified: true,
    hasPriorUpload: true,
  });
  check(() => assert.equal(already.copy, false));
  check(() => assert.equal(already.reason, "already_present"));
  check(() => assert.equal(describeIdentityCarryForward([already]), null));

  const firstTime = planIdentityCarryForward({
    documentType: "cnic",
    draftAlreadyHasIt: false,
    profileVerified: false,
    hasPriorUpload: false,
  });
  check(() => assert.equal(firstTime.copy, false));
  const note = describeIdentityCarryForward([firstTime]);
  check(() => assert.ok(note.includes("no verified CNIC and date of birth"), note));
});

test("reuse is refused when the profile is not verified, and explained", () => {
  const plan = planIdentityCarryForward({
    documentType: "cnic",
    draftAlreadyHasIt: false,
    profileVerified: false,
    hasPriorUpload: true,
    priorTaxYear: 2026,
  });

  check(() => assert.equal(plan.copy, false, "never copy an unapproved document"));
  check(() => assert.equal(plan.reason, "profile_not_verified"));
  check(() => assert.ok(describeIdentityCarryForward([plan]).includes("this filing needs the upload")));
});

test("only identity documents are ever carried forward", () => {
  check(() => assert.deepEqual([...CARRY_FORWARD_DOCUMENT_TYPES], ["cnic"]));
  for (const documentType of [
    "salary_certificate",
    "bank_statement",
    "rent_agreement",
    "property_document",
  ]) {
    const plan = planIdentityCarryForward({
      documentType,
      draftAlreadyHasIt: false,
      profileVerified: true,
      hasPriorUpload: true,
      priorTaxYear: 2026,
    });
    // A salary certificate is for one year; reusing last year's would report
    // last year's income as this year's.
    check(() => assert.equal(plan.copy, false, documentType));
    check(() => assert.equal(plan.reason, "not_an_identity_document", documentType));
  }
  check(() => assert.equal(describeIdentityCarryForward([]), null));
  check(() => assert.equal(describeIdentityCarryForward(undefined), null));
});

test("the reuse note never invents a tax year it does not have", () => {
  const withYear = describeIdentityCarryForward([
    { documentType: "cnic", reason: "copied", sourceTaxYear: 2026 },
  ]);
  check(() => assert.ok(withYear.includes("your Tax Year 2026 filing"), withYear));

  const withoutYear = describeIdentityCarryForward([
    { documentType: "cnic", reason: "copied", sourceTaxYear: null },
  ]);
  check(() => assert.ok(withoutYear.includes("an earlier filing"), withoutYear));
  check(() => assert.equal(withoutYear.includes("Tax Year previous"), false));

  const unknown = describeIdentityCarryForward([
    { documentType: "cnic", reason: "database_unavailable" },
  ]);
  check(() => assert.ok(unknown.includes("could not be reused automatically"), unknown));
});

/* ------------------------------------------------------------------ *
 * an expired card is not proof of identity                             *
 * ------------------------------------------------------------------ */

test("the printed expiry date is read day-first and judged against today", () => {
  const today = new Date("2026-09-10T09:00:00.000Z");

  check(() =>
    assert.equal(readCnicValidity({ expiryDate: "2027-03-11", today }).status, "valid"),
  );
  // NADRA prints "Valid Upto 10/09/2026": the printed day itself is still usable.
  check(() =>
    assert.equal(
      readCnicValidity({ expiryDate: "2026-09-10", today }).status,
      "valid",
      "expiry day is inclusive",
    ),
  );
  check(() =>
    assert.equal(
      readCnicValidity({ expiryDate: "2026-09-09", today }).status,
      "expired",
    ),
  );
  // 01/02/2026 is 1 February, not 2 January: the difference decides validity.
  const dayFirst = readCnicValidity({ expiryDate: "01/02/2026", today });
  check(() => assert.equal(dayFirst.expiry, "2026-02-01"));
  check(() => assert.equal(dayFirst.status, "expired"));
});

test("a missing or unreadable expiry date is never guessed as expired", () => {
  const today = new Date("2026-09-10T09:00:00.000Z");
  for (const value of [null, undefined, "", "N/A", "31/02/2027", "12/03/26"]) {
    const validity = readCnicValidity({ expiryDate: value, today });
    // Older laminated cards print no expiry date at all, and a two-digit year is
    // not something to invent a century for.
    check(() => assert.equal(validity.status, "unread", JSON.stringify(value)));
    check(() => assert.equal(validity.expiry, null, String(value)));
    check(() =>
      assert.ok(validity.message.includes("could not be checked"), String(value)),
    );
  }
});

test("an expired card writes nothing to the profile", () => {
  const plan = planCnicProfileUpdate({
    profile: { name: "Ali Raza Khan", cnic: null, dateOfBirth: null, address: null },
    extracted: {
      name: "Ayesha Malik",
      cnic: "4220144218163",
      dateOfBirth: new Date("1988-03-14"),
      address: "House 12, Lahore",
      expiryDate: "2024-03-12",
    },
    today: new Date("2026-09-10T09:00:00.000Z"),
  });

  check(() => assert.equal(plan.expired, true));
  check(() => assert.deepEqual(plan.update, {}, "a lapsed card establishes nothing"));
  check(() => assert.deepEqual(plan.filled, []));
  // No success sentence, because nothing was approved.
  check(() => assert.equal(describeCnicProfilePlan(plan), null));
  const refusal = plan.validity.message;
  check(() => assert.ok(refusal.includes("expired on 12 March 2024"), refusal));
  check(() => assert.ok(refusal.includes("renewed card"), refusal));
});

test("a valid card's expiry is not announced, an unchecked one is", () => {
  const today = new Date("2026-09-10T09:00:00.000Z");
  const valid = planCnicProfileUpdate({
    profile: { name: null, cnic: null, dateOfBirth: null, address: null },
    extracted: {
      name: "Ayesha Malik",
      cnic: "4220144218163",
      dateOfBirth: new Date("1988-03-14"),
      expiryDate: "2029-01-31",
    },
    today,
  });
  check(() => assert.equal(valid.expired, false));
  check(() => assert.equal(valid.validity.status, "valid"));
  check(() => assert.equal(describeCnicProfilePlan(valid).includes("validity"), false));

  const unchecked = planCnicProfileUpdate({
    profile: { name: null, cnic: null, dateOfBirth: null, address: null },
    extracted: {
      name: "Ayesha Malik",
      cnic: "4220144218163",
      dateOfBirth: new Date("1988-03-14"),
    },
    today,
  });
  check(() => assert.equal(unchecked.expired, false, "no expiry printed is not a refusal"));
  check(() =>
    assert.ok(
      describeCnicProfilePlan(unchecked).endsWith("renew it at NADRA before filing."),
      "the gap is disclosed, at the end of the note",
    ),
  );
});

test("a card that has since lapsed is never carried forward to a new year", () => {
  const lapsed = planIdentityCarryForward({
    documentType: "cnic",
    draftAlreadyHasIt: false,
    profileVerified: true,
    hasPriorUpload: true,
    priorTaxYear: 2025,
    priorExpired: true,
    priorExpiry: "2026-01-31",
  });
  check(() => assert.equal(lapsed.copy, false));
  check(() => assert.equal(lapsed.reason, "prior_expired"));
  const note = describeIdentityCarryForward([lapsed]);
  check(() =>
    assert.ok(note.includes("Tax Year 2025 filing expired on 31 January 2026"), note),
  );
  check(() => assert.ok(note.includes("Upload the renewed card"), note));

  // A payload saved before expiry was ever read is "unchecked", not "expired".
  const legacy = planIdentityCarryForward({
    documentType: "cnic",
    draftAlreadyHasIt: false,
    profileVerified: true,
    hasPriorUpload: true,
    priorTaxYear: 2025,
    priorExpired: false,
    priorExpiry: null,
  });
  check(() => assert.equal(legacy.copy, true));
  check(() => assert.equal(legacy.reason, "copied"));

  // And an unknown year or date is phrased without inventing either.
  check(() =>
    assert.ok(
      describeIdentityCarryForward([
        { documentType: "cnic", reason: "prior_expired" },
      ]).includes("your earlier filing expired on its printed date"),
    ),
  );
});

test("the reuse decision is used by an action that copies the approved row only", () => {
  const action = readFileSync(path.join(root, "app/actions/extraction.ts"), "utf8");
  const wizard = readFileSync(
    path.join(root, "components/tax/filing/filing-wizard.tsx"),
    "utf8",
  );
  const step = readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );

  const bodyStart = action.indexOf("export async function carryForwardIdentityDocumentsAction");
  check(() => assert.notEqual(bodyStart, -1, "the action must exist"));
  const body = action.slice(bodyStart, action.indexOf("export async function", bodyStart + 10));
  const block = (anchor) => {
    const from = body.indexOf(anchor);
    check(() => assert.notEqual(from, -1, anchor));
    return body.slice(from, body.indexOf("});", from));
  };

  check(() => assert.ok(body.includes("CARRY_FORWARD_DOCUMENT_TYPES"), "loops over the allowlist"));
  check(() => assert.ok(body.includes("planIdentityCarryForward"), "delegates the decision"));

  const priorQuery = block("const prior = await prisma.document.findFirst({");
  check(() =>
    assert.ok(
      priorQuery.includes('extractionStatus: "MAPPED"'),
      "the source must be an approved card — a file that was uploaded and never reviewed proves nothing",
    ),
  );
  check(() =>
    assert.ok(
      priorQuery.includes("userId: draft.userId"),
      "never another taxpayer's document",
    ),
  );
  check(() =>
    assert.ok(
      priorQuery.includes("filingDraftId: { not: draft.id }"),
      "from an earlier filing, not the current one",
    ),
  );

  const presentQuery = block("const present = await prisma.document.findFirst({");
  check(() =>
    assert.ok(
      presentQuery.includes('extractionStatus: "MAPPED"'),
      "an unapproved file in this draft is not a reason to stay empty",
    ),
  );

  const profileQuery = block("const profile = await prisma.user.findUnique({");
  check(() =>
    assert.deepEqual(
      ["cnic", "dateOfBirth"].filter((field) => profileQuery.includes(field)),
      ["cnic", "dateOfBirth"],
      "verification is judged on exactly the two fields an approval writes",
    ),
  );

  const reuseValidity = block("const priorValidity = readCnicValidity({");
  check(() =>
    assert.ok(
      reuseValidity.includes("prior?.extractedData"),
      "validity is judged from the stored payload of the approved card",
    ),
  );
  check(() =>
    assert.ok(
      body.includes('priorExpired: priorValidity.status === "expired"'),
      "only an explicit expiry makes it lapsed — an unread expiry must not lock the taxpayer out",
    ),
  );
  check(() =>
    assert.ok(
      body.includes("sourceExpiry: plan.sourceExpiry ?? null"),
      "the refusal names the date the card lapsed",
    ),
  );

  const insert = block("await prisma.document.create({");
  check(() => assert.ok(insert.includes('extractionStatus: "MAPPED"')));
  check(() => assert.ok(insert.includes("filingDraftId: draft.id")));
  check(() =>
    assert.equal(
      /extractionStatus:\s*"(?!MAPPED)/.test(body),
      false,
      "no other status may be written",
    ),
  );
  // A read path that writes must not be able to fail the step it improves.
  check(() =>
    assert.ok(
      /catch \(error\) \{[\s\S]{0,300}?return \{\s*success: false/.test(body),
      "any error falls back to the ordinary upload path instead of blocking the filing",
    ),
  );

  check(() =>
    assert.ok(
      wizard.indexOf("carryForwardIdentityDocumentsAction(draftId)") <
        wizard.indexOf("await getFilingDocumentsAction(draftId)"),
      "reuse happens before the slot list is built, so the step renders filled, not empty",
    ),
  );
  check(() => assert.ok(/describeIdentityCarryForward\(carried\.results\)/.test(wizard)));
  check(() =>
    assert.ok(
      /profileSyncNote=\{profileSyncNote\}/.test(wizard),
      "the wizard passes the note down to the documents step",
    ),
  );
  check(() =>
    assert.ok(
      /role="status"[\s\S]{0,200}\{profileSyncNote\}/.test(step),
      "the note renders as a status, not an error (an approved card is not a problem)",
    ),
  );
  check(() =>
    assert.equal(
      /\{profileSyncNote && \([\s\S]{0,140}role="alert"/.test(step),
      false,
      "the reuse note must never be styled as a failure",
    ),
  );
});

test("an approved CNIC writes the plan and nothing else", () => {
  const action = readFileSync(path.join(root, "app/actions/extraction.ts"), "utf8");
  const hook = readFileSync(
    path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"),
    "utf8",
  );

  const bodyStart = action.indexOf(
    'if (document.documentType === "cnic") {',
    action.indexOf("export async function approveAndMapExtractedDocumentAction"),
  );
  check(() => assert.notEqual(bodyStart, -1, "the CNIC branch must exist"));
  const bodyEnd = action.indexOf(
    'if (document.documentType === "salary_certificate")',
    bodyStart,
  );
  check(() => assert.notEqual(bodyEnd, -1, "the CNIC branch must be self-contained"));
  const body = action.slice(bodyStart, bodyEnd);

  // The write is the plan's, the refusal is the plan's, and nothing bypasses it.
  check(() => assert.ok(body.includes("planCnicProfileUpdate"), "delegates the decision"));
  const promptEnd = action.indexOf("`;", action.indexOf("Use this exact shape"));
  const prompt = action.slice(0, promptEnd);
  check(() => assert.ok(promptEnd > 0, "the extraction prompt must exist"));
  check(() =>
    assert.ok(prompt.includes('"Expiry Date"'), "the extractor is asked for the printed expiry"),
  );
  check(() =>
    assert.ok(
      prompt.includes("never use the issue date or the expiry date"),
      "and still never for the date of birth",
    ),
  );
  check(() =>
    assert.ok(prompt.includes("never infer one from the issue date"), "no invented expiry"),
  );
  check(() =>
    assert.ok(body.includes("data: plan.update"), "writes only what the plan allowed"),
  );
  check(() =>
    assert.ok(
      /if \(Object\.keys\(plan\.update\)\.length > 0\)/.test(body),
      "an empty plan means no profile write at all",
    ),
  );
  check(() => assert.ok(/if \(plan\.missingDateOfBirth\)/.test(body), "hard stop on no DOB"));

  // Expiry: read from its own label, refused before any write, and refused before
  // the date-of-birth complaint so the actionable error is the one shown.
  check(() =>
    assert.ok(
      /const extractedExpiryDate = exactFieldValue\(fields, \[\s*"expiry_date"/.test(body),
      'expiry is read by whole label, so "Date of Issue" cannot satisfy it',
    ),
  );
  check(() => assert.ok(body.includes("expiryDate: extractedExpiryDate"), "fed to the planner"));
  const expiryRefusal = body.indexOf("if (plan.expired)");
  check(() => assert.notEqual(expiryRefusal, -1, "the branch must refuse an expired card"));
  check(() =>
    assert.ok(
      expiryRefusal < body.indexOf("if (plan.missingDateOfBirth)"),
      "an expired card is the more urgent complaint",
    ),
  );
  check(() =>
    assert.ok(
      expiryRefusal < body.indexOf("await prisma.$transaction"),
      "refusal must happen before any write, not after",
    ),
  );
  check(() =>
    assert.ok(
      body.slice(0, expiryRefusal).includes("planCnicProfileUpdate"),
      "the refusal comes from the tested planner, not an inline date compare",
    ),
  );
  check(() =>
    assert.ok(
      body.includes("validity: plan.validity"),
      "the outcome of the check is reported to the UI",
    ),
  );
  check(() =>
    assert.ok(
      /prisma\.user\.findFirst\(\{[\s\S]{0,160}id: \{ not: document\.userId \}/.test(body),
      "the unique CNIC column is checked before writing, not after",
    ),
  );
  check(() =>
    assert.ok(
      /cnicTakenByOtherAccount,\n      \}\);/.test(body),
      "the collision is fed back to the planner, which does the refusing",
    ),
  );
  // The extraction prompt never asks for the father's name, because the profile
  // has no column for it — an approved card must not half-write an identity.
  check(() => assert.equal(body.includes("fatherName"), false));

  // Nothing may bypass the planner by building its own update: one write, and it
  // happens inside the same transaction that marks the document MAPPED.
  check(() =>
    assert.equal(
      (body.match(/user\.update\(/g) ?? []).length,
      1,
      "exactly one profile write on the CNIC path",
    ),
  );
  check(() =>
    assert.ok(
      /tx\.user\.update\(\{[\s\S]{0,120}data: plan\.update/.test(body),
      "the only write is the plan's, inside the mapping transaction",
    ),
  );
  check(() =>
    assert.equal(
      body.includes("prisma.user.update"),
      false,
      "no write outside the transaction — a profile updated but a document left unmapped is a half-truth",
    ),
  );

  // And the summary the person sees must be built from the plan.
  check(() => assert.ok(/profilePlan: \{/.test(body), "the plan is returned to the caller"));
  check(() =>
    assert.ok(
      /describeCnicProfilePlan/.test(hook) && /setProfileSyncNote/.test(hook),
      "the client hook renders the plan, it does not re-decide",
    ),
  );
  check(() =>
    assert.ok(
      /setProfileSyncNote\(null\)/.test(hook),
      "the note is cleared when the operator starts other document activity",
    ),
  );
});

process.on("exit", () => {
  console.log(`\nassertions: ${assertions}`);
});
