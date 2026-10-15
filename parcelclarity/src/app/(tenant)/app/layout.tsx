import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { NavItem } from "@/components/shell/nav-links";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";

export default async function TenantLayout({ children }: { children: ReactNode }) {
  const ctx = await requireTenantContext();
  const role = ctx.active.role;
  // Navigation is a convenience only. Every page and action re-checks permissions server-side.
  const nav: NavItem[] = [
    { href: "/app", label: "Overview", icon: "home", exact: true },
    { href: "/app/customers", label: "Customers", icon: "building" },
    ...(can(role, "ratecard.view") ? [{ href: "/app/rate-cards", label: "Rate cards", icon: "document" } as NavItem] : []),
    ...(can(role, "ratecard.view") ? [{ href: "/app/surcharges", label: "Surcharges", icon: "list" } as NavItem] : []),
    ...(can(role, "simulation.run") ? [{ href: "/app/calculator", label: "Calculator", icon: "calculator" } as NavItem] : []),
    ...(can(role, "member.view") ? [{ href: "/app/team", label: "Team", icon: "users" } as NavItem] : []),
    ...(can(role, "audit.view") ? [{ href: "/app/audit", label: "Activity", icon: "list" } as NavItem] : []),
    { href: "/app/settings", label: "Settings", icon: "settings" },
  ];
  return (
    <AppShell
      homeHref="/app"
      workspaceName={ctx.active.tenantName}
      workspaceCaption="3PL workspace"
      nav={nav}
      userLabel={ctx.profile.email}
      contexts={ctx.memberships.map((m) => ({ id: m.id, label: m.brandName ? `${m.brandName} · ${m.tenantName}` : m.tenantName }))}
      activeContextId={ctx.active.id}
    >
      {children}
    </AppShell>
  );
}
