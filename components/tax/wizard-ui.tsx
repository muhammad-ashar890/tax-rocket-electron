"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small, purely-presentational building blocks shared by the new
 * FilingWizard. Kept in their own file so filing-wizard.tsx stays readable.
 * None of these touch backend types — they're pure UI.
 */

/** A big, tappable choice card — used for "Who is filing?" and "Business structure". */
export function BigChoiceCard({
  icon: Icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center gap-4 rounded-2xl border-2 p-6 text-center transition-all duration-200 sm:p-8",
        selected
          ? "border-amanah bg-amanah/5 shadow-md shadow-amanah/10"
          : "border-border bg-card hover:-translate-y-0.5 hover:border-amanah/40 hover:shadow-md",
      )}
    >
      {selected && (
        <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-amanah text-white shadow-sm">
          <Check className="h-3.5 w-3.5" />
        </span>
      )}
      <span
        className={cn(
          "inline-flex h-16 w-16 items-center justify-center rounded-2xl border transition-colors",
          selected
            ? "border-amanah/25 bg-amanah/10 text-amanah"
            : "border-border bg-muted/40 text-muted-foreground group-hover:text-amanah",
        )}
      >
        <Icon className="h-8 w-8" />
      </span>
      <div>
        <div className="text-lg font-semibold text-foreground">{title}</div>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
    </button>
  );
}

/**
 * CompactSelectableCard — a small icon+title-only box used for the income
 * source grid. Deliberately no hint/description text, per feedback to
 * keep this screen concise and scannable rather than reading like a list
 * of paragraphs.
 */
export function CompactSelectableCard({
  icon: Icon,
  label,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-center gap-2 rounded-xl border-2 p-3.5 text-center transition-all duration-150",
        selected
          ? "border-amanah bg-amanah/5 shadow-sm"
          : "border-border bg-card hover:border-amanah/35 hover:shadow-sm",
      )}
    >
      {selected && (
        <span className="absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-amanah text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
      <span
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-lg border transition-colors",
          selected
            ? "border-amanah/20 bg-amanah/10 text-amanah"
            : "border-border bg-muted/30 text-muted-foreground",
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span
        className={cn(
          "text-xs font-medium leading-tight",
          selected ? "text-amanah" : "text-foreground",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/** A compact multi-select card — used for income sources. */
export function SelectableCard({
  icon: Icon,
  label,
  hint,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3.5 text-left text-sm transition-all duration-150",
        selected
          ? "border-amanah bg-amanah/5 shadow-sm"
          : "border-border bg-card hover:border-amanah/35 hover:shadow-sm",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors",
          selected
            ? "border-amanah/20 bg-amanah/10 text-amanah"
            : "border-border bg-muted/30 text-muted-foreground",
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="flex-1">
        <span
          className={cn(
            "block font-medium",
            selected ? "text-amanah" : "text-foreground",
          )}
        >
          {label}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-amanah" />}
    </button>
  );
}

/** A friendly Yes/No/Unsure (or custom options) pill row for simple questions. */
export function PillChoiceRow({
  question,
  helper,
  options,
  value,
  onChange,
}: {
  question: string;
  helper?: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      {question && (
        <label className="text-sm font-medium text-foreground">
          {question}
        </label>
      )}
      {helper && (
        <p className="-mt-1 text-xs text-muted-foreground">{helper}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
              value === opt.value
                ? "border-amanah bg-amanah text-white shadow-sm"
                : "border-border bg-card text-foreground hover:border-amanah/40",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Step header used at the top of every wizard step's content. */
export function StepHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="space-y-1.5">
      {eyebrow && (
        <span className="text-xs font-semibold uppercase tracking-wider text-amanah">
          {eyebrow}
        </span>
      )}
      <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
        {title}
      </h2>
      {description && (
        <p className="text-sm text-muted-foreground sm:text-base">
          {description}
        </p>
      )}
    </div>
  );
}

/** Top-of-wizard step tracker — "Step 2 of 6" with a slim progress bar + dots. */
export function WizardStepTracker({
  currentStep,
  totalSteps,
  labels,
}: {
  currentStep: number;
  totalSteps: number;
  labels: string[];
}) {
  const pct =
    totalSteps <= 1 ? 100 : Math.round((currentStep / (totalSteps - 1)) * 100);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>
          Step {currentStep + 1} of {totalSteps}
        </span>
        <span className="text-amanah">{labels[currentStep]}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-amanah transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * WizardStepsRail — left-hand vertical list of steps. Renders a flat list
 * of pre-grouped items (a "group" can represent more than one underlying
 * question screen — e.g. six small one-per-screen questions can share a
 * single "Additional details" row here so the rail doesn't look
 * cluttered), each already marked completed/current by the caller.
 * Completed items are clickable to jump back; current is highlighted;
 * upcoming items are muted and inert.
 */
export type StepsRailItem = {
  label: string;
  completed: boolean;
  current: boolean;
};

/**
 * WizardStepsRailCompact — mobile/tablet replacement for the full
 * `WizardStepsRail` list.
 *
 * Problem this fixes: below the `lg` breakpoint, the wizard's 3-column
 * grid stacks into a single column, so the full steps list (Who's
 * filing → FBR connect) rendered in full above the actual question — a
 * user had to scroll past the entire journey outline just to see "Who
 * is filing?". This compact version instead shows a single
 * "Step X of Y — <current label>" row with a thin progress bar, plus an
 * optional "View all steps" toggle that expands the exact same list
 * (still respecting the completed/current/clickable rules) only when
 * the user actually asks for it.
 */
export function WizardStepsRailCompact({
  items,
  onItemClick,
}: {
  items: StepsRailItem[];
  onItemClick?: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const currentIndex = Math.max(
    0,
    items.findIndex((item) => item.current),
  );
  const currentItem = items[currentIndex];
  const progressPct =
    items.length > 0 ? ((currentIndex + 1) / items.length) * 100 : 0;

  return (
    <div className="rounded-2xl border bg-card p-3 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
            Step {currentIndex + 1} of {items.length}
          </p>
          <p className="truncate text-sm font-semibold text-amanah">
            {currentItem?.label}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          {expanded ? "Hide steps" : "View all steps"}
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-amanah transition-all duration-300"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {expanded && (
        <div className="mt-3 border-t pt-3">
          <WizardStepsRail items={items} onItemClick={onItemClick} />
        </div>
      )}
    </div>
  );
}

export function WizardStepsRail({
  items,
  onItemClick,
}: {
  items: StepsRailItem[];
  onItemClick?: (index: number) => void;
}) {
  return (
    <nav aria-label="Wizard steps" className="space-y-1">
      {items.map((item, index) => {
        const isClickable = Boolean(onItemClick) && item.completed;

        const row = (
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
              // Only the little circle/checkmark badge gets the solid
              // dark-green (amanah) fill for completed steps — per
              // direct feedback, the row itself should NOT be fully
              // green, just the checkbox indicator.
              item.current && "bg-amanah/10 font-semibold text-amanah",
              item.completed && !item.current && "text-foreground",
              !item.completed && !item.current && "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                item.current && "border-amanah bg-amanah text-white",
                item.completed &&
                  !item.current &&
                  "border-amanah bg-amanah text-white",
                !item.completed &&
                  !item.current &&
                  "border-border bg-background text-muted-foreground",
              )}
            >
              {item.completed ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className="truncate">{item.label}</span>
          </div>
        );

        return (
          <div key={item.label + index}>
            {isClickable ? (
              <button
                type="button"
                onClick={() => onItemClick?.(index)}
                className="w-full text-left"
              >
                {row}
              </button>
            ) : (
              row
            )}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * WizardSummaryPanel — the right-hand column. A single, plain "so far"
 * summary of the answers given — nothing about route classification or
 * "what happens next" messaging. Only shows rows that already have a
 * value, so it starts small and fills in as the user progresses.
 *
 * Fix: short label/value pairs (e.g. "Tax year — 2026") still sit on one
 * line, side by side. But once a value is long (e.g. a comma-separated
 * list of every selected income source), forcing it to stay right-
 * aligned next to its label on the same line squashed it into a narrow
 * column and made it hard to read. Long values now drop to their own
 * full-width line below the label instead.
 */
export function WizardSummaryPanel({
  title = "Filing Summary",
  rows,
}: {
  title?: string;
  rows: {
    label: string;
    value: string;
    details?: { label: string; value: string }[];
  }[];
}) {
  const filledRows = rows.filter((r) => Boolean(r.value));
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      {filledRows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Your answers will appear here as you go.
        </p>
      ) : (
        <dl className="space-y-3">
          {filledRows.map((row) => {
            return <SummaryRow key={row.label} row={row} />;
          })}
        </dl>
      )}
    </div>
  );
}

function SummaryRow({
  row,
}: {
  row: {
    label: string;
    value: string;
    details?: { label: string; value: string }[];
  };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const isLong = row.value.length > 22;
  const hasDetails = row.details && row.details.length > 0;

  return (
    <div
      className={cn(
        isLong || hasDetails
          ? "space-y-1"
          : "flex items-start justify-between gap-3",
        "text-sm",
      )}
    >
      <div
        className={cn(
          "flex justify-between w-full",
          isLong || hasDetails ? "" : "contents",
          hasDetails ? "cursor-pointer group" : "",
        )}
        onClick={() => hasDetails && setIsOpen(!isOpen)}
      >
        <dt
          className={cn(
            "shrink-0 text-muted-foreground",
            hasDetails &&
              "group-hover:text-foreground transition-colors flex items-center gap-1",
          )}
        >
          {row.label}
          {hasDetails && (
            <svg
              className={cn(
                "h-3 w-3 transition-transform duration-200",
                isOpen ? "rotate-180" : "rotate-0",
              )}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          )}
        </dt>
        <dd
          className={cn(
            "font-medium text-foreground",
            isLong ? "text-left" : "text-right capitalize",
          )}
        >
          {row.value}
        </dd>
      </div>
      {hasDetails && isOpen && (
        <div className="pt-2 pb-1 pl-3 border-l-2 border-[#376952]/20 space-y-1.5 mt-1.5 mb-2 animate-in fade-in slide-in-from-top-1">
          {row.details!.map((detail, i) => (
            <div
              key={detail.label || i}
              className="flex justify-between items-center text-xs"
            >
              <span className="text-foreground">{detail.value}</span>
              {detail.label && (
                <span className="text-muted-foreground font-medium">
                  {detail.label}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WizardActionCard({ blockers }: { blockers: string[] }) {
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm mt-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        Action Items
      </h3>
      {blockers.length === 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-amanah/20 bg-amanah/5 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amanah" />
          <p className="text-xs font-medium text-amanah">
            All clear! Ready to proceed.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {blockers.map((b, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-xs text-muted-foreground"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
              <span className="leading-snug">{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
