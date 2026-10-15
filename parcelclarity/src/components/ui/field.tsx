import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "./cn";

const control =
  "block w-full min-h-11 rounded-control border border-line-strong bg-raised px-3.5 text-fg placeholder:text-muted/70 " +
  "transition-colors hover:border-fg/40 disabled:opacity-60 aria-[invalid=true]:border-danger";

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  children: (aria: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}

/** Label + control + hint + error, wired together for screen readers. */
export function Field({ id, label, error, hint, children }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, "pr-9", className)} {...rest}>
      {children}
    </select>
  );
}
