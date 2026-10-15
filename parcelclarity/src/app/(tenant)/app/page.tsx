import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { PageHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { auditActionLabel } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format/date";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };

export default async function TenantOverview({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const ctx = await requireTenantContext();
  const supabase = await createClient();
  const tenantId = ctx.active.tenantId;
  const nowIso = new Date().toISOString();

  const [brands, members, invites, recent] = await Promise.all([
    supabase.from("brands").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "active"),
    can(ctx.active.role, "member.view")
      ? supabase.from("memberships").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "active")
      : Promise.resolve(null),
    can(ctx.active.role, "member.view")
      ? supabase.from("invitations").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).is("accepted_at", null).is("revoked_at", null).gt("expires_at", nowIso)
      : Promise.resolve(null),
    can(ctx.active.role, "audit.view")
      ? supabase.from("audit_events").select("id, action, occurred_at, metadata").eq("tenant_id", tenantId).order("occurred_at", { ascending: false }).limit(6)
      : Promise.resolve(null),
  ]);

  const activeBrands = brands.count ?? 0;
  const flash = (await searchParams).password === "updated";

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Welcome${ctx.profile.fullName ? `, ${ctx.profile.fullName.split(" ")[0]}` : ""}. Here is where ${ctx.active.tenantName} stands.`}
        actions={can(ctx.active.role, "brand.create") ? <ButtonLink href="/app/customers">Add a customer</ButtonLink> : undefined}
      />
      {flash ? <Alert tone="success" className="mb-6">Your password was updated.</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Active customers" value={activeBrands} note="Brand accounts with portal access" />
        {members ? <Stat label="Team members" value={members.count ?? 0} note="Active people across staff and customers" /> : null}
        {invites ? <Stat label="Pending invitations" value={invites.count ?? 0} note="Waiting to be accepted" /> : null}
      </div>

      {activeBrands === 0 ? (
        <Card className="mt-6">
          <CardTitle>Start by adding your first customer</CardTitle>
          <CardDescription>
            Create a brand account, then invite its team. Each brand only ever sees the pricing and results you assign to it.
          </CardDescription>
          {can(ctx.active.role, "brand.create") ? (
            <div className="mt-4"><ButtonLink href="/app/customers">Add a customer</ButtonLink></div>
          ) : null}
        </Card>
      ) : null}

      {recent?.data ? (
        <section className="mt-10 space-y-3" aria-labelledby="recent-heading">
          <div className="flex items-end justify-between">
            <h2 id="recent-heading" className="text-xl font-semibold tracking-tight">Recent activity</h2>
            <Link href="/app/audit" className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline">View all</Link>
          </div>
          <DataList>
            {recent.data.map((e) => (
              <DataRow key={e.id}>
                <p className="font-medium">{auditActionLabel(e.action)}</p>
                <p className="tabular text-sm text-muted">{formatDateTime(e.occurred_at)}</p>
              </DataRow>
            ))}
          </DataList>
        </section>
      ) : null}
    </>
  );
}
