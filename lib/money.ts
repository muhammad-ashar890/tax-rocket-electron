import { Prisma } from "@prisma/client";

/**
 * Conversion helpers for the money columns being migrated from Float to
 * Decimal (Phase 5).
 *
 * Money is stored as `Decimal(18, 2)` so that adding and subtracting amounts
 * is exact. Floating point is not: `1000000.10 + 1000000.20 - 2000000.30`
 * does not equal zero, which is why tolerance checks had to be sprinkled
 * through the reconciliation code.
 *
 * Decimal is the right storage type but a hostile runtime value, because it
 * silently misbehaves with the operators ordinary code uses:
 *
 *   - `decimalA + decimalB` CONCATENATES. `Decimal(1000.50) + Decimal(2000.25)`
 *     evaluates to the string "1000.52000.25", and TypeScript accepts it
 *     because a string is a valid result of `+`.
 *   - `Decimal(0)` is TRUTHY, where a Float `0` is falsy. Every
 *     `if (amount)` or `amount || fallback` inverts its meaning.
 *   - `.toLocaleString()` does not group thousands, so a value formatted for
 *     the PDF prints "1234567.89" instead of "1,234,567.89".
 *   - It is not JSON-serialisable as a number: it crosses the server/client
 *     boundary as a string.
 *
 * The rule this module exists to enforce: Decimal stays inside the database
 * layer. Anything crossing into a server action's return value, a React
 * component, or the packet PDF is converted here first.
 *
 * Converting to `number` is safe for display because the tax engine rounds
 * every figure it produces to whole rupees, and a 64-bit float represents
 * whole rupees exactly far beyond any realistic Pakistani tax figure. What is
 * NOT safe is doing arithmetic after converting, which is why the aggregation
 * paths keep working in Decimal and only the presentation edge uses these.
 */

type DecimalLike = Prisma.Decimal | number | string;

/**
 * A money column as it arrives from the database, which may be Decimal today,
 * a plain number on a column not yet migrated, or null where the column is
 * optional. Helpers that accept this must convert before comparing or adding.
 */
export type MoneyInput = DecimalLike | null | undefined;

/**
 * Converts an optional money column to a number, treating a missing value as
 * zero.
 *
 * This exists because `transaction.debit ?? 0` stops being safe once the
 * column is Decimal: `??` only replaces null, so a real Decimal survives and
 * then behaves badly. `Decimal(0)` is truthy, so `!(debit ?? 0)` — which
 * decided whether a transaction was money in or money out — silently inverts
 * and leaves every transaction unclassified. Comparisons are worse: they type
 * check and evaluate wrongly.
 */
export function toMoneyAmount(value: MoneyInput): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

/** Converts a stored money column into a plain number for display. */
export function toMoneyNumber(value: DecimalLike): number {
  return typeof value === "number" ? value : Number(value);
}

/** Nullable form, preserving null/undefined so "Pending" states still work. */
export function toMoneyNumberOrNull(
  value: DecimalLike | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return toMoneyNumber(value);
}

/**
 * Adds money values exactly.
 *
 * This is the helper the reduce/`+=` sites are meant to use, for two separate
 * reasons.
 *
 * The first is correctness of the operator. `total + decimal` does not add —
 * it CONCATENATES, so four ledger entries reduce to a run-on string of digits
 * and TypeScript raises nothing, because a string is a valid result of `+`.
 *
 * The second is precision, and it is the reason the whole migration exists.
 * Converting each value to a number first and then adding is type-safe but
 * still wrong: 1000000.10 + 1000000.20 - 2000000.30 does not equal zero in
 * floating point, which is exactly why tolerance checks had to be scattered
 * through the reconciliation. Summing in Decimal and converting once at the
 * end gives the exact total, so those tolerances stop being necessary.
 */
export function sumMoney(values: readonly MoneyInput[]): number {
  return values
    .reduce<Prisma.Decimal>(
      (total, value) => total.plus(toDecimal(value)),
      new Prisma.Decimal(0),
    )
    .toNumber();
}

/**
 * Adds and subtracts money values in one exact pass.
 *
 * Written for the running totals that add some entries and subtract others —
 * inflow versus outflow adjustments, for instance — so the intermediate
 * results stay in Decimal instead of drifting through floating point.
 */
export function netMoney(
  values: readonly { value: MoneyInput; subtract?: boolean }[],
): number {
  return values
    .reduce<Prisma.Decimal>(
      (total, { value, subtract }) =>
        subtract ? total.minus(toDecimal(value)) : total.plus(toDecimal(value)),
      new Prisma.Decimal(0),
    )
    .toNumber();
}

/** Shared Decimal coercion for the exact-arithmetic helpers above. */
function toDecimal(value: MoneyInput): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value.toString());
}

/**
 * Derives a statement's opening balance from its first transaction row.
 *
 * The first row records the balance AFTER it was applied, so the opening
 * figure is that balance with the row reversed out: subtract what came in,
 * add back what went out.
 *
 * This lives here, rather than inline in the parser, for two reasons. The
 * `+` is a live hazard — on an unconverted Decimal it concatenates, turning
 * the opening balance into a run-on string of digits — and inline in a server
 * action the arithmetic could not be tested without a file upload.
 *
 * The arithmetic is done in Decimal, not by converting first. Converting to
 * number and subtracting reintroduces exactly the error this migration exists
 * to remove: 625000.10 + 125000.45 evaluates to 750000.5499999999 in floating
 * point. The result is a stored opening balance, so it has to be exact.
 */
export function deriveOpeningBalance(
  firstBalance: MoneyInput,
  firstCredit: MoneyInput,
  firstDebit: MoneyInput,
): number {
  return toDecimal(firstBalance)
    .minus(toDecimal(firstCredit))
    .plus(toDecimal(firstDebit))
    .toNumber();
}

/**
 * Renders a money column as the plain text an editable input expects.
 *
 * `Decimal.toString()` happens to drop trailing zeros, so "5000.00" already
 * prints as "5000" and the direct call was not visibly wrong. It is routed
 * through here anyway because that behaviour is a property of the Decimal
 * library rather than of this code: going via the number makes the intended
 * output explicit, and the accompanying test pins it so a library change
 * cannot quietly start writing "5000.00" into an editable field.
 */
export function formatMoneyForInput(value: MoneyInput): string {
  if (value === null || value === undefined) return "";
  return String(toMoneyAmount(value));
}

/**
 * Converts the money fields of a packet-shaped record, leaving every other
 * field untouched. Used at the server-action boundary so UI code keeps
 * receiving plain numbers and never has to know the column type changed.
 */
export function serializePacketMoney<
  T extends { taxPayable: DecimalLike; refundDue: DecimalLike },
>(packet: T): Omit<T, "taxPayable" | "refundDue"> & {
  taxPayable: number;
  refundDue: number;
} {
  return {
    ...packet,
    taxPayable: toMoneyNumber(packet.taxPayable),
    refundDue: toMoneyNumber(packet.refundDue),
  };
}
