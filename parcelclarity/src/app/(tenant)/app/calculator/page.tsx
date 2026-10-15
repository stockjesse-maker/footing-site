import type { Metadata } from "next";
import { CalculatorForm, type CalculatorCard, type CalculatorService, type CalculatorVersion } from "@/components/pricing/calculator-form";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Calculator" };

interface CardRow {
  id: string;
  name: string;
}

interface VersionRow {
  id: string;
  rate_card_id: string;
  version_number: number;
  status: string;
  effective_date: string | null;
  expiration_date: string | null;
}

interface TermRow {
  version_id: string;
  service_id: string;
  shipping_services: { carrier_code: string; code: string; name: string } | null;
}

export default async function CalculatorPage({ searchParams }: { searchParams: Promise<{ rateCardId?: string; versionId?: string }> }) {
  const ctx = await requireTenantContext("simulation.run");
  const params = await searchParams;
  const supabase = await createClient();
  const tenantId = ctx.active.tenantId;

  // Row Level Security already limits every query to what this user may see; tenant_id narrows it further.
  const [cardsRes, versionsRes] = await Promise.all([
    supabase.from("rate_cards").select("id, name").eq("tenant_id", tenantId).eq("status", "active").order("name").overrideTypes<CardRow[], { merge: false }>(),
    supabase
      .from("rate_card_versions")
      .select("id, rate_card_id, version_number, status, effective_date, expiration_date")
      .eq("tenant_id", tenantId)
      .in("status", ["draft", "active"])
      .order("version_number", { ascending: false })
      .overrideTypes<VersionRow[], { merge: false }>(),
  ]);
  const cards = cardsRes.data ?? [];
  const cardIds = new Set(cards.map((c) => c.id));
  const versions = (versionsRes.data ?? []).filter((v) => cardIds.has(v.rate_card_id));

  // Services per version (terms rows joined to the service catalog); one query for every version shown.
  const servicesByVersion = new Map<string, CalculatorService[]>();
  if (versions.length) {
    const { data: terms } = await supabase
      .from("rate_card_service_terms")
      .select("version_id, service_id, shipping_services(carrier_code, code, name)")
      .in("version_id", versions.map((v) => v.id))
      .overrideTypes<TermRow[], { merge: false }>();
    for (const t of terms ?? []) {
      if (!t.shipping_services) continue;
      const list = servicesByVersion.get(t.version_id) ?? [];
      list.push({ serviceId: t.service_id, carrierCode: t.shipping_services.carrier_code, code: t.shipping_services.code, name: t.shipping_services.name });
      servicesByVersion.set(t.version_id, list);
    }
  }

  const versionsByCard = new Map<string, CalculatorVersion[]>();
  for (const v of versions) {
    const list = versionsByCard.get(v.rate_card_id) ?? [];
    list.push({
      id: v.id,
      versionNumber: v.version_number,
      status: v.status,
      effectiveDate: v.effective_date,
      expirationDate: v.expiration_date,
      services: (servicesByVersion.get(v.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    });
    versionsByCard.set(v.rate_card_id, list);
  }
  const model: CalculatorCard[] = cards.map((c) => ({ id: c.id, name: c.name, versions: versionsByCard.get(c.id) ?? [] }));

  // Preselection from the query string: only ids that are actually in the list the user may see.
  const wantedCard = uuidSchema.safeParse(params.rateCardId).success ? params.rateCardId : undefined;
  const initialRateCardId = wantedCard && cardIds.has(wantedCard) ? wantedCard : undefined;
  const wantedVersion = uuidSchema.safeParse(params.versionId).success ? params.versionId : undefined;
  const initialVersionId = wantedVersion && initialRateCardId && versionsByCard.get(initialRateCardId)?.some((v) => v.id === wantedVersion) ? wantedVersion : undefined;

  const manage = can(ctx.active.role, "ratecard.manage");

  return (
    <>
      <PageHeader title="Calculator" description="Price a shipment against a rate card and see every charge explained: what is definite, what is estimated, and what might be adjusted after shipping." />
      {model.length ? (
        <CalculatorForm cards={model} initialRateCardId={initialRateCardId} initialVersionId={initialVersionId} />
      ) : (
        <EmptyState title="No rate cards to price against" action={manage ? <ButtonLink href="/app/rate-cards">Go to rate cards</ButtonLink> : undefined}>
          The calculator prices shipments on your customer-facing rate cards. {manage ? "Create a rate card and import its first version, then come back here to test it." : "Ask a 3PL administrator to create and activate a rate card."}
        </EmptyState>
      )}
    </>
  );
}
