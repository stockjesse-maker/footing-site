import Link from "next/link";
import { cn } from "@/components/ui/cn";

export const HISTORY_SECTIONS = [
  { key: "imports", href: "/app/adjustments/history", label: "Imports" },
  { key: "statistics", href: "/app/adjustments/history/statistics", label: "How often" },
  { key: "baselines", href: "/app/adjustments/history/baselines", label: "Packages shipped" },
] as const;
export type HistorySection = (typeof HISTORY_SECTIONS)[number]["key"];

/** The three parts of History: the imports, what they show, and the packages-shipped figures that turn counts into rates. */
export function HistoryNav({ current }: { current: HistorySection }) {
  return (
    <nav aria-label="History sections" className="mb-5 flex flex-wrap gap-2">
      {HISTORY_SECTIONS.map((s) => (
        <Link
          key={s.key}
          href={s.href}
          aria-current={s.key === current ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium",
            s.key === current ? "bg-accent-soft text-accent-text" : "bg-surface text-muted hover:text-fg",
          )}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
