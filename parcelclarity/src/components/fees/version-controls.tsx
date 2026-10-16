"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { activateFeeVersion, createDraftVersion, endFeeVersion, saveVersionNotes, updateDraftRounding } from "@/app/actions/fee-schedules";
import { Dialog } from "@/components/fees/dialog";
import { ROUNDING_OPTIONS } from "@/components/fees/shared";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { useLocalToday } from "@/components/forms/local-today";
import { DateField } from "@/components/pricing/service-terms-form";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";

/**
 * Client controls for a fee schedule's version lifecycle. Every write goes through the server actions
 * in src/app/actions/fee-schedules.ts, which authorise and validate again; the messages they return
 * are shown inline. Hiding a control for someone without permission is a convenience, never security.
 */

/** 44px on phones, where a mis-tap is hard to undo. */
const touch = "min-h-11 sm:min-h-9";

// ---------------------------------------------------------------------------
// New draft
// ---------------------------------------------------------------------------
export interface DraftSourceVersion {
  id: string;
  versionNumber: number;
  status: string;
}

/** Starts a new draft, empty or copied from an existing version, and opens it. */
export function NewDraftControl({ scheduleId, versions }: { scheduleId: string; versions: DraftSourceVersion[] }) {
  const router = useRouter();
  const id = useId();
  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const latestReal = sorted.find((v) => v.status === "active") ?? sorted.find((v) => v.status === "archived") ?? null;
  const [from, setFrom] = useState(latestReal?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await createDraftVersion(scheduleId, from || null);
          if (!result.ok || !result.versionId) {
            setError(result.message ?? "Something went wrong. Please try again.");
            return;
          }
          router.push(`/app/fee-schedules/${scheduleId}/versions/${result.versionId}`);
        });
      }}
    >
      <Field id={`${id}-from`} label="Start the new draft from" hint="A copy keeps every rule, so you only change what is different. Nothing changes for customers until you activate the draft.">
        {(aria) => (
          <Select {...aria} name="fromVersionId" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">An empty draft</option>
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                A copy of version {v.versionNumber} ({v.status})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" loading={pending}>
        {pending ? "Creating…" : "New draft"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Activate and end
// ---------------------------------------------------------------------------
function ActivateForm({ versionId }: { versionId: string }) {
  const today = useLocalToday();
  return (
    <ActionForm action={activateFeeVersion} className="space-y-4">
      <input type="hidden" name="versionId" value={versionId} />
      <p className="text-sm text-muted">
        Activation locks the rules and puts these fees into effect for customers on this schedule between the dates below. Two active versions of a schedule can never cover the same day, so end the
        current one first if the dates overlap.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField id={`activate-effective-${versionId}`} name="effectiveDate" label="Effective date" defaultValue={today} required hint="First date these fees apply (a UTC calendar date)." />
        <DateField id={`activate-expiration-${versionId}`} name="expirationDate" label="Expiration date (optional)" hint="Leave empty if the fees have no agreed end date." />
      </div>
      <SubmitButton pendingLabel="Activating…">Activate version</SubmitButton>
    </ActionForm>
  );
}

/** "Activate…": opens a dialog with the effective and expiration dates. */
export function ActivateVersionButton({ versionId, versionNumber, className }: { versionId: string; versionNumber: number; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" className={`${touch} ${className ?? ""}`} onClick={() => setOpen(true)} aria-haspopup="dialog">
        Activate…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Activate version ${versionNumber}`}>
        <ActivateForm versionId={versionId} />
      </Dialog>
    </>
  );
}

function EndForm({ versionId, expirationDate }: { versionId: string; expirationDate: string | null }) {
  const today = useLocalToday();
  return (
    <ActionForm action={endFeeVersion} className="space-y-4">
      <input type="hidden" name="versionId" value={versionId} />
      <p className="text-sm text-muted">
        Set the last date these fees apply to. Orders dated up to that day are still priced on this version, and a new version can be activated from the next day.
      </p>
      <DateField id={`end-expiration-${versionId}`} name="expirationDate" label="Last effective date" defaultValue={expirationDate ?? today} required hint="A UTC calendar date." />
      <SubmitButton variant="secondary" pendingLabel="Saving…">
        End version on this date
      </SubmitButton>
    </ActionForm>
  );
}

/** "End…": opens a dialog with the last effective date. */
export function EndVersionButton({ versionId, versionNumber, expirationDate }: { versionId: string; versionNumber: number; expirationDate: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" className={touch} onClick={() => setOpen(true)} aria-haspopup="dialog">
        End…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`End version ${versionNumber}`}>
        <EndForm versionId={versionId} expirationDate={expirationDate} />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rounding and notes of a draft
// ---------------------------------------------------------------------------
type Notice = { ok: boolean; text: string } | null;

function NoticeText({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role={notice.ok ? "status" : "alert"} className={`text-sm font-medium ${notice.ok ? "text-success" : "text-danger"}`}>
      {notice.text}
    </p>
  );
}

export function RoundingSelect({ versionId, value, editable, draft = editable }: { versionId: string; value: string; editable: boolean; /** Still a draft, though this person may not change it. */ draft?: boolean }) {
  const id = useId();
  const [current, setCurrent] = useState(value);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <div className="space-y-1.5">
      <Field id={`${id}-rounding`} label="Rounding" hint={editable ? "How the fees are rounded to cents. Saved as soon as you change it." : draft ? "Only administrators can change this while the version is a draft." : "Locked because this version is no longer a draft."}>
        {(aria) => (
          <Select
            {...aria}
            name="rounding"
            value={current}
            disabled={!editable || pending}
            onChange={(e) => {
              const next = e.target.value;
              const previous = current;
              setCurrent(next);
              setNotice(null);
              start(async () => {
                const result = await updateDraftRounding(versionId, next);
                if (!result.ok) {
                  setCurrent(previous);
                  setNotice({ ok: false, text: result.errors?.rounding ?? result.message ?? "Something went wrong. Please try again." });
                } else setNotice({ ok: true, text: "Saved." });
              });
            }}
          >
            {ROUNDING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <NoticeText notice={notice} />
    </div>
  );
}

export function VersionNotesForm({ versionId, notes, editable }: { versionId: string; notes: string | null; editable: boolean }) {
  const id = useId();
  const [text, setText] = useState(notes ?? "");
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  if (!editable) {
    return notes ? <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{notes}</p> : <p className="text-sm text-muted">No notes on this version.</p>;
  }
  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setNotice(null);
        start(async () => {
          const result = await saveVersionNotes(versionId, text.trim() === "" ? null : text);
          setNotice(result.ok ? { ok: true, text: result.message ?? "Saved." } : { ok: false, text: result.errors?.notes ?? result.message ?? "Something went wrong. Please try again." });
        });
      }}
    >
      <Field id={`${id}-notes`} label="Staff notes" hint="Why this version changed, who approved it. Only your team can read this; customers never see it.">
        {(aria) => (
          <textarea
            {...aria}
            name="notes"
            rows={4}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="block w-full rounded-control border border-line-strong bg-raised px-3.5 py-2.5 text-fg transition-colors hover:border-fg/40 aria-[invalid=true]:border-danger"
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={pending}>
          {pending ? "Saving…" : "Save notes"}
        </Button>
        <NoticeText notice={notice} />
      </div>
    </form>
  );
}
