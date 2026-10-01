/**
 * Pakistani IBAN handling.
 *
 * A PK IBAN is exactly 24 characters: "PK" + 2 check digits + 4-letter bank
 * code + 16 alphanumerics. IRIS's Bank Account(s) modal takes that string
 * (maxlength 24) and fetches the account title from it, so a mistyped IBAN
 * stops the Wealth Statement from being completed. The ISO 7064 mod-97 check
 * catches almost every typo before it reaches the portal.
 */

export const PK_IBAN_LENGTH = 24;

/** Upper-case and drop spaces/dashes — how IBANs are printed on statements. */
export function normalizeIban(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char)
      ? String(char.charCodeAt(0) - 55)
      : char;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder;
}

/**
 * Flat result (not a discriminated union): the project's tsconfig is not
 * strict, so `if (!r.valid) r.error` would not narrow. `error` is "" when valid.
 */
export type IbanValidation = {
  valid: boolean;
  /** Normalised IBAN; "" when invalid. */
  iban: string;
  /** Human-readable reason; "" when valid. */
  error: string;
};

export function validatePakistaniIban(
  value: string | null | undefined,
): IbanValidation {
  const iban = normalizeIban(value);
  if (!iban) return { valid: false, iban: "", error: "IBAN is required" };
  if (!iban.startsWith("PK")) {
    return { valid: false, iban: "", error: "IBAN must start with PK" };
  }
  if (iban.length !== PK_IBAN_LENGTH) {
    return {
      valid: false,
      iban: "",
      error: `IBAN must be exactly ${PK_IBAN_LENGTH} characters (it has ${iban.length})`,
    };
  }
  if (!/^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(iban)) {
    return {
      valid: false,
      iban: "",
      error: "IBAN format is PK + 2 digits + 4-letter bank code + 16 characters",
    };
  }
  if (mod97(iban) !== 1) {
    return {
      valid: false,
      iban: "",
      error: "IBAN check digits do not match — re-check it against your statement",
    };
  }
  return { valid: true, iban, error: "" };
}
