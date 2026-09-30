import { useEffect, useState } from "react";

import { confirmFilingForPacketAction } from "@/app/actions/filing";
import {
  generateFilingPacketAction,
  generateFilingPacketPdfAction,
  getLatestFilingPacketAction,
} from "@/app/actions/packet";
import { calculateTaxAction } from "@/app/actions/tax-calculation";
import { getFilingSummaryAction } from "@/app/actions/filing-summary";
import type {
  FilingPacketSummary,
  FilingSummary,
} from "@/components/tax/filing/config/filing-wizard-config";

type UseFilingFinalizationInput = {
  draftId: string | null;
  currentStepKey: string;
  setSavingDraft: (saving: boolean) => void;
  setFilingActionError: (error: string | null) => void;
  setFilingSummary: (summary: FilingSummary) => void;
  onDownstreamInvalidated: () => void;
};

export function useFilingFinalization({
  draftId,
  currentStepKey,
  setSavingDraft,
  setFilingActionError,
  setFilingSummary,
  onDownstreamInvalidated,
}: UseFilingFinalizationInput) {
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [taxCalculatedInSession, setTaxCalculatedInSession] = useState(false);
  const [calculatingTaxFor, setCalculatingTaxFor] = useState<
    "ATL" | "NON_ATL" | "LATE_FILER" | null
  >(null);
  // Advisory, not an error: the estimate is valid but a deduction may be
  // counted from both the salary certificate and the ledger.
  const [withholdingWarning, setWithholdingWarning] = useState<string | null>(
    null,
  );
  // The user's explicit confirmation that the flagged ledger rows are
  // separate payments. Session state only: the persisted proof is the packet
  // approval itself, which the server refuses while a warning stands
  // unconfirmed. Reset on every recalculation, like the approval.
  const [withholdingConfirmed, setWithholdingConfirmed] = useState(false);
  const [taxCalculationError, setTaxCalculationError] = useState<string | null>(
    null,
  );
  const [filingPacket, setFilingPacket] = useState<FilingPacketSummary | null>(
    null,
  );
  const [generatingPacket, setGeneratingPacket] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [packetError, setPacketError] = useState<string | null>(null);
  /**
   * Income the coverage gate refused to fold into the packet. Non-empty means the
   * practitioner can, deliberately, generate anyway — the amounts then travel into
   * the snapshot as manual-entry items instead of vanishing.
   */
  const [packetUnmappedSources, setPacketUnmappedSources] = useState<
    { category: string; totalAmount: number }[]
  >([]);

  useEffect(() => {
    if (!draftId) {
      setFilingPacket(null);
      return;
    }

    let isMounted = true;
    getLatestFilingPacketAction(draftId).then((result) => {
      if (!isMounted || !result.success || !result.packet) return;
      setFilingPacket(result.packet as FilingPacketSummary);
    });

    return () => {
      isMounted = false;
    };
  }, [draftId]);

  useEffect(() => {
    if (currentStepKey !== "pipeline_review") {
      setTaxCalculatedInSession(false);
    }
  }, [currentStepKey]);

  async function handleApprovalChange(checked: boolean) {
    if (!checked && filingPacket) return false;

    if (!draftId) {
      setApprovalConfirmed(checked);
      return true;
    }

    setSavingDraft(true);
    const result = await confirmFilingForPacketAction(
      draftId,
      checked,
      withholdingConfirmed,
    );
    setSavingDraft(false);

    if (!result.success) {
      setApprovalConfirmed(false);
      setFilingActionError(result.error ?? "Failed to save packet approval");
      return false;
    }

    setApprovalConfirmed(checked);
    if ("packet" in result && result.packet) {
      setFilingPacket(result.packet as FilingPacketSummary);
    }
    return true;
  }

  async function handleGeneratePacket(acceptUnmapped?: unknown) {
    if (!draftId) return;

    // Strictly `true`, because this handler is also wired to a click: a MouseEvent
    // must never read as "the practitioner accepted the coverage gap".
    const accept = acceptUnmapped === true;

    setGeneratingPacket(true);
    setPacketError(null);
    const result = await generateFilingPacketAction(draftId, {
      acceptUnmappedPortalSources: accept,
    });
    setGeneratingPacket(false);

    if (!result.success || !result.packet) {
      setPacketError(result.error ?? "Failed to generate filing packet");
      setPacketUnmappedSources(
        (
          result as {
            unmappedPortalSources?: { category: string; totalAmount: number }[];
          }
        ).unmappedPortalSources ?? [],
      );
      return;
    }

    setPacketUnmappedSources([]);
    setFilingPacket(result.packet as FilingPacketSummary);
  }

  async function handleGeneratePacketPdf() {
    if (!draftId || !filingPacket) return;

    setGeneratingPdf(true);
    setPacketError(null);
    const result = await generateFilingPacketPdfAction(draftId);
    setGeneratingPdf(false);

    if (!result.success) {
      setPacketError(result.error ?? "Failed to generate filing packet PDF");
      return;
    }

    setFilingPacket((previous) =>
      previous ? { ...previous, pdfUrl: result.pdfUrl } : previous,
    );
  }

  async function handleCalculateTax(status: "ATL" | "NON_ATL" | "LATE_FILER") {
    if (!draftId) return;

    setCalculatingTaxFor(status);
    setTaxCalculationError(null);
    setWithholdingWarning(null);
    setWithholdingConfirmed(false);
    const result = await calculateTaxAction(draftId, status);
    setCalculatingTaxFor(null);

    if (!result.success) {
      setTaxCalculationError(result.error ?? "Failed to calculate tax");
      return;
    }

    // The server supersedes any packet, revokes approval, and resets FBR
    // progress whenever a fresh ATL/Non-ATL result is saved. Mirror that
    // authoritative state locally, including the parent-owned rail state.
    setWithholdingWarning(result.withholdingWarning ?? null);
    setApprovalConfirmed(false);
    setFilingPacket(null);
    onDownstreamInvalidated();

    const refreshed = await getFilingSummaryAction(draftId);
    if (refreshed.success) {
      setFilingSummary(refreshed.summary as FilingSummary);
      setTaxCalculatedInSession(true);
    }
  }

  return {
    approvalConfirmed,
    taxCalculatedInSession,
    calculatingTaxFor,
    taxCalculationError,
    withholdingWarning,
    withholdingConfirmed,
    filingPacket,
    generatingPacket,
    generatingPdf,
    packetError,
    packetUnmappedSources,
    setApprovalConfirmed,
    setTaxCalculatedInSession,
    setFilingPacket,
    setWithholdingWarning,
    setWithholdingConfirmed,
    handleApprovalChange,
    handleGeneratePacket,
    handleGeneratePacketPdf,
    handleCalculateTax,
  };
}
