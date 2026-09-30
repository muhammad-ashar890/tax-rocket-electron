import { getTaxYearStatementRange } from "@/lib/tax/tax-year-period";

/**
 * Age handling for rate-card rules that depend on the taxpayer's age,
 * currently Section 149(IA) pension above PKR 10 million.
 *
 * The rate card states the treatment for a pensioner "below 70 years" and is
 * silent for age 70 and above, so this module reports three distinct outcomes
 * instead of collapsing an unknown age into a false "below 70".
 */

export type PensionerAgeBracket =
  | "BELOW_70"
  | "SEVENTY_OR_ABOVE"
  | "TURNS_70_DURING_YEAR"
  | "UNKNOWN";

export type PensionerAgeAssessment = {
  bracket: PensionerAgeBracket;
  /** Age on the first day of the tax year, when a date of birth is known. */
  ageAtTaxYearStart: number | null;
  /** Age on the last day of the tax year, when a date of birth is known. */
  ageAtTaxYearEnd: number | null;
  /**
   * True when the taxpayer was below 70 on the first day of the tax year:
   * BELOW_70, or TURNS_70_DURING_YEAR under the confirmed first-day rule.
   */
  isBelow70: boolean;
  /** Operator-facing explanation used when a route cannot be calculated. */
  reason: string;
};

/** Whole years completed on `onDate`. */
export function calculateAgeOn(dateOfBirth: Date, onDate: Date): number {
  let age = onDate.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const birthMonth = dateOfBirth.getUTCMonth();
  const birthDay = dateOfBirth.getUTCDate();
  const onMonth = onDate.getUTCMonth();
  const onDay = onDate.getUTCDate();

  // The birthday has not occurred yet in the comparison year.
  if (onMonth < birthMonth || (onMonth === birthMonth && onDay < birthDay)) {
    age -= 1;
  }

  return age;
}

export function parseTaxpayerDateOfBirth(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  // ISO first: YYYY-MM-DD.
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return buildUtcDate(Number(year), Number(month), Number(day));
  }

  // Pakistani identity documents commonly print DD/MM/YYYY or DD.MM.YYYY.
  const dayFirstMatch = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (dayFirstMatch) {
    const [, day, month, year] = dayFirstMatch;
    // A value above 12 in the first position can only be a day, which keeps an
    // ambiguous DD/MM vs MM/DD pair from silently flipping.
    if (Number(month) > 12) return null;
    return buildUtcDate(Number(year), Number(month), Number(day));
  }

  return null;
}

function buildUtcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible calendar dates such as 31 February.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  if (year < 1900) return null;

  return date;
}

/**
 * Decides the Section 149(IA) age test for a pensioner.
 *
 * Confirmed first-day rule (Option A): age is tested on the first day of the
 * tax year, following the Ordinance's own tradition for age tests (the former
 * 60+ relief applied to a taxpayer "aged 60 years or more on the first day of
 * that tax year"). A taxpayer who turns 70 during the year was 69 on the
 * first day, so the below-70 row applies for the whole year; the bracket
 * still reports TURNS_70_DURING_YEAR so the birthday stays visible.
 */
export function assessPensionerAge(input: {
  taxYear: number;
  dateOfBirth: Date | null;
}): PensionerAgeAssessment {
  if (!input.dateOfBirth) {
    return {
      bracket: "UNKNOWN",
      ageAtTaxYearStart: null,
      ageAtTaxYearEnd: null,
      isBelow70: false,
      reason:
        "Date of birth is not recorded. Add it to the taxpayer profile or upload a CNIC so the Section 149(IA) age condition can be applied.",
    };
  }

  const range = getTaxYearStatementRange(input.taxYear);
  const ageAtTaxYearStart = calculateAgeOn(input.dateOfBirth, range.start);
  const ageAtTaxYearEnd = calculateAgeOn(input.dateOfBirth, range.end);

  if (ageAtTaxYearEnd < 0 || ageAtTaxYearStart < 0) {
    return {
      bracket: "UNKNOWN",
      ageAtTaxYearStart,
      ageAtTaxYearEnd,
      isBelow70: false,
      reason: `The recorded date of birth is after Tax Year ${input.taxYear}. Correct it in the taxpayer profile.`,
    };
  }

  if (ageAtTaxYearEnd < 70) {
    return {
      bracket: "BELOW_70",
      ageAtTaxYearStart,
      ageAtTaxYearEnd,
      isBelow70: true,
      reason: `Pensioner is ${ageAtTaxYearEnd} at the end of Tax Year ${input.taxYear}, so the below-70 rate-card row applies for the whole year.`,
    };
  }

  if (ageAtTaxYearStart >= 70) {
    return {
      bracket: "SEVENTY_OR_ABOVE",
      ageAtTaxYearStart,
      ageAtTaxYearEnd,
      isBelow70: false,
      reason: `Pensioner is ${ageAtTaxYearStart} at the start of Tax Year ${input.taxYear}. The rate card does not state the treatment for age 70 or above, so confirmed rules are required.`,
    };
  }

  return {
    bracket: "TURNS_70_DURING_YEAR",
    ageAtTaxYearStart,
    ageAtTaxYearEnd,
    isBelow70: true,
    reason: `Pensioner turns 70 during Tax Year ${input.taxYear} (age ${ageAtTaxYearStart} at the start, ${ageAtTaxYearEnd} at the end). Per the confirmed first-day rule the below-70 row applies for the whole year.`,
  };
}
