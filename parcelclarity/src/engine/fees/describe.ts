import { dec } from "../money";
import { formatPercent, formatRate } from "./calculate";
import type { FeeRule } from "./types";

/**
 * One rule in the customer's words, generated from the same fields the engine reads, so the
 * editor preview, the customer's fee-schedule view and the tests all say the same thing.
 */
export function describeFeeRule(rule: FeeRule): string {
  const money = (v: string | null | undefined) => `$${formatRate(dec(v ?? "0"))}`;
  const conditions = describeConditions(rule);
  if (rule.basis === "minimum" && rule.minimum) {
    return `If the fees counted toward the minimum in a month add up to less than ${money(rule.minimum.amount)}, the difference is charged; if they add up to more, nothing extra.${rule.minimum.includesShipping ? " Shipping charges count toward it." : ""}`;
  }
  if (rule.basis === "month") return `${money(rule.amount)} a month.`;
  if (rule.basis === "shipping_percent") return `${formatPercent(rule.percent ?? "0")} of ${rule.percentBase === "base_freight" ? "the base shipping rate" : "the shipping cost"} of each order${conditions}.`;
  const noun = nounFor(rule);
  const period = rule.driver?.billingPeriod === "week" ? " per week" : rule.driver?.billingPeriod === "day" ? " per day" : rule.scope === "monthly" ? " per month" : "";
  const minimum = rule.minimumCharge ? `, at least ${money(rule.minimumCharge)} ${rule.scope === "monthly" ? "a month" : "per order"}` : "";
  if (rule.method === "tiered" && rule.tiers) {
    const parts: string[] = [];
    let lower = 0;
    for (const b of rule.tiers.brackets) {
      const range = b.upTo === null ? `${lower + 1}+` : lower + 1 === Number(b.upTo) ? `${b.upTo}` : `${lower + 1}–${b.upTo}`;
      parts.push(rule.tiers.pricing === "flat" ? `${range} ${noun.plural}: ${money(b.amount)} flat` : `${range} ${noun.plural}: ${money(b.amount)} each`);
      lower = b.upTo === null ? lower : Number(b.upTo);
    }
    const how = rule.tiers.mode === "graduated" ? "each unit priced at its own bracket" : rule.tiers.pricing === "flat" ? "one price for the whole bracket" : "every unit at the rate of the bracket the total falls in";
    const axis = rule.tiers.on === "monthly_quantity" ? `, read against your monthly ${noun.plural}` : "";
    return `${parts.join("; ")} (${how}${axis})${minimum}${conditions}.`;
  }
  // "after the first item in each order", "after the first 3 items of each line".
  const allowanceCount = rule.includedQuantity && dec(rule.includedQuantity).gt(0) ? dec(rule.includedQuantity) : null;
  const allowanceScope = rule.includedPer === "line" ? "of each line" : rule.includedPer === "sku" ? "of each product" : rule.includedPer === "shipment" ? "in each shipment" : "in each order";
  const allowance = allowanceCount ? ` after the first ${allowanceCount.eq(1) ? noun.singular : `${allowanceCount.toFixed()} ${noun.plural}`} ${allowanceScope}` : "";
  if (rule.basis === "order_driver") return `${money(rule.amount)} per ${noun.singular}${allowance}, on the share of orders you say get them${minimum}${conditions}.`;
  if (rule.driver?.longTerm) return `${money(rule.amount)} per ${noun.singular}${period} for ${noun.plural} held longer than ${rule.driver.longTerm.thresholdDays} days${rule.driver.longTerm.mode === "replace" ? " (instead of the standard rate)" : " (in addition to the standard rate)"}${minimum}.`;
  return `${money(rule.amount)} per ${noun.singular}${period}${allowance}${minimum}${conditions}.`;
}

function nounFor(rule: FeeRule): { singular: string; plural: string } {
  if (rule.driver) {
    const unit = rule.driver.unit;
    const singular = unit.endsWith("s") && unit.length > 3 ? unit.slice(0, -1) : unit;
    return { singular, plural: unit };
  }
  switch (rule.basis) {
    case "order":
      return { singular: "order", plural: "orders" };
    case "unit":
      return { singular: "item", plural: "items" };
    case "line":
      return { singular: "order line", plural: "order lines" };
    case "sku":
      return { singular: "product", plural: "products" };
    case "package":
      return { singular: "package", plural: "packages" };
    case "shipment":
      return { singular: "shipment", plural: "shipments" };
    default:
      return { singular: "unit", plural: "units" };
  }
}

function describeConditions(rule: FeeRule): string {
  const c = rule.conditions;
  if (!c) return "";
  const parts: string[] = [];
  if (c.minUnits !== undefined && c.maxUnits !== undefined) parts.push(`orders with ${c.minUnits} to ${c.maxUnits} items`);
  else if (c.minUnits !== undefined) parts.push(`orders with ${c.minUnits} or more items`);
  else if (c.maxUnits !== undefined) parts.push(`orders with up to ${c.maxUnits} items`);
  if (c.minLines !== undefined && c.maxLines !== undefined) parts.push(`${c.minLines} to ${c.maxLines} lines`);
  else if (c.minLines !== undefined) parts.push(`${c.minLines} or more lines`);
  else if (c.maxLines !== undefined) parts.push(`up to ${c.maxLines} lines`);
  if (c.minPackages !== undefined && c.maxPackages !== undefined) parts.push(`${c.minPackages} to ${c.maxPackages} packages`);
  else if (c.minPackages !== undefined) parts.push(`${c.minPackages} or more packages`);
  else if (c.maxPackages !== undefined) parts.push(`up to ${c.maxPackages} packages`);
  if (c.packagingTypes?.length) parts.push(c.packagingTypes.includes("*") ? "any other packaging" : `packaging: ${c.packagingTypes.join(", ")}`);
  return parts.length ? `, only for ${parts.join(", ")}` : "";
}
