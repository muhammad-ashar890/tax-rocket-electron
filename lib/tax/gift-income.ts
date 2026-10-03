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
