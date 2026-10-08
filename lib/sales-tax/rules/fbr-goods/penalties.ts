/**
 * Late filing penalty (s.33) and default surcharge (s.34).
 *
 * Amounts are estimates for the user to see the cost of filing late. The
 * Inland Revenue officer decides the actual figure.
 */

import { daysBetween } from "../../dates";
import { type Paisa } from "../../money";
import type { IsoDate } from "../../types";
import { findRuleNumber } from "./catalog";

export type LatePenaltyResult =
  | { status: "on_time"; daysLate: 0; penalty: 0 }
  | {
      status: "late";
      daysLate: number;
      penalty: Paisa;
      basis: "per_day" | "fixed";
    }
  /** No verified rule row covers that due date. */
  | { status: "rule_not_loaded" };

/**
 * Penalty for failing to furnish the return by the due date.
 * Within the window (ten days) it is the per-day amount for each day of
 * default; after that it is the fixed amount. Returns "rule_not_loaded" when
 * the due date falls before the earliest verified rule row.
 */
export function lateReturnPenalty(
  dueDate: IsoDate,
  filedDate: IsoDate,
): LatePenaltyResult {
  const fixed = findRuleNumber("fbr.penalty.late_return.fixed", dueDate);
  const perDay = findRuleNumber("fbr.penalty.late_return.per_day", dueDate);
  const window = findRuleNumber(
    "fbr.penalty.late_return.per_day_window",
    dueDate,
  );
  if (fixed === null || perDay === null || window === null) {
    return { status: "rule_not_loaded" };
  }
  const daysLate = daysBetween(dueDate, filedDate);
  if (daysLate <= 0) return { status: "on_time", daysLate: 0, penalty: 0 };
  if (daysLate <= window) {
    return {
      status: "late",
      daysLate,
      penalty: perDay * daysLate * 100,
      basis: "per_day",
    };
  }
  return { status: "late", daysLate, penalty: fixed * 100, basis: "fixed" };
}

export interface DefaultSurchargeInput {
  /** Unpaid tax in paisa. */
  taxDue: Paisa;
  /** Days between the date the tax was due and the date it was paid. */
  daysLate: number;
  /** The KIBOR rate in percent per annum, entered by the user. */
  kiborPercent: number;
  /** The date the tax was due; selects the rule rows in force. */
  dueDate: IsoDate;
}

/**
 * Default surcharge: the higher of twelve percent a year or KIBOR plus three
 * percent a year, applied to the unpaid tax for the days it stayed unpaid.
 * A 365-day year is assumed. Returns null when no rule row is in force.
 */
export function defaultSurcharge(input: DefaultSurchargeInput): Paisa | null {
  const fixedPercent = findRuleNumber(
    "fbr.default_surcharge.annual_percent",
    input.dueDate,
  );
  const margin = findRuleNumber(
    "fbr.default_surcharge.kibor_margin",
    input.dueDate,
  );
  if (fixedPercent === null || margin === null) return null;
  if (
    !Number.isFinite(input.kiborPercent) ||
    input.kiborPercent < 0 ||
    input.taxDue <= 0 ||
    input.daysLate <= 0
  ) {
    return 0;
  }
  const annualPercent = Math.max(fixedPercent, input.kiborPercent + margin);
  return Math.round((input.taxDue * annualPercent * input.daysLate) / (100 * 365));
}
