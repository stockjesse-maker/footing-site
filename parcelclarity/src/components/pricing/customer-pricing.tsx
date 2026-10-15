import Link from "next/link";
import { assignRateCard, unassignRateCard } from "@/app/actions/rate-cards";
import { createOverride, endOverride } from "@/app/actions/surcharges";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/forms/action-form";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { DateField, DecimalField } from "@/components/pricing/service-terms-form";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { DataList, DataRow } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/format/date";
import { loadServiceCatalog } from "@/lib/pricing/catalog";
import { createClient } from "@/lib/supabase/server";

/**
 * "Pricing" section of the customer detail page: the rate cards assigned to the brand and the
 * surcharge exceptions that apply only to it. A Server Component: every query runs with the
 * signed-in user's client (Row Level Security), and the forms/buttons render only for managers.
 */

// ---------------------------------------------------------------------------
// Row shapes (the Supabase client is untyped; numeric columns may arrive as string or number)
// ---------------------------------------------------------------------------
interface AssignmentRow {
  id: string;
  rate_card_id: string;
  allowed_service_ids: string[] | null;
  assigned_at: string;
  rate_cards: { name: string; status: string } | null;
}

interface OverrideRow {
  id: string;
  mode: string;
  amount: string | number | null;
  percent: string | number | null;
  effective_date: string;
  expiration_date: string | null;
  reference: string;
  surcharge_rules: { name: string; rule_key: string; carrier_code: string } | null;
}

interface RuleRow {
  id: string;
  name: string;
  rule_key: string;
  carrier_code: string;
  scope: string;
  brand_id: string | null;
}

interface ServiceGroup {
  carrierCode: string;
  carrierName: string;
  services: { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: string | number | null) => (value === null ? "—" : usd.format(Number(value)));
const number = (value: string | number | null) => (value === null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 }));
const percent = (value: string | number | null) => (value === null ? "—" : `${number(value)}%`);

/** The exception in words, as the engine will apply it. */
export function describeOverride(mode: string, amount: string | number | null, pct: string | number | null): string {
  switch (mode) {
    case "exclude":
      return "Waived";
    case "override_amount":
      return `Charged at ${money(amount)}`;
    case "override_percent":
      return `Charged at ${percent(pct)}`;
    case "markup_percent":
      return `Published + ${percent(pct)}`;
    case "add_percent_points":
      return `Published + ${number(pct)} points`;
    default:
      return mode;
  }
}

const MODE_OPTIONS = [
  { value: "exclude", label: "Waived" },
  { value: "override_amount", label: "Fixed amount" },
  { value: "override_percent", label: "Fixed percentage" },
  { value: "markup_percent", label: "Published amount + markup %" },
  { value: "add_percent_points", label: "Published percentage + points" },
];

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------
export interface CustomerPricingProps {
  brandId: string;
  brandName: string;
  brandStatus: string;
  tenantId: string;
  /** True for ratecard.manage: shows the assign/exception forms and the unassign/end buttons. */
  canManage: boolean;
}

export async function CustomerPricing({ brandId, brandName, brandStatus, tenantId, canManage }: CustomerPricingProps) {
  const supabase = await createClient();
  const showForms = canManage && brandStatus === "active";

  const [assignments, overrides, cards, rules, catalog, carriers] = await Promise.all([
    supabase
      .from("brand_rate_card_assignments")
      .select("id, rate_card_id, allowed_service_ids, assigned_at, rate_cards(name, status)")
      .eq("brand_id", brandId)
      .eq("tenant_id", tenantId)
      .is("unassigned_at", null)
      .order("assigned_at", { ascending: false })
      .overrideTypes<AssignmentRow[], { merge: false }>(),
    supabase
      .from("customer_surcharge_overrides")
      .select("id, mode, amount, percent, effective_date, expiration_date, reference, surcharge_rules(name, rule_key, carrier_code)")
      .eq("brand_id", brandId)
      .eq("tenant_id", tenantId)
      .is("ended_at", null)
      .order("effective_date", { ascending: false })
      .overrideTypes<OverrideRow[], { merge: false }>(),
    showForms
      ? supabase.from("rate_cards").select("id, name").eq("tenant_id", tenantId).eq("status", "active").order("name").overrideTypes<{ id: string; name: string }[], { merge: false }>()
      : Promise.resolve({ data: null }),
    showForms
      ? supabase
          .from("surcharge_rules")
          .select("id, name, rule_key, carrier_code, scope, brand_id")
          .is("archived_at", null)
          .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
          .or(`brand_id.is.null,brand_id.eq.${brandId}`)
          .order("carrier_code")
          .order("name")
          .overrideTypes<RuleRow[], { merge: false }>()
      : Promise.resolve({ data: null }),
    loadServiceCatalog(supabase),
    supabase.from("carriers").select("code, name").overrideTypes<{ code: string; name: string }[], { merge: false }>(),
  ]);

  const serviceName = new Map(catalog.map((s) => [s.id, s.name]));
  const carrierName = new Map((carriers.data ?? []).map((c) => [c.code, c.name]));
  for (const s of catalog) if (!carrierName.has(s.carrierCode)) carrierName.set(s.carrierCode, s.carrierName);
  const carrierLabel = (code: string) => carrierName.get(code) ?? code.toUpperCase();

  const assigned = assignments.data ?? [];
  const assignedCardIds = new Set(assigned.map((a) => a.rate_card_id));
  const offeredCards = (cards.data ?? []).filter((c) => !assignedCardIds.has(c.id));
  const serviceGroups = showForms && offeredCards.length ? await loadServiceGroups(supabase, offeredCards.map((c) => c.id), catalog) : [];

  return (
    <section aria-labelledby="pricing-heading" className="space-y-8">
      <div>
        <h2 id="pricing-heading" className="text-xl font-semibold tracking-tight">Pricing</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The rate cards this customer can quote against, and surcharge exceptions that apply only to them.
          {canManage ? null : " Only administrators can change them."}
        </p>
      </div>

      <div className="space-y-3">
        <h3 id="assigned-cards-heading" className="text-sm font-semibold text-muted">Assigned rate cards</h3>
        <AssignedRateCards assignments={assigned} serviceName={serviceName} canManage={canManage} />
      </div>

      {showForms ? <AssignRateCardForm brandId={brandId} cards={offeredCards} groups={serviceGroups} hasActiveCards={(cards.data ?? []).length > 0} /> : null}

      <div className="space-y-3">
        <h3 id="exceptions-heading" className="text-sm font-semibold text-muted">Customer exceptions</h3>
        <p className="text-sm text-muted">
          An exception changes how a published surcharge is charged to {brandName} only; the rule itself and every other customer stay as they are. Each one is recorded in the activity log.
        </p>
        <OverridesList overrides={overrides.data ?? []} carrierLabel={carrierLabel} canManage={canManage} />
      </div>

      {showForms ? <CreateOverrideForm brandId={brandId} brandName={brandName} rules={rules.data ?? []} carrierLabel={carrierLabel} /> : null}
    </section>
  );
}

/** Services found on the offered cards' active/draft versions, grouped by carrier in catalog order. */
async function loadServiceGroups(supabase: Awaited<ReturnType<typeof createClient>>, rateCardIds: string[], catalog: Awaited<ReturnType<typeof loadServiceCatalog>>): Promise<ServiceGroup[]> {
  const { data: versions } = await supabase.from("rate_card_versions").select("id").in("rate_card_id", rateCardIds).in("status", ["active", "draft"]);
  const versionIds = (versions ?? []).map((v) => v.id as string);
  if (!versionIds.length) return [];
  const { data: terms } = await supabase.from("rate_card_service_terms").select("service_id").in("version_id", versionIds);
  const found = new Set((terms ?? []).map((t) => t.service_id as string));
  const groups = new Map<string, ServiceGroup>();
  for (const s of catalog) {
    if (!found.has(s.id)) continue;
    let group = groups.get(s.carrierCode);
    if (!group) {
      group = { carrierCode: s.carrierCode, carrierName: s.carrierName, services: [] };
      groups.set(s.carrierCode, group);
    }
    group.services.push({ id: s.id, name: s.name });
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Assigned rate cards
// ---------------------------------------------------------------------------
function AssignedRateCards({ assignments, serviceName, canManage }: { assignments: AssignmentRow[]; serviceName: Map<string, string>; canManage: boolean }) {
  if (!assignments.length) {
    return (
      <EmptyState title="No rate cards assigned">
        {canManage ? "Assign a rate card below so this customer can run calculations against it." : "This customer cannot run calculations until an administrator assigns a rate card."}
      </EmptyState>
    );
  }
  return (
    <DataList>
      {assignments.map((a) => {
        const allowed = a.allowed_service_ids;
        const names = allowed ? allowed.map((id) => serviceName.get(id)).filter((n): n is string => Boolean(n)) : [];
        const unresolved = allowed ? allowed.length - names.length : 0;
        const services = allowed === null ? "All services on the card" : `Limited to: ${names.join(", ")}${unresolved ? `${names.length ? " and " : ""}${unresolved} service${unresolved === 1 ? "" : "s"} no longer in the catalog` : ""}`;
        return (
          <DataRow key={a.id}>
            <div className="min-w-0">
              <p className="font-medium">
                <Link href={`/app/rate-cards/${a.rate_card_id}`} className="inline-flex min-h-11 items-center text-accent-text hover:underline">
                  {a.rate_cards?.name ?? "Rate card"}
                </Link>
              </p>
              <p className="text-sm text-muted">{services}</p>
              <p className="text-sm text-muted">Assigned {formatDate(a.assigned_at)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {a.rate_cards ? <Badge tone={statusTone(a.rate_cards.status)}>{a.rate_cards.status}</Badge> : null}
              {canManage ? (
                <ConfirmAction action={unassignRateCard.bind(null, a.id)} label="Unassign" confirmLabel="Unassign rate card" variant="danger">
                  The customer loses access to this card immediately.
                </ConfirmAction>
              ) : null}
            </div>
          </DataRow>
        );
      })}
    </DataList>
  );
}

function AssignRateCardForm({ brandId, cards, groups, hasActiveCards }: { brandId: string; cards: { id: string; name: string }[]; groups: ServiceGroup[]; hasActiveCards: boolean }) {
  return (
    <Card>
      <CardTitle>Assign a rate card</CardTitle>
      <CardDescription>The customer&apos;s users can quote and run calculations against assigned cards. Limit the services when the agreement does not cover the whole card.</CardDescription>
      {cards.length ? (
        <ActionForm action={assignRateCard} className="mt-5 space-y-5">
          <input type="hidden" name="brandId" value={brandId} />
          <div className="sm:max-w-md">
            <SelectField name="rateCardId" label="Rate card" options={cards.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
          {groups.length ? (
            <fieldset className="space-y-4">
              <legend className="text-sm font-medium">Limit to these services (optional)</legend>
              <p className="text-sm text-muted">Leave every box unchecked to allow all services on the card. Only services that appear on the card&apos;s active or draft version are listed.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {groups.map((g) => (
                  <div key={g.carrierCode} className="rounded-control bg-surface px-4 py-3">
                    <p className="text-sm font-semibold">{g.carrierName}</p>
                    <ul className="mt-1">
                      {g.services.map((s) => {
                        const id = `assign-service-${s.id}`;
                        return (
                          <li key={s.id}>
                            <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm">
                              <input id={id} type="checkbox" name="allowedServiceIds" value={s.id} className="size-5 shrink-0 accent-accent" />
                              {s.name}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="text-sm text-muted">Services to limit the assignment to will appear here once the card has an active or draft version. Without a limit the customer gets every service on the card.</p>
          )}
          <SubmitButton pendingLabel="Assigning…">Assign rate card</SubmitButton>
        </ActionForm>
      ) : (
        <p className="mt-4 text-sm text-muted">
          {hasActiveCards ? "Every active rate card is already assigned to this customer." : "You have no active rate cards yet."}{" "}
          <Link href="/app/rate-cards" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Go to rate cards
          </Link>
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Customer exceptions
// ---------------------------------------------------------------------------
function OverridesList({ overrides, carrierLabel, canManage }: { overrides: OverrideRow[]; carrierLabel: (code: string) => string; canManage: boolean }) {
  if (!overrides.length) {
    return (
      <EmptyState title="No exceptions">
        No customer-specific exceptions. Published surcharges apply as their rules and the assigned rate card&apos;s service terms state.{canManage ? "" : " Administrators can add exceptions."}
      </EmptyState>
    );
  }
  return (
    <DataList>
      {overrides.map((o) => {
        const rule = o.surcharge_rules;
        const dates = o.expiration_date ? `${formatDate(o.effective_date)} – ${formatDate(o.expiration_date)}` : `From ${formatDate(o.effective_date)}`;
        return (
          <DataRow key={o.id}>
            <div className="min-w-0">
              <p className="font-medium">
                {rule ? `${carrierLabel(rule.carrier_code)} · ${rule.name}` : "Surcharge rule"}
                {rule ? <span className="ml-2 text-sm font-normal text-muted">{rule.rule_key}</span> : null}
              </p>
              <p className="tabular text-sm text-muted">
                {dates} · Ref: {o.reference}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={o.mode === "exclude" ? "warning" : "accent"} className="tabular">
                {describeOverride(o.mode, o.amount, o.percent)}
              </Badge>
              {canManage ? (
                <ConfirmAction action={endOverride.bind(null, o.id)} label="End exception" confirmLabel="End exception" variant="danger">
                  The published rule applies again from now on.
                </ConfirmAction>
              ) : null}
            </div>
          </DataRow>
        );
      })}
    </DataList>
  );
}

function CreateOverrideForm({ brandId, brandName, rules, carrierLabel }: { brandId: string; brandName: string; rules: RuleRow[]; carrierLabel: (code: string) => string }) {
  const today = new Date().toISOString().slice(0, 10);
  const ruleOptions = rules.map((r) => ({
    value: r.id,
    label: `${carrierLabel(r.carrier_code)} · ${r.name}${r.brand_id ? " (this customer only)" : r.scope === "tenant" ? " (your rule)" : ""}`,
  }));
  return (
    <Card>
      <CardTitle>Add an exception</CardTitle>
      <CardDescription>
        Applies only to {brandName} and is recorded in the activity log. Choose the surcharge, say how this customer is charged instead, and reference the agreement that grants it.
      </CardDescription>
      {ruleOptions.length ? (
        <ActionForm action={createOverride} className="mt-5 space-y-5">
          <input type="hidden" name="brandId" value={brandId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField name="ruleId" label="Surcharge" options={ruleOptions} />
            <SelectField
              name="mode"
              label="How it is charged"
              options={MODE_OPTIONS}
              hint="Waived: never charged. Fixed: your amount or rate replaces the published one. Published + markup / points: the published amount or rate plus your percent or points."
            />
            <DecimalField id="override-amount" name="amount" label="Amount (USD)" placeholder="e.g. 4.50" hint="For Fixed amount." />
            <DecimalField id="override-percent" name="percent" label="Percent" placeholder="e.g. 10" hint="For Fixed percentage, markup and points." />
            <DateField id="override-effectiveDate" name="effectiveDate" label="Effective from" required defaultValue={today} />
            <DateField id="override-expirationDate" name="expirationDate" label="Expires on" hint="Leave empty if the exception is open-ended." />
          </div>
          <TextField name="reference" label="Reference" required placeholder="e.g. Pricing addendum, 1 Sep 2026" hint="The agreement or correspondence that grants this exception, with its date." />
          <SubmitButton pendingLabel="Saving…">Save exception</SubmitButton>
        </ActionForm>
      ) : (
        <p className="mt-4 text-sm text-muted">
          There are no surcharge rules to make an exception to yet.{" "}
          <Link href="/app/surcharges" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
            Go to surcharges
          </Link>
        </p>
      )}
    </Card>
  );
}
