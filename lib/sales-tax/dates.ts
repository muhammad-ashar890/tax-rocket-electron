/**
 * Calendar helpers. Dates are "YYYY-MM-DD" strings and every calculation uses
 * UTC so the result never depends on the machine's time zone.
 */

import type { IsoDate, TaxPeriod } from "./types";

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatIso(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isValidIso(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidPeriod(period: TaxPeriod | null | undefined): boolean {
  return (
    !!period &&
    Number.isInteger(period.year) &&
    Number.isInteger(period.month) &&
    period.year >= 2000 &&
    period.year <= 2100 &&
    period.month >= 1 &&
    period.month <= 12
  );
}

export function lastDayOfMonth(period: TaxPeriod): IsoDate {
  const last = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  return formatIso(period.year, period.month, last);
}

export function firstDayOfMonth(period: TaxPeriod): IsoDate {
  return formatIso(period.year, period.month, 1);
}

/** The calendar month that follows the given one. */
export function nextMonth(period: TaxPeriod): TaxPeriod {
  return period.month === 12
    ? { year: period.year + 1, month: 1 }
    : { year: period.year, month: period.month + 1 };
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = ISO_PATTERN.exec(from);
  const b = ISO_PATTERN.exec(to);
  if (!a || !b) throw new Error(`daysBetween needs ISO dates, got "${from}" and "${to}".`);
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((end - start) / 86400000);
}

export function isDateInPeriod(date: IsoDate, period: TaxPeriod): boolean {
  return date >= firstDayOfMonth(period) && date <= lastDayOfMonth(period);
}

/**
 * Reads a spreadsheet date cell. Accepts a Date (read with UTC parts), an
 * Excel serial number, or text in ISO, DD/MM/YYYY or DD-Mon-YYYY form.
 * Returns null when the value is not a real date.
 */
export function parseDateCell(value: unknown): IsoDate | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return formatIso(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
    );
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1 || value > 80000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return formatIso(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
    );
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (isValidIso(text)) return text;
  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (slash) {
    const iso = formatIso(Number(slash[3]), Number(slash[2]), Number(slash[1]));
    return isValidIso(iso) ? iso : null;
  }
  const named = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{4})$/.exec(text);
  if (named) {
    const months = [
      "jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const month = months.indexOf(named[2].toLowerCase()) + 1;
    if (month === 0) return null;
    const iso = formatIso(Number(named[3]), month, Number(named[1]));
    return isValidIso(iso) ? iso : null;
  }
  return null;
}
