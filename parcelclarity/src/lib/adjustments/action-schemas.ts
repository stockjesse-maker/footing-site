import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { fieldErrors, uuidSchema, type FieldErrors } from "@/lib/auth/validation";
import { isValidPolicyPair } from "@/engine/adjustments/policy";
import { storableWeight } from "@/engine/adjustments/storage";
import {
  ADJUSTMENT_CAUSES,
  POLICY_COMPONENTS,
  POLICY_TYPES,
  type AdjustmentScenarioResult,
  type E4,
  type Handling,
  type HistoryRefused,
  type HistoryStatistics,
  type PolicyComponent,
  type PolicyType,
  type RiskForecast,
  type RiskInputs,
  type RiskRefusalCode,
} from "@/engine/adjustments/types";
import type { AdjustmentValidationReport, MappingIssue } from "./types";

/**
 * Everything the adjustment server actions (src/app/actions/adjustments.ts) and their callers share that is not an action:
 * request schemas, friendly messages for the database's refusals, result shapes and a few pure helpers. It is kept out of the
 * "use server" module (that file may export async functions only) and it imports nothing that needs a server, so a form can
 * use the schemas and the types.
 *
 * Nothing here knows a carrier buy rate. Every amount a caller types is "what your customer is charged"; the money fields
 * of a history file are guarded elsewhere (header-guard.ts) before anything is stored.
 */

// ---------------------------------------------------------------------------
// Routes and wording
// ---------------------------------------------------------------------------
export const ADJUSTMENTS_PATH = "/app/adjustments";
/** An import's own page: `${HISTORY_PATH}/${importId}`. */
export const HISTORY_PATH = `${ADJUSTMENTS_PATH}/history`;

export const GENERIC_FAILURE = "Something went wrong. Please try again.";
export const NO_PERMISSION_VIEW = "You don't have permission to view adjustments.";
export const NO_PERMISSION_MANAGE = "You don't have permission to change adjustments. Only administrators can.";
/** The same sentence as RATE_LIMITED_MESSAGE of src/lib/rate-limit.ts (that module is server-only; a unit test keeps the two equal). */
export const TOO_OFTEN_MESSAGE = "You're doing that too often. Please wait a few minutes and try again.";

export const ATTESTATION_REQUIRED = "Confirm that these columns hold what your customer was or would be charged, not what the carrier billed you.";
export const CUSTOMER_NOT_FOUND = "Customer not found.";
export const ITEM_NOT_FOUND = "That item was not found.";

/** Per-user rate limits of the actions (names match the database's `^[a-z_.]{2,60}$`, so no digits). */
export const RATE_LIMITS = {
  upload: { action: "adjustment.upload", limit: 30, windowSeconds: 3600 },
  mapping: { action: "adjustment.mapping", limit: 240, windowSeconds: 3600 },
  validate: { action: "adjustment.validate", limit: 120, windowSeconds: 3600 },
  commit: { action: "adjustment.commit", limit: 20, windowSeconds: 3600 },
  statistics: { action: "adjustment.statistics", limit: 240, windowSeconds: 3600 },
  evaluate: { action: "adjustment.evaluate", limit: 600, windowSeconds: 3600 },
  save: { action: "adjustment.save", limit: 240, windowSeconds: 3600 },
  forecast: { action: "adjustment.forecast", limit: 240, windowSeconds: 3600 },
} as const;

// ---------------------------------------------------------------------------
// Dates, decimals and plain text
// ---------------------------------------------------------------------------
function isRealDate(v: string): boolean {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.").refine(isRealDate, "Enter a real date.");

/** Today as an ISO date in UTC (what the database's current_date is on Supabase). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A weight or a dimension: up to 6 digits and 6 decimals, more than zero (the shape of the customer payload's `dec`). */
const positiveDecimal = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,6}(\.\d{1,6})?$/, `Enter ${what} as a number (up to 6 digits).`)
    .refine((v) => Number(v) > 0, `${what[0]!.toUpperCase()}${what.slice(1)} must be more than zero.`);

/** Plain text a customer may read: the database's `app.plain_text_ok` (no control, bidi or zero-width characters, no angle brackets). */
const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [[0x01, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];

/** True when the text has a control, bidi or zero-width character or an angle bracket (the characters `app.plain_text_ok` refuses). */
export function hasForbiddenText(v: string): boolean {
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (ch === "<" || ch === ">" || FORBIDDEN_RANGES.some(([a, b]) => c >= a && c <= b)) return true;
  }
  return false;
}

export const plainText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${what}.`)
    .max(max, `Use at most ${max} characters.`)
    .refine((v) => !hasForbiddenText(v), "Use plain text: no angle brackets or hidden characters.");

const privateNote = z.string().trim().max(1000, "Use at most 1,000 characters.");

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
export const HANDLINGS = ["absorbed", "pass_through", "manual_approval"] as const;

export const setPolicySchema = z
  .strictObject({
    /** null = the decision for all customers; a customer id = that customer's own decision. */
    brandId: uuidSchema.nullable(),
    adjustmentType: z.enum(POLICY_TYPES, { error: "Choose a kind of adjustment." }),
    component: z.enum(POLICY_COMPONENTS, { error: "Choose what the decision is about." }),
    handling: z.enum(HANDLINGS, { error: "Choose who pays." }),
    note: z.preprocess(blankToNull, privateNote.nullish()),
  })
  .refine((v) => isValidPolicyPair(v.adjustmentType, v.component), { path: ["component"], message: "A correction fee has no shipping charge difference; decide the separate adjustment fee." });
export type SetPolicyInput = z.infer<typeof setPolicySchema>;

/** The seven valid (type, component) pairs, in the order the Policies screen lists them: reweigh, remeasure, both together, other correction fee. */
export const POLICY_CELLS: readonly { type: PolicyType; component: PolicyComponent }[] = POLICY_TYPES.flatMap((type) =>
  POLICY_COMPONENTS.filter((component) => isValidPolicyPair(type, component)).map((component) => ({ type, component })),
);

/** One stored decision (`adjustment_policies`). `brandId` null is the decision for all customers. Dates are inclusive. */
export interface PolicyRecord {
  id: string;
  brandId: string | null;
  adjustmentType: PolicyType;
  component: PolicyComponent;
  handling: Exclude<Handling, "unconfigured">;
  validFrom: string;
  validTo: string | null;
  internalNote: string | null;
  createdAt: string;
}

export interface PolicyCellView {
  type: PolicyType;
  component: PolicyComponent;
  /** The decision for all customers in effect on the date; null reads "Not decided". */
  account: PolicyRecord | null;
  /** Customers with their own decision in effect on the date. */
  exceptions: PolicyRecord[];
}

const inEffect = (p: Pick<PolicyRecord, "validFrom" | "validTo">, on: string) => p.validFrom <= on && (p.validTo === null || p.validTo >= on);

/** The Policies matrix for a date: per cell the account-wide decision and the customers' own decisions. Pure. */
export function currentPolicyCells(rows: readonly PolicyRecord[], on: string): PolicyCellView[] {
  return POLICY_CELLS.map(({ type, component }) => {
    const live = rows.filter((r) => r.adjustmentType === type && r.component === component && inEffect(r, on));
    return {
      type,
      component,
      account: live.find((r) => r.brandId === null) ?? null,
      exceptions: live.filter((r) => r.brandId !== null).sort((a, b) => (a.brandId! < b.brandId! ? -1 : 1)),
    };
  });
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
export const baselineSchema = z
  .strictObject({
    /** Present to edit an existing baseline. */
    id: uuidSchema.nullish(),
    /** null = all customers together. */
    brandId: uuidSchema.nullable(),
    carrierCode: z.preprocess(blankToNull, z.string().trim().min(1).max(40).nullable()),
    serviceId: uuidSchema.nullable(),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    /** The unit is the carrier package. */
    packagesTotal: z.number({ error: "Enter a whole number of packages." }).int("Enter a whole number of packages.").min(1, "Enter at least 1 package.").max(2_000_000_000, "That is too many packages."),
    /** Labels printed without a weight in the period, when the WMS reports it; null = not known. */
    labelsMissingWeight: z.number({ error: "Enter a whole number." }).int("Enter a whole number.").min(0, "Enter 0 or more.").nullable(),
    note: z.preprocess(blankToNull, privateNote.nullish()),
  })
  .superRefine((v, ctx) => {
    if (v.periodStart < "2015-01-01") ctx.addIssue({ code: "custom", path: ["periodStart"], message: "The period cannot start before 2015." });
    if (v.periodEnd > "2100-01-01") ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "Enter an earlier end date." });
    if (v.periodEnd < v.periodStart) ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "The period ends before it starts." });
    if (v.labelsMissingWeight !== null && v.labelsMissingWeight > v.packagesTotal) ctx.addIssue({ code: "custom", path: ["labelsMissingWeight"], message: "Labels without a weight cannot be more than the packages shipped." });
  });
export type BaselineInput = z.infer<typeof baselineSchema>;

// ---------------------------------------------------------------------------
// History statistics
// ---------------------------------------------------------------------------
export const historyFiltersSchema = z
  .strictObject({
    /** null = the whole account (only baselines that cover all customers are used). */
    brandId: uuidSchema.nullable(),
    carrierCode: z.preprocess(blankToNull, z.string().trim().min(1).max(40).nullish()),
    serviceId: uuidSchema.nullish(),
    adjustmentType: z.enum(POLICY_TYPES).nullish(),
    cause: z.enum(ADJUSTMENT_CAUSES).nullish(),
    window: z.strictObject({ from: isoDateSchema, to: isoDateSchema }).nullish(),
    baselineIds: z.array(uuidSchema).max(500).nullish(),
    /** Days after the end of a window within which adjustments may still be posting. */
    maturityDays: z.number().int().min(0).max(3650).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.window && v.window.to < v.window.from) ctx.addIssue({ code: "custom", path: ["window"], message: "The window ends before it starts." });
  });
export type HistoryFiltersInput = z.infer<typeof historyFiltersSchema>;

/** What the history statistics call hands back: never the records themselves. */
export type HistoryStatsResponse =
  | {
      status: "ok";
      statistics: HistoryStatistics;
      /** Committed imports that supplied records to the statistic (a saved estimate cites them by id). */
      importIds: string[];
      /** Records read from the account's committed history (before the statistic's own filters). */
      recordsRead: number;
      asOf: string;
    }
  | { status: "refused"; refusal: HistoryRefused }
  | { status: "invalid"; problems: string[]; errors?: FieldErrors }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------
const weightUnit = z.enum(["lb", "oz"], { error: "Choose pounds or ounces." });
const dimsAllOrNone = (v: { length?: string; width?: string; height?: string }, ctx: z.RefinementCtx) => {
  const given = [v.length, v.width, v.height].filter((x) => x !== undefined).length;
  if (given !== 0 && given !== 3) ctx.addIssue({ code: "custom", path: ["length"], message: "Give the length, width and height, or none of them." });
};

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/**
 * An example keeps its weights in pounds with at most 6 decimals, and a weight that must be rounded to get there can cross a billable-weight
 * boundary, so the saved package would no longer price to the amount shown to the customer (engine review finding F10). A weight in ounces with
 * more than 2 decimals (16.001 oz is 1.0000625 lb) is therefore refused up front, with the engine's own test (`storableWeight`).
 */
export const OUNCE_PRECISION_MESSAGE = "Enter ounces with at most 2 decimals (or pounds with at most 6), so the saved example prices to the amount shown.";
const exactWeight = (v: { weight?: string; weightUnit?: "lb" | "oz" }, ctx: z.RefinementCtx) => {
  if (v.weight !== undefined && !storableWeight(v.weight, v.weightUnit ?? "lb")) ctx.addIssue({ code: "custom", path: ["weight"], message: OUNCE_PRECISION_MESSAGE });
};

const declaredPackage = z
  .strictObject({
    weight: positiveDecimal("the declared weight"),
    weightUnit,
    length: z.preprocess(emptyToUndefined, positiveDecimal("the length").optional()),
    width: z.preprocess(emptyToUndefined, positiveDecimal("the width").optional()),
    height: z.preprocess(emptyToUndefined, positiveDecimal("the height").optional()),
  })
  .superRefine((v, ctx) => {
    dimsAllOrNone(v, ctx);
    exactWeight(v, ctx);
  });

/** What changes for one package; only the fields present change. The package count cannot differ. */
const correctionPackage = z
  .strictObject({
    weight: z.preprocess(emptyToUndefined, positiveDecimal("the corrected weight").optional()),
    weightUnit: z.preprocess(emptyToUndefined, weightUnit.optional()),
    length: z.preprocess(emptyToUndefined, positiveDecimal("the length").optional()),
    width: z.preprocess(emptyToUndefined, positiveDecimal("the width").optional()),
    height: z.preprocess(emptyToUndefined, positiveDecimal("the height").optional()),
  })
  .superRefine((v, ctx) => {
    dimsAllOrNone(v, ctx);
    exactWeight(v, ctx);
    if (v.weightUnit !== undefined && v.weight === undefined) ctx.addIssue({ code: "custom", path: ["weight"], message: "Enter the corrected weight with its unit." });
  });

export const MAX_EXAMPLE_PACKAGES = 20;

export const scenarioInputSchema = z
  .strictObject({
    /** The customer the example is priced for (their rate card, exceptions and decisions apply). null = an exploration that cannot be shared. */
    brandId: uuidSchema.nullable(),
    /** One of the customer's assigned rate cards; the first one that has the service when absent. Required without a customer. */
    rateCardId: uuidSchema.nullish(),
    serviceId: uuidSchema,
    /** The date the example is priced on (rates in effect that day); today when absent. */
    shipDate: isoDateSchema.nullish(),
    originZip: z.string().trim().min(3, "Enter the ship-from ZIP.").max(10),
    destinationZip: z.preprocess(emptyToUndefined, z.string().trim().min(3).max(10).optional()),
    destinationZone: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(12).optional()),
    residential: z.boolean({ error: "Choose residential or commercial." }),
    /** `wms_fallback`: the declared weight is the fallback the WMS used when the label was created. */
    declaredSource: z.enum(["entered", "wms_fallback"], { error: "Say where the declared weight came from." }),
    packages: z
      .array(z.strictObject({ declared: declaredPackage, correction: correctionPackage }))
      .min(1, "Add at least one package.")
      .max(MAX_EXAMPLE_PACKAGES, `Use at most ${MAX_EXAMPLE_PACKAGES} packages.`),
  })
  .superRefine((v, ctx) => {
    if (v.destinationZip === undefined && v.destinationZone === undefined) ctx.addIssue({ code: "custom", path: ["destinationZip"], message: "Enter the destination ZIP or the zone." });
    if (v.brandId === null && !v.rateCardId) ctx.addIssue({ code: "custom", path: ["rateCardId"], message: "Choose a rate card when no customer is chosen." });
  });
export type ScenarioBuilderInput = z.infer<typeof scenarioInputSchema>;

export const scenarioNameSchema = plainText(160, "a name for the example");

// ---------------------------------------------------------------------------
// Publishing (the customer sees only text from here; the payload is built in SQL)
// ---------------------------------------------------------------------------
export const publishSchema = z.strictObject({
  scenarioId: uuidSchema,
  brandId: uuidSchema,
  /** The heading the customer reads. */
  title: plainText(120, "a title").refine((v) => !/[\r\n]/.test(v), "Use one line."),
  /** Optional: "Note to the customer" (the customer reads it). */
  note: z.preprocess(blankToNull, plainText(300, "a note").nullish()),
  /** Optional shorter "shown until" date; the database never lets it run longer than 90 days or past an end date the example depends on. */
  validThrough: z.preprocess(blankToNull, isoDateSchema.nullish()),
  /** Optional: only your team reads it. */
  internalNote: z.preprocess(blankToNull, privateNote.nullish()),
});
export type PublishInput = z.infer<typeof publishSchema>;

// ---------------------------------------------------------------------------
// Risk forecast
// ---------------------------------------------------------------------------
export const BASIS_REQUIRED_MESSAGE = "Choose one. It decides whether postage differences are counted here or are already in your forecast.";

/** Dollars with up to 4 decimals, zero or more. */
const dollars = z
  .string({ error: "Enter an amount in dollars, or leave it blank if you do not know it." })
  .trim()
  .regex(/^\d{1,7}(\.\d{1,4})?$/, "Enter dollars and cents, zero or more (up to 4 decimals).");

/** Where a severity (what one adjustment adds) comes from. `entered` with no amount means "not known": never zero. */
const severityChoice = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("history") }),
  z.strictObject({ source: z.literal("entered"), amount: z.preprocess(blankToNull, dollars.nullable()) }),
  z.strictObject({ source: z.literal("example"), scenarioId: uuidSchema }),
]);
export type SeverityChoice = z.infer<typeof severityChoice>;

export const MAX_MONTHLY_PACKAGES_INPUT = 5_000_000;

export const riskInputSchema = z
  .strictObject({
    /** The customer, or null for the whole account. */
    brandId: uuidSchema.nullable(),
    /** Whose decision ("who pays") applies, and which records history counts. */
    adjustmentType: z.enum(POLICY_TYPES, { error: "Choose a kind of adjustment." }),
    /** REQUIRED, no default. */
    basis: z.enum(["declared_weights", "actual_weights"], { error: BASIS_REQUIRED_MESSAGE }),
    volume: z.discriminatedUnion("source", [
      z.strictObject({ source: z.literal("entered"), packagesPerMonth: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "Enter the packages a month as a number.") }),
      /** A finished run of the customer's file: its monthly packages (never modeled orders). Needs a customer. */
      z.strictObject({ source: z.literal("run"), runId: uuidSchema }),
    ]),
    incidence: z.discriminatedUnion("source", [z.strictObject({ source: z.literal("history") }), z.strictObject({ source: z.literal("entered"), pct: z.string().trim().regex(/^\d{1,3}(\.\d{1,6})?$/, "Enter a percentage from 0 to 100.") })]),
    severity: z.strictObject({ postage_difference: severityChoice, separate_fee: severityChoice }),
    /** Explicit, no default: `memo` adds a staff-only note about credits from history; credits never enter exposure either way. */
    credits: z.enum(["exclude", "memo"], { error: "Choose how credits are treated." }),
    /** Which part of the history to count. Required when the incidence or a severity comes from history. */
    history: z
      .strictObject({
        carrierCode: z.preprocess(blankToNull, z.string().trim().min(1).max(40).nullish()),
        serviceId: uuidSchema.nullish(),
        /** Defaults to the adjustment type above; null means every type. */
        adjustmentType: z.enum(POLICY_TYPES).nullish(),
        cause: z.enum(ADJUSTMENT_CAUSES).nullish(),
        window: z.strictObject({ from: isoDateSchema, to: isoDateSchema }).nullish(),
        baselineIds: z.array(uuidSchema).max(500).nullish(),
        maturityDays: z.number().int().min(0).max(3650).nullish(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    const usesHistory = v.incidence.source === "history" || v.severity.postage_difference.source === "history" || v.severity.separate_fee.source === "history";
    if (usesHistory && !v.history) ctx.addIssue({ code: "custom", path: ["history"], message: "Choose which history to use." });
    if (v.credits === "memo" && v.incidence.source !== "history") ctx.addIssue({ code: "custom", path: ["credits"], message: "Credits can only be shown from your history." });
    if (v.volume.source === "run" && v.brandId === null) ctx.addIssue({ code: "custom", path: ["volume"], message: "Choose a customer to use the volume of one of their runs." });
    if (v.incidence.source === "entered") {
      const n = Number(v.incidence.pct);
      if (!(n >= 0 && n <= 100)) ctx.addIssue({ code: "custom", path: ["incidence", "pct"], message: "The incidence must be between 0 and 100 percent." });
    }
    if (v.volume.source === "entered" && Number(v.volume.packagesPerMonth) > MAX_MONTHLY_PACKAGES_INPUT) {
      ctx.addIssue({ code: "custom", path: ["volume", "packagesPerMonth"], message: `The monthly volume is limited to ${MAX_MONTHLY_PACKAGES_INPUT.toLocaleString("en-US")} packages.` });
    }
  });
export type RiskFormInput = z.infer<typeof riskInputSchema>;

export const estimateNameSchema = plainText(160, "a name for the estimate");

/** Whole ten-thousandths of a dollar from "5.30" / "5.3012": exact, no floating point. */
export function dollarsToE4(amount: string): E4 {
  const [whole, frac = ""] = amount.split(".");
  return Number(whole) * 10_000 + Number(`${frac}0000`.slice(0, 4));
}

/** What a saved estimate keeps BY VALUE, so a later edit of the history cannot change it (`risk_estimates.inputs`, at most 16 KB). */
export interface StoredRiskInputs {
  v: 1;
  adjustmentType: PolicyType;
  basis: "declared_weights" | "actual_weights";
  credits: "exclude" | "memo";
  volume: { source: "entered" | "run"; monthlyPackages: string; runId?: string };
  incidence: { source: "history"; k: number; N: number } | { source: "entered"; pct: string };
  severity: Record<PolicyComponent, { source: "history" | "entered" | "example"; e4: E4 | null; n?: number | null; scenarioId?: string }>;
  history: { filters: Record<string, unknown>; recordsInScope: number; affected: number; baselineIds: string[]; periods: { start: string; end: string }[]; counts: RiskHistoryCounts | null } | null;
  importIds: string[];
}

/**
 * What the history's records were counted as for the estimate (distinct packages). Exposure counts the packages that cost something or
 * whose amount is not known (`charges` + `unknownAmount`); credits never enter it and a change of zero adds nothing. The screen says how many
 * were left out and how many were counted without an amount.
 */
export interface RiskHistoryCounts {
  /** Packages whose shipping charge went up. */
  charges: number;
  /** Packages whose charge went down (credits): never part of the exposure, shown beside it. */
  credits: number;
  /** Packages whose charge did not change. */
  zeroChange: number;
  /** Packages with no amounts (weights-only rows): counted for how often, as charges of unknown size. */
  unknownAmount: number;
  /** The packages counted in the estimate (charges + unknownAmount, never more than the packages affected). */
  counted: number;
  /** Distinct packages affected, all directions. */
  affected: number;
}

export interface RiskRunVolume {
  runId: string;
  runName: string | null;
  monthlyPackages: string;
  /** True when the run priced weights from product weights: a forecast built on it is not a forecast on actual weights. */
  weightsFromProductProfiles: boolean | null;
}

export type RiskForecastResponse =
  | {
      status: "ok";
      forecast: RiskForecast;
      /** What the screen needs to say where each number came from. */
      sources: {
        volume: { source: "entered" | "run"; monthlyPackages: string; run: RiskRunVolume | null };
        incidence: { source: "history" | "entered"; k: number | null; N: number | null; pctAsEntered: string | null; history: RiskHistoryCounts | null };
        severity: Record<PolicyComponent, { source: "history" | "entered" | "example"; e4: E4 | null; n: number | null }>;
        handling: Record<PolicyComponent, Handling>;
        credits: "exclude" | "memo";
        statistics: HistoryStatistics | null;
        importIds: string[];
      };
    }
  | { status: "refused"; code: RiskRefusalCode; message: string }
  | { status: "invalid"; problems: string[]; errors?: FieldErrors }
  | { status: "error"; message: string };

/**
 * The packages an estimate counts, from the statistics. Exposure never includes credits ("credits never enter exposure") and a change of zero adds
 * nothing, so the incidence it uses is the packages whose charge went up plus those whose amount is not known (the weights-only rows that "count for
 * incidence only"). Null without a baseline (no incidence at all).
 */
export function riskHistoryCounts(stats: HistoryStatistics): RiskHistoryCounts | null {
  const d = stats.incidenceByDirection;
  if (!d) return null;
  return { charges: d.increase.k, credits: d.decrease.k, zeroChange: d.zero.k, unknownAmount: d.unknown.k, counted: Math.min(stats.affected, d.increase.k + d.unknown.k), affected: stats.affected };
}

/** Everything `forecastAdjustmentRisk` needs, from what the screen asked for and what the server loaded. Pure. */
export interface RiskParts {
  volume: string;
  handling: Record<PolicyComponent, Handling>;
  statistics: HistoryStatistics | null;
  /** Severity (E4) of the saved examples named by `example` choices, by component; null = the example has no amount for it. */
  exampleSeverity: Partial<Record<PolicyComponent, E4 | null>>;
}

export function riskInputsFrom(form: RiskFormInput, parts: RiskParts): { ok: true; inputs: RiskInputs } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const stats = parts.statistics;
  let incidence: RiskInputs["incidence"];
  if (form.incidence.source === "entered") incidence = { source: "entered", pct: form.incidence.pct };
  else if (!stats) {
    problems.push("The history statistics could not be read.");
    incidence = { source: "history", k: 0, N: 0 };
  } else {
    // No baseline: the incidence is unknown (N = 0), never a guess; the engine says so.
    const counts = riskHistoryCounts(stats);
    incidence = stats.baseline.present && stats.incidence && counts ? { source: "history", k: counts.counted, N: stats.incidence.N } : { source: "history", k: 0, N: 0 };
  }

  const severity = {} as RiskInputs["severity"];
  for (const c of POLICY_COMPONENTS) {
    const choice = form.severity[c];
    if (choice.source === "entered") severity[c] = { source: "entered", e4: choice.amount === null ? null : dollarsToE4(choice.amount) };
    else if (choice.source === "example") severity[c] = { source: "example", e4: parts.exampleSeverity[c] ?? null };
    else if (!stats) {
      problems.push("The history statistics could not be read.");
      severity[c] = { source: "history", e4: null, n: 0 };
    } else {
      // Charges only: credits never enter exposure.
      const s = c === "postage_difference" ? stats.severity.increase.postage : stats.severity.increase.fee;
      severity[c] = { source: "history", e4: s.meanE4, n: s.n };
    }
  }

  let credits: RiskInputs["credits"] = null;
  if (form.credits === "memo" && stats && stats.incidenceByDirection) {
    const k = stats.incidenceByDirection.decrease.k;
    const mean = stats.severity.decrease.postage.meanE4;
    // No credit records is "0 credits", not an unknown; credit records always carry an amount (an unknown amount is its own group).
    credits = k === 0 ? { k: 0, severityE4: 0 } : mean === null ? null : { k, severityE4: mean };
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, inputs: { monthlyVolume: parts.volume, incidence, severity, basis: form.basis, handling: parts.handling, credits } };
}

// ---------------------------------------------------------------------------
// Results of the actions
// ---------------------------------------------------------------------------
export interface AdjustmentActionResult {
  ok: boolean;
  message?: string;
  errors?: FieldErrors;
}

/** The upload form's state: `refused` is true when the file looked like carrier cost data (nothing was stored). */
export type UploadState = ActionState & { refused?: boolean };

export interface MappingActionResult extends AdjustmentActionResult {
  status?: string;
  issues?: MappingIssue[];
}

export interface ValidateActionResult extends AdjustmentActionResult {
  status?: string;
  /** The report of this validation. It is stored (and the import marked validated) only when the file can be committed. */
  report?: AdjustmentValidationReport;
}

export interface CommitActionResult extends AdjustmentActionResult {
  committed?: number;
  skipped?: number;
}

export type ScenarioEvalResponse =
  | {
      status: "ok";
      result: AdjustmentScenarioResult;
      context: {
        brandId: string | null;
        brandName: string | null;
        rateCardId: string;
        rateCardName: string;
        rateCardVersionNumber: number;
        pricedOn: string;
        /** Rule problems found while loading (names the 3PL's rules; staff only). */
        loadIssues: string[];
      };
    }
  | { status: "invalid"; problems: string[]; errors?: FieldErrors }
  | { status: "error"; message: string };

export interface SaveScenarioResult extends AdjustmentActionResult {
  scenarioId?: string;
}

export interface SaveEstimateResult extends AdjustmentActionResult {
  estimateId?: string;
}

/** What the database's preview function returns (pins are removed); a refusal to share is data here, not an error. */
export interface ExamplePreview {
  ok: boolean;
  problems: { code: string; message: string }[];
  payload?: unknown;
  hidden?: { kind: string; reason: string }[];
  warnings?: string[];
  pricedOn?: string;
  ratesEffectiveFrom?: string;
  validThrough?: string;
}

export type ExampleState = "current" | "under_review" | "expired" | "retired";

export interface ExampleListItem {
  id: string;
  brandId: string;
  brandName: string | null;
  sourceScenarioId: string;
  title: string;
  noteToCustomer: string | null;
  internalNote: string | null;
  pricedOn: string;
  ratesEffectiveFrom: string;
  validThrough: string;
  publishedAt: string;
  retiredAt: string | null;
  state: ExampleState;
  causes: string[];
}

// ---------------------------------------------------------------------------
// The database's refusals, in words
// ---------------------------------------------------------------------------
export interface DbError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface RefusalWording {
  /** P0002: a missing, foreign or no-permission row (the database answers all three the same way). */
  notFound?: string;
  /** P0004: the row is in a state that does not allow this. */
  state?: string;
  /** P0007 / 23P01: an overlap. */
  overlap?: string;
  /** PC003: figures that did not reconcile. */
  reconcile?: string;
  /** PC001: input the application should have caught. */
  badInput?: string;
}

/** Why a row of a chunk was refused, by the database's reason code (the message carries the code and the row number, never the value). */
export const ROW_PROBLEMS: Record<string, string> = {
  invalid_ship_date: "the ship date is missing, unreadable or out of range",
  invalid_adjusted_on: "the adjusted-on date is unreadable, out of range or before the ship date",
  unknown_carrier: "the carrier is not in the carrier list",
  unknown_service: "the service is unknown or belongs to another carrier",
  unknown_customer: "the customer is not one of your customers",
  invalid_type: "the adjustment type is not recognised",
  invalid_cause: "the cause is not recognised",
  text_too_long: "a text is too long",
  invalid_package_ref: "the package reference is too long",
  invalid_weight_basis: "the weight basis is not recognised",
  weight_basis_mismatch: "the weight basis does not match the weight",
  invalid_weight: "a weight is zero, negative or unreadable",
  partial_dimensions: "only some of the length, width and height are given",
  invalid_dimensions: "a length, width or height is zero, negative or unreadable",
  negative_amount: "an amount is negative",
  invalid_amount: "an amount is unreadable",
  invalid_handling: "the handling value is not recognised",
  duplicate_package: "the package reference repeats another row or a package already imported",
};

/** The sentences for the publish refusals (`hint` of a P0001). The database's own messages say the same; these are the screen's. */
export const PUBLISH_REFUSALS: Record<string, string> = {
  not_found: "This example could not be found.",
  archived: "This example is archived. Price it again to share it.",
  no_customer: "This example was priced without a customer. Price it for the customer you want to share it with.",
  wrong_customer: "This example was priced for a different customer. Price it again for this one.",
  customer_inactive: "This customer is not active.",
  no_adjustment: "Nothing changes in this example, so there is nothing to share.",
  not_priced: "This example could not be priced, so it cannot be shared.",
  estimate_basis: "An example built from estimated amounts cannot be shared. Add the missing package details and price it again.",
  not_an_increase: "The corrected charge is not higher. This is a credit, not an adjustment charge, so it cannot be shared.",
  rate_card_not_assigned: "The rate card or service this example was priced on is not available to this customer. Price it again.",
  rate_card_not_in_effect: "The rate card this example was priced on is not in effect today. Price it again.",
  policy_changed: "The decision on who pays changed since this example was saved. Price it again.",
  component_undecided: "Part of this example could not be decided, so it cannot be shared.",
  no_customer_visible_component: "Nothing in this example is charged to the customer or decided case by case, so there is nothing to share.",
  invalid_result: "The saved result is not valid. Price it again.",
  input_incomplete: "The saved package details are incomplete. Price it again.",
  ended: "A rate, rule or decision this example depends on has already ended. Price it again.",
  payload_invalid: "This example cannot be shown to a customer in its present form.",
};

const COMPONENT_WORDS: [RegExp, string][] = [
  [/shipping charge difference/i, "the shipping charge difference"],
  [/separate adjustment fee/i, "the separate adjustment fee"],
];

function componentIn(message: string): string | null {
  for (const [re, words] of COMPONENT_WORDS) if (re.test(message)) return words;
  return null;
}

/** The sentence for a refusal to share (P0001 with a hint). The component is read from the database's curated message, which holds no row values. */
export function publishRefusalMessage(error: DbError): string | null {
  const hint = error.hint ?? "";
  if (hint === "undecided_policy") return `Decide how ${componentIn(error.message) ?? "the adjustment"} is handled for this customer first.`;
  if (hint === "component_below_minimum") return `${componentIn(error.message) ? capitalise(componentIn(error.message)!) : "The amount"} must be at least $0.01 to be shared.`;
  if (hint === "component_undecided") return `${componentIn(error.message) ? capitalise(componentIn(error.message)!) : "Part of this example"} could not be decided, so it cannot be shared.`;
  return PUBLISH_REFUSALS[hint] ?? null;
}

function capitalise(s: string): string {
  return `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

/** P0001 messages written by the migration that carry no hint. Matched by their opening words. */
const REFUSAL_BY_MESSAGE: [RegExp, string][] = [
  [/too many imports are in progress/i, "You already have five imports in progress. Finish or discard one first."],
  [/file already has an import/i, "This file has already been imported."],
  [/attestation is missing|confirm that the amounts/i, ATTESTATION_REQUIRED],
  [/saved risk estimates are based on this import/i, "Saved risk estimates are based on this import. Archive them first."],
  [/history limit of 200,000/i, "Your account has reached the limit of 200,000 history records. Withdraw an old import to make room."],
  [/limit of 500 baselines/i, "You have reached the limit of 500 baselines. Delete one first."],
  [/limit of 200 saved examples/i, "You have reached the limit of 200 saved examples. Archive some first."],
  [/limit of 200 saved estimates/i, "You have reached the limit of 200 saved estimates. Archive some first."],
  [/limit of 25 shared examples/i, "You have reached the limit of 25 shared examples for this customer. Stop sharing one first."],
  [/rate card is not assigned to this customer/i, "That rate card is not assigned to this customer."],
  [/scenario without a customer carries no customer exceptions/i, "An example without a customer cannot carry customer exceptions."],
];

/**
 * One friendly sentence for any refusal of an adjustment function, by SQLSTATE class (design v2 section 4):
 * 42501 no permission, P0002 not found (missing, foreign and unauthorized look the same), P0004 wrong state, P0007 overlap,
 * P0001 a business refusal (publish refusals carry a hint code), PC001 bad input ("row N: code" for a chunk of history), PC002 stale
 * cursor, PC003 does not reconcile, 53400 rate limit. The text never repeats a value from a row: the database's messages do not
 * contain any, and nothing but their codes, a row number and a header name from the person's own file is shown.
 */
export function rpcFailure(error: DbError, wording: RefusalWording = {}): string {
  switch (error.code) {
    case "42501":
      return NO_PERMISSION_MANAGE;
    case "P0002":
      return wording.notFound ?? ITEM_NOT_FOUND;
    case "P0004":
      return wording.state ?? "That can't be done in its current state. Reload the page and check.";
    case "P0007":
    case "23P01":
      return wording.overlap ?? "This overlaps something you already set.";
    case "53400":
      return TOO_OFTEN_MESSAGE;
    case "PC002":
      return "The upload got out of step and was reset. Start the import again from the beginning.";
    case "PC003":
      return wording.reconcile ?? "The figures did not reconcile. Please try again; if it keeps failing, contact support.";
    case "PC001": {
      const row = /^row (\d+): ([a-z_]+)$/.exec(error.message);
      if (row) return `Row ${row[1]} of the file was refused: ${ROW_PROBLEMS[row[2]!] ?? "a value is not valid"}. Nothing from this import was kept.`;
      return wording.badInput ?? "Some values were not accepted. Check them and try again.";
    }
    case "P0001": {
      const publish = publishRefusalMessage(error);
      if (publish) return publish;
      for (const [re, sentence] of REFUSAL_BY_MESSAGE) if (re.test(error.message)) return sentence;
      if (/carrier cost data/i.test(error.message)) return "A column that looks like carrier cost data cannot be mapped. Choose another column, or leave the field empty.";
      return "That is not allowed right now.";
    }
    default:
      return GENERIC_FAILURE;
  }
}

/** The first complaint per top-level field, as a form shows them (a refinement on the whole object reports under "form"). */
export const zodFieldErrors = (error: z.ZodError): FieldErrors => fieldErrors(error);

/** The problems of a request as one list of "field: message" lines (what the compute actions return as `problems`). */
export function zodProblems(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).slice(0, 20);
}
