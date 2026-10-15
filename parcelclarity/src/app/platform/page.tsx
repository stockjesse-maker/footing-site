import type { Metadata } from "next";
import { setTenantStatus } from "@/app/actions/platform";
import { signOut } from "@/app/actions/auth";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { Logo } from "@/components/shell/logo";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { formatDate } from "@/lib/format/date";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Platform" };

/**
 * Platform operator console. By design it lists tenants and lets operators suspend or restore
 * them, and nothing else: confidential tenant data (brands, members, pricing, reports) is not
 * readable by platform administrators through the application.
 */
export default async function PlatformPage() {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const { data: tenants } = await supabase.from("tenants").select("id, name, slug, status, created_at").order("created_at", { ascending: false }).limit(200);
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-8 flex items-center justify-between"><Logo />
        <form action={signOut}><Button type="submit" variant="secondary" size="sm">Sign out</Button></form>
      </div>
      <PageHeader title="Platform" description="Tenant accounts. Operators can suspend or restore a tenant, but cannot view its customers, pricing or reports." />
      {tenants?.length ? (
        <DataList>
          {tenants.map((t) => (
            <DataRow key={t.id}>
              <div className="min-w-0">
                <p className="truncate font-medium">{t.name}</p>
                <p className="text-sm text-muted">{t.slug} · created {formatDate(t.created_at)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                {t.status === "active" ? (
                  <ConfirmAction action={setTenantStatus.bind(null, t.id, "suspended")} label="Suspend" confirmLabel="Suspend tenant" variant="danger" />
                ) : t.status === "suspended" ? (
                  <ConfirmAction action={setTenantStatus.bind(null, t.id, "active")} label="Restore" confirmLabel="Restore" variant="ghost" />
                ) : null}
              </div>
            </DataRow>
          ))}
        </DataList>
      ) : (
        <EmptyState title="No tenants yet" />
      )}
    </main>
  );
}
