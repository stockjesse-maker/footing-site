"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";

/**
 * An alert that takes keyboard focus when it appears, so a person who submitted by keyboard, and a screen reader, land on what went wrong.
 * A danger alert is `role="alert"` (the Alert component), so it is also announced. Remount it (change its `key`) to move focus again.
 */
export function FocusAlert({ tone = "danger", title, children, id }: { tone?: "info" | "success" | "warning" | "danger"; title?: string; children?: ReactNode; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} id={id} className="rounded-control">
      <Alert tone={tone} title={title}>
        {children}
      </Alert>
    </div>
  );
}
