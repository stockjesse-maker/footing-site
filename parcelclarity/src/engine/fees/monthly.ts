import { D, dec, type Dec } from "../money";
import { formatRate } from "./calculate";
import { e4ToCents, fromE4, tierAmount, toE4 } from "./tiers";
import type { E4, FeeRule, FeeScheduleSnapshot, FulfillmentAnswers, MinimumResult, MonthBucket, MonthlyFeeLine, MonthlyFeeResult, MonthlyNotModeled } from "./types";

/**
 * Monthly-scope fees from the customer's stated quantities (RULES.md section B) and the account
 * minimums over calendar-month buckets (section C). A question that was not answered leaves its
 * fee "not modeled" with the rate shown; "0" models it at zero.
 */

const DAYS_PER_MONTH = new D("30.4375");

export function calculateMonthlyFees(answers: FulfillmentAnswers, schedule: FeeScheduleSnapshot, monthlyOrders: Dec | null): MonthlyFeeResult {
  const rules = [...schedule.rules].filter((r) => r.scope === "monthly" && r.basis !== "minimum").sort((a, b) => a.position - b.position);
  const lines: MonthlyFeeLine[] = [];
  const notModeled: MonthlyNotModeled[] = [];
  const readKeys = new Set<string>();

  // Long-term "replace" rules reduce the quantity of the rule they replace.
  const replacements = new Map<string, Dec>(); // replaced rule key → quantity to subtract
  for (const rule of rules) {
    const lt = rule.driver?.longTerm;
    if (!lt || lt.mode !== "replace") continue;
    const answer = answers.drivers[rule.driver!.key];
    if (answer === null || answer === undefined) continue;
    replacements.set(lt.replacesRuleKey, (replacements.get(lt.replacesRuleKey) ?? new D(0)).plus(dec(answer)));
  }

  for (const rule of rules) {
    const describe = describeMonthlyRate(rule);
    if (rule.basis === "month") {
      const amountE4 = toE4(dec(rule.amount ?? "0"));
      lines.push({ ruleKey: rule.key, name: rule.name, category: rule.category, driverKey: null, quantity: "1", unitAmountE4: amountE4, amountE4, chargeClass: "definite", scalesWithVolume: false, explanation: `$${fromE4(amountE4).toFixed(2)} a month.` });
      continue;
    }
    if (rule.basis !== "driver" || !rule.driver) continue;
    const driver = rule.driver;
    readKeys.add(driver.key);
    const notModeledEntry = (reason: MonthlyNotModeled["reason"]) => notModeled.push({ ruleKey: rule.key, name: rule.name, category: rule.category, driverKey: driver.key, reason, describe });

    let quantity: Dec;
    let scalesWithVolume = false;
    if (driver.kind === "returns_rate") {
      const answer = answers.drivers[driver.key];
      if (answer === null || answer === undefined) {
        notModeledEntry("no_answer");
        continue;
      }
      if (monthlyOrders === null) {
        notModeledEntry("volume_unknown");
        continue;
      }
      quantity = monthlyOrders.times(dec(answer)).div(100);
      scalesWithVolume = true;
    } else {
      const answer = answers.drivers[driver.key];
      if (answer === null || answer === undefined) {
        notModeledEntry("no_answer");
        continue;
      }
      quantity = dec(answer);
      if (driver.longTerm) {
        const replaced = rules.find((r) => r.key === driver.longTerm!.replacesRuleKey);
        if (!replaced) {
          notModeledEntry("replaced_rule_missing");
          continue;
        }
        const stored = answers.drivers[replaced.driver?.key ?? ""];
        if (driver.longTerm.mode === "replace" && stored !== null && stored !== undefined && quantity.gt(dec(stored))) {
          throw new RangeError(`long-term quantity for ${rule.key} (${quantity.toFixed()}) exceeds the stored quantity (${stored})`);
        }
      }
      const subtract = replacements.get(rule.key);
      if (subtract) quantity = D.max(new D(0), quantity.minus(subtract));
      if (driver.billingPeriod === "week") quantity = quantity.times(DAYS_PER_MONTH).div(7);
      else if (driver.billingPeriod === "day") quantity = quantity.times(DAYS_PER_MONTH);
    }

    let amount: Dec;
    let unitAmountE4: E4 | null;
    if (rule.method === "tiered" && rule.tiers) {
      amount = tierAmount(rule.tiers, quantity);
      unitAmountE4 = null;
    } else {
      const rate = dec(rule.amount ?? "0");
      amount = quantity.times(rate);
      unitAmountE4 = toE4(rate);
    }
    if (rule.minimumCharge && quantity.gt(0) && amount.lt(dec(rule.minimumCharge))) amount = dec(rule.minimumCharge);
    const amountE4 = toE4(amount);
    lines.push({
      ruleKey: rule.key,
      name: rule.name,
      category: rule.category,
      driverKey: driver.key,
      quantity: quantity.toFixed(),
      unitAmountE4,
      amountE4,
      chargeClass: "estimated",
      scalesWithVolume,
      explanation: explainMonthly(rule, quantity, unitAmountE4, amountE4),
    });
  }

  const unusedAnswers = Object.keys(answers.drivers).filter((k) => !readKeys.has(k) && answers.drivers[k] !== null && answers.drivers[k] !== undefined).sort();
  return { lines, notModeled, unusedAnswers, totalE4: lines.reduce((n, l) => n + l.amountE4, 0) };
}

function explainMonthly(rule: FeeRule, quantity: Dec, unitAmountE4: E4 | null, amountE4: E4): string {
  const total = `$${fromE4(amountE4).toFixed(2)}`;
  const unit = rule.driver?.unit ?? "units";
  const q = quantity.toDecimalPlaces(4, D.ROUND_HALF_UP).toFixed();
  const period = rule.driver?.billingPeriod === "week" ? " (per week, converted to a month)" : rule.driver?.billingPeriod === "day" ? " (per day, converted to a month)" : "";
  if (unitAmountE4 === null) return `${q} ${unit} priced by bracket: ${total} a month.`;
  if (rule.minimumCharge && fromE4(amountE4).eq(dec(rule.minimumCharge)) && quantity.gt(0)) return `${q} ${unit} × $${formatRate(fromE4(unitAmountE4))}, charged at the minimum of ${total} a month.`;
  return `${q} ${unit} × $${formatRate(fromE4(unitAmountE4))}${period} = ${total} a month.`;
}

/** The rate in words, for "add numbers" prompts: "$15.00 per pallet per month". */
export function describeMonthlyRate(rule: FeeRule): string {
  const unit = rule.driver?.unit ?? "month";
  const per = rule.driver?.billingPeriod === "week" ? "week" : rule.driver?.billingPeriod === "day" ? "day" : "month";
  if (rule.basis === "month") return `$${formatRate(dec(rule.amount ?? "0"))} a month`;
  if (rule.method === "tiered" && rule.tiers) return `priced by bracket per ${singular(unit)} per ${per}`;
  return `$${formatRate(dec(rule.amount ?? "0"))} per ${singular(unit)} per ${per}${rule.minimumCharge ? ` (minimum $${formatRate(dec(rule.minimumCharge))} a month)` : ""}`;
}

function singular(unit: string): string {
  return unit.endsWith("s") && unit.length > 3 ? unit.slice(0, -1) : unit;
}

// ---------------------------------------------------------------------------
// Minimums
// ---------------------------------------------------------------------------

/** What an account-minimum member is called when its rule is no longer in the schedule. A rule key is for staff only. */
export const NOT_IN_SCHEDULE_NAME = "a rule no longer in the schedule";
/**
 * What every customer screen prints for such a member, whatever name a stored summary carries (a summary stored before
 * the engine named it neutrally holds the rule's key as its name).
 */
export const MINIMUM_MEMBER_GONE_LABEL = "A charge that is no longer on the fee schedule";

export function evaluateMinimums(buckets: MonthBucket[], schedule: FeeScheduleSnapshot, monthly: MonthlyFeeResult): MinimumResult[] {
  const minimums = schedule.rules.filter((r) => r.basis === "minimum" && r.minimum).sort((a, b) => a.position - b.position);
  const ruleByKey = new Map(schedule.rules.map((r) => [r.key, r]));
  const monthlyByKey = new Map(monthly.lines.map((l) => [l.ruleKey, l]));
  const notModeledKeys = new Set(monthly.notModeled.map((n) => n.ruleKey));
  return minimums.map((rule) => {
    const members = rule.resolvedRuleKeys ?? [];
    const amount = dec(rule.minimum!.amount);
    const reasons: string[] = [];
    const unresolvedInBuckets = new Set(buckets.flatMap((b) => b.unresolvedRuleKeys ?? []));
    const memberStates = members.map((key) => {
      const member = ruleByKey.get(key);
      // The member's name is a neutral label, never its key: this name is stored in summaries and printed by customer screens.
      if (!member) return { ruleKey: key, name: NOT_IN_SCHEDULE_NAME, state: "not_in_schedule" as const };
      const state = notModeledKeys.has(key) || unresolvedInBuckets.has(key) ? ("not_modeled" as const) : ("priced" as const);
      if (state === "not_modeled") reasons.push(`${member.name} not modeled`);
      return { ruleKey: key, name: member.name, state };
    });
    const bucketResults = buckets.map((b) => {
      const f = dec(b.fraction);
      const scaled = b.modeledOrders > 0 && b.shippedOrders > b.modeledOrders;
      // Coverage extrapolation: (E4 × shipped) / modeled, rounded to cents once (the SQL recomputation does the same arithmetic).
      const scale = (e4: E4): E4 => (scaled ? centsE4(new D(e4).times(b.shippedOrders).div(b.modeledOrders)) : centsE4(new D(e4)));
      if (b.shippedOrders > b.modeledOrders) reasons.push(`coverage ${pct(b.modeledOrders, b.shippedOrders)} in ${b.month}`);
      let counted = 0;
      for (const key of members) {
        const member = ruleByKey.get(key);
        if (!member) continue;
        if (member.scope === "order") counted += scale(b.orderVariableByRuleE4[key] ?? 0);
        else {
          const line = monthlyByKey.get(key);
          if (line) counted += centsE4(new D(line.amountE4).times(f));
        }
      }
      if (rule.minimum!.includesShipping) counted += scale(b.shippingExpectedE4);
      const minimumE4 = centsE4(amount.times(10000).times(f));
      const topUpE4 = Math.max(0, minimumE4 - counted);
      return { month: b.month, minimumE4, countedE4: counted, topUpE4 };
    });
    const status: MinimumResult["status"] = buckets.length === 0 ? "not_computed" : reasons.length ? "upper_bound" : "exact";
    return {
      ruleKey: rule.key,
      name: rule.name,
      minimumE4: bucketResults.reduce((n, b) => n + b.minimumE4, 0),
      topUpE4: bucketResults.reduce((n, b) => n + b.topUpE4, 0),
      countedE4: bucketResults.reduce((n, b) => n + b.countedE4, 0),
      includesShipping: rule.minimum!.includesShipping,
      status,
      reasons: [...new Set(reasons)],
      members: memberStates,
      buckets: bucketResults,
    };
  });
}

function pct(n: number, d: number): string {
  return `${new D(n).times(100).div(d).toDecimalPlaces(1, D.ROUND_HALF_UP).toFixed(1)}%`;
}

/** An E4 amount (possibly fractional) rounded once, HALF_UP, to a whole number of cents. */
function centsE4(e4: Dec): E4 {
  return e4.div(100).toDecimalPlaces(0, D.ROUND_HALF_UP).times(100).toNumber();
}

export { e4ToCents };
