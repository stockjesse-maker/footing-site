import { z } from "zod";
import { describeFeeRule, normalisePackaging } from "@/engine/fees";
import type { FeeCategory, FeeScheduleSnapshot, OrderFeeContext, OrderFeeInput, OrderShippingInput } from "@/engine/fees/types";
import { moneyToCents } from "@/engine/modeling/encode";
import type { ShipmentCalculation } from "@/engine/types";
import { uuidSchema } from "@/lib/auth/validation";

/**
 * The calculator's request shapes, kept outside the "use server" module, and the pure parts of its
 * "What's in the box" block (Milestone 4, design section 8): the box fields, their validation, what
 * the form offers for a fee schedule version, and the mapping of the box into the fee engine's
 * `OrderFeeInput`. Pure (no I/O, no framework imports): the form, the server actions and the tests
 * share one implementation.
 *
 * Nothing here touches carrier buy rates or invents a quantity: a count the customer did not enter is
 * unknown (`null`), and the engine then reports the fees that need it as not computed, never as $0.
 */

/** Request shape accepted by the priceShipment server action (kept outside the "use server" module). */
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/);
const optionalDecimal = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), decimal.optional());

// ---------------------------------------------------------------------------
// What's in the box
// ---------------------------------------------------------------------------
export const BOX_COUNT_MAX = 1_000_000;
/** Order-share driver keys are slugs (`SLUG_RE` of the fee editor). */
const COUNT_KEY = /^[a-z][a-z0-9_]{0,60}$/;
const MAX_COUNT_FIELDS = 10;

/**
 * The packaging value of "Another type (not listed)": a package whose type the schedule does not list,
 * priced by the schedule's catch-all packaging rule. It is a normalised type no schedule spells out, so
 * the engine reads it as an unlisted type.
 */
export const PACKAGING_OTHER = "other (not listed)";

const wholeNumber = (min: number, tooSmall: string) =>
  z
    .number({ error: "Enter a whole number." })
    .int("Enter a whole number.")
    .min(min, tooSmall)
    .max(BOX_COUNT_MAX, `Enter ${BOX_COUNT_MAX.toLocaleString("en-US")} or fewer.`);

type Num = number | null | undefined;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Cross-field problems of the counts in the box, by field: more different products than items (every
 * product is at least one item), more order lines than items (every line has at least one unit), more
 * different products than order lines (a line holds one product). Takes whatever the form has parsed so
 * far; a count that is missing or not a number is not a problem here.
 */
export function boxProblems(box: { units?: Num; products?: Num; lines?: Num }): Partial<Record<"products" | "lines", string>> {
  const out: Partial<Record<"products" | "lines", string>> = {};
  const { units, products, lines } = box;
  if (isNum(products) && isNum(units) && products > units) out.products = "Different products can't be more than the items in the box.";
  if (isNum(lines) && isNum(units) && lines > units) out.lines = "Order lines can't be more than the items in the box.";
  if (isNum(products) && isNum(lines) && products > lines && !out.products) out.products = "Different products can't be more than the order lines.";
  return out;
}

export const boxSchema = z
  .strictObject({
    /** Items (units) in the box. Required: fees are shown only once this is entered. */
    units: wholeNumber(1, "Enter at least 1 item."),
    /** Different products (distinct SKUs). Also the number of order lines unless the schedule has a per-line rule. */
    products: wholeNumber(1, "Enter at least 1 product.").optional(),
    /** Order lines; asked only when the schedule has a per-line rule. */
    lines: wholeNumber(1, "Enter at least 1 order line.").optional(),
    /** A normalised packaging type of the schedule, `PACKAGING_OTHER`, or null for "Not sure". */
    packaging: z.string().trim().min(1).max(80).transform(normalisePackaging).nullable().optional(),
    /** Per-order counts the schedule asks for (inserts, kits, labels), by driver key. */
    counts: z.record(z.string().regex(COUNT_KEY, "Unknown option."), wholeNumber(0, "Enter 0 or more.")).optional(),
  })
  .superRefine((box, ctx) => {
    for (const [field, message] of Object.entries(boxProblems(box))) ctx.addIssue({ code: "custom", path: [field], message });
    if (box.counts && Object.keys(box.counts).length > MAX_COUNT_FIELDS) ctx.addIssue({ code: "custom", path: ["counts"], message: "Too many counts." });
  });

export type CalculatorBox = z.infer<typeof boxSchema>;

export const calculatorRequestSchema = z.object({
  rateCardId: uuidSchema,
    /** 3PL staff pricing on behalf of a customer: that customer's exceptions and brand-scoped rules apply. */
    brandId: uuidSchema.optional(),
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
  /** What's in the box: present only once the customer entered the items; order fees are computed from it. */
  box: boxSchema.optional(),
});

export type CalculatorRequest = z.infer<typeof calculatorRequestSchema>;

/** What the form asks the server for when the ship date or customer changes: the schedule's box options. */
export const calculatorBoxRequestSchema = z.object({
  brandId: uuidSchema.optional(),
  shipDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    // Zod 4 runs refinements even after the pattern failed, so this must not throw on a string that is not a date.
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }, "Enter a real date."),
});

// ---------------------------------------------------------------------------
// What the form offers for a fee schedule version
// ---------------------------------------------------------------------------
export interface CalculatorBoxCount {
  /** The answer's key (an order-share driver of the schedule). Identifies the field; never shown. */
  key: string;
  /** "Inserts in this order". */
  label: string;
  unit: string;
  /** The rate in the customer's words, for the field's hint. */
  rate: string;
  helpText: string | null;
}

export interface CalculatorBoxOptionsOk {
  status: "ok";
  scheduleName: string;
  effectiveDate: string;
  /** The packaging types the schedule prices, normalised, with a display label. */
  packaging: { value: string; label: string }[];
  /** A catch-all packaging rule prices any other type, so "Another type" is offered. */
  allowOtherPackaging: boolean;
  /** A per-line rule needs its own order-lines count; otherwise every product is one line. */
  showLines: boolean;
  counts: CalculatorBoxCount[];
  /** False when every charge of the schedule is monthly: there are no per-order fees to show. */
  hasOrderFees: boolean;
}

/**
 * `no_schedule` / `not_effective`: no fee schedule version in effect on the date; `load_failed`: the
 * schedule could not be read (retryable, never "no fees"); `unavailable`: there is no customer to read a
 * schedule for (general staff calculator) or the caller may not.
 */
export type CalculatorBoxOptions = CalculatorBoxOptionsOk | { status: "no_schedule" | "not_effective" | "load_failed" | "unavailable" };

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const singular = (unit: string) => (unit.endsWith("s") && unit.length > 3 ? unit.slice(0, -1) : unit);

/** The order-share clause of `describeFeeRule`: the calculator asks for the count on this order, not a share of orders. */
const SHARE_CLAUSE = ", on the share of orders you say get them";

/**
 * The box fields a fee schedule version needs, from its order-scope rules: the packaging types it
 * prices (and whether a catch-all prices the rest), whether a rule reads order lines, and one count per
 * order-share driver (inserts, kits, labels). Carries no rule keys or ids.
 */
export function boxOptionsFromSnapshot(snapshot: Pick<FeeScheduleSnapshot, "name" | "effectiveDate" | "rules">): CalculatorBoxOptionsOk {
  const rules = snapshot.rules.filter((r) => r.scope === "order").sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
  const types: string[] = [];
  let catchAll = false;
  let showLines = false;
  const counts: CalculatorBoxCount[] = [];
  for (const rule of rules) {
    if (rule.basis === "package") {
      for (const t of rule.conditions?.packagingTypes ?? []) {
        if (t === "*") catchAll = true;
        else if (!types.includes(t)) types.push(t);
      }
    }
    const c = rule.conditions;
    if (rule.basis === "line" || rule.includedPer === "line" || c?.minLines !== undefined || c?.maxLines !== undefined) showLines = true;
    if (rule.basis === "order_driver" && rule.driver && rule.driver.kind === "order_share" && !counts.some((x) => x.key === rule.driver!.key)) {
      counts.push({
        key: rule.driver.key,
        label: `${capitalise(rule.driver.unit)} in this order`,
        unit: rule.driver.unit,
        rate: describeFeeRule(rule).replace(SHARE_CLAUSE, ""),
        helpText: rule.helpText ?? null,
      });
    }
  }
  return {
    status: "ok",
    scheduleName: snapshot.name,
    effectiveDate: snapshot.effectiveDate,
    packaging: types.map((value) => ({ value, label: capitalise(value) })),
    allowOtherPackaging: catchAll,
    showLines,
    counts,
    hasOrderFees: rules.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Form drafts -> box
// ---------------------------------------------------------------------------
export interface BoxDrafts {
  units: string;
  products: string;
  lines: string;
  /** "" = "Not sure". */
  packaging: string;
  counts: Record<string, string>;
}

export const emptyBoxDrafts = (): BoxDrafts => ({ units: "", products: "", lines: "", packaging: "", counts: {} });

export type ParsedCount = { kind: "empty" } | { kind: "ok"; value: number } | { kind: "invalid" };

/** "1,200" -> 1200; "" -> empty; "2.5", "abc", "-1" -> invalid. */
export function parseCount(raw: string): ParsedCount {
  const v = raw.trim().replace(/[,\s]/g, "");
  if (v === "") return { kind: "empty" };
  if (!/^\d{1,8}$/.test(v)) return { kind: "invalid" };
  return { kind: "ok", value: Number(v) };
}

export interface BoxFromDrafts {
  /** The box to send; null when the items are not entered (no order fees) or something is invalid. */
  box: CalculatorBox | null;
  /** Inline errors by field: `box.units`, `box.products`, `box.lines`, `box.counts.<key>`. */
  errors: Record<string, string>;
  /** True when the customer typed anything in the block. */
  started: boolean;
}

const UNITS_REQUIRED = "Enter the number of items to see order fees.";

/**
 * Turns the block's text fields into the box the server takes, with inline validation. Only the fields
 * the schedule asks for count (a stale answer to a field the new ship date's schedule does not have is
 * ignored). Items blank with nothing else entered is fine: no box, no error, no order fees. Items blank
 * with anything else entered is an error on the items. A blank count is unknown, not zero.
 */
export function boxFromDrafts(drafts: BoxDrafts, options: Pick<CalculatorBoxOptionsOk, "showLines" | "counts"> | null): BoxFromDrafts {
  const errors: Record<string, string> = {};
  if (!options) return { box: null, errors, started: false };
  const empty: ParsedCount = { kind: "empty" };
  const units = parseCount(drafts.units);
  const products = parseCount(drafts.products);
  const lines = options.showLines ? parseCount(drafts.lines) : empty;
  const counts = options.counts.map((c) => ({ key: c.key, parsed: parseCount(drafts.counts[c.key] ?? "") }));
  const packagingChosen = drafts.packaging !== "";
  const others = products.kind !== "empty" || lines.kind !== "empty" || packagingChosen || counts.some((c) => c.parsed.kind !== "empty");
  const started = units.kind !== "empty" || others;

  const check = (field: string, parsed: ParsedCount, min: number, tooSmall: string) => {
    if (parsed.kind === "invalid") errors[field] = "Enter a whole number, for example 3.";
    else if (parsed.kind === "ok" && parsed.value < min) errors[field] = tooSmall;
    else if (parsed.kind === "ok" && parsed.value > BOX_COUNT_MAX) errors[field] = `Enter ${BOX_COUNT_MAX.toLocaleString("en-US")} or fewer.`;
  };
  if (units.kind === "empty") {
    if (others) errors["box.units"] = UNITS_REQUIRED;
  } else check("box.units", units, 1, "Enter at least 1 item.");
  check("box.products", products, 1, "Enter at least 1 product.");
  check("box.lines", lines, 1, "Enter at least 1 order line.");
  for (const c of counts) check(`box.counts.${c.key}`, c.parsed, 0, "Enter 0 or more.");

  const value = (p: ParsedCount): number | undefined => (p.kind === "ok" ? p.value : undefined);
  for (const [field, message] of Object.entries(boxProblems({ units: value(units), products: value(products), lines: value(lines) }))) {
    if (!errors[`box.${field}`]) errors[`box.${field}`] = message;
  }
  if (Object.keys(errors).length > 0 || units.kind !== "ok") return { box: null, errors, started };

  const givenCounts: Record<string, number> = {};
  for (const c of counts) if (c.parsed.kind === "ok") givenCounts[c.key] = c.parsed.value;
  const box: CalculatorBox = {
    units: units.value,
    ...(products.kind === "ok" ? { products: products.value } : {}),
    ...(lines.kind === "ok" ? { lines: lines.value } : {}),
    packaging: packagingChosen ? drafts.packaging : null,
    ...(Object.keys(givenCounts).length ? { counts: givenCounts } : {}),
  };
  return { box, errors, started };
}

/** The box in plain words ("3 items, 2 different products, packaging: Poly mailer"): the echo under the result and in saved scenarios. */
export function describeBox(box: CalculatorBox, options?: Pick<CalculatorBoxOptionsOk, "counts" | "packaging"> | null): string {
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const parts = [plural(box.units, "item", "items")];
  if (box.products !== undefined) parts.push(`${plural(box.products, "different product", "different products")}`);
  if (box.lines !== undefined) parts.push(plural(box.lines, "order line", "order lines"));
  if (box.packaging === PACKAGING_OTHER) parts.push("packaging: another type");
  else if (box.packaging) parts.push(`packaging: ${options?.packaging.find((p) => p.value === box.packaging)?.label ?? capitalise(box.packaging)}`);
  else parts.push("packaging not specified");
  for (const [key, n] of Object.entries(box.counts ?? {})) {
    const unit = options?.counts.find((c) => c.key === key)?.unit ?? "extras";
    parts.push(plural(n, singular(unit), unit));
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Box -> fee engine input
// ---------------------------------------------------------------------------
/**
 * The shipping figures the percent-of-shipping fees read, from the shipping calculation of this order's
 * one shipment: `totalE4` = counted definite + estimated lines (the expected cost), `baseFreightE4` =
 * the base-rate and minimum-charge lines, `estimated` when any counted line rests on an assumption,
 * `hasExposure` when conditional or undecided charges exist that the base leaves out. null when the
 * shipment could not be priced (the fees that read shipping are then not computed).
 */
export function shippingInputFromCalculation(calc: ShipmentCalculation): OrderShippingInput | null {
  if (calc.status !== "ok") return null;
  const cents = (m: { amount: string }) => moneyToCents(m.amount);
  let baseFreightE4 = 0;
  for (const line of calc.lines) {
    if (line.counted && line.status === "charged" && (line.kind === "base" || line.kind === "minimum_charge")) baseFreightE4 += cents(line.amount) * 100;
  }
  return {
    totalE4: cents(calc.totals.expected) * 100,
    baseFreightE4,
    estimated: cents(calc.totals.estimated) > 0,
    hasExposure: cents(calc.totals.conditionalExposure) > 0 || cents(calc.totals.unresolved) > 0,
  };
}

/**
 * The fee engine's input and context for one order described by the box (ordinal 1, one shipment of
 * `packageCount` packages that all carry the chosen packaging). Products are the distinct SKUs; lines
 * are the order-lines count when the schedule asks for it, else one per product (flagged assumed, the
 * only quantity inferred here). Packaging "Not sure" is `null`: packaging-priced fees are then not
 * computed. Each count the schedule asks for becomes an order-share answer of 100% with that count per
 * order; one left blank stays unanswered (not computed, never $0). No monthly-volume rate is pinned, so
 * monthly-volume tiers are not computed.
 */
export function boxToOrderFeeInput(
  box: CalculatorBox,
  opts: { packageCount: number; shipping: OrderShippingInput | null; showLines: boolean; countKeys: readonly string[] },
): { input: OrderFeeInput; context: OrderFeeContext } {
  const packagingType = box.packaging ?? null;
  const derivedLines = !opts.showLines;
  const lines = derivedLines ? (box.products ?? null) : (box.lines ?? null);
  const input: OrderFeeInput = {
    units: box.units,
    lines,
    distinctSkus: box.products ?? null,
    packages: Array.from({ length: Math.max(1, opts.packageCount) }, () => ({ packagingType })),
    shipments: 1,
    shipping: opts.shipping,
    assumed: derivedLines && lines !== null ? { lines: true } : {},
    ordinal: 1,
  };
  const orderShares: OrderFeeContext["orderShares"] = {};
  for (const key of opts.countKeys) {
    const n = box.counts?.[key];
    orderShares[key] = n === undefined ? null : { sharePct: "100", countPerOrder: n };
  }
  return { input, context: { orderShares, pinnedRates: {}, packagingDefault: null } };
}

// ---------------------------------------------------------------------------
// What the server returns: the customer-safe fee block
// ---------------------------------------------------------------------------
export interface OrderFeeLineView {
  name: string;
  category: FeeCategory;
  chargeClass: "definite" | "estimated";
  /** Dollars, cents. */
  amount: string;
  explanation: string;
  /** Staff only. */
  ruleKey?: string;
}

/** The field of the box a not-computed fee needs: the form focuses it. */
export type BoxFieldRef = "products" | "lines" | "packaging" | `count:${string}`;

export interface OrderFeeNotComputedView {
  name: string;
  /** Why it was left out, in plain words. */
  reason: string;
  /** The rate in the customer's words, when the rule is known. */
  rate: string | null;
  /** What to add to include it. */
  add: { field: BoxFieldRef; label: string } | null;
  /** Staff only. */
  ruleKey?: string;
}

export interface OrderFeesView {
  /** ok: every applicable fee computed; partial: some left out; no_content: nothing could be computed. */
  status: "ok" | "partial" | "no_content";
  schedule: { name: string; effectiveDate: string; /** Staff only. */ versionNumber?: number };
  /** The box in plain words. */
  box: string;
  lines: OrderFeeLineView[];
  notComputed: OrderFeeNotComputedView[];
  /** Expected shipping cost of the shipment, dollars. */
  shipping: string;
  /** Order fees counted, dollars; null when none could be computed. "At least" when status is partial. */
  orderFees: string | null;
  /** Shipping + order fees, dollars, rounded once; null when no fee could be computed. "At least" when status is partial. */
  combined: string | null;
  notes: string[];
}

export type CalculatorFeesResponse = { status: "computed"; byService: (OrderFeesView | null)[] } | { status: "no_schedule" | "not_effective" | "load_failed" };
