/**
 * Authoritative employment-page contract from the supplied IRIS HTML captures:
 *
 *   /home/user/uploads/employment salary.html
 *   /home/user/uploads/employment tax deductions.html
 *
 * This is DOM evidence, not a screenshot guess. Cell indexes are zero-based
 * among `.data-middle-child-wapper` inputs. `disabled` cells are computed by
 * IRIS and must never be targeted by the packet/filler.
 */

export type EmploymentGridSpec = {
  headers: readonly string[];
  rows: Readonly<Record<string, readonly number[]>>;
  computedRows: readonly string[];
};

export const EMPLOYMENT_SALARY_SPEC: EmploymentGridSpec = {
  headers: [
    "Description",
    "Code",
    "Total Income",
    "Subject to Final Tax",
    "Subject to Exemption",
    "Subject to Normal Income",
  ],
  rows: {
    // Total Income from Salary is a calculated summary: [D, D, D, D].
    "1000": [],
    // The supplied capture renders [E, D, E, D] for this and the ordinary
    // salary rows. Enter the gross figure in Total Income (cell 0).
    "1009": [0, 2],
    "1049": [0, 2],
    "1010": [0, 1, 2],
    "1008": [0, 1, 2],
    "1059": [0, 2],
    "1089": [0, 1, 2],
    "1099": [0, 1, 2],
  },
  computedRows: ["1000"],
};

export const EMPLOYMENT_TAX_DEDUCTIONS_SPECS: Readonly<{
  adjustable: EmploymentGridSpec;
  final: EmploymentGridSpec;
  average: EmploymentGridSpec;
}> = {
  adjustable: {
    headers: ["Description", "Code", "Taxable Amount", "Tax Deducted"],
    rows: {
      "999909": [],
      "64020004": [0, 1],
      "64020005": [0, 1],
    },
    computedRows: ["999909"],
  },
  final: {
    headers: [
      "Description",
      "Code",
      "Taxable Amount",
      "Tax Deducted",
      "Tax Chargeable",
    ],
    rows: {
      "999910": [],
      "64210051": [0, 1],
      "64020007": [0, 1],
    },
    computedRows: ["999910"],
  },
  average: {
    headers: [
      "Description",
      "Code",
      "Taxable Amount",
      "Tax Deducted",
      "Tax Chargeable",
    ],
    rows: {
      "999911": [],
      "64210054": [0, 1],
      "64210056": [0, 1],
    },
    computedRows: ["999911"],
  },
};

export const EMPLOYMENT_SALARY_ROW_CODES = Object.freeze(
  Object.keys(EMPLOYMENT_SALARY_SPEC.rows),
);

export const EMPLOYMENT_TAX_DEDUCTION_ROW_CODES = Object.freeze([
  ...Object.keys(EMPLOYMENT_TAX_DEDUCTIONS_SPECS.adjustable.rows),
  ...Object.keys(EMPLOYMENT_TAX_DEDUCTIONS_SPECS.final.rows),
  ...Object.keys(EMPLOYMENT_TAX_DEDUCTIONS_SPECS.average.rows),
]);

/** The only Tax Deductions cell currently fed by the salary certificate. */
export const SALARY_CERTIFICATE_TAX_ROW = {
  code: "64020004",
  column: "Tax Deducted",
  cellIndex: 1,
} as const;
