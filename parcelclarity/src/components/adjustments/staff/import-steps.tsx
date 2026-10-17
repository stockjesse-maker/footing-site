import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { IMPORT_STATUS_LABELS, IMPORT_STATUS_TONES, STEP_LABELS, type ImportStatusKey } from "@/lib/adjustments/staff-copy";

/**
 * Upload, Map columns, Check, Import. `current` is the step the person is on (5 = every step done). The current step is marked with
 * aria-current="step" and with its words as well as its fill, and a finished step says "done" in text for a screen reader.
 */
export function ImportSteps({ current }: { current: number }) {
  return (
    <ol aria-label="Import steps" className="mb-6 flex flex-wrap gap-2">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium",
              state === "current" && "bg-accent text-accent-fg",
              state === "done" && "bg-success-soft text-success",
              state === "todo" && "bg-surface text-muted",
            )}
          >
            <span className="tabular">{n}</span>
            {label}
            {state === "done" ? <span className="sr-only"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ImportStatusBadge({ status }: { status: ImportStatusKey }) {
  return <Badge tone={IMPORT_STATUS_TONES[status]}>{IMPORT_STATUS_LABELS[status]}</Badge>;
}
