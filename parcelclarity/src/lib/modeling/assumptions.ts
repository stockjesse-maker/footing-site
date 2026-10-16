import { z } from "zod";
import { normalisePackaging } from "@/engine/fees";
import type { FeeScheduleSnapshot } from "@/engine/fees/types";
import { D } from "@/engine/money";
import type { DriverQuestion } from "@/lib/fees/queries";
import { fulfillmentAnswersSchema } from "@/lib/fees/schema";
import { formatDate } from "@/lib/format/date";
import type { FulfillmentAssumptions } from "@/lib/modeling/fee-input";
import type { RunAssumptions } from "@/lib/modeling/run";

/**
 * Run assumptions (Milestone 4): the schema of everything a run is started with, a canonical form so
 * that an identical resubmission attaches to the live run instead of failing with "different
 * settings", the one-line diff shown when a run is repeated, and the pure model behind the run-setup
 * step "Fulfillment costs" (form state → answers, answers → form state, average → order content rows).
 *
 * Pure: no I/O, no framework imports. Importable from client components, server actions and tests.
 * Nothing here touches carrier buy rates or invents an amount: an answer is what the customer typed,
 * "not sure" is `null` (shown later as not included) and "we don't use this" is an explicit "0".
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const blankToNull = (v: unknown): unknown => (v === undefined || v === "" || (typeof v === "string" && v.trim() === "") ? null : v);

/**
 * The whole `assumptions` object of a bulk run. Closed (an unknown field is refused, like the
 * database does for `fulfillment`), and `fulfillment` is `fulfillmentAnswersSchema`, which mirrors
 * `app.validate_fulfillment` (the checks that need the pinned schedule are left to SQL).
 */
export const runAssumptionsSchema = z.strictObject(
  {
    residentialDefault: z.boolean().nullable().optional(),
    originZipDefault: z.preprocess(blankToNull, z.string().regex(/^\d{5}$/, "Enter a 5-digit ZIP code.").nullable()).optional(),
    overrideAllServices: z.boolean().optional(),
    fulfillment: fulfillmentAnswersSchema.nullable().optional(),
  },
  { error: "Run assumptions carry an unknown field." },
);

export type RunAssumptionsInput = z.output<typeof runAssumptionsSchema>;

/** Anything shaped like `RunAssumptions`, including the schema output and numbers where text is expected (a jsonb quirk). */
export interface FulfillmentLike {
  skip?: boolean | null;
  monthlyOrders?: string | number | null;
  drivers?: Record<string, string | number | null> | null;
  orderShares?: Record<string, { sharePct: string | number; countPerOrder: number | string } | null> | null;
  packagingDefault?: string | null;
  orderContent?: { rows: { units: number | string; lines: number | string; sharePct: string | number }[] } | null;
}

export interface AssumptionsLike {
  residentialDefault?: boolean | null;
  originZipDefault?: string | null;
  overrideAllServices?: boolean;
  fulfillment?: FulfillmentLike | null;
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** "12.0" → "12", "0.50" → "0.5", "00012" → "12"; text that is not a plain non-negative decimal is returned trimmed and untouched (validation reports it). */
export function normaliseDecimalText(value: string): string {
  const t = value.trim();
  if (!PLAIN_DECIMAL.test(t)) return t;
  const d = new D(t);
  return d.isZero() ? "0" : d.toFixed();
}

function decimalOf(v: unknown): unknown {
  if (typeof v === "string") return normaliseDecimalText(v);
  if (typeof v === "number" && Number.isFinite(v)) return normaliseDecimalText(new D(v).toFixed());
  return v;
}

function wholeOf(v: unknown): unknown {
  return typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const k of Object.keys(source).sort()) {
      if (source[k] !== undefined) out[k] = sortKeys(source[k]);
    }
    return out as T;
  }
  return value;
}

const isEmptyObject = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0;

function canonicaliseFulfillment(f: FulfillmentLike): Record<string, unknown> | undefined {
  // Skipped fulfillment costs ignore every other answer, so none are carried (a stale answer could only fail validation).
  if (f.skip === true) return { skip: true };
  const out: Record<string, unknown> = {};

  const monthly = decimalOf(f.monthlyOrders);
  if (typeof monthly === "string" && monthly !== "") out.monthlyOrders = monthly;

  if (f.drivers && typeof f.drivers === "object") {
    const drivers: Record<string, unknown> = {};
    for (const key of Object.keys(f.drivers).sort()) {
      const v = f.drivers[key];
      if (v === undefined) continue;
      // null = "not sure, leave it out": kept, it is an answer.
      drivers[key] = v === null ? null : decimalOf(v);
    }
    if (!isEmptyObject(drivers)) out.drivers = drivers;
  }

  if (f.orderShares && typeof f.orderShares === "object") {
    const shares: Record<string, unknown> = {};
    for (const key of Object.keys(f.orderShares).sort()) {
      const v = f.orderShares[key];
      if (v === undefined) continue;
      shares[key] = v === null ? null : { countPerOrder: wholeOf(v.countPerOrder), sharePct: decimalOf(v.sharePct) };
    }
    if (!isEmptyObject(shares)) out.orderShares = shares;
  }

  if (typeof f.packagingDefault === "string") {
    const packaging = normalisePackaging(f.packagingDefault);
    if (packaging !== "") out.packagingDefault = packaging;
  }

  // Row order is part of the answer: ties of the apportionment go to the earlier row, so rows are never re-sorted.
  const rows = f.orderContent?.rows;
  if (Array.isArray(rows) && rows.length > 0) {
    out.orderContent = { rows: rows.map((r) => ({ lines: wholeOf(r.lines), sharePct: decimalOf(r.sharePct), units: wholeOf(r.units) })) };
  }

  return Object.keys(out).length > 0 ? sortKeys(out) : undefined;
}

/**
 * The stable form of a run's assumptions: keys sorted, decimal strings normalised ("12.0" = "12"), null
 * driver and order-share answers kept ("not sure" is an answer), empty objects dropped, `fulfillment`
 * absent when nothing was answered. Idempotent and independent of key order. Top-level scalars that
 * are null mean "not set" inside `fulfillment` (monthly orders, packaging default, order content) and are
 * dropped; the shipping assumptions keep their explicit nulls as the run has always stored them.
 */
export function canonicaliseAssumptions(a: AssumptionsLike): RunAssumptions {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(a).sort()) {
    if (key === "fulfillment") continue;
    const v = (a as Record<string, unknown>)[key];
    if (v === undefined || isEmptyObject(v)) continue;
    out[key] = v;
  }
  const fulfillment = a.fulfillment ? canonicaliseFulfillment(a.fulfillment) : undefined;
  if (fulfillment) out.fulfillment = fulfillment;
  return sortKeys(out) as RunAssumptions;
}

// ---------------------------------------------------------------------------
// Field errors (shared by the form and the server action)
// ---------------------------------------------------------------------------
/**
 * Issues of `fulfillmentAnswersSchema` keyed by the control they belong to: "monthlyOrders",
 * "drivers.<key>", "orderShares.<key>", "packagingDefault", "orderContent.rows[.n.field]". The first
 * message overall is also stored under "fulfillment" (the step-level message).
 */
export function fulfillmentFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String);
    const [head, second] = path;
    let key: string;
    if ((head === "drivers" || head === "orderShares") && second !== undefined) key = `${head}.${second}`;
    else if (head === "orderContent") key = path.join(".");
    else key = head ?? "fulfillment";
    if (!(key in out)) out[key] = issue.message;
    if (!("fulfillment" in out)) out.fulfillment = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The server action's half: the posted field, and the database's refusals
// ---------------------------------------------------------------------------
const FULFILLMENT_UNREADABLE = "Your fulfillment answers could not be read. Reload the page and try again.";
/** The serialised answers of step 2 are a few KB at most (the database caps them at 16 KB of jsonb). */
const MAX_FULFILLMENT_FIELD = 20_000;

/**
 * The step-2 answers the form posts as one JSON field "fulfillment", parsed with the schema that mirrors
 * `app.validate_fulfillment`. A form without step 2 posts none (`value` undefined). Field errors are keyed
 * "fulfillment.<control>" ("fulfillment.drivers.<key>", "fulfillment.monthlyOrders", …); "fulfillment" is the
 * step-level message.
 */
export function parseFulfillmentField(raw: unknown): { ok: true; value: FulfillmentLike | undefined } | { ok: false; errors: Record<string, string> } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.length > MAX_FULFILLMENT_FIELD) return { ok: false, errors: { fulfillment: FULFILLMENT_UNREADABLE } };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: { fulfillment: FULFILLMENT_UNREADABLE } };
  }
  if (json === null) return { ok: true, value: undefined };
  const parsed = fulfillmentAnswersSchema.safeParse(json);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const [key, message] of Object.entries(fulfillmentFieldErrors(parsed.error))) errors[key === "fulfillment" ? key : `fulfillment.${key}`] = message;
    return { ok: false, errors };
  }
  return { ok: true, value: parsed.data };
}

/**
 * `start_simulation_run` raises SQLSTATE PC001 ("invalid input") with messages written for people. Those
 * about the fulfillment answers become errors on step 2: field-level where the message names the question
 * (the key stays in the error's key, never on screen), step-level otherwise. null = not about fulfillment.
 */
export function fulfillmentProblemFromSql(message: string): Record<string, string> | null {
  if (/no fee schedule is in effect/.test(message)) {
    return { fulfillment: "No fee schedule is in effect for this customer on the date you chose, so fulfillment answers cannot be used. Choose another date in step 1, or skip fulfillment costs." };
  }
  if (/monthly orders must be between/.test(message)) {
    const text = "Monthly orders must be between 1 and 5,000,000.";
    return { "fulfillment.monthlyOrders": text, fulfillment: text };
  }
  if (/packaging default must be/.test(message)) {
    const text = "Packaging must be up to 60 characters.";
    return { "fulfillment.packagingDefault": text, fulfillment: text };
  }
  const answer = /^answer for (\S+) (must be a number|is out of range|needs a share)/.exec(message);
  if (answer) {
    const key = answer[1]!;
    const text = answer[2] === "needs a share" ? "Enter a share of orders (0–100) and a whole count per order (1–1000)." : answer[2] === "is out of range" ? "This number is out of range." : "Enter a number (digits only, up to 4 decimals).";
    return { [`fulfillment.drivers.${key}`]: text, [`fulfillment.orderShares.${key}`]: text, fulfillment: "Check the answers marked on this step." };
  }
  if (/is not a question of this fee schedule/.test(message)) {
    return { fulfillment: "One of the answers is for a question that is not on the fee schedule used for this run (the schedule may have changed). Reload the page to see the current questions." };
  }
  if (/returns rate is a percent/.test(message)) return { fulfillment: "A returns rate is a percent of orders: enter 0 to 100." };
  const longTerm = /^long-term quantity for "(.+)" exceeds the total stored/.exec(message);
  if (longTerm) return { fulfillment: `The long-term quantity for ${longTerm[1]} cannot be more than the total stored.` };
  if (/order content/.test(message)) {
    return {
      "fulfillment.orderContent.rows": message.includes("100.00") ? "Order content shares must add up to exactly 100.00%." : "Each order content row needs whole items, order lines (1 up to the items) and a share of orders.",
      fulfillment: "Check the order content on this step.",
    };
  }
  if (/fulfillment assumptions|skip must be|drivers must be|orderShares must be/.test(message)) return { fulfillment: FULFILLMENT_UNREADABLE };
  return null;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
export interface DiffOptions {
  /** Driver key → the question's label, so a line reads "pallets stored 12 → 15", never a key. */
  labels?: Record<string, string>;
}

function groupDigits(text: string): string {
  const [int = "0", frac] = text.split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

const isZeroText = (v: string): boolean => PLAIN_DECIMAL.test(v) && new D(v).isZero();

function answerText(v: string | null | undefined): string {
  if (v === undefined || v === null) return "left out";
  return isZeroText(v) ? "none" : groupDigits(v);
}

function shareText(v: { sharePct: string; countPerOrder: number } | null | undefined): string {
  if (!v) return "left out";
  if (isZeroText(v.sharePct)) return "none";
  return `${groupDigits(v.sharePct)}% of orders × ${v.countPerOrder}`;
}

/** Lower-case the first letter of a label unless it starts an acronym ("Pallets stored" → "pallets stored", "SKUs stored" stays). */
function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

const humanise = (key: string): string => key.replace(/[_-]+/g, " ").trim();

export function describeContentRows(rows: { units: number; lines: number; sharePct: string }[] | undefined): string {
  if (!rows || rows.length === 0) return "not described";
  return rows.map((r) => `${groupDigits(r.sharePct)}% ${r.units} ${r.units === 1 ? "item" : "items"} on ${r.lines} ${r.lines === 1 ? "line" : "lines"}`).join(", ");
}

const residentialText = (v: boolean | null | undefined): string => (v === true ? "home deliveries" : v === false ? "business deliveries" : "not set");

/**
 * What changed between two sets of assumptions, as short fragments for "Changed: …" above the
 * button that repeats a run. Both sides are canonicalised first, so "12.0" against "12" is no change,
 * and an unanswered question against "not sure" is no change either (neither is included). When
 * either side skips fulfillment costs only that switch is reported: the answers behind it do not apply.
 */
export function diffAssumptions(a: AssumptionsLike | null | undefined, b: AssumptionsLike | null | undefined, opts: DiffOptions = {}): string[] {
  const pa = canonicaliseAssumptions(a ?? {});
  const pb = canonicaliseAssumptions(b ?? {});
  const fa = pa.fulfillment ?? null;
  const fb = pb.fulfillment ?? null;
  const labelOf = (key: string) => lowerFirst(opts.labels?.[key] ?? humanise(key));
  const lines: string[] = [];

  const skipA = fa?.skip === true;
  const skipB = fb?.skip === true;
  if (skipA !== skipB) {
    lines.push(`fulfillment costs ${skipA ? "skipped" : "included"} → ${skipB ? "skipped" : "included"}`);
  } else if (!skipA) {
    const da = fa?.drivers ?? {};
    const db = fb?.drivers ?? {};
    for (const key of [...new Set([...Object.keys(da), ...Object.keys(db)])].sort()) {
      const x = da[key] ?? null;
      const y = db[key] ?? null;
      if (x !== y) lines.push(`${labelOf(key)} ${answerText(x)} → ${answerText(y)}`);
    }
    const sa = fa?.orderShares ?? {};
    const sb = fb?.orderShares ?? {};
    const shareId = (v: { sharePct: string; countPerOrder: number } | null | undefined) => (!v ? "-" : isZeroText(v.sharePct) ? "0" : `${v.sharePct}|${v.countPerOrder}`);
    for (const key of [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort()) {
      const x = sa[key] ?? null;
      const y = sb[key] ?? null;
      if (shareId(x) !== shareId(y)) lines.push(`${labelOf(key)} ${shareText(x)} → ${shareText(y)}`);
    }
    const volA = fa?.monthlyOrders ?? null;
    const volB = fb?.monthlyOrders ?? null;
    if (volA !== volB) lines.push(`volume ${volA === null ? "from your file" : groupDigits(volA)} → ${volB === null ? "from your file" : groupDigits(volB)}`);
    const packA = fa?.packagingDefault ?? null;
    const packB = fb?.packagingDefault ?? null;
    if (packA !== packB) lines.push(`default packaging ${packA ?? "left out"} → ${packB ?? "left out"}`);
    const rowsA = fa?.orderContent?.rows;
    const rowsB = fb?.orderContent?.rows;
    if (JSON.stringify(rowsA ?? null) !== JSON.stringify(rowsB ?? null)) lines.push(`order content ${describeContentRows(rowsA)} → ${describeContentRows(rowsB)}`);
  }

  if ((pa.residentialDefault ?? null) !== (pb.residentialDefault ?? null)) lines.push(`delivery type ${residentialText(pa.residentialDefault)} → ${residentialText(pb.residentialDefault)}`);
  if ((pa.originZipDefault ?? null) !== (pb.originZipDefault ?? null)) lines.push(`ship-from ZIP ${pa.originZipDefault ?? "none"} → ${pb.originZipDefault ?? "none"}`);
  if ((pa.overrideAllServices ?? false) !== (pb.overrideAllServices ?? false)) lines.push(`every shipment on one service ${pa.overrideAllServices ? "on" : "off"} → ${pb.overrideAllServices ? "on" : "off"}`);
  return lines;
}

/** "Changed: pallets stored 12 → 15; volume 1,250 → 1,400", or the sentence for no change. */
export function formatAssumptionDiff(lines: string[]): string {
  return lines.length > 0 ? `Changed: ${lines.join("; ")}` : "No changes from the last run.";
}

// ---------------------------------------------------------------------------
// Run setup data (loaded on the server, rendered by the form)
// ---------------------------------------------------------------------------
/** `dataset_forecast_period` (design §5), as far as the form needs it. */
export interface RunSetupPeriod {
  population: number;
  dated: number;
  undated: number;
  from: string | null;
  to: string | null;
  days: number | null;
  /** Calendar months covered, as the database computed them (decimal text, 6 dp). */
  months: string | null;
  /** Dated orders inside the period: the orders the file volume is counted over. */
  inPeriod: number;
  /** Dated orders left out of the period because their date is an outlier. */
  trimmed: number;
}

export type RunSetupSchedule =
  | { status: "none" }
  | { status: "unavailable" }
  | { status: "not_effective"; name: string }
  | {
      status: "ok";
      name: string;
      effectiveDate: string;
      questions: DriverQuestion[];
      /** Normalised packaging types the schedule prices (catch-alls excluded). */
      packagingTypes: string[];
      /** True when a rule reads units, lines or products per order (so describing typical orders matters). */
      readsOrderContent: boolean;
    };

export interface RunSetupData {
  period: RunSetupPeriod | null;
  schedule: RunSetupSchedule;
  /** The file carries item counts / line data (from the dataset's validation counts). */
  hasUnits: boolean;
  hasLines: boolean;
  /** At least one package has no packaging type. */
  untypedPackages: boolean;
}

/** True when any order-scope rule reads the units, lines or distinct products of an order. */
export function scheduleReadsOrderContent(snapshot: Pick<FeeScheduleSnapshot, "rules">): boolean {
  return snapshot.rules.some((r) => {
    if (r.scope !== "order") return false;
    if (r.basis === "unit" || r.basis === "line" || r.basis === "sku") return true;
    const c = r.conditions;
    if (c && (c.minUnits !== undefined || c.maxUnits !== undefined || c.minLines !== undefined || c.maxLines !== undefined)) return true;
    return r.includedPer === "line" || r.includedPer === "sku";
  });
}

export type VolumeUnavailableReason = "unreadable" | "no_dates" | "short";

export type PeriodVolume = { ok: true; monthlyOrders: string } | { ok: false; reason: VolumeUnavailableReason };

/** The monthly volume the database will use when the customer does not state one (round(inPeriod / months, 4)). */
export function derivePeriodVolume(period: RunSetupPeriod | null): PeriodVolume {
  if (!period) return { ok: false, reason: "unreadable" };
  if (!period.from || !period.to || !period.months || period.inPeriod <= 0 || period.days === null || !new D(period.months).gt(0)) return { ok: false, reason: "no_dates" };
  if (period.days < 28) return { ok: false, reason: "short" };
  return { ok: true, monthlyOrders: new D(period.inPeriod).div(new D(period.months)).toDecimalPlaces(4, D.ROUND_HALF_UP).toFixed() };
}

/** "1,318" from 1318.4; "12.5" from 12.45 (a rounded figure for "about V orders a month"; the exact value is what the run uses). */
export function formatVolume(monthlyOrders: string): string {
  const d = new D(monthlyOrders);
  return groupDigits(d.toDecimalPlaces(d.gte(100) ? 0 : 1, D.ROUND_HALF_UP).toFixed());
}

export function formatMonths(months: string): string {
  const text = new D(months).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed();
  return `${text} ${text === "1" ? "month" : "months"}`;
}

export const formatCount = (n: number): string => groupDigits(String(n));

/**
 * The derivation shown above the volume choice: "Your file has N orders over <from>–<to> (M months):
 * about V orders a month", with the trimmed and undated counts when they are not zero. When no volume
 * can be derived, the sentence says why and the customer states one.
 */
export function describePeriodVolume(period: RunSetupPeriod | null): { sentence: string; notes: string[]; volume: PeriodVolume } {
  const volume = derivePeriodVolume(period);
  const notes: string[] = [];
  if (period && period.trimmed > 0) notes.push(`${formatCount(period.trimmed)} ${period.trimmed === 1 ? "order has a date" : "orders have dates"} far outside the rest and ${period.trimmed === 1 ? "is" : "are"} left out of the period, so one stray date cannot stretch it.`);
  if (period && period.undated > 0) notes.push(`${formatCount(period.undated)} ${period.undated === 1 ? "order has" : "orders have"} no date and ${period.undated === 1 ? "is" : "are"} not counted in the volume.`);
  if (volume.ok && period) {
    const range = `${formatDate(period.from!)}–${formatDate(period.to!)}`;
    return {
      sentence: `Your file has ${formatCount(period.inPeriod)} ${period.inPeriod === 1 ? "order" : "orders"} over ${range} (${formatMonths(period.months!)}): about ${formatVolume(volume.monthlyOrders)} orders a month.`,
      notes,
      volume,
    };
  }
  const reason = !volume.ok ? volume.reason : "unreadable";
  const sentence =
    reason === "short" && period
      ? `Your file covers only ${formatCount(period.days ?? 0)} ${period.days === 1 ? "day" : "days"} (${formatDate(period.from!)}–${formatDate(period.to!)}), too short to turn into a monthly volume. State your usual number of orders a month to see monthly charges per order.`
      : reason === "no_dates"
        ? "No order in your file has a usable date, so a monthly volume cannot be worked out from it. State your usual number of orders a month to see monthly charges per order."
        : "The dates in your file could not be read just now. State your usual number of orders a month to see monthly charges per order.";
  return { sentence, notes, volume };
}

// ---------------------------------------------------------------------------
// Order content: an average becomes the exact rows
// ---------------------------------------------------------------------------
export interface ContentRow {
  units: number;
  lines: number;
  sharePct: string;
}

/**
 * Turns "an average of U items on L lines per order" into order-content rows that reproduce both
 * averages exactly and never have more lines than items: items take the two whole numbers around U
 * (floor and ceiling) in the proportion that gives U, lines do the same around L, and the two splits
 * are coupled so the larger orders have the larger line counts (the same quantile for both). The
 * result is two rows whenever the fractions agree or either average is a whole number, three
 * otherwise; it is never an approximation. Averages have at most 4 decimals (shares have 2 on a percent).
 */
export function averageToContentRows(averageUnits: string, averageLines: string): { ok: true; rows: ContentRow[] } | { ok: false; error: string } {
  const re = /^[0-9]{1,5}(\.[0-9]{1,4})?$/;
  const u = averageUnits.trim();
  const l = averageLines.trim();
  if (!re.test(u)) return { ok: false, error: "Enter the average number of items per order (up to 4 decimals)." };
  if (!re.test(l)) return { ok: false, error: "Enter the average number of order lines per order (up to 4 decimals)." };
  const unitsAvg = new D(u);
  const linesAvg = new D(l);
  if (unitsAvg.lt(1)) return { ok: false, error: "An order has at least 1 item on average." };
  if (linesAvg.lt(1)) return { ok: false, error: "An order has at least 1 order line on average." };
  if (linesAvg.gt(unitsAvg)) return { ok: false, error: "An order cannot have more lines than items: the average lines must not be more than the average items." };

  // Exact integers: tenths of a basis point are never needed because averages carry at most 4 decimals.
  const u4 = unitsAvg.times(10000).toNumber();
  const l4 = linesAvg.times(10000).toNumber();
  const unitsFloor = Math.floor(u4 / 10000);
  const linesFloor = Math.floor(l4 / 10000);
  const unitsHigh = u4 % 10000; // share of orders (in 1/10000) that take the next whole number of items
  const linesHigh = l4 % 10000;
  const cuts = [...new Set([0, 10000 - unitsHigh, 10000 - linesHigh, 10000])].sort((x, y) => x - y);
  const rows: ContentRow[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const lo = cuts[i - 1]!;
    const hi = cuts[i]!;
    rows.push({
      units: unitsFloor + (hi > 10000 - unitsHigh ? 1 : 0),
      lines: linesFloor + (hi > 10000 - linesHigh ? 1 : 0),
      sharePct: new D(hi - lo).div(100).toFixed(2),
    });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Form state of step 2 "Fulfillment costs"
// ---------------------------------------------------------------------------
export type AnswerChoice = "number" | "unsure" | "none";

export interface QuantityAnswerState {
  /** null = not answered yet: the step cannot be submitted until every question has a choice. */
  choice: AnswerChoice | null;
  value: string;
}

export interface ShareAnswerState {
  choice: AnswerChoice | null;
  sharePct: string;
  count: string;
}

export interface ContentRowState {
  units: string;
  lines: string;
  sharePct: string;
}

export type ContentMode = "none" | "rows" | "average";

export interface FulfillmentFormState {
  skip: boolean;
  volumeMode: "file" | "stated";
  volume: string;
  /** Monthly quantities and returns rates, by driver key. */
  drivers: Record<string, QuantityAnswerState>;
  /** Order-share drivers, by driver key. */
  shares: Record<string, ShareAnswerState>;
  /** Normalised packaging type, "" = not sure. */
  packagingDefault: string;
  contentMode: ContentMode;
  contentRows: ContentRowState[];
  averageUnits: string;
  averageLines: string;
}

export type FormQuestion = Pick<DriverQuestion, "key" | "label" | "unit" | "kind" | "answers" | "longTerm">;

export interface FulfillmentFormContext {
  questions: FormQuestion[];
  /** False when the file's volume cannot be derived (under 28 days or no dated orders): the customer states it. */
  canDeriveVolume: boolean;
  showPackaging: boolean;
  showContent: boolean;
}

/** A blank row for the order-content editor. */
export const newContentRow = (): ContentRowState => ({ units: "", lines: "", sharePct: "" });

export const CHOOSE_MESSAGE = "Choose one: enter a number, Not sure (leave it out), or We don't use this.";

/** The state the step opens with: every answer of the previous run when there is one, otherwise nothing chosen. */
export function initialFulfillmentState(ctx: FulfillmentFormContext, prev: FulfillmentAssumptions | null | undefined): FulfillmentFormState {
  const prevDrivers = prev?.drivers ?? {};
  const prevShares = prev?.orderShares ?? {};
  const drivers: Record<string, QuantityAnswerState> = {};
  const shares: Record<string, ShareAnswerState> = {};
  for (const q of ctx.questions) {
    if (q.answers === "orderShares") {
      const v = prevShares[q.key];
      shares[q.key] = v === undefined ? { choice: null, sharePct: "", count: "" } : v === null ? { choice: "unsure", sharePct: "", count: "" } : isZeroText(v.sharePct) ? { choice: "none", sharePct: "", count: "" } : { choice: "number", sharePct: v.sharePct, count: String(v.countPerOrder) };
    } else {
      const v = prevDrivers[q.key];
      drivers[q.key] = v === undefined ? { choice: null, value: "" } : v === null ? { choice: "unsure", value: "" } : isZeroText(v) ? { choice: "none", value: "" } : { choice: "number", value: v };
    }
  }
  const rows = prev?.orderContent?.rows;
  const stated = prev?.monthlyOrders ?? null;
  return {
    skip: prev?.skip === true,
    volumeMode: !ctx.canDeriveVolume || stated !== null ? "stated" : "file",
    volume: stated ?? "",
    drivers,
    shares,
    packagingDefault: prev?.packagingDefault ?? "",
    contentMode: rows && rows.length > 0 ? "rows" : "none",
    contentRows: rows && rows.length > 0 ? rows.map((r) => ({ units: String(r.units), lines: String(r.lines), sharePct: r.sharePct })) : [{ units: "", lines: "", sharePct: "100.00" }],
    averageUnits: "",
    averageLines: "",
  };
}

export interface BuiltFulfillment {
  /** The canonical answers to post as `assumptions.fulfillment` (`{}` while there are errors). */
  value: FulfillmentAssumptions;
  /** Keys as in `fulfillmentFieldErrors`, plus "orderContent.average" and "monthlyOrders". Empty = ready to submit. */
  errors: Record<string, string>;
}

/**
 * Form state → answers. A question needs a choice; a chosen number must be filled in. Numbers are
 * validated with `fulfillmentAnswersSchema` (the database's rules), plus the two checks that need a
 * question rather than a schema: a returns rate is at most 100, a long-term quantity that replaces
 * part of the stored quantity cannot exceed it.
 */
export function fulfillmentFromState(state: FulfillmentFormState, ctx: FulfillmentFormContext): BuiltFulfillment {
  if (state.skip) return { value: { skip: true }, errors: {} };
  const errors: Record<string, string> = {};
  const candidate: Record<string, unknown> = {};

  const volume = state.volume.trim();
  const stated = ctx.canDeriveVolume ? state.volumeMode === "stated" : true;
  if (stated) {
    if (volume !== "") candidate.monthlyOrders = volume;
    else if (ctx.canDeriveVolume) errors.monthlyOrders = "Enter the number of orders a month, or choose Use this volume.";
  }

  const drivers: Record<string, string | null> = {};
  const shares: Record<string, { sharePct: string; countPerOrder: string } | null> = {};
  for (const q of ctx.questions) {
    if (q.answers === "orderShares") {
      const s = state.shares[q.key] ?? { choice: null, sharePct: "", count: "" };
      if (s.choice === null) errors[`orderShares.${q.key}`] = CHOOSE_MESSAGE;
      else if (s.choice === "unsure") shares[q.key] = null;
      else if (s.choice === "none") shares[q.key] = { sharePct: "0", countPerOrder: "1" };
      else if (s.sharePct.trim() === "" || s.count.trim() === "") errors[`orderShares.${q.key}`] = "Enter the share of orders and how many each of them gets, or choose one of the other answers.";
      else shares[q.key] = { sharePct: s.sharePct.trim(), countPerOrder: s.count.trim() };
    } else {
      const d = state.drivers[q.key] ?? { choice: null, value: "" };
      if (d.choice === null) errors[`drivers.${q.key}`] = CHOOSE_MESSAGE;
      else if (d.choice === "unsure") drivers[q.key] = null;
      else if (d.choice === "none") drivers[q.key] = "0";
      else if (d.value.trim() === "") errors[`drivers.${q.key}`] = "Enter a number, or choose one of the other answers.";
      else drivers[q.key] = d.value.trim();
    }
  }
  if (Object.keys(drivers).length > 0) candidate.drivers = drivers;
  if (Object.keys(shares).length > 0) candidate.orderShares = shares;

  if (ctx.showPackaging && state.packagingDefault !== "") candidate.packagingDefault = state.packagingDefault;

  if (ctx.showContent && state.contentMode === "rows") {
    candidate.orderContent = { rows: state.contentRows.map((r) => ({ units: r.units.trim(), lines: r.lines.trim(), sharePct: r.sharePct.trim() })) };
  } else if (ctx.showContent && state.contentMode === "average") {
    const average = averageToContentRows(state.averageUnits, state.averageLines);
    if (average.ok) candidate.orderContent = { rows: average.rows };
    else errors["orderContent.average"] = average.error;
  }

  const parsed = fulfillmentAnswersSchema.safeParse(candidate);
  if (!parsed.success) {
    const found = fulfillmentFieldErrors(parsed.error);
    for (const [key, message] of Object.entries(found)) if (key !== "fulfillment" && !(key in errors)) errors[key] = message;
    // An issue that belongs to no control (too large, unknown field) still blocks, with the step-level message.
    if (Object.keys(errors).length === 0 && found.fulfillment) errors.fulfillment = found.fulfillment;
  }

  // Checks that need the question, not only the schema.
  for (const q of ctx.questions) {
    const answer = drivers[q.key];
    if (typeof answer !== "string" || !PLAIN_DECIMAL.test(answer) || `drivers.${q.key}` in errors) continue;
    if (q.kind === "returns_rate" && new D(answer).gt(100)) errors[`drivers.${q.key}`] = "A returns rate is a percent of orders: enter 0 to 100.";
    const lt = q.longTerm;
    if (lt && lt.mode === "replace" && lt.partOf) {
      const stored = drivers[lt.partOf.key];
      if (typeof stored === "string" && PLAIN_DECIMAL.test(stored) && new D(answer).gt(stored)) errors[`drivers.${q.key}`] = `This cannot be more than the total you entered for ${lowerFirst(lt.partOf.label)} (${groupDigits(normaliseDecimalText(stored))}).`;
    }
  }

  if (Object.keys(errors).length > 0 || !parsed.success) return { value: {}, errors };
  return { value: canonicaliseAssumptions({ fulfillment: parsed.data }).fulfillment ?? {}, errors };
}
