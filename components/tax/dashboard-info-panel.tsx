"use client";

import Link from "next/link";
import { Bell, CalendarClock, Scale, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteDraftButton } from "@/components/tax/delete-draft-button";
import type { ActiveFilingSummary } from "@/components/tax/taxpayer-dashboard";

// DashboardInfoPanel — right-hand column: Profile card, Tax Overview,
// Important Dates. Styled after the Befiler reference's right sidebar,
// but showing TaxRocket's own real state (filer type from the active
// draft, Mizan/wealth-reconciliation status) instead of generic
// marketing widgets — no "Stay Connected" social links, per the earlier
// decision to keep this purely functional.

export type NotificationSummary = {
  id: string;
  title: string;
  message: string;
  createdAt: string;
};

type DashboardInfoPanelProps = {
  displayName: string;
  email?: string;
  image?: string | null;
  taxYear: number;
  primaryFiling?: ActiveFilingSummary | null;
  hasApprovedFiling?: boolean;
  mizanStatus?: string | null;
  notifications?: NotificationSummary[];
  unreadNotificationCount?: number;
};

const STEP_LABEL: Record<string, string> = {
  setup: "Setup",
  upload: "Upload",
  review: "Review",
  approve: "Approve",
  file: "File",
};

export function DashboardInfoPanel({
  displayName,
  email,
  image,
  taxYear,
  primaryFiling,
  hasApprovedFiling,
  mizanStatus,
  notifications = [],
  unreadNotificationCount = 0,
}: DashboardInfoPanelProps) {
  const initials = displayName
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const filingStatusLabel = !primaryFiling
    ? "Not started"
    : hasApprovedFiling
      ? "Approved"
      : `In progress · ${
          primaryFiling.currentStepLabel ??
          STEP_LABEL[primaryFiling.currentStep] ??
          primaryFiling.currentStep
        }`;

  return (
    <aside className="hidden xl:block">
      <div className="space-y-4 xl:sticky xl:top-20">
        {/* Profile card */}
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-amanah text-sm font-semibold text-white">
              {image ? (
                <img
                  src={image}
                  alt={displayName}
                  className="h-full w-full object-cover"
                />
              ) : (
                initials || "TR"
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {displayName}
              </p>
              {email && (
                <p className="truncate text-xs text-muted-foreground">
                  {email}
                </p>
              )}
            </div>
          </div>
          <Link
            href="/tax/profile"
            className="mt-3 block text-center text-xs font-medium text-amanah hover:underline"
          >
            View Profile
          </Link>
        </div>

        {/* Tax overview */}
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Wallet className="h-4 w-4 text-amanah" />
            <p className="text-sm font-semibold text-foreground">
              Tax Overview ({taxYear})
            </p>
          </div>
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Filing status</dt>
              <dd className="font-medium text-foreground">
                {!primaryFiling ? (
                  <Badge
                    variant="outline"
                    className="border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]"
                  >
                    Not filed
                  </Badge>
                ) : hasApprovedFiling ? (
                  <Badge
                    variant="outline"
                    className="border-amanah/25 bg-amanah/10 text-amanah"
                  >
                    Approved
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-mizan/40 bg-mizan/20 text-mizan-foreground"
                  >
                    {filingStatusLabel}
                  </Badge>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Tax year</dt>
              <dd className="font-medium text-foreground">{taxYear}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Scale className="h-3.5 w-3.5" />
                Mizan status
              </dt>
              <dd className="font-medium text-foreground">
                {mizanStatus === "RESOLVED" ? "Resolved" : "Not checked yet"}
              </dd>
            </div>
          </dl>
          <Button asChild size="sm" className="mt-4 w-full gap-2">
            <Link
              href={
                primaryFiling
                  ? `/tax/new?draftId=${primaryFiling.id}`
                  : "/tax/new"
              }
            >
              {primaryFiling
                ? hasApprovedFiling
                  ? "Open Approved Filing"
                  : "Continue Filing"
                : "File Your Return Now"}
            </Link>
          </Button>
          {primaryFiling &&
            primaryFiling.status !== "FILED" &&
            !hasApprovedFiling && (
              <div className="mt-2">
                <DeleteDraftButton draftId={primaryFiling.id} fullWidth />
              </div>
            )}
        </div>

        {/* Important dates */}
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-amanah" />
            <p className="text-sm font-semibold text-foreground">
              Important Dates
            </p>
          </div>
          <div className="space-y-3">
            <DateRow
              month="SEP"
              day="30"
              label="Individual Return Deadline"
              note={`Tax year ${taxYear}`}
            />
            <DateRow
              month="DEC"
              day="31"
              label="Company Return Deadline"
              note="AOP / Company filers"
            />
          </div>
        </div>

        {/* Notifications teaser — small, non-marketing */}
        {notifications.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border bg-card p-4 shadow-sm">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Bell className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                No new notices
              </p>
              <p className="text-xs text-muted-foreground">
                FBR notices will show up here.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-amanah" />
                <p className="text-sm font-semibold text-foreground">Notices</p>
              </div>
              {unreadNotificationCount > 0 && (
                <Badge
                  variant="outline"
                  className="border-red-200 bg-red-50 text-red-600"
                >
                  {unreadNotificationCount} new
                </Badge>
              )}
            </div>
            <div className="space-y-2.5">
              {notifications.slice(0, 3).map((notification) => (
                <div key={notification.id} className="text-sm">
                  <p className="font-medium text-foreground">
                    {notification.title}
                  </p>
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {notification.message}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function DateRow({
  month,
  day,
  label,
  note,
}: {
  month: string;
  day: string;
  label: string;
  note: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex w-11 shrink-0 flex-col items-center rounded-lg border bg-muted/40 py-1">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          {month}
        </span>
        <span className="text-sm font-bold text-foreground">{day}</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}
