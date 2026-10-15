import { z } from "zod";
import type { OrderMapping } from "./types";

/** Zod shape of the mapping the customer approves in the wizard (kept outside the "use server" module). */
const col = z.number().int().min(0).max(199).nullable();

export const orderMappingSchema = z.object({
  sheet: z.string().min(1).max(120),
  headerRow: z.number().int().min(0).max(50),
  format: z.enum(["generic", "shopify", "shiphero"]),
  columns: z.object({
    orderId: z.number().int().min(0).max(199),
    shipmentId: col,
    packageId: col,
    orderDate: col,
    shipDate: col,
    originZip: col,
    destinationZip: col,
    country: col,
    residential: col,
    carrier: col,
    service: col,
    weight: col,
    weightUnit: col,
    length: col,
    width: col,
    height: col,
    declaredValue: col,
    sku: col,
    units: col,
    packaging: col,
    cancelled: col,
  }),
  grouping: z.object({
    shipments: z.enum(["by_shipment_id", "one_per_order", "one_per_row"]),
    packages: z.enum(["by_package_columns", "one_per_shipment", "one_per_row"]),
  }),
  dateFormat: z.enum(["iso", "mdy", "dmy"]),
  weightUnit: z.enum(["lb", "oz", "g", "kg"]),
  padShortZips: z.boolean(),
  serviceMap: z.record(z.string().max(200), z.string().uuid().nullable()).refine((m) => Object.keys(m).length <= 500, "too many services"),
  useSkuProfiles: z.boolean(),
  defaults: z.object({
    originZip: z.string().regex(/^\d{5}$/).nullable(),
    residential: z.boolean().nullable(),
  }),
}) satisfies z.ZodType<OrderMapping>;

export const runSettingsSchema = z.object({
  pricingBasis: z.enum(["ship_date", "fixed_date"]),
  asOfDate: z.preprocess((v) => (v === "" || v === null ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
  serviceOverrideId: z.preprocess((v) => (v === "" || v === null ? null : v), z.string().uuid().nullable()),
  unmappedPolicy: z.enum(["exclude", "use_override"]),
  overrideAllServices: z.boolean(),
  residentialDefault: z.boolean().nullable(),
  originZipDefault: z.preprocess((v) => (v === "" || v === null ? null : v), z.string().regex(/^\d{5}$/).nullable()),
});

export type RunSettings = z.infer<typeof runSettingsSchema>;
