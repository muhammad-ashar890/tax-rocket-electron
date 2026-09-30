"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServerSession } from "next-auth/next";

import { createNotification } from "@/app/actions/notifications";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  bankDescriptionMatchesKeyword as matchesKeyword,
  findLikelyInternalTransferPairs,
  hasInternalTransferLanguage as hasTransferLanguage,
  normalizeBankDescription as normalizeDescription,
  type TransferCandidate,
} from "@/lib/tax/bank-transfer-matching";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";
import { toMoneyAmount, toMoneyNumber, type MoneyInput, toMoneyNumberOrNull } from "@/lib/money";

const CLASSIFICATION_RULES = [
  {
    keywords: ["tax", "withholding", "fbr", "fed", "federal excise"],
    entryType: "EXPENSE",
    category: "TAX_PAYMENT",
    confidence: 0.9,
  },
  {
    keywords: [
      "bank profit",
      "profit credited",
      "profit payment",
      "profit on savings deposit",
      "profit on deposit",
      "savings profit",
      "savings account profit",
      "interest credited",
      "interest income",
      "deposit profit",
      "profit on debt",
      "markup",
    ],
    entryType: "INCOME",
    category: "BANK_PROFIT",
    confidence: 0.88,
  },
  {
    keywords: [
      "bank charge",
      "bank charges",
      "bank fee",
      "bank fees",
      "service charge",
      "annual fee",
      "account maintenance",
      "maintenance fee",
    ],
    entryType: "EXPENSE",
    category: "BANK_CHARGES",
    confidence: 0.92,
  },
  {
    keywords: ["rent received", "rental income", "rent credited"],
    entryType: "INCOME",
    category: "PROPERTY_RENT",
    confidence: 0.92,
  },
  {
    keywords: [
      "rent",
      "k-electric",
      "k electric",
      "electricity",
      "gas bill",
      "utility",
      " ke ",
    ],
    entryType: "EXPENSE",
    category: "UTILITIES_OR_RENT",
    confidence: 0.9,
  },
  {
    keywords: ["fuel", "petrol", "pso", "psos", "shell", "total"],
    entryType: "EXPENSE",
    category: "TRANSPORT",
    confidence: 0.88,
  },
  {
    keywords: ["salary", "payroll", "wages", "compensation"],
    entryType: "INCOME",
    category: "SALARY",
    confidence: 0.95,
  },
  {
    keywords: [
      "grocery",
      "groceries",
      "mart",
      "superstore",
      "restaurant",
      "food",
    ],
    entryType: "EXPENSE",
    category: "PERSONAL_EXPENSE",
    confidence: 0.8,
  },
] as const;

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
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

async function invalidateDerivedFilingState(draft: {
  id: string;
  userId: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.ledgerEntry.deleteMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        source: "RECONCILIATION_AUTO_ADJUSTMENT",
      },
    });

    await tx.filingDraft.update({
      where: { id: draft.id },
      data: {
        reconciliationStatus: "UNRESOLVED",
        reconciliationMethod: null,
        reconciliationNote: null,
        reconciliationGap: null,
        openingWealth: null,
        closingWealth: null,
        taxableIncome: null,
        taxWithheld: null,
        taxPayable: null,
        refundDue: null,
        taxCalculationStatus: "NOT_CALCULATED",
        status: "IN_PROGRESS",
      },
    });

    await tx.filingPacket.updateMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
      },
      data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
    });

    await tx.fbrConnection.updateMany({
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
  });
}

function classifyDescription(description: string) {
  const normalized = normalizeDescription(description);

  // Cash deposits/withdrawals are movements, not automatically income or
  // expenses. Surface them for an explicit cash decision before merchant or
  // payroll keywords can override that safer interpretation.
  if (
    normalized.includes("cash withdrawal") ||
    normalized.includes("cash deposit") ||
    normalized.includes("atm withdrawal") ||
    normalized.includes("atm cash") ||
    normalized.includes("visa atm") ||
    normalized.includes("counter cash")
  ) {
    return {
      status: "POTENTIAL_CASH_MOVEMENT",
      entryType: null,
      category: "CASH_MOVEMENT",
      confidence: 0.85,
    };
  }

  // Transfer language must win over words such as "salary" in an account
  // label. "Transfer from HBL Salary Account" is a reviewable transfer, not
  // earned salary merely because the source account contains that word.
  if (hasTransferLanguage(description)) {
    return {
      status: "POTENTIAL_TRANSFER",
      entryType: null,
      category: "INTERNAL_TRANSFER",
      confidence: 0.8,
    };
  }

  const rule = CLASSIFICATION_RULES.find((candidate) =>
    candidate.keywords.some((keyword) => matchesKeyword(normalized, keyword)),
  );

  if (!rule) {
    return {
      status: "UNREVIEWED",
      entryType: null,
      category: null,
      confidence: 0,
    };
  }

  return {
    status: "SUGGESTED",
    entryType: rule.entryType,
    category: rule.category,
    confidence: rule.confidence,
  };
}

function hasLikelyInternalTransferPair(
  transaction: TransferCandidate,
  candidates: TransferCandidate[],
) {
  return findLikelyInternalTransferPairs(transaction, candidates).length > 0;
}

type TransferDecisionCandidate = TransferCandidate & {
  classificationStatus: string;
  suggestedEntryType: string | null;
  suggestedCategory: string | null;
};

async function getTransferCounterparts(
  draft: { id: string; userId: string },
  transaction: TransferCandidate,
) {
  const candidates = await prisma.bankTransaction.findMany({
    where: {
      filingDraftId: draft.id,
      userId: draft.userId,
      id: { not: transaction.id },
      bankAccountId: { not: null },
    },
    select: {
      id: true,
      bankAccountId: true,
      transactionDate: true,
      description: true,
      debit: true,
      credit: true,
      classificationStatus: true,
      suggestedEntryType: true,
      suggestedCategory: true,
    },
  });

  return findLikelyInternalTransferPairs<TransferDecisionCandidate>(
    transaction,
    candidates,
  );
}

function reviewedStatusForUndo(transaction: {
  suggestedEntryType: string | null;
  suggestedCategory: string | null;
}) {
  return transaction.suggestedEntryType && transaction.suggestedCategory
    ? "SUGGESTED"
    : "UNREVIEWED";
}

function classifyTransaction(
  transaction: TransferCandidate,
  transferCandidates: TransferCandidate[],
) {
  const normalized = normalizeDescription(transaction.description);

  if (hasLikelyInternalTransferPair(transaction, transferCandidates)) {
    return {
      status: "POTENTIAL_TRANSFER",
      entryType: null,
      category: "INTERNAL_TRANSFER",
      confidence: 0.98,
    };
  }

  const descriptionSuggestion = classifyDescription(transaction.description);

  if (descriptionSuggestion.status !== "UNREVIEWED") {
    return descriptionSuggestion;
  }

  // Both sides are converted before being compared. `Decimal(0)` is truthy,
  // so the previous `!(transaction.debit ?? 0)` form evaluated to false on a
  // zero Decimal and left every transaction unclassified in both directions.
  const debitAmount = toMoneyAmount(transaction.debit);
  const creditAmount = toMoneyAmount(transaction.credit);

  const hasCredit = creditAmount > 0 && debitAmount === 0;
  const hasDebit = debitAmount > 0 && creditAmount === 0;

  if (
    hasCredit &&
    [
      "loan",
      "financing",
      "credit facility",
      "loan proceeds",
      "loan disbursement",
    ].some((keyword) => matchesKeyword(normalized, keyword))
  ) {
    return {
      status: "POTENTIAL_LIABILITY",
      entryType: "LIABILITY",
      category: "LOAN_PROCEEDS",
      confidence: 0.7,
    };
  }

  if (
    hasDebit &&
    [
      "car purchase",
      "vehicle purchase",
      "property purchase",
      "land purchase",
      "equipment purchase",
      "laptop purchase",
      "machinery purchase",
    ].some((keyword) => matchesKeyword(normalized, keyword))
  ) {
    return {
      status: "POTENTIAL_ASSET",
      entryType: "ASSET",
      category: "ASSET_PURCHASE",
      confidence: 0.7,
    };
  }

  // A generic incoming credit is not automatically taxable income. Surface it
  // as a potential-income decision so the user can choose income, internal
  // transfer, or exclusion explicitly.
  if (hasCredit) {
    return {
      status: "POTENTIAL_INCOME",
      entryType: "INCOME",
      category: "POTENTIAL_INCOME",
      confidence: 0.55,
    };
  }

  return descriptionSuggestion;
}

type GeminiClassification = {
  transactionId: string;
  classification:
    | "income"
    | "expense"
    | "asset"
    | "liability"
    | "internal_transfer"
    | "cash_movement"
    | "unknown";
  category?: string;
  confidence?: number;
  reason?: string;
};

function maskSensitiveDescription(description: string) {
  return description.slice(0, 240).replace(/\b\d{8,}\b/g, "[redacted]");
}

function parseGeminiClassifications(text: string) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as GeminiClassification[];
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      return JSON.parse(
        cleaned.slice(start, end + 1),
      ) as GeminiClassification[];
    } catch {
      return [];
    }
  }
}

type OwnedAccountContext = {
  id: string;
  bankName: string;
  accountLabel: string;
  accountNumberMasked: string | null;
};

function safeMaskedAccountNumber(value: string | null) {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  const suffix = compact.slice(-4);
  return suffix ? `****${suffix}` : null;
}

/**
 * Rows sent to Gemini in a single request.
 *
 * This is a prompt-size limit, NOT a limit on how much of a statement gets
 * classified. A very long prompt is truncated or refused by the model, so the
 * work is split into chunks of this size and every chunk is sent. A full tax
 * year of transactions is classified in full.
 */
const GEMINI_CLASSIFICATION_CHUNK_SIZE = 100;

/**
 * How many chunks are sent in parallel. Keeps a large statement fast without
 * opening hundreds of simultaneous connections to the model.
 */
const GEMINI_CLASSIFICATION_CONCURRENCY = 3;

/**
 * Per-user budget on chunks, over a ten minute window.
 *
 * Sized so that a legitimate run is never blocked: one full tax year of bank
 * activity is on the order of a few thousand rows, of which only the ambiguous
 * ones reach Gemini. At 100 rows per chunk this budget covers 12,000 ambiguous
 * rows every ten minutes, which is several complete statements. It exists to
 * stop a runaway loop or a scripted abuse of a paid endpoint, not to ration
 * normal use.
 */
const GEMINI_CLASSIFICATION_CHUNK_BUDGET = 120;
const GEMINI_CLASSIFICATION_WINDOW_MS = 10 * 60 * 1000;

type ClassifiableTransaction = {
  id: string;
  bankAccountId: string | null;
  transactionDate: Date | null;
  description: string;
  debit: MoneyInput;
  credit: MoneyInput;
  balance: MoneyInput;
};

async function classifyChunkWithGemini(
  batch: ClassifiableTransaction[],
  ownedAccounts: OwnedAccountContext[],
  apiKey: string,
) {
  try {
    const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
    });
    const prompt = `You are reviewing ambiguous Pakistani bank transactions for a tax ledger.
Return only a JSON array. Do not invent facts.
For each row choose exactly one classification:
- income: only when the description strongly indicates earned income
- expense: only when the description strongly indicates a personal/business expense
- asset: an identifiable asset purchase
- liability: loan/financing proceeds
- internal_transfer: likely movement between the taxpayer's own accounts
- cash_movement: ATM/cash movement that is not automatically an expense
- unknown: insufficient evidence
Generic credits must not be automatically treated as income unless evidence supports it.
A description such as "transfer from HBL Salary Account" refers to an account, not necessarily salary income.
Use the owned-account context below to identify likely movements between the taxpayer's own accounts.
Each item must have this shape:
{"transactionId":"string","classification":"income|expense|asset|liability|internal_transfer|cash_movement|unknown","category":"string","confidence":0.0,"reason":"short explanation"}

Owned accounts (masked):
${JSON.stringify(
  ownedAccounts.map((account) => ({
    bankName: account.bankName,
    accountLabel: account.accountLabel,
    accountNumberMasked: safeMaskedAccountNumber(account.accountNumberMasked),
  })),
)}

Rows:
${JSON.stringify(
  batch.map((transaction) => {
    const account = ownedAccounts.find(
      (candidate) => candidate.id === transaction.bankAccountId,
    );
    return {
      transactionId: transaction.id,
      account: account
        ? {
            bankName: account.bankName,
            accountLabel: account.accountLabel,
            accountNumberMasked: safeMaskedAccountNumber(
              account.accountNumberMasked,
            ),
          }
        : null,
      date: transaction.transactionDate?.toISOString().slice(0, 10) ?? null,
      description: maskSensitiveDescription(transaction.description),
      // Decimal is not JSON-serialisable as a number; it would reach the
      // browser as a string. Converted here, at the boundary.
      debit: toMoneyNumberOrNull(transaction.debit),
      credit: toMoneyNumberOrNull(transaction.credit),
      balance: toMoneyNumberOrNull(transaction.balance),
    };
  }),
)}`;

    const result = await model.generateContent([{ text: prompt }]);
    const parsed = parseGeminiClassifications(result.response.text());
    return new Map(
      parsed
        .filter((item) => item && typeof item.transactionId === "string")
        .map((item) => [item.transactionId, item]),
    );
  } catch (error) {
    // One failed chunk must not lose the chunks that succeeded. The rows in
    // this chunk simply keep their rule-based suggestion.
    console.error("Gemini bank classification chunk failed:", error);
    return new Map<string, GeminiClassification>();
  }
}

/**
 * Classifies every ambiguous transaction, splitting the work into
 * prompt-sized chunks rather than discarding the overflow.
 */
async function classifyAmbiguousTransactionsWithGemini(
  transactions: ClassifiableTransaction[],
  ownedAccounts: OwnedAccountContext[],
  userId: string,
) {
  const merged = new Map<string, GeminiClassification>();

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || transactions.length === 0) return merged;

  const chunks: ClassifiableTransaction[][] = [];
  for (
    let index = 0;
    index < transactions.length;
    index += GEMINI_CLASSIFICATION_CHUNK_SIZE
  ) {
    chunks.push(
      transactions.slice(index, index + GEMINI_CLASSIFICATION_CHUNK_SIZE),
    );
  }

  for (
    let cursor = 0;
    cursor < chunks.length;
    cursor += GEMINI_CLASSIFICATION_CONCURRENCY
  ) {
    const wave = chunks.slice(
      cursor,
      cursor + GEMINI_CLASSIFICATION_CONCURRENCY,
    );

    // The budget is charged per chunk, so cost tracks actual model usage
    // rather than the number of times the user pressed the button. Running
    // out is not an error: classification is an assist over the rule-based
    // result, so remaining rows keep that result and the user still sees a
    // fully classified statement.
    const affordable: ClassifiableTransaction[][] = [];
    for (const chunk of wave) {
      const budget = consumeRateLimit(
        `gemini-classification:${userId}`,
        GEMINI_CLASSIFICATION_CHUNK_BUDGET,
        GEMINI_CLASSIFICATION_WINDOW_MS,
      );
      if (!budget.allowed) break;
      affordable.push(chunk);
    }

    if (affordable.length === 0) {
      console.warn(
        `Gemini classification budget exhausted for user ${userId}; ${
          chunks.length - cursor
        } chunk(s) fall back to rule-based classification.`,
      );
      break;
    }

    const results = await Promise.all(
      affordable.map((chunk) =>
        classifyChunkWithGemini(chunk, ownedAccounts, apiKey),
      ),
    );
    for (const result of results) {
      for (const [id, classification] of result) merged.set(id, classification);
    }

    if (affordable.length < wave.length) break;
  }

  return merged;
}

function applyGeminiClassification(
  suggestion: GeminiClassification | undefined,
) {
  if (!suggestion || suggestion.classification === "unknown") {
    return {
      status: "UNREVIEWED",
      entryType: null,
      category: null,
      confidence: 0,
    };
  }

  const category = suggestion.category?.trim().toUpperCase() || "AI_REVIEW";
  const confidence = Math.max(0, Math.min(1, suggestion.confidence ?? 0.5));

  if (suggestion.classification === "income") {
    return {
      status: "POTENTIAL_INCOME",
      entryType: "INCOME",
      category,
      confidence,
    };
  }
  if (suggestion.classification === "asset") {
    return {
      status: "POTENTIAL_ASSET",
      entryType: "ASSET",
      category,
      confidence,
    };
  }
  if (suggestion.classification === "liability") {
    return {
      status: "POTENTIAL_LIABILITY",
      entryType: "LIABILITY",
      category,
      confidence,
    };
  }
  if (suggestion.classification === "internal_transfer") {
    return {
      status: "POTENTIAL_TRANSFER",
      entryType: null,
      category: "INTERNAL_TRANSFER",
      confidence,
    };
  }
  if (suggestion.classification === "cash_movement") {
    return {
      status: "POTENTIAL_CASH_MOVEMENT",
      entryType: null,
      category: "CASH_MOVEMENT",
      confidence,
    };
  }

  return {
    status: "UNREVIEWED",
    entryType: null,
    category: null,
    confidence: 0,
  };
}

export type ClassificationStatementInput = Readonly<{
  bankAccountId: string;
  openingBalance: number;
  closingBalance: number;
  periodStart: string;
  periodEnd: string;
}>;

export async function classifyBankTransactionsAction(
  draftId: string,
  statementInput: ClassificationStatementInput,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const bankAccountId = statementInput.bankAccountId.trim();
    const statement = await prisma.bankStatement.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId,
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        bankAccountId: true,
        currency: true,
        openingBalance: true,
        closingBalance: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    if (!statement) {
      return {
        success: false,
        error: "Save statement balances before classifying transactions",
      };
    }

    const statementValidation = validateTaxYearStatement({
      taxYear: draft.taxYear,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      currency: statement.currency,
    });

    if (!statementValidation.valid) {
      return { success: false, error: statementValidation.error };
    }

    // The server cannot rely only on the button's disabled state: a client
    // may call this action directly or may have stale browser JavaScript.
    // Require the selected account's current form values to match its exact
    // persisted statement before classifying that account's transactions.
    const persistedStart =
      statement.periodStart?.toISOString().slice(0, 10) ?? "";
    const persistedEnd = statement.periodEnd?.toISOString().slice(0, 10) ?? "";
    const valuesMatch =
      statement.bankAccountId === bankAccountId &&
      // Money is stored as Decimal, and `===` against a number is always
      // false for a Decimal instance. Comparing the converted values keeps
      // this an equality check rather than an unconditional "changed".
      toMoneyNumber(statement.openingBalance) ===
        statementInput.openingBalance &&
      toMoneyNumber(statement.closingBalance) ===
        statementInput.closingBalance &&
      persistedStart === statementInput.periodStart &&
      persistedEnd === statementInput.periodEnd;

    if (!valuesMatch) {
      return {
        success: false,
        error: "Save statement balances before classifying transactions",
      };
    }

    const [transactions, transferCandidates, ownedAccounts] = await Promise.all(
      [
        prisma.bankTransaction.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            OR: [
              { bankAccountId },
              { bankAccountId: null, bankStatementId: statement.id },
            ],
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.bankTransaction.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            bankAccountId: { not: null },
          },
          select: {
            id: true,
            bankAccountId: true,
            transactionDate: true,
            description: true,
            debit: true,
            credit: true,
          },
        }),
        prisma.bankAccount.findMany({
          where: { filingDraftId: draft.id, userId: draft.userId },
          select: {
            id: true,
            bankName: true,
            accountLabel: true,
            accountNumberMasked: true,
          },
          orderBy: { createdAt: "asc" },
        }),
      ],
    );

    const finalStatuses = new Set([
      "APPROVED",
      "REJECTED",
      "TRANSFER",
      "CASH_MOVEMENT",
    ]);
    const ruleSuggestions = transactions.map((transaction) => ({
      transaction,
      suggestion: finalStatuses.has(transaction.classificationStatus)
        ? {
            status: transaction.classificationStatus,
            entryType: transaction.suggestedEntryType,
            category: transaction.suggestedCategory,
            confidence: 1,
          }
        : classifyTransaction(transaction, transferCandidates),
    }));

    const ambiguous = ruleSuggestions
      .filter(
        (item) =>
          item.suggestion.status === "UNREVIEWED" ||
          item.suggestion.status === "POTENTIAL_INCOME",
      )
      .map((item) => item.transaction);
    const aiSuggestions = await classifyAmbiguousTransactionsWithGemini(
      ambiguous,
      ownedAccounts,
      draft.userId,
    );

    const suggestions = ruleSuggestions.map(({ transaction, suggestion }) => {
      const useAiFallback =
        suggestion.status === "UNREVIEWED" ||
        suggestion.status === "POTENTIAL_INCOME";
      const aiResult = useAiFallback
        ? aiSuggestions.get(transaction.id)
        : undefined;
      const aiSuggestion =
        aiResult && aiResult.classification !== "unknown"
          ? applyGeminiClassification(aiResult)
          : suggestion;

      return { id: transaction.id, ...aiSuggestion };
    });

    await prisma.$transaction(
      suggestions.map((suggestion) =>
        prisma.bankTransaction.update({
          where: { id: suggestion.id },
          data: {
            classificationStatus: suggestion.status,
            suggestedEntryType: suggestion.entryType,
            suggestedCategory: suggestion.category,
          },
        }),
      ),
    );

    const reviewStatuses = new Set([
      "UNREVIEWED",
      "POTENTIAL_INCOME",
      "POTENTIAL_ASSET",
      "POTENTIAL_LIABILITY",
      "POTENTIAL_TRANSFER",
      "POTENTIAL_CASH_MOVEMENT",
    ]);
    const riskCount = suggestions.filter((suggestion) =>
      reviewStatuses.has(suggestion.status),
    ).length;

    if (riskCount > 0) {
      await createNotification({
        userId: draft.userId,
        type: "RISK_FLAG",
        title: `${riskCount} bank transaction(s) need review`,
        message:
          "Classification found transactions that need an explicit income, asset, liability, transfer or cash decision.",
        link: `/tax/new?draftId=${draft.id}`,
      });
    }

    await invalidateDerivedFilingState(draft);
    return { success: true, suggestions };
  } catch (error) {
    console.error("Error classifying bank transactions:", error);
    return { success: false, error: "Failed to classify bank transactions" };
  }
}

export async function validateBankTransactionReviewAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const validation = await validateFilingCompleteness({
      draftId: draft.id,
      userId: draft.userId,
    });

    if (!validation.success) {
      return {
        success: false,
        error: validation.blockers.join(" · "),
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Error validating filing completeness:", error);
    return {
      success: false,
      error: "Failed to validate filing completeness",
    };
  }
}

export async function autoReviewSafeBankTransactionsAction(
  draftId: string,
  bankAccountId: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const account = await prisma.bankAccount.findFirst({
      where: {
        id: bankAccountId.trim(),
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: { id: true },
    });
    if (!account) {
      return { success: false, error: "Select a valid bank account" };
    }

    const safeExpenseCategories = [
      "UTILITIES_OR_RENT",
      "PERSONAL_EXPENSE",
      "TRANSPORT",
      "BANK_CHARGES",
    ];
    const safeTransactions = await prisma.bankTransaction.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId: account.id,
        classificationStatus: "SUGGESTED",
        suggestedEntryType: { not: null },
        suggestedCategory: { not: null },
      },
      select: { id: true, suggestedEntryType: true, suggestedCategory: true },
    });

    const autoApproveIds = safeTransactions
      .filter(
        (transaction) =>
          (transaction.suggestedEntryType === "EXPENSE" &&
            safeExpenseCategories.includes(
              transaction.suggestedCategory ?? "",
            )) ||
          (transaction.suggestedEntryType === "INCOME" &&
            transaction.suggestedCategory === "SALARY"),
      )
      .map((transaction) => transaction.id);
    const affectedIds = autoApproveIds;

    await prisma.$transaction(async (tx) => {
      if (affectedIds.length > 0) {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: { in: affectedIds },
          },
        });
      }
      if (autoApproveIds.length > 0) {
        await tx.bankTransaction.updateMany({
          where: { id: { in: autoApproveIds } },
          data: { classificationStatus: "APPROVED" },
        });
      }
    });

    await invalidateDerivedFilingState(draft);

    return {
      success: true,
      approvedCount: autoApproveIds.length,
    };
  } catch (error) {
    console.error("Error auto-reviewing safe bank transactions:", error);
    return { success: false, error: "Failed to auto-review safe transactions" };
  }
}

export async function undoBankTransactionClassificationAction(
  draftId: string,
  transactionId: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const transaction = await prisma.bankTransaction.findFirst({
      where: {
        id: transactionId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: {
        id: true,
        bankAccountId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
        classificationStatus: true,
        suggestedEntryType: true,
        suggestedCategory: true,
      },
    });
    if (!transaction)
      return { success: false, error: "Bank transaction not found" };

    const counterparts =
      transaction.classificationStatus === "TRANSFER"
        ? await getTransferCounterparts(draft, transaction)
        : [];
    const pairedTransferCounterparts = counterparts.filter(
      (counterpart) => counterpart.classificationStatus === "TRANSFER",
    );
    if (pairedTransferCounterparts.length > 1) {
      return {
        success: false,
        error: "Multiple transfer matches found; review the account data first",
      };
    }

    const affectedTransactions = [transaction, ...pairedTransferCounterparts];
    const affectedIds = affectedTransactions.map((item) => item.id);

    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          sourceTransactionId: { in: affectedIds },
        },
      });
      for (const affected of affectedTransactions) {
        await tx.bankTransaction.update({
          where: { id: affected.id },
          data: {
            classificationStatus: reviewedStatusForUndo(affected),
          },
        });
      }
    });
    await invalidateDerivedFilingState(draft);
    return { success: true };
  } catch (error) {
    console.error("Error undoing bank classification:", error);
    return { success: false, error: "Failed to undo bank classification" };
  }
}

export async function manuallyClassifyBankTransactionAction(
  draftId: string,
  transactionId: string,
  entryType: "INCOME" | "EXPENSE" | "ASSET" | "LIABILITY" | "EXCLUDE",
  category: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const transaction = await prisma.bankTransaction.findFirst({
      where: {
        id: transactionId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
    });
    if (!transaction)
      return { success: false, error: "Bank transaction not found" };

    if (transaction.classificationStatus === "TRANSFER") {
      const pairedTransfers = (
        await getTransferCounterparts(draft, transaction)
      ).filter(
        (counterpart) => counterpart.classificationStatus === "TRANSFER",
      );
      if (pairedTransfers.length > 0) {
        return {
          success: false,
          error:
            "This is a paired internal transfer. Use Undo first; both sides will be reopened together.",
        };
      }
    }

    if (entryType === "EXCLUDE") {
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: transaction.id,
          },
        });
        await tx.bankTransaction.update({
          where: { id: transaction.id },
          data: {
            classificationStatus: "REJECTED",
            suggestedEntryType: null,
            suggestedCategory: category || "EXCLUDED",
          },
        });
      });
      await invalidateDerivedFilingState(draft);
      return { success: true };
    }

    const amount = toMoneyAmount(
      entryType === "INCOME" || entryType === "LIABILITY"
        ? transaction.credit
        : transaction.debit,
    );
    if (amount <= 0) {
      return {
        success: false,
        error: "Choose a transaction type matching the debit/credit amount",
      };
    }
    if (!category.trim())
      return { success: false, error: "Category is required" };

    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          sourceTransactionId: transaction.id,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          entryDate: transaction.transactionDate,
          entryType,
          category: category.trim(),
          description: transaction.description,
          amount: Math.abs(amount),
          source: "BANK_CLASSIFIED",
          sourceDocumentId: transaction.sourceDocumentId,
          sourceTransactionId: transaction.id,
        },
      });
      await tx.bankTransaction.update({
        where: { id: transaction.id },
        data: {
          classificationStatus: "APPROVED",
          suggestedEntryType: entryType,
          suggestedCategory: category.trim(),
        },
      });
    });
    await invalidateDerivedFilingState(draft);
    return { success: true };
  } catch (error) {
    console.error("Error manually classifying bank transaction:", error);
    return { success: false, error: "Failed to save manual classification" };
  }
}

export async function reviewBankTransactionClassificationAction(
  draftId: string,
  transactionId: string,
  decision: "APPROVE" | "REJECT" | "TRANSFER" | "CASH_MOVEMENT",
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const transaction = await prisma.bankTransaction.findFirst({
      where: {
        id: transactionId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
    });

    if (!transaction) {
      return { success: false, error: "Bank transaction not found" };
    }

    const transferCounterparts = await getTransferCounterparts(
      draft,
      transaction,
    );
    const pairedTransferCounterparts = transferCounterparts.filter(
      (counterpart) => counterpart.classificationStatus === "TRANSFER",
    );

    if (
      decision !== "TRANSFER" &&
      transaction.classificationStatus === "TRANSFER" &&
      pairedTransferCounterparts.length > 0
    ) {
      return {
        success: false,
        error:
          "This is a paired internal transfer. Use Undo first; both sides will be reopened together.",
      };
    }

    if (decision === "CASH_MOVEMENT") {
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: transaction.id,
          },
        });
        await tx.bankTransaction.update({
          where: { id: transaction.id },
          data: {
            classificationStatus: "CASH_MOVEMENT",
            suggestedEntryType: null,
            suggestedCategory: "CASH_MOVEMENT",
          },
        });
      });
      await invalidateDerivedFilingState(draft);
      return { success: true, decision };
    }

    if (decision === "TRANSFER") {
      if (transferCounterparts.length === 0) {
        return {
          success: false,
          error:
            "No matching opposite transaction was found in another owned account",
        };
      }
      if (transferCounterparts.length > 1) {
        return {
          success: false,
          error:
            "Multiple possible transfer matches were found; review the account data first",
        };
      }

      const counterpart = transferCounterparts[0];
      const conflictingStatuses = new Set([
        "APPROVED",
        "REJECTED",
        "CASH_MOVEMENT",
      ]);
      if (conflictingStatuses.has(counterpart.classificationStatus)) {
        return {
          success: false,
          error:
            "The matching transfer side has a conflicting decision. Undo that decision first.",
        };
      }

      const transferIds = [transaction.id, counterpart.id];
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: { in: transferIds },
          },
        });

        await tx.bankTransaction.updateMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            id: { in: transferIds },
          },
          data: {
            classificationStatus: "TRANSFER",
            suggestedEntryType: null,
            suggestedCategory: "INTERNAL_TRANSFER",
          },
        });
      });

      await invalidateDerivedFilingState(draft);
      return {
        success: true,
        decision,
        pairedTransactionId: counterpart.id,
      };
    }

    if (decision === "REJECT") {
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: transaction.id,
          },
        });

        await tx.bankTransaction.update({
          where: { id: transaction.id },
          data: { classificationStatus: "REJECTED" },
        });
      });

      await invalidateDerivedFilingState(draft);
      return { success: true, decision };
    }

    if (!transaction.suggestedEntryType || !transaction.suggestedCategory) {
      return {
        success: false,
        error: "This transaction has no suggestion to approve",
      };
    }

    const amount = toMoneyAmount(
      transaction.suggestedEntryType === "INCOME" ||
        transaction.suggestedEntryType === "LIABILITY"
        ? transaction.credit
        : transaction.debit,
    );

    if (amount <= 0) {
      return { success: false, error: "Transaction has no usable amount" };
    }

    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          sourceTransactionId: transaction.id,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          entryDate: transaction.transactionDate,
          entryType: transaction.suggestedEntryType,
          category: transaction.suggestedCategory,
          description: transaction.description,
          amount: Math.abs(amount),
          source: "BANK_CLASSIFIED",
          sourceDocumentId: transaction.sourceDocumentId,
          sourceTransactionId: transaction.id,
        },
      });

      await tx.bankTransaction.update({
        where: { id: transaction.id },
        data: { classificationStatus: "APPROVED" },
      });
    });

    await invalidateDerivedFilingState(draft);
    return { success: true, decision };
  } catch (error) {
    console.error("Error reviewing bank classification:", error);
    return { success: false, error: "Failed to review bank classification" };
  }
}
