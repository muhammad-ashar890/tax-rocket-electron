import { useEffect, useState } from "react";

import {
  calculateReconciliationPreviewAction,
  getReconciliationAction,
  saveReconciliationAction,
  type ReconciliationInput,
} from "@/app/actions/reconciliation";
import type { ReconciliationMethod } from "@/components/tax/filing/config/filing-wizard-config";
import { toMoneyAmount, type MoneyInput } from "@/lib/money";

type ResetDownstreamSteps = (
  resetStep: number,
  preserveReconciliation?: boolean,
) => void;

type ReconciliationPreview = {
  revision: string;
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

type ReconciliationResolved = {
  method: ReconciliationMethod;
  note?: string;
};

type UseFilingReconciliationInput = {
  draftId: string | null;
  step: number;
  ledgerEntryCount: number;
  setSavingDraft: (saving: boolean) => void;
  resetDownstreamSteps: ResetDownstreamSteps;
  refreshLedger: () => Promise<void>;
};

export function useFilingReconciliation({
  draftId,
  step,
  ledgerEntryCount,
  setSavingDraft,
  resetDownstreamSteps,
  refreshLedger,
}: UseFilingReconciliationInput) {
  const [reconciliationMethod, setReconciliationMethod] =
    useState<ReconciliationMethod | null>(null);
  const [reconciliationNote, setReconciliationNote] = useState("");
  const [reconciliationResolved, setReconciliationResolved] =
    useState<ReconciliationResolved | null>(null);
  const [reconciliationError, setReconciliationError] = useState<string | null>(
    null,
  );
  const [reconciliationPreview, setReconciliationPreview] =
    useState<ReconciliationPreview | null>(null);

  useEffect(() => {
    if (!draftId) {
      setReconciliationResolved(null);
      setReconciliationPreview(null);
      return;
    }

    let isMounted = true;
    Promise.all([
      getReconciliationAction(draftId),
      calculateReconciliationPreviewAction(draftId),
    ]).then(([savedResult, previewResult]) => {
      if (!isMounted) return;

      if (!previewResult.success) {
        setReconciliationPreview(null);
        setReconciliationResolved(null);
        setReconciliationError(
          previewResult.error ?? "Add bank data before calculating Mizan",
        );
        return;
      }

      const preview = previewResult.preview;
      const record = savedResult.success ? savedResult.reconciliation : null;
      // Exact comparison: both sides come from the same Decimal figures, so
      // identical inputs now produce identical numbers. The old 0.01
      // tolerance existed only to absorb floating-point drift.
      const amountsMatch = (
        savedValue: MoneyInput,
        previewValue: number,
      ) =>
        savedValue !== null &&
        savedValue !== undefined &&
        toMoneyAmount(savedValue) === previewValue;
      const baseAmountsMatch =
        record?.reconciliationStatus === "RESOLVED" &&
        amountsMatch(record.openingWealth, preview.openingWealth) &&
        amountsMatch(record.closingWealth, preview.closingWealth);
      const expectedAutoCategory =
        preview.gap >= 0
          ? "RECONCILIATION_ADJUSTMENT_INFLOW"
          : "RECONCILIATION_ADJUSTMENT_OUTFLOW";
      const autoAdjustmentMatches =
        record?.reconciliationMethod === "auto" &&
        amountsMatch(record.reconciliationGap, 0) &&
        (preview.gap === 0
          ? toMoneyAmount(record.autoAdjustmentAmount) === 0
          : amountsMatch(record.autoAdjustmentAmount, Math.abs(preview.gap)) &&
            record.autoAdjustmentCategory === expectedAutoCategory);
      const manualGapMatches =
        record?.reconciliationMethod === "manual" &&
        amountsMatch(record.reconciliationGap, preview.gap);
      const savedMatchesPreview =
        baseAmountsMatch && (autoAdjustmentMatches || manualGapMatches);

      setReconciliationError(null);
      setReconciliationPreview(
        savedMatchesPreview && record?.reconciliationMethod === "auto"
          ? { ...preview, gap: 0 }
          : preview,
      );

      if (
        savedMatchesPreview &&
        (record?.reconciliationMethod === "auto" ||
          record?.reconciliationMethod === "manual")
      ) {
        setReconciliationResolved({
          method: record.reconciliationMethod,
          note: record.reconciliationNote ?? undefined,
        });
      } else {
        setReconciliationResolved(null);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [draftId, ledgerEntryCount, step]);

  async function handleConfirmReconciliation() {
    if (!reconciliationPreview) {
      setReconciliationError(
        "Add bank transactions with balances before resolving Mizan",
      );
      return;
    }

    const effectiveMethod: ReconciliationMethod =
      reconciliationPreview.gap === 0
        ? "auto"
        : (reconciliationMethod ?? "auto");

    if (
      effectiveMethod === "manual" &&
      reconciliationNote.trim().length === 0
    ) {
      return;
    }

    const input: ReconciliationInput = {
      method: effectiveMethod,
      note:
        effectiveMethod === "manual" ? reconciliationNote.trim() : undefined,
      revision: reconciliationPreview.revision,
    };

    if (!draftId) {
      setReconciliationResolved({ method: input.method, note: input.note });
      return;
    }

    setSavingDraft(true);
    setReconciliationError(null);
    const result = await saveReconciliationAction(draftId, input);
    setSavingDraft(false);

    if (!result.success || !("adjustmentAmount" in result)) {
      setReconciliationError(
        ("error" in result ? result.error : undefined) ??
          "Failed to save reconciliation",
      );
      // If source rows changed after the displayed preview, immediately show
      // the fresh authoritative values instead of leaving stale numbers on
      // screen for another confirm attempt.
      const refreshed = await calculateReconciliationPreviewAction(draftId);
      if (refreshed.success) {
        setReconciliationPreview(refreshed.preview);
        setReconciliationResolved(null);
      }
      return;
    }

    const adjustmentAmount = result.adjustmentAmount;
    resetDownstreamSteps(step, true);
    setReconciliationPreview({
      ...result.preview,
      gap: input.method === "auto" ? 0 : result.serverGap,
    });

    setReconciliationResolved({
      method: input.method,
      note:
        input.method === "auto"
          ? adjustmentAmount === 0
            ? "No Other reconciliation adjustment was required."
            : `Other adjustment recorded for PKR ${adjustmentAmount.toLocaleString()}.`
          : input.note,
    });

    if (input.method === "auto") {
      await refreshLedger();
    }
  }

  return {
    reconciliationMethod,
    reconciliationNote,
    reconciliationResolved,
    reconciliationError,
    reconciliationPreview,
    setReconciliationMethod,
    setReconciliationNote,
    setReconciliationResolved,
    setReconciliationPreview,
    handleConfirmReconciliation,
  };
}
