"use client";

import { CheckCircle2, ExternalLink, FileText, Rocket } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteDraftButton } from "@/components/tax/delete-draft-button";

export type FilingHistoryItem = {
  id: string;
  taxYear: number;
  status: string;
  filerType: string | null;
  updatedAt: string;
  packet: {
    id: string;
    version: number;
    fileUrl: string | null;
    approvalStatus: string;
    taxPayable: number | null;
    refundDue: number | null;
  } | null;
};

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function statusClass(status: string) {
  if (status === "FILED") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "APPROVED_FOR_FILING") {
    return "border-amanah/25 bg-amanah/10 text-amanah";
  }
  if (status === "NEEDS_RULES") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  return "border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]";
}

export function FilingHistoryList({
  initialFilings,
}: {
  initialFilings: FilingHistoryItem[];
}) {
  return (
    <div className="space-y-4">
      {initialFilings.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium text-foreground">No filings yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Start a filing to see it appear here.
          </p>
        </div>
      ) : (
        initialFilings.map((filing) => {
          const packet = filing.packet;
          const isCurrentApproval = filing.status === "APPROVED_FOR_FILING";

          return (
            <article
              key={filing.id}
              className="overflow-hidden rounded-xl border bg-card shadow-sm"
            >
              <div className="space-y-5 p-5 sm:p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-foreground">
                        Tax Year {filing.taxYear}
                      </h2>
                      <Badge
                        variant="outline"
                        className={statusClass(filing.status)}
                      >
                        {statusLabel(filing.status)}
                      </Badge>
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span aria-hidden="true">◷</span>
                      Updated{" "}
                      {new Date(filing.updatedAt).toLocaleDateString("en-PK")}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                    >
                      <Link href={`/tax/new?draftId=${filing.id}`}>
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open Filing
                      </Link>
                    </Button>
                    {isCurrentApproval && (
                      <Button asChild size="sm" className="gap-1.5">
                        <Link href={`/tax/fbr-connect?draftId=${filing.id}`}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          FBR Connect
                        </Link>
                      </Button>
                    )}
                    {!isCurrentApproval && filing.status !== "FILED" && (
                      <DeleteDraftButton draftId={filing.id} compact />
                    )}
                  </div>
                </div>

                <div className="grid gap-3 border-t pt-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Filer</p>
                    <p className="mt-1 text-sm font-medium capitalize">
                      {(filing.filerType ?? "Not selected").replaceAll(
                        "_",
                        " ",
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Latest packet
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {packet ? `v${packet.version}` : "Not generated"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Tax payable</p>
                    <p className="mt-1 text-sm font-medium">
                      {packet?.taxPayable !== null &&
                      packet?.taxPayable !== undefined
                        ? `PKR ${packet.taxPayable.toLocaleString()}`
                        : "Pending"}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  {packet?.fileUrl ? (
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                    >
                      <a href={`/api/packets/${packet.id}`} download>
                        <FileText className="h-3.5 w-3.5" />
                        Download Packet
                      </a>
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No PDF packet yet
                    </span>
                  )}

                  {!isCurrentApproval && packet && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Rocket className="h-3.5 w-3.5" />
                      Continue review from Open Filing
                    </span>
                  )}
                </div>
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}
