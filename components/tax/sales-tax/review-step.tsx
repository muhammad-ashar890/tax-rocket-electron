"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import type { SalesTaxReview } from "@/app/actions/sales-tax";
import { StepHeading } from "@/components/tax/wizard-ui";
import { formatRupees } from "@/lib/sales-tax/money";
import type { ReturnLine } from "@/lib/sales-tax/types";
import { cn } from "@/lib/utils";

import { formatIsoDate } from "./format";
import { ProblemList } from "./invoice-steps";

/** The return laid out in the order of the IRIS form. */
const SECTIONS: { title: string; srs: string[] }[] = [
  { title: "Input tax (purchases and imports)", srs: ["1", "2", "3", "4", "5", "6", "6a", "7", "7a", "7b", "8"] },
  { title: "Output tax (sales and exports)", srs: ["9", "10", "11", "15", "16", "17"] },
  { title: "Other amounts", srs: ["22", "23", "23a"] },
  { title: "Input tax adjusted against output tax", srs: ["24", "25", "26", "27", "28", "29", "30"] },
  { title: "Amount payable", srs: ["32", "35", "36", "37"] },
];

/** Pakistan time with a fixed locale, so the server and the browser print the same text. */
function formatApprovedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Karachi",
  });
}

const amount = (paisa: number | null) =>
  paisa === null ? "" : formatRupees(paisa).replace("Rs ", "");

function Assumptions({ review }: { review: SalesTaxReview }) {
  const { figures } = review;
  const items = [
    figures.imports.length === 0
      ? "No imports were entered. If you imported goods this month, go back and add them."
      : `${figures.imports.length} import${figures.imports.length === 1 ? "" : "s"} entered.`,
    figures.exports.length === 0
      ? "No exports were entered."
      : `${figures.exports.length} export${figures.exports.length === 1 ? "" : "s"} entered.`,
    figures.capitalGoodsRows.length === 0
      ? "No purchase was marked as a fixed asset."
      : `${figures.capitalGoodsRows.length} purchase${figures.capitalGoodsRows.length === 1 ? "" : "s"} marked as fixed assets.`,
    figures.excludedFrom8B
      ? "Your business is treated as excluded from the section 8B input tax limit."
      : "The section 8B limit (90% of output tax) is applied to your input tax.",
    "Credit carried on account of value addition tax (line 27) is not supported and is kept at zero.",
  ];
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">What this estimate assumes</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function LineRow({ line }: { line: ReturnLine }) {
  const strong = line.sr === "37" || line.sr === "35" || line.sr === "8" || line.sr === "17";
  return (
    <tr className={cn("border-t", strong && "bg-muted/30 font-semibold")}>
      <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">{line.sr}</td>
      <td className="px-3 py-2 align-top">
        <span className="text-foreground">{line.description}</span>
        {line.status === "estimate" && (
          <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
            Estimate
          </span>
        )}
        {line.note && line.sr === "24" && (
          <span className="block text-xs font-normal text-muted-foreground">{line.note}</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">{amount(line.grossValue)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">{amount(line.taxableValue)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">{amount(line.salesTax)}</td>
    </tr>
  );
}

export function ReviewStep({
  stepNumber,
  review,
  loading,
  paymentDue,
  reviewed,
  onReviewed,
}: {
  stepNumber: number;
  review: SalesTaxReview | null;
  loading: boolean;
  paymentDue: string | null;
  reviewed: boolean;
  onReviewed: (value: boolean) => void;
}) {
  if (!review || loading) {
    return (
      <div className="space-y-6">
        <StepHeading eyebrow={`Step ${stepNumber}`} title="Review your return" />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing your estimate…
        </p>
      </div>
    );
  }

  const { estimate, approval } = review;
  const approved = approval?.current === true;
  const byLine = new Map(estimate.lines.map((line) => [line.sr, line]));

  return (
    <div className="space-y-6">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title="Review your return"
        description="This is an estimate worked out from your files and figures. IRIS calculates the final amounts, and nothing has been sent to FBR."
      />

      {approved && approval && (
        <p className="flex items-start gap-2 rounded-xl border border-amanah/20 bg-amanah/5 p-3 text-sm text-foreground">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amanah" />
          <span>
            You approved this return on {formatApprovedDate(approval.approvedAt)}.
            Nothing has been sent to FBR. The IRIS filing step comes next.
          </span>
        </p>
      )}
      {approval && !approved && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            Your files or figures changed after you approved this return. Review it again and approve it again.
          </span>
        </p>
      )}

      {!estimate.canEstimate ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-foreground">
            {review.fileProblemsBlocking > 0
              ? `Your invoice files have ${review.fileProblemsBlocking} problem${review.fileProblemsBlocking === 1 ? "" : "s"} that stop the estimate. Go back to Check problems, fix the file in Excel and upload it again.`
              : "The estimate could not be prepared. Read the message below, then go back and correct it."}
          </p>
          {estimate.problems.length > 0 && <ProblemList problems={estimate.problems} />}
        </div>
      ) : (
        <>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Estimated balance payable
            </p>
            <p className="mt-1 text-2xl font-semibold text-foreground">
              {formatRupees(estimate.balancePayable ?? 0)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Estimate only; the amount IRIS shows is the one to pay.
              {paymentDue ? ` Payment is due on ${formatIsoDate(paymentDue)}.` : ""}
            </p>
          </div>

          <div className="space-y-4">
            {SECTIONS.map((section) => {
              const lines = section.srs
                .map((sr) => byLine.get(sr))
                .filter((line): line is ReturnLine => Boolean(line));
              return (
                <section key={section.title} className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
                  <div className="overflow-x-auto rounded-xl border bg-card">
                    <table className="w-full min-w-[34rem] text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Sr.</th>
                          <th className="px-3 py-2 font-medium">Description</th>
                          <th className="px-3 py-2 text-right font-medium">Value</th>
                          <th className="px-3 py-2 text-right font-medium">Taxable value</th>
                          <th className="px-3 py-2 text-right font-medium">Sales tax</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((line) => (
                          <LineRow key={line.sr} line={line} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>

          <Assumptions review={review} />

          {estimate.problems.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Please check</h3>
              <ProblemList problems={estimate.problems} />
            </section>
          )}

          {!approved && (
            <label className="flex items-start gap-3 rounded-xl border bg-card p-3.5 text-sm text-foreground">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => onReviewed(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[#376952]"
              />
              <span>
                Yes, I have reviewed these figures and the invoices behind them.
                I understand this is an estimate and IRIS decides the final amounts.
              </span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
