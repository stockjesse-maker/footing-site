import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countPercentOfShippingFees } from "@/engine/adjustments/scenario";
import type { AdjustmentScenarioInput, AdjustmentType, PackageCorrection } from "@/engine/adjustments/types";
import { latestPerKey, ruleIsCandidate } from "@/engine/surcharges";
import type { PackageInput, PricingContext, ShipmentInput } from "@/engine/types";
import { loadBrandFeeSchedule } from "@/lib/fees/queries";
import { loadPricingContext, type LoadedSnapshot, type ServiceOption } from "@/lib/pricing/snapshot";
import type { ScenarioBuilderInput } from "./action-schemas";

/**
 * Pricing-context helpers for the example builder (Milestone 5). A scenario is priced on the 3PL's customer-facing rate card and
 * rules only, in the customer's own context (their exceptions, brand-scoped rules and allowed services), and with the
 * UNFILTERED rule set (`adjustmentView`): a reweigh, remeasure or correction fee that the 3PL's decision says is absorbed leaves
 * the customer's own pricing context, but the staff evaluation must still see it to price what is not billed.
 *
 * Nothing here is a carrier cost. The session decides the tenant; the customer and the card come from the form and are
 * checked against it (the database authorizes them again).
 */

/** The three categories of fee that only ever apply after shipping; they are conditional charges, never part of a counted total. */
const FEE_CATEGORIES: ReadonlySet<string> = new Set(["reweight", "remeasure", "shipping_charge_correction"]);

/** Fee categories kept on the corrected pricing of each type (`shipping_charge_correction` for every type), as the engine keeps them. */
function feeCategoriesInScope(type: AdjustmentType): ReadonlySet<string> {
  if (type === "reweight") return new Set(["reweight", "shipping_charge_correction"]);
  if (type === "remeasure") return new Set(["remeasure", "shipping_charge_correction"]);
  return new Set(["reweight", "remeasure", "shipping_charge_correction"]);
}

export interface AssignedCard {
  id: string;
  name: string;
  /** null = every service of the card. */
  allowedServiceIds: string[] | null;
}

interface AssignmentRow {
  rate_card_id: string;
  allowed_service_ids: string[] | null;
  rate_cards: { id: string; name: string; status: string } | null;
}

/** The active rate cards assigned to a customer, by name (the builder's card choices). */
export async function assignedRateCards(supabase: SupabaseClient, brandId: string): Promise<AssignedCard[]> {
  const { data, error } = await supabase
    .from("brand_rate_card_assignments")
    .select("rate_card_id, allowed_service_ids, rate_cards(id, name, status)")
    .eq("brand_id", brandId)
    .is("unassigned_at", null)
    .overrideTypes<AssignmentRow[], { merge: false }>();
  if (error) throw new Error(`the customer's rate cards could not be loaded: ${error.message}`);
  return (data ?? [])
    .filter((a) => a.rate_cards && a.rate_cards.status === "active")
    .map((a) => ({ id: a.rate_card_id, name: a.rate_cards!.name, allowedServiceIds: a.allowed_service_ids?.length ? a.allowed_service_ids : null }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export type ScenarioContextError = "no_card" | "card_not_assigned" | "rate_card_not_found" | "no_version_in_effect" | "service_not_available" | "customer_not_found" | "fee_schedule_failed" | "load_failed";

export const SCENARIO_CONTEXT_MESSAGES: Record<ScenarioContextError, string> = {
  no_card: "No rate card is assigned to this customer yet, so nothing can be priced.",
  card_not_assigned: "That rate card is not assigned to this customer.",
  rate_card_not_found: "That rate card is not available to you.",
  no_version_in_effect: "No active version of the rate card is in effect on the pricing date. Choose another date.",
  service_not_available: "That service is not on the customer's rate card, or the customer may not use it.",
  customer_not_found: "Customer not found.",
  fee_schedule_failed: "The customer's fee schedule could not be loaded. Please try again.",
  load_failed: "Pricing data could not be loaded right now. Try again in a moment.",
};

export type ScenarioContext =
  | {
      ok: true;
      snapshot: LoadedSnapshot;
      card: { id: string; name: string };
      service: ServiceOption;
      /** Percent-of-shipping fees of the customer's fee schedule in effect on the date (detected, never modelled); undefined without a customer. */
      percentOfShippingFeeCount: number | undefined;
    }
  | { ok: false; error: ScenarioContextError; message: string };

const fail = (error: ScenarioContextError): { ok: false; error: ScenarioContextError; message: string } => ({ ok: false, error, message: SCENARIO_CONTEXT_MESSAGES[error] });

/**
 * Loads the pricing context an example is priced in. For a customer: the customer's assigned cards (the one asked for, else the
 * first by name that has the service), priced in the customer's context with the unfiltered rule set. Without a customer (an
 * exploration that cannot be shared): the named card of the account, in the account's context.
 *
 * `tenantId` is the session's. A card of another tenant (a user who belongs to two) is refused here, not only by the database.
 */
export async function loadScenarioContext(
  supabase: SupabaseClient,
  opts: { tenantId: string; brandId: string | null; rateCardId?: string | null; serviceId: string; shipDate: string },
): Promise<ScenarioContext> {
  let candidates: { id: string; name: string | null }[];
  if (opts.brandId) {
    const cards = await assignedRateCards(supabase, opts.brandId);
    if (!cards.length) return fail("no_card");
    if (opts.rateCardId && !cards.some((c) => c.id === opts.rateCardId)) return fail("card_not_assigned");
    candidates = (opts.rateCardId ? cards.filter((c) => c.id === opts.rateCardId) : cards).filter((c) => !c.allowedServiceIds || c.allowedServiceIds.includes(opts.serviceId));
    if (!candidates.length) return fail("service_not_available");
  } else {
    if (!opts.rateCardId) return fail("no_card");
    candidates = [{ id: opts.rateCardId, name: null }];
  }

  let lastError: ScenarioContextError = "service_not_available";
  for (const candidate of candidates) {
    const loaded = await loadPricingContext(supabase, { rateCardId: candidate.id, shipDate: opts.shipDate, brandId: opts.brandId, serviceIds: [opts.serviceId], adjustmentView: true });
    if (!loaded.ok) {
      // An outage is retried by the caller; anything else may be true of this card only, so the next card is tried.
      if (loaded.error === "load_failed") return fail("load_failed");
      lastError = loaded.error === "no_version_in_effect" ? "no_version_in_effect" : loaded.error === "version_not_found" ? "no_version_in_effect" : "rate_card_not_found";
      continue;
    }
    const snapshot = loaded.snapshot;
    if (snapshot.tenantId !== opts.tenantId) return fail("rate_card_not_found");
    const service = snapshot.services.find((s) => s.serviceId === opts.serviceId);
    if (!service) {
      lastError = "service_not_available";
      continue;
    }
    let percentOfShippingFeeCount: number | undefined;
    if (opts.brandId) {
      const fees = await loadBrandFeeSchedule(supabase, opts.brandId, opts.shipDate);
      if (fees.status === "not_found") return fail("customer_not_found");
      // A schedule that cannot be read is never treated as "no percent fees": the notice would be silently missing.
      if (fees.status === "load_failed") return fail("fee_schedule_failed");
      percentOfShippingFeeCount = fees.status === "ok" ? countPercentOfShippingFees(fees.activeVersion.rules) : 0;
    }
    return { ok: true, snapshot, card: { id: candidate.id, name: snapshot.context.rateCard.rateCardName }, service, percentOfShippingFeeCount };
  }
  return fail(lastError);
}

/** The engine's input from the builder's form: the declared shipment and one correction per package. Only fields the form gave are set. */
export function buildScenarioInput(form: ScenarioBuilderInput, service: ServiceOption, shipDate: string): AdjustmentScenarioInput {
  const packages: PackageInput[] = form.packages.map(({ declared }) => ({
    weight: declared.weight,
    weightUnit: declared.weightUnit,
    ...(declared.length !== undefined && declared.width !== undefined && declared.height !== undefined ? { length: declared.length, width: declared.width, height: declared.height } : {}),
  }));
  const corrections: PackageCorrection[] = form.packages.map(({ correction }) => ({
    ...(correction.weight !== undefined ? { weight: correction.weight } : {}),
    ...(correction.weightUnit !== undefined ? { weightUnit: correction.weightUnit } : {}),
    ...(correction.length !== undefined && correction.width !== undefined && correction.height !== undefined ? { length: correction.length, width: correction.width, height: correction.height } : {}),
  }));
  const shipment: ShipmentInput = {
    shipDate,
    originZip: form.originZip,
    ...(form.destinationZip !== undefined ? { destinationZip: form.destinationZip } : {}),
    ...(form.destinationZone !== undefined ? { destinationZone: form.destinationZone } : {}),
    residential: form.residential,
    carrierCode: service.carrierCode,
    serviceCode: service.serviceCode,
    packages,
  };
  return { shipment, corrections, declaredSource: form.declaredSource };
}

/**
 * The rule versions an example depends on: every rule the engine considers for the service and date (the latest version of each
 * key, as the engine picks them), leaving out adjustment-fee rules of categories the scenario's type does not use. A superset of
 * the rules that fired is the safe side: the database marks a shared example "under review" when any pinned rule changes, and an
 * unpinned rule that changed an amount would leave a stale figure in front of a customer.
 */
export function candidateRuleVersionIds(ctx: Pick<PricingContext, "rules">, shipment: Pick<ShipmentInput, "carrierCode" | "serviceCode" | "shipDate">, type: AdjustmentType): string[] {
  const inScope = feeCategoriesInScope(type);
  const rules = latestPerKey(ctx.rules.filter((r) => ruleIsCandidate(r, shipment.carrierCode, shipment.serviceCode, shipment.shipDate))).filter((r) => !FEE_CATEGORIES.has(r.category) || inScope.has(r.category));
  return [...new Set(rules.map((r) => r.versionId))].sort();
}

/** What `save_adjustment_scenario` pins: the rate card version priced on, the rules and the customer's exceptions in force, and the date. */
export interface ScenarioPins {
  rateCardVersionId: string;
  ruleVersionIds: string[];
  overrideIds: string[];
  pricedOn: string;
}

export function scenarioPins(snapshot: Pick<LoadedSnapshot, "context" | "pins">, shipment: ShipmentInput, type: AdjustmentType, brandId: string | null): ScenarioPins {
  return {
    rateCardVersionId: snapshot.pins.rateCardVersionId,
    ruleVersionIds: candidateRuleVersionIds(snapshot.context, shipment, type),
    // The customer's live exceptions as loaded (the database keeps only those on pinned rules when it compares); none without a customer.
    overrideIds: brandId ? [...snapshot.pins.overrideIds].sort() : [],
    pricedOn: shipment.shipDate,
  };
}
