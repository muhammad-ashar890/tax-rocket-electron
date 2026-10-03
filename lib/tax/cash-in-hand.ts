import { netMoney, type MoneyInput } from "@/lib/money";

/**
 * Cash in hand (IRIS wealth row 7012).
 *
 * A bank transaction the taxpayer marked as a cash movement is the taxpayer's
 * own money leaving or entering the bank as physical cash: a withdrawal (debit)
 * raises cash in hand, a deposit (credit) lowers it. The net movement is
 *
 *   N = sum(withdrawals) - sum(deposits)
 *
 * and it is the amount ADDED to whatever IRIS already holds on row 7012. The
 * bank balance (row 7030) falls by the same amount, so net assets do not move
 * and the Mizan reconciliation needs no gap-filling adjustment.
 */
export const CASH_IN_HAND_CODE = "7012";

/** Packet marker: the amount is added to the value IRIS holds, not typed as is. */
export const VALUE_MODE_ADD_TO_IRIS = "add_to_iris_value" as const;

export type CashMovementTransaction = {
  classificationStatus: string | null | undefined;
  debit: MoneyInput;
  credit: MoneyInput;
};

/** Net cash movement of the confirmed CASH_MOVEMENT rows (exact, in Decimal). */
export function netCashMovement(
  transactions: readonly CashMovementTransaction[],
): number {
  return netMoney(
    transactions
      .filter((row) => row.classificationStatus === "CASH_MOVEMENT")
      .flatMap((row) => [
        { value: row.debit },
        { value: row.credit, subtract: true },
      ]),
  );
}
