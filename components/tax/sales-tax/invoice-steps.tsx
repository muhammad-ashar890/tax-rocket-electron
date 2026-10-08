"use client";

import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";

import {
  removeSalesTaxUploadAction,
  uploadSalesTaxInvoicesAction,
  type SalesTaxInvoiceState,
  type SalesTaxUploadInfo,
} from "@/app/actions/sales-tax";
import { StepHeading } from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import { formatRupees } from "@/lib/sales-tax/money";
import type { SalesTaxProblem } from "@/lib/sales-tax/types";
import { cn } from "@/lib/utils";

/**
 * The three steps that follow "Create return" in the Sales Tax wizard:
 * upload the sales file, upload the purchase file, check the problems.
 * The wizard owns the state; these components only draw it.
 */

export type InvoiceKind = "SALES" | "PURCHASES";

export const EMPTY_INVOICES: SalesTaxInvoiceState = {
  sales: null,
  purchases: null,
  problems: [],
};

const KIND_TEXT: Record<
  InvoiceKind,
  {
    title: string;
    description: string;
    fileWord: string;
    sheet: "sales" | "purchases";
  }
> = {
  SALES: {
    title: "Upload your sales invoices",
    description:
      "Use the Sales Invoice template (DSI) from IRIS with this month's sales filled in.",
    fileWord: "sales",
    sheet: "sales",
  },
  PURCHASES: {
    title: "Upload your purchase invoices",
    description:
      "Use the Purchase Invoice template (DPI) from IRIS with this month's purchases filled in.",
    fileWord: "purchases",
    sheet: "purchases",
  },
};

/** Problems that belong to one file: its own rows plus what its header says. */
export function fileProblemsFor(
  invoices: SalesTaxInvoiceState,
  kind: InvoiceKind,
): SalesTaxProblem[] {
  const text = KIND_TEXT[kind];
  return [
    ...invoices.problems.filter(
      (problem) =>
        problem.sheet === "template" &&
        problem.message.includes(`${text.fileWord} file`),
    ),
    ...invoices.problems.filter((problem) => problem.sheet === text.sheet),
  ];
}

export function problemCounts(invoices: SalesTaxInvoiceState) {
  const mustFix = invoices.problems.filter(
    (p) => p.severity !== "warning",
  ).length;
  return { mustFix, toCheck: invoices.problems.length - mustFix };
}

const countText = (upload: SalesTaxUploadInfo | null) =>
  upload
    ? `${upload.invoiceCount} invoice${upload.invoiceCount === 1 ? "" : "s"}`
    : "";

export function invoiceSummaryRows(invoices: SalesTaxInvoiceState) {
  return [
    { label: "Sales file", value: countText(invoices.sales) },
    { label: "Purchase file", value: countText(invoices.purchases) },
    {
      label: "Problems",
      value:
        invoices.sales || invoices.purchases
          ? invoices.problems.length === 0
            ? "None"
            : String(invoices.problems.length)
          : "",
    },
  ];
}

/** Action items for one of the three invoice steps (0, 1 or 2). */
export function invoiceBlockers(
  invoices: SalesTaxInvoiceState,
  invoiceStep: number,
): string[] {
  const { mustFix, toCheck } = problemCounts(invoices);
  if (invoiceStep < 2) {
    const kind: InvoiceKind = invoiceStep === 0 ? "SALES" : "PURCHASES";
    const info = kind === "SALES" ? invoices.sales : invoices.purchases;
    const word = KIND_TEXT[kind].fileWord;
    if (!info) {
      return [
        `Upload your ${word} file, or continue if you had no ${word} this month.`,
      ];
    }
    const own = fileProblemsFor(invoices, kind).length;
    return own > 0
      ? [
          `${own} problem${own === 1 ? "" : "s"} found in this file. You can fix them now or review them on the last step.`,
        ]
      : [];
  }
  if (mustFix > 0) {
    return [
      `${mustFix} to fix${toCheck > 0 ? ` and ${toCheck} to check` : ""}. Fix the file in Excel and upload it again.`,
    ];
  }
  if (toCheck > 0) {
    return [
      `${toCheck} reminder${toCheck === 1 ? "" : "s"} to read. Nothing here needs a new file.`,
    ];
  }
  if (!invoices.sales && !invoices.purchases) {
    return ["Upload at least one invoice file."];
  }
  return [];
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SEVERITY_ORDER = { refuse: 0, error: 1, warning: 2 } as const;

function severityLabel(severity: SalesTaxProblem["severity"]): string {
  if (severity === "refuse") return "Blocks the estimate";
  if (severity === "error") return "Must fix";
  return "Please check";
}

const PREVIEW_LIMIT = 25;

export function ProblemList({ problems }: { problems: SalesTaxProblem[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...problems].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.row ?? 0) - (b.row ?? 0),
  );
  const visible = showAll ? sorted : sorted.slice(0, PREVIEW_LIMIT);
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {visible.map((problem, index) => (
          <li
            key={`${problem.code}-${problem.row}-${index}`}
            className={cn(
              "rounded-xl border p-3 text-sm",
              problem.severity === "warning"
                ? "border-amber-200 bg-amber-50"
                : "border-red-200 bg-red-50",
            )}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  problem.severity === "warning"
                    ? "text-amber-600"
                    : "text-red-600",
                )}
              />
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {severityLabel(problem.severity)}
                  {problem.row ? ` · Row ${problem.row}` : ""}
                </p>
                <p className="text-foreground">{problem.message}</p>
                <p className="text-muted-foreground">{problem.action}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {sorted.length > PREVIEW_LIMIT && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show fewer" : `Show all ${sorted.length} problems`}
        </Button>
      )}
    </div>
  );
}

export function UploadStep({
  filingId,
  kind,
  stepNumber,
  invoices,
  onInvoices,
  onError,
}: {
  filingId: string;
  kind: InvoiceKind;
  stepNumber: number;
  invoices: SalesTaxInvoiceState;
  onInvoices: (next: SalesTaxInvoiceState) => void;
  onError: (message: string | null) => void;
}) {
  const text = KIND_TEXT[kind];
  const info: SalesTaxUploadInfo | null =
    kind === "SALES" ? invoices.sales : invoices.purchases;
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileProblems = fileProblemsFor(invoices, kind);

  async function handleFile(file: File | null | undefined) {
    if (!file || busy) return;
    setBusy(true);
    onError(null);
    try {
      const form = new FormData();
      form.set("filingId", filingId);
      form.set("kind", kind);
      form.set("file", file);
      const result = await uploadSalesTaxInvoicesAction(form);
      if (result.success === false) {
        onError(result.error);
        return;
      }
      onInvoices(result.invoices);
    } catch {
      onError(
        "The file could not be uploaded. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    if (busy) return;
    if (!window.confirm("Remove this file? You can upload it again later."))
      return;
    setBusy(true);
    onError(null);
    try {
      const result = await removeSalesTaxUploadAction(filingId, kind);
      if (result.success === false) {
        onError(result.error);
        return;
      }
      onInvoices(result.invoices);
    } catch {
      onError("Could not remove this file. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title={text.title}
        description={text.description}
      />

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xlsm"
        className="sr-only"
        aria-label={`Choose ${text.fileWord} invoice file`}
        onChange={(event) => handleFile(event.target.files?.[0])}
      />

      {!info ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFile(event.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors sm:p-10",
            dragging
              ? "border-amanah bg-amanah/5"
              : "border-border bg-card hover:border-amanah/40",
          )}
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amanah/20 bg-amanah/10 text-amanah">
            {busy ? (
              <Loader2 className="h-7 w-7 animate-spin" />
            ) : (
              <Upload className="h-7 w-7" />
            )}
          </span>
          <span className="text-base font-semibold text-foreground">
            {busy ? "Reading your file…" : "Choose your Excel file"}
          </span>
          <span className="text-sm text-muted-foreground">
            or drop it here · .xlsx or .xlsm · up to 8 MB
          </span>
        </button>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amanah/20 bg-amanah/10 text-amanah">
                <FileSpreadsheet className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {info.fileName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatSize(info.fileSize)} · {countText(info)}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="gap-1.5"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                Replace
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={handleRemove}
                className="gap-1.5 text-red-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border bg-card p-3">
              <dt className="text-xs text-muted-foreground">
                Value excluding sales tax
              </dt>
              <dd className="mt-1 font-semibold text-foreground">
                {formatRupees(info.valuePaisa)}
              </dd>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <dt className="text-xs text-muted-foreground">Sales tax</dt>
              <dd className="mt-1 font-semibold text-foreground">
                {formatRupees(info.taxPaisa)}
              </dd>
            </div>
          </dl>

          {fileProblems.length === 0 ? (
            <p className="flex items-center gap-2 rounded-xl border border-amanah/20 bg-amanah/5 p-3 text-sm text-amanah">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              No problems found in this file.
            </p>
          ) : (
            <ProblemList problems={fileProblems} />
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Download the template from IRIS under Invoice Management. Do not rename
        or remove its sheets or columns. These totals are only a count of what
        is in your file; the return estimate comes after your files are clean.
      </p>
    </div>
  );
}

export function CheckStep({
  invoices,
  stepNumber,
}: {
  invoices: SalesTaxInvoiceState;
  stepNumber: number;
}) {
  const problemsFor = (sheet: "sales" | "purchases") =>
    invoices.problems.filter((problem) => problem.sheet === sheet);
  const templateProblems = invoices.problems.filter(
    (problem) => problem.sheet === "template",
  );
  const { mustFix, toCheck } = problemCounts(invoices);
  const groups: { title: string; problems: SalesTaxProblem[] }[] = [
    { title: "File details", problems: templateProblems },
    { title: "Sales invoices", problems: problemsFor("sales") },
    { title: "Purchase invoices", problems: problemsFor("purchases") },
  ].filter((group) => group.problems.length > 0);
  const hasFiles = Boolean(invoices.sales || invoices.purchases);
  return (
    <div className="space-y-6">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title="Check your invoices"
        description="Fix anything marked Must fix or Blocks the estimate. Items marked Please check are reminders."
      />
      {!hasFiles ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          You have not uploaded any invoice file yet. Go back to add your sales
          or purchase file.
        </p>
      ) : groups.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-amanah/20 bg-amanah/5 p-4 text-sm text-amanah">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          No problems found. Your invoice files are ready for the next step.
        </p>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-foreground">
            <span className="font-semibold">{mustFix}</span> to fix ·{" "}
            <span className="font-semibold">{toCheck}</span> to check.
            {mustFix > 0
              ? " Fix them in Excel, then go back and use Replace to upload the file again."
              : " Nothing needs a new file."}
          </p>
          {groups.map((group) => (
            <section key={group.title} className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">
                {group.title}{" "}
                <span className="font-normal text-muted-foreground">
                  ({group.problems.length})
                </span>
              </h3>
              <ProblemList problems={group.problems} />
            </section>
          ))}
        </div>
      )}
      {hasFiles && (
        <p className="rounded-xl border bg-muted/30 p-3 text-sm text-muted-foreground">
          Next, you will add the figures that are not in your files, and then
          review your return estimate.
        </p>
      )}
    </div>
  );
}
