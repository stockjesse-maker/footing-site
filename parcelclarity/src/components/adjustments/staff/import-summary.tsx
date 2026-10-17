"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { discardImport, withdrawImport } from "@/app/actions/adjustments";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DISCARD_BUTTON, WITHDRAW_BUTTON, formatCount, formatDateRange, formatIsoDate, pluralize } from "@/lib/adjustments/staff-copy";

/** Takes a committed import back: its records are deleted (Withdraw), after a second confirmation. */
export function WithdrawControl({ importId, records }: { importId: string; records: number }) {
  const router = useRouter();
  return (
    <ConfirmAction
      label={WITHDRAW_BUTTON}
      confirmLabel="Withdraw"
      variant="danger"
      action={async () => {
        const result = await withdrawImport(importId);
        if (result.ok) router.refresh();
        return result;
      }}
    >
      {`Deletes the ${pluralize(records, "record")} this import added. Statistics change. An estimate saved from this import must be archived first.`}
    </ConfirmAction>
  );
}

/** Throws away an import that is not committed: the file and everything read from it. */
export function DiscardControl({ importId }: { importId: string }) {
  const router = useRouter();
  return (
    <ConfirmAction
      label={DISCARD_BUTTON}
      confirmLabel="Discard"
      variant="ghost"
      action={async () => {
        const result = await discardImport(importId);
        if (result.ok) router.push("/app/adjustments/history");
        return result;
      }}
    >
      The file and everything read from it are deleted. This cannot be undone.
    </ConfirmAction>
  );
}

export interface CommittedSummary {
  importId: string;
  name: string;
  committedCount: number;
  skippedCount: number;
  committedAt: string | null;
  shipDateFrom: string | null;
  shipDateTo: string | null;
}

/** The committed state: what was added, where to see it, and Withdraw. `message` is what the commit action said just now (absent on a later visit). */
export function ImportCommittedView({ summary, message, canManage }: { summary: CommittedSummary; message?: string | null; canManage: boolean }) {
  const range = formatDateRange(summary.shipDateFrom, summary.shipDateTo);
  return (
    <div className="space-y-4">
      {message ? <Alert tone="success">{message}</Alert> : null}
      <Card>
        <CardTitle>Imported</CardTitle>
        <CardDescription>
          {pluralize(summary.committedCount, "row")} added to your history{summary.committedAt ? ` on ${formatIsoDate(summary.committedAt)}` : ""}.
          {range ? ` Shipped ${range}.` : ""}
          {summary.skippedCount > 0 ? ` ${pluralize(summary.skippedCount, "row")} skipped as already imported.` : ""} The uploaded file was deleted when the import finished.
        </CardDescription>
        <p className="mt-3 text-sm text-muted">
          To see how often adjustments happen you also need the packages you shipped in the same period.{" "}
          <Link href="/app/adjustments/history/baselines" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Add packages shipped
          </Link>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link href="/app/adjustments/history/statistics" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            See how often adjustments happen
          </Link>
          {canManage ? <WithdrawControl importId={summary.importId} records={summary.committedCount} /> : null}
        </div>
        {canManage ? <p className="mt-3 text-sm text-muted">Withdrawing an import deletes the {formatCount(summary.committedCount)} records it added. You can import the file again afterwards.</p> : null}
      </Card>
    </div>
  );
}

/** A discarded or withdrawn import keeps no records and no file. */
export function ImportEndedView({ status }: { status: "discarded" | "withdrawn" }) {
  return (
    <Card>
      <CardTitle>{status === "discarded" ? "This import was discarded" : "This import was withdrawn"}</CardTitle>
      <CardDescription>{status === "discarded" ? "The file and everything read from it were deleted. Nothing from it is in your history." : "Its records were deleted. Nothing from it is in your history."}</CardDescription>
      <div className="mt-4">
        <Link href="/app/adjustments/history" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          Back to history
        </Link>
      </div>
    </Card>
  );
}
