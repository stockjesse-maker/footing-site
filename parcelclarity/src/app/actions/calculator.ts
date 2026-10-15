"use server";

import { calculatorRequestSchema } from "@/lib/pricing/calculator-schema";
import type { CalculatorRequest } from "@/lib/pricing/calculator-schema";
import { calculateShipment } from "@/engine/calculate";
import type { ShipmentCalculation, ShipmentInput } from "@/engine/types";
import { getContext, requireUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { loadPricingContext } from "@/lib/pricing/snapshot";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { customerSafe } from "@/lib/pricing/customer-safe";
import { createClient } from "@/lib/supabase/server";



export type { CalculatorRequest };

export interface CalculatorResponse {
  ok: boolean;
  message?: string;
  results?: ShipmentCalculation[];
  /** Staff only: which version priced the shipment. Customers get `effectiveDate` alone. */
  version?: { id: string; versionNumber: number; effectiveDate: string; expirationDate: string | null; status: string };
  effectiveDate?: string | null;
  /** Configuration problems found while loading (e.g. a rule version whose stored conditions no longer validate). Shown with the result. */
  issues?: string[];
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
    const { data: brand } = await supabase.from("brands").select("id, tenant_id").eq("id", req.brandId).maybeSingle();
    if (!brand || brand.tenant_id !== ctx.active.tenantId) return { ok: false, message: "That customer is not available to you." };
    onBehalf = brand.id;
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

  const activity = supabase.rpc("log_audit_event", {
    p_tenant: snapshot.tenantId,
    p_brand: isBrand ? ctx.active.brandId : onBehalf,
    p_action: "simulation.single_shipment",
    p_entity_type: "rate_card_version",
    p_entity_id: snapshot.version.id,
    p_metadata: { services: services.length, packages: req.packages.length, statuses: results.map((r) => r.status) },
  });
  await activity;
  if (isBrand) return { ok: true, results: results.map(customerSafe), effectiveDate: snapshot.version.effectiveDate, issues: snapshot.issues };
  return { ok: true, results, version: snapshot.version, effectiveDate: snapshot.version.effectiveDate, issues: snapshot.issues };
}
