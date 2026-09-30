"use client";

import type React from "react";
import { cn } from "@/lib/utils";
import {
  FilingProgress,
  type FilingStep,
} from "@/components/tax/filing-progress";

/**
 * WorkflowPageShell — Standardized outer wrapper for all draft-scoped workflow pages.
 *
 * ⚠️ Every exported function name and prop signature below is preserved
 * exactly from the original file. Visual changes only (spacing, soft
 * shadows, rounded corners) plus one new optional prop on WorkflowHeader
 * (`showProgress`, default true) that renders the shared FilingProgress bar
 * inline so Setup/Upload/Review/Approve/File always look like one journey.
 */
export function WorkflowPageShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-7xl flex-col gap-6 px-1 pb-10 sm:px-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * WorkflowHeader — Standardized page header section.
 *
 * Renders the FilingProgress bar (now always front-and-center by default),
 * title, description, and an optional actions slot.
 */
export function WorkflowHeader({
  progressStep,
  title,
  description,
  actions,
  statusBadge,
  showProgress = true,
}: {
  progressStep?: FilingStep;
  title: string;
  description: string;
  actions?: React.ReactNode;
  statusBadge?: React.ReactNode;
  /** New, optional — defaults to true. Set false to hide the progress bar on pages that render it elsewhere. */
  showProgress?: boolean;
}) {
  return (
    <section className="rounded-2xl border bg-card p-6 shadow-sm">
      {progressStep && showProgress && (
        <div className="mb-6 border-b pb-6">
          <FilingProgress currentStep={progressStep} />
        </div>
      )}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          {statusBadge && <div className="mb-3">{statusBadge}</div>}
          <h1 className="text-2xl font-semibold md:text-3xl">{title}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-start gap-2">
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * WorkflowKpiCard — A single KPI metric card used in the summary strip.
 *
 * Fix (take 2): the previous attempt forced character-level breaking
 * (`overflow-wrap: anywhere`) so a number like "12,450,000" would split
 * mid-digit onto a new line, and truncated the label so it disappeared
 * behind an ellipsis. Neither is acceptable. The real cause was that the
 * card itself was too narrow (4 cards squeezed into the wizard's center
 * column). The actual fix is on `WorkflowKpiStrip` below — giving these
 * cards enough width via fewer columns — combined with *normal* text
 * wrapping here (breaks only at natural word boundaries, never mid-word
 * or mid-number) and no label truncation.
 */
export function WorkflowKpiCard({
  label,
  value,
  sub,
  accent,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "amanah" | "mizan" | "indus" | "risk" | "khewra";
  children?: React.ReactNode;
}) {
  const accentCls = accent
    ? accent === "amanah"
      ? "text-amanah"
      : accent === "mizan"
        ? "text-mizan-foreground"
        : accent === "indus"
          ? "text-indus"
          : accent === "risk"
            ? "text-risk"
            : "text-khewra"
    : "text-daftar";

  // Long values (packet hashes, big currency amounts) step down in size
  // so they're more likely to fit on one line, but — given enough card
  // width from WorkflowKpiStrip — normal wrapping (only between words,
  // never mid-number) is enough on its own.
  const valueSizeCls =
    value.length > 18
      ? "text-lg sm:text-xl"
      : value.length > 12
        ? "text-xl sm:text-2xl"
        : "text-2xl";

  return (
    <div className="min-w-0 rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="text-xs uppercase leading-snug tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 break-words font-semibold leading-snug",
          valueSizeCls,
          accentCls,
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 break-words text-xs text-muted-foreground">
          {sub}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * WorkflowKpiStrip — A grid of KPI cards.
 *
 * Fix: the previous fixed `sm:grid-cols-2 lg:grid-cols-4` squeezed cards
 * far too narrow whenever this strip sits inside a constrained container
 * (e.g. the filing wizard's center column, which is itself boxed in
 * between a 220px steps rail and a 280px summary panel) — that's what
 * was pushing values like "PKR 12,450,000" onto multiple broken lines.
 * `maxColumns` lets each call site cap how wide the grid is allowed to
 * get: pass `2` for strips living inside a narrow column (as the wizard
 * now does), or leave the default `4` for full-width pages like the
 * dashboard where 4 columns always have plenty of room.
 */
export function WorkflowKpiStrip({
  children,
  className,
  maxColumns = 4,
}: {
  children: React.ReactNode;
  className?: string;
  /** Caps how many columns the grid grows to on wide screens. Defaults to 4 (previous behavior) for full-width pages; pass 2 for narrower containers. */
  maxColumns?: 2 | 4;
}) {
  const gridCls =
    maxColumns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4";
  return <div className={cn("grid gap-4", gridCls, className)}>{children}</div>;
}

/**
 * WorkflowSection — A two-column grid section for workflow content.
 */
export function WorkflowSection({
  children,
  className,
  columns = "equal",
}: {
  children: React.ReactNode;
  className?: string;
  columns?: "equal" | "primary-secondary" | "secondary-primary";
}) {
  const gridCols =
    columns === "primary-secondary"
      ? "xl:grid-cols-[1.05fr_0.95fr]"
      : columns === "secondary-primary"
        ? "xl:grid-cols-[0.95fr_1.05fr]"
        : "xl:grid-cols-[1fr_1fr]";

  return (
    <div className={cn("grid gap-6", gridCols, className)}>{children}</div>
  );
}

/**
 * WorkflowNavBar — A horizontal bar of cross-links to other workflow modules.
 */
export function WorkflowNavBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>{children}</div>
  );
}

/**
 * WorkflowNavLink — A single navigation link styled as a button.
 */
export function WorkflowNavLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-muted"
    >
      {icon}
      {label}
    </a>
  );
}

/**
 * WorkflowBlockerCard — A card that shows a blocking/warning state.
 */
export function WorkflowBlockerCard({
  icon,
  title,
  description,
  variant = "warning",
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  variant?: "success" | "warning" | "blocking";
  children?: React.ReactNode;
}) {
  const borderCls =
    variant === "success"
      ? "border-amanah/30"
      : variant === "blocking"
        ? "border-risk/30"
        : "border-mizan/40";

  const iconCls =
    variant === "success"
      ? "bg-amanah/10 text-amanah"
      : variant === "blocking"
        ? "bg-risk/15 text-risk"
        : "bg-mizan/20 text-mizan-foreground";

  return (
    <div className={cn("rounded-2xl border bg-card shadow-sm", borderCls)}>
      <div className="p-6">
        <div
          className={cn(
            "mb-3 flex h-11 w-11 items-center justify-center rounded-xl",
            iconCls,
          )}
        >
          {icon}
        </div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}

/**
 * WorkflowEmptyState — A dashed-border empty state for sections with no data.
 */
export function WorkflowEmptyState({
  message,
  sub,
}: {
  message: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      <p>{message}</p>
      {sub && <p className="mt-1 text-xs">{sub}</p>}
    </div>
  );
}

/**
 * WorkflowActivityItem — A single activity/audit event item.
 */
export function WorkflowActivityItem({
  icon,
  label,
  timestamp,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  timestamp?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {label}
      </div>
      {timestamp && (
        <p className="mt-1 text-xs text-muted-foreground">{timestamp}</p>
      )}
      {children}
    </div>
  );
}
