import { z } from "zod";
import { scrubJsonb } from "./jsonb-size";
import { ADJUSTMENT_FIELDS, type AdjustmentField, type AdjustmentMapping } from "./types";

/**
 * Zod shape of the mapping the 3PL approves (kept outside any "use server" module). It checks structure and sizes only;
 * `validateMapping` (mapping.ts) checks the mapping against the file and the header guard, and the database checks the
 * stored `fields` once more with its own forbidden-header test.
 */
const col = z.number().int().min(0).max(199).nullable();
const columns = Object.fromEntries(ADJUSTMENT_FIELDS.map((f) => [f, col])) as Record<AdjustmentField, typeof col>;

const TYPES = ["reweight", "remeasure", "combined", "correction"] as const;
const CAUSES = ["wms_no_weight", "scale_error", "carrier_reweigh", "carrier_remeasure", "packaging_change", "other"] as const;

/**
 * A key of a value map: the normalised text of a cell (letters, digits and single spaces), at most 120 characters, and never a control
 * character (a NUL would fail the whole database call) or a lone surrogate. It matches "scale error" and "яндекс"; it rejects "a\u0000b".
 */
const mapKey = z.string().max(120).refine((k) => scrubJsonb(k) === k && !/[\u0000-\u001f\u007f]/.test(k), "unreadable value");

/** A value map: normalised text to a value. 200 entries at most; the stored mapping as a whole is limited to 8 KB by the database. */
const valueMap = <T extends z.ZodType>(value: T) => z.record(mapKey, value).refine((m) => Object.keys(m).length <= 200, "too many values");

export const adjustmentMappingSchema = z.object({
  v: z.literal(1),
  sheet: z.string().min(1).max(120),
  headerRow: z.number().int().min(0).max(50),
  columns: z.object(columns),
  dateFormat: z.enum(["iso", "mdy", "dmy"]),
  weightUnit: z.enum(["lb", "oz", "g", "kg"]),
  dimensionUnit: z.enum(["in", "cm"]),
  duplicateHandling: z.enum(["refuse", "sum", "first"]),
  defaults: z.object({
    adjustmentType: z.enum(TYPES).nullable(),
    cause: z.enum(CAUSES),
    brandId: z.string().uuid().nullable(),
  }),
  typeMap: valueMap(z.enum(TYPES).nullable()),
  causeMap: valueMap(z.enum(CAUSES)),
  carrierMap: valueMap(z.string().min(1).max(40).nullable()),
  serviceMap: valueMap(z.string().uuid().nullable()),
  brandMap: valueMap(z.string().uuid().nullable()),
}) satisfies z.ZodType<AdjustmentMapping>;

/**
 * Reads the mapping back from adjustment_imports.mapping (the stored form keeps only mapped columns and adds `fields`).
 * Null when it is not a valid mapping.
 */
export function parseStoredMapping(json: unknown): AdjustmentMapping | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const { fields: _fields, columns: stored, ...rest } = json as Record<string, unknown>;
  const storedColumns = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const filled = Object.fromEntries(ADJUSTMENT_FIELDS.map((f) => [f, storedColumns[f] ?? null]));
  const result = adjustmentMappingSchema.safeParse({ ...rest, columns: filled });
  return result.success ? result.data : null;
}
