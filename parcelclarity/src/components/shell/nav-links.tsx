"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { BuildingIcon, CalculatorIcon, DocumentIcon, HomeIcon, ListIcon, SettingsIcon, ShieldIcon, UserIcon, UsersIcon } from "@/components/ui/icons";
import { cn } from "@/components/ui/cn";

const ICONS = { home: HomeIcon, building: BuildingIcon, users: UsersIcon, calculator: CalculatorIcon, document: DocumentIcon, user: UserIcon, settings: SettingsIcon, shield: ShieldIcon, list: ListIcon };
export type IconName = keyof typeof ICONS;
export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Match only this exact path (used for each portal's home route). */
  exact?: boolean;
}

function isActive(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn("flex min-h-11 items-center gap-3 rounded-control px-3 text-[15px] font-medium transition-colors", active ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-surface")}
          >
            <Icon className="size-5" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function TabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const listRef = useRef<HTMLUListElement>(null);
  // A workspace with many sections (an administrator sees nine) does not fit a 390px phone at a usable width: the bar
  // scrolls sideways, each tab keeps a 72px-wide target, and the current page's tab is brought into view.
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !current) return;
    const offset = current.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    list.scrollLeft = Math.max(0, offset - (list.clientWidth - current.offsetWidth) / 2);
  }, [pathname]);
  return (
    <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 backdrop-blur md:hidden">
      <ul ref={listRef} className="mx-auto flex max-w-lg overflow-x-auto overscroll-x-contain">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item);
          return (
            <li key={item.href} className="min-w-[4.5rem] flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-center text-[11px] font-medium leading-tight", active ? "text-accent-text" : "text-muted")}
              >
                <Icon className="size-6" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
