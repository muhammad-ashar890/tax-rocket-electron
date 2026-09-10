import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { ShieldCheck } from "lucide-react";

import { getFbrConnectionAction } from "@/app/actions/fbr";
import { toMoneyAmount } from "@/lib/money";
import { isFbrAgentCompleted } from "@/lib/tax/filing-status";
import { isLiveFilingEnabledByDeployment } from "@/lib/tax/fbr-agent-config";
import FbrConnectClient from "@/components/tax/fbr-connect-client";
import { Card, CardContent } from "@/components/ui/card";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";
import { WizardSummaryPanel } from "@/components/tax/wizard-ui";
import { DashboardSidebar } from "@/components/tax/dashboard-sidebar";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type FbrConnectPageProps = Readonly<{
  searchParams: {
    draftId?: string;
  };
}>;

export default async function FbrConnectPage({
  searchParams,
}: FbrConnectPageProps) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) {
    redirect("/login");
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true },
  });

  const draftId = searchParams.draftId;
  const draft =
    user && draftId
      ? await prisma.filingDraft.findFirst({
          where: {
            id: draftId,
            userId: user.id,
          },
          include: {
            // The final gate shows the numbers the taxpayer is about to submit;
            // without this the standalone page renders the gate blind.
            filingPackets: {
              where: { approvalStatus: "APPROVED" },
              orderBy: { version: "desc" },
              take: 1,
              select: { version: true, taxPayable: true, refundDue: true },
            },
          },
        })
      : null;

  const currentStatus = draft
    ? draft.status === "APPROVED_FOR_FILING" &&
      draft.packetApprovalConfirmed &&
      draft.taxCalculationStatus === "ESTIMATE" &&
      draft.reconciliationStatus === "RESOLVED" &&
      toMoneyAmount(draft.reconciliationGap) === 0
      ? draft.status
      : draft.taxCalculationStatus === "NEEDS_RULES"
        ? "NEEDS_RULES"
        : "IN_PROGRESS"
    : null;

  const connectionResult = draftId
    ? await getFbrConnectionAction(draftId)
    : { success: true as const, connection: null };
  const connection = connectionResult.success ? connectionResult.connection : null;

  const summaryRows = draft
    ? [
        { label: "Tax year", value: String(draft.taxYear) },
        {
          label: "Taxpayer",
          value: user?.name || session.user?.name || "Taxpayer",
        },
        {
          label: "Filer",
          value: (draft.filerType || "Not selected").replaceAll("_", " "),
        },
        {
          label: "Status",
          value: currentStatus?.replaceAll("_", " ") ?? "Not started",
        },
        {
          // Same centralized predicate the wizard rail uses — never re-list the
          // agent's status strings here, or the two views drift again.
          label: "Local agent",
          value: connection?.status
            ? isFbrAgentCompleted(connection.status)
              ? "Job completed"
              : connection.status.replaceAll("_", " ")
            : "Not connected",
        },
      ]
    : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <DashboardSidebar />

      <div className="lg:min-w-0">
        <div className="flex items-center gap-3">
          <TaxRocketLogo showWordmark={false} />
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              FBR Connect
            </h1>
            <p className="text-xs text-muted-foreground">
              Supervised filing hand-off to FBR Iris.
            </p>
          </div>
        </div>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_280px]">
          <Card className="shadow-sm">
            <CardContent className="space-y-6 p-6 sm:p-8">
              <div>
                <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
                  File with FBR
                </h2>
                <p className="text-sm text-muted-foreground sm:text-base">
                  A local agent on your own computer connects securely to FBR
                  Iris. You stay in control of every OTP, CAPTCHA, and PIN.
                </p>
              </div>

              <div className="rounded-xl border border-[#376952]/20 bg-[#376952]/5 p-5">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[#376952]/10 text-[#376952]">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <p className="font-semibold text-foreground">
                  You&apos;re always supervising
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  TaxRocket never sees or stores your OTP, CAPTCHA, or PIN.
                  Everything sensitive happens locally, in front of you.
                </p>
              </div>

              <FbrConnectClient
                draftId={draftId}
                initialConnection={connection}
                taxPayable={
                  draft && draft.taxPayable != null
                    ? toMoneyAmount(draft.taxPayable)
                    : null
                }
                refundDue={
                  draft && draft.refundDue != null
                    ? toMoneyAmount(draft.refundDue)
                    : null
                }
                packetVersion={draft?.filingPackets?.[0]?.version}
                liveFilingEnabled={isLiveFilingEnabledByDeployment()}
              />
            </CardContent>
          </Card>

          <aside className="lg:sticky lg:top-20 lg:self-start">
            <WizardSummaryPanel rows={summaryRows} title="Filing Summary" />
          </aside>
        </div>
      </div>
    </div>
  );
}
