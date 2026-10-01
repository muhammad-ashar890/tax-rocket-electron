"use server";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validatePakistaniIban } from "@/lib/tax/iban";

export type BankAccountInput = {
  id?: string;
  bankName: string;
  accountLabel: string;
  accountNumberMasked?: string;
  /**
   * Not asked for here: it is read from the bank statement (a required field of
   * the statement review). Kept only so an IBAN already on the account is
   * carried through a re-save instead of being wiped.
   */
  iban?: string;
  currency?: string;
};

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
    select: { id: true, userId: true },
  });
  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

export async function saveBankAccountsAction(
  draftId: string,
  accounts: BankAccountInput[],
) {
  try {
    const draft = await getOwnedDraft(draftId);
    if (accounts.length === 0) {
      return { success: false, error: "Add at least one bank account" };
    }

    const normalized = accounts.map((account) => ({
      bankName: account.bankName.trim(),
      accountLabel: account.accountLabel.trim(),
      accountNumberMasked: account.accountNumberMasked?.trim() || null,
      currency: account.currency?.trim().toUpperCase() || "PKR",
    }));

    const existing = await prisma.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      select: { id: true, iban: true },
    });
    const existingIds = new Set(existing.map((account) => account.id));
    const existingIbanById = new Map(
      existing.map((account) => [account.id, account.iban] as const),
    );

    // The IBAN comes from the statement. A re-save of this list must neither
    // require it nor erase it; anything typed in is still validated.
    const ibans: (string | null)[] = [];
    for (const account of accounts) {
      const typed = (account.iban ?? "").trim();
      if (typed) {
        const validation = validatePakistaniIban(typed);
        if (!validation.valid) {
          return {
            success: false,
            error: `${account.bankName.trim() || "Bank account"} — ${account.accountLabel.trim() || "unnamed"}: ${validation.error}`,
          };
        }
        ibans.push(validation.iban);
      } else {
        ibans.push(
          (account.id ? existingIbanById.get(account.id) : null) ?? null,
        );
      }
    }
    const present = ibans.filter((iban): iban is string => Boolean(iban));
    if (new Set(present).size !== present.length) {
      return {
        success: false,
        error: "Each bank account needs its own IBAN — one IBAN is used twice",
      };
    }

    if (
      normalized.some((account) => !account.bankName || !account.accountLabel)
    ) {
      return {
        success: false,
        error: "Bank name and account label are required",
      };
    }

    const labels = normalized.map((account) =>
      account.accountLabel.toLowerCase(),
    );
    if (new Set(labels).size !== labels.length) {
      return {
        success: false,
        error: "Each bank account needs a unique label",
      };
    }

    const saved = await prisma.$transaction(async (tx) => {
      const savedAccounts = [];
      for (const [accountIndex, account] of accounts.entries()) {
        const normalizedAccount = {
          bankName: account.bankName.trim(),
          accountLabel: account.accountLabel.trim(),
          accountNumberMasked: account.accountNumberMasked?.trim() || null,
          iban: ibans[accountIndex],
          currency: account.currency?.trim().toUpperCase() || "PKR",
        };

        if (account.id) {
          if (!existingIds.has(account.id)) {
            throw new Error("Bank account does not belong to this filing");
          }
          savedAccounts.push(
            await tx.bankAccount.update({
              where: { id: account.id },
              data: normalizedAccount,
              select: {
                id: true,
                bankName: true,
                accountLabel: true,
                accountNumberMasked: true,
                iban: true,
                currency: true,
              },
            }),
          );
        } else {
          savedAccounts.push(
            await tx.bankAccount.upsert({
              where: {
                filingDraftId_accountLabel: {
                  filingDraftId: draft.id,
                  accountLabel: normalizedAccount.accountLabel,
                },
              },
              // Never null out an IBAN already read from a statement.
              update: normalizedAccount.iban
                ? normalizedAccount
                : {
                    bankName: normalizedAccount.bankName,
                    accountNumberMasked: normalizedAccount.accountNumberMasked,
                    currency: normalizedAccount.currency,
                  },
              create: {
                ...normalizedAccount,
                filingDraftId: draft.id,
                userId: draft.userId,
              },
              select: {
                id: true,
                bankName: true,
                accountLabel: true,
                accountNumberMasked: true,
                iban: true,
                currency: true,
              },
            }),
          );
        }
      }

      const keepIds = savedAccounts.map((account) => account.id);
      const staleIds = existing
        .map((account) => account.id)
        .filter((id) => !keepIds.includes(id));

      if (staleIds.length > 0) {
        const linked = await tx.bankAccount.findMany({
          where: {
            id: { in: staleIds },
            OR: [
              { documents: { some: {} } },
              { statements: { some: {} } },
              { transactions: { some: {} } },
              { ledgerEntries: { some: {} } },
            ],
          },
          select: { bankName: true, accountLabel: true },
        });
        if (linked.length > 0) {
          throw new Error(
            `Remove linked documents or statements before removing: ${linked.map((account) => `${account.bankName} — ${account.accountLabel}`).join(", ")}`,
          );
        }
        await tx.bankAccount.deleteMany({ where: { id: { in: staleIds } } });
      }

      return savedAccounts;
    });

    return { success: true, accounts: saved };
  } catch (error) {
    console.error("Error saving bank accounts:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to save bank accounts",
    };
  }
}

export async function getBankAccountsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const accounts = await prisma.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        bankName: true,
        accountLabel: true,
        accountNumberMasked: true,
        iban: true,
        currency: true,
      },
    });
    return { success: true, accounts };
  } catch (error) {
    console.error("Error fetching bank accounts:", error);
    return {
      success: false,
      error: "Failed to fetch bank accounts",
      accounts: [],
    };
  }
}
