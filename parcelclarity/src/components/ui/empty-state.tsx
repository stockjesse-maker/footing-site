import type { ReactNode } from "react";

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line-strong bg-raised px-6 py-12 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
