export type SalaryCertificateFieldKind =
  | "gross_salary"
  | "tax_withheld"
  | "employer_name"
  | "other_employers"
  | "tax_year";

/** Review-form labels for the employer fields (see ensureSalaryCertificateReviewFields). */
export const SALARY_EMPLOYER_LABEL = "Employer Name (as registered with FBR)";
export const SALARY_OTHER_EMPLOYERS_LABEL =
  "Other Employer Names (optional, separate with ; or ,)";
export const SALARY_TAX_YEAR_LABEL = "Tax Year";

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

  // Employer fields. "Employer NTN", "Employer Address" and the like are not
  // names, so a label must say "name" and carry none of those words.
  if (
    /(^|_)employers?(_|$)/.test(normalized) &&
    !/(^|_)(ntn|ftn|cnic|nic|id|no|number|address|reg|registration|phone|email)(_|$)/.test(
      normalized,
    )
  ) {
    return /(^|_)(other|additional|more)(_|$)/.test(normalized)
      ? "other_employers"
      : /(^|_)name(s)?(_|$)/.test(normalized) || normalized === "employer"
        ? "employer_name"
        : null;
  }

  // "Tax Year" itself, not "Tax Deducted ..." and not "Salary Period".
  if (normalized === "tax_year" || /^tax_year_\d{4}$/.test(normalized)) {
    return "tax_year";
  }

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

/** Every recognised field except the optional extra employers is required (Tax Year included). */
export function isSalaryCertificateRequiredField(label: unknown): boolean {
  const kind = getSalaryCertificateFieldKind(label);
  return kind !== null && kind !== "other_employers";
}

/** Adds visible, editable placeholders when the extractor omitted either field. */
export function ensureSalaryCertificateReviewFields(
  extracted: unknown,
): unknown {
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
      (field) => getSalaryCertificateFieldKind(field.label) === "gross_salary",
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

  if (
    !fields.some(
      (field) => getSalaryCertificateFieldKind(field.label) === "employer_name",
    )
  ) {
    fields.push({ label: SALARY_EMPLOYER_LABEL, value: null, confidence: 0 });
  }

  if (
    !fields.some(
      (field) => getSalaryCertificateFieldKind(field.label) === "tax_year",
    )
  ) {
    fields.push({ label: SALARY_TAX_YEAR_LABEL, value: null, confidence: 0 });
  }

  if (
    !fields.some(
      (field) =>
        getSalaryCertificateFieldKind(field.label) === "other_employers",
    )
  ) {
    fields.push({
      label: SALARY_OTHER_EMPLOYERS_LABEL,
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
  if (
    !normalized ||
    normalized === "-" ||
    normalized === "." ||
    normalized === "-."
  ) {
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

/**
 * Reads the tax year from what the certificate shows: "2026", "TY2026",
 * "Tax Year 2026", "2025-26" or a period such as "01 July 2025 to 30 June
 * 2026". A Pakistani tax year is named after the year its period ends in, so
 * the latest year found is the answer. Returns null when no year is readable.
 */
export function parseSalaryCertificateTaxYear(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const years: number[] = [];
  for (const match of text.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)) {
    years.push(Number(match[1]));
  }
  // "2025-26" / "2025/26": the short second half is the ending year.
  for (const match of text.matchAll(
    /(?<!\d)(20\d{2})\s*[-/\u2013]\s*(\d{2})(?!\d)(?!\s*[-/\u2013]\s*\d)/g,
  )) {
    years.push(2000 + Number(match[2]));
  }
  return years.length ? Math.max(...years) : null;
}

/**
 * The certificate's tax year must be readable and equal the return's tax
 * year: figures from another year must never reach this return.
 */
export function checkSalaryCertificateTaxYear(
  fields: SalaryCertificateFieldLike[] | undefined,
  returnTaxYear: number,
): { ok: boolean; error?: string; certificateTaxYear: number | null } {
  const certificateTaxYear = fields
    ? parseSalaryCertificateTaxYear(
        salaryCertificateFieldValue(fields, "tax_year"),
      )
    : null;
  if (certificateTaxYear === null) {
    return {
      ok: false,
      certificateTaxYear,
      error:
        "Enter the tax year printed on the salary certificate (for example 2026).",
    };
  }
  if (certificateTaxYear !== returnTaxYear) {
    return {
      ok: false,
      certificateTaxYear,
      error: `This salary certificate is for tax year ${certificateTaxYear}, but this return is for tax year ${returnTaxYear}. Upload the certificate for July ${returnTaxYear - 1} to June ${returnTaxYear}.`,
    };
  }
  return { ok: true, certificateTaxYear };
}

/** True when the certificate names the employer to add on IRIS. */
export function hasRequiredSalaryCertificateEmployer(
  fields: SalaryCertificateFieldLike[] | undefined,
) {
  if (!fields) return false;
  return (
    normalizeEmployerNames(salaryCertificateFieldValue(fields, "employer_name"))
      .length > 0
  );
}

/**
 * Splits free text into trimmed, non-empty employer names. `;` and new lines
 * always separate names; a comma does too, but only where several names are
 * expected (Other Employer Names). The main name stays a single name.
 */
function normalizeEmployerNames(
  value: unknown,
  { commaSeparates = false }: { commaSeparates?: boolean } = {},
): string[] {
  return String(value ?? "")
    .split(commaSeparates ? /[;,\n]+/ : /[;\n]+/)
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Every employer the taxpayer named on the reviewed salary certificate: the
 * main employer first, then any "other employers". Duplicates (ignoring case
 * and spacing) are dropped. IRIS needs each one added by name.
 */
export function extractSalaryCertificateEmployers(
  extractedData: string | null | undefined,
): string[] {
  if (!extractedData) return [];
  try {
    const payload = JSON.parse(extractedData) as {
      fields?: SalaryCertificateFieldLike[];
    };
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    const names = [
      ...normalizeEmployerNames(
        salaryCertificateFieldValue(fields, "employer_name"),
      ),
      ...fields
        .filter(
          (field) =>
            getSalaryCertificateFieldKind(field.label) === "other_employers",
        )
        .flatMap((field) =>
          normalizeEmployerNames(field.value, { commaSeparates: true }),
        ),
    ];
    const seen = new Set<string>();
    return names.filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * A comparable fingerprint of the employer fields: two field lists with the
 * same names (ignoring spacing and the separator typed) give the same string.
 * Used to tell whether the employer was edited after it was last saved.
 */
export function salaryCertificateEmployerSignature(
  fields: SalaryCertificateFieldLike[] | undefined,
): string {
  const list = Array.isArray(fields) ? fields : [];
  const main = normalizeEmployerNames(
    salaryCertificateFieldValue(list, "employer_name"),
  );
  const others = list
    .filter(
      (field) =>
        getSalaryCertificateFieldKind(field.label) === "other_employers",
    )
    .flatMap((field) =>
      normalizeEmployerNames(field.value, { commaSeparates: true }),
    );
  return JSON.stringify([main, others]);
}

const MAX_EMPLOYER_NAME_LENGTH = 200;
const MAX_EMPLOYERS = 10;

/**
 * Rewrites only the two employer fields of an already-mapped salary
 * certificate. Pure: validates the names and returns the new extractedData
 * JSON, leaving amounts and every other field untouched.
 */
export function planSalaryCertificateEmployerUpdate(
  extractedData: string | null | undefined,
  input: { employerName: unknown; otherEmployerNames?: unknown },
): {
  ok: boolean;
  error?: string;
  extractedData?: string;
  employers?: string[];
} {
  const main = normalizeEmployerNames(input.employerName);
  if (main.length !== 1) {
    return {
      ok: false,
      error:
        "Enter exactly one name in Employer Name. Put any other employers under Other Employer Names, separated by semicolons.",
    };
  }
  const others = normalizeEmployerNames(input.otherEmployerNames, {
    commaSeparates: true,
  });
  const all = [...main, ...others];
  if (all.some((name) => name.length > MAX_EMPLOYER_NAME_LENGTH)) {
    return { ok: false, error: "An employer name is too long." };
  }
  if (all.some((name) => /[\u0000-\u001f\u007f]/.test(name))) {
    return { ok: false, error: "Employer names contain invalid characters." };
  }
  if (all.length > MAX_EMPLOYERS) {
    return { ok: false, error: `At most ${MAX_EMPLOYERS} employers.` };
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed = extractedData ? JSON.parse(extractedData) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    return { ok: false, error: "The stored extraction could not be read." };
  }
  const existing: SalaryCertificateFieldLike[] = Array.isArray(payload.fields)
    ? (payload.fields as SalaryCertificateFieldLike[])
    : [];
  const kept = existing.filter((field) => {
    const kind = getSalaryCertificateFieldKind(field?.label);
    return kind !== "employer_name" && kind !== "other_employers";
  });
  const fields = [
    ...kept,
    { label: SALARY_EMPLOYER_LABEL, value: main[0], confidence: 1 },
    {
      label: SALARY_OTHER_EMPLOYERS_LABEL,
      value: others.length ? others.join("; ") : null,
      confidence: 1,
    },
  ];
  const next = JSON.stringify({ ...payload, fields });
  return {
    ok: true,
    extractedData: next,
    employers: extractSalaryCertificateEmployers(next),
  };
}
