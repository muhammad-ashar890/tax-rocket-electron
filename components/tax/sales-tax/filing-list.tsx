"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Trash2 } from "lucide-react";

import {
  deleteSalesTaxMonthAction,
  type SalesTaxFilingSummary,
} from "@/app/actions/sales-tax";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPeriod, getAuthorityName } from "@/lib/sales-tax/profile";

import { formatIsoDate, statusLabel } from "./format";

export function SalesTaxFilingList({
  filings,
}: {
  filings: SalesTaxFilingSummary[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this draft month? Nothing has been filed."))
      return;
    setBusyId(id);
    setError(null);
    try {
      const result = await deleteSalesTaxMonthAction(id);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not delete this month. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (filings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium text-foreground">No returns started yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose &ldquo;New sales tax return&rdquo; to start your first one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {filings.map((filing) => (
        <article
          key={filing.id}
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-foreground">
                {formatPeriod({
                  year: filing.periodYear,
                  month: filing.periodMonth,
                })}
              </h3>
              <Badge variant="outline">
                {getAuthorityName(filing.authority)}
              </Badge>
              <Badge variant="outline" className="text-muted-foreground">
                {statusLabel(filing.status)}
              </Badge>
            </div>
            {filing.dueDates && (
              <p className="mt-1 text-xs text-muted-foreground">
                Payment due {formatIsoDate(filing.dueDates.payment)} · Return
                due {formatIsoDate(filing.dueDates.returnFiling)}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link href={`/tax/sales-tax/${filing.id}`}>
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </Link>
            </Button>
            {filing.status === "DRAFT" && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-red-700"
                disabled={busyId === filing.id}
                onClick={() => handleDelete(filing.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
