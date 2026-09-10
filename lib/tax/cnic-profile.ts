/**
 * What an approved CNIC may write into the taxpayer profile, and how the card is
 * reused across filing years.
 *
 * The CNIC is the authoritative identity document: the legal name and the identity
 * number on the profile should match the card, not whatever a Google/GitHub login
 * supplied years ago. So identity fields from the card WIN — but every such change
 * is reported, never applied quietly, and a number another account already claims
 * is refused (the column is unique and FBR allows one account per identity number).
 *
 * `address` is deliberately different: it is contact information, not identity, and
 * the printed card goes stale, so a profile that already has one keeps it.
 *
 * Pure by design — the DB-bound caller (app/actions/extraction.ts) applies the plan,
 * so these rules are testable without Postgres.
 */

/**
 * Pakistani identity documents print dates day-first (DD/MM/YYYY); this is the same
 * parser the date-of-birth path uses, so "01/02/2026" is 2 February and an
 * impossible date is refused rather than flipped.
 */
function parseIdentityDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;

  const iso = /^\d{4}-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    return buildDay(Number(text.slice(0, 4)), Number(iso[1]), Number(iso[2]));
  }

  const dayFirst = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(text);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    if (month > 12) return null;
    return buildDay(Number(dayFirst[3]), month, day);
  }

  return null;
}

function buildDay(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  if (year < 1900) return null;
  return date;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** An ISO yyyy-mm-dd read back out of a stored payload, in human form. */
function describeExpiry(iso: string | null | undefined): string {
  const parsed = parseIdentityDate(iso);
  return parsed ? formatDay(parsed) : "its printed date";
}

function formatDay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export type CnicValidityStatus = "valid" | "expired" | "unread";

export type CnicValidity = {
  status: CnicValidityStatus;
  /** ISO yyyy-mm-dd of the printed expiry date, when one was read. */
  expiry: string | null;
  /** Operator-facing sentence: never empty for a check that could not run. */
  message: string | null;
};

/**
 * A CNIC that has lapsed is not a proof of identity: NADRA requires renewal and
 * IRIS verification is against a live card. The check is deliberately three-way —
 * many older laminated cards print no expiry date at all, and treating "unread"
 * as "expired" would lock people out of filing over a printing difference.
 */
export function readCnicValidity(input: {
  expiryDate: unknown;
  today?: Date;
}): CnicValidity {
  const expiry = parseIdentityDate(input.expiryDate);
  if (!expiry) {
    return {
      status: "unread",
      expiry: null,
      message:
        "No expiry date was read from the card, so its validity could not be checked. If the card has lapsed, renew it at NADRA before filing.",
    };
  }

  const now = input.today ?? new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const label = formatDay(expiry);

  // "Valid upto 12/03/2024" means the card stops being usable on that day's end,
  // so the printed day itself is still accepted.
  if (expiry.getTime() < today.getTime()) {
    return {
      status: "expired",
      expiry: expiry.toISOString().slice(0, 10),
      message: `This CNIC expired on ${label}. An expired card is not valid proof of identity, so nothing was saved from it — upload the renewed card from NADRA.`,
    };
  }

  return {
    status: "valid",
    expiry: expiry.toISOString().slice(0, 10),
    message: null,
  };
}

export type CnicProfile = {
  name?: string | null;
  cnic?: string | null;
  dateOfBirth?: Date | string | null;
  address?: string | null;
};

export type CnicExtracted = {
  name?: unknown;
  cnic?: unknown;
  dateOfBirth?: Date | null;
  address?: unknown;
  /** The printed "valid upto" date, in whatever form the extraction returned. */
  expiryDate?: unknown;
};

export type CnicProfilePlan = {
  /** Only fields the profile is allowed to receive. Empty means nothing changes. */
  update: {
    name?: string;
    cnic?: string;
    address?: string;
    dateOfBirth?: Date;
  };
  /** Field names written, for the operator-facing summary. */
  filled: string[];
  /** Fields written over a value the profile already had — never silent. */
  overwritten: { field: string; previous: string }[];
  /**
   * Fields not written, each with the reason shown in the UI. `kind` decides the
   * wording: a value the profile keeps on purpose is not the same as a value the
   * card failed to supply, and neither is a refusal.
   */
  skipped: {
    field: string;
    reason: string;
    kind: "kept" | "unread" | "refused";
  }[];
  /** The one hard stop: filing rules need a real date of birth. */
  missingDateOfBirth: boolean;
  /** A lapsed card is a second hard stop: nothing is established from it. */
  expired: boolean;
  validity: CnicValidity;
};

const TEXT_LIMIT = 300;

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_LIMIT);
}

function digits(value: unknown): string {
  return clean(value).replace(/[^0-9]/g, "");
}

/**
 * The profile form refuses anything but XXXXX-XXXXXXX-X (app/tax/profile/page.tsx),
 * while the desktop agent strips separators before comparing against the portal
 * (iris-navigation.js normalizes with /[ -]/g). So the stored form is the dashed
 * one and every comparison here is done on digits — writing bare digits is what
 * made an approved CNIC fail the profile page's own validation on the next save.
 */
export function formatCnicNumber(value: unknown): string {
  const raw = digits(value);
  if (raw.length !== 13) return raw;
  return `${raw.slice(0, 5)}-${raw.slice(5, 12)}-${raw.slice(12)}`;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function sameDay(
  profileValue: Date | string | null | undefined,
  cardDate: Date,
): boolean {
  const current = asDate(profileValue);
  if (!current) return false;
  return (
    current.getUTCFullYear() === cardDate.getUTCFullYear() &&
    current.getUTCMonth() === cardDate.getUTCMonth() &&
    current.getUTCDate() === cardDate.getUTCDate()
  );
}

function has(profileValue: string | null | undefined): boolean {
  return clean(profileValue).length > 0;
}

export function planCnicProfileUpdate(input: {
  profile: CnicProfile;
  extracted: CnicExtracted;
  /** Injectable for tests; defaults to the current date. */
  today?: Date;
  /**
   * True when another account already holds this CNIC. Writing it would fail the
   * whole approval with a database error the user cannot act on, so it is refused
   * here and explained instead.
   */
  cnicTakenByOtherAccount?: boolean;
}): CnicProfilePlan {
  const profile = input.profile ?? {};
  const extracted = input.extracted ?? {};
  const plan: CnicProfilePlan = {
    update: {},
    filled: [],
    overwritten: [],
    skipped: [],
    missingDateOfBirth: false,
    expired: false,
    validity: { status: "unread", expiry: null, message: null },
  };

  const skip = (field: string, kind: "kept" | "unread" | "refused", reason: string) => {
    plan.skipped.push({ field, kind, reason });
  };

  const write = (
    field: keyof CnicProfilePlan["update"] & string,
    value: string | Date,
  ) => {
    const previous = clean((profile as Record<string, unknown>)[field]);
    (plan.update as Record<string, unknown>)[field] = value;
    plan.filled.push(field);
    if (previous && previous !== String(value)) {
      plan.overwritten.push({ field, previous });
    }
  };

  // 0. Validity, before anything is written. Refusing here keeps a lapsed card
  // from becoming the profile's identity of record.
  const validity = readCnicValidity({
    expiryDate: extracted.expiryDate,
    today: input.today,
  });
  plan.validity = validity;
  plan.expired = validity.status === "expired";
  if (plan.expired) return plan;

  // 1. Date of birth — always the card's, because Section 149(IA) pension rules
  // and the age-based slabs are computed from it. A card without a printed DOB is
  // a refusal, never a guess.
  const dateOfBirth = asDate(extracted.dateOfBirth);
  if (!dateOfBirth) {
    plan.missingDateOfBirth = true;
    skip(
      "dateOfBirth",
      "unread",
      "No date of birth was read from the card, so nothing was guessed. Re-run the extraction or enter it on the profile page.",
    );
  } else if (sameDay(profile.dateOfBirth, dateOfBirth)) {
    skip(
      "dateOfBirth",
      "kept",
      "The profile already carries this date of birth.",
    );
  } else {
    write("dateOfBirth", dateOfBirth);
  }

  // 2. Legal name — the card wins over a login-supplied display name, and the
  // value it replaced is reported rather than swallowed.
  const cardName = clean(extracted.name);
  if (!cardName) {
    skip("name", "unread", "No name was read from the card.");
  } else if (
    has(profile.name) &&
    clean(profile.name).toLowerCase() === cardName.toLowerCase()
  ) {
    skip("name", "kept", "The profile already carries this name.");
  } else {
    write("name", cardName);
  }

  // 3. CNIC number — the card wins, unless another account claims it.
  const cardCnic = digits(extracted.cnic);
  if (cardCnic.length !== 13) {
    skip(
      "cnic",
      "unread",
      "The number read from the card is not 13 digits, so it was not stored.",
    );
  } else if (digits(profile.cnic) === cardCnic) {
    skip("cnic", "kept", "The profile already carries this CNIC.");
  } else if (input.cnicTakenByOtherAccount) {
    skip(
      "cnic",
      "refused",
      "Another account already uses this CNIC. FBR allows one account per identity number, so nothing was stored and the upload was not rejected.",
    );
  } else {
    write("cnic", formatCnicNumber(cardCnic));
  }

  // 4. Address — contact information the card prints but also gets stale, so it
  // is only filled when the profile has none.
  const cardAddress = clean(extracted.address);
  if (!cardAddress) {
    skip("address", "unread", "No address was read from the card.");
  } else if (has(profile.address)) {
    skip(
      "address",
      "kept",
      "The profile already has an address; a CNIC goes stale, so it was kept.",
    );
  } else {
    write("address", cardAddress);
  }

  return plan;
};

const PROFILE_FIELD_LABELS: Record<string, string> = {
  dateOfBirth: "date of birth",
  name: "legal name",
  cnic: "CNIC number",
  address: "address",
};

export type CnicProfilePlanSummary = {
  filled?: string[];
  skipped?: {
    field: string;
    kind?: "kept" | "unread" | "refused";
    reason?: string;
  }[];
  overwritten?: { field: string; previous: string }[];
  validity?: { status?: string; message?: string | null };
};

function listPhrase(items: string[]) {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The one sentence the wizard shows after an approved CNIC, built next to the rules
 * it describes so wording and behaviour cannot drift apart (and so it is testable
 * without React).
 */
export function describeCnicProfilePlan(
  plan?: CnicProfilePlan | CnicProfilePlanSummary | null,
): string | null {
  if (!plan) return null;
  const label = (field: string) => PROFILE_FIELD_LABELS[field] ?? field;
  const overwritten = new Map(
    (plan.overwritten ?? []).map((entry) => [entry.field, entry.previous]),
  );
  const filled = (plan.filled ?? []).map((field) => {
    const previous = overwritten.get(field);
    return previous ? `${label(field)} (was ${previous})` : label(field);
  });
  const skipped = plan.skipped ?? [];
  const kept = skipped
    .filter((entry) => (entry.kind ?? "kept") === "kept")
    .map((entry) => label(entry.field));
  const unread = skipped
    .filter((entry) => entry.kind === "unread")
    .map((entry) => label(entry.field));
  const refused = skipped.filter((entry) => entry.kind === "refused");
  if (filled.length === 0 && skipped.length === 0) return null;

  const parts = [
    filled.length > 0
      ? `Profile updated from the CNIC: ${listPhrase(filled)}.`
      : "Nothing new was written to your profile.",
  ];
  if (kept.length > 0) {
    parts.push(`Left as you had it: ${listPhrase(kept)}.`);
  }
  if (unread.length > 0) {
    parts.push(
      `Not read from the card: ${listPhrase(unread)} — re-run the extraction or enter it on the profile page.`,
    );
  }
  for (const entry of refused) {
    parts.push(
      `${label(entry.field)}: ${entry.reason ?? "this card cannot be applied to your profile."}`,
    );
  }
  // A check that ran and passed needs no announcement; a check that could not run
  // must never pass in silence.
  if (plan.validity?.status === "unread" && plan.validity.message) {
    parts.push(plan.validity.message);
  }
  return parts.join(" ");
}

/* ------------------------------------------------------------------ *
 * Reusing an already-verified identity document for the next filing    *
 * ------------------------------------------------------------------ */

/**
 * Document types whose content belongs to the PERSON rather than to a tax year.
 * A salary certificate or a bank statement is per-year by nature and must never
 * be carried forward, so this list is the whole allowlist.
 */
export const CARRY_FORWARD_DOCUMENT_TYPES = ["cnic"] as const;

export type IdentityCarryForwardReason =
  | "copied"
  | "not_an_identity_document"
  | "already_present"
  | "profile_not_verified"
  | "prior_expired"
  | "no_previous_upload";

export type IdentityCarryForwardPlan = {
  documentType: string;
  copy: boolean;
  reason: IdentityCarryForwardReason;
  /** Tax year of the filing the card is being reused from. */
  sourceTaxYear?: number | null;
  /** ISO expiry date, when the refusal is about a lapsed card. */
  sourceExpiry?: string | null;
};

/**
 * Reusing the card is allowed only when the identity it established is still the
 * identity on file. If the profile has no CNIC or no date of birth, the earlier
 * upload was never approved (or was wiped), and a fresh upload is the honest
 * answer — copying an unverified document into a new filing would make the
 * requirement look satisfied without anything having been verified.
 */
export function planIdentityCarryForward(input: {
  documentType: string;
  draftAlreadyHasIt: boolean;
  profileVerified: boolean;
  priorTaxYear?: number | null;
  hasPriorUpload: boolean;
  /** True when the card on the earlier filing has since lapsed. */
  priorExpired?: boolean;
  priorExpiry?: string | null;
}): IdentityCarryForwardPlan {
  if (!(CARRY_FORWARD_DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) {
    return { documentType: input.documentType, copy: false, reason: "not_an_identity_document" };
  }
  if (input.draftAlreadyHasIt) {
    return { documentType: input.documentType, copy: false, reason: "already_present" };
  }
  if (!input.profileVerified) {
    return { documentType: input.documentType, copy: false, reason: "profile_not_verified" };
  }
  if (input.hasPriorUpload && input.priorExpired) {
    return {
      documentType: input.documentType,
      copy: false,
      reason: "prior_expired",
      sourceTaxYear: input.priorTaxYear ?? null,
      sourceExpiry: input.priorExpiry ?? null,
    };
  }
  if (!input.hasPriorUpload) {
    return { documentType: input.documentType, copy: false, reason: "no_previous_upload" };
  }
  return {
    documentType: input.documentType,
    copy: true,
    reason: "copied",
    sourceTaxYear: input.priorTaxYear ?? null,
  };
}

const SILENT_REASONS = new Set(["not_an_identity_document", "already_present"]);

/** The shape that crosses the server-action boundary. */
export type IdentityCarryForwardResult = {
  documentType: string;
  reason: string;
  sourceTaxYear?: number | null;
  sourceExpiry?: string | null;
};

/**
 * The note for the documents step; nothing at all when the outcome is ordinary
 * (this filing already has the card, or the type is never reused).
 */
export function describeIdentityCarryForward(
  results: (IdentityCarryForwardResult | null | undefined)[] | undefined,
): string | null {
  const label = (documentType: string) =>
    PROFILE_FIELD_LABELS[documentType] ?? documentType;
  const sentences = (results ?? [])
    .filter(Boolean)
    .map((plan) => {
      if (SILENT_REASONS.has(plan!.reason)) return "";
      switch (plan!.reason) {
        case "copied":
          return `${label(plan!.documentType)} reused from ${
            plan!.sourceTaxYear
              ? `your Tax Year ${plan!.sourceTaxYear} filing`
              : "an earlier filing"
          } — you do not need to upload it again.`;
        case "profile_not_verified":
          return `${label(
            plan!.documentType,
          )} was not reused: your profile has no verified CNIC and date of birth yet, so this filing needs the upload.`;
        case "prior_expired":
          return `${label(plan!.documentType)} from your ${
            plan!.sourceTaxYear ? `Tax Year ${plan!.sourceTaxYear} ` : "earlier "
          }filing expired on ${describeExpiry(plan!.sourceExpiry)}, so it cannot be reused for this filing. Upload the renewed card.`;
        case "no_previous_upload":
          return `${label(
            plan!.documentType,
          )} has not been approved on any earlier filing, so upload it once and it will carry forward to future years.`;
        default:
          // An unknown reason must never be phrased as a success.
          return `${label(plan!.documentType)} could not be reused automatically.`;
      }
    })
    .filter(Boolean);
  return sentences.length > 0 ? sentences.join(" ") : null;
}
