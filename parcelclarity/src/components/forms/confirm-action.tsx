"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Compact on desktop; the 44px minimum touch target on phones, where a mis-tap is irreversible. */
const touch = "min-h-11 sm:min-h-9";

/**
 * Two-step inline confirmation for consequential actions (suspend, revoke). It avoids
 * modal popups: the button turns into "Confirm / Cancel" in place.
 */
export function ConfirmAction({
  action,
  label,
  confirmLabel = "Confirm",
  variant = "secondary",
  children,
}: {
  action: () => Promise<{ ok: boolean; message?: string }>;
  label: string;
  confirmLabel?: string;
  variant?: "secondary" | "danger" | "ghost";
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!armed) {
    return (
      <Button size="sm" className={touch} variant={variant} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm: ${label}`}>
      {children ? <span className="text-sm text-muted">{children}</span> : null}
      <Button
        size="sm"
        className={touch}
        variant={variant === "ghost" ? "primary" : "danger"}
        loading={pending}
        onClick={() =>
          start(async () => {
            const result = await action();
            if (!result.ok) setError(result.message ?? "Something went wrong.");
            else setArmed(false);
          })
        }
      >
        {confirmLabel}
      </Button>
      <Button size="sm" className={touch} variant="secondary" disabled={pending} onClick={() => { setArmed(false); setError(null); }}>
        Cancel
      </Button>
      {error ? <span role="alert" className="text-sm font-medium text-danger">{error}</span> : null}
    </span>
  );
}
