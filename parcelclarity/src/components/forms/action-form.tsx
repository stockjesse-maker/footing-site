"use client";

import { createContext, useActionState, useContext, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { initialState, type ActionState } from "@/lib/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const StateContext = createContext<ActionState>(initialState);
export const useFormState = () => useContext(StateContext);

/** Server Action form with consistent loading, error, and success feedback. */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, initialState);
  return (
    <StateContext.Provider value={state}>
      <form action={formAction} className={className ?? "space-y-4"} noValidate>
        {children}
        <FormMessage />
      </form>
    </StateContext.Provider>
  );
}

export function FormMessage() {
  const state = useFormState();
  if (state.message) {
    return (
      <Alert tone={state.ok ? "success" : "danger"}>
        {state.message}
        {state.inviteLink ? <CopyableLink href={state.inviteLink} /> : null}
      </Alert>
    );
  }
  return null;
}

function CopyableLink({ href }: { href: string }) {
  return (
    <span className="mt-2 block">
      <label className="block text-xs font-medium text-muted" htmlFor="invite-link">
        Invitation link (share it privately)
      </label>
      <input id="invite-link" readOnly value={href} onFocus={(e) => e.currentTarget.select()} className="mt-1 block w-full rounded-control border border-line-strong bg-raised px-3 py-2 text-sm" />
    </span>
  );
}

export function SubmitButton({ children, pendingLabel, ...rest }: { children: ReactNode; pendingLabel?: string; variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" | "lg"; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...rest}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}

interface TextFieldProps {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "url";
  autoComplete?: string;
  required?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  defaultValue?: string;
  readOnly?: boolean;
}

export function TextField({ name, label, type = "text", defaultValue, ...rest }: TextFieldProps) {
  const state = useFormState();
  return (
    <Field id={name} label={label} error={state.errors?.[name]} hint={rest.hint}>
      {(aria) => (
        <Input
          {...aria}
          name={name}
          type={type}
          autoComplete={rest.autoComplete}
          required={rest.required}
          placeholder={rest.placeholder}
          readOnly={rest.readOnly}
          defaultValue={state.values?.[name] ?? defaultValue}
          autoCapitalize={type === "email" ? "none" : undefined}
          spellCheck={type === "text" ? undefined : false}
        />
      )}
    </Field>
  );
}

export function SelectField({ name, label, options, hint }: { name: string; label: string; options: { value: string; label: string }[]; hint?: ReactNode }) {
  const state = useFormState();
  return (
    <Field id={name} label={label} error={state.errors?.[name]} hint={hint}>
      {(aria) => (
        <Select {...aria} name={name} defaultValue={state.values?.[name] ?? options[0]?.value}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
