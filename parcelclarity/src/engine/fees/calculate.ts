import { D, dec, type Dec } from "../money";
import { fromE4, roundE4ToCents, tierAmount, toE4 } from "./tiers";
import type { E4, FeeLine, FeeRule, FeeScheduleSnapshot, FeeUnresolvedReason, OrderFeeContext, OrderFeeInput, OrderFeeResult } from "./types";

/**
 * Order-scope fees for one order (RULES.md section A). Every rule either produces a line, is
 * skipped because nothing is chargeable, or is reported as unresolved with the reason: an unknown
 * quantity with no assumption is never priced as $0.
 */

/** trim, lower case, runs of whitespace/underscores/hyphens → one space. */
export function normalisePackaging(type: string): string {
  return type.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

interface Quantity {
  value: Dec | null;
  assumed: boolean;
  unknown: FeeUnresolvedReason | null;
}

interface Unresolved {
  ruleKey: string;
  name: string;
  reason: FeeUnresolvedReason;
  replacedBy?: string;
  position: number;
}

export function calculateOrderFees(input: OrderFeeInput, schedule: FeeScheduleSnapshot, context: OrderFeeContext): OrderFeeResult {
  const lines: (FeeLine & { position: number })[] = [];
  const unresolved: Unresolved[] = [];
  const warnings = new Set<string>();
  const rules = [...schedule.rules].filter((r) => r.scope === "order").sort((a, b) => a.position - b.position);

  const count = (basis: "units" | "lines" | "skus" | "shipments" | "packages"): Quantity => {
    switch (basis) {
      case "units":
        return input.units === null ? { value: null, assumed: false, unknown: "units_unknown" } : { value: new D(input.units), assumed: !!input.assumed.units, unknown: null };
      case "lines":
        return input.lines === null ? { value: null, assumed: false, unknown: "lines_unknown" } : { value: new D(input.lines), assumed: !!input.assumed.lines, unknown: null };
      case "skus":
        return input.distinctSkus === null ? { value: null, assumed: false, unknown: "skus_unknown" } : { value: new D(input.distinctSkus), assumed: !!input.assumed.skus, unknown: null };
      case "shipments":
        return { value: new D(input.shipments), assumed: false, unknown: null };
      case "packages":
        return { value: new D(input.packages.length), assumed: false, unknown: null };
    }
  };

  // Packaging types per package, with the default applied where the file has none.
  const packageTypes = input.packages.map((p) => {
    if (p.packagingType !== null) return { type: normalisePackaging(p.packagingType), raw: p.packagingType, defaulted: false, unknown: false };
    if (context.packagingDefault) return { type: normalisePackaging(context.packagingDefault), raw: context.packagingDefault, defaulted: true, unknown: false };
    return { type: null, raw: null, defaulted: false, unknown: true };
  });
  const packagingRules = rules.filter((r) => r.conditions?.packagingTypes?.length);
  const packageMatches = (rule: FeeRule, type: string): boolean => {
    const types = rule.conditions?.packagingTypes ?? [];
    return types.includes("*") || types.includes(type);
  };

  // Exclusive groups: per package for package-basis rules, per order otherwise. Decided before amounts.
  const wonPackages = new Map<string, number[]>(); // rule key → package indexes it won
  const orderWinners = new Map<string, string>(); // group → winning key (order scope)
  const replaced = new Map<string, string>(); // losing key → winner
  const groups = new Map<string, FeeRule[]>();
  for (const r of rules) if (r.exclusiveGroup) groups.set(r.exclusiveGroup, [...(groups.get(r.exclusiveGroup) ?? []), r]);
  const byPriority = (a: FeeRule, b: FeeRule) => (a.priority ?? 0) - (b.priority ?? 0) || a.position - b.position;

  const conditionsMatchOrder = (rule: FeeRule): { ok: boolean; unknown: FeeUnresolvedReason | null; assumed: boolean } => {
    const c = rule.conditions ?? {};
    let assumed = false;
    const check = (basis: "units" | "lines" | "packages", min?: number, max?: number): { ok: boolean; unknown: FeeUnresolvedReason | null } => {
      if (min === undefined && max === undefined) return { ok: true, unknown: null };
      const q = count(basis);
      if (q.value === null) return { ok: false, unknown: q.unknown };
      assumed = assumed || q.assumed;
      if (min !== undefined && q.value.lt(min)) return { ok: false, unknown: null };
      if (max !== undefined && q.value.gt(max)) return { ok: false, unknown: null };
      return { ok: true, unknown: null };
    };
    for (const r of [check("units", c.minUnits, c.maxUnits), check("lines", c.minLines, c.maxLines), check("packages", c.minPackages, c.maxPackages)]) {
      if (r.unknown) return { ok: false, unknown: r.unknown, assumed };
      if (!r.ok) return { ok: false, unknown: null, assumed };
    }
    return { ok: true, unknown: null, assumed };
  };

  for (const [group, members] of groups) {
    const sorted = [...members].sort(byPriority);
    if (sorted.every((r) => r.basis === "package")) {
      input.packages.forEach((_, index) => {
        const pkg = packageTypes[index]!;
        if (pkg.type === null) return;
        const applicable = sorted.filter((r) => conditionsMatchOrder(r).ok && (!r.conditions?.packagingTypes?.length || packageMatches(r, pkg.type!)));
        const [winner, ...losers] = applicable;
        if (!winner) return;
        wonPackages.set(winner.key, [...(wonPackages.get(winner.key) ?? []), index]);
        for (const l of losers) if (!replaced.has(l.key)) replaced.set(l.key, winner.key);
      });
    } else {
      const applicable = sorted.filter((r) => conditionsMatchOrder(r).ok);
      const [winner, ...losers] = applicable;
      if (winner) {
        orderWinners.set(group, winner.key);
        for (const l of losers) if (!replaced.has(l.key)) replaced.set(l.key, winner.key);
      }
    }
  }

  for (const rule of rules) {
    const fail = (reason: FeeUnresolvedReason) => unresolved.push({ ruleKey: rule.key, name: rule.name, reason, position: rule.position });
    const loser = replaced.get(rule.key);
    if (loser) {
      unresolved.push({ ruleKey: rule.key, name: rule.name, reason: "replaced", replacedBy: loser, position: rule.position });
      continue;
    }
    if (rule.exclusiveGroup && rule.basis !== "package" && orderWinners.get(rule.exclusiveGroup) !== rule.key) {
      // The group had no applicable winner (conditions failed or unknown): fall through to the normal path, which reports it.
    }

    // Conditions on order quantities.
    const cond = conditionsMatchOrder(rule);
    if (cond.unknown) {
      fail(cond.unknown);
      continue;
    }
    if (!cond.ok) continue;
    let assumed = cond.assumed;

    // Quantity for the basis.
    let quantity: Dec;
    let usedPinnedRate = false;
    let explanationQuantity = "";
    switch (rule.basis) {
      case "order":
        quantity = new D(1);
        break;
      case "unit":
      case "line":
      case "sku":
      case "shipment": {
        const q = count(rule.basis === "unit" ? "units" : rule.basis === "line" ? "lines" : rule.basis === "sku" ? "skus" : "shipments");
        if (q.value === null) {
          fail(q.unknown!);
          continue;
        }
        quantity = q.value;
        assumed = assumed || q.assumed;
        break;
      }
      case "package": {
        // Packaging-conditioned rules count only the packages they match (and won); others count every package.
        if (rule.conditions?.packagingTypes?.length) {
          if (packageTypes.some((p) => p.unknown)) {
            fail("packaging_unknown");
            continue;
          }
          const indexes = rule.exclusiveGroup ? (wonPackages.get(rule.key) ?? []) : input.packages.map((_, i) => i).filter((i) => packageMatches(rule, packageTypes[i]!.type!));
          quantity = new D(indexes.length);
          if (indexes.some((i) => packageTypes[i]!.defaulted)) {
            assumed = true;
            warnings.add("packaging_defaulted");
          }
          if (input.assumed.packaging) assumed = true;
        } else quantity = new D(input.packages.length);
        break;
      }
      case "shipping_percent": {
        if (!input.shipping) {
          fail("shipping_unknown");
          continue;
        }
        const baseE4 = rule.percentBase === "base_freight" ? input.shipping.baseFreightE4 : input.shipping.totalE4;
        if (baseE4 <= 0) continue;
        const base = fromE4(baseE4);
        const amountE4 = toE4(base.times(dec(rule.percent ?? "0")).div(100));
        if (input.shipping.hasExposure) warnings.add("fee_base_excludes_exposure");
        lines.push({
          ruleKey: rule.key,
          name: rule.name,
          category: rule.category,
          basis: rule.basis,
          quantity: base.toFixed(4),
          unitAmountE4: null,
          amountE4: schedule.rounding === "transaction" ? roundE4ToCents(amountE4) : amountE4,
          chargeClass: input.shipping.estimated ? "estimated" : "definite",
          explanation: `${formatPercent(rule.percent ?? "0")} of ${rule.percentBase === "base_freight" ? "the base shipping rate" : "the shipping cost"} ($${base.toFixed(2)}).`,
          position: rule.position,
        });
        continue;
      }
      case "order_driver": {
        const key = rule.driver?.key ?? rule.key;
        const answer = context.orderShares[key];
        if (!answer) {
          fail("assumption_missing");
          continue;
        }
        const p = dec(answer.sharePct).div(100);
        const qualifies = new D(input.ordinal).times(p).floor().gt(new D(input.ordinal - 1).times(p).floor());
        quantity = qualifies ? new D(answer.countPerOrder) : new D(0);
        assumed = true;
        // A share of 100 % is every order (the calculator's case): the sentence would say nothing.
        explanationQuantity = qualifies && dec(answer.sharePct).lt(100) ? ` (this order is one of the ${formatPercent(answer.sharePct)} of orders that get ${rule.driver?.unit ?? "them"})` : "";
        break;
      }
      default:
        continue; // monthly bases never reach here
    }

    // Free allowance.
    if (rule.includedQuantity && !rule.tiers) {
      const per = rule.includedPer ?? null;
      let countPer: Quantity = { value: new D(1), assumed: false, unknown: null };
      if (per === "line") countPer = count("lines");
      else if (per === "sku") countPer = count("skus");
      else if (per === "shipment") countPer = count("shipments");
      if (countPer.value === null) {
        fail(countPer.unknown!);
        continue;
      }
      assumed = assumed || countPer.assumed;
      quantity = D.max(new D(0), quantity.minus(dec(rule.includedQuantity).times(countPer.value)));
    }
    if (quantity.lte(0)) continue;

    // Amount.
    let amount: Dec;
    let unitAmountE4: E4 | null = null;
    if (rule.method === "tiered" && rule.tiers) {
      if (rule.tiers.on === "monthly_quantity") {
        const pinned = context.pinnedRates[rule.key];
        if (!pinned) {
          fail("assumption_missing");
          continue;
        }
        amount = quantity.times(fromE4(pinned.rateE4));
        unitAmountE4 = pinned.rateE4;
        usedPinnedRate = true;
      } else {
        amount = tierAmount(rule.tiers, quantity);
        unitAmountE4 = rule.tiers.mode === "volume" && rule.tiers.pricing === "rate" ? toE4(dec(bracketAmount(rule, quantity))) : null;
      }
    } else {
      const rate = dec(rule.amount ?? "0");
      amount = quantity.times(rate);
      unitAmountE4 = toE4(rate);
    }
    if (rule.minimumCharge && amount.lt(dec(rule.minimumCharge))) amount = dec(rule.minimumCharge);
    let amountE4 = toE4(amount);
    if (schedule.rounding === "transaction") amountE4 = roundE4ToCents(amountE4);

    lines.push({
      ruleKey: rule.key,
      name: rule.name,
      category: rule.category,
      basis: rule.basis,
      quantity: quantity.toFixed(),
      unitAmountE4,
      amountE4,
      chargeClass: assumed || usedPinnedRate ? "estimated" : "definite",
      explanation: explainLine(rule, quantity, unitAmountE4, amountE4, explanationQuantity, usedPinnedRate),
      position: rule.position,
    });
  }

  // Packages whose type matches no packaging-conditioned rule at all.
  if (packagingRules.length) {
    const seen = new Set<string>();
    packageTypes.forEach((pkg) => {
      if (pkg.type === null || seen.has(pkg.type)) return;
      if (packagingRules.some((r) => packageMatches(r, pkg.type!))) return;
      seen.add(pkg.type);
      unresolved.push({ ruleKey: `packaging:${pkg.type}`, name: `Packaging (${pkg.raw})`, reason: "packaging_unmatched", position: Number.MAX_SAFE_INTEGER });
    });
  }

  lines.sort((a, b) => a.position - b.position);
  unresolved.sort((a, b) => a.position - b.position);
  const definiteE4 = lines.filter((l) => l.chargeClass === "definite").reduce((n, l) => n + l.amountE4, 0);
  const estimatedE4 = lines.filter((l) => l.chargeClass === "estimated").reduce((n, l) => n + l.amountE4, 0);
  const blocking = unresolved.filter((u) => u.reason !== "replaced");
  const status: OrderFeeResult["status"] = blocking.length === 0 ? "ok" : lines.length ? "partial" : "no_content";
  return {
    status,
    lines: lines.map(({ position: _p, ...line }) => line),
    definiteE4,
    estimatedE4,
    unresolved: unresolved.map(({ position: _p, ...u }) => u),
    warnings: [...warnings].sort(),
  };
}

function bracketAmount(rule: FeeRule, quantity: Dec): string {
  const tiers = rule.tiers!;
  for (const b of tiers.brackets) if (b.upTo === null || quantity.lte(dec(b.upTo))) return b.amount;
  return tiers.brackets[tiers.brackets.length - 1]!.amount;
}

function explainLine(rule: FeeRule, quantity: Dec, unitAmountE4: E4 | null, amountE4: E4, extra: string, pinned: boolean): string {
  const total = `$${fromE4(amountE4).toFixed(2)}`;
  const unit = unitAmountE4 === null ? null : `$${formatRate(fromE4(unitAmountE4))}`;
  const q = quantity.toFixed();
  const noun = basisNoun(rule, quantity);
  if (rule.method === "tiered" && rule.tiers && !pinned) return `${q} ${noun} priced by bracket${rule.tiers.mode === "graduated" ? " (each unit at its own bracket)" : ""}: ${total}.`;
  if (pinned) return `${q} ${noun} × ${unit} (the rate for your monthly volume): ${total}.`;
  if (rule.minimumCharge && fromE4(amountE4).eq(dec(rule.minimumCharge))) return `${q} ${noun} × ${unit}, charged at the minimum of ${total}.`;
  return `${q} ${noun} × ${unit} = ${total}${extra}.`;
}

function basisNoun(rule: FeeRule, quantity: Dec): string {
  const one = quantity.eq(1);
  switch (rule.basis) {
    case "order":
      return "order";
    case "unit":
      return one ? "item" : "items";
    case "line":
      return one ? "line" : "lines";
    case "sku":
      return one ? "product" : "products";
    case "package":
      return one ? "package" : "packages";
    case "shipment":
      return one ? "shipment" : "shipments";
    case "order_driver": {
      const unit = rule.driver?.unit;
      if (!unit) return one ? "item" : "items";
      return one && unit.endsWith("s") && unit.length > 3 ? unit.slice(0, -1) : unit;
    }
    default:
      return "";
  }
}

/** Rates print with at least two and at most four decimals, from the decimal (never a float). */
export function formatRate(value: Dec): string {
  const s = value.toFixed(4);
  return s.replace(/(\.\d\d)00$/, "$1").replace(/(\.\d\d\d)0$/, "$1");
}

export function formatPercent(percent: string): string {
  return `${dec(percent).toFixed(4).replace(/\.?0+$/, "")}%`;
}
