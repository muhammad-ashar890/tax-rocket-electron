"use client";

import { FileText, Scale, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";

type TaxBreakdownLine = {
  source: string;
  section: string;
  ruleId: string;
  income: number;
  baseTax: number;
  surcharge: number;
  taxDue: number;
  isFinalTax: boolean;
  rateShape: string;
  combinedRoutes?: { route: string; income: number }[];
};

type FilingSummary = {
  income: number;
  expenses: number;
  assets: number;
  liabilities: number;
  documentCount: number;
  pendingDocumentCount: number;
  reconciliationStatus: string;
  reconciliationGap: number | null;
  taxableIncome: number | null;
  taxWithheld: number | null;
  taxPayable: number | null;
  refundDue: number | null;
  taxCalculationStatus: string;
  taxpayerListStatus: "ATL" | "NON_ATL" | "LATE_FILER" | null;
  taxBreakdown?: TaxBreakdownLine[];
  finalTaxDue?: number;
  assessableTaxDue?: number;
  mixedExcessWithholding?: number;
  collectionBreakdown?: TaxBreakdownLine[];
  collectionTaxDue?: number;
};

const SOURCE_LABELS: Record<string, string> = {
  salary: "Salary",
  pension: "Pension",
  property_rent: "Rental income",
  bank_profit: "Profit on debt",
  services: "Services income",
  other_income: "Other income",
  capital_gains: "Capital gains",
  business: "Business income",
  dividend: "Dividend",
  foreign_income_assets: "Non-Resident",
  imports: "Imports",
  advance_tax: "Advance tax",
  combined_slab: "Combined slab",
};

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source.replaceAll("_", " ");
}

type WizardReviewStepProps = Readonly<{
  filingSummary: FilingSummary | null;
  filingSummaryError: string | null;
  taxCalculationError: string | null;
  withholdingWarning: string | null;
  withholdingConfirmed: boolean;
  onWithholdingConfirmChange: (checked: boolean) => void;
  calculatingTaxFor: "ATL" | "NON_ATL" | "LATE_FILER" | null;
  reconciliationResolved: boolean;
  draftId?: string;
  onCalculateTax: (status: "ATL" | "NON_ATL" | "LATE_FILER") => void;
}>;

export function WizardReviewStep({
  filingSummary,
  filingSummaryError,
  taxCalculationError,
  withholdingWarning,
  withholdingConfirmed,
  onWithholdingConfirmChange,
  calculatingTaxFor,
  reconciliationResolved,
  draftId,
  onCalculateTax,
}: WizardReviewStepProps) {
  const money = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "Pending"
      : `PKR ${value.toLocaleString()}`;

  const amount = (value: number) => `PKR ${Math.round(value).toLocaleString()}`;

  // The breakdown is only meaningful once an estimate exists; a NEEDS_RULES
  // result deliberately carries no lines.
  const breakdown =
    filingSummary?.taxCalculationStatus === "ESTIMATE"
      ? (filingSummary.taxBreakdown ?? [])
      : [];
  const collectionBreakdown =
    filingSummary?.taxCalculationStatus === "ESTIMATE"
      ? (filingSummary.collectionBreakdown ?? [])
      : [];
  const needsRules = filingSummary?.taxCalculationStatus === "NEEDS_RULES";
  const hasSalaryTaxLine = breakdown.some((line) => line.source === "salary");

  return (
    <div className="space-y-6">
      <StepHeading
        title="Review your filing"
        description="Review the totals saved against this filing before generating the packet."
      />

      {(filingSummaryError || taxCalculationError) && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {taxCalculationError ?? filingSummaryError}
        </div>
      )}

      {/* Amber, not red: the estimate is usable, but tax deducted at source
          may have been counted from both the salary certificate and the bank
          ledger. Overstated withholding produces a refund that does not
          exist, so this is shown before the packet is generated. */}
      {withholdingWarning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
          <p className="font-semibold">Check tax deducted at source</p>
          <p className="mt-1">{withholdingWarning}</p>
          <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-amber-500/20 pt-3">
            <input
              type="checkbox"
              data-testid="withholding-duplicate-confirm"
              className="mt-0.5 h-4 w-4 accent-amber-600"
              checked={withholdingConfirmed}
              onChange={(e) => onWithholdingConfirmChange(e.target.checked)}
            />
            <span>
              I confirm these ledger rows are separate payments, not the same
              deduction as the salary certificate. Filing a double-counted
              figure produces a refund that does not exist.
            </span>
          </label>
        </div>
      )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Ledger income"
          value={money(filingSummary?.income)}
          sub={
            hasSalaryTaxLine
              ? "Ledger cash inflows; a mapped certificate replaces bank pay in the salary tax base."
              : "Approved income entries in the ledger."
          }
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Expenses"
          value={money(filingSummary?.expenses)}
        />
        <WorkflowKpiCard
          label="Assets"
          value={money(filingSummary?.assets)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Liabilities"
          value={money(filingSummary?.liabilities)}
        />
        <WorkflowKpiCard
          label="Taxable income"
          value={money(filingSummary?.taxableIncome)}
        />
        <WorkflowKpiCard
          label="Tax already withheld"
          value={money(filingSummary?.taxWithheld)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Tax payable"
          value={money(filingSummary?.taxPayable)}
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Refund due"
          value={money(filingSummary?.refundDue)}
          accent="amanah"
        />
      </WorkflowKpiStrip>

      <div className="space-y-4 rounded-xl border bg-card p-4">
        {hasSalaryTaxLine && (
          <p className="rounded-lg border border-amanah/20 bg-amanah/5 p-3 text-xs text-muted-foreground">
            When a salary certificate is mapped, salary tax uses its annual
            gross amount. Bank payroll deposits stay in the ledger for cash and
            wealth reconciliation, and are not added to salary a second time.
          </p>
        )}
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Tax calculation
            </p>
            <p className="text-xs text-muted-foreground">
              Status: {filingSummary?.taxCalculationStatus ?? "NOT_CALCULATED"}
            </p>
          </div>
          {filingSummary?.taxpayerListStatus && (
            <Badge
              variant="outline"
              className="w-fit border-amanah/25 bg-amanah/10 text-amanah"
            >
              Calculated for {filingSummary.taxpayerListStatus}
            </Badge>
          )}
        </div>

        {breakdown.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-muted/20">
            <div className="border-b border-border/70 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tax by income source
              </p>
            </div>
            <ul className="divide-y divide-border/50">
              {breakdown.map((line) => (
                <li
                  key={`${line.source}-${line.ruleId}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {sourceLabel(line.source)}
                      </span>
                      {line.isFinalTax && (
                        <span className="rounded-full bg-amanah/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amanah">
                          Final tax
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {line.section ? `Section ${line.section} · ` : ""}
                      Income {amount(line.income)}
                      {line.surcharge > 0
                        ? ` · incl. surcharge ${amount(line.surcharge)}`
                        : ""}
                      {(line.combinedRoutes ?? []).length > 0 && (
                        <>
                          {" · "}
                          {(line.combinedRoutes ?? [])
                            .map(
                              (part) =>
                                `${sourceLabel(part.route)} ${amount(part.income)}`,
                            )
                            .join(" + ")}
                        </>
                      )}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {amount(line.taxDue)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2.5">
              <span className="text-sm font-semibold">Total tax</span>
              <span className="text-sm font-semibold tabular-nums">
                {amount(
                  breakdown.reduce((total, line) => total + line.taxDue, 0),
                )}
              </span>
            </div>
            {(filingSummary?.finalTaxDue ?? 0) > 0 && (
              <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
                {amount(filingSummary?.finalTaxDue ?? 0)} of this is final tax
                and is not refundable through the return. Assessable portion:{" "}
                {amount(filingSummary?.assessableTaxDue ?? 0)}.
              </p>
            )}
            {(filingSummary?.mixedExcessWithholding ?? 0) > 0 && (
              <p className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {amount(filingSummary?.mixedExcessWithholding ?? 0)} was
                withheld above the calculated liability on this mixed return.
                Confirm via CPRs that the excess sits on adjustable withholding
                before claiming it as refund — final-tax over-deduction is not
                refundable.
              </p>
            )}
          </div>
        )}

        {collectionBreakdown.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-muted/20">
            <div className="border-b border-border/70 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tax collected at source
              </p>
            </div>
            <ul className="divide-y divide-border/50">
              {collectionBreakdown.map((line) => (
                <li
                  key={`collection-${line.source}-${line.ruleId}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium">
                      {sourceLabel(line.source)}
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {line.section ? `Section ${line.section} · ` : ""}
                      {line.income > 0
                        ? `Base ${amount(line.income)}`
                        : "Fixed charge"}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {amount(line.taxDue)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2.5">
              <span className="text-sm font-semibold">
                Total collected at source
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {amount(filingSummary?.collectionTaxDue ?? 0)}
              </span>
            </div>
            <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
              Collected when the transaction happened. Not deducted from Tax
              payable automatically — claim it as credit with CPR,
              goods-declaration or bill evidence.
            </p>
          </div>
        )}

        {needsRules && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-500">
              Confirmed rules required
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This filing cannot be estimated yet. Open the calculation details
              for the specific reason, or contact your tax adviser.
            </p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Select the taxpayer-list status to use for this manual estimate.
        </p>

        <div className="grid gap-2 sm:grid-cols-3">
          {(["ATL", "LATE_FILER", "NON_ATL"] as const).map((status) => {
            const isCalculating = calculatingTaxFor === status;
            const isSelected = filingSummary?.taxpayerListStatus === status;
            return (
              <Button
                key={status}
                type="button"
                variant={isSelected ? "default" : "outline"}
                onClick={() => onCalculateTax(status)}
                disabled={calculatingTaxFor !== null || !draftId}
                className="gap-2"
              >
                {isCalculating && <Loader2 className="h-4 w-4 animate-spin" />}
                {isCalculating
                  ? "Calculating..."
                  : status === "ATL"
                    ? "Calculate for ATL"
                    : status === "LATE_FILER"
                      ? "Calculate for Late Filer"
                      : "Calculate for Non-ATL"}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border p-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amanah/10 text-amanah">
            <FileText className="h-5 w-5" />
          </div>
          <p className="font-semibold text-foreground">Document extraction</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filingSummary?.documentCount ?? 0} document(s) attached to this
            filing.
          </p>
          <Badge
            variant="outline"
            className="mt-3 border-amanah/25 bg-amanah/10 text-amanah"
          >
            {filingSummary?.pendingDocumentCount ?? 0} pending extraction
          </Badge>
        </div>

        <div className="rounded-xl border border-mizan/30 bg-mizan/5 p-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-mizan/20 text-mizan-foreground">
            <Scale className="h-5 w-5" />
          </div>
          <p className="font-semibold text-foreground">
            Wealth Reconciliation (Mizan)
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Status: {filingSummary?.reconciliationStatus ?? "UNRESOLVED"}
            {filingSummary?.reconciliationGap !== null &&
            filingSummary?.reconciliationGap !== undefined
              ? ` · Gap ${money(Math.abs(filingSummary.reconciliationGap))}`
              : ""}
          </p>
          <Badge
            variant="outline"
            className={
              reconciliationResolved
                ? "mt-3 border-amanah/25 bg-amanah/10 text-amanah"
                : "mt-3 border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]"
            }
          >
            {reconciliationResolved ? "Resolved" : "Needs attention"}
          </Badge>
        </div>
      </div>
    </div>
  );
}
