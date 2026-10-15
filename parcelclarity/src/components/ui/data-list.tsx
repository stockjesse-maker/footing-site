import type { ReactNode } from "react";
import { cn } from "./cn";

/** Responsive list: stacked rows on phones, aligned columns on larger screens. */
export function DataList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("divide-y divide-line overflow-hidden rounded-card border border-line bg-raised shadow-card", className)}>{children}</ul>;
}

export function DataRow({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6", className)}>{children}</li>;
}
