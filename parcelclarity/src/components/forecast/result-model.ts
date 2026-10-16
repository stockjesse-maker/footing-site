import { formatMoney } from "@/components/pricing/calculation-result";
import { e4ToCents } from "@/engine/fees/tiers";
import type { FeeCategory, FeeScope } from "@/engine/fees/types";
import type { ForecastCaveat, ForecastSummary, ForecastVolumePoint } from "@/engine/forecast/types";
import { formatDate } from "@/lib/format/date";

/**
 * The pure model behind the forecast result (Milestone 4, design §7 and §6): which headline a summary
 * earns, what is not included and how to add it, the "what this forecast assumes" lines, and the
 * brand-safe copy of a summary. Nothing here computes a money amount: every figure shown is a string
 * the engine produced (or an E4 integer it produced, shown as cents), and an unknown quantity is only
 * ever described as "not computed", never as $0.
 */

export type Audience = "brand" | "staff";

export const CATEGORY_LABEL: Record<FeeCategory, string> = {
  pick_pack: "Pick and pack",
  packaging: "Packaging",
  kitting: "Kitting & assembly",
  labeling: "Labeling",
  receiving: "Receiving",
  storage: "Storage",
  returns: "Returns",
  account: "Account fees",
  other: "Other fees",
};

export const usd = (value: string | null | undefined): string => (value === null || value === undefined ? "—" : formatMoney({ amount: value, currency: "USD" }));

/** "1,250" from "1250" (an exact digit grouping; no rounding). */
export function groupDigits(text: string): string {
  const [int = "0", frac] = text.split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------------------
// Reasons in the customer's words
// ---------------------------------------------------------------------------
const NOT_COMPUTED_REASON: Record<string, string> = {
  units_unknown: "the number of items in an order was not given",
  lines_unknown: "the number of order lines in an order was not given",
  skus_unknown: "the number of different products in an order was not given",
  packaging_unknown: "the packaging was not given",
  packaging_unmatched: "no charge on the fee schedule covers this packaging",
  shipping_unknown: "shipping could not be priced",
  assumption_missing: "a number it needs was not given",
  no_answer: "no number was given",
  replaced_rule_missing: "the total it is part of was not given",
  volume_unknown: "the order volume is needed",
  skipped: "fulfillment costs were skipped",
  no_schedule: "no fee schedule is in effect on this date",
};

export function notComputedReason(code: string | null): string {
  return (code && NOT_COMPUTED_REASON[code]) || "it could not be worked out from what was given";
}

const UNPRICEABLE_REASON: Record<string, string> = {
  no_rate_for_zone: "the rate card has no rate for this zone",
  no_rate_for_weight: "the parcel is heavier than the rate card's top weight",
  no_rate_for_origin: "the rate card has no rate from this ship-from ZIP",
  service_not_on_rate_card: "the service is not on the rate card",
  service_mismatch: "the service is not on the rate card",
  zone_unresolved: "the zone could not be decided",
  zone_ambiguous: "the zone could not be decided",
  zone_mismatch: "the zone could not be matched",
  rate_card_not_effective: "the rate card has no rates in effect on this date",
  invalid_input: "a value could not be priced",
};

export function unpriceableReason(code: string): string {
  return UNPRICEABLE_REASON[code] ?? "it could not be priced";
}

// ---------------------------------------------------------------------------
// Not included, and how to add it
// ---------------------------------------------------------------------------
/** Where "Add" takes the person: a question of the fee schedule, the typical-order section, the parcels' packaging, or the fulfillment section. */
export type AddTarget = { kind: "driver"; key: string } | { kind: "content" } | { kind: "packaging" } | { kind: "fulfillment" };

export interface NotIncludedItem {
  category: FeeCategory;
  categoryLabel: string;
  /** Charged per order, or once a month from a stated quantity. */
  scope: FeeScope;
  name: string;
  /** The rate in the customer's words ("$15.00 per pallet per month"). */
  rate: string;
  reason: string;
  /** How many orders it affects, for per-order fees (0 for monthly charges and for rules that affect every order). */
  orders: number;
  target: AddTarget;
}

function targetFor(reason: string | null, driverKey: string | null): AddTarget {
  switch (reason) {
    case "units_unknown":
    case "lines_unknown":
    case "skus_unknown":
      return { kind: "content" };
    case "packaging_unknown":
    case "packaging_unmatched":
      return { kind: "packaging" };
    default:
      return driverKey ? { kind: "driver", key: driverKey } : { kind: "fulfillment" };
  }
}

/**
 * Every fee the forecast could not compute, with its rate and what to add. Empty when fulfillment
 * costs were skipped or no schedule applies (the headline says so once instead of listing every rule).
 * Reads rule keys to join monthly driver questions, so it runs on the unscrubbed summary.
 */
export function notIncludedItems(summary: ForecastSummary): NotIncludedItem[] {
  if (summary.feeMode !== "modeled") return [];
  const driverByRule = new Map((summary.monthly?.notModeled ?? []).map((n) => [n.ruleKey, n.driverKey] as const));
  const items: NotIncludedItem[] = [];
  for (const category of summary.completeness) {
    if (category.state !== "not_modeled") continue;
    for (const rule of category.rules) {
      if (rule.state !== "not_modeled") continue;
      items.push({
        category: category.category,
        categoryLabel: CATEGORY_LABEL[category.category],
        scope: rule.scope,
        name: rule.name,
        rate: rule.describe,
        reason: notComputedReason(rule.reason),
        orders: rule.scope === "order" ? category.notModeledOrders : 0,
        target: targetFor(rule.reason, driverByRule.get(rule.key) ?? null),
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------
export interface ForecastHeadline {
  /**
   * all_in: every rate-bearing category priced; at_least: some are not, or the minimum is an upper
   * bound; partial: only part of the volume could be priced (no combined figure); shipping_only: fees
   * were skipped or no fee schedule applies.
   */
  kind: "all_in" | "at_least" | "partial" | "shipping_only";
  label: string;
  /** Dollars per order (2 dp), the combined figure; null for `partial`. */
  perOrder: string | null;
  monthly: string | null;
  annual: string | null;
  /**
   * The parts per order: shipping, order fees and the monthly charges spread over the volume. A part
   * is null when none of its fees could be computed (it is then "not computed", never $0).
   */
  parts: { shipping: string; orderFees: string | null; monthlyCharges: string | null };
  notIncluded: NotIncludedItem[];
  /** "The account minimum could add up to $X a month" when the minimum is an upper bound (dollars), else null. */
  minimumUpTo: string | null;
  /** One sentence on why the figure is shipping only, or how much of the volume could be priced. */
  note: string | null;
}

function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The headline of a forecast, a function of completeness like the file run's: "All-in cost per order"
 * only when every rate-bearing category is priced; otherwise "without …" with "At least $X" and the
 * not-included fees. When only part of the volume could be priced there is no combined figure at all.
 */
export function forecastHeadline(summary: ForecastSummary, notIncluded: NotIncludedItem[] = notIncludedItems(summary)): ForecastHeadline {
  const allocation = summary.allocation;
  // A part none of whose fees could be computed is "not computed", never the $0.00 its empty sum would print.
  const orderFeesNotComputed = notIncluded.some((i) => i.scope === "order") && (summary.processing?.byRule.length ?? 0) === 0;
  const monthlyNotComputed = notIncluded.some((i) => i.scope === "monthly") && (summary.monthly?.lines.length ?? 0) === 0;
  const parts = {
    shipping: summary.shipping.perOrder,
    orderFees: orderFeesNotComputed ? null : (summary.processing?.perOrder ?? null),
    monthlyCharges: monthlyNotComputed ? null : (summary.allocated?.perOrder ?? null),
  };
  const upperBound = summary.minimums.filter((m) => m.status === "upper_bound");
  const upTo = upperBound.reduce((n, m) => n + m.topUpE4, 0);
  const minimumUpTo = upTo > 0 ? e4ToCents(upTo) : null;
  const partial = summary.unpriceable.length > 0;

  if (summary.feeMode !== "modeled") {
    const note = summary.feeMode === "skipped" ? "Fulfillment costs were skipped, so this is shipping only." : `No fee schedule is in effect for you on ${formatDate(summary.asOfDate)}, so this is shipping only.`;
    return { kind: "shipping_only", label: "Estimated shipping cost per order", perOrder: summary.shipping.perOrder, monthly: summary.shipping.expected, annual: null, parts: { ...parts, orderFees: null, monthlyCharges: null }, notIncluded: [], minimumUpTo: null, note: partial ? `${note} Only ${summary.pricedSharePct}% of orders could be priced.` : note };
  }
  if (partial || !allocation) {
    return {
      kind: "partial",
      label: `Shipping and order fees per order, for the ${summary.pricedSharePct}% of orders that could be priced`,
      perOrder: null,
      monthly: null,
      annual: null,
      parts: { ...parts, monthlyCharges: null },
      notIncluded,
      minimumUpTo,
      note: `Only ${summary.pricedSharePct}% of orders could be priced. These are averages over those orders, with nothing estimated for the rest, so there is no all-in figure.`,
    };
  }
  const notPriced = [...new Set(notIncluded.map((i) => i.category))];
  if (summary.allIn && !upperBound.length) {
    return { kind: "all_in", label: "All-in cost per order", perOrder: summary.allIn.perOrder, monthly: summary.allIn.monthly, annual: summary.allIn.annual, parts, notIncluded: [], minimumUpTo: null, note: null };
  }
  return {
    kind: "at_least",
    label: notPriced.length ? `All-in cost per order, without ${joinWords(notPriced.map((c) => lowerFirst(CATEGORY_LABEL[c])))}` : "All-in cost per order",
    perOrder: allocation.perOrder.allIn,
    monthly: allocation.monthly.total,
    annual: allocation.monthly.annual,
    parts,
    notIncluded,
    minimumUpTo,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// What this forecast assumes
// ---------------------------------------------------------------------------
export interface AssumptionLine {
  id: ForecastCaveat | "origin";
  text: string;
}

function positive(amount: string): boolean {
  return /[1-9]/.test(amount);
}

/** The lines of the "What this forecast assumes" card, driven by the summary's caveats and figures. */
export function assumptionLines(summary: ForecastSummary): AssumptionLine[] {
  const has = (c: ForecastCaveat) => summary.caveats.includes(c);
  const p = summary.provenance;
  const profile = summary.profile;
  const lines: AssumptionLine[] = [];
  if (has("independent_distributions")) {
    lines.push({ id: "independent_distributions", text: "Each choice you made (parcel, zone, service, home or business delivery, packages per order, what is in the order) is treated as independent of the others. If, say, heavier parcels tend to go to farther zones, the real mix of costs will differ." });
  }
  if (has("one_shipment_per_order")) {
    const multi = profile.multiPackage;
    lines.push({
      id: "one_shipment_per_order",
      text: positive(multi.pct) ? `Every order ships as one shipment. ${groupDigits(multi.pct)}% of orders ship as one shipment of ${multi.packagesPerOrder} identical packages; the rest as one package.` : "Every order ships as one shipment of one package.",
    });
  }
  if (has("exact_weights")) {
    const unknownSize = profile.parcels.some((x) => x.unknownSize);
    lines.push({
      id: "exact_weights",
      text: `Every parcel is priced at exactly the weight and size you stated, not rounded or grouped.${unknownSize ? " Parcels marked “I don't know the size” are priced without a size check, so a bulky, light parcel may cost more than shown." : ""}`,
    });
  }
  lines.push({ id: "origin", text: `Every order ships from ZIP code ${profile.originZip}.` });
  if (has("no_shipment_options")) lines.push({ id: "no_shipment_options", text: "No signature, Saturday delivery or declared value is added." });
  if (has("delivery_area_undecided")) {
    const up = summary.shipping.unresolvedUpTo;
    lines.push({
      id: "delivery_area_undecided",
      text: `Delivery-area and remote-area surcharges depend on the destination ZIP code, which a forecast does not have, so they are never included${positive(up) ? `: could not be decided (up to ${usd(up)} a month)` : ""}.`,
    });
    if (positive(summary.shipping.conditionalUpTo)) lines.push({ id: "delivery_area_undecided", text: `Charges that may be added after shipping, such as address corrections, are not included (up to ${usd(summary.shipping.conditionalUpTo)} a month).` });
  }
  if (has("effective_dates")) {
    const rates = `rate card ${p.rateCardName}, in effect from ${formatDate(p.rateCardEffectiveDate)}${p.rateCardExpirationDate ? ` to ${formatDate(p.rateCardExpirationDate)}` : ""}`;
    const fees = p.feeScheduleName && p.feeScheduleEffectiveDate ? `; fee schedule ${p.feeScheduleName}, in effect from ${formatDate(p.feeScheduleEffectiveDate)}${p.feeScheduleExpirationDate ? ` to ${formatDate(p.feeScheduleExpirationDate)}` : ""}` : "";
    lines.push({ id: "effective_dates", text: `Priced on ${formatDate(summary.asOfDate)}: ${rates}${fees}.` });
  }
  if (has("priced_only_covered")) lines.push({ id: "priced_only_covered", text: `Only ${summary.pricedSharePct}% of orders could be priced. The figures are averages over those orders, with nothing estimated for the rest, so no all-in figure or projection is shown.` });
  if (has("no_fee_schedule")) lines.push({ id: "no_fee_schedule", text: "No fee schedule was in effect on this date, so only shipping is forecast." });
  if (has("fulfillment_skipped")) lines.push({ id: "fulfillment_skipped", text: "Fulfillment costs were skipped, so only shipping is forecast." });
  if (has("not_all_categories_priced")) lines.push({ id: "not_all_categories_priced", text: "Fees that could not be computed from what you gave are listed as not included, never counted as $0." });
  if (has("minimum_upper_bound")) {
    // An upper bound is what the minimum would add on the fees counted so far; fees not computed can only lower it, so 0 means it adds nothing.
    const upTo = summary.minimums.filter((m) => m.status === "upper_bound").reduce((n, m) => n + m.topUpE4, 0);
    lines.push({
      id: "minimum_upper_bound",
      text: upTo > 0 ? `The account minimum could add up to ${usd(e4ToCents(upTo))} a month; it is not included in the all-in figure.` : "The fees counted so far already meet the account minimum, so it adds nothing, whatever the fees that could not be computed come to.",
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Brand-safe copy
// ---------------------------------------------------------------------------
/** Property names that carry rule keys, service ids, hashes or engine versions: blanked for a brand viewer. */
const BRAND_BLANKED = new Set(["key", "ruleKey", "replacesRuleKey", "serviceId", "assumptionsHash", "forecastEngineVersion", "engineVersion", "feeEngineVersion", "message"]);

function blank(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blank);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = BRAND_BLANKED.has(k) && typeof v === "string" ? "" : blank(v);
    return out;
  }
  return value;
}

/**
 * The summary as the screen needs it: the per-cell records dropped (nobody reads them and they can
 * run to 100 KB), and for a brand viewer every rule key, service id, hash, engine version and engine
 * message blanked, so none of them reaches the browser. Driver question keys stay: the brand's own
 * form carries the same keys to wire "Add". Never mutates its input.
 */
export function scrubForecast(summary: ForecastSummary, audience: Audience): ForecastSummary {
  const base = { ...summary, cells: [] as ForecastSummary["cells"] };
  return audience === "brand" ? (blank(base) as ForecastSummary) : base;
}

export interface ForecastResultData {
  summary: ForecastSummary;
  headline: ForecastHeadline;
  /** All-in figures at 0.5×, 1×, 2× and 4× the forecast volume (empty when fees were not modeled or only part of the volume was priced). */
  sensitivity: ForecastVolumePoint[];
}
