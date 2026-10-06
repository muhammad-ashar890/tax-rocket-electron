import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { JobAttention } from "@/app/actions/fbr-jobs";

const KIND_BADGE: Record<
  JobAttention["items"][number]["kind"],
  { label: string; className: string }
> = {
  problem: {
    label: "Needs your action",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  conflict: {
    label: "IRIS holds a different figure",
    className: "border-red-200 bg-red-50 text-red-800",
  },
  prefill: {
    label: "Please check",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
};

/**
 * What the agent could not enter, as a short list: what it is, what happened,
 * and what to do. Rendered from the agent's own result, so it can only say what
 * the run recorded.
 */
export function FbrAttentionPanel({
  attention,
}: Readonly<{ attention: JobAttention }>) {
  const count = attention.items.length;
  const percent =
    attention.total > 0
      ? Math.min(100, Math.round((attention.done / attention.total) * 100))
      : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {attention.remaining > 0
              ? "The agent stopped here and needs you"
              : count === 1
                ? "1 item needs your attention"
                : `${count} items need your attention`}
          </p>
          <p className="text-xs text-muted-foreground">
            {attention.done} of {attention.total} figures are already in IRIS.
            {attention.remaining > 0
              ? ` The other ${attention.remaining} will be entered after you continue.`
              : ""}
          </p>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={attention.total}
            aria-valuenow={attention.done}
            aria-label="Figures entered in IRIS"
          >
            <div
              className="h-full rounded-full bg-green-600"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </div>

      <ul className="space-y-3">
        {attention.items.map((item, index) => {
          const badge = KIND_BADGE[item.kind];
          return (
            <li
              key={`${item.kind}-${index}`}
              className="rounded-lg border bg-background p-3 shadow-sm"
            >
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
              >
                {badge.label}
              </span>
              <ul className="mt-2 divide-y">
                {item.lines.map((line) => (
                  <li
                    key={line.name}
                    className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 break-words font-medium text-foreground">
                      {line.name}
                    </span>
                    {line.amount && (
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        PKR {line.amount}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-foreground">{item.what}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  What to do:{" "}
                </span>
                {item.todo}
              </p>
            </li>
          );
        })}
      </ul>

      <p className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-700" />
        Nothing was saved, submitted, calculated or paid. The agent never
        overwrites a figure that is already in IRIS.
      </p>
    </div>
  );
}
