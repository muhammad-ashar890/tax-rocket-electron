"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import {
  createFilingDraftAction,
  saveFilingDraftAction,
  updateFilingDraftAction,
} from "@/app/actions/filing";
import FilingWizard from "@/components/tax/filing/filing-wizard";

function NewFilingPageContent() {
  const searchParams = useSearchParams();
  const resumeDraftId = searchParams.get("draftId") ?? undefined;

  async function createAction(formData: FormData) {
    const result = await createFilingDraftAction(formData);

    if (!result.success) {
      console.error("Failed to create filing draft:", result.error);
    }

    return result;
  }

  async function handleSaveDraft(formData: FormData) {
    const result = await saveFilingDraftAction(formData);

    if (!result.success) {
      console.error("Failed to save filing draft:", result.error);
    }

    return result;
  }

  async function handleAutoSave(formData: FormData) {
    if (!resumeDraftId) return;

    const taxYear = formData.get("taxYear");
    const filerType = formData.get("filerType");
    const businessStructure = formData.get("businessStructure");
    const salaryPercentage = formData.get("salaryPercentage");
    const residencyStatus = formData.get("residencyStatus");
    const currentStep = Number(formData.get("currentStep"));
    const wizardCompletionStep = Number(formData.get("wizardCompletionStep"));
    const incomeSubcategorySelections = formData
      .getAll("incomeSubcategorySelections")
      .map((value) => {
        try {
          const selection = JSON.parse(String(value)) as {
            source?: unknown;
            subcategory?: unknown;
          };
          return {
            source: String(selection.source ?? ""),
            subcategory: String(selection.subcategory ?? ""),
          };
        } catch {
          return null;
        }
      })
      .filter(
        (selection): selection is { source: string; subcategory: string } =>
          Boolean(selection?.source && selection.subcategory),
      );

    await updateFilingDraftAction(resumeDraftId, {
      taxYear: taxYear ? Number(taxYear) : undefined,
      filerType: filerType ? String(filerType) : null,
      businessStructure: businessStructure ? String(businessStructure) : null,
      salaryPercentage: salaryPercentage ? String(salaryPercentage) : null,
      residencyStatus:
        residencyStatus === "resident" || residencyStatus === "non_resident"
          ? residencyStatus
          : null,
      currentStep:
        Number.isInteger(currentStep) && currentStep >= 0
          ? currentStep
          : undefined,
      wizardCompletionStep:
        Number.isInteger(wizardCompletionStep) && wizardCompletionStep >= 0
          ? wizardCompletionStep
          : undefined,
      incomeSources: formData.getAll("incomeSources").map(String),
      incomeSubcategorySelections,
      readinessCompleted: formData.getAll("readinessCompleted").map(String),
    });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <FilingWizard
        createAction={createAction}
        onSaveDraft={handleSaveDraft}
        resumeDraftId={resumeDraftId}
        onAutoSave={handleAutoSave}
      />
    </div>
  );
}

export default function NewFilingPage() {
  return (
    <Suspense
      fallback={
        <div className="p-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <NewFilingPageContent />
    </Suspense>
  );
}
