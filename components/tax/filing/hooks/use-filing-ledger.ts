import { useEffect, useRef, useState } from "react";

import {
  deleteLedgerEntryAction,
  getLedgerEntriesAction,
  replaceLedgerEntriesAction,
  type LedgerEntryInput,
} from "@/app/actions/ledger";
import type { PipelineStepKey } from "@/components/tax/filing/config/filing-wizard-config";
import type { WizardLedgerEntry } from "@/components/tax/filing/wizard-ledger-step";

type ResetDownstreamSteps = (
  resetStep: number,
  preserveReconciliation?: boolean,
) => void;

type UseFilingLedgerInput = {
  draftId: string | null;
  currentStepKey: string;
  combinedSteps: readonly string[];
  resetDownstreamSteps: ResetDownstreamSteps;
};

export function useFilingLedger({
  draftId,
  currentStepKey,
  combinedSteps,
  resetDownstreamSteps,
}: UseFilingLedgerInput) {
  const [ledgerEntries, setLedgerEntries] = useState<WizardLedgerEntry[]>([]);
  const [ledgerDraft, setLedgerDraft] = useState<LedgerEntryInput>({
    date: "",
    entryType: "INCOME",
    category: "",
    description: "",
    amount: "",
    source: "MANUAL",
  });
  const [savingLedger, setSavingLedger] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const ledgerHydratedRef = useRef(false);
  const previousLedgerSignatureRef = useRef<string | null>(null);

  async function refreshLedger() {
    if (!draftId) {
      setLedgerEntries([]);
      ledgerHydratedRef.current = true;
      return;
    }

    const result = await getLedgerEntriesAction(draftId);
    if (result.success) {
      const loadedEntries = result.entries as WizardLedgerEntry[];
      previousLedgerSignatureRef.current = JSON.stringify(loadedEntries);
      ledgerHydratedRef.current = true;
      setLedgerEntries(loadedEntries);
    } else {
      ledgerHydratedRef.current = true;
      setLedgerError(result.error ?? "Failed to load ledger entries");
    }
  }

  useEffect(() => {
    ledgerHydratedRef.current = false;
    previousLedgerSignatureRef.current = null;
    let isMounted = true;

    if (!draftId) {
      setLedgerEntries([]);
      ledgerHydratedRef.current = true;
      return () => {
        isMounted = false;
      };
    }

    getLedgerEntriesAction(draftId).then((result) => {
      if (!isMounted) return;
      if (result.success) {
        const loadedEntries = result.entries as WizardLedgerEntry[];
        previousLedgerSignatureRef.current = JSON.stringify(loadedEntries);
        ledgerHydratedRef.current = true;
        setLedgerEntries(loadedEntries);
      } else {
        ledgerHydratedRef.current = true;
        setLedgerError(result.error ?? "Failed to load ledger entries");
      }
    });

    return () => {
      isMounted = false;
    };
  }, [draftId]);

  useEffect(() => {
    if (!draftId || currentStepKey !== "ledgers") return;
    let isMounted = true;

    getLedgerEntriesAction(draftId).then((result) => {
      if (!isMounted || !result.success) return;
      const loadedEntries = result.entries as WizardLedgerEntry[];
      previousLedgerSignatureRef.current = JSON.stringify(loadedEntries);
      ledgerHydratedRef.current = true;
      setLedgerEntries(loadedEntries);
    });

    return () => {
      isMounted = false;
    };
  }, [draftId, currentStepKey]);

  useEffect(() => {
    if (!draftId || !ledgerHydratedRef.current) return;

    const signature = JSON.stringify(ledgerEntries);
    if (previousLedgerSignatureRef.current === null) {
      previousLedgerSignatureRef.current = signature;
      return;
    }
    if (signature === previousLedgerSignatureRef.current) return;

    previousLedgerSignatureRef.current = signature;
    const ledgerStepIndex = combinedSteps.indexOf("ledgers");
    if (ledgerStepIndex >= 0) resetDownstreamSteps(ledgerStepIndex);
  }, [draftId, ledgerEntries, combinedSteps, resetDownstreamSteps]);

  async function persistLedgerEntries(nextEntries: WizardLedgerEntry[]) {
    setLedgerEntries(nextEntries);
    setLedgerError(null);
    if (!draftId) return;

    setSavingLedger(true);
    const inputs: LedgerEntryInput[] = nextEntries.map(
      ({ id, ...entry }) => entry,
    );
    const result = await replaceLedgerEntriesAction(draftId, inputs);
    setSavingLedger(false);

    if (!result.success) {
      setLedgerError(result.error ?? "Failed to save ledger entries");
    } else if (
      nextEntries.some(
        (entry) => entry.source === "RECONCILIATION_AUTO_ADJUSTMENT",
      )
    ) {
      setLedgerEntries(
        nextEntries.filter(
          (entry) => entry.source !== "RECONCILIATION_AUTO_ADJUSTMENT",
        ),
      );
    }
  }

  function handleAddLedgerEntry() {
    const amount = Number(
      String(ledgerDraft.amount).replaceAll(",", "").trim(),
    );
    if (
      !ledgerDraft.description?.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setLedgerError("Add a description and a valid amount first");
      return;
    }

    void persistLedgerEntries([
      ...ledgerEntries,
      {
        ...ledgerDraft,
        amount,
        description: ledgerDraft.description.trim(),
      },
    ]);
    setLedgerDraft((previous) => ({
      ...previous,
      description: "",
      amount: "",
    }));
  }

  async function handleRemoveLedgerEntry(index: number) {
    const entry = ledgerEntries[index];
    if (!entry) return;

    if (!draftId || !entry.id) {
      void persistLedgerEntries(ledgerEntries.filter((_, i) => i !== index));
      return;
    }

    setSavingLedger(true);
    setLedgerError(null);
    const result = await deleteLedgerEntryAction(draftId, entry.id);
    setSavingLedger(false);

    if (!result.success) {
      setLedgerError(result.error ?? "Failed to delete ledger entry");
      return;
    }

    setLedgerEntries((current) =>
      current.filter((currentEntry) => currentEntry.id !== entry.id),
    );
  }

  return {
    ledgerEntries,
    ledgerDraft,
    savingLedger,
    ledgerError,
    setLedgerEntries,
    setLedgerDraft,
    setLedgerError,
    refreshLedger,
    handleAddLedgerEntry,
    handleRemoveLedgerEntry,
  };
}
