import { z } from "zod";
import { normalisePackaging, resolveMonthlyRate, toE4 } from "@/engine/fees";
import { FEE_CATEGORIES, MONTHLY_BASES, ORDER_BASES } from "@/engine/fees/types";
import type { FeeBasis, FeeCategory, FeeMethod, FeeRule, FeeScheduleSnapshot, FeeScope, IncludedPer, OrderFeeContext, OrderFeeInput } from "@/engine/fees/types";
import { D } from "@/engine/money";
import type { FieldErrors } from "@/lib/auth/validation";

/**
 * Fee-schedule editor schemas (Milestone 4). Pure: no I/O, importable from client components,
 * server actions and tests alike.
 *
 * `feeRuleInputSchema` mirrors `app.fee_rule_problem` in 20261015000006_fees.sql field by field, with
 * the same closed sets and (where the check is per field) the same wording, so the editor shows the
 * problem inline before the database refuses the row. The database remains the authority: the row
 * trigger runs the same checks again, and the cross-rule checks (`app.fee_version_problem`: minimum
 * sets disjoint, long-term references, packaging collisions) only run there, at activation.
 *
 * `fulfillmentAnswersSchema` mirrors `app.validate_fulfillment` for the run-setup step; the checks that
 * need the schedule (answered keys are questions of the pinned version, returns rates ≤ 100, long-term
 * ≤ stored) are in `fulfillmentAnswerProblems`.
 *
 * Nothing here touches carrier buy rates: every amount is one the 3PL typed into its own fee schedule.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
const SLUG_RE = /^[a-z][a-z0-9_]{0,60}$/;
const GROUP_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** `app.fee_decimal_ok(p, scale)`: digits, optional fraction of up to `scale` places; no sign, no commas. */
const decimalString = (intDigits: number, scale: number, message: string) => z.string({ error: message }).trim().regex(new RegExp(`^[0-9]{1,${intDigits}}(\\.[0-9]{1,${scale}})?$`), message);

/**
 * A range check on a decimal string. Zod 4 runs refinements even after the shape check failed, so a
 * string that is not a decimal passes here (the shape error already stands) instead of throwing.
 */
const withinRange = (check: (value: InstanceType<typeof D>) => boolean) => (v: string) => !/^[0-9]+(\.[0-9]+)?$/.test(v) || check(new D(v));

/** numeric(12,4) columns: 8 integer digits, 4 decimals. */
const columnMoney = (message = "Enter an amount with up to 4 decimals (digits only; no sign or commas).") => decimalString(8, 4, message);
/** Amounts inside jsonb (tiers, minimum): `app.fee_decimal_ok(p, 4)`. */
const jsonMoney = (message: string) => decimalString(12, 4, message);

/** "" and undefined become null (an empty form field is "not set"). */
const emptyToNull = (v: unknown): unknown => (v === undefined || v === "" || (typeof v === "string" && v.trim() === "") ? null : v);
const nullable = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToNull, schema.nullable());

/** Whole numbers typed into a form arrive as strings; the database stores integers. */
const toInt = (v: unknown): unknown => (typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v);
const wholeNumber = (min: number, max: number, message: string) => z.preprocess(toInt, z.number({ error: message }).int(message).min(min, message).max(max, message));
/** `^[0-9]{1,9}$` on a jsonb number: a non-negative integer with up to nine digits. */
const count = wholeNumber(0, 999_999_999, "Enter a whole number.");

/** Drops keys an editor leaves empty (null, undefined, "", []) so a strict object sees only what was set. */
function dropEmpty(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined || val === "") continue;
    if (Array.isArray(val) && val.length === 0) continue;
    out[k] = val;
  }
  return out;
}

/** Like `dropEmpty`, and an object with nothing left in it becomes null ("no conditions"). */
function objectOrNull(v: unknown): unknown {
  const cleaned = dropEmpty(emptyToNull(v));
  return cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0 ? null : cleaned;
}

const slug = (message: string) => z.string({ error: message }).trim().regex(SLUG_RE, message);

// ---------------------------------------------------------------------------
// Sub-objects stored as jsonb
// ---------------------------------------------------------------------------
export const feeTiersSchema = z
  .strictObject(
    {
      on: z.enum(["order_quantity", "monthly_quantity"], { error: "tiers.on must be order_quantity or monthly_quantity" }),
      mode: z.enum(["graduated", "volume"], { error: "tiers.mode must be graduated or volume" }),
      pricing: z.enum(["rate", "flat"], { error: "tiers.pricing must be rate or flat" }),
      brackets: z
        .array(
          z.strictObject(
            {
              upTo: nullable(jsonMoney("bracket edges must be numbers")),
              amount: jsonMoney("bracket amounts must be numbers with up to 4 decimals"),
            },
            { error: "a bracket has an unknown field" },
          ),
        )
        .min(1, "tiers need 1–50 brackets")
        .max(50, "tiers need 1–50 brackets"),
    },
    { error: "tiers has an unknown field" },
  )
  .superRefine((t, ctx) => {
    if (t.mode === "graduated" && t.pricing === "flat") ctx.addIssue({ code: "custom", path: ["pricing"], message: "graduated tiers are priced per unit" });
    let prev = new D(0);
    t.brackets.forEach((b, i) => {
      if (i === t.brackets.length - 1) {
        if (b.upTo !== null) ctx.addIssue({ code: "custom", path: ["brackets", i, "upTo"], message: "the last bracket must be open-ended (upTo null)" });
        return;
      }
      if (b.upTo === null) {
        ctx.addIssue({ code: "custom", path: ["brackets", i, "upTo"], message: "bracket edges must be numbers" });
        return;
      }
      if (!/^[0-9]+(\.[0-9]+)?$/.test(b.upTo)) return; // its own shape error already stands
      const up = new D(b.upTo);
      if (up.lte(prev)) ctx.addIssue({ code: "custom", path: ["brackets", i, "upTo"], message: "bracket edges must ascend" });
      prev = up;
    });
  });

const conditionsObject = z
  .strictObject(
    {
      minUnits: count.optional(),
      maxUnits: count.optional(),
      minLines: count.optional(),
      maxLines: count.optional(),
      minPackages: count.optional(),
      maxPackages: count.optional(),
      packagingTypes: z.array(z.string().min(1, "packaging types must be 1–60 characters").max(60, "packaging types must be 1–60 characters")).min(1, "packagingTypes must list 1–50 types").max(50, "packagingTypes must list 1–50 types").optional(),
    },
    { error: "conditions has an unknown field" },
  )
  .superRefine((c, ctx) => {
    const pairs = [
      ["minUnits", "maxUnits"],
      ["minLines", "maxLines"],
      ["minPackages", "maxPackages"],
    ] as const;
    for (const [lo, hi] of pairs) {
      const min = c[lo];
      const max = c[hi];
      if (min !== undefined && max !== undefined && min > max) ctx.addIssue({ code: "custom", path: [lo], message: `${lo} exceeds ${hi}` });
    }
    if (c.packagingTypes) {
      c.packagingTypes.forEach((p, i) => {
        if (p !== "*" && normalisePackaging(p) !== p) ctx.addIssue({ code: "custom", path: ["packagingTypes", i], message: 'packaging types must be normalised (lower case, trimmed, single spaces) or "*"' });
      });
      if (new Set(c.packagingTypes).size !== c.packagingTypes.length) ctx.addIssue({ code: "custom", path: ["packagingTypes"], message: "packaging types repeat" });
    }
  });
/** Conditions of an order rule; an object with nothing set is null (no conditions). */
export const feeConditionsSchema = z.preprocess(objectOrNull, conditionsObject.nullable());

const driverObject = z
  .strictObject(
    {
      key: slug("driver.key must be a short slug"),
      label: z.string({ error: "driver.label must be 1–200 characters" }).trim().min(1, "driver.label must be 1–200 characters").max(200, "driver.label must be 1–200 characters"),
      unit: z.string({ error: "driver.unit must be 1–40 characters" }).trim().min(1, "driver.unit must be 1–40 characters").max(40, "driver.unit must be 1–40 characters"),
      kind: z.enum(["monthly_quantity", "order_share", "returns_rate"], { error: "driver.kind must be monthly_quantity, order_share or returns_rate" }),
      billingPeriod: z.enum(["month", "week", "day"], { error: "billingPeriod must be month, week or day on a monthly quantity" }).optional(),
      longTerm: z
        .strictObject(
          {
            mode: z.enum(["replace", "surcharge"], { error: "longTerm.mode must be replace or surcharge" }),
            replacesRuleKey: slug("longTerm.replacesRuleKey must name another rule"),
            thresholdDays: wholeNumber(1, 3650, "longTerm.thresholdDays must be 1–3650"),
          },
          { error: "longTerm has an unknown field" },
        )
        .optional(),
    },
    { error: "driver has an unknown field" },
  )
  .superRefine((d, ctx) => {
    if (d.billingPeriod !== undefined && d.kind !== "monthly_quantity") ctx.addIssue({ code: "custom", path: ["billingPeriod"], message: "billingPeriod must be month, week or day on a monthly quantity" });
    if (d.longTerm !== undefined && d.kind !== "monthly_quantity") ctx.addIssue({ code: "custom", path: ["longTerm"], message: "longTerm applies to monthly quantities" });
  });
export const feeDriverSchema = z.preprocess(dropEmpty, driverObject);

export const feeMinimumSchema = z.strictObject(
  {
    amount: jsonMoney("minimum.amount must be a number with up to 4 decimals"),
    appliesTo: z.strictObject(
      {
        categories: z.array(z.enum(FEE_CATEGORIES, { error: "minimum.appliesTo.categories has an unknown category" }), { error: "minimum.appliesTo.categories must be a list" }).max(FEE_CATEGORIES.length),
        includeRuleKeys: z.array(slug("minimum rule keys must be slugs"), { error: "minimum.appliesTo.includeRuleKeys must be a list" }).max(200),
        excludeRuleKeys: z.array(slug("minimum rule keys must be slugs"), { error: "minimum.appliesTo.excludeRuleKeys must be a list" }).max(200),
      },
      { error: "minimum.appliesTo must list categories, includeRuleKeys and excludeRuleKeys" },
    ),
    includesShipping: z.boolean({ error: "minimum.includesShipping must be true or false" }),
  },
  { error: "minimum has an unknown field" },
);

// ---------------------------------------------------------------------------
// One rule, as the editor submits it
// ---------------------------------------------------------------------------
const FEE_BASES: readonly FeeBasis[] = [...ORDER_BASES, ...MONTHLY_BASES];
const FEE_METHODS: readonly FeeMethod[] = ["flat", "tiered", "percent", "minimum"];
const ALLOWANCE_BASES: readonly FeeBasis[] = ["unit", "line", "sku", "package", "shipment", "order_driver"];
const NO_MINIMUM_CHARGE_BASES: readonly FeeBasis[] = ["month", "minimum", "shipping_percent"];
const MONTHLY_TIER_BASES: readonly FeeBasis[] = ["order", "unit", "package", "shipment"];

export const feeRuleInputSchema = z
  .object({
    key: slug("key must be a short slug (letters, digits, underscores)"),
    name: z.string({ error: "name must be 1–120 characters" }).trim().min(1, "name must be 1–120 characters").max(120, "name must be 1–120 characters"),
    category: z.enum(FEE_CATEGORIES, { error: "unknown category" }),
    scope: z.enum(["order", "monthly"], { error: "unknown scope" }),
    basis: z.enum(FEE_BASES, { error: "unknown basis" }),
    method: z.enum(FEE_METHODS, { error: "unknown method" }),
    amount: nullable(columnMoney()),
    percent: nullable(decimalString(4, 4, "Enter a percentage with up to 4 decimals.").refine(withinRange((d) => d.lte(1000)), "percent must be between 0 and 1000")),
    percentBase: nullable(z.enum(["shipping_total", "base_freight"], { error: "choose what the percent is taken of" })),
    tiers: nullable(feeTiersSchema),
    includedQuantity: nullable(columnMoney("Enter a quantity with up to 4 decimals.")),
    includedPer: nullable(z.enum(["order", "line", "sku", "shipment"], { error: "includedPer must be order, line, sku or shipment" })),
    minimumCharge: nullable(columnMoney()),
    conditions: feeConditionsSchema,
    exclusiveGroup: nullable(z.string().trim().regex(GROUP_RE, "exclusive group must be a short slug")),
    priority: nullable(wholeNumber(-2_147_483_648, 2_147_483_647, "Enter a whole number.")),
    driver: nullable(feeDriverSchema),
    minimum: nullable(feeMinimumSchema),
    description: nullable(z.string().trim().max(2000, "Use at most 2,000 characters.")),
    helpText: nullable(z.string().trim().max(1000, "Use at most 1,000 characters.")),
  })
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

    // Scope, basis and method agree (same order as app.fee_rule_problem).
    if (r.scope === "order" && !ORDER_BASES.includes(r.basis)) issue(["basis"], "basis does not match an order-scope rule");
    if (r.scope === "monthly" && !MONTHLY_BASES.includes(r.basis)) issue(["basis"], "basis does not match a monthly rule");
    if ((r.basis === "shipping_percent") !== (r.method === "percent")) issue(["method"], "the percent method is for percent-of-shipping rules only, and they always use it");
    if ((r.basis === "minimum") !== (r.method === "minimum")) issue(["method"], "the minimum method is for account minimums only, and they always use it");
    if (r.method === "tiered" && (r.basis === "month" || r.basis === "shipping_percent" || r.basis === "minimum")) issue(["method"], "this basis cannot be tiered");

    // Amount, percent and its base.
    if (r.method === "flat" && r.amount === null) issue(["amount"], "amount is required");
    if (r.method !== "flat" && r.amount !== null) issue(["amount"], "amount applies to flat rules only");
    if (r.method === "percent" && r.percent === null) issue(["percent"], "percent is required");
    if (r.method !== "percent" && r.percent !== null) issue(["percent"], "percent applies to percent-of-shipping rules only");
    if (r.method === "percent" && r.percentBase === null) issue(["percentBase"], "choose what the percent is taken of");
    if (r.method !== "percent" && r.percentBase !== null) issue(["percentBase"], "percent base applies to percent-of-shipping rules only");

    // Tiers.
    if ((r.method === "tiered") !== (r.tiers !== null)) issue(["tiers"], "tiers are required for tiered rules and not allowed otherwise");
    if (r.tiers) {
      if (r.scope === "monthly" && r.tiers.on !== "monthly_quantity") issue(["tiers", "on"], "monthly rules tier on the monthly quantity");
      if (r.scope === "order" && r.tiers.on === "monthly_quantity" && (!MONTHLY_TIER_BASES.includes(r.basis) || r.tiers.pricing !== "rate")) {
        issue(["tiers", "on"], "monthly-volume tiers apply to per-order, per-item, per-package or per-shipment rules priced per unit");
      }
      if (r.includedQuantity !== null) issue(["includedQuantity"], "a tiered rule has no free allowance (use a first bracket at 0 instead)");
    }

    // Free allowance and per-occurrence minimum.
    if (r.includedQuantity !== null && !r.tiers && (r.scope !== "order" || !ALLOWANCE_BASES.includes(r.basis))) {
      issue(["includedQuantity"], "a free allowance applies to per-item, per-line, per-product, per-package, per-shipment and per-insert rules");
    }
    if (r.includedPer !== null && r.includedQuantity === null) issue(["includedPer"], "includedPer needs an included quantity");
    if (r.minimumCharge !== null && NO_MINIMUM_CHARGE_BASES.includes(r.basis)) issue(["minimumCharge"], "a minimum charge applies to per-quantity rules only");

    // Conditions.
    if (r.conditions) {
      if (r.scope !== "order") issue(["conditions"], "conditions apply to order rules only");
      if (r.conditions.packagingTypes && r.basis !== "package") issue(["conditions", "packagingTypes"], "packaging types condition applies to per-package rules only");
    }

    // Exclusive groups.
    if (r.exclusiveGroup !== null) {
      if (r.scope !== "order") issue(["exclusiveGroup"], "exclusive groups apply to order rules only");
      if (r.priority === null) issue(["priority"], "a rule in an exclusive group needs a priority");
    } else if (r.priority !== null) {
      issue(["priority"], "priority applies to rules in an exclusive group only");
    }

    // Drivers.
    const driverBasis = r.basis === "driver" || r.basis === "order_driver";
    if (driverBasis !== (r.driver !== null)) issue(["driver"], "driver is required for driver rules and not allowed otherwise");
    if (r.driver) {
      if (r.basis === "order_driver" && r.driver.kind !== "order_share") issue(["driver", "kind"], "a per-order driver is answered as a share of orders");
      if (r.basis === "driver" && r.driver.kind === "order_share") issue(["driver", "kind"], "a monthly driver is a monthly quantity or a returns rate");
      if (r.driver.longTerm && r.driver.longTerm.replacesRuleKey === r.key) issue(["driver", "longTerm", "replacesRuleKey"], "longTerm.replacesRuleKey must name another rule");
    }

    // Account minimums.
    if ((r.basis === "minimum") !== (r.minimum !== null)) issue(["minimum"], "minimum is required for account minimums and not allowed otherwise");
  });

export type FeeRuleInput = z.output<typeof feeRuleInputSchema>;

/** Field errors keyed by the full path ("tiers.brackets.1.upTo"), first message per path. */
export function ruleFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Converters: form input ⇄ fee_rules rows ⇄ FeeRule (engine snapshot shape)
// ---------------------------------------------------------------------------
/** A `public.fee_rules` row as PostgREST returns it (numerics may arrive as strings or numbers). */
export interface FeeRuleRow {
  id?: string;
  version_id: string;
  tenant_id: string;
  position: number;
  key: string;
  name: string;
  category: string;
  scope: string;
  basis: string;
  method: string;
  amount: string | number | null;
  percent: string | number | null;
  percent_base: string | null;
  tiers: unknown;
  included_quantity: string | number | null;
  included_per: string | null;
  minimum_charge: string | number | null;
  conditions: unknown;
  exclusive_group: string | null;
  priority: number | null;
  driver: unknown;
  minimum: unknown;
  resolved_rule_keys?: string[] | null;
  description: string | null;
  help_text: string | null;
}

/** The columns a fee manager may write (the grant lists exactly these). */
export type FeeRuleWrite = Omit<FeeRuleRow, "id" | "resolved_rule_keys">;

export function ruleFormToRow(input: FeeRuleInput, meta: { versionId: string; tenantId: string; position: number }): FeeRuleWrite {
  return {
    version_id: meta.versionId,
    tenant_id: meta.tenantId,
    position: meta.position,
    key: input.key,
    name: input.name,
    category: input.category,
    scope: input.scope,
    basis: input.basis,
    method: input.method,
    amount: input.amount,
    percent: input.percent,
    percent_base: input.percentBase,
    tiers: input.tiers,
    included_quantity: input.includedQuantity,
    included_per: input.includedPer,
    minimum_charge: input.minimumCharge,
    conditions: input.conditions,
    exclusive_group: input.exclusiveGroup,
    priority: input.priority,
    driver: input.driver,
    minimum: input.minimum,
    description: input.description,
    help_text: input.helpText,
  };
}

/** Decimal text of a numeric column; PostgREST may hand numerics over as JSON numbers. */
function numericText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? new D(value).toFixed() : value;
}

function jsonColumn<T>(schema: z.ZodType<T>, value: unknown, what: string, key: string): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RangeError(`fee rule "${key}" has malformed ${what}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/**
 * A `fee_rules` row as the engine's `FeeRule`, in the shape `fee_schedule_snapshot` produces (null
 * fields omitted, numerics as decimal text). Malformed jsonb throws rather than pricing on it.
 */
export function rowToSnapshotRule(row: FeeRuleRow): FeeRule {
  const rule: FeeRule = {
    key: row.key,
    name: row.name,
    category: row.category as FeeCategory,
    scope: row.scope as FeeScope,
    basis: row.basis as FeeBasis,
    method: row.method as FeeMethod,
    amount: numericText(row.amount),
    percent: numericText(row.percent),
    position: row.position,
  };
  if (row.id) rule.id = row.id;
  if (row.percent_base) rule.percentBase = row.percent_base as FeeRule["percentBase"];
  const tiers = jsonColumn(feeTiersSchema, row.tiers, "tiers", row.key);
  if (tiers) rule.tiers = tiers;
  const includedQuantity = numericText(row.included_quantity);
  if (includedQuantity !== null) rule.includedQuantity = includedQuantity;
  if (row.included_per) rule.includedPer = row.included_per as IncludedPer;
  const minimumCharge = numericText(row.minimum_charge);
  if (minimumCharge !== null) rule.minimumCharge = minimumCharge;
  const conditions = jsonColumn(feeConditionsSchema, row.conditions, "conditions", row.key);
  if (conditions) rule.conditions = conditions;
  if (row.exclusive_group) rule.exclusiveGroup = row.exclusive_group;
  if (row.priority !== null && row.priority !== undefined) rule.priority = row.priority;
  const driver = jsonColumn(feeDriverSchema, row.driver, "driver", row.key);
  if (driver) rule.driver = driver;
  const minimum = jsonColumn(feeMinimumSchema, row.minimum, "minimum", row.key);
  if (minimum) rule.minimum = minimum;
  if (row.resolved_rule_keys) rule.resolvedRuleKeys = row.resolved_rule_keys;
  if (row.description) rule.description = row.description;
  if (row.help_text) rule.helpText = row.help_text;
  return rule;
}

/**
 * A snapshot rule as the editor's form input (prefill when editing, and the fixtures in tests).
 * An account minimum's amount lives in `minimum.amount` only: the database refuses a top-level
 * amount on any non-flat rule, so a redundant copy on a minimum rule is dropped here.
 */
export function snapshotRuleToForm(rule: FeeRule): FeeRuleInput {
  return {
    key: rule.key,
    name: rule.name,
    category: rule.category,
    scope: rule.scope,
    basis: rule.basis,
    method: rule.method,
    amount: rule.method === "flat" ? (rule.amount ?? null) : null,
    percent: rule.percent ?? null,
    percentBase: rule.percentBase ?? null,
    tiers: rule.tiers ?? null,
    includedQuantity: rule.includedQuantity ?? null,
    includedPer: rule.includedPer ?? null,
    minimumCharge: rule.minimumCharge ?? null,
    conditions: rule.conditions ?? null,
    exclusiveGroup: rule.exclusiveGroup ?? null,
    priority: rule.priority ?? null,
    driver: rule.driver ?? null,
    minimum: rule.minimum ?? null,
    description: rule.description ?? null,
    helpText: rule.helpText ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fulfillment answers (run setup step 2), mirroring app.validate_fulfillment
// ---------------------------------------------------------------------------
const driverKey = z.string().regex(SLUG_RE, "not a question of this fee schedule");
const answerDecimal = decimalString(12, 4, "Enter a number (up to 4 decimals).").refine(withinRange((d) => d.lte(1_000_000_000)), "This number is out of range.");
const sharePct = decimalString(12, 2, "Enter a share of orders as a percentage with up to 2 decimals.").refine(withinRange((d) => d.lte(100)), "A share of orders is between 0 and 100.");

export const orderShareAnswerSchema = z.strictObject(
  {
    sharePct,
    countPerOrder: wholeNumber(1, 1000, "Enter a whole count per order (1–1000)."),
  },
  { error: "An order driver needs a share of orders (0–100) and a whole count per order (1–1000)." },
);

const contentCount = wholeNumber(0, 99_999, "Enter a whole number up to 99,999.");
export const orderContentSchema = z
  .strictObject(
    {
      rows: z
        .array(
          z
            .strictObject({ units: contentCount, lines: contentCount, sharePct: decimalString(12, 2, "Enter a share of orders with up to 2 decimals.") }, { error: "Each order content row needs units, lines and a share of orders." })
            .superRefine((row, ctx) => {
              if (row.lines > row.units) ctx.addIssue({ code: "custom", path: ["lines"], message: "An order cannot have more lines than items." });
              if (row.units > 0 && row.lines === 0) ctx.addIssue({ code: "custom", path: ["lines"], message: "An order with items has at least one line." });
            }),
        )
        .min(1, "Order content must list 1–12 rows.")
        .max(12, "Order content must list 1–12 rows."),
    },
    { error: "Order content must list 1–12 rows." },
  )
  .superRefine((c, ctx) => {
    // Rows whose share failed its own check are already reported; the sum is only meaningful over valid shares.
    if (!c.rows.every((r) => /^[0-9]+(\.[0-9]+)?$/.test(r.sharePct))) return;
    const total = c.rows.reduce((sum, r) => sum.plus(r.sharePct), new D(0));
    if (!total.eq(100)) ctx.addIssue({ code: "custom", path: ["rows"], message: `Order content shares add up to ${total.toFixed(2)}%; they must add up to exactly 100.00%.` });
  });

/** Roughly pg_column_size ≤ 16 KB: jsonb carries per-key overhead, so the text is capped lower. */
const MAX_ANSWERS_TEXT = 12_000;

export const fulfillmentAnswersSchema = z
  .strictObject(
    {
      skip: z.boolean({ error: "skip must be true or false" }).optional(),
      monthlyOrders: nullable(decimalString(12, 2, "Enter the number of orders a month (up to 2 decimals).").refine(withinRange((d) => d.gte(1) && d.lte(5_000_000)), "Monthly orders must be between 1 and 5,000,000.")).optional(),
      drivers: z.record(driverKey, nullable(answerDecimal)).nullable().optional(),
      orderShares: z.record(driverKey, nullable(orderShareAnswerSchema)).nullable().optional(),
      packagingDefault: nullable(z.string().trim().min(1, "Packaging default must be up to 60 characters.").max(60, "Packaging default must be up to 60 characters.")).optional(),
      orderContent: nullable(orderContentSchema).optional(),
    },
    { error: "Fulfillment assumptions carry an unknown field." },
  )
  .superRefine((f, ctx) => {
    if (JSON.stringify(f).length > MAX_ANSWERS_TEXT) ctx.addIssue({ code: "custom", path: [], message: "Fulfillment assumptions are too large." });
  });

export type FulfillmentAnswersInput = z.output<typeof fulfillmentAnswersSchema>;

/**
 * The checks of app.validate_fulfillment that need the pinned schedule: every answered key is a
 * question of this version, a returns rate is 0–100, and a long-term quantity never exceeds the stored
 * quantity it is part of. Keys: "drivers.<key>" / "orderShares.<key>".
 */
export function fulfillmentAnswerProblems(answers: FulfillmentAnswersInput, snapshot: FeeScheduleSnapshot): FieldErrors {
  const out: FieldErrors = {};
  const monthlyByDriver = new Map<string, FeeRule>();
  const orderKeys = new Set<string>();
  for (const rule of snapshot.rules) {
    if (!rule.driver) continue;
    if (rule.basis === "driver" && !monthlyByDriver.has(rule.driver.key)) monthlyByDriver.set(rule.driver.key, rule);
    if (rule.basis === "order_driver") orderKeys.add(rule.driver.key);
  }
  const drivers = answers.drivers ?? {};
  for (const [key, value] of Object.entries(drivers)) {
    const rule = monthlyByDriver.get(key);
    if (!rule) {
      out[`drivers.${key}`] = "This question is not on the fee schedule.";
      continue;
    }
    if (value !== null && rule.driver?.kind === "returns_rate" && new D(value).gt(100)) out[`drivers.${key}`] = "A returns rate is a percent of orders (0–100).";
  }
  for (const key of Object.keys(answers.orderShares ?? {})) {
    if (!orderKeys.has(key)) out[`orderShares.${key}`] = "This question is not on the fee schedule.";
  }
  // Long-term "replace" quantities are part of the stored quantity they replace.
  for (const rule of snapshot.rules) {
    const lt = rule.driver?.longTerm;
    if (!lt || lt.mode !== "replace" || !rule.driver) continue;
    const stored = snapshot.rules.find((r) => r.key === lt.replacesRuleKey)?.driver?.key;
    const own = drivers[rule.driver.key];
    const storedAnswer = stored ? drivers[stored] : undefined;
    if (own !== null && own !== undefined && storedAnswer !== null && storedAnswer !== undefined && new D(own).gt(storedAnswer)) {
      out[`drivers.${rule.driver.key}`] = `This cannot exceed the total ${rule.driver.unit} stored (${storedAnswer}).`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Try an order" (editor panel): one order typed by staff, priced on a version's snapshot
// ---------------------------------------------------------------------------
const orderCount = wholeNumber(0, 999_999, "Enter a whole number up to 999,999.");
const dollars = decimalString(8, 4, "Enter an amount in dollars (up to 4 decimals).");

export const tryOrderInputSchema = z.object({
  /** null = unknown (the rule that reads it is reported as not computed, never $0). */
  units: nullable(orderCount),
  lines: nullable(orderCount),
  distinctSkus: nullable(orderCount),
  packages: z.array(z.object({ packagingType: nullable(z.string().trim().min(1).max(60, "Packaging types are up to 60 characters.")) })).max(50, "Up to 50 packages.").default([]),
  shipments: wholeNumber(1, 50, "Enter 1–50 shipments.").default(1),
  /** The order's shipping in dollars; null = shipping unknown. */
  shipping: nullable(
    z.object({
      total: dollars,
      baseFreight: nullable(dollars),
      estimated: z.boolean().default(false),
      hasExposure: z.boolean().default(false),
    }),
  ),
  orderShares: z.record(driverKey, nullable(orderShareAnswerSchema)).default({}),
  /** Monthly volume per basis for rules tiered on the monthly quantity (orders, items, packages, shipments a month). */
  monthlyQuantities: z
    .object({
      order: nullable(answerDecimal).optional(),
      unit: nullable(answerDecimal).optional(),
      package: nullable(answerDecimal).optional(),
      shipment: nullable(answerDecimal).optional(),
    })
    .default({}),
  packagingDefault: nullable(z.string().trim().min(1).max(60, "Packaging types are up to 60 characters.")),
  ordinal: wholeNumber(1, 1_000_000_000, "The order ordinal is a whole number from 1.").default(1),
});

export type TryOrderInput = z.output<typeof tryOrderInputSchema>;

/** The engine input and context for a tried order; pinned monthly rates are resolved from the stated volumes. */
export function tryOrderToEngine(parsed: TryOrderInput, snapshot: FeeScheduleSnapshot): { input: OrderFeeInput; context: OrderFeeContext } {
  const pinnedRates: OrderFeeContext["pinnedRates"] = {};
  for (const rule of snapshot.rules) {
    if (rule.scope !== "order" || rule.method !== "tiered" || !rule.tiers || rule.tiers.on !== "monthly_quantity") continue;
    const quantity = rule.basis === "order" || rule.basis === "unit" || rule.basis === "package" || rule.basis === "shipment" ? parsed.monthlyQuantities[rule.basis] : null;
    if (quantity === null || quantity === undefined) continue;
    const rateE4 = resolveMonthlyRate(rule.tiers, new D(quantity));
    if (rateE4 !== null) pinnedRates[rule.key] = { rateE4, monthlyQuantity: quantity };
  }
  const shipping: OrderFeeInput["shipping"] = parsed.shipping
    ? {
        totalE4: toE4(new D(parsed.shipping.total)),
        baseFreightE4: toE4(new D(parsed.shipping.baseFreight ?? parsed.shipping.total)),
        estimated: parsed.shipping.estimated,
        hasExposure: parsed.shipping.hasExposure,
      }
    : null;
  return {
    input: {
      units: parsed.units,
      lines: parsed.lines,
      distinctSkus: parsed.distinctSkus,
      packages: parsed.packages.map((p) => ({ packagingType: p.packagingType })),
      shipments: parsed.shipments,
      shipping,
      assumed: {},
      ordinal: parsed.ordinal,
    },
    context: { orderShares: parsed.orderShares, pinnedRates, packagingDefault: parsed.packagingDefault },
  };
}
