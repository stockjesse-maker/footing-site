import { allInAtVolumes } from "@/engine/forecast";
import type { ForecastProfile, ForecastSummary } from "@/engine/forecast/types";
import type { AllocationResult, FeeCategory, MinimumResult, MinimumStatus, MonthlyFeeResult } from "@/engine/fees/types";
import type { BulkSummary, CategoryCompleteness, FeeStatus, RunPeriod } from "@/engine/modeling/types";
import { D, type Dec } from "@/engine/money";
import { formatDate } from "@/lib/format/date";
import { formatMonths, formatVolume } from "@/lib/modeling/assumptions";

/**
 * The one place that decides what a fee-aware run's headline says (design section 6 and the F1 rule of
 * section 10). The run page, the model hub, the overview, the scenario list, compare and the CSV header
 * all read it, so a figure never carries a different label on two screens.
 *
 * Pure: no I/O, no framework imports. Every amount comes from the stored summary (a `BulkSummary` of a
 * file run or a `ForecastSummary` of a forecast from assumptions); this module only chooses which
 * stored figure to show, how to label it, and what must be said next to it. The only arithmetic is the
 * handful of documented helpers (volume sensitivity, the monthly-charges split, per-order rows) and each
 * rounds HALF_UP to cents once from exact amounts.
 *
 * Hard rules honoured here: an unknown, un-assumed quantity is never shown as $0 (it is `null` with a
 * reason); a figure that leaves something out says "At least" and names what; nothing here prints a rule
 * key, an id or a version number; monthly charges are never presented as per-order fees.
 */

export type HeadlineSummary = BulkSummary | ForecastSummary;
export type HeadlineView = "shipping" | "fees" | "allin";
export type HeadlineAudience = "brand" | "staff";

export const HEADLINE_VIEWS: readonly HeadlineView[] = ["shipping", "fees", "allin"];
export const VIEW_LABEL: Record<HeadlineView, string> = { shipping: "Shipping", fees: "Order fees", allin: "All-in" };

/** The sentence under the view control: what each choice contains. */
export const VIEW_SENTENCE =
  "Shipping is the carrier cost only. Order fees add the charges that depend on each order (pick, pack, packaging). All-in also adds monthly charges such as storage and account fees, spread over your orders a month.";

export function isForecastSummary(summary: HeadlineSummary): summary is ForecastSummary {
  return (summary as ForecastSummary).basis === "assumptions";
}

/** `?view=` value to a view; null when absent or unknown (the page then picks the default). */
export function parseView(raw: string | null | undefined): HeadlineView | null {
  return raw === "shipping" || raw === "fees" || raw === "allin" ? raw : null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
/** HALF_UP to cents, once. "12.3450" becomes "12.35". */
export function toCents(value: string): string {
  return new D(value).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "$1,234.50" from a decimal string (rounded to cents first); "—" for null. Never prints a missing amount as $0. */
export function usd(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const rounded = toCents(value);
  const negative = rounded.startsWith("-");
  const [int = "0", frac = "00"] = rounded.replace(/^-/, "").split(".");
  return `${negative ? "−" : ""}$${group(int)}.${frac}`;
}

/** Exact E4 (ten-thousandths of a dollar) as a decimal. */
const fromE4 = (e4: number): Dec => new D(e4).div(10000);
const centsOf = (value: Dec): string => value.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
/** A rate with at least two decimals and at most four: 18 → "18.00", 0.0125 → "0.0125". */
function rateText(e4: number): string {
  const text = fromE4(e4).toFixed(4);
  return text.replace(/(\.\d\d)(\d*?)0*$/, (_m, two: string, rest: string) => `${two}${rest}`);
}

const n = (value: number): string => value.toLocaleString("en-US");
const plural = (count: number, one: string, many = `${one}s`): string => `${n(count)} ${count === 1 ? one : many}`;

export function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const capitalise = (text: string): string => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text);

const CATEGORY_NAME: Record<FeeCategory, string> = {
  pick_pack: "pick and pack",
  packaging: "packaging",
  kitting: "kitting & assembly",
  labeling: "labeling",
  receiving: "receiving",
  storage: "storage",
  returns: "returns",
  account: "account fees",
  other: "other fees",
};

/** A category in the customer's words, lower case ("storage", "kitting & assembly"). */
export function categoryName(category: FeeCategory): string {
  return CATEGORY_NAME[category];
}

const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
/** "2026-03" becomes "Mar 2026"; "average" is the forecast's one synthetic month. */
export function monthLabel(month: string): string {
  if (month === "average") return "A typical month";
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? monthFmt.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))) : month;
}

// ---------------------------------------------------------------------------
// Reasons in the customer's words
// ---------------------------------------------------------------------------
/** Reasons for which entering numbers in the run setup step can fix the gap. */
const ADDABLE_REASONS = new Set(["no_answer", "volume_unknown", "replaced_rule_missing", "assumption_missing", "units_unknown", "lines_unknown", "skus_unknown", "packaging_unknown", "no_content", "skipped"]);

const REASON_TEXT: Record<string, string> = {
  no_answer: "no number was given",
  volume_unknown: "it needs your monthly order volume",
  replaced_rule_missing: "it depends on a number that was left out",
  assumption_missing: "no answer was given",
  units_unknown: "the file has no item counts",
  lines_unknown: "the file has no line data",
  skus_unknown: "the file has no product (SKU) data",
  packaging_unknown: "the orders have no packaging type",
  packaging_unmatched: "no charge on the fee schedule covers the packaging type",
  shipping_unknown: "shipping could not be priced for those orders",
  no_content: "there is no order content to price from",
  not_effective: "no fee schedule was in effect on the order date",
  date_missing: "the order has no date",
  no_schedule: "there is no fee schedule",
  skipped: "fulfillment costs were skipped",
};

export function reasonText(reason: string | null | undefined): string {
  return (reason && REASON_TEXT[reason]) || "it could not be computed";
}

export function isAddableReason(reason: string | null | undefined): boolean {
  return !!reason && ADDABLE_REASONS.has(reason);
}

/** Why orders have no fee figure: [singular, plural] verb phrases per unpriced status. */
const STATUS_NOT_PRICED: Partial<Record<FeeStatus, [string, string]>> = {
  no_content: ["has no item counts or order content to price fees from", "have no item counts or order content to price fees from"],
  no_schedule: ["had no fee schedule", "had no fee schedule"],
  not_effective: ["was dated outside the fee schedule's dates", "were dated outside the fee schedule's dates"],
  date_missing: ["has no date, so the fee schedule in effect could not be picked", "have no date, so the fee schedule in effect could not be picked"],
  skipped: ["was priced for shipping only", "were priced for shipping only"],
};

/** "3 orders were dated outside the fee schedule's dates" style sentences for every unpriced status. */
export function feeStatusSentences(statusCounts: Partial<Record<FeeStatus, number>>): string[] {
  const out: string[] = [];
  for (const status of ["no_content", "not_effective", "date_missing", "no_schedule", "skipped"] as const) {
    const count = statusCounts[status] ?? 0;
    const phrase = STATUS_NOT_PRICED[status];
    if (count > 0 && phrase) out.push(`${plural(count, "order")} ${count === 1 ? phrase[0] : phrase[1]}.`);
  }
  return out;
}

/** Engine minimum reasons ("Storage not modeled", "coverage 60.0% in 2026-03", "1 order without a date") in plain words. */
export function describeMinimumReason(reason: string): string {
  const coverage = /^coverage ([0-9.]+)% in (\d{4}-\d{2})$/.exec(reason);
  if (coverage) return `only ${coverage[1]}% of the orders shipped in ${monthLabel(coverage[2]!)} could be priced`;
  const undated = /^(\d+) orders? without a date$/.exec(reason);
  if (undated) {
    const count = Number(undated[1]);
    return `${plural(count, "order")} ${count === 1 ? "has" : "have"} no date`;
  }
  const notModeled = /^(.+) not modeled$/.exec(reason);
  if (notModeled) return `${notModeled[1]} is not modeled`;
  return "something it counts could not be worked out";
}

// ---------------------------------------------------------------------------
// One shape over file runs and forecasts
// ---------------------------------------------------------------------------
interface Basis {
  source: "file" | "assumptions";
  feeMode: "modeled" | "skipped" | "no_schedule";
  shippingPerOrder: string | null;
  processingPerOrder: string | null;
  processingOrders: number;
  modeledOrders: number;
  importedOrders: number;
  ordersPct: string | null;
  completeness: CategoryCompleteness[];
  minimums: Array<MinimumResult & { includesShipping?: boolean }>;
  minimumStatus: MinimumStatus | "none";
  allocation: AllocationResult | null;
  monthly: MonthlyFeeResult | null;
  /** Months the period covers (decimal text); "1" for a forecast, whose monthly figures are already per month. */
  months: string;
  monthlyOrders: string | null;
  period: RunPeriod | null;
  statusCounts: Partial<Record<FeeStatus, number>>;
  assumed: { units: number; lines: number; skus: number; packaging: number } | null;
  warnings: { code: string; orders: number }[];
  priceOnlyCovered: boolean;
}

function basisOf(summary: HeadlineSummary): Basis {
  if (isForecastSummary(summary)) {
    return {
      source: "assumptions",
      feeMode: summary.feeMode,
      shippingPerOrder: summary.shipping.perOrder,
      processingPerOrder: summary.processing?.perOrder ?? null,
      processingOrders: 0,
      modeledOrders: 0,
      importedOrders: 0,
      ordersPct: null,
      completeness: summary.completeness,
      minimums: summary.minimums,
      minimumStatus: summary.minimumStatus,
      allocation: summary.allocation,
      monthly: summary.monthly,
      months: "1",
      monthlyOrders: summary.monthlyOrders,
      period: null,
      statusCounts: {},
      assumed: null,
      warnings: [],
      priceOnlyCovered: summary.priceOnlyCovered,
    };
  }
  return {
    source: "file",
    feeMode: summary.fees.mode,
    shippingPerOrder: summary.averages.expectedPerOrder,
    processingPerOrder: summary.fees.processing.perOrder,
    processingOrders: summary.fees.processing.orders,
    modeledOrders: summary.modeled.orders,
    importedOrders: summary.imported.orders,
    ordersPct: summary.coverage.ordersPct,
    completeness: summary.fees.completeness,
    minimums: summary.minimums,
    minimumStatus: summary.minimumStatus,
    allocation: summary.allocation,
    monthly: summary.monthly,
    months: summary.period.months ?? "1",
    monthlyOrders: summary.period.monthlyOrders,
    period: summary.period,
    statusCounts: summary.fees.statusCounts,
    assumed: summary.fees.assumed,
    warnings: summary.fees.warnings,
    priceOnlyCovered: false,
  };
}

const monthsOf = (b: Basis): Dec => {
  const months = new D(b.months);
  return months.gt(0) ? months : new D(1);
};

/** The fee schedule says nothing: skipped, no schedule, or no version covered any date of the run. */
function feesUnavailable(b: Basis): string | null {
  if (b.feeMode === "skipped") return "Fulfillment costs were skipped for this model, so only shipping is shown.";
  if (b.feeMode === "no_schedule" || b.completeness.every((c) => c.state === "not_in_schedule")) return "No fee schedule was in effect for this model, so only shipping is shown.";
  return null;
}

/** Why no order was priced with fees, from the status that kept the most orders out. */
function noProcessingReason(b: Basis): string {
  const entries = Object.entries(b.statusCounts)
    .filter(([status, count]) => status !== "ok" && status !== "partial" && (count ?? 0) > 0)
    .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0) || (x[0] < y[0] ? -1 : 1));
  const top = entries[0]?.[0] as FeeStatus | undefined;
  return top ? `No order could be priced with fees: ${reasonText(top)}.` : "No order could be priced with fees.";
}

// ---------------------------------------------------------------------------
// Basis sentences
// ---------------------------------------------------------------------------
/** The period and volume every allocated monthly figure prints: "N orders a month over <from>–<to> (M months)". */
export function allocationBasisSentence(summary: HeadlineSummary): string {
  return allocationBasisOf(basisOf(summary));
}

function allocationBasisOf(b: Basis): string {
  const volume = b.monthlyOrders;
  if (volume === null || new D(volume).lte(0)) {
    return volume === null ? "No monthly volume is known, so monthly charges are not spread over your orders." : "Your monthly order volume is 0, so monthly charges are not spread over orders.";
  }
  if (b.source === "assumptions") return `${formatVolume(volume)} orders a month, as described in the forecast`;
  const p = b.period;
  const range = p?.from && p.to && p.months ? `${formatDate(p.from)}–${formatDate(p.to)} (${formatMonths(p.months)})` : null;
  if (p?.volumeBasis === "stated") return range ? `${formatVolume(volume)} orders a month, the volume you stated (your file covers ${range})` : `${formatVolume(volume)} orders a month, the volume you stated`;
  return range ? `${formatVolume(volume)} orders a month over ${range}` : `${formatVolume(volume)} orders a month`;
}

function shippingBasisSentence(b: Basis): string {
  if (b.source === "assumptions") return b.monthlyOrders ? `Forecast at ${formatVolume(b.monthlyOrders)} orders a month` : "Forecast from assumptions";
  return `Based on ${n(b.modeledOrders)} of ${n(b.importedOrders)} orders (${b.ordersPct ?? "0.0"}%)`;
}

// ---------------------------------------------------------------------------
// Headline figures
// ---------------------------------------------------------------------------
export interface HeadlineProvenance {
  /** Where numbers are added (the run page's "run again" step); null or absent when the viewer cannot rerun. */
  addHref?: string | null;
}

export interface NotIncludedItem {
  name: string;
  category: FeeCategory;
  /** The rate in the customer's words ("$15.00 per pallet per month."). */
  rate: string;
  /** Why it is left out, in words ("no number was given"). */
  reason: string;
  addHref?: string;
}

export interface HeadlinePart {
  label: string;
  /** Per order, cents; null = not computed. */
  amount: string | null;
  note: string | null;
}

export interface HeadlineFigures {
  view: HeadlineView;
  label: string;
  /** Per order, cents; null when it cannot be computed (never $0). */
  amount: string | null;
  qualifier: "" | "At least";
  /** True when nothing the schedule prices is left out and the figure is exact: the label is the plain one. */
  complete: boolean;
  /** Why `amount` is null, when it is. */
  unavailable: string | null;
  /** Fees left out because no numbers were given, each with its rate and (when the viewer can rerun) an Add link. */
  notIncluded: NotIncludedItem[];
  basisSentence: string;
  /** Fee-related caveats (shipping caveats stay with the shipping card). */
  caveats: string[];
  /** F1: an account minimum that could not be worked out exactly. `perMonth` is null when no figure can be given. */
  minimumCouldAdd: { perMonth: string | null; perOrder: string | null; sentence: string } | null;
  /** The all-in split per order: shipping, order fees, monthly charges spread over orders. */
  parts: HeadlinePart[];
}

function missingCategories(b: Basis, scope: "order" | "all"): CategoryCompleteness[] {
  return b.completeness.filter((c) => c.state === "not_modeled" && (scope === "all" || c.rules.some((r) => r.scope === "order" && r.state === "not_modeled")));
}

function notIncludedItems(b: Basis, scope: "order" | "all", addHref: string | undefined): NotIncludedItem[] {
  const items: NotIncludedItem[] = [];
  for (const category of b.completeness) {
    for (const rule of category.rules) {
      if (rule.state !== "not_modeled" || (scope === "order" && rule.scope !== "order") || !isAddableReason(rule.reason)) continue;
      items.push({ name: rule.name, category: category.category, rate: rule.describe, reason: reasonText(rule.reason), ...(addHref ? { addHref } : {}) });
    }
  }
  return items;
}

function minimumCouldAddOf(b: Basis): HeadlineFigures["minimumCouldAdd"] {
  if (b.minimumStatus === "not_computed") {
    return { perMonth: null, perOrder: null, sentence: "Your fee schedule has an account minimum that could not be worked out because no order in the file has a date. It is not included." };
  }
  if (b.minimumStatus !== "upper_bound") return null;
  const totalE4 = b.minimums.reduce((sum, m) => sum + m.topUpE4, 0);
  const perMonthExact = fromE4(totalE4).div(monthsOf(b));
  const perMonth = centsOf(perMonthExact);
  const volume = b.monthlyOrders === null ? null : new D(b.monthlyOrders);
  const perOrder = volume && volume.gt(0) ? centsOf(perMonthExact.div(volume)) : null;
  const reasons = [...new Set(b.minimums.flatMap((m) => m.reasons).map(describeMinimumReason))];
  const because = reasons.length ? ` It could not be worked out exactly: ${joinWords(reasons)}.` : "";
  return {
    perMonth,
    perOrder,
    sentence: `The account minimum could add up to ${usd(perMonth)} a month${perOrder ? ` (about ${usd(perOrder)} per order)` : ""} on top of this.${because}`,
  };
}

function feeCaveats(b: Basis, view: HeadlineView): string[] {
  const out: string[] = [];
  if (b.source === "assumptions") {
    out.push("A forecast from your assumptions: expected values over the mix described, not a prediction for any month and not an invoice.");
    if (b.priceOnlyCovered) out.push("Only the part of your volume that the rate card covers was priced, so no all-in figure is shown.");
    return out;
  }
  const a = b.assumed;
  if (a && a.units > 0) out.push(`${plural(a.units, "order")} had no item count in the file, so the typical order you described was used (estimated).`);
  if (a && a.lines > 0) out.push(`${plural(a.lines, "order")} had no line data, so the typical order you described was used (estimated).`);
  if (a && a.packaging > 0) out.push(`${plural(a.packaging, "order")} had no packaging type, so the default packaging you chose was used (estimated).`);
  for (const w of b.warnings) {
    if (w.code === "fee_base_excludes_exposure") out.push(`${plural(w.orders, "order")}: a fee that is a percentage of shipping was based on shipping without the charges that may be added after shipping.`);
  }
  out.push(...feeStatusSentences(b.statusCounts));
  if (view === "allin" && b.allocation) {
    if (b.allocation.caveats.includes("at_least")) out.push(`Only ${b.allocation.coveragePct}% of your orders could be priced, so the monthly figures count just those orders: the real cost is at least this.`);
    else if (b.allocation.extrapolated) out.push(`Monthly figures scale the average of the orders that could be priced (${b.allocation.coveragePct}% of your orders) to your monthly volume.`);
  }
  const unused = view === "allin" ? (b.monthly?.unusedAnswers.length ?? 0) : 0;
  if (unused > 0) out.push(`${plural(unused, "answer")} you gave ${unused === 1 ? "is" : "are"} not used by this fee schedule.`);
  return out;
}

function shippingHeadline(b: Basis): HeadlineFigures {
  return {
    view: "shipping",
    label: "Estimated shipping cost per order",
    amount: b.shippingPerOrder,
    qualifier: "",
    complete: b.shippingPerOrder !== null,
    unavailable: b.shippingPerOrder === null ? "No order could be priced." : null,
    notIncluded: [],
    basisSentence: shippingBasisSentence(b),
    caveats: [],
    minimumCouldAdd: null,
    parts: [],
  };
}

function feesHeadline(b: Basis, addHref: string | undefined): HeadlineFigures {
  const base = { view: "fees" as const, notIncluded: [] as NotIncludedItem[], caveats: feeCaveats(b, "fees"), minimumCouldAdd: null, parts: [] as HeadlinePart[] };
  const unavailable = feesUnavailable(b) ?? (b.processingPerOrder === null ? noProcessingReason(b) : null);
  if (unavailable || b.processingPerOrder === null) {
    return { ...base, label: "Order fees per order", amount: null, qualifier: "", complete: false, unavailable: unavailable ?? "No order could be priced with fees.", basisSentence: shippingBasisSentence(b) };
  }
  const missing = missingCategories(b, "order").map((c) => categoryName(c.category));
  const priced = b.source === "file" ? `Fees priced for ${n(b.processingOrders)} of ${n(b.modeledOrders)} orders that could be priced` : shippingBasisSentence(b);
  return {
    ...base,
    label: missing.length ? `Order fees per order, without ${joinWords(missing)}` : "Order fees per order",
    amount: b.processingPerOrder,
    qualifier: missing.length ? "At least" : "",
    complete: missing.length === 0,
    unavailable: null,
    notIncluded: notIncludedItems(b, "order", addHref),
    basisSentence: priced,
  };
}

function allInHeadline(b: Basis, addHref: string | undefined): HeadlineFigures {
  const caveats = feeCaveats(b, "allin");
  const none = { view: "allin" as const, notIncluded: [] as NotIncludedItem[], caveats, minimumCouldAdd: null, parts: [] as HeadlinePart[] };
  const unavailable = feesUnavailable(b);
  if (unavailable) return { ...none, label: "All-in cost per order", amount: null, qualifier: "", complete: false, unavailable, basisSentence: shippingBasisSentence(b) };

  const missing = missingCategories(b, "all").map((c) => categoryName(c.category));
  const label = missing.length ? `All-in cost per order, without ${joinWords(missing)}` : "All-in cost per order";
  const allocation = b.allocation;
  let amount: string | null = allocation?.perOrder.allIn ?? null;
  let reason: string | null = null;
  if (b.source === "file" && b.processingOrders === 0) {
    // The allocation of an empty processing set is only the monthly charges: not an all-in cost.
    amount = null;
    reason = noProcessingReason(b);
  } else if (!allocation) {
    reason = b.priceOnlyCovered ? "Only part of your volume could be priced, so no all-in figure is shown." : "No all-in figure could be worked out for this model.";
  } else if (amount === null) {
    const volume = b.monthlyOrders === null ? null : new D(b.monthlyOrders);
    reason = volume === null ? "No monthly order volume is known, so monthly charges cannot be spread over your orders. State a volume and run the model again." : "Your monthly order volume is 0, so charges cannot be spread per order.";
  }
  const minimumGap = b.minimumStatus === "upper_bound" || b.minimumStatus === "not_computed";
  const atLeast = missing.length > 0 || minimumGap || (allocation?.caveats.includes("at_least") ?? false);
  const qualifier: "" | "At least" = amount !== null && atLeast ? "At least" : "";
  const couldAdd = amount !== null ? minimumCouldAddOf(b) : null;
  const parts: HeadlinePart[] = allocation && amount !== null
    ? [
        { label: "Shipping", amount: allocation.perOrder.shipping, note: null },
        { label: "Order fees", amount: allocation.perOrder.processing, note: null },
        { label: "Monthly charges, spread over your orders", amount: allocation.perOrder.allocated, note: allocation.perOrder.allocated !== null && b.monthlyOrders ? `at ${formatVolume(b.monthlyOrders)} orders a month` : null },
      ]
    : [];
  return {
    view: "allin",
    label,
    amount,
    qualifier,
    complete: amount !== null && !atLeast,
    unavailable: amount === null ? reason : null,
    notIncluded: notIncludedItems(b, "all", addHref),
    basisSentence: allocationBasisOf(b),
    caveats,
    minimumCouldAdd: couldAdd,
    parts,
  };
}

/**
 * What the headline says for one view (design section 6). "All-in cost per order" is the label only
 * when every rate-bearing category of the pinned fee schedule is priced and the account minimum is exact
 * or absent. Otherwise the label names what is left out ("All-in cost per order, without storage and
 * receiving"), the figure reads "At least", and the left-out charges are listed with their rates and an
 * Add link. F1: a minimum that is an upper bound only through coverage or undated orders leaves every
 * category priced, so the label stays and a separate sentence says "the account minimum could add up to $X".
 */
export function headlineFigures(summary: HeadlineSummary, view: HeadlineView, provenance: HeadlineProvenance = {}, _audience: HeadlineAudience = "brand"): HeadlineFigures {
  const b = basisOf(summary);
  const addHref = provenance.addHref ?? undefined;
  if (view === "shipping") return shippingHeadline(b);
  if (view === "fees") return feesHeadline(b, addHref);
  return allInHeadline(b, addHref);
}

/** All-in when its figure is complete and exact, else Shipping. */
export function defaultView(summary: HeadlineSummary): HeadlineView {
  return headlineFigures(summary, "allin").complete ? "allin" : "shipping";
}

/** "At least $9.20" / "$9.20" / "Not computed": the figure as one string, for tiles and lists. */
export function headlineText(h: HeadlineFigures): string {
  if (h.amount === null) return "Not computed";
  return `${h.qualifier ? `${h.qualifier} ` : ""}${usd(h.amount)}`;
}

// ---------------------------------------------------------------------------
// "Not included": three groups
// ---------------------------------------------------------------------------
export interface NotIncludedGroups {
  /** Left out because no numbers were given: the rate and, when the viewer can rerun, the Add link. */
  needNumbers: NotIncludedItem[];
  /** Not on the fee schedule (or not covered by the version in effect). */
  notOnSchedule: { label: string; detail: string }[];
  /** Never included, whatever was entered. */
  neverIncluded: string[];
}

export const NEVER_INCLUDED: readonly string[] = [
  "Special projects and anything else outside the fee schedule (these are quoted separately).",
  "Carrier adjustments billed after shipping, such as address corrections and reweighs.",
  "Taxes.",
  "Return shipping.",
];

export function notIncludedGroups(summary: HeadlineSummary, provenance: HeadlineProvenance = {}, audience: HeadlineAudience = "brand"): NotIncludedGroups {
  const b = basisOf(summary);
  const addHref = provenance.addHref ?? undefined;
  const schedule = audience === "staff" ? "this customer's fee schedule" : "your fee schedule";
  const neverIncluded = [...NEVER_INCLUDED];
  if (b.feeMode === "no_schedule" || b.completeness.every((c) => c.state === "not_in_schedule")) {
    return { needNumbers: [], notOnSchedule: [{ label: "Every fulfillment fee", detail: "No fee schedule was in effect for this model." }], neverIncluded };
  }
  const notOnSchedule: NotIncludedGroups["notOnSchedule"] = [];
  for (const c of b.completeness) {
    if (c.state === "not_in_schedule") notOnSchedule.push({ label: capitalise(categoryName(c.category)), detail: `${capitalise(schedule)} has no ${categoryName(c.category)} charge.` });
  }
  for (const c of b.completeness) {
    for (const rule of c.rules) {
      if (rule.state === "not_modeled" && !isAddableReason(rule.reason)) notOnSchedule.push({ label: rule.name, detail: capitalise(reasonText(rule.reason)) + "." });
    }
  }
  return { needNumbers: notIncludedItems(b, "all", addHref), notOnSchedule, neverIncluded };
}

// ---------------------------------------------------------------------------
// Provenance lines
// ---------------------------------------------------------------------------
/** "'Standard', in effect from Jan 1, 2026" (with the later change dates when several versions priced the run). */
export function feeScheduleDescription(provenance: { scheduleName: string; versions: { effectiveDate: string }[] }): string {
  const dates = [...new Set(provenance.versions.map((v) => v.effectiveDate))].sort();
  const head = `'${provenance.scheduleName}'`;
  if (dates.length === 0) return head;
  if (dates.length === 1) return `${head}, in effect from ${formatDate(dates[0]!)}`;
  return `${head}, in effect from ${formatDate(dates[0]!)} (with changes from ${joinWords(dates.slice(1).map((d) => formatDate(d)))} for later orders)`;
}

/** "{tenant} fee schedule 'Standard', in effect from Jan 1, 2026". */
export function feeScheduleLine(tenantName: string, provenance: { scheduleName: string; versions: { effectiveDate: string }[] } | null | undefined): string | null {
  return provenance ? `${tenantName} fee schedule ${feeScheduleDescription(provenance)}` : null;
}

/** "Assumptions entered by Acme 3PL on Oct 14, 2026" / "by you" / "by another user". */
export function assumptionsLine(by: "you" | "tenant" | "other", tenantName: string, on: string): string {
  const who = by === "you" ? "you" : by === "tenant" ? tenantName : "another user";
  return `Assumptions entered by ${who} on ${formatDate(on)}`;
}

/**
 * True when the fee schedule in effect today is not one of the versions the run was priced with
 * (or the customer no longer has one): "Fees have changed since this model was priced".
 */
export function feesChangedSince(pinnedVersionIds: readonly string[], current: { status: "ok"; versionId: string } | { status: "none" | "unknown" }): boolean {
  if (pinnedVersionIds.length === 0 || current.status === "unknown") return false;
  return "versionId" in current ? !pinnedVersionIds.includes(current.versionId) : true;
}

// ---------------------------------------------------------------------------
// Sensitivity: the all-in at other volumes
// ---------------------------------------------------------------------------
export const SENSITIVITY_MULTIPLIERS: readonly string[] = ["0.5", "1", "2", "4"];

export interface VolumePoint {
  multiplier: string;
  /** V × multiplier, exact decimal text. */
  monthlyOrders: string;
  monthlyTotal: string | null;
  allInPerOrder: string | null;
  /**
   * false: the account minimum would have to be re-evaluated per month at this volume from data the summary
   * does not carry, so no figure is given (rather than guessing one).
   */
  known: boolean;
}

/**
 * Monthly shipping + order fees from the exact stored totals, with the operation order `allocate` uses
 * ((total × V) / orders, or total / months below 80 % coverage), so scaling it by k never multiplies a
 * figure that was already rounded to cents. Available when every shipping-modeled order was priced with
 * fees (the shipping total over the processing orders is then `totals.expected`); null otherwise, and the
 * caller falls back to the rounded monthly figures (a cent or two of noise on a monthly total).
 */
function exactMonthlyVariable(summary: BulkSummary, b: Basis): Dec | null {
  const a = b.allocation;
  if (!a || b.monthlyOrders === null || b.processingOrders === 0 || b.processingOrders !== b.modeledOrders) return null;
  const total = new D(summary.totals.expected).plus(summary.fees.processing.expected);
  return a.caveats.includes("at_least") ? total.div(monthsOf(b)) : total.times(b.monthlyOrders).div(b.modeledOrders);
}

/**
 * The all-in at k × the monthly volume, holding the per-order shipping and order fees constant: shipping
 * and order fees scale with volume, monthly charges scale only when their quantity follows volume (a
 * returns rate, `scalesWithVolume`), the others stay fixed. Computed from the stored allocation and monthly
 * lines; k = 1 returns the stored figures. An exact account minimum is handled only where it can be proven:
 * with no top-up at the stated volume there is none at a higher one (charges only grow), otherwise the
 * point is left unknown. A minimum that is not exact stays out, as in the headline, and the headline's
 * "At least" covers it. Forecasts re-evaluate their minimum exactly in the engine (`allInAtVolumes`).
 */
export function volumeSensitivity(summary: HeadlineSummary, multipliers: readonly string[] = SENSITIVITY_MULTIPLIERS): VolumePoint[] {
  if (isForecastSummary(summary)) {
    return allInAtVolumes(summary, multipliers).map((p) => ({ multiplier: p.multiplier, monthlyOrders: p.monthlyOrders, monthlyTotal: p.monthly.total, allInPerOrder: p.perOrder.allIn, known: true }));
  }
  const b = basisOf(summary);
  const a = b.allocation;
  if (b.feeMode !== "modeled" || !a || b.monthlyOrders === null || b.processingOrders === 0) return [];
  const volume = new D(b.monthlyOrders);
  if (!volume.gt(0) || a.monthly.shipping === null || a.monthly.processing === null) return [];
  const variable = exactMonthlyVariable(summary, b) ?? new D(a.monthly.shipping).plus(a.monthly.processing);
  const lines = b.monthly?.lines ?? [];
  const topUp1 = a.monthly.minimumTopUp === null ? null : new D(a.monthly.minimumTopUp);
  return multipliers.map((multiplier) => {
    if (!/^\d+(\.\d+)?$/.test(multiplier) || !/[1-9]/.test(multiplier)) throw new RangeError(`volume multiplier "${multiplier}" must be a positive decimal`);
    const k = new D(multiplier);
    const orders = volume.times(k);
    if (k.eq(1) && a.monthly.total !== null && a.perOrder.allIn !== null) return { multiplier, monthlyOrders: orders.toFixed(), monthlyTotal: a.monthly.total, allInPerOrder: a.perOrder.allIn, known: true };
    let topUp: Dec | null = new D(0);
    if (b.minimumStatus === "exact") topUp = topUp1 !== null && topUp1.isZero() && k.gte(1) ? new D(0) : null;
    if (topUp === null) return { multiplier, monthlyOrders: orders.toFixed(), monthlyTotal: null, allInPerOrder: null, known: false };
    const fixed = lines.reduce((sum, l) => sum.plus(fromE4(l.amountE4).times(l.scalesWithVolume ? k : 1)), new D(0));
    const total = variable.times(k).plus(fixed).plus(topUp);
    return { multiplier, monthlyOrders: orders.toFixed(), monthlyTotal: centsOf(total), allInPerOrder: centsOf(total.div(orders)), known: true };
  });
}

// ---------------------------------------------------------------------------
// Monthly charges
// ---------------------------------------------------------------------------
export interface MonthlyChargeLine {
  name: string;
  category: FeeCategory;
  /** Inputs echoed by the engine: "12 pallets × $18.00 = $216.00 a month." */
  explanation: string;
  quantity: string;
  unitAmount: string | null;
  amount: string;
  chargeClass: "definite" | "estimated";
  scalesWithVolume: boolean;
}

export interface MonthlyNotModeledLine {
  name: string;
  category: FeeCategory;
  rate: string;
  reason: string;
  addable: boolean;
}

export interface MonthlyCharges {
  lines: MonthlyChargeLine[];
  notModeled: MonthlyNotModeledLine[];
  /** Charges that do not depend on volume ("whatever you ship"); null when there are none. */
  fixedPerMonth: string | null;
  /** Charges that grow with volume (a returns rate); null when there are none. */
  volumeLinkedPerMonth: string | null;
  /** Every priced monthly charge, rounded once; null when none was priced. */
  totalPerMonth: string | null;
  /** The total spread over the monthly volume, rounded once; null when the volume is unknown or 0. Never an order fee. */
  perOrder: string | null;
  /** "N orders a month over <from>–<to> (M months)". */
  basisSentence: string;
}

const MONTHLY_REASON: Record<string, string> = { no_answer: "no number was given", replaced_rule_missing: "it depends on a number that was left out", volume_unknown: "it needs your monthly order volume" };

/** The monthly charges card, from the stored monthly result (null when fees were not modeled). */
export function monthlyCharges(summary: HeadlineSummary): MonthlyCharges | null {
  const b = basisOf(summary);
  if (b.feeMode !== "modeled" || !b.monthly) return null;
  const monthly = b.monthly;
  const sum = (items: typeof monthly.lines): string | null => (items.length ? centsOf(items.reduce((s, l) => s.plus(fromE4(l.amountE4)), new D(0))) : null);
  const total = sum(monthly.lines);
  const volume = b.monthlyOrders === null ? null : new D(b.monthlyOrders);
  const perOrder = total !== null && volume && volume.gt(0) ? centsOf(fromE4(monthly.totalE4).div(volume)) : null;
  return {
    lines: monthly.lines.map((l) => ({ name: l.name, category: l.category, explanation: l.explanation, quantity: l.quantity, unitAmount: l.unitAmountE4 === null ? null : rateText(l.unitAmountE4), amount: centsOf(fromE4(l.amountE4)), chargeClass: l.chargeClass, scalesWithVolume: l.scalesWithVolume })),
    notModeled: monthly.notModeled.map((m) => ({ name: m.name, category: m.category, rate: m.describe, reason: MONTHLY_REASON[m.reason] ?? "no number was given", addable: true })),
    fixedPerMonth: sum(monthly.lines.filter((l) => !l.scalesWithVolume)),
    volumeLinkedPerMonth: sum(monthly.lines.filter((l) => l.scalesWithVolume)),
    totalPerMonth: total,
    perOrder,
    basisSentence: allocationBasisOf(b),
  };
}

// ---------------------------------------------------------------------------
// Order fees (per rule) and per-order rows
// ---------------------------------------------------------------------------
export interface OrderFeeRow {
  name: string;
  category: FeeCategory | null;
  /** The rate in the customer's words; null for a pseudo-row such as an unmatched packaging type. */
  rate: string | null;
  /** Totals over the processing orders, rounded to cents once. */
  definite: string;
  estimated: string;
  orders: number;
  /** "1,200 orders: the file has no item counts" (several reasons joined by "; "), or null. */
  notComputed: string | null;
  /** Entering numbers (or order content) in the run setup step could fix a gap in this row. */
  addable: boolean;
  replacedOrders: number;
}

/** The "Order fees" table: every order-scope rule of the schedule in effect, whether or not it was charged. */
export function orderFeeRows(summary: BulkSummary): OrderFeeRow[] {
  const info = new Map<string, { name: string; category: FeeCategory; rate: string }>();
  for (const c of summary.fees.completeness) for (const r of c.rules) if (r.scope === "order") info.set(r.key, { name: r.name, category: c.category, rate: r.describe });
  const byKey = new Map(summary.fees.byRule.filter((r) => r.scope === "order").map((r) => [r.key, r] as const));
  const rows: OrderFeeRow[] = [];
  const row = (key: string): OrderFeeRow => {
    const i = info.get(key);
    const r = byKey.get(key);
    const reasons = r ? Object.entries(r.unresolvedBy).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)) : [];
    return {
      name: i?.name ?? r?.name ?? "A fee",
      category: i?.category ?? r?.category ?? null,
      rate: i?.rate ?? null,
      definite: toCents(r?.definite ?? "0"),
      estimated: toCents(r?.estimated ?? "0"),
      orders: r?.orders ?? 0,
      notComputed: reasons.length ? reasons.map(([reason, count]) => `${plural(count, "order")}: ${reasonText(reason)}`).join("; ") : null,
      addable: reasons.some(([reason]) => isAddableReason(reason)),
      replacedOrders: r?.replacedOrders ?? 0,
    };
  };
  for (const key of info.keys()) rows.push(row(key));
  for (const key of byKey.keys()) if (!info.has(key)) rows.push(row(key));
  return rows;
}

/** Rule names by key, for turning an order's unresolved keys into words. Never printed as keys. */
export function ruleNameIndex(summary: BulkSummary): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of summary.fees.completeness) for (const r of c.rules) names.set(r.key, r.name);
  for (const r of summary.fees.byRule) if (!names.has(r.key)) names.set(r.key, r.name);
  return names;
}

export interface OrderRowInput {
  /** `simulation_order_results.fee_status`. */
  feeStatus: string;
  definiteE4: number;
  estimatedE4: number;
  /** Σ expected shipping of the order's shipments (decimal text) when every shipment priced, else null. */
  shippingExpected: string | null;
  unresolved: { ruleKey: string; reason: string }[];
}

export interface OrderRowFigures {
  /** Cents; null = the order's shipping was not priced. */
  shipping: string | null;
  /** Cents; null = not computed. When `feesAtLeast`, a rule could not be computed and this is a lower bound. */
  fees: string | null;
  feesAtLeast: boolean;
  /** Shipping + order fees, rounded once; null unless both are known. */
  combined: string | null;
  feeStatus: "priced" | "partly priced" | "not computed";
  /** Why fees are not computed (status), or the names of the rules that could not be computed. */
  notComputed: string | null;
}

export function orderRowFigures(input: OrderRowInput, names: ReadonlyMap<string, string>): OrderRowFigures {
  const priced = input.feeStatus === "ok" || input.feeStatus === "partial";
  const feesExact = priced ? fromE4(input.definiteE4 + input.estimatedE4) : null;
  const shippingExact = input.shippingExpected === null ? null : new D(input.shippingExpected);
  const missing = [...new Set(input.unresolved.filter((u) => u.reason !== "replaced").map((u) => names.get(u.ruleKey) ?? "A fee"))];
  let notComputed: string | null = null;
  if (!priced) notComputed = capitalise(reasonText(input.feeStatus === "no_content" ? "no_content" : input.feeStatus));
  else if (missing.length) notComputed = missing.join("; ");
  return {
    shipping: shippingExact ? centsOf(shippingExact) : null,
    fees: feesExact ? centsOf(feesExact) : null,
    feesAtLeast: input.feeStatus === "partial",
    combined: feesExact && shippingExact ? centsOf(feesExact.plus(shippingExact)) : null,
    feeStatus: input.feeStatus === "ok" ? "priced" : input.feeStatus === "partial" ? "partly priced" : "not computed",
    notComputed,
  };
}

// ---------------------------------------------------------------------------
// Account minimum
// ---------------------------------------------------------------------------
export interface MinimumMemberView {
  name: string;
  state: "priced" | "not_modeled" | "not_in_schedule";
  /** "Counted", "Not modeled" or "Not on your fee schedule". */
  label: string;
}

export interface MinimumBucketRow {
  label: string;
  minimum: string;
  counted: string;
  added: string;
  /** The month is only partly inside the period, so its minimum is prorated. */
  prorated: boolean;
}

export interface MinimumView {
  name: string;
  status: MinimumStatus;
  includesShipping: boolean;
  members: MinimumMemberView[];
  /** One row per calendar month (exact minimums only). */
  buckets: MinimumBucketRow[];
  /** "Fees counted toward the minimum: $380.00 · Minimum: $500.00 · Added: $120.00" when the period is one month. */
  oneLine: string | null;
  /** Exact, several months: the average added a month. */
  averageAdded: string | null;
  /** Not exact: what it could add at most, and why it could not be worked out. */
  couldAdd: string | null;
}

const MEMBER_LABEL: Record<MinimumMemberView["state"], string> = { priced: "Counted", not_modeled: "Not modeled", not_in_schedule: "Not on your fee schedule" };

/** The "Account minimum" card. A member that is no longer on the schedule is named generically (the engine only knows its key). */
export function minimumViews(summary: HeadlineSummary): MinimumView[] {
  const b = basisOf(summary);
  if (b.feeMode !== "modeled") return [];
  const fractions = new Map((b.period?.monthProfile ?? []).map((m) => [m.month, new D(m.fraction)] as const));
  const months = monthsOf(b);
  return b.minimums.map((m) => {
    const includesShipping = m.includesShipping === true;
    const members = m.members.map<MinimumMemberView>((x) => ({ name: x.state === "not_in_schedule" ? "A charge that is no longer on the fee schedule" : x.name, state: x.state, label: MEMBER_LABEL[x.state] }));
    const view: MinimumView = { name: m.name, status: m.status, includesShipping, members, buckets: [], oneLine: null, averageAdded: null, couldAdd: null };
    if (m.status === "exact") {
      view.buckets = m.buckets.map((x) => ({ label: monthLabel(x.month), minimum: centsOf(fromE4(x.minimumE4)), counted: centsOf(fromE4(x.countedE4)), added: centsOf(fromE4(x.topUpE4)), prorated: (fractions.get(x.month) ?? new D(1)).lt(1) }));
      view.averageAdded = centsOf(fromE4(m.topUpE4).div(months));
      const only = view.buckets.length === 1 ? view.buckets[0] : undefined;
      if (only) view.oneLine = `${includesShipping ? "Fees and shipping counted toward the minimum" : "Fees counted toward the minimum"}: ${usd(only.counted)} · Minimum: ${usd(only.minimum)} · Added: ${usd(only.added)}`;
    } else if (m.status === "upper_bound") {
      const reasons = [...new Set(m.reasons.map(describeMinimumReason))];
      view.couldAdd = `This minimum could add up to ${usd(centsOf(fromE4(m.topUpE4).div(months)))} a month. It is not included in the all-in figure because it could not be worked out exactly${reasons.length ? `: ${joinWords(reasons)}` : ""}.`;
    } else {
      view.couldAdd = "This minimum could not be worked out because no order in the file has a date. It is not included in the all-in figure.";
    }
    return view;
  });
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
export interface CompareFacts {
  source: "file" | "assumptions";
  sourceText: string;
  monthlyOrders: string | null;
  ordersPerMonthText: string;
  periodText: string;
  feeScheduleText: string;
  leftOut: FeeCategory[];
  leftOutText: string;
  minimumText: string;
  /** Equal for two runs whose all-in figures leave out the same things; only then are all-in rows comparable. */
  allInSetKey: string;
  shippingPerOrder: string | null;
  feesPerOrder: string | null;
  shippingPlusFees: string | null;
  shippingPlusFeesAtLeast: boolean;
  monthlyChargesPerOrder: string | null;
  allIn: HeadlineFigures;
}

export function compareFacts(summary: HeadlineSummary): CompareFacts {
  const b = basisOf(summary);
  const allIn = headlineFigures(summary, "allin");
  const fileProvenance = isForecastSummary(summary) ? null : summary.provenance;
  const forecastProvenance = isForecastSummary(summary) ? summary.provenance : null;
  const unavailable = feesUnavailable(b);
  const leftOut = missingCategories(b, "all").map((c) => c.category);

  let feeScheduleText: string;
  if (b.feeMode === "skipped") feeScheduleText = "Fulfillment costs skipped";
  else if (b.feeMode === "no_schedule" || (unavailable && !fileProvenance && !forecastProvenance?.feeScheduleName)) feeScheduleText = "No fee schedule";
  else if (fileProvenance) feeScheduleText = feeScheduleDescription(fileProvenance);
  else if (forecastProvenance?.feeScheduleName) feeScheduleText = `'${forecastProvenance.feeScheduleName}'${forecastProvenance.feeScheduleEffectiveDate ? `, in effect from ${formatDate(forecastProvenance.feeScheduleEffectiveDate)}` : ""}`;
  else feeScheduleText = "No fee schedule";

  const leftOutText = b.feeMode === "skipped" ? "Every fulfillment fee (skipped)" : unavailable ? "Every fulfillment fee (no fee schedule)" : leftOut.length ? joinWords(leftOut.map(categoryName)) : "Nothing left out";

  let minimumText: string;
  if (unavailable || b.minimumStatus === "none") minimumText = "No account minimum";
  else if (b.minimumStatus === "exact") minimumText = `Adds ${usd(b.allocation?.monthly.minimumTopUp ?? null)} a month`;
  else if (b.minimumStatus === "upper_bound") minimumText = `Up to ${usd(minimumCouldAddOf(b)?.perMonth ?? null)} a month, not included`;
  else minimumText = "Not worked out (no order dates)";

  const volume = b.monthlyOrders;
  const period = b.period;
  let ordersPerMonthText = "Not known";
  if (volume !== null) ordersPerMonthText = `${formatVolume(volume)}${b.source === "file" ? (period?.volumeBasis === "stated" ? " (you stated it)" : " (from the file)") : " (as described)"}`;
  const periodText = b.source === "assumptions" ? "A typical month, as described" : period?.from && period.to && period.months ? `${formatDate(period.from)}–${formatDate(period.to)} (${formatMonths(period.months)})` : "No order dates in the file";

  const ship = b.allocation?.perOrder.shipping ?? b.shippingPerOrder;
  const fees = b.allocation?.perOrder.processing ?? b.processingPerOrder;
  const both = b.feeMode === "modeled" && !unavailable && ship !== null && fees !== null && !(b.source === "file" && b.processingOrders === 0);
  const minimumIncluded = b.minimumStatus === "exact" || b.minimumStatus === "none";
  return {
    source: b.source,
    sourceText: b.source === "file" ? "Orders file" : "Forecast from assumptions",
    monthlyOrders: volume,
    ordersPerMonthText,
    periodText,
    feeScheduleText,
    leftOut,
    leftOutText,
    minimumText,
    allInSetKey: `${b.feeMode}|${unavailable ? "none" : [...leftOut].sort().join(",")}|${minimumIncluded ? "min" : "nomin"}`,
    shippingPerOrder: ship,
    feesPerOrder: b.feeMode === "modeled" && !unavailable ? fees : null,
    shippingPlusFees: both ? centsOf(new D(ship!).plus(fees!)) : null,
    shippingPlusFeesAtLeast: missingCategories(b, "order").length > 0,
    monthlyChargesPerOrder: b.allocation?.perOrder.allocated ?? null,
    allIn,
  };
}

/** Two monthly volumes differ by more than `threshold` (default 5 %), measured against the larger. */
export function volumeDiffers(a: string | null, b: string | null, threshold = 0.05): boolean {
  if (a === null || b === null) return false;
  const x = new D(a);
  const y = new D(b);
  const larger = D.max(x, y);
  if (!larger.gt(0)) return false;
  return x.minus(y).abs().div(larger).gt(threshold);
}

/** What differs between two forecasts' assumptions, as short fragments ("orders a month 1,250 → 1,400"). */
export function diffForecastProfiles(a: ForecastProfile, b: ForecastProfile): string[] {
  const lines: string[] = [];
  if (a.monthlyOrders !== b.monthlyOrders) lines.push(`orders a month ${formatVolume(a.monthlyOrders)} → ${formatVolume(b.monthlyOrders)}`);
  if (a.asOfDate !== b.asOfDate) lines.push(`rates and fees read on ${formatDate(a.asOfDate)} → ${formatDate(b.asOfDate)}`);
  if (a.originZip !== b.originZip) lines.push(`ship-from ZIP ${a.originZip} → ${b.originZip}`);
  if (a.residentialPct !== b.residentialPct) lines.push(`home deliveries ${a.residentialPct}% → ${b.residentialPct}%`);
  if (a.multiPackage.pct !== b.multiPackage.pct || a.multiPackage.packagesPerOrder !== b.multiPackage.packagesPerOrder) lines.push(`multi-package orders ${a.multiPackage.pct}% × ${a.multiPackage.packagesPerOrder} → ${b.multiPackage.pct}% × ${b.multiPackage.packagesPerOrder}`);
  if (JSON.stringify(a.parcels) !== JSON.stringify(b.parcels)) lines.push("parcel mix differs");
  if (JSON.stringify(a.zones) !== JSON.stringify(b.zones)) lines.push("zone mix differs");
  if (JSON.stringify(a.services) !== JSON.stringify(b.services)) lines.push("service mix differs");
  if (JSON.stringify(a.content) !== JSON.stringify(b.content)) lines.push("typical order content differs");
  return lines;
}
