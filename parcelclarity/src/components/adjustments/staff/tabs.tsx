"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { ADJUSTMENT_TABS, isTabActive, type AdjustmentTab } from "@/lib/adjustments/staff-copy";

/**
 * The five tabs of the Adjustments area: Overview, Policies, History, Examples, Risk. The current tab is marked with aria-current and
 * by an underline AND bolder text, never by colour alone. The row scrolls sideways inside itself on a phone (it never widens the page)
 * and every tab keeps a 44px target. `AdjustmentTabsView` takes the path as a prop so it renders (and is tested) without a router.
 */
export function AdjustmentTabsView({ pathname, tabs = ADJUSTMENT_TABS }: { pathname: string; tabs?: readonly AdjustmentTab[] }) {
  return (
    <nav aria-label="Adjustments sections" className="mb-6 overflow-x-auto overscroll-x-contain">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {tabs.map((tab) => {
          const active = isTabActive(pathname, tab);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative inline-flex min-h-11 items-center px-4 text-[15px]",
                  active ? "font-semibold text-accent-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "font-medium text-muted hover:text-fg",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AdjustmentTabs() {
  return <AdjustmentTabsView pathname={usePathname()} />;
}
