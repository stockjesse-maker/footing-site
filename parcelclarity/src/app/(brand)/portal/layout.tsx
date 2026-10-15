import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { NavItem } from "@/components/shell/nav-links";
import { requireBrandContext } from "@/lib/auth/session";

const NAV: NavItem[] = [
  { href: "/portal", label: "Overview", icon: "home", exact: true },
  { href: "/portal/model", label: "Model Costs", icon: "calculator" },
  { href: "/portal/reports", label: "Reports", icon: "document" },
  { href: "/portal/account", label: "Account", icon: "user" },
];

export default async function BrandLayout({ children }: { children: ReactNode }) {
  const ctx = await requireBrandContext();
  return (
    <AppShell
      homeHref="/portal"
      workspaceName={ctx.active.brandName}
      workspaceCaption={`Provided by ${ctx.active.tenantName}`}
      nav={NAV}
      userLabel={ctx.profile.email}
      contexts={ctx.memberships.map((m) => ({ id: m.id, label: m.brandName ? `${m.brandName} · ${m.tenantName}` : m.tenantName }))}
      activeContextId={ctx.active.id}
    >
      {children}
    </AppShell>
  );
}
