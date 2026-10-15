import type { HTMLAttributes } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  neutral: "bg-surface text-muted",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", tones[tone], className)} {...rest} />;
}

export function statusTone(status: string): Tone {
  if (status === "active") return "success";
  if (status === "suspended") return "warning";
  if (status === "revoked" || status === "pending_deletion") return "danger";
  return "neutral";
}
