import Decimal from "decimal.js";
import { z } from "zod";
import { normalizeZone } from "../zones";
import { FORECAST_LIMITS, type ForecastAssumptions, type ForecastCell, type ForecastContent, type ForecastContentRow, type ForecastFulfillment, type ForecastGrid, type ForecastGridCounts, type ForecastParcel, type ForecastService, type ForecastZone } from "./types";

/**
 * Validation, canonical form and the weighted profile grid (design §7). Weights are products of up
 * to seven decimals with at most nine significant digits each, so a 60-digit Decimal keeps every
 * weight and every sum exact: no rounding happens anywhere in this file.
 */
export const X = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -50, toExpPos: 60 });
export type Xd = InstanceType<typeof X>;

/** The canonical text of a decimal string: no leading or trailing zeros ("033.30" → "33.3", "100.00" → "100"). */
export function canonicalDecimal(value: string): string {
  return new X(value).toFixed();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DECIMAL_4 = /^\d{1,12}(\.\d{1,4})?$/;
const SHARE = /^\d{1,3}(\.\d{1,2})?$/;
const SLUG = /^[a-z][a-z0-9_]{0,60}$/;

/** Zod keeps running refinements after a failed regex, so every numeric refinement passes a string the regex already rejected. */
const within = (re: RegExp, test: (v: Xd) => boolean) => (v: string) => !re.test(v) || test(new X(v));
const decimal4 = z.string().regex(DECIMAL_4, "must be a number with up to 4 decimals");
const positive4 = decimal4.refine((v) => !DECIMAL_4.test(v) || /[1-9]/.test(v), "must be greater than zero");
const atMost = (max: number) => within(DECIMAL_4, (v) => v.lte(max));
const share = z
  .string()
  .regex(SHARE, "must be a percentage with up to 2 decimals")
  .refine(within(SHARE, (v) => v.lte(100)), "must be at most 100");
const rowShare = share.refine((v) => !SHARE.test(v) || /[1-9]/.test(v), "must be greater than zero (remove the row instead)");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "must be a real calendar date");
const packagingType = z.string().trim().min(1, "must not be blank (use null for unknown)").max(60).nullable();

const parcelSchema = z
  .strictObject({
    weightLb: positive4.refine(atMost(10_000), "must be at most 10,000 lb"),
    lengthIn: positive4.refine(atMost(1_000), "must be at most 1,000 in").optional(),
    widthIn: positive4.refine(atMost(1_000), "must be at most 1,000 in").optional(),
    heightIn: positive4.refine(atMost(1_000), "must be at most 1,000 in").optional(),
    packagingType,
    sharePct: rowShare,
    unknownSize: z.boolean().optional(),
  })
  .refine((p) => [p.lengthIn, p.widthIn, p.heightIn].every((d) => d === undefined) || [p.lengthIn, p.widthIn, p.heightIn].every((d) => d !== undefined), {
    message: "give all three dimensions or none",
    path: ["lengthIn"],
  })
  .refine((p) => !(p.unknownSize && p.lengthIn !== undefined), { message: "a parcel with dimensions cannot also be of unknown size", path: ["unknownSize"] });

const zoneSchema = z.strictObject({
  zone: z.string().trim().min(1, "must not be blank").max(12),
  sharePct: rowShare,
});

const serviceSchema = z.strictObject({
  serviceId: z.string().min(1).max(120),
  carrierCode: z.string().min(1).max(40),
  serviceCode: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  sharePct: rowShare,
});

const contentRowSchema = z
  .strictObject({
    units: z.number().int().min(1).max(FORECAST_LIMITS.unitsMax),
    lines: z.number().int().min(1).max(FORECAST_LIMITS.unitsMax),
    sharePct: rowShare,
  })
  .refine((r) => r.lines <= r.units, { message: "an order cannot have more lines than items", path: ["lines"] });

const average = positive4.refine(
  within(DECIMAL_4, (v) => v.gte(1) && v.lte(FORECAST_LIMITS.unitsMax)),
  `must be between 1 and ${FORECAST_LIMITS.unitsMax}`,
);

const contentSchema = z
  .strictObject({
    rows: z.array(contentRowSchema).min(1).max(FORECAST_LIMITS.contentRows).optional(),
    averageUnits: average.optional(),
    averageLines: average.optional(),
  })
  .refine((c) => (c.rows !== undefined && c.averageUnits === undefined && c.averageLines === undefined) || (c.rows === undefined && c.averageUnits !== undefined && c.averageLines !== undefined), {
    message: "describe the typical order either as rows or as averageUnits and averageLines",
  });

const driverAnswer = decimal4.refine(atMost(1_000_000_000), "is out of range").nullable();
const orderShareAnswer = z
  .strictObject({
    sharePct: share,
    countPerOrder: z.number().int().min(1).max(1000),
  })
  .nullable();

const fulfillmentSchema = z.strictObject({
  skip: z.boolean().optional(),
  drivers: z.record(z.string().regex(SLUG, "is not a valid question key"), driverAnswer),
  orderShares: z.record(z.string().regex(SLUG, "is not a valid question key"), orderShareAnswer),
  packagingDefault: z.string().trim().min(1).max(60).nullable().optional(),
});

const assumptionsSchema = z.strictObject({
  version: z.literal(1),
  monthlyOrders: z
    .string()
    .regex(/^\d{1,8}$/, "must be a whole number of orders")
    .refine(within(/^\d{1,8}$/, (v) => v.gte(FORECAST_LIMITS.monthlyOrdersMin) && v.lte(FORECAST_LIMITS.monthlyOrdersMax)), "must be between 1 and 5,000,000"),
  asOfDate: isoDate,
  originZip: z.string().regex(/^\d{5}$/, "must be a 5-digit US ZIP code"),
  parcels: z.array(parcelSchema).min(1).max(FORECAST_LIMITS.parcels),
  zones: z.array(zoneSchema).min(1).max(FORECAST_LIMITS.zones),
  services: z.array(serviceSchema).min(1).max(FORECAST_LIMITS.services),
  residentialPct: share,
  multiPackage: z.strictObject({
    pct: share,
    packagesPerOrder: z.number().int().min(FORECAST_LIMITS.packagesPerOrderMin).max(FORECAST_LIMITS.packagesPerOrderMax),
  }),
  content: contentSchema,
  fulfillment: fulfillmentSchema,
});

function sumShares(rows: { sharePct: string }[]): Xd {
  return rows.reduce((s, r) => s.plus(r.sharePct), new X(0));
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The grid dimensions of a (structurally valid) set of assumptions, before anything is priced. */
export function gridCounts(a: Pick<ForecastAssumptions, "parcels" | "zones" | "services" | "residentialPct" | "multiPackage">): ForecastGridCounts {
  const residential = new X(a.residentialPct);
  const multi = new X(a.multiPackage.pct);
  const residentialSplits = residential.isZero() || residential.eq(100) ? 1 : 2;
  const packageClasses = multi.isZero() || multi.eq(100) ? 1 : 2;
  const counts = { parcels: a.parcels.length, zones: a.zones.length, services: a.services.length, residentialSplits, packageClasses };
  return { ...counts, cells: counts.parcels * counts.zones * counts.services * residentialSplits * packageClasses };
}

/** "14 parcels × 6 zones × 10 services × 2 residential splits × 2 package classes = 3,360 cells". */
export function describeGridProduct(c: ForecastGridCounts): string {
  const n = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;
  return `${n(c.parcels, "parcel", "parcels")} × ${n(c.zones, "zone", "zones")} × ${n(c.services, "service", "services")} × ${n(c.residentialSplits, "residential split", "residential splits")} × ${n(c.packageClasses, "package class", "package classes")} = ${thousands(c.cells)} cells`;
}

/**
 * Every problem with a set of assumptions, in plain words (empty = valid). Shares are checked for an
 * exact sum of 100.00 and never rescaled. Keys and ids never appear in the messages.
 */
export function validateForecastAssumptions(input: unknown): string[] {
  const parsed = assumptionsSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.slice(0, 12).map((i) => `${i.path.map(String).join(".") || "assumptions"}: ${i.message}`);
  const a = parsed.data as ForecastAssumptions;
  const problems: string[] = [];
  const checkSum = (label: string, rows: { sharePct: string }[]) => {
    const sum = sumShares(rows);
    if (!sum.eq(100)) problems.push(`${label}: shares add up to ${sum.toFixed(2)}%, not 100.00%`);
  };
  checkSum("parcels", a.parcels);
  checkSum("zones", a.zones);
  checkSum("services", a.services);

  const zonesSeen = new Set<string>();
  a.zones.forEach((z, i) => {
    const zone = normalizeZone(z.zone);
    if (!zone) problems.push(`zones.${i}.zone: must not be blank`);
    else if (zonesSeen.has(zone)) problems.push(`zones.${i}.zone: zone ${zone} is listed twice`);
    zonesSeen.add(zone);
  });
  const servicesSeen = new Set<string>();
  a.services.forEach((s, i) => {
    if (servicesSeen.has(s.serviceId)) problems.push(`services.${i}: ${s.name} is listed twice`);
    servicesSeen.add(s.serviceId);
  });

  const content = contentShape(a.content);
  if ("rows" in content) checkSum("content.rows", content.rows);
  else if (new X(content.averageLines).gt(content.averageUnits)) problems.push("content: the average number of lines per order cannot exceed the average number of items");

  const counts = gridCounts(a);
  if (counts.cells > FORECAST_LIMITS.cells) {
    problems.push(`the mix has too many combinations to price: ${describeGridProduct(counts)}, more than the limit of ${thousands(FORECAST_LIMITS.cells)}; use fewer parcel, zone or service rows`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

function compareDecimal(a: string, b: string): number {
  return new X(a).cmp(b);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareOptionalDecimal(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return compareDecimal(a, b);
}

/** Zones sort numerically when both are numbers ("2" before "10"), otherwise by text. */
export function compareZones(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return compareText(a, b);
}

function compareParcels(a: ForecastParcel, b: ForecastParcel): number {
  return (
    compareDecimal(a.weightLb, b.weightLb) ||
    compareOptionalDecimal(a.lengthIn, b.lengthIn) ||
    compareOptionalDecimal(a.widthIn, b.widthIn) ||
    compareOptionalDecimal(a.heightIn, b.heightIn) ||
    compareText(a.packagingType ?? "", b.packagingType ?? "") ||
    Number(!!a.unknownSize) - Number(!!b.unknownSize) ||
    compareDecimal(a.sharePct, b.sharePct)
  );
}

function compareContentRows(a: ForecastContentRow, b: ForecastContentRow): number {
  return a.units - b.units || a.lines - b.lines || compareDecimal(a.sharePct, b.sharePct);
}

/** Which of the two content shapes was given (a parsed object may carry the other members as undefined). */
function contentShape(content: ForecastContent): ForecastContent {
  const c = content as { rows?: ForecastContentRow[]; averageUnits?: string; averageLines?: string };
  if (c.rows !== undefined) return { rows: c.rows };
  if (c.averageUnits !== undefined && c.averageLines !== undefined) return { averageUnits: c.averageUnits, averageLines: c.averageLines };
  throw new RangeError("order content needs rows or averages");
}

/**
 * The same assumptions in canonical form: rows sorted by content (so the order the brand typed them
 * in changes nothing), decimals in canonical text, blank optionals dropped, zones normalised. The
 * evaluator works on this form and echoes it as the profile. Input must be valid (see
 * `validateForecastAssumptions`).
 */
export function canonicalizeAssumptions(a: ForecastAssumptions): ForecastAssumptions {
  const d = canonicalDecimal;
  const parcels: ForecastParcel[] = a.parcels
    .map((p) => {
      const out: ForecastParcel = { weightLb: d(p.weightLb), packagingType: p.packagingType === null ? null : p.packagingType.trim(), sharePct: d(p.sharePct) };
      if (p.lengthIn !== undefined && p.widthIn !== undefined && p.heightIn !== undefined) {
        out.lengthIn = d(p.lengthIn);
        out.widthIn = d(p.widthIn);
        out.heightIn = d(p.heightIn);
      }
      if (p.unknownSize) out.unknownSize = true;
      return out;
    })
    .sort(compareParcels);
  const zones: ForecastZone[] = a.zones.map((z) => ({ zone: normalizeZone(z.zone), sharePct: d(z.sharePct) })).sort((x, y) => compareZones(x.zone, y.zone));
  const services: ForecastService[] = a.services
    .map((s) => ({ serviceId: s.serviceId, carrierCode: s.carrierCode, serviceCode: s.serviceCode, name: s.name.trim(), sharePct: d(s.sharePct) }))
    .sort((x, y) => compareText(x.serviceId, y.serviceId));
  const given = contentShape(a.content);
  const content: ForecastContent =
    "rows" in given
      ? { rows: given.rows.map((r) => ({ units: r.units, lines: r.lines, sharePct: d(r.sharePct) })).sort(compareContentRows) }
      : { averageUnits: d(given.averageUnits), averageLines: d(given.averageLines) };
  const drivers: ForecastFulfillment["drivers"] = {};
  for (const key of Object.keys(a.fulfillment.drivers).sort()) {
    const v = a.fulfillment.drivers[key];
    drivers[key] = v === null || v === undefined ? null : d(v);
  }
  const orderShares: ForecastFulfillment["orderShares"] = {};
  for (const key of Object.keys(a.fulfillment.orderShares).sort()) {
    const v = a.fulfillment.orderShares[key];
    orderShares[key] = v === null || v === undefined ? null : { sharePct: d(v.sharePct), countPerOrder: v.countPerOrder };
  }
  const fulfillment: ForecastFulfillment = { drivers, orderShares };
  if (a.fulfillment.skip) fulfillment.skip = true;
  const packagingDefault = a.fulfillment.packagingDefault?.trim();
  if (packagingDefault) fulfillment.packagingDefault = packagingDefault;
  return {
    version: 1,
    monthlyOrders: d(a.monthlyOrders),
    asOfDate: a.asOfDate,
    originZip: a.originZip,
    parcels,
    zones,
    services,
    residentialPct: d(a.residentialPct),
    multiPackage: { pct: d(a.multiPackage.pct), packagesPerOrder: a.multiPackage.packagesPerOrder },
    content,
    fulfillment,
  };
}

/** JSON with object keys sorted at every level and `undefined` members dropped; arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** The canonical JSON text of a set of assumptions (what `assumptionsHash` is the hash of). */
export function canonicalAssumptions(a: ForecastAssumptions): string {
  return stableStringify(canonicalizeAssumptions(a));
}

// ---------------------------------------------------------------------------
// Order content
// ---------------------------------------------------------------------------

/**
 * The content rows of a forecast. Averages are split two-point: an average of 1.4 items becomes 60%
 * of orders with 1 item and 40% with 2, which reproduces the average exactly. Lines are split the
 * same way and coupled comonotonically with items (the orders with more items are the ones with more
 * lines), so each row keeps lines ≤ items. Shares are exact percentages.
 */
export function contentRows(input: ForecastContent): ForecastContentRow[] {
  const content = contentShape(input);
  if ("rows" in content) return [...content.rows].sort(compareContentRows);
  const units = new X(content.averageUnits);
  const lines = new X(content.averageLines);
  if (lines.gt(units)) throw new RangeError("the average number of lines per order cannot exceed the average number of items");
  const floorU = units.floor();
  const floorL = lines.floor();
  const fu = units.minus(floorU);
  const fl = lines.minus(floorL);
  const one = new X(1);
  const candidates: { units: Xd; lines: Xd; share: Xd }[] =
    fu.gte(fl)
      ? [
          { units: floorU, lines: floorL, share: one.minus(fu) },
          { units: floorU.plus(1), lines: floorL, share: fu.minus(fl) },
          { units: floorU.plus(1), lines: floorL.plus(1), share: fl },
        ]
      : [
          { units: floorU, lines: floorL, share: one.minus(fl) },
          { units: floorU, lines: floorL.plus(1), share: fl.minus(fu) },
          { units: floorU.plus(1), lines: floorL.plus(1), share: fu },
        ];
  return candidates
    .filter((c) => c.share.gt(0))
    .map((c) => ({ units: c.units.toNumber(), lines: c.lines.toNumber(), sharePct: c.share.times(100).toFixed() }))
    .sort(compareContentRows);
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/**
 * The profile grid of canonical assumptions: parcel × zone × service × residential × package class,
 * each cell weighted by monthlyOrders × the product of its shares, exactly. Cells are enumerated in
 * canonical order, so two shuffles of the same rows produce the same cells in the same order.
 */
export function buildGrid(a: ForecastAssumptions): ForecastGrid {
  const counts = gridCounts(a);
  if (counts.cells > FORECAST_LIMITS.cells) throw new RangeError(`too many cells: ${describeGridProduct(counts)}`);
  const volume = new X(a.monthlyOrders);
  const residential = new X(a.residentialPct).div(100);
  const multi = new X(a.multiPackage.pct).div(100);
  const one = new X(1);
  const residentialClasses: { residential: boolean; share: Xd }[] =
    residential.eq(1) ? [{ residential: true, share: one }] : residential.isZero() ? [{ residential: false, share: one }] : [{ residential: false, share: one.minus(residential) }, { residential: true, share: residential }];
  const k = a.multiPackage.packagesPerOrder;
  const packageClasses: { packages: number; share: Xd }[] = multi.eq(1) ? [{ packages: k, share: one }] : multi.isZero() ? [{ packages: 1, share: one }] : [{ packages: 1, share: one.minus(multi) }, { packages: k, share: multi }];

  const cells: ForecastCell[] = [];
  let weightSum = new X(0);
  a.parcels.forEach((parcel, parcelIndex) => {
    const pShare = volume.times(parcel.sharePct).div(100);
    a.zones.forEach((zone, zoneIndex) => {
      const zShare = pShare.times(zone.sharePct).div(100);
      a.services.forEach((service, serviceIndex) => {
        const sShare = zShare.times(service.sharePct).div(100);
        for (const r of residentialClasses) {
          for (const g of packageClasses) {
            const weight = sShare.times(r.share).times(g.share);
            weightSum = weightSum.plus(weight);
            cells.push({
              key: `${service.serviceId}|${zone.zone}|p${parcelIndex}|${r.residential ? "res" : "com"}|k${g.packages}`,
              parcelIndex,
              zoneIndex,
              serviceIndex,
              zone: zone.zone,
              serviceId: service.serviceId,
              residential: r.residential,
              packages: g.packages,
              weight: weight.toFixed(),
            });
          }
        }
      });
    });
  });
  if (!weightSum.eq(volume)) throw new RangeError(`cell weights add up to ${weightSum.toFixed()}, not ${volume.toFixed()}`);
  return { cells, weightSum: weightSum.toFixed(), counts };
}
