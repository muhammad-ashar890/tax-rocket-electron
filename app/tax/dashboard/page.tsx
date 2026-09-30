import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";

import {
  TaxpayerDashboard,
  type ActiveFilingSummary,
  type RecentActivityItem,
} from "@/components/tax/taxpayer-dashboard";
import { DashboardSidebar } from "@/components/tax/dashboard-sidebar";
import { DashboardInfoPanel } from "@/components/tax/dashboard-info-panel";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import {
  FILING_STATUS,
  getCurrentApprovalState,
  getDashboardStepLabel,
  getEffectiveFilingStatus,
  getPipelineStartIndex,
} from "@/lib/tax/filing-status";

export default async function TaxDashboardPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) {
    redirect("/login");
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      defaultTaxYear: true,
    },
  });

  const drafts = user
    ? await prisma.filingDraft.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        include: {
          documents: {
            select: { extractionStatus: true },
          },
          bankTransactions: {
            select: { classificationStatus: true },
          },
          filingPackets: {
            where: { status: { not: "SUPERSEDED" } },
            orderBy: { version: "desc" },
            take: 1,
            select: { approvalStatus: true },
          },
        },
      })
    : [];

  const notifications = user
    ? await prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 5,
      })
    : [];

  const unreadNotificationCount = user
    ? await prisma.notification.count({
        where: { userId: user.id, isRead: false },
      })
    : 0;

  const baseApprovalByDraft = new Map(
    drafts.map((draft) => [
      draft.id,
      getCurrentApprovalState({
        draft: draft as any,
        documents: draft.documents as any,
        transactions: draft.bankTransactions as any,
        latestPacket: draft.filingPackets[0] as any,
      }).isCurrentlyApproved,
    ]),
  );
  const filingIntegrityByDraft = new Map(
    await Promise.all(
      drafts.map(async (draft) => {
        if (
          draft.status === FILING_STATUS.FILED ||
          !baseApprovalByDraft.get(draft.id)
        ) {
          return [draft.id, true] as const;
        }
        const [completeness, reconciliation] = await Promise.all([
          validateFilingCompleteness({
            draftId: draft.id,
            userId: draft.userId,
          }),
          validateAuthoritativeReconciliation({
            draftId: draft.id,
            userId: draft.userId,
          }),
        ]);
        return [
          draft.id,
          completeness.success && reconciliation.success,
        ] as const;
      }),
    ),
  );

  const isCurrentlyApproved = (draft: (typeof drafts)[number]) =>
    Boolean(
      baseApprovalByDraft.get(draft.id) && filingIntegrityByDraft.get(draft.id),
    );

  const activeDrafts = drafts.filter((draft) => !isCurrentlyApproved(draft));
  const approvedDrafts = drafts.filter((draft) => isCurrentlyApproved(draft));

  const dashboardStatus = (draft: (typeof drafts)[number]) => {
    const effectiveStatus = getEffectiveFilingStatus({
      draft: draft as any,
      documents: draft.documents as any,
      transactions: draft.bankTransactions as any,
      latestPacket: draft.filingPackets[0] as any,
    });
    return !isCurrentlyApproved(draft) &&
      effectiveStatus === FILING_STATUS.APPROVED_FOR_FILING
      ? FILING_STATUS.IN_PROGRESS
      : effectiveStatus;
  };

  const dashboardStepLabel = (draft: (typeof drafts)[number]) => {
    const approved = isCurrentlyApproved(draft);
    return getDashboardStepLabel({
      draft: draft as any,
      isCurrentlyApproved: approved,
    });
  };

  const filings: ActiveFilingSummary[] = activeDrafts.map((draft) => ({
    id: draft.id,
    taxYear: draft.taxYear,
    currentStep: draft.currentStep,
    pipelineStartIndex: getPipelineStartIndex(draft),
    currentStepLabel: dashboardStepLabel(draft),
    status: dashboardStatus(draft),
    taxpayerName: user?.name,
    reconciliationStatus: draft.reconciliationStatus,
  }));

  const approvedFilings: ActiveFilingSummary[] = approvedDrafts.map(
    (draft) => ({
      id: draft.id,
      taxYear: draft.taxYear,
      currentStep: draft.currentStep,
      pipelineStartIndex: getPipelineStartIndex(draft),
      currentStepLabel: dashboardStepLabel(draft),
      status: dashboardStatus(draft),
      taxpayerName: user?.name,
      reconciliationStatus: draft.reconciliationStatus,
    }),
  );

  const recentActivity: RecentActivityItem[] = drafts.map((draft) => ({
    id: draft.id,
    label: `Filing draft updated for TY ${draft.taxYear}`,
    timestamp: draft.updatedAt.toLocaleDateString("en-PK"),
    icon: draft.status === "FILED" ? "file" : "note",
  }));

  const displayName = user?.name || session.user?.name || "Taxpayer";
  const userEmail = user?.email || email;
  // Keep approved drafts visible so the dashboard can reopen them.
  const primaryFiling = filings[0] ?? approvedFilings[0] ?? null;
  const taxYear = primaryFiling?.taxYear ?? new Date().getFullYear();

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr] xl:grid-cols-[220px_1fr_280px]">
      <DashboardSidebar />

      <div className="space-y-3 lg:min-w-0">
        <TaxpayerDashboard
          displayName={displayName}
          activeDraftCount={activeDrafts.length}
          approvedDraftCount={approvedDrafts.length}
          defaultTaxYear={user?.defaultTaxYear}
          activeFilings={filings}
          approvedFilings={approvedFilings}
          recentActivity={recentActivity}
        />
      </div>

      <DashboardInfoPanel
        displayName={displayName}
        email={userEmail}
        image={user?.image}
        taxYear={taxYear}
        primaryFiling={primaryFiling}
        hasApprovedFiling={approvedDrafts.length > 0}
        mizanStatus={primaryFiling?.reconciliationStatus}
        notifications={notifications.map((notification) => ({
          id: notification.id,
          title: notification.title,
          message: notification.message,
          createdAt: notification.createdAt.toISOString(),
        }))}
        unreadNotificationCount={unreadNotificationCount}
      />
    </div>
  );
}
