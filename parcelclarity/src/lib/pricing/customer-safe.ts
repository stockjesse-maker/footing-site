import { calculateOrderFees, describeFeeRule, e4ToCents, roundE4ToCents } from "@/engine/fees";
import type { FeeLine, FeeRule, FeeScheduleSnapshot, FeeUnresolvedReason, OrderFeeResult } from "@/engine/fees/types";
import type { ShipmentCalculation } from "@/engine/types";
import type { BrandFeeSchedule } from "@/lib/fees/queries";
import {
  boxOptionsFromSnapshot,
  boxToOrderFeeInput,
  describeBox,
  shippingInputFromCalculation,
  singular,
  type BoxFieldRef,
  type CalculatorBox,
  type CalculatorBoxOptionsOk,
  type CalculatorFeesResponse,
  type OrderFeeNotComputedView,
  type OrderFeesView,
} from "@/lib/pricing/calculator-schema";
import { moneyToCents } from "@/engine/modeling/encode";

export const CUSTOMER_RULE_LABEL = "Your 3PL's approved pricing configuration";

/**
 * What a customer may hold of an engine result: amounts, names, categories, statuses, classes and
 * plain-language explanations. The 3PL's source notes and ids, the engine version and the 3PL's
 * exception references are removed on the server, so no client rendering can leak them (and the
 * exception note itself lives in a staff-only table). Rule keys and versions are removed as well, but
 * that is data minimisation, not the control that keeps them private: under decision D7 (Milestone 5)
 * rule keys, rule and version ids and fee-dictionary names are classified as non-confidential
 * identifiers that a customer can read through the API (the editors say so), so nothing here may
 * depend on their staying hidden. What stays confidential is carried by other means: staff-only
 * tables and no carrier cost anywhere. (The engine's warning messages keep the names of rules that
 * were applied, which are what the customer reads in line labels; the load problem text, which names
 * a rule that could NOT be applied, never reaches a customer: the calculator hands one fixed sentence.)
 * Verification state stays: it is what makes a line an estimate rather than a definite charge, and
 * the result already says so.
 */
export function customerSafe(result: ShipmentCalculation): ShipmentCalculation {
  const safeRule = (rule: ShipmentCalculation["lines"][number]["rule"]) =>
    rule ? { key: "", version: 0, scope: rule.scope, sourceReference: rule.scope === "platform" ? rule.sourceReference : CUSTOMER_RULE_LABEL, verificationStatus: rule.verificationStatus } : rule;
  return {
    ...result,
    lines: result.lines.map((l) => ({ ...l, rule: safeRule(l.rule) })),
    warnings: result.warnings.map((w) => ({ code: w.code, message: w.message })),
    references: {
      ...result.references,
      rateCardId: "",
      rateCardVersionId: "",
      rateCardVersionNumber: 0,
      termsVersion: null,
      engineVersion: "",
      rules: [],
      zipLists: [],
      overrides: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Order fees of the calculator ("What's in the box")
// ---------------------------------------------------------------------------
export type FeeAudience = "brand" | "staff";

/** Customer wording for the engine's warning codes (order scope). */
const FEE_WARNING: Record<string, string> = {
  fee_base_excludes_exposure: "Percentage fees are taken on the shipping cost shown, which leaves out charges that may be added after shipping.",
  packaging_defaulted: "Packaging was assumed for this estimate.",
};

const SHARE_CLAUSE = ", on the share of orders you say get them";

/** Why a fee was left out, in plain words, and what to add to include it. Never mentions a rule key. */
function notComputedWording(reason: FeeUnresolvedReason, rule: FeeRule | undefined, options: CalculatorBoxOptionsOk): Pick<OrderFeeNotComputedView, "reason" | "add"> {
  const products = { field: "products" as BoxFieldRef, label: "Add products" };
  switch (reason) {
    case "units_unknown":
      return { reason: "Needs the number of items in the box.", add: null };
    case "lines_unknown":
      return options.showLines ? { reason: "Needs the number of order lines.", add: { field: "lines", label: "Add order lines" } } : { reason: "Needs the number of different products.", add: products };
    case "skus_unknown":
      return { reason: "Needs the number of different products.", add: products };
    case "packaging_unknown":
      return { reason: "Needs the packaging used.", add: { field: "packaging", label: "Choose packaging" } };
    case "packaging_unmatched":
      // Left out, like every fee in this list: the schedule not listing the type does not make the fee $0, so the wording must not say "none was added".
      return { reason: "Your fee schedule does not list a packaging fee for this type of packaging, so it is left out. Ask your 3PL what applies.", add: { field: "packaging", label: "Change packaging" } };
    case "shipping_unknown":
      return { reason: "Needs a shipping price, and this shipment could not be priced.", add: null };
    case "assumption_missing": {
      if (rule?.tiers?.on === "monthly_quantity") return { reason: "Depends on your monthly volume.", add: null };
      const driver = rule?.basis === "order_driver" ? rule.driver : null;
      if (driver) return { reason: `Needs the number of ${driver.unit} in this order.`, add: { field: `count:${driver.key}`, label: `Add ${driver.unit}` } };
      return { reason: "Depends on information this calculator does not ask for.", add: null };
    }
    case "replaced":
      return { reason: "Replaced by another fee.", add: null };
  }
}

/**
 * The engine words an order-driver line for a share of orders ("this order is one of the 100% of orders that get
 * inserts") and names the unit in the plural even for one ("1 inserts"). In the calculator the count is this
 * order's own, so that sentence is dropped and a single unit reads in the singular ("1 insert × $0.25 = $0.25.").
 */
function boxLineExplanation(line: FeeLine, rule: FeeRule | undefined): string {
  if (line.basis !== "order_driver") return line.explanation;
  let text = line.explanation.replace(/ \(this order is one of the [^)]*\)(?=\.$)/, "");
  const unit = rule?.driver?.unit;
  if (unit && line.quantity === "1" && text.startsWith(`1 ${unit} `)) text = `1 ${singular(unit)} ${text.slice(unit.length + 3)}`;
  return text;
}

/**
 * The customer-safe view of one service's order fees: lines with their explanations, the fees left out
 * with the reason (never as $0) and what to add, and the totals. Brand callers get no rule keys; staff
 * get the key of each line and of each fee left out, and the schedule's version number.
 *
 * Money: the fee lines are exact (E4); the order-fee total and "shipping + order fees" are each rounded
 * HALF_UP to cents once from the exact sum. When any fee was left out both are "at least" figures, and
 * when nothing could be computed they are null (the view shows "Not computed", never $0.00).
 */
export function orderFeesView(args: {
  fees: OrderFeeResult;
  schedule: Pick<FeeScheduleSnapshot, "name" | "effectiveDate" | "rules"> & { versionNumber?: number };
  options: CalculatorBoxOptionsOk;
  box: CalculatorBox;
  /** The shipment's expected shipping cost (definite + estimated), dollars. */
  shippingExpected: string;
  audience: FeeAudience;
}): OrderFeesView {
  const { fees, schedule, options, box, audience } = args;
  const staff = audience === "staff";
  const rulesByKey = new Map(schedule.rules.map((r) => [r.key, r]));
  const feeE4 = fees.definiteE4 + fees.estimatedE4;
  const shippingE4 = moneyToCents(args.shippingExpected) * 100;
  const computed = fees.status !== "no_content";

  const notComputed: OrderFeeNotComputedView[] = fees.unresolved
    .filter((u) => u.reason !== "replaced")
    .map((u) => {
      const rule = rulesByKey.get(u.ruleKey);
      const wording = notComputedWording(u.reason, rule, options);
      const rate = rule ? describeFeeRule(rule).replace(SHARE_CLAUSE, "") : null;
      // A packaging type no rule prices is named by the type the customer chose, never by the sentinel behind "Another type".
      const name = u.reason === "packaging_unmatched" && u.name.toLowerCase().includes("other (not listed)") ? "Packaging (another type)" : u.name;
      return { name, ...wording, rate, ...(staff ? { ruleKey: u.ruleKey } : {}) };
    });

  const lines = fees.lines.map((l) => ({
    name: l.name,
    category: l.category,
    chargeClass: l.chargeClass,
    amount: e4ToCents(l.amountE4),
    explanation: boxLineExplanation(l, rulesByKey.get(l.ruleKey)),
    ...(staff ? { ruleKey: l.ruleKey } : {}),
  }));

  const notes = fees.warnings.map((w) => FEE_WARNING[w]).filter((t): t is string => !!t);
  // Lines are rounded for display one by one; the total is rounded once from the exact sum, so they can differ by a cent.
  const displayed = fees.lines.reduce((n, l) => n + roundE4ToCents(l.amountE4), 0);
  if (computed && displayed !== roundE4ToCents(feeE4)) notes.push("Fee lines are rounded to the cent for display; the total is rounded once from the exact amounts.");

  return {
    status: fees.status,
    schedule: { name: schedule.name, effectiveDate: schedule.effectiveDate, ...(staff && schedule.versionNumber !== undefined ? { versionNumber: schedule.versionNumber } : {}) },
    box: describeBox(box, options),
    lines,
    notComputed,
    shipping: e4ToCents(shippingE4),
    orderFees: computed ? e4ToCents(feeE4) : null,
    combined: computed ? e4ToCents(shippingE4 + feeE4) : null,
    notes,
  };
}

/**
 * Order fees for each shipping calculation of one calculator request: the fee schedule version in
 * effect on the ship date (as `loadBrandFeeSchedule` returned it) priced against the box, once per
 * service because percent-of-shipping fees read that service's shipping cost. A service that could not
 * be priced gets null (there is no "shipping + order fees" without a shipping price). When there is no
 * schedule in effect the answer says so; it is never $0.
 */
export function priceOrderFees(args: { schedule: BrandFeeSchedule; box: CalculatorBox; calculations: ShipmentCalculation[]; audience: FeeAudience }): CalculatorFeesResponse {
  const { schedule, box, calculations, audience } = args;
  if (schedule.status === "no_schedule" || schedule.status === "not_effective") return { status: schedule.status };
  if (schedule.status !== "ok") return { status: "load_failed" };
  const snapshot = schedule.activeVersion;
  const options = boxOptionsFromSnapshot(snapshot);
  const countKeys = options.counts.map((c) => c.key);
  try {
    const byService = calculations.map((calc) => {
      if (calc.status !== "ok") return null;
      const { input, context } = boxToOrderFeeInput(box, { packageCount: calc.input.packages.length, shipping: shippingInputFromCalculation(calc), showLines: options.showLines, countKeys });
      const fees = calculateOrderFees(input, snapshot, context);
      return orderFeesView({ fees, schedule: snapshot, options, box, shippingExpected: calc.totals.expected.amount, audience });
    });
    return { status: "computed", byService };
  } catch {
    // A schedule the engine cannot read must not take the shipping price down with it.
    return { status: "load_failed" };
  }
}
