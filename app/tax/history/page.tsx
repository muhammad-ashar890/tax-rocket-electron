import Link from "next/link";
import { redirect } from "next/navigation";
import { History, Rocket } from "lucide-react";
import { getServerSession } from "next-auth/next";
import { Button } from "@/components/ui/button";
import { DashboardSidebar } from "@/components/tax/dashboard-sidebar";
import {
  FilingHistoryList,
  type FilingHistoryItem,
} from "@/components/tax/filing-history-list";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import { toMoneyNumber } from "@/lib/money";
import {
  FILING_STATUS,
  getCurrentApprovalState,
  getEffectiveFilingStatus,
  isTaxCalculationReady,
} from "@/lib/tax/filing-status";

export default async function HistoryPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  const drafts = user
    ? await prisma.filingDraft.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        include: {
          filingPackets: {
            where: { status: { not: "SUPERSEDED" } },
            orderBy: { version: "desc" },
            take: 1,
            select: {
              id: true,
              version: true,
              fileUrl: true,
              approvalStatus: true,
              taxPayable: true,
              refundDue: true,
            },
          },
        },
      })
    : [];

  const filingIntegrityByDraft = new Map(
    await Promise.all(
      drafts.map(async (draft) => {
        const packet = draft.filingPackets[0] ?? null;
        const baseApproval = getCurrentApprovalState({
          draft: draft as any,
          latestPacket: packet as any,
        }).isCurrentlyApproved;
        if (draft.status === FILING_STATUS.FILED || !baseApproval) {
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

  const filings: FilingHistoryItem[] = drafts.map((draft) => {
    const packet = draft.filingPackets[0] ?? null;

    const baseApproval = getCurrentApprovalState({
      draft: draft as any,
      latestPacket: packet as any,
    }).isCurrentlyApproved;
    const isCurrentlyApproved = Boolean(
      baseApproval && filingIntegrityByDraft.get(draft.id),
    );

    const baseEffectiveStatus = getEffectiveFilingStatus({
      draft: draft as any,
      latestPacket: packet as any,
    });
    const effectiveStatus =
      !isCurrentlyApproved &&
      baseEffectiveStatus === FILING_STATUS.APPROVED_FOR_FILING
        ? FILING_STATUS.IN_PROGRESS
        : baseEffectiveStatus;

    const taxCalculationReady = isTaxCalculationReady(
      draft.taxCalculationStatus,
    );

    return {
      id: draft.id,
      taxYear: draft.taxYear,
      // Centralized: never display stale APPROVED_FOR_FILING when current draft needs rules/Mizan
      status: effectiveStatus,
      filerType: draft.filerType,
      updatedAt: draft.updatedAt.toISOString(),
      packet: packet
        ? {
            ...packet,
            // Do not show stored zero as real tax result when pending rules
            taxPayable:
              isCurrentlyApproved && taxCalculationReady
                ? toMoneyNumber(packet.taxPayable)
                : null,
            refundDue:
              isCurrentlyApproved && taxCalculationReady
                ? toMoneyNumber(packet.refundDue)
                : null,
          }
        : null,
    };
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <DashboardSidebar />

      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amanah/10 text-amanah">
              <History className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-foreground">
                Filing History
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                View and reopen your saved, approved, and filed returns.
              </p>
            </div>
          </div>
          <Button asChild className="gap-2">
            <Link href="/tax/new">
              <Rocket className="h-4 w-4" />
              Start New Filing
            </Link>
          </Button>
        </div>

        <FilingHistoryList initialFilings={filings} />
      </div>
    </div>
  );
}
