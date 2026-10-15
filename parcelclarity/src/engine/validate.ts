import { z } from "zod";
import type { ShipmentInput } from "./types";

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");
const positiveDecimal = decimalString.refine((v) => Number.parseFloat(v) > 0, "must be greater than zero");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date").refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "must be a real calendar date");

/** Accepts "12345", "12345-6789" or "123456789"; yields the 5-digit ZIP. */
export const zipSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^\d{5}(\d{4})?$/, "must be a 5-digit US ZIP code"))
  .transform((v) => v.slice(0, 5));

export const packageSchema = z
  .object({
    weight: positiveDecimal,
    weightUnit: z.enum(["lb", "oz"]),
    length: positiveDecimal.optional(),
    width: positiveDecimal.optional(),
    height: positiveDecimal.optional(),
    dimensionUnit: z.literal("in").optional(),
    packageType: z.enum(["parcel", "carrier_flat_rate", "envelope", "tube", "pallet"]).optional(),
    declaredValue: decimalString.optional(),
    flags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    reference: z.string().max(120).optional(),
  })
  .refine((p) => [p.length, p.width, p.height].every((d) => d === undefined) || [p.length, p.width, p.height].every((d) => d !== undefined), {
    message: "provide all three dimensions or none",
    path: ["length"],
  });

export const shipmentSchema = z
  .object({
    shipDate: isoDate,
    originZip: zipSchema,
    destinationZip: zipSchema.optional(),
    destinationZone: z.string().trim().min(1).max(12).optional(),
    destinationCountry: z.literal("US").optional(),
    residential: z.boolean(),
    carrierCode: z.string().min(1).max(40),
    serviceCode: z.string().min(1).max(40),
    packages: z.array(packageSchema).min(1, "at least one package").max(200, "at most 200 packages per shipment"),
    options: z
      .object({ signature: z.enum(["none", "indirect", "direct", "adult"]).optional(), saturdayDelivery: z.boolean().optional() })
      .optional(),
    orderId: z.string().max(120).optional(),
    shipmentId: z.string().max(120).optional(),
  })
  .refine((s) => s.destinationZip !== undefined || s.destinationZone !== undefined, {
    message: "provide a destination ZIP or a destination zone",
    path: ["destinationZip"],
  });

export type ValidShipment = z.infer<typeof shipmentSchema>;

export function validateShipment(input: unknown): { ok: true; value: ValidShipment } | { ok: false; problems: string[] } {
  const parsed = shipmentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as ValidShipment };
  const problems = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
  return { ok: false, problems };
}

export function isValidShipment(input: unknown): input is ShipmentInput {
  return shipmentSchema.safeParse(input).success;
}

// ---------------------------------------------------------------------------
// Rule schemas (used when a 3PL configures surcharges and when loading rows from the database)
// ---------------------------------------------------------------------------
const zoneList = z.array(z.string().trim().min(1).max(12)).min(1).max(50);
const inches = z.string().regex(/^\d+(\.\d+)?$/);

export const ruleConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("residential"), value: z.boolean() }),
  z.object({ type: z.literal("weight_gt"), valueLb: inches, basis: z.enum(["actual", "billable"]) }),
  z.object({ type: z.literal("weight_lte"), valueLb: inches, basis: z.enum(["actual", "billable"]) }),
  z.object({ type: z.literal("longest_side_gt"), inches }),
  z.object({ type: z.literal("second_longest_side_gt"), inches }),
  z.object({ type: z.literal("length_plus_girth_gt"), inches }),
  z.object({ type: z.literal("cubic_in_gt"), value: inches }),
  z.object({ type: z.literal("zone_in"), zones: zoneList }),
  z.object({ type: z.literal("destination_zip_in_list"), listKey: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/) }),
  z.object({ type: z.literal("destination_zip_prefix_in"), prefixes: z.array(z.string().regex(/^\d{3,5}$/)).min(1).max(500) }),
  z.object({ type: z.literal("declared_value_gt"), amount: inches }),
  z.object({ type: z.literal("signature_in"), values: z.array(z.enum(["none", "indirect", "direct", "adult"])).min(1) }),
  z.object({ type: z.literal("saturday_delivery"), value: z.boolean() }),
  z.object({ type: z.literal("package_type_in"), types: z.array(z.enum(["parcel", "carrier_flat_rate", "envelope", "tube", "pallet"])).min(1) }),
  z.object({ type: z.literal("flag_present"), flag: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal("ship_date_between"), from: isoDate, to: isoDate }),
  z.object({ type: z.literal("package_count_gt"), value: z.number().int().min(0).max(200) }),
]);

export const calculationBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("base_rate") }),
  z.object({ kind: z.literal("base_plus_all_surcharges") }),
  z.object({
    kind: z.literal("base_plus_categories"),
    categories: z
      .array(z.enum(["fuel", "residential", "das", "das_extended", "remote_area", "additional_handling", "oversize", "peak", "address_correction", "signature", "declared_value", "saturday_delivery", "reweight", "remeasure", "shipping_charge_correction", "other"]))
      .min(1),
  }),
]);
