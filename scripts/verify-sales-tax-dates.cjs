/**
 * Sales tax calendar: dates, due dates, late filing penalty and default
 * surcharge. Every expected date and amount is worked out by hand from the
 * Sales Tax Act 1990 (updated to 30-06-2026) and the FBR due dates page.
 */

const { load, createChecker } = require("./lib/sales-tax-test-kit.cjs");

const dates = load("lib/sales-tax/dates.ts");
const due = load("lib/sales-tax/rules/fbr-goods/due-dates.ts");
const pen = load("lib/sales-tax/rules/fbr-goods/penalties.ts");

const { check, finish } = createChecker("verify-sales-tax-dates");

// ---------------------------------------------------------------------------
// 1. Calendar helpers
// ---------------------------------------------------------------------------

for (const [text, valid] of [
  ["2026-08-31", true], ["2026-02-29", false], ["2024-02-29", true], ["2026-13-01", false],
  ["2026-00-10", false], ["2026-4-5", false], ["26-04-05", false], ["", false], ["2026-04-31", false],
]) {
  check(`isValidIso(${text})`, dates.isValidIso(text), valid);
}
check("isValidIso(non string)", [dates.isValidIso(null), dates.isValidIso(20260101), dates.isValidIso(undefined)], [false, false, false]);

for (const [period, last] of [
  [{ year: 2026, month: 1 }, "2026-01-31"], [{ year: 2026, month: 2 }, "2026-02-28"],
  [{ year: 2024, month: 2 }, "2024-02-29"], [{ year: 2026, month: 4 }, "2026-04-30"],
  [{ year: 2026, month: 12 }, "2026-12-31"], [{ year: 2100, month: 2 }, "2100-02-28"],
]) {
  check(`lastDayOfMonth ${period.year}-${period.month}`, dates.lastDayOfMonth(period), last);
}
check("firstDayOfMonth", dates.firstDayOfMonth({ year: 2026, month: 8 }), "2026-08-01");
check("nextMonth", dates.nextMonth({ year: 2026, month: 8 }), { year: 2026, month: 9 });
check("nextMonth December", dates.nextMonth({ year: 2026, month: 12 }), { year: 2027, month: 1 });
check("daysBetween same day", dates.daysBetween("2026-09-18", "2026-09-18"), 0);
check("daysBetween one day", dates.daysBetween("2026-09-18", "2026-09-19"), 1);
check("daysBetween across month end", dates.daysBetween("2026-09-28", "2026-10-02"), 4);
check("daysBetween across leap day", dates.daysBetween("2024-02-28", "2024-03-01"), 2);
check("daysBetween across year", dates.daysBetween("2026-12-30", "2027-01-02"), 3);
check("daysBetween negative", dates.daysBetween("2026-09-19", "2026-09-18"), -1);
check("daysBetween a full year", dates.daysBetween("2026-01-01", "2027-01-01"), 365);
{
  let threw = false;
  try { dates.daysBetween("bad", "2026-01-01"); } catch (e) { threw = true; }
  check("daysBetween rejects bad text", threw, true);
}
check("isValidPeriod", [
  dates.isValidPeriod({ year: 2026, month: 8 }), dates.isValidPeriod({ year: 2026, month: 0 }),
  dates.isValidPeriod({ year: 2026, month: 13 }), dates.isValidPeriod({ year: 2026.5, month: 8 }),
  dates.isValidPeriod(null), dates.isValidPeriod({ year: 1999, month: 8 }),
], [true, false, false, false, false, false]);
check("isDateInPeriod first", dates.isDateInPeriod("2026-08-01", { year: 2026, month: 8 }), true);
check("isDateInPeriod last", dates.isDateInPeriod("2026-08-31", { year: 2026, month: 8 }), true);
check("isDateInPeriod day before", dates.isDateInPeriod("2026-07-31", { year: 2026, month: 8 }), false);
check("isDateInPeriod day after", dates.isDateInPeriod("2026-09-01", { year: 2026, month: 8 }), false);

// Spreadsheet date cells. Dates are read with UTC parts, so the machine's time zone cannot move them.
check("Date cell", dates.parseDateCell(new Date(Date.UTC(2026, 7, 10))), "2026-08-10");
check("Date cell at 23:59 UTC stays the same day", dates.parseDateCell(new Date(Date.UTC(2026, 7, 10, 23, 59))), "2026-08-10");
check("Excel serial 46244 (2026-08-10)", dates.parseDateCell(46244), "2026-08-10");
check("Excel serial with time fraction", dates.parseDateCell(46244.75), "2026-08-10");
check("ISO text", dates.parseDateCell("2026-08-10"), "2026-08-10");
check("DD/MM/YYYY", dates.parseDateCell("10/08/2026"), "2026-08-10");
check("D/M/YYYY", dates.parseDateCell("1/8/2026"), "2026-08-01");
check("DD-Mon-YYYY", dates.parseDateCell("10-Aug-2026"), "2026-08-10");
check("DD Month YYYY", dates.parseDateCell("10 August 2026"), "2026-08-10");
check("impossible date text", dates.parseDateCell("31/02/2026"), null);
check("garbage text", dates.parseDateCell("tomorrow"), null);
check("blank", [dates.parseDateCell(""), dates.parseDateCell(null), dates.parseDateCell(undefined)], [null, null, null]);
check("invalid Date object", dates.parseDateCell(new Date("x")), null);
check("zero serial", dates.parseDateCell(0), null);
check("huge serial", dates.parseDateCell(9999999), null);
check("Excel serial for 2026-01-01", dates.parseDateCell(46023), "2026-01-01");

// ---------------------------------------------------------------------------
// 2. Due dates: Annex-C 10th, payment 15th, return 18th of the next month
// ---------------------------------------------------------------------------

{
  const d = due.getDueDates({ year: 2026, month: 8 }, []);
  check("Aug 2026 Annex-C", d.annexC, "2026-09-10");
  check("Aug 2026 payment", d.payment, "2026-09-15");
  check("Aug 2026 return", d.returnFiling, "2026-09-18");
  check("no overrides applied", d.overridesApplied, []);
}
{
  const d = due.getDueDates({ year: 2026, month: 12 }, []);
  check("Dec 2026 rolls into January", [d.annexC, d.payment, d.returnFiling], ["2027-01-10", "2027-01-15", "2027-01-18"]);
}
{
  const d = due.getDueDates({ year: 2026, month: 1 }, []);
  check("Jan 2026", [d.annexC, d.payment, d.returnFiling], ["2026-02-10", "2026-02-15", "2026-02-18"]);
}
check("shipped override table is empty until an extension is verified", due.DUE_DATE_OVERRIDES, []);
{
  const override = { period: { year: 2026, month: 8 }, target: "return", date: "2026-09-25", reference: "S.R.O. test-only" };
  const d = due.getDueDates({ year: 2026, month: 8 }, [override]);
  check("override moves only the return date", [d.annexC, d.payment, d.returnFiling], ["2026-09-10", "2026-09-15", "2026-09-25"]);
  check("override is reported", d.overridesApplied.length, 1);
  const other = due.getDueDates({ year: 2026, month: 7 }, [override]);
  check("override for another month is ignored", other.returnFiling, "2026-08-18");
  const noRef = due.getDueDates({ year: 2026, month: 8 }, [{ ...override, reference: "" }]);
  check("override without a notification reference is ignored", noRef.returnFiling, "2026-09-18");
  const badDate = due.getDueDates({ year: 2026, month: 8 }, [{ ...override, date: "2026-02-31" }]);
  check("override with an impossible date is ignored", badDate.returnFiling, "2026-09-18");
  const all = due.getDueDates({ year: 2026, month: 8 }, [
    { ...override, target: "annex_c", date: "2026-09-12" },
    { ...override, target: "payment", date: "2026-09-16" },
  ]);
  check("annex-c and payment overrides", [all.annexC, all.payment, all.returnFiling], ["2026-09-12", "2026-09-16", "2026-09-18"]);
}

// ---------------------------------------------------------------------------
// 3. Late return penalty (s.33): Rs 2,000 a day within 10 days, else Rs 50,000
// ---------------------------------------------------------------------------

const DUE = "2026-09-18";
check("filed on the due date", pen.lateReturnPenalty(DUE, "2026-09-18"), { status: "on_time", daysLate: 0, penalty: 0 });
check("filed early", pen.lateReturnPenalty(DUE, "2026-09-10").status, "on_time");
check("one day late", pen.lateReturnPenalty(DUE, "2026-09-19"), { status: "late", daysLate: 1, penalty: 200000, basis: "per_day" });
check("five days late", pen.lateReturnPenalty(DUE, "2026-09-23"), { status: "late", daysLate: 5, penalty: 1000000, basis: "per_day" });
check("ten days late is still per day", pen.lateReturnPenalty(DUE, "2026-09-28"), { status: "late", daysLate: 10, penalty: 2000000, basis: "per_day" });
check("eleven days late is the fixed penalty", pen.lateReturnPenalty(DUE, "2026-09-29"), { status: "late", daysLate: 11, penalty: 5000000, basis: "fixed" });
check("a year late is the fixed penalty", pen.lateReturnPenalty(DUE, "2027-09-18"), { status: "late", daysLate: 365, penalty: 5000000, basis: "fixed" });
check("due date before the loaded rule", pen.lateReturnPenalty("2026-06-18", "2026-06-25"), { status: "rule_not_loaded" });
check("first day the rule applies", pen.lateReturnPenalty("2026-07-01", "2026-07-02").penalty, 200000);
check("last day before the rule applies", pen.lateReturnPenalty("2026-06-30", "2026-07-02").status, "rule_not_loaded");

// ---------------------------------------------------------------------------
// 4. Default surcharge (s.34): higher of 12% a year or KIBOR + 3%
// ---------------------------------------------------------------------------

// Rs 1,000,000 for 30 days.
//   KIBOR 11% -> 14% a year -> 1,000,000 x 0.14 x 30 / 365 = 11,506.849 -> Rs 11,506.85 = 1,150,685 paisa
//   KIBOR 8%  -> 12% a year (11% is lower) -> 986,301.37 paisa -> 986,301
const base = { taxDue: 100000000, daysLate: 30, dueDate: "2026-09-15" };
check("KIBOR above the floor", pen.defaultSurcharge({ ...base, kiborPercent: 11 }), 1150685);
check("KIBOR below the floor uses 12%", pen.defaultSurcharge({ ...base, kiborPercent: 8 }), 986301);
check("KIBOR exactly at the crossover (9%) uses 12%", pen.defaultSurcharge({ ...base, kiborPercent: 9 }), 986301);
check("KIBOR just above the crossover", pen.defaultSurcharge({ ...base, kiborPercent: 9.5 }), Math.round((100000000 * 12.5 * 30) / 36500));
check("one day", pen.defaultSurcharge({ ...base, daysLate: 1, kiborPercent: 8 }), Math.round((100000000 * 12 * 1) / 36500));
check("zero days", pen.defaultSurcharge({ ...base, daysLate: 0, kiborPercent: 11 }), 0);
check("no tax due", pen.defaultSurcharge({ ...base, taxDue: 0, kiborPercent: 11 }), 0);
check("negative days", pen.defaultSurcharge({ ...base, daysLate: -3, kiborPercent: 11 }), 0);
check("bad KIBOR gives zero, not a guess", pen.defaultSurcharge({ ...base, kiborPercent: NaN }), 0);
check("negative KIBOR gives zero", pen.defaultSurcharge({ ...base, kiborPercent: -1 }), 0);
check("365 days is a full year at 12%", pen.defaultSurcharge({ taxDue: 100000, daysLate: 365, kiborPercent: 5, dueDate: "2026-09-15" }), 12000);

finish();
