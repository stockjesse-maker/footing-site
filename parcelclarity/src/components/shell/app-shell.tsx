import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/shell/logo";
import { SidebarNav, TabBar, type NavItem } from "@/components/shell/nav-links";
import { ContextSwitcher, type ContextOption } from "@/components/shell/context-switcher";

interface AppShellProps {
  homeHref: string;
  /** Name shown under the logo: the 3PL for staff, the brand for customers. */
  workspaceName: string;
  workspaceCaption: string;
  nav: NavItem[];
  userLabel: string;
  contexts?: ContextOption[];
  activeContextId?: string;
  children: ReactNode;
}

/** Responsive shell: sidebar on desktop, bottom tab bar (with iOS safe-area support) on phones. */
export function AppShell({ homeHref, workspaceName, workspaceCaption, nav, userLabel, contexts, activeContextId, children }: AppShellProps) {
  return (
    <div className="min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-raised focus:px-4 focus:py-2">
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col justify-between border-r border-line bg-bg p-4 md:flex">
        <div className="space-y-6">
          <Link href={homeHref} className="block px-2 pt-2" aria-label="ParcelClarity home">
            <Logo />
          </Link>
          <div className="px-2">
            <p className="truncate text-sm font-semibold">{workspaceName}</p>
            <p className="truncate text-xs text-muted">{workspaceCaption}</p>
          </div>
          <SidebarNav items={nav} />
        </div>
        <div className="space-y-3">
          {contexts && contexts.length > 1 && activeContextId ? <ContextSwitcher options={contexts} activeId={activeContextId} /> : null}
          <p className="truncate px-2 text-xs text-muted" title={userLabel}>{userLabel}</p>
          <form action={signOut}>
            <Button type="submit" variant="secondary" className="w-full">
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="safe-top sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 backdrop-blur md:hidden">
          <Link href={homeHref} aria-label="ParcelClarity home" className="inline-flex min-h-11 items-center">
            <Logo className="[&_span]:text-base" />
          </Link>
          <p className="max-w-[45%] truncate text-sm font-medium text-muted">{workspaceName}</p>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-6 sm:px-6 md:px-10 md:pb-16 md:pt-10">
          {children}
        </main>
      </div>
      <TabBar items={nav} />
    </div>
  );
}
