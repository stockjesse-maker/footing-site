"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { archiveScenario, renameScenario, shareScenario } from "@/app/actions/modeling";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

/**
 * Rename, archive and (for 3PL staff) share a saved forecast, through the scenario actions every saved
 * model uses: they authorise on the project and the customer, so a forged id only ever comes back as
 * "not found". Nothing here is security; the buttons are a convenience.
 */
export function ForecastManage({ projectId, name, brandId, staff, shared, archived }: { projectId: string; name: string; /** Staff on behalf of a customer: the customer's brand id. */ brandId?: string; staff: boolean; shared: boolean; archived: boolean }) {
  const id = useId();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(name);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rename = () =>
    start(async () => {
      const result = await renameScenario(projectId, value, brandId);
      if (result.ok) {
        setMessage(null);
        setRenaming(false);
        router.refresh();
      } else setMessage(result.message ?? "The forecast could not be renamed.");
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" className="min-h-11 sm:min-h-9" aria-expanded={renaming} onClick={() => setRenaming((r) => !r)}>
          Rename
        </Button>
        {staff && brandId ? (
          <ConfirmAction action={shareScenario.bind(null, projectId, !shared, brandId)} label={shared ? "Hide from customer" : "Share with customer"} confirmLabel={shared ? "Hide" : "Share"} variant="ghost" />
        ) : null}
        {!archived ? (
          <ConfirmAction action={archiveScenario.bind(null, projectId, brandId)} label="Archive" confirmLabel="Archive" variant="ghost">
            Hidden from lists; its results are kept.
          </ConfirmAction>
        ) : null}
      </div>
      {renaming ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            rename();
          }}
        >
          <div className="flex-1">
            <Field id={`${id}-name`} label="Forecast name">
              {(aria) => <Input {...aria} value={value} onChange={(e) => setValue(e.target.value)} maxLength={160} autoComplete="off" />}
            </Field>
          </div>
          <Button type="submit" loading={pending} disabled={value.trim() === "" || value.trim() === name}>
            Save name
          </Button>
        </form>
      ) : null}
      {message ? <Alert tone="danger">{message}</Alert> : null}
    </div>
  );
}
