import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import {
  netMoney,
  sumMoney,
  toMoneyAmount,
  type MoneyInput,
  toMoneyNumber,
  toMoneyNumberOrNull,
} from "@/lib/money";

type ReconciliationDatabase = Pick<
  PrismaClient,
  | "filingDraft"
  | "bankAccount"
  | "document"
  | "bankStatement"
  | "bankTransaction"
  | "ledgerEntry"
>;

type ReconciliationCalculationInput = {
  draftId: string;
  userId: string;
};

export type AuthoritativeReconciliationPreview = {
  revision: string;
  accountBalances: Array<{
    bankAccountId: string;
    bankName: string;
    accountLabel: string;
    openingBalance: number;
    closingBalance: number;
  }>;
  openingWealth: number;
  closingWealth: number;
  totalIncome: number;
  totalExpenses: number;
  totalAssets: number;
  totalLiabilities: number;
  otherAdjustments: number;
  gap: number;
};

export type AuthoritativeReconciliationResult =
  | { success: true; preview: AuthoritativeReconciliationPreview }
  | { success: false; blockers: string[] };

function isoDate(value: Date | null) {
  return value?.toISOString() ?? null;
}

/**
 * Calculates Mizan exclusively from persisted, account-complete source rows.
 *
 * Callers may pass a Prisma transaction client so completeness validation,
 * revision checking, calculation, and persistence share one database snapshot.
 * Auto-generated reconciliation entries are excluded because they are derived
 * outputs rather than source wealth movement.
 */
export async function calculateAuthoritativeReconciliation(
  input: ReconciliationCalculationInput,
  database: ReconciliationDatabase = prisma,
): Promise<AuthoritativeReconciliationResult> {
  const completeness = await validateFilingCompleteness(input, database);
  if (!completeness.success) {
    return { success: false, blockers: completeness.blockers };
  }

  const draft = await database.filingDraft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    select: { id: true, userId: true, taxYear: true },
  });
  if (!draft) {
    return { success: false, blockers: ["Filing draft not found"] };
  }

  const [accounts, transactions, ledgerEntries] = await Promise.all([
    database.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        bankName: true,
        accountLabel: true,
        currency: true,
        statements: {
          where: { filingDraftId: draft.id, userId: draft.userId },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            sourceDocumentId: true,
            openingBalance: true,
            closingBalance: true,
            currency: true,
            periodStart: true,
            periodEnd: true,
          },
        },
      },
    }),
    database.bankTransaction.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        bankAccountId: true,
        bankStatementId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
        balance: true,
        sourceDocumentId: true,
        classificationStatus: true,
        suggestedEntryType: true,
        suggestedCategory: true,
      },
    }),
    database.ledgerEntry.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        source: { not: "RECONCILIATION_AUTO_ADJUSTMENT" },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        entryDate: true,
        entryType: true,
        category: true,
        description: true,
        amount: true,
        source: true,
        sourceDocumentId: true,
        sourceTransactionId: true,
        bankAccountId: true,
      },
    }),
  ]);

  const accountWithoutExactlyOneStatement = accounts.find(
    (account) => account.statements.length !== 1,
  );
  if (accountWithoutExactlyOneStatement) {
    return {
      success: false,
      blockers: [
        `${accountWithoutExactlyOneStatement.bankName} — ${accountWithoutExactlyOneStatement.accountLabel}: exactly one current statement is required for Mizan`,
      ],
    };
  }

  // Balances are stored as Decimal. They are converted once here, at the edge
  // of the calculation, so every total below stays ordinary number arithmetic.
  // Leaving them as Decimal would make `total + balance` concatenate strings
  // rather than add, which TypeScript cannot always catch.
  const accountBalances = accounts.map((account) => {
    const statement = account.statements[0];
    return {
      bankAccountId: account.id,
      bankName: account.bankName,
      accountLabel: account.accountLabel,
      openingBalance: toMoneyNumber(statement.openingBalance),
      closingBalance: toMoneyNumber(statement.closingBalance),
    };
  });

  // Every total below is summed in Decimal and converted once at the end.
  //
  // Adding these with `+` would be wrong twice over. On a Decimal column the
  // operator concatenates rather than adds, producing a string of joined
  // digits that TypeScript accepts. And even after converting each value to a
  // number, floating point leaves a residue: the figures that should cancel
  // to a zero gap settle around 1e-10 instead, which is the entire reason the
  // 0.01 tolerances exist further down the filing.
  const sumEntries = (entryType: string) =>
    sumMoney(
      ledgerEntries
        .filter((entry) => entry.entryType === entryType)
        .map((entry) => entry.amount),
    );

  const openingWealth = sumMoney(
    accountBalances.map((account) => account.openingBalance),
  );
  const closingWealth = sumMoney(
    accountBalances.map((account) => account.closingBalance),
  );
  const totalIncome = sumEntries("INCOME");
  const totalExpenses = sumEntries("EXPENSE");
  const totalAssets = sumEntries("ASSET");
  const totalLiabilities = sumEntries("LIABILITY");
  const otherAdjustments = netMoney(
    ledgerEntries
      .filter(
        (entry) =>
          entry.entryType === "OTHER" &&
          (entry.category === "RECONCILIATION_ADJUSTMENT_INFLOW" ||
            entry.category === "RECONCILIATION_ADJUSTMENT_OUTFLOW"),
      )
      .map((entry) => ({
        value: entry.amount,
        subtract:
          entry.category === "RECONCILIATION_ADJUSTMENT_OUTFLOW",
      })),
  );
  // Money columns are Decimal in the database, and `total + decimal`
  // concatenates instead of adding: three balances reduce to the string
  // "01000000.12000000.23000000.3" rather than 6000000.60. TypeScript cannot
  // always see it (a cast, an `any`, or an untyped join is enough to hide it),
  // and the resulting figure would flow straight into the reconciliation gap.
  //
  // So every total is checked here, at the one place they all pass through.
  // A non-finite value means a conversion was missed upstream.
  const componentTotals = {
    openingWealth,
    closingWealth,
    totalIncome,
    totalExpenses,
    totalAssets,
    totalLiabilities,
    otherAdjustments,
  };
  for (const [name, value] of Object.entries(componentTotals)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Reconciliation total "${name}" is not a finite number (received ${typeof value}: ${String(value)}). ` +
          `A Decimal money column was summed without being converted first.`,
      );
    }
  }

  // The final combination is done in Decimal as well. Each total above is
  // already exact, but adding and subtracting them as numbers reintroduces
  // the drift: a filing whose books balance perfectly settles at roughly
  // 1e-10 instead of 0, which is what the 0.01 tolerances downstream were
  // added to absorb.
  const wealthMovement = netMoney([
    { value: totalIncome },
    { value: totalLiabilities },
    { value: totalExpenses, subtract: true },
    { value: totalAssets, subtract: true },
    { value: otherAdjustments },
  ]);
  const gap = netMoney([
    { value: closingWealth },
    { value: openingWealth, subtract: true },
    { value: wealthMovement, subtract: true },
  ]);

  // This payload is hashed into the `revision` fingerprint that detects
  // whether the filing changed between previewing and confirming Mizan.
  //
  // Every money value in it is converted to a number first, so the hash
  // depends on the AMOUNTS rather than on how Prisma happens to represent
  // them. A Decimal serialises as a quoted string ("5000") where a number
  // serialises bare (5000), so mixing the two makes the fingerprint depend on
  // the column type: changing a column from Float to Decimal, or reading the
  // same figure through a different query, would produce a different hash for
  // identical data and reject the user's confirmation as "inputs changed".
  const revisionPayload = {
    taxYear: draft.taxYear,
    accounts: accounts.map((account) => {
      const statement = account.statements[0];
      return {
        id: account.id,
        bankName: account.bankName,
        accountLabel: account.accountLabel,
        currency: account.currency,
        statement: {
          id: statement.id,
          sourceDocumentId: statement.sourceDocumentId,
          openingBalance: toMoneyNumber(statement.openingBalance),
          closingBalance: toMoneyNumber(statement.closingBalance),
          currency: statement.currency,
          periodStart: isoDate(statement.periodStart),
          periodEnd: isoDate(statement.periodEnd),
        },
      };
    }),
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      bankAccountId: transaction.bankAccountId,
      bankStatementId: transaction.bankStatementId,
      transactionDate: isoDate(transaction.transactionDate),
      description: transaction.description,
      // Decimal is not JSON-serialisable as a number; it would reach the
      // browser as a string. Converted here, at the boundary.
      debit: toMoneyNumberOrNull(transaction.debit),
      credit: toMoneyNumberOrNull(transaction.credit),
      balance: toMoneyNumberOrNull(transaction.balance),
      sourceDocumentId: transaction.sourceDocumentId,
      classificationStatus: transaction.classificationStatus,
      suggestedEntryType: transaction.suggestedEntryType,
      suggestedCategory: transaction.suggestedCategory,
    })),
    ledgerEntries: ledgerEntries.map((entry) => ({
      id: entry.id,
      entryDate: isoDate(entry.entryDate),
      entryType: entry.entryType,
      category: entry.category,
      description: entry.description,
      amount: toMoneyNumber(entry.amount),
      source: entry.source,
      sourceDocumentId: entry.sourceDocumentId,
      sourceTransactionId: entry.sourceTransactionId,
      bankAccountId: entry.bankAccountId,
    })),
  };
  const revision = createHash("sha256")
    .update(JSON.stringify(revisionPayload))
    .digest("hex");

  return {
    success: true,
    preview: {
      revision,
      accountBalances,
      openingWealth,
      closingWealth,
      totalIncome,
      totalExpenses,
      totalAssets,
      totalLiabilities,
      otherAdjustments,
      gap,
    },
  };
}

export type AuthoritativeReconciliationValidation =
  | { success: true; preview: AuthoritativeReconciliationPreview }
  | { success: false; blockers: string[] };

/**
 * Verifies that the persisted reconciliation still represents the current
 * authoritative base calculation. Final tax/approval/packet/FBR actions use
 * this to prevent a stale stored `RESOLVED` flag from bypassing Mizan.
 */
export async function validateAuthoritativeReconciliation(
  input: ReconciliationCalculationInput,
  database: ReconciliationDatabase = prisma,
): Promise<AuthoritativeReconciliationValidation> {
  const calculation = await calculateAuthoritativeReconciliation(
    input,
    database,
  );
  if (!calculation.success) return calculation;

  const [record, autoAdjustments] = await Promise.all([
    database.filingDraft.findFirst({
      where: { id: input.draftId, userId: input.userId },
      select: {
        reconciliationStatus: true,
        reconciliationMethod: true,
        reconciliationGap: true,
        openingWealth: true,
        closingWealth: true,
      },
    }),
    database.ledgerEntry.findMany({
      where: {
        filingDraftId: input.draftId,
        userId: input.userId,
        source: "RECONCILIATION_AUTO_ADJUSTMENT",
      },
      select: { amount: true, category: true },
    }),
  ]);

  if (
    !record ||
    record.reconciliationStatus !== "RESOLVED" ||
    !record.reconciliationMethod
  ) {
    return {
      success: false,
      blockers: ["Resolve wealth reconciliation using the latest Mizan inputs"],
    };
  }

  const preview = calculation.preview;
  // Stored figures must equal the freshly calculated ones exactly.
  //
  // This used to allow a 0.01 difference, because both sides were computed in
  // floating point and identical inputs could still disagree in the last few
  // digits. Both are Decimal now and summed exactly, so identical inputs give
  // identical results and any real difference means the filing changed after
  // it was reconciled -- which is precisely what this check exists to catch.
  const amountsMatch = (stored: MoneyInput, current: number) =>
    stored !== null &&
    stored !== undefined &&
    toMoneyAmount(stored) === current;
  if (
    !amountsMatch(record.openingWealth, preview.openingWealth) ||
    !amountsMatch(record.closingWealth, preview.closingWealth)
  ) {
    return {
      success: false,
      blockers: [
        "Bank balances changed after Mizan was resolved; recalculate reconciliation",
      ],
    };
  }

  // The gap is exact now, so it is used as-is. Rounding anything under a
  // paisa down to zero would silently accept books that do not balance.
  const serverGap = preview.gap;
  if (record.reconciliationMethod === "auto") {
    const expectedAmount = Math.abs(serverGap);
    const expectedCategory =
      serverGap >= 0
        ? "RECONCILIATION_ADJUSTMENT_INFLOW"
        : "RECONCILIATION_ADJUSTMENT_OUTFLOW";
    const adjustmentMatches =
      expectedAmount === 0
        ? autoAdjustments.length === 0
        : autoAdjustments.length === 1 &&
          toMoneyAmount(autoAdjustments[0].amount) === expectedAmount &&
          autoAdjustments[0].category === expectedCategory;

    if (!amountsMatch(record.reconciliationGap, 0) || !adjustmentMatches) {
      return {
        success: false,
        blockers: [
          "The saved Mizan auto-adjustment is stale; recalculate reconciliation",
        ],
      };
    }
  } else if (record.reconciliationMethod === "manual") {
    if (
      autoAdjustments.length > 0 ||
      !amountsMatch(record.reconciliationGap, serverGap)
    ) {
      return {
        success: false,
        blockers: [
          "The saved manual Mizan result is stale; recalculate reconciliation",
        ],
      };
    }
  } else {
    return {
      success: false,
      blockers: ["Select a valid Mizan reconciliation method"],
    };
  }

  return { success: true, preview };
}
