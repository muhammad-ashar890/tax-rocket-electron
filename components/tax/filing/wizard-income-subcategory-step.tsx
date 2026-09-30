"use client";

import { AlertTriangle, CheckCircle2, Layers3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StepHeading } from "@/components/tax/wizard-ui";
import {
  getTy2026SourceForStep,
  getTy2026SubcategoryDetailFields,
  getTy2026SubcategoryOptions,
  getTy2026SubcategoryStep,
  type Ty2026IncomeSelectionInput,
  type Ty2026SelectionUserDetails,
  type Ty2026SubcategoryStepKey,
} from "@/lib/tax/rules/ty2026/subcategories";

// Subcategory cards hidden until the client confirms the underlying rule.
// The filter is UI-only (data + suites still see them) so saved drafts and
// the 152-rule coverage pins keep passing. Restore by deleting this set.
const HIDDEN_PENDING_CONFIRMATION: ReadonlySet<string> = new Set([
  "bank_profit:sukuk-individual-aop-below-1m",
  "foreign_income_assets:1db-sukuk-individual-aop-below-1m",
]);

// Pension amount/age bands are derived automatically (ledger pension amount
// + date of birth), so those cards never render. Unlike the set above this
// is permanent, not awaiting confirmation.
const AUTO_DERIVED_NO_CARD: ReadonlySet<string> = new Set([
  "pension:pension-up-to-10m",
  "pension:pension-above-10m-below-age-70",
]);

type WizardIncomeSubcategoryStepProps = Readonly<{
  currentStepKey: Ty2026SubcategoryStepKey;
  selections: readonly Ty2026IncomeSelectionInput[];
  onToggle: (selection: Ty2026IncomeSelectionInput) => void;
  onDetailsChange: (selection: Ty2026IncomeSelectionInput) => void;
}>;

export function WizardIncomeSubcategoryStep({
  currentStepKey,
  selections,
  onToggle,
  onDetailsChange,
}: WizardIncomeSubcategoryStepProps) {
  const source = getTy2026SourceForStep(currentStepKey);
  const step = getTy2026SubcategoryStep(source);
  const options = getTy2026SubcategoryOptions(source).filter((option) => {
    const key = `${option.source}:${option.subcategory}`;
    return (
      !HIDDEN_PENDING_CONFIRMATION.has(key) && !AUTO_DERIVED_NO_CARD.has(key)
    );
  });
  const selectedSubcategories = new Set(
    selections
      .filter((selection) => selection.source === source)
      .map((selection) => selection.subcategory),
  );

  if (!step) return null;

  return (
    <div className="space-y-6">
      <StepHeading title={step.title} description={step.description} />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">Tax Year 2026</Badge>
        <span>{options.length} categories available</span>
        <span>•</span>
        <span>{selectedSubcategories.size} selected</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = selectedSubcategories.has(option.subcategory);
          const needsDetail =
            option.implementationStatus === "NEEDS_EXTERNAL_DETAIL";
          const fields = getTy2026SubcategoryDetailFields(
            option.source,
            option.subcategory,
          );
          const existing = selections.find(
            (selection) =>
              selection.source === option.source &&
              selection.subcategory === option.subcategory,
          );

          return (
            <div
              key={`${option.source}:${option.subcategory}`}
              className={`rounded-xl border transition ${
                selected
                  ? "border-amanah bg-amanah/5 shadow-sm"
                  : "border-border bg-card hover:border-amanah/40 hover:bg-muted/30"
              }`}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  onToggle({
                    source: option.source,
                    subcategory: option.subcategory,
                  })
                }
                className="w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      selected
                        ? "bg-amanah text-white"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {selected ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Layers3 className="h-4 w-4" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">
                      {option.label}
                    </p>
                    {option.ruleCount > 1 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {option.ruleCount} amount/rate bands
                      </p>
                    )}
                    {needsDetail && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          Selection allowed; final calculation needs client
                          confirmation.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </button>

              {selected && fields.length > 0 && (
                <div className="space-y-3 border-t border-border/70 p-4 pt-3">
                  {fields.map((field) => {
                    if (field.checkbox === true) {
                      return (
                        <label
                          key={field.key}
                          className="flex cursor-pointer items-start gap-2.5"
                        >
                          <input
                            type="checkbox"
                            checked={
                              existing?.details?.[field.key] === true
                            }
                            onChange={(event) => {
                              onDetailsChange({
                                source: option.source,
                                subcategory: option.subcategory,
                                details: {
                                  ...(existing?.details ?? {}),
                                  [field.key]: event.target.checked,
                                },
                              });
                            }}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                          />
                          <span>
                            <span className="text-xs font-semibold text-foreground">
                              {field.label}
                              {field.required ? " *" : ""}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                              {field.hint}
                            </span>
                          </span>
                        </label>
                      );
                    }
                    const current = existing?.details?.[field.key];
                    return (
                      <label key={field.key} className="block">
                        <span className="text-xs font-semibold text-foreground">
                          {field.label}
                          {field.required ? " *" : ""}
                        </span>
                        <input
                          type="number"
                          min={field.min}
                          step={field.wholeNumber ? 1 : "any"}
                          inputMode="decimal"
                          placeholder="0"
                          value={typeof current === "number" ? current : ""}
                          onChange={(event) => {
                            const raw = event.target.value;
                            const parsed =
                              raw === "" ? undefined : Number(raw);
                            const next: Ty2026SelectionUserDetails = {
                              ...(existing?.details ?? {}),
                            };
                            if (parsed === undefined || Number.isNaN(parsed)) {
                              delete next[field.key];
                            } else {
                              next[field.key] = parsed as never;
                            }
                            onDetailsChange({
                              source: option.source,
                              subcategory: option.subcategory,
                              details: next,
                            });
                          }}
                          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                          {field.hint}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Select all that apply. Amount-specific slabs are chosen later from each
        saved income record; they are not separate income sources.
      </p>
    </div>
  );
}
