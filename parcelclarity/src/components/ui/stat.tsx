import type { ReactNode } from "react";
import { Card } from "./card";

/** Large, readable number with a quiet label, the visual core of every results view. */
export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-sm font-medium text-muted">{label}</p>
      <p className="tabular text-4xl font-semibold tracking-tight">{value}</p>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </Card>
  );
}
