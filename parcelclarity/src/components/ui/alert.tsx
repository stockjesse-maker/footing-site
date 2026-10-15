import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "info" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  info: "bg-accent-soft text-fg border-accent/20",
  success: "bg-success-soft text-fg border-success/30",
  warning: "bg-warning-soft text-fg border-warning/30",
  danger: "bg-danger-soft text-fg border-danger/30",
};

export function Alert({ tone = "info", title, children, className }: { tone?: Tone; title?: string; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-control border px-4 py-3 text-sm", tones[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-0.5" : undefined}>{children}</div> : null}
    </div>
  );
}
