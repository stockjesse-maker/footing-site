"use server";

import { z } from "zod";
import { calculateShipment } from "@/engine/calculate";
import type { ShipmentCalculation, ShipmentInput } from "@/engine/types";
import { getContext, requireUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { uuidSchema } from "@/lib/auth/validation";
import { loadPricingContext } from "@/lib/pricing/snapshot";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/);
const optionalDecimal = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), decimal.optional());

export const calculatorRequestSchema = z.object({
  rateCardId: uuidSchema,
  /** Staff may price against a specific (e.g. draft) version; brands always get the version in effect. */
  versionId: uuidSchema.optional(),
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  originZip: z.string().trim(),
  destinationZip: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().optional()),
  destinationZone: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().max(12).optional()),
  residential: z.boolean(),
  /** "carrier/serviceCode"; "*" compares every service on the card. */
  service: z.string().min(1),
  signature: z.enum(["none", "indirect", "direct", "adult"]).default("none"),
  saturdayDelivery: z.boolean().default(false),
  packages: z
    .array(
      z.object({
        weight: decimal,
        weightUnit: z.enum(["lb", "oz"]),
        length: optionalDecimal,
        width: optionalDecimal,
        height: optionalDecimal,
        declaredValue: optionalDecimal,
        packageType: z.enum(["parcel", "carrier_flat_rate", "envelope", "tube", "pallet"]).optional(),
        flags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export type CalculatorRequest = z.infer<typeof calculatorRequestSchema>;

export interface CalculatorResponse {
  ok: boolean;
  message?: string;
  results?: ShipmentCalculation[];
  version?: { id: string; versionNumber: number; effectiveDate: string; expirationDate: string | null; status: string };
}

/**
 * Prices a shipment for the signed-in user. 3PL staff can use any rate card of their tenant;
 * brand users only their assigned cards (Row Level Security makes anything else invisible).
 */
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
  const loaded = await loadPricingContext(supabase, {
    rateCardId: req.rateCardId,
    shipDate: req.shipDate,
    versionId: isBrand ? undefined : req.versionId,
    brandId: isBrand ? ctx.active.brandId : null,
  });
  if (!loaded.ok) {
    const messages = {
      rate_card_not_found: "That rate card is not available to you.",
      no_version_in_effect: "No active version of this rate card is in effect on the ship date.",
      version_not_found: "That version is not available.",
    } as const;
    return { ok: false, message: messages[loaded.error] };
  }
  const { snapshot } = loaded;

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
    p_brand: isBrand ? ctx.active.brandId : null,
    p_action: "simulation.single_shipment",
    p_entity_type: "rate_card_version",
    p_entity_id: snapshot.version.id,
    p_metadata: { services: services.length, packages: req.packages.length, statuses: results.map((r) => r.status) },
  });
  await activity;
  return { ok: true, results, version: snapshot.version };
}
