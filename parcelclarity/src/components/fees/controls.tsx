"use client";

import type { ReactNode } from "react";
import { Field, Input, Select } from "@/components/ui/field";

/** Controlled form controls shared by the rule editor and the "Try an order" panel. Each wires its label, hint and error together. */

export interface TextProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: ReactNode;
  inputMode?: "decimal" | "numeric" | "text";
  placeholder?: string;
  maxLength?: number;
  readOnly?: boolean;
  list?: string;
  className?: string;
}

export function Text({ id, label, value, onChange, onBlur, error, hint, inputMode, placeholder, maxLength, readOnly, list, className }: TextProps) {
  return (
    <div className={className}>
      <Field id={id} label={label} error={error} hint={hint}>
        {(aria) => (
          <Input {...aria} name={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} inputMode={inputMode} placeholder={placeholder} maxLength={maxLength} readOnly={readOnly} list={list} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        )}
      </Field>
    </div>
  );
}

export function Pick<T extends string>({ id, label, value, onChange, options, error, hint, disabled, className }: { id: string; label: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[]; error?: string; hint?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <div className={className}>
      <Field id={id} label={label} error={error} hint={hint}>
        {(aria) => (
          <Select {...aria} name={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  );
}

export function Check({ id, label, checked, onChange, hint }: { id: string; label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; hint?: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="flex min-h-11 items-start gap-3 py-2 text-sm">
        <input id={id} name={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-accent" aria-describedby={hint ? `${id}-hint` : undefined} />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="-mt-1 mb-1 pl-8 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Area({ id, label, value, onChange, onBlur, error, hint, rows = 3, maxLength }: { id: string; label: string; value: string; onChange: (value: string) => void; onBlur?: () => void; error?: string; hint?: ReactNode; rows?: number; maxLength: number }) {
  return (
    <Field id={id} label={label} error={error} hint={hint}>
      {(aria) => (
        <textarea
          {...aria}
          name={id}
          rows={rows}
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="block w-full rounded-control border border-line-strong bg-raised px-3.5 py-2.5 text-fg transition-colors hover:border-fg/40 aria-[invalid=true]:border-danger"
        />
      )}
    </Field>
  );
}

export function GroupErrors({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div className="space-y-1">
      {messages.map((m) => (
        <p key={m} role="alert" className="text-sm font-medium text-danger">
          {m}
        </p>
      ))}
    </div>
  );
}


