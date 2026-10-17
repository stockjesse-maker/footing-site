import Link from "next/link";
import { cn } from "@/components/ui/cn";

export const HISTORY_SECTIONS = [
  { key: "imports", href: "/app/adjustments/history", label: "Imports" },
  { key: "statistics", href: "/app/adjustments/history/statistics", label: "How often" },
  { key: "baselines", href: "/app/adjustments/history/baselines", label: "Packages shipped" },
] as const;
export type HistorySection = (typeof HISTORY_SECTIONS)[number]["key"];

/**
 * The three parts of History: the imports, what they show, and the packages-shipped figures that turn counts into rates. Styled like the view
 * control of a run's results (bordered links; the current one is bolder, tinted and ticked, so it never depends on colour alone).
 */
export function HistoryNav({ current }: { current: HistorySection }) {
  return (
    <nav aria-label="History sections" className="mb-5">
      <ul className="flex flex-wrap gap-2">
        {HISTORY_SECTIONS.map((s) => {
          const selected = s.key === current;
          return (
            <li key={s.key}>
              <Link
                href={s.href}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-control border px-4 text-sm",
                  selected ? "border-accent bg-accent-soft font-semibold text-accent-text" : "border-line text-fg hover:bg-surface",
                )}
              >
                {selected ? <span aria-hidden="true">✓</span> : null}
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
