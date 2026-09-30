"use server";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import { createNotification } from "@/app/actions/notifications";
import { getFbrConnectionBlockers } from "@/lib/tax/filing-status";

export type FbrConnectionView = {
  id: string;
  status: string;
  agentId: string | null;
  message: string | null;
  errorMessage: string | null;
  lastHeartbeat: string | null;
  startedAt: string | null;
  completedAt: string | null;
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

function serializeConnection(connection: {
  id: string;
  status: string;
  agentId: string | null;
  message: string | null;
  errorMessage: string | null;
  lastHeartbeat: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}): FbrConnectionView {
  return {
    id: connection.id,
    status: connection.status,
    agentId: connection.agentId,
    message: connection.message,
    errorMessage: connection.errorMessage,
    lastHeartbeat: connection.lastHeartbeat?.toISOString() ?? null,
    startedAt: connection.startedAt?.toISOString() ?? null,
    completedAt: connection.completedAt?.toISOString() ?? null,
  };
}

export async function getFbrConnectionAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const connection = await prisma.fbrConnection.findUnique({
      where: { filingDraftId: draft.id },
    });

    return {
      success: true,
      connection: connection ? serializeConnection(connection) : null,
    };
  } catch (error) {
    console.error("Error fetching FBR connection:", error);
    return { success: false, error: "Failed to fetch FBR connection" };
  }
}

export async function startFbrConnectionAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const [draftState, completeness, reconciliation, latestPacket] =
      await Promise.all([
        prisma.filingDraft.findUnique({
          where: { id: draft.id },
          select: {
            status: true,
            packetApprovalConfirmed: true,
            taxCalculationStatus: true,
            taxpayerListStatus: true,
            taxRuleSetVersion: true,
            taxCalculationRevision: true,
            reconciliationStatus: true,
            reconciliationGap: true,
          },
        }),
        validateFilingCompleteness({
          draftId: draft.id,
          userId: draft.userId,
        }),
        validateAuthoritativeReconciliation({
          draftId: draft.id,
          userId: draft.userId,
        }),
        prisma.filingPacket.findFirst({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            status: { not: "SUPERSEDED" },
            approvalStatus: "APPROVED",
          },
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            status: true,
            approvalStatus: true,
          },
        }),
      ]);

    // Combine the general approval/FBR state with the same authoritative
    // per-account completeness gate used by Bank Intelligence and packet
    // generation. Direct or stale calls cannot skip missing account slots.
    const blockers = Array.from(
      new Set([
        ...completeness.blockers,
        ...("blockers" in reconciliation ? reconciliation.blockers : []),
        ...(draftState &&
        ["ATL", "NON_ATL", "LATE_FILER"].includes(
          draftState.taxpayerListStatus ?? "",
        ) &&
        draftState.taxRuleSetVersion &&
        draftState.taxCalculationRevision
          ? []
          : ["Calculate a current ATL, Late Filer or Non-ATL tax estimate"]),
        ...(draftState
          ? getFbrConnectionBlockers({
              draft: {
                status: draftState.status,
                packetApprovalConfirmed: draftState.packetApprovalConfirmed,
                taxCalculationStatus: draftState.taxCalculationStatus,
                reconciliationStatus: draftState.reconciliationStatus,
                reconciliationGap: draftState.reconciliationGap,
              },
              latestPacket,
            })
          : ["Filing draft not found"]),
      ]),
    );

    // Extra guard: if packet itself missing (not just not approved) show same message as before
    if (!latestPacket && draftState) {
      const missingPacketMsg = "Generate and approve the latest filing packet";
      if (!blockers.includes(missingPacketMsg)) {
        blockers.push(missingPacketMsg);
      }
    }

    if (blockers.length > 0) {
      return { success: false, error: blockers.join(" · ") };
    }

    const now = new Date();
    const connection = await prisma.fbrConnection.upsert({
      where: { filingDraftId: draft.id },
      update: {
        status: "WAITING_FOR_AGENT",
        agentId: null,
        message: `Waiting for the local Trusted Desktop Agent for packet v${latestPacket.version}.`,
        errorMessage: null,
        startedAt: now,
        completedAt: null,
      },
      create: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: "WAITING_FOR_AGENT",
        message: `Waiting for the local Trusted Desktop Agent for packet v${latestPacket.version}.`,
        startedAt: now,
      },
    });

    await createNotification({
      userId: draft.userId,
      type: "FBR_STATUS",
      title: "FBR connection started",
      message: `Waiting for the local Trusted Desktop Agent for packet v${latestPacket.version}.`,
      link: `/tax/fbr-connect?draftId=${draft.id}`,
    });

    return { success: true, connection: serializeConnection(connection) };
  } catch (error) {
    console.error("Error starting FBR connection:", error);
    return { success: false, error: "Failed to start FBR connection" };
  }
}
