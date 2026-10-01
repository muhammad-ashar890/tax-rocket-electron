import { validatePakistaniIban, normalizeIban } from "@/lib/tax/iban";

/**
 * The bank statement's IBAN is a REQUIRED extracted field, exactly like the
 * annual gross salary on a salary certificate: the extractor is asked for it,
 * a visible blank "IBAN" field is added when it is missing, and the statement
 * cannot be mapped until a valid one is entered.
 */
export const BANK_STATEMENT_IBAN_LABEL = "IBAN";

export type BankStatementFieldLike = {
  label?: unknown;
  value?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
};

function normalizedLabel(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** "IBAN", "Account IBAN", "IBAN Number" — but not "Account Number". */
export function isBankStatementIbanLabel(label: unknown): boolean {
  return /(^|_)iban(_|$)/.test(normalizedLabel(label));
}

/**
 * Every valid PK IBAN printed anywhere in `text`. Statements print them with
 * spaces ("PK36 SCBL 0000 0011 2345 6702"), so spacing is removed first; the
 * mod-97 check keeps accidental digit runs from being mistaken for one.
 */
export function findPakistaniIbans(text: unknown): string[] {
  const compact = String(text ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  const found = new Set<string>();
  for (const match of compact.matchAll(/PK\d{2}[A-Z]{4}[A-Z0-9]{16}/g)) {
    if (validatePakistaniIban(match[0]).valid) found.add(match[0]);
  }
  return [...found];
}

/**
 * Adds a visible, editable, empty IBAN field when the extractor omitted it.
 * Statements often print the IBAN where "Account Number" would go, so a valid
 * IBAN found in that field is promoted rather than asked for again.
 */
export function ensureBankStatementReviewFields(extracted: unknown): unknown {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
    return extracted;
  }
  const payload = extracted as Record<string, unknown>;
  const fields: BankStatementFieldLike[] = Array.isArray(payload.fields)
    ? payload.fields.filter(
        (field): field is BankStatementFieldLike =>
          Boolean(field) && typeof field === "object" && !Array.isArray(field),
      )
    : [];

  if (!fields.some((field) => isBankStatementIbanLabel(field.label))) {
    const promoted = fields
      .filter((field) => /account/.test(normalizedLabel(field.label)))
      .flatMap((field) => findPakistaniIbans(field.value))[0];
    fields.push({
      label: BANK_STATEMENT_IBAN_LABEL,
      value: promoted ?? null,
      confidence: promoted ? 0.9 : 0,
    });
  }
  return { ...payload, fields };
}

export function bankStatementIbanValue(
  fields: BankStatementFieldLike[] | undefined,
): unknown {
  return fields?.find((field) => isBankStatementIbanLabel(field.label))?.value;
}

/** Flat result — same shape as `validatePakistaniIban`. */
export function validateBankStatementIban(
  fields: BankStatementFieldLike[] | undefined,
) {
  return validatePakistaniIban(
    bankStatementIbanValue(fields) as string | null | undefined,
  );
}

export function hasRequiredBankStatementIban(
  fields: BankStatementFieldLike[] | undefined,
): boolean {
  return validateBankStatementIban(fields).valid;
}

export { normalizeIban };
