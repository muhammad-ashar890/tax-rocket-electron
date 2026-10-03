"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  joinOtherEmployerRows,
  splitOtherEmployerRows,
} from "@/lib/tax/salary-certificate-fields";

const MAX_OTHER_EMPLOYERS = 9;

type OtherEmployerNamesFieldProps = Readonly<{
  /** The stored value: names separated by "; ". */
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}>;

/**
 * One input per other employer, with a plus button to add another. The stored
 * value stays a single "; "-separated string, so nothing downstream changes.
 */
export function OtherEmployerNamesField({
  value,
  readOnly = false,
  onChange,
}: OtherEmployerNamesFieldProps) {
  const [rows, setRows] = useState<string[]>(() => splitOtherEmployerRows(value));
  const lastEmitted = useRef(value);

  // A value that did not come from this editor (a reload, a re-extraction)
  // replaces the rows; the editor's own output never does.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setRows(splitOtherEmployerRows(value));
    }
  }, [value]);

  function commit(next: string[]) {
    setRows(next);
    const joined = joinOtherEmployerRows(next);
    lastEmitted.current = joined;
    onChange(joined);
  }

  return (
    <div className="grid gap-2 sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Other employers (optional)
        </span>
        {!readOnly && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={rows.length >= MAX_OTHER_EMPLOYERS}
            onClick={() => commit([...rows, ""])}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add employer
          </Button>
        )}
      </div>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            aria-label={`Other employer ${index + 1}`}
            placeholder="Employer name as registered with FBR"
            value={row}
            readOnly={readOnly}
            className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
            onChange={(event) =>
              commit(rows.map((r, i) => (i === index ? event.target.value : r)))
            }
            onBlur={() => {
              // A pasted "A; B" or "A, B" becomes two rows.
              if (/[;,\n]/.test(row)) {
                commit(
                  rows.flatMap((r, i) =>
                    i === index ? splitOtherEmployerRows(r) : [r],
                  ),
                );
              }
            }}
          />
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={`Remove other employer ${index + 1}`}
              onClick={() =>
                commit(rows.length > 1 ? rows.filter((_, i) => i !== index) : [""])
              }
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Add one row for each additional employer you had this year.
      </p>
    </div>
  );
}
