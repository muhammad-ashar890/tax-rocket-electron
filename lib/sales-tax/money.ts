/**
 * Money helpers for the sales tax engine.
 *
 * All amounts inside the engine are whole paisa held in plain integers, so
 * adding and subtracting never drifts the way floating point rupees do.
 * Rupee strings are produced only at the presentation edge.
 *
 * This file is deliberately independent of lib/money.ts, which is tied to the
 * database Decimal type. The sales tax engine has no database in Phase 1.
 */

export type Paisa = number;

const MAX_SAFE_PAISA = Number.MAX_SAFE_INTEGER;

/**
 * Converts a rupee amount (number or text such as "1,234.50") to whole paisa.
 * Rounds half away from zero using text arithmetic, so 1.005 becomes 101
 * paisa instead of being pulled down by binary floating point.
 * Returns null for blank or non-numeric input.
 */
export function toPaisa(value: unknown): Paisa | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Eight decimals is far more than any rupee amount needs and removes the
    // binary noise (for example 0.1 + 0.2) before the text is rounded.
    text = value.toFixed(8);
  } else if (typeof value === "string") {
    text = value.replace(/,/g, "").replace(/\s+/g, "");
    if (text === "") return null;
  } else {
    return null;
  }
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const negative = match[1] === "-";
  const whole = match[2] || "0";
  const fraction = match[3] || "";
  if (whole === "0" && fraction === "" && match[2] === "") return null;
  const wholePaisa = Number(whole) * 100;
  const fractionDigits = (fraction + "000").slice(0, 3);
  let paisa = wholePaisa + Number(fractionDigits.slice(0, 2));
  if (Number(fractionDigits[2]) >= 5) paisa += 1;
  if (!Number.isSafeInteger(paisa) || paisa > MAX_SAFE_PAISA) return null;
  return negative ? -paisa : paisa;
}

/** Whole rupees, rounded half away from zero, the way IRIS shows return lines. */
export function paisaToRupees(paisa: Paisa): number {
  const sign = paisa < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(paisa) + 50) / 100);
}

/** Formats paisa as "Rs 1,234.50" (always two decimals). */
export function formatRupees(paisa: Paisa): string {
  const sign = paisa < 0 ? "-" : "";
  const absolute = Math.abs(paisa);
  const rupees = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, "0");
  const grouped = String(rupees).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}Rs ${grouped}.${cents}`;
}

/**
 * Multiplies paisa by a rate given as a decimal fraction (0.18 for 18%) and
 * rounds half away from zero. The rate is converted to parts per ten
 * thousand first, which covers every numeric rate in the official FBR list
 * (the smallest step there is 0.0001).
 */
export function applyRate(paisa: Paisa, rateFraction: number): Paisa {
  const basisPoints = Math.round(rateFraction * 10000);
  const scaled = Math.abs(paisa) * basisPoints;
  const result = Math.floor((scaled + 5000) / 10000);
  return paisa < 0 ? -result : result;
}

/** Applies a whole-number percentage (for example 90) to paisa, rounding down. */
export function percentOfFloor(paisa: Paisa, percent: number): Paisa {
  const sign = paisa < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(paisa) * percent) / 100);
}

export function sumPaisa(values: Paisa[]): Paisa {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
