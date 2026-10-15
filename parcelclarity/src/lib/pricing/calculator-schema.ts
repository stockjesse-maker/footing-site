import { z } from "zod";
import { uuidSchema } from "@/lib/auth/validation";

/** Request shape accepted by the priceShipment server action (kept outside the "use server" module). */
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
