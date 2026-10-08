// Decides which filing draft a "create" or "save" request belongs to.
//
// A taxpayer can have more than one filing for the same tax year: for example
// the salary return is filed first and a business return is prepared later.
// The database no longer forces one draft per user per year, so the code that
// saves a draft must choose between UPDATING an existing draft and CREATING a
// new one. A wrong choice silently overwrites a return that was already
// approved or filed, so the rule lives here, in one pure and tested place.

import { FILING_STATUS } from "@/lib/tax/filing-status";

/** FbrConnection states that mean a filing job is running right now. */
const ACTIVE_FBR_CONNECTION_STATUSES = [
  "WAITING_FOR_AGENT",
  "CONNECTED",
  "SUBMITTING",
] as const;

/** FbrConnection state written when the desktop agent finished a real filing. */
const FILING_COMPLETED_STATUS = "FILING_COMPLETED";

export type ProtectionCandidate = {
  status?: string | null;
  packetApprovalConfirmed?: boolean | null;
  filingPackets?: ReadonlyArray<{ approvalStatus?: string | null }> | null;
  fbrConnections?: ReadonlyArray<{ status?: string | null }> | null;
};

/**
 * A draft is protected when it holds work that a new filing must never
 * overwrite: it was approved, an approved packet exists, the desktop agent
 * finished or is running a real filing for it, or it is marked filed.
 *
 * A dry run (DRY_RUN_COMPLETED) does not protect a draft: nothing was filed.
 */
export function isProtectedFilingDraft(draft: ProtectionCandidate): boolean {
  if (
    draft.status === FILING_STATUS.FILED ||
    draft.status === FILING_STATUS.APPROVED_FOR_FILING
  ) {
    return true;
  }
  if (draft.packetApprovalConfirmed === true) return true;
  if (
    (draft.filingPackets ?? []).some(
      (packet) => packet.approvalStatus === "APPROVED",
    )
  ) {
    return true;
  }
  return (draft.fbrConnections ?? []).some(
    (connection) =>
      connection.status === FILING_COMPLETED_STATUS ||
      (ACTIVE_FBR_CONNECTION_STATUSES as readonly string[]).includes(
        connection.status ?? "",
      ),
  );
}

export type ReuseCandidate = ProtectionCandidate & {
  id: string;
  updatedAt: Date | string | number;
};

/**
 * Picks the draft a request without an explicit draft id may reuse: the most
 * recently updated draft for that user and year that is NOT protected.
 * Returns null when every same-year draft is protected (or none exists), which
 * means a new draft must be created.
 */
export function pickReusableDraft<T extends ReuseCandidate>(
  sameYearDrafts: readonly T[],
): T | null {
  const reusable = sameYearDrafts
    .filter((draft) => !isProtectedFilingDraft(draft))
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  return reusable[0] ?? null;
}

export type SameYearPosition = { position: number; total: number };

/**
 * Numbers the filings of each tax year in creation order, so two filings for
 * the same year can be told apart ("Filing 1 of 2"). Years with a single
 * filing get total = 1 and need no label.
 */
export function numberFilingsPerYear(
  drafts: ReadonlyArray<{
    id: string;
    taxYear: number;
    createdAt: Date | string | number;
  }>,
): Map<string, SameYearPosition> {
  const byYear = new Map<number, typeof drafts[number][]>();
  for (const draft of drafts) {
    const group = byYear.get(draft.taxYear) ?? [];
    group.push(draft);
    byYear.set(draft.taxYear, group);
  }

  const result = new Map<string, SameYearPosition>();
  for (const group of byYear.values()) {
    const ordered = [...group].sort((a, b) => {
      const diff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
    ordered.forEach((draft, index) =>
      result.set(draft.id, { position: index + 1, total: ordered.length }),
    );
  }
  return result;
}

const INCOME_SOURCE_LABELS: Record<string, string> = {
  salary: "Salary",
  pension: "Pension",
  property_rent: "Rental income",
  services: "Freelancer",
  bank_profit: "Bank profit",
  dividend: "Dividend",
  capital_gains: "Capital gains",
  business: "Business income",
  agriculture: "Agriculture",
  foreign_income_assets: "Non-resident",
  aop_company_links: "AOP / Company",
  sales_tax_fed_withholding: "Sales tax / FED",
  other_income: "Other income",
};

/**
 * Short human summary of a draft's income sources, for list screens. Accepts
 * the stored JSON string. Unknown or unreadable input gives an empty string.
 */
export function describeIncomeSources(stored: string | null | undefined) {
  if (!stored) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  const labels: string[] = [];
  for (const source of parsed) {
    const label = INCOME_SOURCE_LABELS[String(source)];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(", ");
}
