"use client";

import { Loader2, Save as SaveIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";

type WizardHeaderProps = Readonly<{
  hasDraft: boolean;
  isPipelinePhase: boolean;
  savingDraft: boolean;
  draftSavedAt: number | null;
  onSaveDraft: () => void;
}>;

export function WizardHeader({
  hasDraft,
  isPipelinePhase,
  savingDraft,
  draftSavedAt,
  onSaveDraft,
}: WizardHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <TaxRocketLogo showWordmark={false} />
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {hasDraft ? "Your filing" : "New tax filing"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {isPipelinePhase
              ? "Documents → Bank Intelligence → Ledgers → Reconciliation → Review → Approval → Filing Packet → FBR Connect"
              : "One simple question at a time."}
          </p>
        </div>
      </div>

      {!hasDraft && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onSaveDraft}
          disabled={savingDraft}
          className="gap-1.5 text-xs text-muted-foreground"
        >
          {savingDraft ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SaveIcon className="h-3.5 w-3.5" />
          )}
          {draftSavedAt ? "Draft saved" : "Save draft"}
        </Button>
      )}
    </div>
  );
}
