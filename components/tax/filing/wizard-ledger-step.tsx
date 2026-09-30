"use client";

import { Plus, Trash2, Scale } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";
import type { LedgerEntryInput } from "@/app/actions/ledger";
import { getTaxYearDateInputBounds } from "@/lib/tax/tax-year-period";

export type WizardLedgerEntry = LedgerEntryInput & {
  id?: string;
  bankName?: string | null;
  accountLabel?: string | null;
};

type WizardLedgerStepProps = Readonly<{
  taxYear: number;
  ledgerEntries: WizardLedgerEntry[];
  ledgerDraft: LedgerEntryInput;
  savingLedger: boolean;
  ledgerError: string | null;
  onDraftChange: (patch: Partial<LedgerEntryInput>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}>;

export function WizardLedgerStep({
  taxYear,
  ledgerEntries,
  ledgerDraft,
  savingLedger,
  ledgerError,
  onDraftChange,
  onAdd,
  onRemove,
}: WizardLedgerStepProps) {
  const taxYearBounds = getTaxYearDateInputBounds(taxYear);
  const counts = {
    INCOME: ledgerEntries.filter((entry) => entry.entryType === "INCOME")
      .length,
    EXPENSE: ledgerEntries.filter((entry) => entry.entryType === "EXPENSE")
      .length,
    ASSET: ledgerEntries.filter((entry) => entry.entryType === "ASSET").length,
    LIABILITY: ledgerEntries.filter((entry) => entry.entryType === "LIABILITY")
      .length,
    OTHER: ledgerEntries.filter((entry) => entry.entryType === "OTHER").length,
  };

  return (
    <div className="space-y-6">
      <StepHeading
        title="Your ledgers"
        description="Add or review income, expenses, assets, and liabilities for this filing."
      />

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Income entries"
          value={String(counts.INCOME)}
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Expense entries"
          value={String(counts.EXPENSE)}
        />
        <WorkflowKpiCard
          label="Asset entries"
          value={String(counts.ASSET)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Liability entries"
          value={String(counts.LIABILITY)}
        />
        <WorkflowKpiCard
          label="Other adjustments"
          value={String(counts.OTHER)}
          accent="risk"
        />
      </WorkflowKpiStrip>

      {ledgerError && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {ledgerError}
        </div>
      )}

      <Card className="border-border shadow-none">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Add ledger entry
              </h3>
              <p className="text-xs text-muted-foreground">
                Entries are saved to this filing draft.
              </p>
            </div>
            {savingLedger && (
              <span className="text-xs text-muted-foreground">Saving...</span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input
              type="date"
              min={taxYearBounds.min}
              max={taxYearBounds.max}
              value={String(ledgerDraft.date ?? "")}
              onChange={(event) => onDraftChange({ date: event.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAdd();
                }
              }}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            />
            <select
              value={ledgerDraft.entryType}
              onChange={(event) =>
                onDraftChange({ entryType: event.target.value })
              }
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
              <option value="ASSET">Asset</option>
              <option value="LIABILITY">Liability</option>
              <option value="OTHER">Other adjustment</option>
            </select>
            <input
              type="text"
              placeholder="Category"
              value={String(ledgerDraft.category ?? "")}
              onChange={(event) =>
                onDraftChange({ category: event.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAdd();
                }
              }}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            />
            <input
              type="number"
              min="0"
              placeholder="Amount"
              value={String(ledgerDraft.amount ?? "")}
              onChange={(event) =>
                onDraftChange({ amount: event.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAdd();
                }
              }}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            />
            <input
              type="text"
              placeholder="Description"
              value={String(ledgerDraft.description ?? "")}
              onChange={(event) =>
                onDraftChange({ description: event.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAdd();
                }
              }}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm sm:col-span-2 lg:col-span-3"
            />
            <Button
              type="button"
              size="sm"
              onClick={onAdd}
              disabled={savingLedger}
              className="h-10 w-full gap-1.5 lg:col-span-1"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {ledgerEntries.length > 0 ? (
        <div className="overflow-hidden rounded-xl border">
          <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
            <p className="text-sm font-semibold text-foreground">
              {ledgerEntries.length} entr
              {ledgerEntries.length === 1 ? "y" : "ies"}
            </p>
            <span className="text-xs text-muted-foreground">
              Sources:{" "}
              {Array.from(
                new Set(
                  ledgerEntries.map((entry) =>
                    entry.source === "RECONCILIATION_AUTO_ADJUSTMENT"
                      ? "System-generated"
                      : entry.source === "BANK_CLASSIFIED"
                        ? "Bank Intelligence"
                        : entry.source === "MANUAL"
                          ? "Manual"
                          : "Imported",
                  ),
                ),
              ).join(" + ")}
            </span>
          </div>
          <div className="min-w-0 max-w-full overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b bg-muted/20 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Source account</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {ledgerEntries.map((entry, index) => (
                  <tr key={entry.id ?? `${entry.description}-${index}`}>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.date || "—"}
                    </td>
                    <td className="px-4 py-3 font-medium">{entry.entryType}</td>
                    <td className="px-4 py-3">{entry.category || "—"}</td>
                    <td className="px-4 py-3">
                      {entry.bankName
                        ? `${entry.bankName} — ${entry.accountLabel ?? "Account"}`
                        : entry.source === "MANUAL"
                          ? "Manual"
                          : "—"}
                    </td>
                    <td className="px-4 py-3">{entry.description || "—"}</td>
                    <td className="px-4 py-3 text-right">
                      PKR {Number(entry.amount).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(index)}
                        disabled={savingLedger}
                        aria-label="Remove ledger entry"
                        className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <Scale className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            No ledger entries yet
          </p>
          <p className="text-xs text-muted-foreground">
            Add entries above. Document extraction can populate these ledgers
            later.
          </p>
        </div>
      )}
    </div>
  );
}
