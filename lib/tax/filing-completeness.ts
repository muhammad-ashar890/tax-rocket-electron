import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { findLikelyInternalTransferPairs } from "@/lib/tax/bank-transfer-matching";
import { getRequiredTaxDocumentTypesForCurrentFlow } from "@/lib/tax/document-requirements";
import type { TaxIncomeSource } from "@/lib/tax/filing-drafts";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";

const FINAL_TRANSACTION_STATUSES = new Set([
  "APPROVED",
  "REJECTED",
  "TRANSFER",
  "CASH_MOVEMENT",
]);

const READY_DOCUMENT_STATUSES = new Set(["COMPLETED", "MAPPED"]);
const DOCUMENT_TYPES_REQUIRING_MAPPING = new Set([
  "bank_statement",
  "salary_certificate",
]);

type FilingCompletenessInput = {
  draftId: string;
  userId: string;
};

type FilingCompletenessDatabase = Pick<
  PrismaClient,
  | "filingDraft"
  | "bankAccount"
  | "document"
  | "bankStatement"
  | "bankTransaction"
>;

export type FilingCompletenessResult = {
  success: boolean;
  blockers: string[];
};

function parseIncomeSources(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed.map(String) as TaxIncomeSource[])
      : [];
  } catch {
    return [];
  }
}

function accountName(account: { bankName: string; accountLabel: string }) {
  return `${account.bankName} — ${account.accountLabel}`;
}

function uniqueMessages(messages: string[]) {
  return Array.from(new Set(messages));
}

/**
 * Authoritative pre-filing integrity gate.
 *
 * This validates slot-based required documents and every configured bank
 * account from persisted rows. It deliberately does not trust wizard-local
 * completion flags. The same function is used by Bank Intelligence,
 * pre-packet approval, packet generation, final approval, and FBR start.
 */
export async function validateFilingCompleteness(
  input: FilingCompletenessInput,
  database: FilingCompletenessDatabase = prisma,
): Promise<FilingCompletenessResult> {
  const draft = await database.filingDraft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    select: { id: true, userId: true, taxYear: true, incomeSources: true },
  });

  if (!draft) {
    return { success: false, blockers: ["Filing draft not found"] };
  }

  const [accounts, documents, statements, transactions] = await Promise.all([
    database.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        bankName: true,
        accountLabel: true,
        currency: true,
      },
    }),
    database.document.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        documentType: true,
        bankAccountId: true,
        extractionStatus: true,
      },
    }),
    database.bankStatement.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        bankAccountId: true,
        sourceDocumentId: true,
        currency: true,
        periodStart: true,
        periodEnd: true,
      },
    }),
    database.bankTransaction.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      select: {
        id: true,
        bankAccountId: true,
        bankStatementId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
        classificationStatus: true,
      },
    }),
  ]);

  const blockers: string[] = [];
  const incomeSources = parseIncomeSources(draft.incomeSources);
  const requiredDocumentTypes = getRequiredTaxDocumentTypesForCurrentFlow({
    incomeSources,
  });

  // Non-bank requirements are keyed by their document type. Because rows are
  // newest-first, only assign a slot once; this avoids the historical bug
  // where Map construction silently let the oldest upload win.
  for (const documentType of requiredDocumentTypes) {
    if (documentType === "bank_statement") continue;

    const latestDocument = documents.find(
      (document) => document.documentType === documentType,
    );
    if (!latestDocument) {
      blockers.push(`Upload the required ${documentType} document`);
      continue;
    }

    const requiresMapping = DOCUMENT_TYPES_REQUIRING_MAPPING.has(documentType);
    const ready = requiresMapping
      ? latestDocument.extractionStatus === "MAPPED"
      : READY_DOCUMENT_STATUSES.has(latestDocument.extractionStatus);
    if (!ready) {
      blockers.push(
        `Review and approve/map the required ${documentType} document`,
      );
    }
  }

  if (requiredDocumentTypes.includes("bank_statement")) {
    if (accounts.length === 0) {
      blockers.push(
        "Configure at least one bank account and map its statement",
      );
    }

    const configuredAccountIds = new Set(accounts.map((account) => account.id));
    const statementByAccount = new Map<string, (typeof statements)[number]>();

    for (const account of accounts) {
      const label = accountName(account);
      if (account.currency.trim().toUpperCase() !== "PKR") {
        blockers.push(`${label}: bank account currency must be PKR`);
      }

      const accountDocuments = documents.filter(
        (document) =>
          document.documentType === "bank_statement" &&
          document.bankAccountId === account.id,
      );
      const accountStatements = statements.filter(
        (statement) => statement.bankAccountId === account.id,
      );

      if (accountDocuments.length === 0) {
        blockers.push(`${label}: upload and map a bank statement`);
      } else if (accountDocuments.length > 1) {
        blockers.push(
          `${label}: multiple current bank statement documents exist; replace them with one current mapped statement`,
        );
      }

      const currentDocument = accountDocuments[0];
      if (currentDocument && currentDocument.extractionStatus !== "MAPPED") {
        blockers.push(`${label}: bank statement document must be mapped`);
      }

      if (accountStatements.length === 0) {
        blockers.push(`${label}: save a valid bank statement record`);
        continue;
      }
      if (accountStatements.length > 1) {
        blockers.push(
          `${label}: multiple bank statement records exist; keep one current statement`,
        );
        continue;
      }

      const statement = accountStatements[0];
      statementByAccount.set(account.id, statement);

      if (
        !currentDocument ||
        statement.sourceDocumentId !== currentDocument.id
      ) {
        blockers.push(
          `${label}: saved statement must come from the current mapped account document`,
        );
      }

      const statementValidation = validateTaxYearStatement({
        taxYear: draft.taxYear,
        periodStart: statement.periodStart,
        periodEnd: statement.periodEnd,
        currency: statement.currency || account.currency,
      });
      if (!statementValidation.valid) {
        blockers.push(`${label}: ${statementValidation.error}`);
      }
    }

    // Legacy unassigned document rows do not satisfy an account slot, but are
    // ignored once every configured account has its own current document.
    // Orphan statement/transaction rows are still unsafe because they feed
    // balances and ledgers, so those must block progression.
    const invalidStatement = statements.find(
      (statement) =>
        !statement.bankAccountId ||
        !configuredAccountIds.has(statement.bankAccountId),
    );
    if (invalidStatement) {
      blockers.push(
        "Every bank statement record must belong to a configured account",
      );
    }

    const incorrectlyLinkedTransaction = transactions.find((transaction) => {
      if (
        !transaction.bankAccountId ||
        !configuredAccountIds.has(transaction.bankAccountId)
      ) {
        return true;
      }
      const statement = statementByAccount.get(transaction.bankAccountId);
      return !statement || transaction.bankStatementId !== statement.id;
    });
    if (incorrectlyLinkedTransaction) {
      blockers.push(
        "Every bank transaction must be linked to its configured account's current statement",
      );
    }
  }

  if (
    transactions.some(
      (transaction) =>
        !FINAL_TRANSACTION_STATUSES.has(transaction.classificationStatus),
    )
  ) {
    blockers.push("Review every bank transaction before approval or filing");
  }

  for (const transaction of transactions) {
    if (transaction.classificationStatus !== "TRANSFER") continue;

    const counterparts = findLikelyInternalTransferPairs(
      transaction,
      transactions,
    );
    if (counterparts.length === 0) {
      blockers.push(
        `Internal transfer has no matching opposite account entry: ${transaction.description}`,
      );
      continue;
    }
    if (counterparts.length > 1) {
      blockers.push(
        `Internal transfer has multiple possible matches and needs manual review: ${transaction.description}`,
      );
      continue;
    }
    if (counterparts[0].classificationStatus !== "TRANSFER") {
      blockers.push(
        "Both sides of an internal transfer must have the Internal Transfer decision",
      );
    }
  }

  const uniqueBlockers = uniqueMessages(blockers);
  return {
    success: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
  };
}
