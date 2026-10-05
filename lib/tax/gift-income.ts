/**
 * A gift received is an inflow of the Wealth Statement (IRIS Reconciliation of
 * Net Assets, row 7037 "Gift"), not taxable income. TaxRocket keeps it in the
 * ledger as an INCOME-type entry in category GIFT so that Mizan balances (the
 * money did arrive in the bank), and every tax figure leaves it out.
 */
export const GIFT_CATEGORIES: readonly string[] = [
  "GIFT",
  "GIFTS",
  "GIFT_RECEIVED",
];

export function normalizeGiftCategory(category: string | null | undefined) {
  return String(category ?? "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9_]/g, "_");
}

export function isGiftCategory(category: string | null | undefined) {
  return GIFT_CATEGORIES.includes(normalizeGiftCategory(category));
}

/** IRIS row for a gift received (Reconciliation of Net Assets, Inflows). */
export const IRIS_GIFT_INFLOW_CODE = "7037";

/**
 * IRIS asks who gave a gift: the dialog opened by the "+" on row 7037 has a
 * required "Registration No./CNIC/POC/Passport No." field (13 characters at
 * most). After the number is typed and the search button pressed, IRIS fills
 * the donor's name itself. TaxRocket therefore keeps one donor number per gift.
 */
export const GIFT_DONOR_ID_MAX_LENGTH = 13;

export function normalizeGiftDonorId(value: string | null | undefined) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function validateGiftDonorId(value: string | null | undefined): {
  valid: boolean;
  id: string;
  error?: string;
} {
  const id = normalizeGiftDonorId(value);
  if (!id) {
    return {
      valid: false,
      id,
      error: "Enter the donor's CNIC (13 digits) or registration number.",
    };
  }
  if (id.length > GIFT_DONOR_ID_MAX_LENGTH) {
    return {
      valid: false,
      id,
      error: `IRIS accepts at most ${GIFT_DONOR_ID_MAX_LENGTH} characters for the donor number.`,
    };
  }
  if (/^[0-9]+$/.test(id)) {
    // Digits only: a CNIC (13) or an NTN (7). Anything else is a typing slip.
    if (id.length !== 13 && id.length !== 7) {
      return {
        valid: false,
        id,
        error:
          "A CNIC has 13 digits and an NTN has 7. Check the donor number and try again.",
      };
    }
    return { valid: true, id };
  }
  // Letters and digits: a passport or POC number.
  if (id.length < 5) {
    return {
      valid: false,
      id,
      error: "The donor number is too short.",
    };
  }
  return { valid: true, id };
}
