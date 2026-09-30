"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { deleteFilingDraftAction } from "@/app/actions/filing";
import { Button } from "@/components/ui/button";

export function DeleteDraftButton({
  draftId,
  compact = false,
  fullWidth = false,
}: {
  draftId: string;
  compact?: boolean;
  fullWidth?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    const confirmed = window.confirm(
      "Delete this draft permanently? All uploaded documents, bank data, ledgers, packets, and progress will be removed. This cannot be undone.",
    );
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await deleteFilingDraftAction(draftId);
      if (!result.success) {
        setError(result.error ?? "Failed to delete draft");
        return;
      }
      router.refresh();
    });
  }

  return (
    <span
      className={`flex flex-col gap-1 ${fullWidth ? "w-full" : "items-end"}`}
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={handleDelete}
        disabled={isPending}
        className={`gap-1.5 border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800 ${fullWidth ? "w-full justify-center" : ""}`}
        title="Delete draft"
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        {!compact && (isPending ? "Deleting..." : "Delete Draft")}
      </Button>
      {error && (
        <span className="max-w-[220px] text-right text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
