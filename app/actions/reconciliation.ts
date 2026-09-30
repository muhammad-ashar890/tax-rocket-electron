"use server";

import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";

import { createNotification } from "@/app/actions/notifications";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import {
  toMoneyAmount,
  toMoneyNumber,
  toMoneyNumberOrNull,
} from "@/lib/money";

export type ReconciliationMethod = "auto" | "manual";

export type ReconciliationInput = {
  method: ReconciliationMethod;
  note?: string;
  revision: string;
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
    select: {
      id: true,
      userId: true,
      taxYear: true,
    },
  });

  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

export async function getReconciliationAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const [record, autoAdjustment] = await Promise.all([
      prisma.filingDraft.findUnique({
        where: { id: draft.id },
        select: {
          reconciliationStatus: true,
          reconciliationMethod: true,
          reconciliationNote: true,
          openingWealth: true,
          closingWealth: true,
          reconciliationGap: true,
        },
      }),
      prisma.ledgerEntry.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          source: "RECONCILIATION_AUTO_ADJUSTMENT",
        },
        orderBy: { createdAt: "desc" },
        select: { amount: true, category: true },
      }),
    ]);

    const activeAutoAdjustment =
      record?.reconciliationStatus === "RESOLVED" &&
      record.reconciliationMethod === "auto" &&
      toMoneyAmount(record.reconciliationGap) === 0
        ? autoAdjustment
        : null;

    const reconciliation = record
      ? {
          ...record,
          // Converted at the boundary: the client compares this against a
          // preview number, and a Decimal would fail every comparison.
          autoAdjustmentAmount: toMoneyNumberOrNull(
            activeAutoAdjustment?.amount,
          ),
          autoAdjustmentCategory: activeAutoAdjustment?.category ?? null,
          reconciliationNote:
            record.reconciliationMethod === "auto"
              ? activeAutoAdjustment
                ? `Other reconciliation adjustment recorded for PKR ${toMoneyNumber(
                    activeAutoAdjustment.amount,
                  ).toLocaleString()}. This is non-taxable and requires review before filing.`
                : "No Other reconciliation adjustment was required."
              : record.reconciliationNote,
        }
      : null;

    return { success: true, reconciliation };
  } catch (error) {
    console.error("Error fetching reconciliation:", error);
    return { success: false, error: "Failed to fetch reconciliation" };
  }
}

export async function calculateReconciliationPreviewAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const calculation = await prisma.$transaction(
      (tx) =>
        calculateAuthoritativeReconciliation(
          { draftId: draft.id, userId: draft.userId },
          tx,
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    if ("blockers" in calculation) {
      return {
        success: false,
        error: calculation.blockers.join(" · "),
      };
    }

    return { success: true, preview: calculation.preview };
  } catch (error) {
    console.error("Error calculating reconciliation preview:", error);
    return {
      success: false,
      error: "Failed to calculate reconciliation preview",
    };
  }
}

export async function saveReconciliationAction(
  draftId: string,
  input: ReconciliationInput,
) {
  try {
    const draft = await getOwnedDraft(draftId);

    if (!input.revision.trim()) {
      return {
        success: false,
        error: "Refresh Mizan before confirming reconciliation",
      };
    }
    if (input.method === "manual" && !input.note?.trim()) {
      return {
        success: false,
        error: "A manual reconciliation note is required",
      };
    }

    const result = await prisma.$transaction(
      async (tx) => {
        // Re-read and validate every account/document/statement/transaction and
        // ledger row inside the same serializable transaction that persists
        // reconciliation. Client-provided monetary totals are never accepted.
        const calculation = await calculateAuthoritativeReconciliation(
          { draftId: draft.id, userId: draft.userId },
          tx,
        );
        if ("blockers" in calculation) {
          return {
            success: false as const,
            error: calculation.blockers.join(" · "),
          };
        }

        const preview = calculation.preview;
        if (preview.revision !== input.revision) {
          return {
            success: false as const,
            error:
              "Mizan inputs changed after this preview. Refresh and review the latest calculation before confirming.",
          };
        }

        const serverGap = preview.gap;
        const adjustmentAmount =
          input.method === "auto" ? Math.abs(serverGap) : 0;
        const autoAdjustmentNote =
          adjustmentAmount > 0
            ? `Other reconciliation adjustment recorded for PKR ${adjustmentAmount.toLocaleString()}. This is non-taxable and requires review before filing.`
            : "No Other reconciliation adjustment was required.";

        // Always replace/remove the old derived adjustment. The authoritative
        // base calculation above excluded it, so the replacement cannot mask a
        // changed statement or ledger input.
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            source: "RECONCILIATION_AUTO_ADJUSTMENT",
          },
        });

        if (input.method === "auto" && adjustmentAmount > 0) {
          await tx.ledgerEntry.create({
            data: {
              filingDraftId: draft.id,
              userId: draft.userId,
              entryType: "OTHER",
              category:
                serverGap >= 0
                  ? "RECONCILIATION_ADJUSTMENT_INFLOW"
                  : "RECONCILIATION_ADJUSTMENT_OUTFLOW",
              description: "Mizan auto-adjustment — non-taxable Other item",
              amount: adjustmentAmount,
              source: "RECONCILIATION_AUTO_ADJUSTMENT",
            },
          });
        }

        await tx.filingDraft.update({
          where: { id: draft.id },
          data: {
            reconciliationStatus: "RESOLVED",
            reconciliationMethod: input.method,
            reconciliationNote:
              input.method === "auto"
                ? autoAdjustmentNote
                : input.note?.trim() || null,
            openingWealth: preview.openingWealth,
            closingWealth: preview.closingWealth,
            reconciliationGap: input.method === "auto" ? 0 : serverGap,
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

        await tx.filingPacket.updateMany({
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

        return {
          success: true as const,
          adjustmentAmount,
          serverGap,
          preview,
          note:
            input.method === "auto"
              ? autoAdjustmentNote
              : input.note?.trim() || undefined,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (!result.success) return result;

    await createNotification({
      userId: draft.userId,
      type: "FILING_STATUS",
      title: `Mizan resolved — Tax Year ${draft.taxYear}`,
      message:
        input.method === "auto"
          ? (result.note ?? "No Other reconciliation adjustment was required.")
          : Math.abs(result.serverGap) > 0
            ? `Wealth reconciliation was manually acknowledged with a gap of PKR ${Math.abs(result.serverGap).toLocaleString()}.`
            : "Wealth reconciliation completed with no gap.",
      link: `/tax/new?draftId=${draft.id}`,
    });

    return result;
  } catch (error) {
    console.error("Error saving reconciliation:", error);
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      return {
        success: false,
        error:
          "Mizan inputs changed while saving. Refresh and confirm the latest calculation.",
      };
    }
    return { success: false, error: "Failed to save reconciliation" };
  }
}
