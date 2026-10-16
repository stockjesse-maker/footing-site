"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { canonicalizeAssumptions, evaluateForecast, forecastPinnedRates, validateForecastAssumptions, type ForecastAssumptions, type ForecastSummary, type ForecastUnpriceable } from "@/engine/forecast";
import { ENGINE_VERSION } from "@/engine/types";
import type { ForecastContextResult } from "@/components/forecast/forecast-model";
import type { Audience, ForecastResultData } from "@/components/forecast/result-model";
import { can } from "@/lib/auth/permissions";
import { getContext, requireUser } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { loadBrandFeeSchedule } from "@/lib/fees/queries";
import { sha256Hex } from "@/lib/forecast/hash";
import { forecastResultData, loadForecastContext } from "@/lib/forecast/queries";
import { formatDate } from "@/lib/format/date";
import { loadPricingContext } from "@/lib/pricing/snapshot";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for forecasts from assumptions (Milestone 4, design §7). Brand members forecast for
 * their own brand; 3PL staff forecast on behalf of a customer by naming the brand. Nothing here trusts
 * the browser: the assumptions are validated again, the services are matched against the brand's
 * rate card (names come from the rate card, not from the form), the pricing context and the fee schedule
 * are loaded under the caller's Row Level Security, and a saved forecast is evaluated again on the
 * server and checked by `save_forecast_run` before anything is stored. A preview stores nothing.
 *
 * No carrier buy rate is read, stored or shown: forecasts price on the customer-facing rate card and
 * fee schedule only. Nothing here is an invoice or a quote.
 */

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const NO_PERMISSION = "You don't have permission to model costs for this customer.";

interface Actor {
  tenantId: string;
  brandId: string;
  staff: boolean;
  basePath: string;
  audience: Audience;
}

/** Who is forecasting for which brand: staff must name a brand of their tenant, brand members are bound to their own. */
async function forecastActor(brandIdFromClient: unknown): Promise<Actor | null> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || !can(ctx.active.role, "simulation.run")) return null;
  if (ctx.active.portal === "brand") return { tenantId: ctx.active.tenantId, brandId: ctx.active.brandId!, staff: false, basePath: "/portal/model", audience: "brand" };
  const brandId = String(brandIdFromClient ?? "");
  if (!uuidSchema.safeParse(brandId).success) return null;
  const supabase = await createClient();
  const { data: brand } = await supabase.from("brands").select("id, tenant_id, status").eq("id", brandId).maybeSingle();
  if (!brand || brand.tenant_id !== ctx.active.tenantId) return null;
  return { tenantId: ctx.active.tenantId, brandId, staff: true, basePath: `/app/customers/${brandId}/model`, audience: "staff" };
}

export interface ForecastCallOptions {
  /** When some orders cannot be priced: average over the priced ones instead of stopping (no all-in figure then). */
  priceOnlyCovered?: boolean;
  /** The rate card to price on; the customer's first (by name) when absent. */
  rateCardId?: string;
}

const optionsSchema = z.strictObject({ priceOnlyCovered: z.boolean().optional(), rateCardId: uuidSchema.optional() }).optional();

export type ForecastPreviewResponse =
  | { status: "ok"; result: ForecastResultData }
  /** Some cells cannot be priced from the rate card; nothing is estimated for them. */
  | { status: "blocked"; cellCount: number; unpriceable: ForecastUnpriceable[]; unpriceableSharePct: string }
  /** `problems` are the engine's ("parcels.0.weightLb: must be …"); the form shows them on the fields. */
  | { status: "invalid"; problems: string[] }
  | { status: "error"; message: string };

export type ForecastSaveResponse = { status: "saved"; projectId: string; href: string } | Exclude<ForecastPreviewResponse, { status: "ok" }>;

interface Pins {
  rateCardVersionId: string;
  ruleVersionIds: string[];
  zipListIds: string[];
  overrideIds: string[];
  loadIssues: string[];
  feeScheduleVersionId: string | null;
}

type Evaluated =
  | { kind: "ok"; summary: ForecastSummary; assumptions: ForecastAssumptions; pins: Pins; rateCardId: string }
  | { kind: "blocked"; cellCount: number; unpriceable: ForecastUnpriceable[]; unpriceableSharePct: string }
  | { kind: "invalid"; problems: string[] }
  | { kind: "error"; message: string };

/** The assumptions are stored in a jsonb column capped at 32 KB; a request far beyond that is refused before any work is done. */
const MAX_ASSUMPTIONS_CHARS = 40_000;

async function resolveRateCard(supabase: Awaited<ReturnType<typeof createClient>>, brandId: string, wanted: string | undefined): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("brand_rate_card_assignments")
    .select("rate_card_id, rate_cards(id, name, status)")
    .eq("brand_id", brandId)
    .is("unassigned_at", null)
    .overrideTypes<{ rate_card_id: string; rate_cards: { id: string; name: string; status: string } | null }[], { merge: false }>();
  if (error) return { ok: false, message: GENERIC_FAILURE };
  const active = (data ?? []).filter((a) => a.rate_cards && a.rate_cards.status === "active").sort((a, b) => a.rate_cards!.name.localeCompare(b.rate_cards!.name));
  if (!active.length) return { ok: false, message: "No rate card is assigned to this customer yet, so nothing can be priced." };
  if (wanted) return active.some((a) => a.rate_card_id === wanted) ? { ok: true, id: wanted } : { ok: false, message: "That rate card is not assigned to this customer." };
  return { ok: true, id: active[0]!.rate_card_id };
}

/** Answers for fees the schedule in effect on the date does not have (the form was built for another date, or the schedule changed). */
function staleAnswers(a: ForecastAssumptions, schedule: FeeScheduleSnapshot | null): string[] {
  if (a.fulfillment.skip) return [];
  const driverKeys = new Set<string>();
  const shareKeys = new Set<string>();
  for (const rule of schedule?.rules ?? []) {
    if (rule.basis === "driver" && rule.driver) driverKeys.add(rule.driver.key);
    if (rule.basis === "order_driver" && rule.driver) shareKeys.add(rule.driver.key);
  }
  const extra = Object.keys(a.fulfillment.drivers).some((k) => !driverKeys.has(k)) || Object.keys(a.fulfillment.orderShares).some((k) => !shareKeys.has(k));
  return extra ? [`Some of your answers are for fees that are not on the fee schedule in effect on ${formatDate(a.asOfDate)}. Reload the page, then answer again.`] : [];
}

async function evaluateOnServer(supabase: Awaited<ReturnType<typeof createClient>>, actor: Actor, raw: unknown, options: ForecastCallOptions): Promise<Evaluated> {
  let size = 0;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return { kind: "invalid", problems: ["The forecast could not be read."] };
  }
  if (size > MAX_ASSUMPTIONS_CHARS) return { kind: "invalid", problems: ["The forecast is too large. Use fewer rows."] };
  const problems = validateForecastAssumptions(raw);
  if (problems.length) return { kind: "invalid", problems };
  const given = raw as ForecastAssumptions;
  if (!given.services.every((s) => uuidSchema.safeParse(s.serviceId).success)) return { kind: "invalid", problems: ["A selected service is not available on your rate card."] };

  const card = await resolveRateCard(supabase, actor.brandId, options.rateCardId);
  if (!card.ok) return { kind: "error", message: card.message };
  const loaded = await loadPricingContext(supabase, { rateCardId: card.id, shipDate: given.asOfDate, brandId: actor.brandId, serviceIds: given.services.map((s) => s.serviceId) });
  if (!loaded.ok) {
    if (loaded.error === "no_version_in_effect") return { kind: "invalid", problems: [`asOfDate: your rate card has no rates in effect on ${formatDate(given.asOfDate)}. Choose another date.`] };
    if (loaded.error === "load_failed") return { kind: "error", message: "Your rate card could not be loaded. Please try again." };
    return { kind: "error", message: "That rate card is not available to this customer." };
  }
  const snapshot = loaded.snapshot;

  // Names, codes and ids of the services come from the rate card, never from the form.
  const known = new Map(snapshot.services.map((s) => [s.serviceId, s] as const));
  const missing: string[] = [];
  const services = given.services.map((s) => {
    const k = known.get(s.serviceId);
    if (!k) {
      missing.push(s.name.slice(0, 60));
      return s;
    }
    return { serviceId: k.serviceId, carrierCode: k.carrierCode, serviceCode: k.serviceCode, name: k.serviceName, sharePct: s.sharePct };
  });
  if (missing.length) return { kind: "invalid", problems: [`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not available on your rate card.`] };

  const fees = await loadBrandFeeSchedule(supabase, actor.brandId, given.asOfDate);
  if (fees.status === "not_found") return { kind: "error", message: NO_PERMISSION };
  // A schedule that cannot be read is never treated as "no fees": the forecast would silently drop them.
  if (fees.status === "load_failed") return { kind: "error", message: "Your fee schedule could not be loaded. Please try again." };
  const schedule = fees.status === "ok" ? fees.activeVersion : null;
  const stale = staleAnswers(given, schedule);
  if (stale.length) return { kind: "invalid", problems: stale };

  const assumptions = canonicalizeAssumptions({ ...given, services });
  let result: ReturnType<typeof evaluateForecast>;
  try {
    result = evaluateForecast(
      assumptions,
      { pricing: snapshot.context, schedule, pinnedRates: forecastPinnedRates(assumptions, schedule), feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex },
      { priceOnlyCovered: options.priceOnlyCovered === true },
    );
  } catch {
    // The engine throws only for a state it cannot price exactly (an amount too large to carry); the person sees a message, never a stack.
    return { kind: "error", message: "This forecast could not be priced. Check the numbers and try again." };
  }
  if (result.status === "invalid") return { kind: "invalid", problems: result.problems };
  if (result.status === "blocked") {
    // The engine's own messages can name rate card details; a customer reads the curated reasons instead.
    const unpriceable = actor.staff ? result.unpriceable : result.unpriceable.map((u) => ({ ...u, serviceId: "", message: "" }));
    return { kind: "blocked", cellCount: result.cellCount, unpriceable, unpriceableSharePct: result.unpriceableSharePct };
  }
  // The version pinned for the fee schedule is the one in effect on the date even when fulfillment costs were skipped (the database checks it).
  const feeScheduleVersionId = fees.status === "ok" ? fees.activeVersion.versionId : null;
  const pins: Pins = { rateCardVersionId: snapshot.pins.rateCardVersionId, ruleVersionIds: snapshot.pins.ruleVersionIds, zipListIds: snapshot.pins.zipListIds, overrideIds: snapshot.pins.overrideIds, loadIssues: snapshot.issues, feeScheduleVersionId };
  return { kind: "ok", summary: result.summary, assumptions, pins, rateCardId: card.id };
}

function failure(e: Exclude<Evaluated, { kind: "ok" }>): Exclude<ForecastPreviewResponse, { status: "ok" }> {
  switch (e.kind) {
    case "blocked":
      return { status: "blocked", cellCount: e.cellCount, unpriceable: e.unpriceable, unpriceableSharePct: e.unpriceableSharePct };
    case "invalid":
      return { status: "invalid", problems: e.problems };
    default:
      return { status: "error", message: e.message };
  }
}

/**
 * Prices a forecast from assumptions without storing anything: the expected value over the mix the
 * caller described, with the fee schedule's order fees, monthly charges and minimum, and the all-in
 * figure only when every category could be priced. Rate-limited per user.
 */
export async function previewForecast(assumptions: unknown, brandId?: string, options?: ForecastCallOptions): Promise<ForecastPreviewResponse> {
  const actor = await forecastActor(brandId);
  if (!actor) return { status: "error", message: NO_PERMISSION };
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) return { status: "error", message: GENERIC_FAILURE };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "forecast.preview", 240, 3600))) return { status: "error", message: RATE_LIMITED_MESSAGE };
  const evaluated = await evaluateOnServer(supabase, actor, assumptions, parsed.data ?? {});
  if (evaluated.kind !== "ok") return failure(evaluated);
  return { status: "ok", result: forecastResultData(evaluated.summary, actor.audience) };
}

const nameSchema = z.string().trim().min(1, "Give the forecast a name.").max(160, "Use at most 160 characters.");

/** Maps the database's refusals (SQLSTATE class PC and P0002) to sentences; anything else is the generic failure. */
function saveError(error: { code?: string; message: string }): string {
  if (error.code === "P0002") return "Customer not found.";
  if (/rate card is not assigned/.test(error.message)) return "That rate card is not assigned to this customer.";
  if (/no fee schedule is in effect/.test(error.message)) return "No fee schedule is in effect for this customer on that date, so fulfillment answers cannot be saved.";
  if (error.code === "PC003") return "The forecast could not be saved because its figures did not reconcile. Please try again; if it keeps failing, contact support.";
  return GENERIC_FAILURE;
}

/**
 * Evaluates the forecast again on the server (never trusting a result from the browser) and stores it
 * through `save_forecast_run`, which checks the identities of the figures and pins the rate card
 * version, rule versions, ZIP lists and fee schedule version used. Returns where to find it.
 */
export async function saveForecast(assumptions: unknown, name: string, brandId?: string, options?: ForecastCallOptions): Promise<ForecastSaveResponse> {
  const actor = await forecastActor(brandId);
  if (!actor) return { status: "error", message: NO_PERMISSION };
  const parsedName = nameSchema.safeParse(name);
  if (!parsedName.success) return { status: "invalid", problems: [`name: ${parsedName.error.issues[0]?.message ?? "Give the forecast a name."}`] };
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) return { status: "error", message: GENERIC_FAILURE };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "forecast.save", 120, 3600))) return { status: "error", message: RATE_LIMITED_MESSAGE };
  const evaluated = await evaluateOnServer(supabase, actor, assumptions, parsed.data ?? {});
  if (evaluated.kind !== "ok") return failure(evaluated);

  const { data, error } = await supabase.rpc("save_forecast_run", {
    p_brand: actor.brandId,
    p_rate_card: evaluated.rateCardId,
    p_name: parsedName.data,
    p_assumptions: evaluated.assumptions,
    p_summary: evaluated.summary,
    p_pins: evaluated.pins,
    p_engine_version: ENGINE_VERSION,
    p_fee_engine_version: FEE_ENGINE_VERSION,
  });
  if (error || typeof data !== "string") return { status: "error", message: error ? saveError(error) : GENERIC_FAILURE };
  revalidatePath(actor.basePath, "layout");
  revalidatePath(actor.staff ? `/app/customers/${actor.brandId}` : "/portal", "layout");
  return { status: "saved", projectId: data, href: `${actor.basePath}/forecast/${data}` };
}

const contextInputSchema = z.strictObject({
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => {
      // A date that does not exist ("2026-02-30") is an invalid Date, whose toISOString() throws.
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }),
  originZip: z.string().max(10).optional(),
  rateCardId: uuidSchema.optional(),
});

/**
 * What the form can choose from for a rate card, date and ship-from ZIP: the services with the zones
 * the rate card prices, and the fee schedule in effect on the date. The form asks again whenever one of
 * the three changes, so a date in another rate card version or fee schedule version never shows stale
 * choices.
 */
export async function loadForecastFormContext(input: unknown, brandId?: string): Promise<ForecastContextResult> {
  const actor = await forecastActor(brandId);
  if (!actor) return { status: "failed", message: NO_PERMISSION };
  const parsed = contextInputSchema.safeParse(input);
  if (!parsed.success) return { status: "failed", message: "Choose a valid date." };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "forecast.context", 600, 3600))) return { status: "failed", message: RATE_LIMITED_MESSAGE };
  const { data: tenant } = await supabase.from("tenants").select("default_origin_zip").eq("id", actor.tenantId).maybeSingle();
  return loadForecastContext(supabase, {
    brandId: actor.brandId,
    tenantDefaultOriginZip: (tenant?.default_origin_zip as string | null | undefined) ?? null,
    rateCardId: parsed.data.rateCardId ?? null,
    asOfDate: parsed.data.asOfDate,
    originZip: parsed.data.originZip ?? null,
  });
}
