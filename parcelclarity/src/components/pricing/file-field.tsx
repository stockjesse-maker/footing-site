"use client";

import { useFormState } from "@/components/forms/action-form";
import { Field } from "@/components/ui/field";

/** File input styled like the other controls, with the action's inline error for its field name. */
export function FileField({ name, label, accept, hint }: { name: string; label: string; accept: string; hint?: string }) {
  const state = useFormState();
  return (
    <Field id={name} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => (
        <input
          {...aria}
          type="file"
          name={name}
          accept={accept}
          required
          className="block w-full min-h-11 rounded-control border border-line-strong bg-raised px-3.5 py-2 text-fg file:mr-3 file:rounded-control file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-text"
        />
      )}
    </Field>
  );
}
