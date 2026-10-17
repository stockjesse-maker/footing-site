"use client";

import { useActionState, useState } from "react";
import { uploadAdjustmentFile } from "@/app/actions/adjustments";
import { SubmitButton } from "@/components/forms/action-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { initialState } from "@/lib/actions";
import type { UploadState } from "@/lib/adjustments/action-schemas";
import { REFUSAL_TITLE } from "@/lib/adjustments/copy";
import { MONEY_FIELD_HINT, TEMPLATE_HREF, UPLOAD_BUTTON, UPLOAD_FILE_HINT_LIMITS, UPLOAD_FILE_LABEL, UPLOAD_NOTHING_IMPORTED, UPLOAD_PENDING, UPLOAD_READ_ONLY, UPLOAD_TEMPLATE_LINK, UPLOAD_TITLE } from "@/lib/adjustments/staff-copy";
import { FocusAlert } from "./focus-alert";

const ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Step 1 of an import. The first line under the file says what the amounts must be (what your customer is charged, never what the carrier
 * bills you), then the limits. A file the guard refuses stores nothing and is answered with the action's own message, which names the
 * column, shown word for word under the title "This file looks like carrier cost data".
 */
export function UploadFormView({ state, formAction, attempt = 0, onSubmit }: { state: UploadState; formAction?: (formData: FormData) => void; attempt?: number; onSubmit?: () => void }) {
  const fileError = state.errors?.file;
  return (
    <Card>
      <CardTitle>{UPLOAD_TITLE}</CardTitle>
      <CardDescription>
        A CSV or XLSX of what your customers were charged for past reweighs, remeasures and other corrections. {UPLOAD_NOTHING_IMPORTED}
      </CardDescription>
      <a href={TEMPLATE_HREF} download className="mt-1 inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
        {UPLOAD_TEMPLATE_LINK}
      </a>
      <form action={formAction} onSubmit={onSubmit} className="mt-3 space-y-4" noValidate>
        <Field
          id="adjustment-history-file"
          label={UPLOAD_FILE_LABEL}
          error={fileError}
          hint={
            <>
              <span className="block">{MONEY_FIELD_HINT}</span>
              <span className="block">{UPLOAD_FILE_HINT_LIMITS}</span>
            </>
          }
        >
          {(aria) => (
            <input
              {...aria}
              type="file"
              name="file"
              accept={ACCEPT}
              required
              className="block w-full min-h-11 rounded-control border border-line-strong bg-raised px-3.5 py-2 text-fg file:mr-3 file:rounded-control file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-text"
            />
          )}
        </Field>
        {state.refused && state.message ? (
          <FocusAlert key={attempt} title={REFUSAL_TITLE}>
            {state.message}
          </FocusAlert>
        ) : state.message ? (
          <FocusAlert key={attempt}>{state.message}</FocusAlert>
        ) : null}
        <SubmitButton pendingLabel={UPLOAD_PENDING}>{UPLOAD_BUTTON}</SubmitButton>
      </form>
    </Card>
  );
}

export function HistoryUploadForm({ canManage }: { canManage: boolean }) {
  const [state, formAction] = useActionState<UploadState, FormData>(uploadAdjustmentFile, initialState);
  const [attempt, setAttempt] = useState(0);
  if (!canManage) {
    return (
      <Card>
        <CardTitle>{UPLOAD_TITLE}</CardTitle>
        <CardDescription>{UPLOAD_READ_ONLY}</CardDescription>
      </Card>
    );
  }
  return <UploadFormView state={state} formAction={formAction} attempt={attempt} onSubmit={() => setAttempt((a) => a + 1)} />;
}
