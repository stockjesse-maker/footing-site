import type { Metadata } from "next";
import Link from "next/link";
import { createRateCard } from "@/app/actions/rate-cards";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { formatEffectivity } from "@/components/pricing/version-rows-table";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Rate cards" };

interface CardRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

interface VersionRow {
  rate_card_id: string;
  version_number: number;
  status: string;
  effective_date: string | null;
  expiration_date: string | null;
}

/** The version customers are priced on today, the next scheduled one, and how many drafts wait. */
function summarize(versions: VersionRow[], today: string) {
  const active = versions.filter((v) => v.status === "active" && v.effective_date !== null);
  const current = active.find((v) => (v.effective_date ?? "") <= today && (!v.expiration_date || v.expiration_date >= today));
  const upcoming = active.find((v) => (v.effective_date ?? "") > today);
  const drafts = versions.filter((v) => v.status === "draft").length;
  return { current, upcoming, drafts };
}

export default async function RateCardsPage() {
  const ctx = await requireTenantContext("ratecard.view");
  const supabase = await createClient();
  const tenantId = ctx.active.tenantId;
  const [cardsRes, versionsRes, assignmentsRes] = await Promise.all([
    supabase.from("rate_cards").select("id, name, description, status").eq("tenant_id", tenantId).order("status").order("name").overrideTypes<CardRow[], { merge: false }>(),
    supabase
      .from("rate_card_versions")
      .select("rate_card_id, version_number, status, effective_date, expiration_date")
      .eq("tenant_id", tenantId)
      .in("status", ["draft", "active"])
      .order("effective_date", { ascending: true })
      .overrideTypes<VersionRow[], { merge: false }>(),
    supabase.from("brand_rate_card_assignments").select("rate_card_id").eq("tenant_id", tenantId).is("unassigned_at", null).overrideTypes<{ rate_card_id: string }[], { merge: false }>(),
  ]);

  const cards = cardsRes.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const versionsByCard = new Map<string, VersionRow[]>();
  for (const v of versionsRes.data ?? []) versionsByCard.set(v.rate_card_id, [...(versionsByCard.get(v.rate_card_id) ?? []), v]);
  const assignedByCard = new Map<string, number>();
  for (const a of assignmentsRes.data ?? []) assignedByCard.set(a.rate_card_id, (assignedByCard.get(a.rate_card_id) ?? 0) + 1);
  const manage = can(ctx.active.role, "ratecard.manage");

  return (
    <>
      <PageHeader title="Rate cards" description="The prices you charge customers for shipping. Each card is versioned: import a spreadsheet, review it, then activate it for a date range." />

      {manage ? (
        <Card className="mb-8">
          <CardTitle>New rate card</CardTitle>
          <CardDescription>One card per pricing agreement, for example a customer tier or a negotiated contract. You import its prices on the next screen.</CardDescription>
          <ActionForm action={createRateCard} className="mt-5 grid gap-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
            <TextField name="name" label="Name" autoComplete="off" required placeholder="e.g. Standard 2026" />
            <TextField name="description" label="Description (optional)" autoComplete="off" placeholder="Who it applies to or where it came from" />
            <SubmitButton pendingLabel="Creating…">Create rate card</SubmitButton>
          </ActionForm>
        </Card>
      ) : null}

      {cards.length ? (
        <DataList>
          {cards.map((card) => {
            const { current, upcoming, drafts } = summarize(versionsByCard.get(card.id) ?? [], today);
            const assigned = assignedByCard.get(card.id) ?? 0;
            const versionLine = current
              ? `Version ${current.version_number} in effect · ${formatEffectivity(current.effective_date, current.expiration_date)}`
              : upcoming
                ? `Version ${upcoming.version_number} scheduled · ${formatEffectivity(upcoming.effective_date, upcoming.expiration_date)}`
                : drafts
                  ? `${drafts} ${drafts === 1 ? "draft" : "drafts"} awaiting activation`
                  : "No prices yet. Import a spreadsheet to create the first version.";
            return (
              <DataRow key={card.id} className="p-0 sm:p-0">
                <Link href={`/app/rate-cards/${card.id}`} className="flex w-full flex-col gap-2 px-4 py-4 hover:bg-surface sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{card.name}</span>
                      {card.status !== "active" ? <Badge tone={statusTone(card.status)}>{card.status}</Badge> : null}
                      {drafts && current ? <Badge tone="neutral">{drafts === 1 ? "1 draft" : `${drafts} drafts`}</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{versionLine}</span>
                    {card.description ? <span className="mt-0.5 block truncate text-sm text-muted">{card.description}</span> : null}
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">
                    {current ? <Badge tone="success">In effect</Badge> : upcoming ? <Badge tone="accent">Scheduled</Badge> : drafts ? <Badge tone="neutral">Draft</Badge> : <Badge tone="warning">No version</Badge>}
                    <span className="tabular">
                      {assigned} {assigned === 1 ? "customer" : "customers"}
                    </span>
                  </span>
                </Link>
              </DataRow>
            );
          })}
        </DataList>
      ) : (
        <EmptyState title="No rate cards yet">
          A rate card holds the prices you charge a customer for shipping: a base rate for each service, zone and weight bracket, plus the DIM and minimum-charge terms you agreed. It never
          holds carrier buy rates. {manage ? "Create one above, then import its first version from a spreadsheet." : "Ask a 3PL administrator to create one."}
        </EmptyState>
      )}
    </>
  );
}
