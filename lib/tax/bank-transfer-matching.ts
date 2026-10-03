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

  // Whole words only. A plain substring test matched "rent" inside "Parents"
  // and "Current", "tax" inside "Taxi", "total" inside "Subtotal". A trailing
  // plural ("rents", "taxes") still counts as the same word.
  const haystack = ` ${normalized} `;
  return [
    ` ${normalizedKeyword} `,
    ` ${normalizedKeyword}s `,
    ` ${normalizedKeyword}es `,
  ].some((needle) => haystack.includes(needle));
}

/**
 * Plain phrase search, used for transfer wording only. Bank narrations glue
 * channel codes to numbers ("IBFT12345"), so a whole-word test would miss them.
 */
export function bankDescriptionContainsPhrase(
  normalized: string,
  phrase: string,
) {
  const normalizedPhrase = normalizeBankDescription(phrase);
  return Boolean(normalizedPhrase) && normalized.includes(normalizedPhrase);
}

export function hasInternalTransferLanguage(description: string) {
  const normalized = normalizeBankDescription(description);
  return TRANSFER_KEYWORDS.some((keyword) =>
    bankDescriptionContainsPhrase(normalized, keyword),
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
    debit > 0 && credit <= 0 ? debit : credit > 0 && debit <= 0 ? credit : 0;
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
      (credit > 0 && debit <= 0 && candidateDebit > 0 && candidateCredit <= 0);
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

/**
 * A row whose narration reads like an own-account transfer and whose opposite
 * side sits in another owned account, but which is being booked as income or
 * an expense. Wording on BOTH sides is required, so an ordinary salary credit
 * that merely says "IBFT" next to an unrelated debit of the same amount is not
 * caught by this rule.
 */
export function isTransferLookalike(
  transaction: TransferCandidate,
  counterparts: TransferCandidate[],
) {
  return (
    hasInternalTransferLanguage(transaction.description) &&
    counterparts.some((counterpart) =>
      hasInternalTransferLanguage(counterpart.description),
    )
  );
}

/**
 * Pairs of rows that look like one internal transfer but were not both given
 * the Internal Transfer decision, where at least one side was approved into
 * the ledger as income, an expense, an asset or a liability. Booked that way
 * the money is counted as earned or spent, and because the two sides cancel in
 * the reconciliation gap nothing else would flag it.
 */
export function findTransferLookalikePairs<
  T extends TransferCandidate & { classificationStatus: string },
>(transactions: T[]) {
  const withWording = transactions.filter(
    (transaction) =>
      transaction.classificationStatus !== "TRANSFER" &&
      hasInternalTransferLanguage(transaction.description),
  );
  const seen = new Set<string>();
  const pairs: { first: T; second: T }[] = [];

  for (const transaction of withWording) {
    for (const counterpart of findLikelyInternalTransferPairs(
      transaction,
      withWording,
    )) {
      if (
        transaction.classificationStatus !== "APPROVED" &&
        counterpart.classificationStatus !== "APPROVED"
      ) {
        continue;
      }
      const key = [transaction.id, counterpart.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ first: transaction, second: counterpart });
    }
  }
  return pairs;
}
