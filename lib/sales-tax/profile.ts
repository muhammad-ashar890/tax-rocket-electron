/**
 * Business profile and month choice for the Sales Tax module.
 *
 * Pure validation, no database: the server actions call these and the tests
 * pin them. Every message is shown to the user as written, so each one says
 * what is wrong and what to do.
 */

import { isValidPeriod } from "./dates";
import type { TaxPeriod } from "./types";

export type AuthorityCode = "FBR" | "SRB" | "PRA" | "KPRA" | "BRA";

export interface AuthorityInfo {
  code: AuthorityCode;
  name: string;
  scope: string;
  /** Only enabled authorities can be selected; the others are shown as coming soon. */
  enabled: boolean;
}

/** In the order the modules are planned: FBR first, then the provincial boards. */
export const AUTHORITIES: readonly AuthorityInfo[] = [
  {
    code: "FBR",
    name: "FBR (IRIS)",
    scope: "Sales tax on goods",
    enabled: true,
  },
  {
    code: "SRB",
    name: "SRB (Sindh)",
    scope: "Sales tax on services",
    enabled: false,
  },
  {
    code: "PRA",
    name: "PRA (Punjab)",
    scope: "Sales tax on services",
    enabled: false,
  },
  {
    code: "KPRA",
    name: "KPRA (Khyber Pakhtunkhwa)",
    scope: "Sales tax on services",
    enabled: false,
  },
  {
    code: "BRA",
    name: "BRA (Balochistan)",
    scope: "Sales tax on services",
    enabled: false,
  },
];

export function isEnabledAuthority(code: string): code is AuthorityCode {
  return AUTHORITIES.some(
    (authority) => authority.code === code && authority.enabled,
  );
}

export function getAuthorityName(code: string): string {
  return AUTHORITIES.find((authority) => authority.code === code)?.name ?? code;
}

const MIN_REGISTRATION_DIGITS = 7;
const MAX_REGISTRATION_DIGITS = 15;
const MAX_BUSINESS_NAME_LENGTH = 120;

export interface ProfileInput {
  businessName?: unknown;
  registrationNo?: unknown;
  authorities?: unknown;
}

export interface ValidProfile {
  businessName: string;
  registrationNo: string;
  authorities: AuthorityCode[];
}

export type ProfileResult =
  | { ok: true; value: ValidProfile }
  | { ok: false; error: string };

/** Collapses spaces so "  Acme   Traders " is stored as "Acme Traders". */
function cleanName(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export type BusinessDetailsResult =
  | { ok: true; value: { businessName: string; registrationNo: string } }
  | { ok: false; error: string };

/**
 * Step 1 of the wizard. The registration number is kept as the user typed it
 * (with dashes or spaces) after trimming, because that is how it appears on
 * invoices. Only the digits are counted for the check.
 */
export function validateBusinessDetails(input: {
  businessName?: unknown;
  registrationNo?: unknown;
}): BusinessDetailsResult {
  const businessName = cleanName(input.businessName);
  if (!businessName) {
    return { ok: false, error: "Enter the business name as it is registered." };
  }
  if (businessName.length > MAX_BUSINESS_NAME_LENGTH) {
    return {
      ok: false,
      error: `The business name is too long (maximum ${MAX_BUSINESS_NAME_LENGTH} characters).`,
    };
  }

  const registrationNo = String(input.registrationNo ?? "").trim();
  if (!registrationNo) {
    return {
      ok: false,
      error: "Enter your sales tax registration number (STRN).",
    };
  }
  if (!/^[0-9\-\s]+$/.test(registrationNo)) {
    return {
      ok: false,
      error:
        "The registration number can only contain digits, dashes and spaces.",
    };
  }
  const digits = registrationNo.replace(/\D/g, "").length;
  if (digits < MIN_REGISTRATION_DIGITS || digits > MAX_REGISTRATION_DIGITS) {
    return {
      ok: false,
      error: `The registration number should have between ${MIN_REGISTRATION_DIGITS} and ${MAX_REGISTRATION_DIGITS} digits. Check it against your sales tax certificate.`,
    };
  }
  return { ok: true, value: { businessName, registrationNo } };
}

export type AuthoritySelectionResult =
  | { ok: true; value: AuthorityCode[] }
  | { ok: false; error: string };

/** Step 2 of the wizard. */
export function validateAuthoritySelection(
  authorities: unknown,
): AuthoritySelectionResult {
  const requested = Array.isArray(authorities) ? authorities.map(String) : [];
  if (requested.length === 0) {
    return { ok: false, error: "Select at least one authority." };
  }
  const unavailable = requested.filter((code) => !isEnabledAuthority(code));
  if (unavailable.length > 0) {
    return {
      ok: false,
      error: `${unavailable
        .map(getAuthorityName)
        .join(", ")} is not available yet. For now, select FBR only.`,
    };
  }
  return {
    ok: true,
    value: AUTHORITIES.filter((authority) =>
      requested.includes(authority.code),
    ).map((authority) => authority.code),
  };
}

export function validateProfile(input: ProfileInput): ProfileResult {
  const business = validateBusinessDetails(input);
  if (business.ok === false) return { ok: false, error: business.error };
  const authorities = validateAuthoritySelection(input.authorities);
  if (authorities.ok === false) return { ok: false, error: authorities.error };
  return {
    ok: true,
    value: { ...business.value, authorities: authorities.value },
  };
}

/** Reads the stored JSON list of authorities; anything unreadable gives none. */
export function parseStoredAuthorities(
  stored: string | null | undefined,
): AuthorityCode[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return AUTHORITIES.filter((authority) =>
      parsed.map(String).includes(authority.code),
    ).map((authority) => authority.code);
  } catch {
    return [];
  }
}

export const EARLIEST_PERIOD_YEAR = 2020;

export type PeriodResult =
  | { ok: true; value: TaxPeriod }
  | { ok: false; error: string };

/**
 * A month can be prepared once it has started: the current month is allowed
 * (some clients prepare early), later months are not.
 */
export function validateRequestedPeriod(
  year: unknown,
  month: unknown,
  today: Date = new Date(),
): PeriodResult {
  const period = { year: Number(year), month: Number(month) };
  if (
    !Number.isInteger(period.year) ||
    !Number.isInteger(period.month) ||
    !isValidPeriod(period)
  ) {
    return { ok: false, error: "Choose a valid month and year." };
  }
  if (period.year < EARLIEST_PERIOD_YEAR) {
    return {
      ok: false,
      error: `Returns before ${EARLIEST_PERIOD_YEAR} cannot be prepared here.`,
    };
  }
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  if (
    period.year > currentYear ||
    (period.year === currentYear && period.month > currentMonth)
  ) {
    return {
      ok: false,
      error:
        "That month has not started yet. Choose the current month or an earlier one.",
    };
  }
  return { ok: true, value: period };
}

const MONTH_NAMES = [
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

export function formatPeriod(period: TaxPeriod): string {
  return `${MONTH_NAMES[period.month - 1] ?? "?"} ${period.year}`;
}

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? "";
}
