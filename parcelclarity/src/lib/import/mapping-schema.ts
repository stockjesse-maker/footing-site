import { z } from "zod";
import { uuidSchema } from "@/lib/auth/validation";

/** Zod schema for an administrator-approved rate-card mapping (see rate-card-mapping.ts). */
const longMappingSchema = z.object({
  format: z.literal("long"),
  sheet: z.string().min(1),
  headerRow: z.number().int().min(0),
  columns: z.object({
    carrier: z.number().int().min(0).nullable(),
    service: z.number().int().min(0),
    originZip: z.number().int().min(0).nullable(),
    zone: z.number().int().min(0),
    weightMin: z.number().int().min(0).nullable(),
    weightMax: z.number().int().min(0),
    weightUnit: z.number().int().min(0).nullable(),
    price: z.number().int().min(0),
    minCharge: z.number().int().min(0).nullable(),
    dimDivisor: z.number().int().min(0).nullable(),
  }),
  defaults: z.object({ weightUnit: z.enum(["lb", "oz"]), dimDivisor: z.string().regex(/^\d+(\.\d+)?$/).nullable() }),
  serviceMap: z.record(z.string(), uuidSchema),
});
const gridMappingSchema = z.object({
  format: z.literal("grid"),
  sheets: z
    .array(
      z.object({
        sheet: z.string().min(1),
        serviceId: uuidSchema,
        headerRow: z.number().int().min(0),
        weightColumn: z.number().int().min(0),
        weightUnit: z.enum(["lb", "oz"]),
        zoneColumns: z.array(z.object({ column: z.number().int().min(0), zone: z.string().min(1).max(12) })).min(1),
        originZip: z.string().regex(/^\d{3}$|^\d{5}$/).nullable(),
        dimDivisor: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
        minCharge: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
      }),
    )
    .min(1),
});
export const mappingSchema = z.discriminatedUnion("format", [longMappingSchema, gridMappingSchema]);

export type ParsedMapping = z.infer<typeof mappingSchema>;
