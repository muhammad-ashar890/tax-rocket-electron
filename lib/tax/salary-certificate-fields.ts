export type SalaryCertificateFieldKind = "gross_salary" | "tax_withheld";

export type SalaryCertificateFieldLike = {
  label?: unknown;
  value?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
};

function normalizedLabel(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Maps only annual/unspecified salary-certificate fields. A "Net Salary" or
 * monthly amount must never satisfy the gross-annual field requirement.
 */
export function getSalaryCertificateFieldKind(
  label: unknown,
): SalaryCertificateFieldKind | null {
  const normalized = normalizedLabel(label);
  if (!normalized) return null;

  const isMonthly = /(^|_)(monthly|month|per_month)(_|$)/.test(normalized);
  if (isMonthly) return null;

  if (
    normalized === "salary" ||
    normalized.includes("gross_salary") ||
    normalized.includes("gross_pay")
  ) {
    return "gross_salary";
  }

  if (
    normalized.includes("tax_deducted") ||
    normalized.includes("tax_withheld") ||
    normalized.includes("income_tax_deducted")
  ) {
    return "tax_withheld";
  }

  return null;
}

/** Adds visible, editable placeholders when the extractor omitted either field. */
export function ensureSalaryCertificateReviewFields(extracted: unknown): unknown {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
    return extracted;
  }

  const payload = extracted as Record<string, unknown>;
  const fields: SalaryCertificateFieldLike[] = Array.isArray(payload.fields)
    ? payload.fields.filter(
        (field): field is SalaryCertificateFieldLike =>
          Boolean(field) && typeof field === "object" && !Array.isArray(field),
      )
    : [];

  if (
    !fields.some(
      (field) =>
        getSalaryCertificateFieldKind(field.label) === "gross_salary",
    )
  ) {
    fields.push({
      label: "Gross Salary (Annual PKR)",
      value: null,
      confidence: 0,
    });
  }

  if (
    !fields.some(
      (field) => getSalaryCertificateFieldKind(field.label) === "tax_withheld",
    )
  ) {
    fields.push({
      label: "Tax Deducted u/s 149 (Annual PKR)",
      value: null,
      confidence: 0,
    });
  }

  return { ...payload, fields };
}

/** Prefer an explicitly annual value if the certificate contains several rows. */
export function salaryCertificateFieldValue(
  fields: SalaryCertificateFieldLike[],
  kind: SalaryCertificateFieldKind,
) {
  const candidates = fields.filter(
    (field) => getSalaryCertificateFieldKind(field.label) === kind,
  );
  candidates.sort((left, right) => {
    const score = (field: SalaryCertificateFieldLike) => {
      const label = normalizedLabel(field.label);
      const annual = /(^|_)(annual|yearly|year)(_|$)/.test(label) ? 0 : 1;
      const explicitGross = label.includes("gross") ? 0 : 1;
      return annual * 2 + (kind === "gross_salary" ? explicitGross : 0);
    };
    return score(left) - score(right);
  });
  return candidates[0]?.value;
}

export function parseSalaryCertificateAmount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const normalized = String(value).replace(/[^0-9.-]/g, "");
  if (!normalized || normalized === "-" || normalized === "." || normalized === "-.") {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasRequiredSalaryCertificateAmounts(
  fields: SalaryCertificateFieldLike[] | undefined,
) {
  if (!fields) return false;
  const grossSalary = parseSalaryCertificateAmount(
    salaryCertificateFieldValue(fields, "gross_salary"),
  );
  const taxWithheld = parseSalaryCertificateAmount(
    salaryCertificateFieldValue(fields, "tax_withheld"),
  );
  return (
    grossSalary !== null &&
    grossSalary > 0 &&
    taxWithheld !== null &&
    taxWithheld >= 0
  );
}


/** Read the two canonical annual amounts from a persisted salary extraction. */
export function extractSalaryCertificateAmounts(
  extractedData: string | null | undefined,
) {
  const empty = { grossSalary: null, taxWithheld: null };
  if (!extractedData) return empty;

  try {
    const payload = JSON.parse(extractedData) as {
      fields?: SalaryCertificateFieldLike[];
    };
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    return {
      grossSalary: parseSalaryCertificateAmount(
        salaryCertificateFieldValue(fields, "gross_salary"),
      ),
      taxWithheld: parseSalaryCertificateAmount(
        salaryCertificateFieldValue(fields, "tax_withheld"),
      ),
    };
  } catch {
    return empty;
  }
}

/**
 * Use certificate gross pay as the tax base while keeping bank salary deposits
 * in the cash/wealth ledger. Preserve any ordinary income that was not already
 * represented by a salary-category bank credit.
 */
export function resolveSalaryTaxableIncome(input: {
  ledgerSalaryRemainder: number;
  bankSalaryIncome: number;
  certificateGrossSalary: number | null;
}) {
  const ledgerSalaryRemainder = Number.isFinite(input.ledgerSalaryRemainder)
    ? Math.max(0, input.ledgerSalaryRemainder)
    : 0;
  const certificateGrossSalary = input.certificateGrossSalary;

  if (
    certificateGrossSalary === null ||
    !Number.isFinite(certificateGrossSalary) ||
    certificateGrossSalary <= 0
  ) {
    return ledgerSalaryRemainder;
  }

  const bankSalaryIncome = Number.isFinite(input.bankSalaryIncome)
    ? Math.max(0, input.bankSalaryIncome)
    : 0;
  const ordinaryIncomeOutsideBankSalary = Math.max(
    0,
    ledgerSalaryRemainder - bankSalaryIncome,
  );

  return certificateGrossSalary + ordinaryIncomeOutsideBankSalary;
}
