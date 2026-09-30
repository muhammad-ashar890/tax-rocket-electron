import { toMoneyAmount, type MoneyInput } from "@/lib/money";

export type TransferCandidate = {
  id: string;
  bankAccountId: string | null;
  transactionDate: Date | null;
  description: string;
  // Accepts the Decimal the database now returns as well as a plain number.
  // Every read below goes through toMoneyAmount, so callers cannot forget.
  debit: MoneyInput;
  credit: MoneyInput;
};

const TRANSFER_KEYWORDS = [
  "internal transfer",
  "transfer from",
  "transfer to",
  "fund transfer",
  "funds transfer",
  "bank transfer",
  "interbank transfer",
  "inter bank transfer",
  "online transfer",
  "ibft",
  "raast transfer",
] as const;

export function normalizeBankDescription(description: string) {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bankDescriptionMatchesKeyword(
  normalized: string,
  keyword: string,
) {
  const normalizedKeyword = normalizeBankDescription(keyword);
  if (!normalizedKeyword) return false;

  if (normalizedKeyword.length <= 2) {
    return normalized.split(" ").includes(normalizedKeyword);
  }

  return normalized.includes(normalizedKeyword);
}

export function hasInternalTransferLanguage(description: string) {
  const normalized = normalizeBankDescription(description);
  return TRANSFER_KEYWORDS.some((keyword) =>
    bankDescriptionMatchesKeyword(normalized, keyword),
  );
}

/**
 * Finds exact evidence-based opposite sides of an internal transfer.
 *
 * A candidate must belong to another configured account, have the opposite
 * debit/credit direction, match the amount to the paisa, fall within three
 * days, and have transfer language on at least one side. The caller must
 * still require exactly one result before accepting a transfer decision.
 */
export function findLikelyInternalTransferPairs<T extends TransferCandidate>(
  transaction: TransferCandidate,
  candidates: T[],
) {
  if (!transaction.bankAccountId || !transaction.transactionDate) return [];

  const debit = toMoneyAmount(transaction.debit);
  const credit = toMoneyAmount(transaction.credit);
  const amount =
    debit > 0 && credit <= 0
      ? debit
      : credit > 0 && debit <= 0
        ? credit
        : 0;
  if (amount <= 0) return [];

  return candidates.filter((candidate) => {
    if (
      candidate.id === transaction.id ||
      !candidate.bankAccountId ||
      candidate.bankAccountId === transaction.bankAccountId ||
      !candidate.transactionDate
    ) {
      return false;
    }

    const candidateDebit = toMoneyAmount(candidate.debit);
    const candidateCredit = toMoneyAmount(candidate.credit);
    const hasOppositeSide =
      (debit > 0 &&
        credit <= 0 &&
        candidateCredit > 0 &&
        candidateDebit <= 0) ||
      (credit > 0 &&
        debit <= 0 &&
        candidateDebit > 0 &&
        candidateCredit <= 0);
    if (!hasOppositeSide) return false;

    const candidateAmount =
      candidateDebit > 0 ? candidateDebit : candidateCredit;
    if (Math.abs(candidateAmount - amount) > 0.01) return false;

    const dayDifference =
      Math.abs(
        candidate.transactionDate.getTime() -
          transaction.transactionDate!.getTime(),
      ) /
      (24 * 60 * 60 * 1000);

    return (
      dayDifference <= 3 &&
      (hasInternalTransferLanguage(transaction.description) ||
        hasInternalTransferLanguage(candidate.description))
    );
  });
}
