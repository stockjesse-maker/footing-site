import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireTenantContext } from "@/lib/auth/session";
import { auditActionLabel } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format/date";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Activity" };
const PAGE_SIZE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const ctx = await requireTenantContext("audit.view");
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const supabase = await createClient();
  const { data: events, count } = await supabase
    .from("audit_events")
    .select("id, action, occurred_at, actor_id, metadata", { count: "exact" })
    .eq("tenant_id", ctx.active.tenantId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const actorIds = [...new Set((events ?? []).map((e) => e.actor_id).filter((id): id is string => !!id))];
  const actors = new Map<string, string>();
  if (actorIds.length) {
    const { data: profiles } = await supabase.from("profiles").select("id, full_name, email").in("id", actorIds);
    for (const p of profiles ?? []) actors.set(p.id, p.full_name || p.email);
  }

  return (
    <>
      <PageHeader title="Activity" description="A permanent record of changes to customers, team access and invitations. Times are shown in UTC." />
      {events && events.length ? (
        <>
          <DataList>
            {events.map((e) => (
              <DataRow key={e.id}>
                <div className="min-w-0">
                  <p className="font-medium">{auditActionLabel(e.action)}</p>
                  <p className="truncate text-sm text-muted">{e.actor_id ? (actors.get(e.actor_id) ?? "A removed user") : "System"}</p>
                </div>
                <p className="tabular text-sm text-muted">{formatDateTime(e.occurred_at)}</p>
              </DataRow>
            ))}
          </DataList>
          {(count ?? 0) > PAGE_SIZE ? (
            <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
              {page > 1 ? <ButtonLink href={`/app/audit?page=${page - 1}`} variant="secondary" size="sm">Newer</ButtonLink> : <span />}
              {from + PAGE_SIZE < (count ?? 0) ? <ButtonLink href={`/app/audit?page=${page + 1}`} variant="secondary" size="sm">Older</ButtonLink> : <span />}
            </nav>
          ) : null}
        </>
      ) : (
        <EmptyState title="No activity yet" />
      )}
    </>
  );
}
