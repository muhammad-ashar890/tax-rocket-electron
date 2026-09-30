"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  PenLine,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";

export type ReconciliationPreview = {
  accountBalances?: Array<{
    bankName: string | null;
    accountLabel: string;
    openingBalance: number;
    closingBalance: number;
  }>;
  openingWealth: number;
  closingWealth: number;
  totalIncome: number;
  totalExpenses: number;
  gap: number;
};

export type ReconciliationMethod = "auto" | "manual";

type WizardReconciliationStepProps = Readonly<{
  draftId?: string;
  reconciliationMethod: ReconciliationMethod | null;
  reconciliationNote: string;
  reconciliationResolved: {
    method: ReconciliationMethod;
    note?: string;
  } | null;
  reconciliationPreview: ReconciliationPreview | null;
  reconciliationError: string | null;
  saving: boolean;
  onMethodChange: (method: ReconciliationMethod) => void;
  onNoteChange: (note: string) => void;
  onConfirm: () => void;
}>;

export function WizardReconciliationStep({
  draftId,
  reconciliationMethod,
  reconciliationNote,
  reconciliationResolved,
  reconciliationPreview,
  reconciliationError,
  saving,
  onMethodChange,
  onNoteChange,
  onConfirm,
}: WizardReconciliationStepProps) {
  const formatWealth = (value: number | undefined) =>
    value === undefined ? "Not available" : `PKR ${value.toLocaleString()}`;
  const gapLabel = reconciliationPreview
    ? `PKR ${Math.abs(reconciliationPreview.gap).toLocaleString()}`
    : "calculated data";
  const gapIsResolved =
    reconciliationPreview !== null &&
    reconciliationPreview.gap === 0;
  const noAdjustmentRequired =
    reconciliationResolved?.method === "auto" &&
    reconciliationResolved.note?.startsWith(
      "No Other reconciliation adjustment",
    );

  return (
    <div className="space-y-6">
      <StepHeading
        title="Wealth reconciliation (Mizan)"
        description="There's a gap between your opening and closing wealth statements — let's resolve it before moving on."
      />

      {reconciliationError && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {reconciliationError}
        </div>
      )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Opening wealth"
          value={formatWealth(reconciliationPreview?.openingWealth)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Closing wealth"
          value={formatWealth(reconciliationPreview?.closingWealth)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Unexplained gap"
          value={
            reconciliationPreview
              ? `PKR ${Math.abs(reconciliationPreview.gap).toLocaleString()}`
              : "Not available"
          }
          accent="risk"
        />
        <WorkflowKpiCard
          label="Status"
          value={reconciliationResolved ? "Resolved" : "Needs attention"}
        />
      </WorkflowKpiStrip>

      {reconciliationPreview?.accountBalances &&
        reconciliationPreview.accountBalances.length > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <p className="mb-3 text-sm font-semibold">
              Account balances included in Mizan
            </p>
            <div className="space-y-2">
              {reconciliationPreview.accountBalances.map((account, index) => (
                <div
                  key={`${account.accountLabel}-${index}`}
                  className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-[1.5fr_1fr_1fr]"
                >
                  <span className="font-medium">
                    {account.bankName
                      ? `${account.bankName} — ${account.accountLabel}`
                      : account.accountLabel}
                  </span>
                  <span>Opening: {formatWealth(account.openingBalance)}</span>
                  <span>Closing: {formatWealth(account.closingBalance)}</span>
                </div>
              ))}
              <div className="grid gap-2 border-t pt-3 text-sm font-semibold sm:grid-cols-[1.5fr_1fr_1fr]">
                <span>Combined total</span>
                <span>
                  Opening: {formatWealth(reconciliationPreview.openingWealth)}
                </span>
                <span>
                  Closing: {formatWealth(reconciliationPreview.closingWealth)}
                </span>
              </div>
            </div>
          </div>
        )}

      {reconciliationResolved ? (
        <div className="flex items-start gap-3 rounded-xl border border-amanah/20 bg-amanah/5 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-amanah" />
          <div>
            <p className="text-sm font-medium text-amanah">
              {noAdjustmentRequired
                ? "Reconciled — no adjustment required"
                : reconciliationResolved.method === "auto"
                  ? "Auto-adjustment recorded in Other"
                  : "Manually acknowledged — gap remains"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {reconciliationResolved.method === "auto"
                ? (reconciliationResolved.note ??
                  "A non-taxable Other adjustment was recorded and will remain visible in the ledger for review.")
                : reconciliationResolved.note}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-xl border border-[#B8872F]/30 bg-[#B8872F]/10 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8A641F]" />
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-[#8A641F]">
                {gapIsResolved
                  ? "Your opening and closing wealth reconcile with no unexplained gap. Confirm to continue."
                  : reconciliationPreview
                    ? `Choose how you'd like to resolve the ${gapLabel} gap.`
                    : "Add bank transactions with balances to calculate the Mizan gap."}
              </p>
              {!reconciliationPreview && draftId && (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-2"
                >
                  <Link href={`/tax/new?draftId=${draftId}`}>
                    Return to Filing Wizard
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          </div>

          {gapIsResolved ? (
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={onConfirm}
                disabled={saving || !reconciliationPreview}
                className="gap-2"
              >
                <CheckCircle2 className="h-4 w-4" />
                {saving ? "Saving..." : "Confirm Reconciliation"}
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => onMethodChange("auto")}
                  className={`flex flex-col items-center gap-3 rounded-2xl border-2 p-6 text-center transition-all ${
                    reconciliationMethod === "auto"
                      ? "border-amanah bg-amanah/5 shadow-sm"
                      : "border-border hover:border-amanah/35"
                  }`}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-amanah/25 bg-amanah/10 text-amanah">
                    <Sparkles className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">Auto-adjust</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Record the calculated gap as a non-taxable Other
                      adjustment for review.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onMethodChange("manual")}
                  className={`flex flex-col items-center gap-3 rounded-2xl border-2 p-6 text-center transition-all ${
                    reconciliationMethod === "manual"
                      ? "border-amanah bg-amanah/5 shadow-sm"
                      : "border-border hover:border-amanah/35"
                  }`}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
                    <PenLine className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">
                      Resolve manually
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Explain the source of the gap yourself.
                    </p>
                  </div>
                </button>
              </div>

              {reconciliationMethod === "manual" && (
                <textarea
                  value={reconciliationNote}
                  onChange={(event) => onNoteChange(event.target.value)}
                  rows={3}
                  placeholder="Explain the gap..."
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                />
              )}

              {reconciliationMethod && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={onConfirm}
                    disabled={
                      saving ||
                      !reconciliationPreview ||
                      (reconciliationMethod === "manual" &&
                        reconciliationNote.trim().length === 0)
                    }
                    className="gap-2"
                  >
                    {reconciliationMethod === "auto" ? (
                      <Sparkles className="h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {saving ? "Saving..." : "Confirm Resolution"}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
