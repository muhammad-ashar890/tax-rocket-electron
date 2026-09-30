"use client";

import React from "react";
import {
  CheckCircle2,
  ClipboardList,
  FileSearch,
  FileText,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * FilingProgress — the ONE progress bar that appears everywhere:
 * Dashboard cards, the wizard, Documents, Ledgers/Mizan, Approval, and
 * FBR Connect. Keeping this visually identical across pages is what makes
 * the whole product feel like a single guided journey instead of five
 * separate tools.
 *
 * ⚠️ Backend contract — DO NOT change without updating every call site:
 *   - `FilingStep` union stays exactly: "setup" | "upload" | "review" | "approve" | "file"
 *   - `currentStep` / `className` props are unchanged and still required/optional respectively.
 * Everything else below (variant, onStepClick, completedSteps) is additive
 * and optional, so existing `<FilingProgress currentStep={x} />` call sites
 * keep compiling untouched.
 */
export type FilingStep = "setup" | "upload" | "review" | "approve" | "file";

const STEPS: {
  key: FilingStep;
  label: string;
  blurb: string;
  icon: React.ElementType;
}[] = [
  {
    key: "setup",
    label: "Setup",
    blurb: "Tell us about you",
    icon: ClipboardList,
  },
  { key: "upload", label: "Upload", blurb: "Add your documents", icon: Upload },
  {
    key: "review",
    label: "Review",
    blurb: "Check the numbers",
    icon: FileSearch,
  },
  {
    key: "approve",
    label: "Approve",
    blurb: "Sign off the packet",
    icon: FileText,
  },
  { key: "file", label: "File", blurb: "Submit to FBR", icon: ShieldCheck },
];

const STEP_ORDER: FilingStep[] = [
  "setup",
  "upload",
  "review",
  "approve",
  "file",
];

type FilingProgressProps = {
  currentStep: FilingStep;
  className?: string;
  /** "full" (default) shows icon + label + sub-blurb row, "compact" is a slim version for tight headers. */
  variant?: "full" | "compact";
  /** Steps the user has actually finished — defaults to everything before currentStep. Lets a page mark a step done even if currentStep hasn't advanced yet (e.g. draft created but still on setup page). */
  completedSteps?: FilingStep[];
  /** Optional — allow clicking a past/completed step to jump back. Never enabled for future steps. */
  onStepClick?: (step: FilingStep) => void;
};

export function FilingProgress({
  currentStep,
  className,
  variant = "full",
  completedSteps,
  onStepClick,
}: FilingProgressProps) {
  const currentIndex = STEP_ORDER.indexOf(currentStep);
  const isCompact = variant === "compact";

  const isStepCompleted = (stepKey: FilingStep, stepIndex: number) =>
    completedSteps
      ? completedSteps.includes(stepKey)
      : stepIndex < currentIndex;

  return (
    <nav aria-label="Filing progress" className={cn("w-full", className)}>
      <ol className="flex items-center">
        {STEPS.map((step, index) => {
          const stepIndex = STEP_ORDER.indexOf(step.key);
          const isCompleted = isStepCompleted(step.key, stepIndex);
          const isCurrent = step.key === currentStep;
          const isUpcoming = !isCompleted && !isCurrent;
          const isClickable =
            Boolean(onStepClick) && (isCompleted || isCurrent);
          const Icon = step.icon;

          const node = (
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex items-center justify-center rounded-full border-2 transition-all duration-300",
                  isCompact ? "h-7 w-7" : "h-9 w-9",
                  isCompleted && "border-amanah bg-amanah text-white shadow-sm",
                  isCurrent &&
                    "border-amanah bg-amanah/10 text-amanah ring-4 ring-amanah/10 scale-105",
                  isUpcoming &&
                    "border-border bg-background text-muted-foreground",
                )}
              >
                {isCompleted ? (
                  <CheckCircle2
                    className={isCompact ? "h-3.5 w-3.5" : "h-4.5 w-4.5"}
                  />
                ) : (
                  <Icon className={isCompact ? "h-3.5 w-3.5" : "h-4.5 w-4.5"} />
                )}
              </div>
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "text-xs font-semibold transition-colors",
                    isCompleted || isCurrent
                      ? "text-amanah"
                      : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
                {!isCompact && (
                  <span
                    className={cn(
                      "hidden text-[10px] text-muted-foreground sm:block",
                      isCurrent && "text-amanah/70",
                    )}
                  >
                    {step.blurb}
                  </span>
                )}
              </div>
            </div>
          );

          return (
            <li
              key={step.key}
              className={cn(
                "flex items-center",
                index < STEPS.length - 1 && "flex-1",
              )}
            >
              {isClickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick?.(step.key)}
                  className="rounded-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amanah/40"
                >
                  {node}
                </button>
              ) : (
                node
              )}

              {index < STEPS.length - 1 && (
                <div
                  className={cn(
                    "mx-2 h-0.5 flex-1 rounded-full transition-colors duration-500",
                    isCompact ? "mt-[-0.9rem]" : "mt-[-1.4rem]",
                    stepIndex < currentIndex ? "bg-amanah" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * FilingProgressPill — a tiny single-line summary ("Step 2 of 5 · Upload")
 * for very tight spaces like mobile headers or table rows.
 */
export function FilingProgressPill({
  currentStepIndex,
  status,
  pipelineStartIndex = 5,
  className,
}: {
  currentStepIndex: number;
  status?: string;
  /** Zero-based index of the wizard's Upload documents step for this filing branch. */
  pipelineStartIndex?: number;
  className?: string;
}) {
  // Approved/filed drafts are ready for the final FBR hand-off, regardless
  // of the branch-specific wizard index used internally.
  let mappedStepIndex =
    status === "APPROVED_FOR_FILING" || status === "FILED" ? 4 : 0;
  if (status !== "APPROVED_FOR_FILING" && status !== "FILED") {
    const pipelineOffset = currentStepIndex - pipelineStartIndex;
    if (pipelineOffset >= 7)
      mappedStepIndex = 4; // FBR Connect -> File
    else if (pipelineOffset >= 5)
      mappedStepIndex = 3; // Approval/packet -> Approve
    else if (pipelineOffset >= 2)
      mappedStepIndex = 2; // Ledgers/Mizan/review -> Review
    else if (pipelineOffset >= 0)
      mappedStepIndex = 1; // Documents/bank -> Upload
    else mappedStepIndex = 0; // Setup
  }

  const step = STEPS[mappedStepIndex];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-amanah/25 bg-amanah/10 px-2.5 py-1 text-xs font-medium text-amanah",
        className,
      )}
    >
      <step.icon className="h-3 w-3" />
      Step {mappedStepIndex + 1} of {STEPS.length} · {step.label}
    </span>
  );
}
