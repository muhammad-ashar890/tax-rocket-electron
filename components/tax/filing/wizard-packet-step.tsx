"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";
import type { PortalMappingGaps } from "@/components/tax/filing/config/filing-wizard-config";

type FilingPacketSummary = {
  id: string;
  version: number;
  packetHash: string;
  status: string;
  taxPayable: number;
  refundDue: number;
  pdfUrl?: string | null;
  mappingGaps?: PortalMappingGaps | null;
};

/** One priced income source from the latest calculation. */
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
};

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source.replaceAll("_", " ");
}

function manualEntryLabel(category: string) {
  switch (category) {
    case "RECONCILIATION_ADJUSTMENT_INFLOW":
      return "Other reconciliation amount";
    case "RECONCILIATION_ADJUSTMENT_OUTFLOW":
      return "Reconciliation adjustment";
    default:
      return sourceLabel(category.toLowerCase());
  }
}

function manualEntryHint(category: string) {
  switch (category) {
    case "RECONCILIATION_ADJUSTMENT_INFLOW":
      return "Tell TaxRocket which FBR/IRIS field should receive this amount, or confirm that it should not be entered anywhere.";
    case "RECONCILIATION_ADJUSTMENT_OUTFLOW":
      return "Tell TaxRocket how this adjustment should be reported in FBR IRIS, or confirm that it should not be entered anywhere.";
    default:
      return "This item will not be entered automatically.";
  }
}

type WizardPacketStepProps = Readonly<{
  draftId?: string;
  filingPacket: FilingPacketSummary | null;
  filingSummary: {
    reconciliationGap: number | null;
    taxableIncome: number | null;
    taxPayable: number | null;
    refundDue: number | null;
    taxCalculationStatus: string;
    taxBreakdown?: TaxBreakdownLine[];
    finalTaxDue?: number;
    assessableTaxDue?: number;
  } | null;
  generatingPacket: boolean;
  generatingPdf: boolean;
  packetError: string | null;
  /** Income the coverage gate refused; non-empty offers the explicit override. */
  packetUnmappedSources: { category: string; totalAmount: number }[];
  onGeneratePacket: (acceptUnmapped?: unknown) => void | Promise<void>;
  onGeneratePdf: () => void;
  irisLoginConfirmed: boolean;
  onIrisLoginChange: (checked: boolean) => void;
}>;

/**
 * The packet tells us which ledger categories it could NOT place on an IRIS line
 * (P0 `mappingGaps`). Showing that here — before approval — is the difference
 * between "the agent failed" and "these four sources are manual, by design".
 */
function PortalMappingGapNotice({
  gaps,
}: {
  gaps: PortalMappingGaps | null | undefined;
}) {
  if (!gaps) {
    return (
      <p className="text-xs text-muted-foreground">
        The packet does not yet have its manual-entry notes. Generate it again
        to see which amounts you will enter yourself in IRIS.
      </p>
    );
  }
  const unmapped = gaps.unmappedCategories || [];
  const computed = gaps.skippedComputedCodes || [];
  const unproven = gaps.captureUnverified || [];
  const mismatches = gaps.pensionSplitMismatch || [];
  if (
    !unmapped.length &&
    !computed.length &&
    !mismatches.length &&
    !unproven.length
  ) {
    return (
      <p className="text-xs text-muted-foreground">
        No additional manual entries are currently needed for this packet.
      </p>
    );
  }
  const money = (value: number) => `PKR ${Math.round(value).toLocaleString()}`;
  return (
    <div className="overflow-hidden rounded-xl border border-amber-500/40 bg-amber-50/40 dark:bg-amber-500/5">
      <div className="border-b border-amber-500/30 px-4 py-3">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Manual entry still required
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The desktop agent will fill the supported items. You will handle the
          amounts listed below yourself in IRIS.
        </p>
      </div>
      {unmapped.length > 0 && (
        <div className="px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Items you will enter in IRIS
          </p>
          <ul className="mt-2 space-y-1">
            {unmapped.map((gap) => (
              <li
                key={gap.category}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <span>
                  {manualEntryLabel(gap.category)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {manualEntryHint(gap.category)}
                  </span>
                </span>
                <span className="font-medium tabular-nums">
                  {money(gap.totalAmount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {computed.length > 0 && (
        <div className="border-t border-amber-500/20 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Amounts IRIS calculates automatically
          </p>
          <ul className="mt-2 space-y-1">
            {computed.map((row) => (
              <li
                key={row.code}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <span>{row.description}</span>
                <span className="tabular-nums text-muted-foreground">
                  {money(row.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unproven.length > 0 && (
        <div className="border-t border-amber-500/20 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Items requiring your review
          </p>
          <ul className="mt-2 space-y-1">
            {unproven.map((row) => (
              <li
                key={`${row.code}-${row.category}`}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <span>{row.description}</span>
                <span className="tabular-nums text-muted-foreground">
                  {money(row.amount)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            The agent could not safely confirm an editable IRIS field for these
            items, so it will not guess. Review and handle them directly in
            IRIS.
          </p>
        </div>
      )}
      {mismatches.length > 0 && (
        <div className="border-t border-amber-500/20 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Pension split does not match the ledger
          </p>
          <ul className="mt-2 space-y-1">
            {mismatches.map((mismatch) => (
              <li
                key={mismatch.entryId}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <span className="text-muted-foreground">
                  The pension amount and its tax split do not match. Review the
                  pension figures before continuing.
                </span>
                <span className="font-medium tabular-nums">
                  {money(mismatch.ledgerAmount)} vs{" "}
                  {money(mismatch.engineSplitTotal)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WizardPacketStep({
  draftId,
  filingPacket,
  filingSummary,
  generatingPacket,
  generatingPdf,
  packetError,
  packetUnmappedSources,
  onGeneratePacket,
  onGeneratePdf,
  irisLoginConfirmed,
  onIrisLoginChange,
}: WizardPacketStepProps) {
  const [acceptUnmapped, setAcceptUnmapped] = useState(false);
  const taxCalculationReady =
    filingSummary?.taxCalculationStatus === "ESTIMATE";
  const money = (value: number | null | undefined) =>
    !taxCalculationReady || value === null || value === undefined
      ? "Pending"
      : `PKR ${value.toLocaleString()}`;

  // Always formats, unlike `money`: the breakdown is only rendered once a
  // calculation exists, so its figures are never pending.
  const amount = (value: number) => `PKR ${Math.round(value).toLocaleString()}`;

  const breakdown = taxCalculationReady
    ? (filingSummary?.taxBreakdown ?? [])
    : [];
  const finalTaxDue = filingSummary?.finalTaxDue ?? 0;
  const assessableTaxDue = filingSummary?.assessableTaxDue ?? 0;
  const hasFinalTax = finalTaxDue > 0;

  const totals = breakdown.reduce(
    (running, line) => ({
      income: running.income + line.income,
      baseTax: running.baseTax + line.baseTax,
      surcharge: running.surcharge + line.surcharge,
      taxDue: running.taxDue + line.taxDue,
    }),
    { income: 0, baseTax: 0, surcharge: 0, taxDue: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="min-w-0">
          <StepHeading
            title="Your filing packet"
            description="Generate an immutable snapshot of your current filing data before approval."
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            onClick={() =>
              void onGeneratePacket(
                packetUnmappedSources.length > 0 && acceptUnmapped
                  ? true
                  : false,
              )
            }
            disabled={generatingPacket || !draftId}
            className="gap-2 bg-[#376952] text-white hover:bg-[#2e5a44]"
          >
            {generatingPacket ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {generatingPacket
              ? "Generating..."
              : filingPacket
                ? "Generate New Version"
                : "Generate Packet Snapshot"}
          </Button>

          {filingPacket &&
            (filingPacket.pdfUrl ? (
              <Button type="button" variant="outline" asChild className="gap-2">
                <a href={filingPacket.pdfUrl} download>
                  <Download className="h-4 w-4" />
                  Download PDF
                </a>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={onGeneratePdf}
                disabled={generatingPdf}
                className="gap-2"
              >
                {generatingPdf && <Loader2 className="h-4 w-4 animate-spin" />}
                {generatingPdf ? "Generating PDF..." : "Generate PDF"}
              </Button>
            ))}
        </div>
      </div>

      {packetError && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {packetError}
        </div>
      )}

      {packetUnmappedSources.length > 0 && (
        <div
          role="group"
          aria-label="Packet coverage override"
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        >
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={acceptUnmapped}
              onChange={(event) => setAcceptUnmapped(event.target.checked)}
            />
            <span>
              <span className="font-medium text-amber-800 dark:text-amber-300">
                I have confirmed the FBR/IRIS field for these amounts, or that
                they should not be entered anywhere.
              </span>{" "}
              <span className="text-muted-foreground">
                {packetUnmappedSources
                  .map(
                    (gap) =>
                      `${manualEntryLabel(gap.category)} PKR ${gap.totalAmount.toLocaleString()}`,
                  )
                  .join(", ")}{" "}
                will be kept in the packet for your review. The desktop agent
                will not enter them automatically, so handle them in IRIS before
                saving or submitting.
              </span>
            </span>
          </label>
        </div>
      )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Packet version"
          value={filingPacket ? `v${filingPacket.version}` : "Not generated"}
        />
        <WorkflowKpiCard
          label="Packet hash"
          value={
            filingPacket ? `${filingPacket.packetHash.slice(0, 12)}…` : "—"
          }
          sub="SHA-256 snapshot fingerprint"
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
        <WorkflowKpiCard
          label="Reconciliation gap"
          value={
            filingSummary?.reconciliationGap === null ||
            filingSummary?.reconciliationGap === undefined
              ? "Pending"
              : `PKR ${Math.abs(filingSummary.reconciliationGap).toLocaleString()}`
          }
          accent="mizan"
        />
      </WorkflowKpiStrip>

      <PortalMappingGapNotice gaps={filingPacket?.mappingGaps} />

      {breakdown.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-muted/40 px-4 py-3">
            <h3 className="text-sm font-semibold">Tax by income source</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each source is charged under its own section of the rate card.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Source</th>
                  <th className="px-4 py-2 text-right font-medium">Income</th>
                  <th className="px-4 py-2 text-right font-medium">Tax</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Surcharge
                  </th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((line) => (
                  <tr
                    key={`${line.source}-${line.ruleId}`}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {sourceLabel(line.source)}
                        </span>
                        {line.isFinalTax && (
                          <span className="rounded-full bg-amanah/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amanah">
                            Final tax
                          </span>
                        )}
                      </div>
                      {line.section && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Section {line.section}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {amount(line.income)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {amount(line.baseTax)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {line.surcharge > 0 ? amount(line.surcharge) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {amount(line.taxDue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-semibold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {amount(totals.income)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {amount(totals.baseTax)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {totals.surcharge > 0 ? amount(totals.surcharge) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {amount(totals.taxDue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {hasFinalTax && (
            <div className="border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  Assessable tax:{" "}
                  <strong className="text-foreground tabular-nums">
                    {amount(assessableTaxDue)}
                  </strong>
                </span>
                <span>
                  Final tax:{" "}
                  <strong className="text-foreground tabular-nums">
                    {amount(finalTaxDue)}
                  </strong>
                </span>
              </div>
              <p className="mt-1.5">
                Tax deducted under a final-tax section discharges the liability
                on that income. Any excess deducted there is not claimed back
                automatically through this return.
              </p>
            </div>
          )}
        </div>
      )}

      {filingPacket && (
        <div className="rounded-xl border border-amanah/20 bg-amanah/5 p-4 text-sm text-amanah">
          Packet snapshot v{filingPacket.version} generated successfully.
          Approval can now be reviewed against this exact version.
        </div>
      )}

      <div
        className={`rounded-xl border p-4 transition-colors ${
          irisLoginConfirmed
            ? "border-[#376952] bg-white shadow-sm"
            : "border-gray-200 bg-white"
        }`}
      >
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={irisLoginConfirmed}
            onChange={(e) => onIrisLoginChange(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[#376952]"
          />
          <div>
            <p className="text-sm font-medium text-gray-700">
              I have created my FBR Iris login{" "}
              <span className="text-red-500">*</span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              Required before FBR Connect - the desktop agent can only file with
              your own Iris credentials. No login yet? Create it first via the{" "}
              <Link
                href="/tax/guide#ntn-cnic"
                className="font-medium text-[#376952] hover:underline"
              >
                NTN / CNIC Guide
              </Link>
              .
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}
