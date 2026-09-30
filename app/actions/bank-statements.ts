"use server";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";
import { toMoneyNumber } from "@/lib/money";

export type BankStatementInput = {
  bankAccountId: string;
  periodStart?: string;
  periodEnd?: string;
  openingBalance: number;
  closingBalance: number;
  sourceDocumentId?: string;
};

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });

  if (!user) throw new Error("User profile not found");

  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: { id: true, userId: true, taxYear: true },
  });

  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

function parseDate(value?: string) {
  if (!value?.trim()) return null;
  const date = new Date(`${value.trim()}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Invalid statement date");
  }
  return date;
}

function validateStatement(
  taxYear: number,
  periodStart: Date | null,
  periodEnd: Date | null,
  currency: string | null | undefined,
) {
  return validateTaxYearStatement({
    taxYear,
    periodStart,
    periodEnd,
    currency,
  });
}

async function consolidateDuplicateBankStatements(draft: {
  id: string;
  userId: string;
}) {
  const statements = await prisma.bankStatement.findMany({
    where: { filingDraftId: draft.id, userId: draft.userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      bankAccountId: true,
    },
  });

  const keepByAccount = new Map<string, string>();
  const duplicateIds: string[] = [];

  for (const statement of statements) {
    // This filing workflow has one annual statement record per configured
    // account. Never deduplicate across account IDs; leave legacy unassigned
    // rows untouched until they are explicitly assigned.
    const key = statement.bankAccountId ?? `LEGACY:${statement.id}`;

    if (!keepByAccount.has(key)) {
      keepByAccount.set(key, statement.id);
    } else {
      duplicateIds.push(statement.id);
    }
  }

  if (duplicateIds.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const duplicateId of duplicateIds) {
      const duplicate = statements.find(
        (statement) => statement.id === duplicateId,
      );
      if (!duplicate) continue;

      if (!duplicate.bankAccountId) continue;
      const keepId = keepByAccount.get(duplicate.bankAccountId);
      if (!keepId) continue;

      await tx.bankTransaction.updateMany({
        where: {
          bankStatementId: duplicateId,
          OR: [
            { bankAccountId: duplicate.bankAccountId },
            { bankAccountId: null },
          ],
        },
        data: {
          bankStatementId: keepId,
          bankAccountId: duplicate.bankAccountId,
        },
      });

      await tx.bankStatement.delete({ where: { id: duplicateId } });
    }
  });
}

export async function getBankStatementAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    await consolidateDuplicateBankStatements(draft);
    const statements = await prisma.bankStatement.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { updatedAt: "desc" },
      include: {
        bankAccount: {
          select: { bankName: true, accountLabel: true },
        },
      },
    });

    const serializedStatements = statements.map((statement) => ({
      ...statement,
      periodStart: statement.periodStart?.toISOString().slice(0, 10) ?? "",
      periodEnd: statement.periodEnd?.toISOString().slice(0, 10) ?? "",
      // Balances are Decimal in the database; the client receives numbers.
      openingBalance: toMoneyNumber(statement.openingBalance),
      closingBalance: toMoneyNumber(statement.closingBalance),
    }));

    const invalidStatement = statements.find((statement) => {
      const validation = validateStatement(
        draft.taxYear,
        statement.periodStart,
        statement.periodEnd,
        statement.currency,
      );
      return !validation.valid;
    });

    if (invalidStatement) {
      const validation = validateStatement(
        draft.taxYear,
        invalidStatement.periodStart,
        invalidStatement.periodEnd,
        invalidStatement.currency,
      );
      return {
        success: false,
        error: validation.valid ? "Invalid bank statement" : validation.error,
        statement: null,
        statements: serializedStatements,
      };
    }

    return {
      success: true,
      statement: serializedStatements[0] ?? null,
      statements: serializedStatements,
    };
  } catch (error) {
    console.error("Error fetching bank statement:", error);
    return {
      success: false,
      error: "Failed to fetch bank statement",
      statement: null,
      statements: [],
    };
  }
}

export async function getAllBankStatementsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    await consolidateDuplicateBankStatements(draft);
    const statements = await prisma.bankStatement.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { updatedAt: "desc" },
      include: {
        bankAccount: {
          select: { bankName: true, accountLabel: true },
        },
      },
    });

    const invalidStatement = statements.find((statement) => {
      const validation = validateStatement(
        draft.taxYear,
        statement.periodStart,
        statement.periodEnd,
        statement.currency,
      );
      return !validation.valid;
    });

    const serialized = statements.map((statement) => ({
      ...statement,
      periodStart: statement.periodStart?.toISOString().slice(0, 10) ?? "",
      periodEnd: statement.periodEnd?.toISOString().slice(0, 10) ?? "",
      // Balances are Decimal in the database; the client receives numbers.
      openingBalance: toMoneyNumber(statement.openingBalance),
      closingBalance: toMoneyNumber(statement.closingBalance),
    }));

    if (invalidStatement) {
      const validation = validateStatement(
        draft.taxYear,
        invalidStatement.periodStart,
        invalidStatement.periodEnd,
        invalidStatement.currency,
      );
      return {
        success: false,
        error: validation.valid ? "Invalid bank statement" : validation.error,
        statements: serialized,
      };
    }

    return { success: true, statements: serialized };
  } catch (error) {
    console.error("Error fetching all bank statements:", error);
    return {
      success: false,
      error: "Failed to fetch bank statements",
      statements: [],
    };
  }
}

export async function saveBankStatementAction(
  draftId: string,
  input: BankStatementInput,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    await consolidateDuplicateBankStatements(draft);

    const bankAccountId = input.bankAccountId.trim();
    if (!bankAccountId) {
      return { success: false, error: "Select a bank account" };
    }

    const bankAccount = await prisma.bankAccount.findFirst({
      where: {
        id: bankAccountId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: {
        id: true,
        accountLabel: true,
        accountNumberMasked: true,
        currency: true,
      },
    });

    if (!bankAccount) {
      return {
        success: false,
        error: "Bank account not found for this filing",
      };
    }

    if (
      !Number.isFinite(input.openingBalance) ||
      !Number.isFinite(input.closingBalance)
    ) {
      return {
        success: false,
        error: "Opening and closing balances must be valid numbers",
      };
    }

    const periodStart = parseDate(input.periodStart);
    const periodEnd = parseDate(input.periodEnd);
    const currency = bankAccount.currency.trim().toUpperCase();
    const validation = validateStatement(
      draft.taxYear,
      periodStart,
      periodEnd,
      currency,
    );

    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const existing = await prisma.bankStatement.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId: bankAccount.id,
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, sourceDocumentId: true },
    });

    let sourceDocumentId = existing?.sourceDocumentId ?? null;
    if (input.sourceDocumentId) {
      const sourceDocument = await prisma.document.findFirst({
        where: {
          id: input.sourceDocumentId,
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "bank_statement",
          bankAccountId: bankAccount.id,
        },
        select: { id: true },
      });
      if (!sourceDocument) {
        return {
          success: false,
          error: "Statement document does not belong to the selected account",
        };
      }
      sourceDocumentId = sourceDocument.id;
    }

    const data = {
      accountLabel: bankAccount.accountLabel,
      accountNumberMasked: bankAccount.accountNumberMasked,
      currency,
      periodStart,
      periodEnd,
      openingBalance: input.openingBalance,
      closingBalance: input.closingBalance,
      sourceDocumentId,
      bankAccountId: bankAccount.id,
    };

    const statement = existing
      ? await prisma.bankStatement.update({ where: { id: existing.id }, data })
      : await prisma.bankStatement.create({
          data: {
            ...data,
            filingDraftId: draft.id,
            userId: draft.userId,
          },
        });

    // Only attach orphan rows already assigned to this exact account. Never
    // absorb filing-wide orphan transactions into whichever statement was
    // saved most recently.
    await prisma.bankTransaction.updateMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId: bankAccount.id,
        bankStatementId: null,
      },
      data: {
        bankStatementId: statement.id,
        bankAccountId: bankAccount.id,
      },
    });

    // Statement balance/period changes invalidate the previous Mizan
    // adjustment. It will be recreated as an OTHER entry after the user
    // recalculates and saves reconciliation.
    await prisma.ledgerEntry.deleteMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        source: "RECONCILIATION_AUTO_ADJUSTMENT",
      },
    });
    await prisma.filingDraft.update({
      where: { id: draft.id },
      data: {
        reconciliationStatus: "UNRESOLVED",
        reconciliationMethod: null,
        reconciliationNote: null,
        reconciliationGap: null,
        openingWealth: null,
        closingWealth: null,
        taxableIncome: null,
        taxPayable: null,
        refundDue: null,
        taxCalculationStatus: "NOT_CALCULATED",
        packetApprovalConfirmed: false,
        packetApprovalAt: null,
        packetApprovalByUserId: null,
        status: "IN_PROGRESS",
      },
    });

    await prisma.filingPacket.updateMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
      },
      data: {
        status: "SUPERSEDED",
        approvalStatus: "SUPERSEDED",
      },
    });

    await prisma.fbrConnection.updateMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      data: {
        status: "NOT_STARTED",
        agentId: null,
        message: null,
        errorMessage: null,
        lastHeartbeat: null,
        startedAt: null,
        completedAt: null,
      },
    });

    return { success: true, statementId: statement.id };
  } catch (error) {
    console.error("Error saving bank statement:", error);
    return { success: false, error: "Failed to save bank statement" };
  }
}
