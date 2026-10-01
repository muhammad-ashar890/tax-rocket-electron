/**
 * Wealth Statement rows the packet may carry (116 → Reconciliation / Assets).
 *
 * Kept apart from `portal-row-evidence.ts`, which is generated from the capture
 * census and must not be hand-edited. Evidence for everything here:
 *  - `+ Expenses` modal ("expense modal IRIS 2.0") and the grid it produces
 *    ("reconciliation with expense fields IRIS 2.0"), captured 2026-10-01.
 *  - "7098 added IRIS 2.0" (2026-10-01): `+` on Adjustments in Outflows takes a
 *    required Description, and after SAVE a SECOND row with the same id 7098
 *    appears ("Adjustments in Outflows - <description>") with ONE editable cell.
 *    (The first 7098 is the disabled summary row, so the filler's duplicate-id
 *    rule picks the editable one.)
 *  - Bank balances are NOT here on purpose: `7012` is "Cash in hand", not a bank
 *    account. Banks are `7030`, added one by one through the Bank Account
 *    modal, which demands an IBAN TaxRocket does not store.
 *
 * Expense child rows do NOT exist until the operator ticks the category in the
 * modal and presses ADD. Each then renders ONE editable amount cell. `label` is
 * the exact checkbox text, so a driver can tick the right box by text.
 */

export const WEALTH_OTHER_EXPENSE_CODE = "7087";
/**
 * Bank Account(s). One editable child row per account, added through
 * `+ Assets` -> "Bank Account(s)" -> the IBAN modal. IRIS words the row
 * "Bank Account(s) - <IBAN> - <title> - <bank> ...", so the IBAN in the row
 * description is what tells two accounts apart (they share the id 7030).
 * Evidence: "bank account field visibleIRIS 2.0" (2026-10-01).
 */
export const WEALTH_BANK_ACCOUNT_CODE = "7030";
/** Adjustments in Outflows: the row created by the `+` modal. */
export const WEALTH_TAX_OUTFLOW_CODE = "7098";
/** Description the `+` modal must be given so the new row is recognisable. */
export const WEALTH_TAX_OUTFLOW_DESCRIPTION = "Income tax deducted u/s 149";

export const WEALTH_EXPENSE_ROWS: Readonly<Record<string, { label: string }>> = {
  "7066": { label: "Asset Insurance / Security" },
  "7070": { label: "Medical" },
  "7071": { label: "Educational" },
  "7072": { label: "Club" },
  "7073": { label: "Functions / Gatherings" },
  "7076": {
    label:
      "Donation, Zakat, Annuity, Profit on Debt, Life Insurance Premium, etc.",
  },
  "7087": { label: "Other Personal / Household Expenses" },
  "705601": { label: "Foreign Traveling" },
  "7056": { label: "Local Traveling" },
  "7051": { label: "Rent" },
  "707302": { label: "Wedding Events" },
  "707301": { label: "Other Events / Functions / Gathering" },
  "7052": { label: "Rates / Taxes / Charge / Cess" },
  "7055": { label: "Vehicle Running / Maintenance" },
  "7058": { label: "Electricity" },
  "7059": { label: "Water" },
  "7060": { label: "Gas" },
  "7061": { label: "Telephone" },
};

/**
 * TaxRocket's expense categories are coarse (UTILITIES_OR_RENT lumps rent with
 * electricity). The split below uses the bank description with the same
 * keywords the classifier used; anything it cannot place lands on `7087`
 * "Other Personal / Household" so the TOTAL always equals the ledger. Returns
 * null for a category that is not a personal expense at all.
 */
export function classifyExpenseToWealthCode(
  category: string | null | undefined,
  description: string | null | undefined,
): string | null {
  const cat = String(category || "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9_]/g, "_");
  const text = ` ${String(description || "").toLowerCase()} `;
  switch (cat) {
    case "UTILITIES_OR_RENT":
      if (/\brent\b/.test(text)) return "7051";
      if (/k-?\s?electric|electric|\bke\b/.test(text)) return "7058";
      if (/\bgas\b|sui\s?(southern|northern)/.test(text)) return "7060";
      if (/\bwater\b/.test(text)) return "7059";
      if (/telephone|\bptcl\b|phone bill/.test(text)) return "7061";
      return WEALTH_OTHER_EXPENSE_CODE;
    case "TRANSPORT":
      return "7055";
    case "PERSONAL_EXPENSE":
    case "BANK_CHARGES":
      return WEALTH_OTHER_EXPENSE_CODE;
    default:
      return null;
  }
}
