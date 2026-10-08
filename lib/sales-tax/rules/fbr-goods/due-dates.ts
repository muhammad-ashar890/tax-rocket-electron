/**
 * Due dates for the monthly return.
 *
 * Standard procedure (FBR due dates page): Annex-C by the 10th, payment by
 * the 15th, electronic filing by the 18th of the month after the tax period.
 * The Board can move these dates by notification, so every extension is a
 * dated override carrying its S.R.O. reference. Nothing is guessed: weekend
 * and holiday shifts are only applied when someone adds an override.
 */

import { formatIso, isValidIso, lastDayOfMonth, nextMonth } from "../../dates";
import type { IsoDate, TaxPeriod } from "../../types";
import { findRuleNumber } from "./catalog";

export type DueDateTarget = "annex_c" | "payment" | "return";

export interface DueDateOverride {
  period: TaxPeriod;
  target: DueDateTarget;
  date: IsoDate;
  /** The notification that moved the date, for example an S.R.O. number. */
  reference: string;
}

/**
 * Notified extensions. Empty on purpose: the one extension seen so far was
 * reported by a news site and has not been checked against an FBR
 * notification, so it is not loaded.
 */
export const DUE_DATE_OVERRIDES: DueDateOverride[] = [];

export interface DueDates {
  annexC: IsoDate;
  payment: IsoDate;
  returnFiling: IsoDate;
  /** Overrides that changed a date, so the screen can show why. */
  overridesApplied: DueDateOverride[];
}

export function getDueDates(
  period: TaxPeriod,
  overrides: DueDateOverride[] = DUE_DATE_OVERRIDES,
): DueDates | null {
  const asOf = lastDayOfMonth(period);
  const annexCDay = findRuleNumber("fbr.due.annex_c_day", asOf);
  const paymentDay = findRuleNumber("fbr.due.payment_day", asOf);
  const returnDay = findRuleNumber("fbr.due.return_day", asOf);
  if (annexCDay === null || paymentDay === null || returnDay === null) {
    return null;
  }
  const following = nextMonth(period);
  const result: DueDates = {
    annexC: formatIso(following.year, following.month, annexCDay),
    payment: formatIso(following.year, following.month, paymentDay),
    returnFiling: formatIso(following.year, following.month, returnDay),
    overridesApplied: [],
  };
  for (const override of overrides) {
    if (
      override.period.year !== period.year ||
      override.period.month !== period.month
    ) {
      continue;
    }
    if (!isValidIso(override.date) || !override.reference) continue;
    if (override.target === "annex_c") result.annexC = override.date;
    if (override.target === "payment") result.payment = override.date;
    if (override.target === "return") result.returnFiling = override.date;
    result.overridesApplied.push(override);
  }
  return result;
}
