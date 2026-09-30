"use client";

import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  CalendarClock,
  CheckCircle2,
  FileText,
  FolderOpen,
  Link2,
  Rocket,
  Scale,
  Sparkles,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { FilingProgressPill } from "@/components/tax/filing-progress";

export type RecentActivityItem = {
  id: string;
  label: string;
  timestamp: string;
  icon?: "upload" | "review" | "approve" | "file" | "note";
};

export type ActiveFilingSummary = {
  id: string;
  taxYear: number;
  currentStep: number;
  pipelineStartIndex?: number;
  currentStepLabel?: string;
  status?: string;
  taxpayerName?: string | null;
  reconciliationStatus?: string | null;
};

type TaxpayerDashboardProps = {
  displayName: string;
  activeDraftCount?: number;
  approvedDraftCount?: number;
  defaultTaxYear?: number | null;
  activeFilings?: ActiveFilingSummary[];
  approvedFilings?: ActiveFilingSummary[];
  recentActivity?: RecentActivityItem[];
};

const activityIconMap: Record<
  NonNullable<RecentActivityItem["icon"]>,
  React.ElementType
> = {
  upload: Upload,
  review: FileText,
  approve: CheckCircle2,
  file: Rocket,
  note: Sparkles,
};

export function TaxpayerDashboard({
  displayName,
  activeDraftCount = 0,
  approvedDraftCount = 0,
  defaultTaxYear,
  activeFilings = [],
  approvedFilings = [],
  recentActivity = [],
}: TaxpayerDashboardProps) {
  const hasActiveFiling = activeDraftCount > 0;
  const hasApprovedFiling = approvedDraftCount > 0;
  const firstName = displayName.split(" ")[0] || displayName;
  const primaryFiling = activeFilings[0];
  const primaryApprovedFiling = approvedFilings[0];
  const primaryVisibleFiling = primaryFiling ?? primaryApprovedFiling;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Warm welcome hero ─────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-amanah/10 via-card to-card p-6 shadow-sm md:p-8">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-amanah/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 md:flex-col md:items-start md:justify-between">
          <div className="max-w-2xl">
            <Badge
              variant="outline"
              className="mb-3 border-amanah/25 bg-amanah/10 text-amanah"
            >
              <Sparkles className="mr-1.5 h-3 w-3" />
              Your Tax Daftar
            </Badge>
            <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-4xl">
              Hello, {firstName}
            </h1>
            <p className="mt-3 text-sm text-muted-foreground md:text-base">
              {hasActiveFiling
                ? "Filing your tax return doesn't have to be stressful. Answer a few simple questions, upload your documents, and TaxRocket takes care of the rest."
                : "Filing your tax return doesn't have to be stressful. Answer a few simple questions, upload your documents, and TaxRocket takes care of the rest."}
            </p>
          </div>
          <div className="flex flex-col gap-2.5 sm:flex-row md:shrink-0">
            {hasActiveFiling ? (
              <Button asChild size="lg" className="gap-2 shadow-sm">
                <Link href={`/tax/new?draftId=${primaryFiling?.id}`}>
                  Continue Filing
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            ) : hasApprovedFiling && primaryApprovedFiling ? (
              <Button asChild size="lg" className="gap-2 shadow-sm">
                <Link href={`/tax/new?draftId=${primaryApprovedFiling.id}`}>
                  Open Approved Filing
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <Button asChild size="lg" className="gap-2 shadow-sm">
                <Link href="/tax/new">
                  <Rocket className="h-4 w-4" />
                  Start New Filing
                </Link>
              </Button>
            )}
            <Button asChild size="lg" variant="outline" className="gap-2">
              <Link href="/tax/guide#how-it-works">
                How it works
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>

        {/* Live progress preview of the primary filing, right inside the hero. */}
        {primaryVisibleFiling && (
          <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/70 p-4 backdrop-blur-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">
                Tax Year {primaryVisibleFiling.taxYear}
                {primaryVisibleFiling.taxpayerName
                  ? ` · ${primaryVisibleFiling.taxpayerName}`
                  : ""}
              </p>
              <FilingProgressPill
                currentStepIndex={primaryVisibleFiling.currentStep as number}
                pipelineStartIndex={primaryVisibleFiling.pipelineStartIndex}
                status={primaryVisibleFiling.status}
              />
            </div>
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs text-amanah"
            >
              <Link href={`/tax/new?draftId=${primaryVisibleFiling.id}`}>
                Open <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          </div>
        )}
      </section>

      {/* ── Status KPI strip ──────────────────────────────────────── */}
      <WorkflowKpiStrip>
        <WorkflowKpiCard
          label="Active filings"
          value={String(activeDraftCount)}
          sub={
            hasActiveFiling ? "In progress right now" : "None yet — start below"
          }
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Ready to file"
          value={String(approvedDraftCount)}
          sub={
            hasApprovedFiling
              ? "Approved & packet-ready"
              : "Approve a packet to unlock"
          }
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Recent activity"
          value={String(recentActivity.length)}
          sub={
            recentActivity.length
              ? "Events in the last few days"
              : "Nothing yet"
          }
        />
        <WorkflowKpiCard
          label="Tax year"
          value={String(defaultTaxYear ?? new Date().getFullYear())}
          sub="Default for new filings"
        />
      </WorkflowKpiStrip>

      {/* ── Recent activity ───────────────────────────────────────── */}
      {recentActivity.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Recent activity
            </h2>
            <Link
              href="/tax/history"
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-amanah transition-colors hover:bg-amanah/10"
            >
              View all
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <Card>
            <CardContent className="divide-y p-0">
              {recentActivity.slice(0, 6).map((item) => {
                const Icon = activityIconMap[item.icon ?? "note"];
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-1.5 p-4 sm:flex-row sm:items-center sm:gap-3"
                  >
                    {/* Icon + label — always in one row */}
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </div>
                      <p className="truncate text-sm font-medium text-foreground">
                        {item.label}
                      </p>
                    </div>

                    {/* Timestamp: on mobile sits below label (indented past
                        the icon), on desktop stays inline at the end */}
                    <span className="flex items-center gap-1 self-start pl-11 text-xs text-muted-foreground sm:shrink-0 sm:self-auto sm:pl-0">
                      <CalendarClock className="h-3 w-3 shrink-0" />
                      {item.timestamp}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
