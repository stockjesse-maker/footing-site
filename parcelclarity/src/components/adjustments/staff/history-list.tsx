import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { HISTORY_EMPTY } from "@/lib/adjustments/copy";
import { IMPORT_STATUS_LABELS, IMPORT_STATUS_TONES, formatCount, formatDateRange, formatIsoDate, type ImportStatusKey } from "@/lib/adjustments/staff-copy";

/** What the list needs of an import (a subset of `ImportListRow` of queries.ts, so the screen renders without a server). */
export interface ImportListItem {
  id: string;
  name: string;
  status: ImportStatusKey;
  rowCount: number;
  committedCount: number;
  skippedCount: number;
  createdAt: string;
  committedAt: string | null;
  shipDateFrom: string | null;
  shipDateTo: string | null;
}

/** "1,240 rows", or what was imported when it is not all of them. */
export function importSizeLine(i: Pick<ImportListItem, "status" | "rowCount" | "committedCount" | "skippedCount">): string {
  if (i.status === "committed") {
    const skipped = i.skippedCount > 0 ? `, ${formatCount(i.skippedCount)} skipped as already imported` : "";
    return `${formatCount(i.committedCount)} ${i.committedCount === 1 ? "row" : "rows"} imported${skipped}`;
  }
  if (i.status === "discarded" || i.status === "withdrawn") return `${formatCount(i.rowCount)} ${i.rowCount === 1 ? "row" : "rows"} in the file; nothing is kept`;
  return `${formatCount(i.rowCount)} ${i.rowCount === 1 ? "row" : "rows"} in the file`;
}

/**
 * The imports, newest first. One row each: a stacked card on a phone, a line from 640px. Status is words plus a badge, and the whole row is
 * one link with a name that says what it opens.
 */
export function HistoryList({ imports }: { imports: ImportListItem[] }) {
  if (!imports.length) {
    return (
      <EmptyState title="No history yet">
        {HISTORY_EMPTY.replace(/^No history yet\.\s*/, "")}
      </EmptyState>
    );
  }
  return (
    <section aria-label="Imports">
      <DataList>
        {imports.map((i) => {
          const range = formatDateRange(i.shipDateFrom, i.shipDateTo);
          return (
            <DataRow key={i.id} className="p-0 sm:p-0">
              <Link href={`/app/adjustments/history/${i.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6" aria-label={`${i.name}, ${IMPORT_STATUS_LABELS[i.status]}`}>
                <span className="min-w-0">
                  <span className="block font-medium [overflow-wrap:anywhere]">{i.name}</span>
                  <span className="block text-sm text-muted">{importSizeLine(i)}</span>
                  <span className="block text-sm text-muted">
                    {range ? `Shipped ${range}. ` : ""}Uploaded {formatIsoDate(i.createdAt)}
                  </span>
                </span>
                <Badge tone={IMPORT_STATUS_TONES[i.status]} className="self-start sm:self-center">
                  {IMPORT_STATUS_LABELS[i.status]}
                </Badge>
              </Link>
            </DataRow>
          );
        })}
      </DataList>
    </section>
  );
}
