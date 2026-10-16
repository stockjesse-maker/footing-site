import { allInAtVolumes } from "@/engine/forecast";
import type { ForecastProfile, ForecastSummary } from "@/engine/forecast/types";
import type { AllocationResult, FeeCategory, MinimumResult, MinimumStatus, MonthlyFeeResult } from "@/engine/fees/types";
import type { BulkSummary, CategoryCompleteness, FeeStatus, RunPeriod } from "@/engine/modeling/types";
import { D, type Dec } from "@/engine/money";
import { formatDate } from "@/lib/format/date";
import { diffAssumptions, formatMonths, formatVolume, type AssumptionsLike } from "@/lib/modeling/assumptions";

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

/** The text with one full stop at its end (some stored sentences carry their own), so "{sentence}." never prints two. */
export const endSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

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

/** The one reason the "Not included, because no numbers were given" lists are headed with; any other reason is printed beside its item. */
export const NO_NUMBER_REASON = "no number was given";

const REASON_TEXT: Record<string, string> = {
  no_answer: NO_NUMBER_REASON,
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
  // The monthly-figures sentences describe an all-in figure; when no order could be priced there is none to describe.
  if (view === "allin" && b.allocation && !(b.source === "file" && b.processingOrders === 0)) {
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
        { label: "Monthly charges, spread over your orders", amount: allocation.perOrder.allocated, note: allocation.perOrder.allocated !== null && b.monthlyOrders ? `at ${formatVolume(b.monthlyOrders)} orders a month${b.minimumStatus === "exact" && allocation.monthly.minimumTopUp !== null && new D(allocation.monthly.minimumTopUp).gt(0) ? ", with the account minimum" : ""}` : null },
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

/**
 * One sentence on why a headline is not the plain all-in figure: what is missing and what could be added,
 * or why no figure exists. null when the figure is complete. Used under tiles where the full card does not fit.
 */
export function headlineReason(h: HeadlineFigures): string | null {
  if (h.unavailable) return h.unavailable;
  const parts: string[] = [];
  if (h.notIncluded.length) parts.push(`Not included yet: ${joinWords(h.notIncluded.map((i) => i.name))}. Add your numbers for the full figure.`);
  if (h.minimumCouldAdd) parts.push(h.minimumCouldAdd.sentence);
  if (!parts.length && h.qualifier) parts.push("Some charges are left out of this figure; the results say which and why.");
  return parts.length ? parts.join(" ") : null;
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

/** A sentence about order dates no fee schedule version covered (ship-date basis, or a schedule that began later); null when every date was covered. */
export function uncoveredFeeDatesNote(uncovered: { from: string; to: string; dates: number } | null): string | null {
  if (!uncovered) return null;
  if (uncovered.dates === 1) return `No fee schedule was in effect on ${formatDate(uncovered.from)}, so orders dated then have no fees.`;
  return `No fee schedule was in effect on ${n(uncovered.dates)} of the order dates (between ${formatDate(uncovered.from)} and ${formatDate(uncovered.to)}), so orders dated then have no fees.`;
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
  /** false: the stored month figures do not allow the account minimum to be evaluated at this volume, so no figure is given (rather than guessing one). */
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
 * What an account minimum that was worked out exactly adds a month on average when the same orders arrive k
 * times as often, evaluated month by month from the stored buckets: what counts toward the minimum is the
 * orders' charges (which grow with k) plus the monthly charges inside its set (which stay, or grow with k for
 * a returns rate), against the month's minimum. null when the stored figures do not allow it (never a guess).
 * A minimum that is not exact stays out, as it does in the headline.
 */
function minimumTopUpAt(b: Basis, k: Dec): Dec | null {
  if (b.minimumStatus !== "exact") return new D(0);
  const lines = new Map((b.monthly?.lines ?? []).map((l) => [l.ruleKey, l] as const));
  const fractions = new Map((b.period?.monthProfile ?? []).map((m) => [m.month, new D(m.fraction)] as const));
  const cents = (e4: Dec): Dec => e4.div(100).toDecimalPlaces(0, D.ROUND_HALF_UP).times(100);
  let topUpE4 = new D(0);
  for (const minimum of b.minimums) {
    const inSet = minimum.members.filter((x) => x.state === "priced").flatMap((x) => lines.get(x.ruleKey) ?? []);
    for (const bucket of minimum.buckets) {
      const f = fractions.get(bucket.month) ?? new D(1);
      // The orders' share of what was counted is what is left after the monthly charges the engine added (rounded to cents as it did).
      const fixedStored = inSet.reduce((sum, l) => sum.plus(cents(new D(l.amountE4).times(f))), new D(0));
      const variable = new D(bucket.countedE4).minus(fixedStored);
      if (variable.isNegative()) return null;
      const fixedAtK = inSet.reduce((sum, l) => sum.plus(new D(l.amountE4).times(f).times(l.scalesWithVolume ? k : 1)), new D(0));
      topUpE4 = topUpE4.plus(D.max(new D(0), new D(bucket.minimumE4).minus(variable.times(k).plus(fixedAtK))));
    }
  }
  return fromE4(topUpE4.toNumber()).div(monthsOf(b));
}

/**
 * The all-in at k × the monthly volume, holding the per-order shipping and order fees constant: shipping
 * and order fees scale with volume, monthly charges scale only when their quantity follows volume (a
 * returns rate, `scalesWithVolume`), the others stay fixed, and an exact account minimum is evaluated again
 * for each month at that volume from the stored month figures. Computed from the stored allocation, monthly
 * lines and minimum buckets; k = 1 returns the stored figures. A minimum that is not exact stays out, as in
 * the headline, and the headline's "At least" covers it. Cents can differ by a cent or two from running the
 * model again at that volume (rounding happens once here, per rule there). Price breaks that depend on
 * volume are not re-read. Forecasts re-evaluate their minimum exactly in the engine (`allInAtVolumes`).
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
  return multipliers.map((multiplier) => {
    if (!/^\d+(\.\d+)?$/.test(multiplier) || !/[1-9]/.test(multiplier)) throw new RangeError(`volume multiplier "${multiplier}" must be a positive decimal`);
    const k = new D(multiplier);
    const orders = volume.times(k);
    if (k.eq(1) && a.monthly.total !== null && a.perOrder.allIn !== null) return { multiplier, monthlyOrders: orders.toFixed(), monthlyTotal: a.monthly.total, allInPerOrder: a.perOrder.allIn, known: true };
    const topUp = minimumTopUpAt(b, k);
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
  /** What an exactly-worked-out account minimum adds a month on top of the charges above (null when none, or not exact). */
  minimumPerMonth: string | null;
  /** The monthly charges plus that minimum, spread over the monthly volume: the figure the all-in uses; null when unknown. */
  withMinimumPerOrder: string | null;
  /** "N orders a month over <from>–<to> (M months)". */
  basisSentence: string;
}

const MONTHLY_REASON: Record<string, string> = { no_answer: NO_NUMBER_REASON, replaced_rule_missing: "it depends on a number that was left out", volume_unknown: "it needs your monthly order volume" };

/** The monthly charges card, from the stored monthly result (null when fees were not modeled). */
export function monthlyCharges(summary: HeadlineSummary): MonthlyCharges | null {
  const b = basisOf(summary);
  if (b.feeMode !== "modeled" || !b.monthly) return null;
  const monthly = b.monthly;
  const sum = (items: typeof monthly.lines): string | null => (items.length ? centsOf(items.reduce((s, l) => s.plus(fromE4(l.amountE4)), new D(0))) : null);
  const total = sum(monthly.lines);
  const volume = b.monthlyOrders === null ? null : new D(b.monthlyOrders);
  const perOrder = total !== null && volume && volume.gt(0) ? centsOf(fromE4(monthly.totalE4).div(volume)) : null;
  const topUp = b.allocation?.monthly.minimumTopUp ?? null;
  const minimumAdded = b.minimumStatus === "exact" && topUp !== null && new D(topUp).gt(0) ? topUp : null;
  return {
    lines: monthly.lines.map((l) => ({ name: l.name, category: l.category, explanation: l.explanation, quantity: l.quantity, unitAmount: l.unitAmountE4 === null ? null : rateText(l.unitAmountE4), amount: centsOf(fromE4(l.amountE4)), chargeClass: l.chargeClass, scalesWithVolume: l.scalesWithVolume })),
    notModeled: monthly.notModeled.map((m) => ({ name: m.name, category: m.category, rate: m.describe, reason: MONTHLY_REASON[m.reason] ?? NO_NUMBER_REASON, addable: true })),
    fixedPerMonth: sum(monthly.lines.filter((l) => !l.scalesWithVolume)),
    volumeLinkedPerMonth: sum(monthly.lines.filter((l) => l.scalesWithVolume)),
    totalPerMonth: total,
    perOrder,
    minimumPerMonth: minimumAdded,
    withMinimumPerOrder: minimumAdded !== null ? (b.allocation?.perOrder.allocated ?? null) : null,
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

/** Names (never keys) of the rules an order could not be computed on; a rule replaced by another of its group is not a gap. */
export function unresolvedRuleNames(unresolved: { ruleKey: string; reason: string }[], names: ReadonlyMap<string, string>): string[] {
  return [...new Set(unresolved.filter((u) => u.reason !== "replaced").map((u) => names.get(u.ruleKey) ?? "A fee"))];
}

export function orderRowFigures(input: OrderRowInput, names: ReadonlyMap<string, string>): OrderRowFigures {
  const priced = input.feeStatus === "ok" || input.feeStatus === "partial";
  const feesExact = priced ? fromE4(input.definiteE4 + input.estimatedE4) : null;
  const shippingExact = input.shippingExpected === null ? null : new D(input.shippingExpected);
  const missing = unresolvedRuleNames(input.unresolved, names);
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
  /** Order-scope categories left out of the order fees (the set "Shipping + order fees" is comparable across). */
  orderLeftOut: FeeCategory[];
  monthlyChargesPerOrder: string | null;
  /** Every priced monthly charge, a month, rounded once; null when none was priced. */
  monthlyChargesPerMonth: string | null;
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
    orderLeftOut: missingCategories(b, "order").map((c) => c.category),
    monthlyChargesPerOrder: b.allocation?.perOrder.allocated ?? null,
    monthlyChargesPerMonth: monthlyCharges(summary)?.totalPerMonth ?? null,
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

// ---------------------------------------------------------------------------
// Compare two models
// ---------------------------------------------------------------------------
export interface CompareRunInput {
  /** A file run's `BulkSummary` or a forecast's `ForecastSummary`: both go through the same rows. */
  summary: HeadlineSummary;
  datasetId: string | null;
  datasetName: string | null;
  rateCardName: string | null;
  pricingBasis: "ship_date" | "fixed_date";
  asOfDate: string | null;
  serviceOverrideId: string | null;
  serviceOverrideName: string | null;
  overrideAllServices: boolean;
  /** What the run was started with (a file run's assumptions, or a forecast's); null when none were stored. */
  assumptions: AssumptionsLike | null;
}

export interface CompareRow {
  group: "basis" | "figures" | "allin";
  label: string;
  a: string;
  b: string;
  /** Greyed: the two figures are not comparable (the all-in rows when the models leave out different things). */
  muted: boolean;
  note: string | null;
}

export interface Comparison {
  rows: CompareRow[];
  warnings: string[];
  /** What differs in the answers and assumptions, as short fragments ("pallets stored 12 → 15"). */
  changes: string[];
  /** Both all-in figures leave out the same things (and count the account minimum the same way). */
  allInComparable: boolean;
  allInNote: string | null;
}

const orDash = (v: string | null): string => (v === null ? "—" : usd(v));
const orNotComputed = (v: string | null): string => (v === null ? "Not computed" : usd(v));

function ratesText(r: CompareRunInput): string {
  if (isForecastSummary(r.summary)) return `in effect on ${formatDate(r.summary.asOfDate)}`;
  return r.pricingBasis === "fixed_date" && r.asOfDate ? `in effect on ${formatDate(r.asOfDate)}` : "each ship date";
}

function pricedOnText(r: CompareRunInput): string {
  if (isForecastSummary(r.summary)) return "services in the forecast mix";
  return r.serviceOverrideName ? `${r.overrideAllServices ? "everything" : "unmapped shipments"} on ${r.serviceOverrideName}` : "services in the file";
}

/** Driver key → the name of the charge it feeds, from the stored monthly result (so a diff never prints a key). */
function driverLabelsOf(summary: HeadlineSummary): Record<string, string> {
  const labels: Record<string, string> = {};
  const monthly = summary.monthly;
  for (const l of monthly?.lines ?? []) if (l.driverKey) labels[l.driverKey] = l.name;
  for (const m of monthly?.notModeled ?? []) if (m.driverKey && !labels[m.driverKey]) labels[m.driverKey] = m.name;
  return labels;
}

/** The assumptions two runs are compared on: the shipping assumptions only make sense between two file runs; volume and order content sit in their own rows. */
function comparableAssumptions(run: CompareRunInput, other: CompareRunInput): AssumptionsLike {
  const raw = run.assumptions ?? {};
  const f = raw.fulfillment ?? null;
  const forecast = isForecastSummary(run.summary);
  const cross = forecast !== isForecastSummary(other.summary);
  if (forecast) return { fulfillment: f ? { skip: f.skip ?? null, drivers: f.drivers ?? null, orderShares: f.orderShares ?? null, packagingDefault: f.packagingDefault ?? null } : null };
  if (cross) return { fulfillment: f ? { skip: f.skip ?? null, drivers: f.drivers ?? null, orderShares: f.orderShares ?? null, packagingDefault: f.packagingDefault ?? null } : null };
  return { residentialDefault: raw.residentialDefault, originZipDefault: raw.originZipDefault, overrideAllServices: raw.overrideAllServices, fulfillment: f };
}

/**
 * The comparison table of two completed models, basis rows first (what each is made from, the volume and
 * period, the fee schedule date, what is left out, the minimum), then the per-order figures, then the all-in
 * rows, which are greyed with a note when the two leave out different things. "Shipping + order fees" is
 * the row that stays comparable. Every figure is read from the stored summaries.
 */
export function buildComparison(a: CompareRunInput, b: CompareRunInput): Comparison {
  const fa = compareFacts(a.summary);
  const fb = compareFacts(b.summary);
  const sa = isForecastSummary(a.summary) ? null : a.summary;
  const sb = isForecastSummary(b.summary) ? null : b.summary;
  const forecastA = isForecastSummary(a.summary) ? a.summary : null;
  const forecastB = isForecastSummary(b.summary) ? b.summary : null;

  const allInComparable = fa.allInSetKey === fb.allInSetKey;
  const allInNote = allInComparable ? null : `These two all-in figures leave out different things (${fa.leftOutText} in the first; ${fb.leftOutText} in the second), so they are not comparable. Compare "Shipping + order fees" instead.`;
  const orderSetsDiffer = [...fa.orderLeftOut].sort().join(",") !== [...fb.orderLeftOut].sort().join(",");

  const row = (group: CompareRow["group"], label: string, x: string, y: string, extra: Partial<Pick<CompareRow, "muted" | "note">> = {}): CompareRow => ({ group, label, a: x, b: y, muted: extra.muted ?? false, note: extra.note ?? null });
  const pair = (fn: (f: CompareFacts) => string): [string, string] => [fn(fa), fn(fb)];

  const rows: CompareRow[] = [
    row("basis", "Based on", fa.sourceText, fb.sourceText),
    row("basis", "Orders file", a.datasetName ?? "—", b.datasetName ?? "—"),
    row("basis", "Rate card", a.rateCardName ?? "—", b.rateCardName ?? "—"),
    row("basis", "Rates", ratesText(a), ratesText(b)),
    row("basis", "Priced on", pricedOnText(a), pricedOnText(b)),
    row("basis", "Orders a month", ...pair((f) => f.ordersPerMonthText)),
    row("basis", "Period", ...pair((f) => f.periodText)),
    row("basis", "Fee schedule", ...pair((f) => f.feeScheduleText)),
    row("basis", "Orders modeled", sa ? `${n(sa.modeled.orders)} of ${n(sa.imported.orders)} (${sa.coverage.ordersPct}%)` : forecastA ? `${forecastA.pricedSharePct}% of the volume` : "—", sb ? `${n(sb.modeled.orders)} of ${n(sb.imported.orders)} (${sb.coverage.ordersPct}%)` : forecastB ? `${forecastB.pricedSharePct}% of the volume` : "—"),
    row("basis", "Left out of the all-in", ...pair((f) => f.leftOutText)),
    row("basis", "Account minimum", ...pair((f) => f.minimumText)),

    row("figures", "Shipping per order", orNotComputed(fa.shippingPerOrder), orNotComputed(fb.shippingPerOrder)),
    row("figures", "Order fees per order", orNotComputed(fa.feesPerOrder), orNotComputed(fb.feesPerOrder)),
    row("figures", "Shipping + order fees (comparable)", fa.shippingPlusFees === null ? "Not computed" : `${fa.shippingPlusFeesAtLeast ? "At least " : ""}${usd(fa.shippingPlusFees)}`, fb.shippingPlusFees === null ? "Not computed" : `${fb.shippingPlusFeesAtLeast ? "At least " : ""}${usd(fb.shippingPlusFees)}`, {
      note: orderSetsDiffer ? "The two leave out different order fees, so this row is only a lower bound on both." : null,
    }),
    row("figures", "Per package", sa ? orDash(sa.averages.expectedPerPackage) : "—", sb ? orDash(sb.averages.expectedPerPackage) : "—"),
    row("figures", "Projected shipping spend (the orders in the file)", sa ? orDash(sa.modeled.orders ? sa.totals.expected : null) : "—", sb ? orDash(sb.modeled.orders ? sb.totals.expected : null) : "—"),
    row("figures", "From rate card", sa ? orDash(sa.totals.definite) : "—", sb ? orDash(sb.totals.definite) : "—"),
    row("figures", "Based on assumptions", sa ? orDash(sa.totals.estimated) : "—", sb ? orDash(sb.totals.estimated) : "—"),
    row("figures", "Could not be decided (up to)", sa ? orDash(sa.exposure.unresolved.amount) : forecastA ? `${usd(forecastA.shipping.unresolvedUpTo)} a month` : "—", sb ? orDash(sb.exposure.unresolved.amount) : forecastB ? `${usd(forecastB.shipping.unresolvedUpTo)} a month` : "—"),
    row("figures", "May be added after shipping (up to)", sa ? orDash(sa.exposure.conditional.amount) : forecastA ? `${usd(forecastA.shipping.conditionalUpTo)} a month` : "—", sb ? orDash(sb.exposure.conditional.amount) : forecastB ? `${usd(forecastB.shipping.conditionalUpTo)} a month` : "—"),

    row("allin", "Monthly charges a month (without the account minimum)", fa.monthlyChargesPerMonth === null ? "Not computed" : `${usd(fa.monthlyChargesPerMonth)} a month`, fb.monthlyChargesPerMonth === null ? "Not computed" : `${usd(fb.monthlyChargesPerMonth)} a month`, { muted: !allInComparable }),
    row("allin", "Monthly charges spread over orders (with any account minimum)", orDash(fa.monthlyChargesPerOrder), orDash(fb.monthlyChargesPerOrder), { muted: !allInComparable }),
    row("allin", `All-in cost per order${allInComparable ? "" : " (not comparable)"}`, `${headlineText(fa.allIn)}${fa.allIn.amount !== null && fa.leftOut.length ? ` (without ${fa.leftOutText})` : ""}`, `${headlineText(fb.allIn)}${fb.allIn.amount !== null && fb.leftOut.length ? ` (without ${fb.leftOutText})` : ""}`, { muted: !allInComparable, note: allInNote }),
  ];

  const warnings: string[] = [];
  if (sa && sb) {
    if (a.datasetId !== b.datasetId) warnings.push("Different orders files were modeled, so the averages are not directly comparable.");
    if (Math.abs(Number(sa.coverage.ordersPct) - Number(sb.coverage.ordersPct)) > 5) warnings.push("The share of orders that could be priced differs by more than 5 points.");
    if (a.pricingBasis !== b.pricingBasis || a.asOfDate !== b.asOfDate) warnings.push("The two models use different pricing dates.");
    if (a.serviceOverrideId !== b.serviceOverrideId || a.overrideAllServices !== b.overrideAllServices) warnings.push("The two models price shipments on different services (one is a what-if).");
  } else if (forecastA && forecastB && forecastA.asOfDate !== forecastB.asOfDate) {
    warnings.push("The two forecasts read rates and fees on different dates.");
  }
  if ((forecastA === null) !== (forecastB === null)) {
    warnings.push("One of these is a forecast from assumptions and the other is built from an orders file. A forecast shows expected values over the mix described; compare them as two estimates, not as a check of one against the other.");
  }
  if (volumeDiffers(fa.monthlyOrders, fb.monthlyOrders)) {
    warnings.push(`The two models are at different volumes (${formatVolume(fa.monthlyOrders!)} and ${formatVolume(fb.monthlyOrders!)} orders a month), so monthly charges spread over orders are not directly comparable.`);
  }
  const feesIn = (f: CompareFacts) => f.feesPerOrder !== null;
  if (feesIn(fa) !== feesIn(fb)) warnings.push("Order fees are not modeled in one of these (skipped, or no fee schedule in effect), so only shipping can be compared.");
  else if (feesIn(fa) && fa.feeScheduleText !== fb.feeScheduleText) warnings.push("The two models were priced with different fee schedules or fee schedule dates.");

  const labels = { ...driverLabelsOf(a.summary), ...driverLabelsOf(b.summary) };
  const changes: string[] = [];
  if (forecastA && forecastB) changes.push(...diffForecastProfiles(forecastA.profile, forecastB.profile));
  changes.push(...diffAssumptions(comparableAssumptions(a, b), comparableAssumptions(b, a), { labels }));

  return { rows, warnings, changes, allInComparable, allInNote };
}

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------
/** Quotes for CSV. */
export function csvCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Text from the customer's own file: a leading =, +, -, @ or tab would run as a formula in a spreadsheet, so it is prefixed with an apostrophe. */
export function csvText(v: string | null | undefined): string {
  const s = v ?? "";
  return csvCell(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
}

/** One `# …` comment line: the text on a single line, so a name with a line break cannot end the comment. */
export function csvComment(text: string): string {
  return `# ${text.replace(/[\r\n]+/g, " ").trim()}`;
}

export const ORDERS_CSV_COLUMNS = ["order_id", "order_date", "units", "lines", "packages", "shipments", "shipping_expected", "order_fees", "shipping_plus_fees", "fee_status", "not_computed"] as const;

export interface OrdersCsvOrder extends OrderRowInput {
  externalOrderId: string;
  orderDate: string | null;
  units: number | null;
  lines: number | null;
  packages: number;
  shipments: number;
  assumed: { units?: boolean; lines?: boolean; skus?: boolean; packaging?: boolean };
}

/**
 * One order as CSV cells, in `ORDERS_CSV_COLUMNS` order. Blank means "not computed" and is never a zero:
 * units and lines are blank where the file has none (or where the figure used was assumed), shipping is blank
 * unless every shipment of the order priced, fees are blank unless the fee engine ran. There is no per-order
 * column for monthly charges or the all-in: monthly charges are in monthly.csv.
 */
export function ordersCsvRecord(order: OrdersCsvOrder, names: ReadonlyMap<string, string>): string[] {
  const f = orderRowFigures(order, names);
  const contentAssumed = order.assumed.units === true || order.assumed.lines === true;
  const status = f.feeStatus === "priced" ? (contentAssumed ? "priced_on_assumed_content" : "priced") : f.feeStatus === "partly priced" ? "partly_priced" : "not_computed";
  const missing = unresolvedRuleNames(order.unresolved, names);
  const notComputed = f.feeStatus === "priced" ? "" : missing.length ? missing.join(";") : (f.notComputed ?? "");
  return [
    csvText(order.externalOrderId),
    csvCell(order.orderDate ?? ""),
    order.units === null || order.assumed.units === true ? "" : String(order.units),
    order.lines === null || order.assumed.lines === true ? "" : String(order.lines),
    String(order.packages),
    String(order.shipments),
    f.shipping ?? "",
    f.fees ?? "",
    f.combined ?? "",
    status,
    csvText(notComputed),
  ];
}

export interface CsvMeta {
  scenarioName: string;
  rateCardName: string;
  /** "{tenant} fee schedule 'Standard', in effect from Jan 1, 2026"; null when none applied. */
  feeScheduleLine: string | null;
  audience?: HeadlineAudience;
}

/** `# …` lines at the top of orders.csv: what the file is, the headline it reconciles with, and where the monthly charges are. */
export function ordersCsvComments(summary: BulkSummary, meta: CsvMeta): string[] {
  // The all-in headline with its completeness label (and why it is not the plain figure), or shipping when fees were not modeled.
  const h = headlineFigures(summary, summary.fees.mode === "modeled" ? "allin" : "shipping", {}, meta.audience ?? "brand");
  const reason = headlineReason(h);
  return [
    csvComment(`Estimates for "${meta.scenarioName}" from ${meta.rateCardName}${meta.feeScheduleLine ? ` and ${meta.feeScheduleLine}` : ""}, not an invoice. Amounts in USD.`),
    csvComment(`${h.label}: ${headlineText(h)}. ${h.basisSentence}.${reason ? ` ${reason}` : ""}`),
    csvComment("Monthly charges are not per-order fees and are not in this file: they are in monthly.csv."),
    csvComment("shipping_plus_fees is shipping_expected plus order_fees, each rounded to cents once. Blank means not computed, never zero."),
    csvComment("fee_status: priced, priced_on_assumed_content (units and lines are blank; the typical order described at setup was used), partly_priced (order_fees is a lower bound; not_computed lists what is missing), or not_computed."),
  ];
}

export const MONTHLY_CSV_COLUMNS = ["row_type", "name", "period", "status", "quantity", "unit_amount", "amount", "class", "note"] as const;

export interface MonthlyCsv {
  comments: string[];
  rows: string[][];
}

/**
 * monthly.csv: every monthly charge with its quantity, rate, amount, class and status (a charge with no
 * number given is listed as not_modeled, blank, with its rate), then the account minimum month by month.
 * The period and volume the charges are spread over are in the header comments; no per-order amount appears.
 */
export function monthlyCsv(summary: BulkSummary, meta: CsvMeta): MonthlyCsv {
  const comments = [csvComment(`Monthly charges for "${meta.scenarioName}" from ${meta.feeScheduleLine ?? "the fee schedule"}, not an invoice. Amounts in USD, each rounded to cents once.`)];
  const m = monthlyCharges(summary);
  if (!m) {
    comments.push(csvComment("Fulfillment costs were not modeled for this run, so there are no monthly charges."));
    return { comments, rows: [] };
  }
  comments.push(csvComment(`Basis: ${allocationBasisSentence(summary)}.`));
  comments.push(csvComment("These are monthly amounts. They are not per-order fees and are not in orders.csv."));
  const rows: string[][] = [];
  for (const l of m.lines) {
    rows.push(["charge", csvText(l.name), "a month", "priced", l.quantity, l.unitAmount ?? "", l.amount, l.chargeClass === "definite" ? "from_rate_card" : "based_on_assumptions", csvText(l.explanation)]);
  }
  for (const x of m.notModeled) {
    rows.push(["charge", csvText(x.name), "a month", "not_modeled", "", "", "", "", csvText(`${capitalise(x.reason)}. Rate: ${x.rate}.`)]);
  }
  if (m.totalPerMonth !== null) rows.push(["total", "Monthly charges priced", "a month", "priced", "", "", m.totalPerMonth, "", m.notModeled.length ? csvCell("Charges that are not modeled are not in this total") : ""]);
  for (const min of summary.minimums) {
    if (min.status === "exact") {
      for (const bucket of min.buckets) rows.push(["minimum", csvText(min.name), bucket.month, "exact", "", "", centsOf(fromE4(bucket.topUpE4)), "", csvText(`Counted ${usd(centsOf(fromE4(bucket.countedE4)))} toward a ${usd(centsOf(fromE4(bucket.minimumE4)))} minimum; amount is what is added`)]);
    } else if (min.status === "upper_bound") {
      const reasons = [...new Set(min.reasons.map(describeMinimumReason))];
      rows.push(["minimum", csvText(min.name), "", "up_to", "", "", "", "", csvText(`Could add up to ${usd(centsOf(fromE4(min.topUpE4).div(monthsOf(basisOf(summary)))))} a month; not included in any all-in figure${reasons.length ? ` (${joinWords(reasons)})` : ""}`)]);
    } else {
      rows.push(["minimum", csvText(min.name), "", "not_computed", "", "", "", "", csvCell("No order in the file has a date, so the minimum could not be worked out")]);
    }
  }
  return { comments, rows };
}
