import type { Metadata } from "next";
import Link from "next/link";
import { RuleForm, type CarrierOption, type KnownGroup } from "@/components/pricing/rule-form";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { carrierProfile } from "@/engine/carriers";
import { requireTenantContext } from "@/lib/auth/session";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "New surcharge rule" };

export default async function NewSurchargeRulePage() {
  // A write page: readers without ratecard.manage get a 404 rather than a form that cannot submit.
  const ctx = await requireTenantContext("ratecard.manage");
  const supabase = await createClient();
  const tenantId = ctx.active.tenantId;
  const [catalog, carriersRes, brandsRes, zipListsRes] = await Promise.all([
    loadServiceCatalog(supabase),
    supabase.from("carriers").select("code, name").order("name").overrideTypes<CarrierOption[], { merge: false }>(),
    supabase.from("brands").select("id, name").eq("tenant_id", tenantId).eq("status", "active").order("name").overrideTypes<{ id: string; name: string }[], { merge: false }>(),
    supabase.from("zip_lists").select("key").or(`tenant_id.is.null,tenant_id.eq.${tenantId}`).eq("status", "published").overrideTypes<{ key: string }[], { merge: false }>(),
  ]);
  const carriers = carriersRes.data ?? [];
  const knownGroups: Record<string, KnownGroup[]> = Object.fromEntries(carriers.map((c) => [c.code, carrierProfile(c.code).knownExclusivityGroups]));
  const zipListKeys = [...new Set((zipListsRes.data ?? []).map((l) => l.key))].sort();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/app/surcharges" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← Surcharges
        </Link>
      </p>
      <PageHeader title="New surcharge rule" description="Describe one surcharge you charge customers: what it costs, when it applies and where the amount comes from. It is saved as a draft version that you publish from the rule page." />
      {carriers.length ? (
        <Card>
          <RuleForm mode="create" catalog={catalog} carriers={carriers} brands={brandsRes.data ?? []} knownGroups={knownGroups} zipListKeys={zipListKeys} today={today} />
        </Card>
      ) : (
        <EmptyState title="No carriers available">Surcharge rules belong to a carrier, and none are configured on this platform yet.</EmptyState>
      )}
    </>
  );
}
