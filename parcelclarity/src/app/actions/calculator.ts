"use server";

import { boxOptionsFromSnapshot, calculatorBoxRequestSchema, calculatorRequestSchema } from "@/lib/pricing/calculator-schema";
import type { CalculatorBoxOptions, CalculatorFeesResponse, CalculatorRequest } from "@/lib/pricing/calculator-schema";
import { calculateShipment } from "@/engine/calculate";
import type { ShipmentCalculation, ShipmentInput } from "@/engine/types";
import { getContext, requireUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { loadPricingContext } from "@/lib/pricing/snapshot";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { CUSTOMER_PRICING_ISSUE } from "@/lib/adjustments/copy";
import { customerSafe, priceOrderFees } from "@/lib/pricing/customer-safe";
import { loadBrandFeeSchedule } from "@/lib/fees/queries";
import { createClient } from "@/lib/supabase/server";



export type { CalculatorRequest };

export interface CalculatorResponse {
  ok: boolean;
  message?: string;
  results?: ShipmentCalculation[];
  /** Staff only: which version priced the shipment. Customers get `effectiveDate` alone. */
  version?: { id: string; versionNumber: number; effectiveDate: string; expirationDate: string | null; status: string };
  effectiveDate?: string | null;
  /** Configuration problems found while loading (e.g. a rule version whose stored conditions no longer validate). Shown with the result. A customer gets one fixed sentence (never a rule's name); staff get the text. */
  issues?: string[];
  /** Present when the request carried what's in the box: the order fees of each result (same order as `results`), or why there are none. */
  fees?: CalculatorFeesResponse;
}

type Ctx = NonNullable<Awaited<ReturnType<typeof getContext>>>;

/** The customer staff may price for: one of their own tenant's brands, else null. */
async function ownBrandId(supabase: Awaited<ReturnType<typeof createClient>>, ctx: Ctx, brandId: string): Promise<string | null> {
  const { data: brand } = await supabase.from("brands").select("id, tenant_id").eq("id", brandId).maybeSingle();
  return brand && brand.tenant_id === ctx.active.tenantId ? brand.id : null;
}

/**
 * What the calculator's "What's in the box" block offers on a ship date: the packaging types, counts and
 * per-line questions of the customer's fee schedule version in effect that day, or why there is none.
 * The customer is the signed-in brand, or (3PL staff) one of the tenant's own brands; the schedule is read
 * through `brand_fee_schedule_on`, which authorises again on the caller and returns a customer-safe snapshot.
 */
export async function loadCalculatorBox(request: unknown): Promise<CalculatorBoxOptions> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || !can(ctx.active.role, "simulation.run")) return { status: "unavailable" };
  const parsed = calculatorBoxRequestSchema.safeParse(request);
  if (!parsed.success) return { status: "unavailable" };
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "calc.box", 1200, 3600))) return { status: "load_failed" };
  const brandId = ctx.active.portal === "brand" ? ctx.active.brandId : parsed.data.brandId ? await ownBrandId(supabase, ctx, parsed.data.brandId) : null;
  if (!brandId) return { status: "unavailable" };
  const schedule = await loadBrandFeeSchedule(supabase, brandId, parsed.data.shipDate);
  if (schedule.status === "ok") return boxOptionsFromSnapshot(schedule.activeVersion);
  if (schedule.status === "not_found") return { status: "unavailable" };
  return { status: schedule.status };
}

export async function priceShipment(request: unknown): Promise<CalculatorResponse> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || !can(ctx.active.role, "simulation.run")) return { ok: false, message: "You don't have permission to run calculations." };
  const parsed = calculatorRequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, message: `Check the inputs: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  const req = parsed.data;

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "calc.single", 600, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };

  const isBrand = ctx.active.portal === "brand";
  // Staff may price on behalf of one of their customers; the brand must be theirs, and drafts are then off limits.
  let onBehalf: string | null = null;
  if (!isBrand && req.brandId) {
    onBehalf = await ownBrandId(supabase, ctx, req.brandId);
    if (!onBehalf) return { ok: false, message: "That customer is not available to you." };
  }
  const loaded = await loadPricingContext(supabase, {
    rateCardId: req.rateCardId,
    shipDate: req.shipDate,
    versionId: isBrand || onBehalf ? undefined : req.versionId,
    brandId: isBrand ? ctx.active.brandId : onBehalf,
  });
  if (!loaded.ok) {
    const messages = {
      rate_card_not_found: "That rate card is not available to you.",
      no_version_in_effect: "No active version of this rate card is in effect on the ship date.",
      version_not_found: "That version is not available.",
      load_failed: "Pricing data could not be loaded right now. Try again in a moment.",
    } as const;
    return { ok: false, message: messages[loaded.error] };
  }
  const { snapshot } = loaded;
  // Pin the calculation to the active workspace: a user with several memberships can only price
  // what the workspace they are in may see (the database already limits brands to assigned cards).
  if (snapshot.tenantId !== ctx.active.tenantId) return { ok: false, message: "That rate card is not available to you." };

  const services = req.service === "*" ? snapshot.services : snapshot.services.filter((s) => `${s.carrierCode}/${s.serviceCode}` === req.service);
  if (!services.length) return { ok: false, message: "That service is not on this rate card." };

  const results = services.map((s) => {
    const input: ShipmentInput = {
      shipDate: req.shipDate,
      originZip: req.originZip,
      destinationZip: req.destinationZip,
      destinationZone: req.destinationZone,
      residential: req.residential,
      carrierCode: s.carrierCode,
      serviceCode: s.serviceCode,
      packages: req.packages.map((p) => ({
        weight: p.weight,
        weightUnit: p.weightUnit,
        length: p.length,
        width: p.width,
        height: p.height,
        declaredValue: p.declaredValue,
        packageType: p.packageType,
        flags: p.flags,
      })),
      options: { signature: req.signature, saturdayDelivery: req.saturdayDelivery },
    };
    return calculateShipment(input, snapshot.context);
  });

  // Order fees: only when the customer entered what's in the box. They are priced here, from the schedule
  // version in effect on the ship date, never from anything the client computed.
  let fees: CalculatorFeesResponse | undefined;
  if (req.box) {
    const feeBrand = isBrand ? ctx.active.brandId : onBehalf;
    if (!feeBrand) fees = { status: "no_schedule" };
    else {
      try {
        fees = priceOrderFees({ schedule: await loadBrandFeeSchedule(supabase, feeBrand, req.shipDate), box: req.box, calculations: results, audience: isBrand ? "brand" : "staff" });
      } catch {
        // The result says the fees could not be calculated; the shipping price (already computed) is not lost with them.
        fees = { status: "load_failed" };
      }
    }
  }

  const activity = supabase.rpc("log_audit_event", {
    p_tenant: snapshot.tenantId,
    p_brand: isBrand ? ctx.active.brandId : onBehalf,
    p_action: "simulation.single_shipment",
    p_entity_type: "rate_card_version",
    p_entity_id: snapshot.version.id,
    p_metadata: { services: services.length, packages: req.packages.length, statuses: results.map((r) => r.status), orderFees: fees?.status ?? null },
  });
  await activity;
  // The engine's message about a rule it could not apply names the rule, which is the 3PL's own text: a customer is told only that one could not be applied.
  if (isBrand) return { ok: true, results: results.map(customerSafe), effectiveDate: snapshot.version.effectiveDate, issues: snapshot.issues.length ? [CUSTOMER_PRICING_ISSUE] : [], ...(fees ? { fees } : {}) };
  return { ok: true, results, version: snapshot.version, effectiveDate: snapshot.version.effectiveDate, issues: snapshot.issues, ...(fees ? { fees } : {}) };
}
