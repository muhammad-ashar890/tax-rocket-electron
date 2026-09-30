import { toMoneyAmount, type MoneyInput } from "@/lib/money";
import { extractSalaryCertificateAmounts } from "@/lib/tax/salary-certificate-fields";
import { prisma } from "@/lib/prisma";

/**
 * Tax already deducted at source reaches a filing from two independent places:
 *
 *   - the salary certificate, which reports Section 149 deductions made by an
 *     employer, and
 *   - the bank ledger, where every Section 151 deduction appears as its own
 *     transaction the wizard classifies as EXPENSE / TAX_PAYMENT.
 *
 * Both have to be counted, because neither contains the other. What makes
 * this awkward is that they *can* overlap: an employer that pays gross salary
 * and deducts tax separately produces a bank row for the same deduction the
 * certificate already reports. Adding them blindly would then invent a refund
 * that does not exist.
 *
 * The rule implemented here is deliberately conservative. The two sources are
 * added, and the result is flagged when the ledger contains a tax row that
 * looks like employer withholding, rather than guessing which side to drop.
 * A wrong refund is far more damaging than a question: the taxpayer files it,
 * and FBR raises the notice months later.
 *
 * Deciding by keyword alone was rejected. Two defects in this codebase already
 * came from reading intent out of bank narration — "IBFT" was treated as proof
 * of an internal transfer, and "HBL" failed to match "Habib Bank Limited".
 * Keywords are used here only to raise a question, never to change a number.
 */

export type WithholdingLedgerEntry = {
  entryType: string;
  category: string | null;
  /** Required in the schema; typed loosely so a partial select cannot throw. */
  description: string | null | undefined;
  amount: MoneyInput;
};

export type WithholdingResolution = {
  /** Section 149, from the mapped salary certificate. */
  certificateTaxWithheld: number;
  /** Section 151 and any other deduction recorded in the ledger. */
  ledgerTaxWithheld: number;
  /** What the calculator should use. */
  taxWithheld: number;
  /**
   * Present when the same deduction may have been counted twice. The filing
   * still calculates — the figure is not silently altered — but the wizard
   * must surface this before the return is filed.
   */
  duplicateWarning: string | null;
};

const TAX_PAYMENT_CATEGORY = "TAX_PAYMENT";

/** Ledger categories arrive in mixed shapes ("Tax payment", "tax-payment"). */
export function normalizeLedgerCategory(category: string | null) {
  return (
    category?.toUpperCase().replaceAll(" ", "_").replaceAll("-", "_") ?? ""
  );
}

/**
 * Defensive against a missing description. `LedgerEntry.description` is a
 * required column, but a Prisma `select` that forgets the field hands this
 * function `undefined`, and an exception here would take down the whole
 * Calculate action over a cosmetic warning. An unnamed row simply cannot be
 * recognised as employer withholding, which is the safe direction: the
 * figures are unaffected either way.
 */
function normalizeDescription(description: string | null | undefined) {
  if (typeof description !== "string") {
    return "";
  }
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Narration that suggests an *employer* deduction rather than a bank one.
 * Section 151 language is listed separately so a bank's own withholding row,
 * which is never a duplicate of the certificate, does not raise the warning.
 */
const SALARY_WITHHOLDING_HINTS = [
  "salary tax",
  "tax on salary",
  "payroll tax",
  "income tax deduction",
  "employer tax",
  "149",
];

const BANK_WITHHOLDING_HINTS = [
  "151",
  "profit",
  "wht on profit",
  "withholding tax on profit",
];

export function looksLikeSalaryWithholding(
  description: string | null | undefined,
) {
  const normalized = normalizeDescription(description);
  if (BANK_WITHHOLDING_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }
  return SALARY_WITHHOLDING_HINTS.some((hint) => normalized.includes(hint));
}

function formatAmount(value: number) {
  return `PKR ${value.toLocaleString("en-US")}`;
}

/**
 * Resolves the withheld figure from its evidence every time it is asked for.
 *
 * The stored `FilingDraft.taxWithheld` column is *not* an input here. That
 * column is where the calculation writes its own answer, so consulting it
 * would make the result depend on how many times Calculate had been pressed:
 * the first run would include the bank's deduction and every run after it
 * would drop it. `storedTaxWithheld` is therefore used only when there is no
 * evidence at all, to preserve a figure an operator typed by hand.
 */
export function resolveTaxWithheld(input: {
  certificateTaxWithheld: number;
  entries: readonly WithholdingLedgerEntry[];
  storedTaxWithheld: number;
}): WithholdingResolution {
  const { certificateTaxWithheld, entries, storedTaxWithheld } = input;

  const taxRows = entries.filter(
    (entry) =>
      entry.entryType === "EXPENSE" &&
      normalizeLedgerCategory(entry.category) === TAX_PAYMENT_CATEGORY,
  );

  const ledgerTaxWithheld = taxRows.reduce(
    (total, entry) => total + toMoneyAmount(entry.amount),
    0,
  );

  if (certificateTaxWithheld === 0 && ledgerTaxWithheld === 0) {
    return {
      certificateTaxWithheld: 0,
      ledgerTaxWithheld: 0,
      taxWithheld: storedTaxWithheld,
      duplicateWarning: null,
    };
  }

  const taxWithheld = certificateTaxWithheld + ledgerTaxWithheld;

  // The warning is only meaningful when both sides carry a figure; a filing
  // with no certificate cannot be double-counting one.
  let duplicateWarning: string | null = null;
  if (certificateTaxWithheld > 0 && ledgerTaxWithheld > 0) {
    const suspects = taxRows.filter((entry) =>
      looksLikeSalaryWithholding(entry.description),
    );
    if (suspects.length > 0) {
      const suspectTotal = suspects.reduce(
        (total, entry) => total + toMoneyAmount(entry.amount),
        0,
      );
      const names = suspects
        .slice(0, 3)
        .map((entry) => (entry.description ?? "").trim())
        .join(", ");
      duplicateWarning =
        `The salary certificate reports ${formatAmount(certificateTaxWithheld)} of tax deducted, ` +
        `and the ledger also contains ${suspects.length} salary-tax row(s) totalling ${formatAmount(suspectTotal)} ` +
        `(${names}). If these are the same deduction it is being counted twice. ` +
        `Exclude the duplicate rows from the ledger before filing, or confirm they are separate payments.`;
    }
  }

  return {
    certificateTaxWithheld,
    ledgerTaxWithheld,
    taxWithheld,
    duplicateWarning,
  };
}

/**
 * Annual salary gross reported on the mapped salary certificate. Bank ledger
 * salary rows are cash movements; this is the source used for the salary tax
 * base and the IRIS salary income row.
 */
export function extractMappedSalaryGross(extractedData: string | null) {
  return extractSalaryCertificateAmounts(extractedData).grossSalary;
}

/**
 * Section 149 withholding reported on a MAPPED salary certificate. Moved here
 * from the tax-calculation action so packet approval can re-derive the same
 * duplicate warning the calculation saw, instead of trusting session state.
 */
export function extractMappedSalaryWithholding(extractedData: string | null) {
  return extractSalaryCertificateAmounts(extractedData).taxWithheld;
}

/**
 * Re-derives the salary-certificate/ledger duplicate warning for a draft from
 * current database state. Packet approval and the filing summary both call
 * this so the confirmation gate follows live data: a warning the user never
 * saw (page reload, ledger edited after calculation) still blocks approval,
 * and a warning cleared by removing the duplicate row releases it.
 *
 * The salaried-route check mirrors the tax-calculation action exactly: the
 * certificate is only consulted when salary is selected with the salary
 * subcategories, so a stale certificate cannot strand a non-salary filing.
 */
export async function getWithholdingDuplicateWarning(
  draftId: string,
  userId: string,
): Promise<string | null> {
  const [draft, selections, salaryCertificate, entries] = await Promise.all([
    prisma.filingDraft.findUnique({
      where: { id: draftId },
      select: { incomeSources: true, taxWithheld: true },
    }),
    prisma.filingIncomeSelection.findMany({
      where: { filingDraftId: draftId, userId },
      select: { source: true, subcategory: true },
    }),
    prisma.document.findFirst({
      where: {
        filingDraftId: draftId,
        userId,
        documentType: "salary_certificate",
        extractionStatus: "MAPPED",
      },
      select: { extractedData: true },
    }),
    prisma.ledgerEntry.findMany({
      where: { filingDraftId: draftId, userId },
      select: {
        entryType: true,
        category: true,
        amount: true,
        description: true,
      },
    }),
  ]);

  if (!draft) return null;

  let incomeSources: string[] = [];
  try {
    const parsed = JSON.parse(draft.incomeSources);
    incomeSources = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    incomeSources = [];
  }
  const salarySelected = selections
    .filter((selection) => selection.source === "salary")
    .map((selection) => selection.subcategory);
  const isSalariedRoute =
    incomeSources.includes("salary") &&
    salarySelected.length > 0 &&
    salarySelected.every(
      (subcategory) =>
        subcategory === "salary" || subcategory === "salary-surcharge",
    );

  const certificateTaxWithheld = isSalariedRoute
    ? (extractMappedSalaryWithholding(
        salaryCertificate?.extractedData ?? null,
      ) ?? 0)
    : 0;

  return resolveTaxWithheld({
    certificateTaxWithheld,
    entries,
    storedTaxWithheld: toMoneyAmount(draft.taxWithheld),
  }).duplicateWarning;
}
