"use client";

import { useRef } from "react";
import { switchContext } from "@/app/actions/context";
import { Select } from "@/components/ui/field";

export interface ContextOption {
  id: string;
  label: string;
}

/** Shown only to people with more than one membership (for example a consultant for two 3PLs). */
export function ContextSwitcher({ options, activeId }: { options: ContextOption[]; activeId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={switchContext}>
      <label htmlFor="context" className="mb-1 block text-xs font-medium text-muted">
        Workspace
      </label>
      <Select id="context" name="membershipId" defaultValue={activeId} onChange={() => formRef.current?.requestSubmit()} className="min-h-10 text-sm">
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </form>
  );
}
