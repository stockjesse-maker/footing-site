import { normalisePackaging } from "@/engine/fees";
import type { BillingPeriod, FeeBasis, FeeCategory, FeeMethod, FeeRule, FeeScope, IncludedPer } from "@/engine/fees/types";
import { rowToSnapshotRule, ruleFormToRow, snapshotRuleToForm, type FeeRuleInput } from "@/lib/fees/schema";
import { textOf } from "@/components/fees/shared";

/**
 * The rule editor's model: the form values, the presets, what each basis allows, and the function that
 * turns the form into the object `feeRuleInputSchema` validates. Pure (no React, no I/O) so the form
 * and the tests share one implementation; `rule-form.tsx` is the view over it.
 */
// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------
export interface Bracket {
  upTo: string;
  amount: string;
}

export interface Values {
  name: string;
  key: string;
  keyTouched: boolean;
  category: FeeCategory;
  scope: FeeScope;
  basis: FeeBasis;
  method: FeeMethod;
  amount: string;
  percent: string;
  percentBase: "shipping_total" | "base_freight";
  tiersOn: "order_quantity" | "monthly_quantity";
  tiersMode: "graduated" | "volume";
  tiersPricing: "rate" | "flat";
  brackets: Bracket[];
  includedQuantity: string;
  includedPer: IncludedPer;
  minimumCharge: string;
  minUnits: string;
  maxUnits: string;
  minLines: string;
  maxLines: string;
  minPackages: string;
  maxPackages: string;
  packagingTypes: string;
  exclusiveGroup: string;
  priority: string;
  driverKey: string;
  driverKeyTouched: boolean;
  driverLabel: string;
  driverUnit: string;
  driverKind: "monthly_quantity" | "returns_rate";
  /** "" = not set (a month); "month" is kept only when the stored rule has it spelled out. */
  billingPeriod: "" | BillingPeriod;
  longTerm: boolean;
  ltMode: "replace" | "surcharge";
  ltReplaces: string;
  ltDays: string;
  minAmount: string;
  minCategories: FeeCategory[];
  minInclude: string[];
  minExclude: string[];
  minShipping: boolean;
  description: string;
  helpText: string;
  source: string;
}

export const defaultBrackets = (): Bracket[] => [
  { upTo: "", amount: "" },
  { upTo: "", amount: "" },
];

export function blank(): Values {
  return {
    name: "",
    key: "",
    keyTouched: false,
    category: "pick_pack",
    scope: "order",
    basis: "order",
    method: "flat",
    amount: "",
    percent: "",
    percentBase: "shipping_total",
    tiersOn: "order_quantity",
    tiersMode: "graduated",
    tiersPricing: "rate",
    brackets: defaultBrackets(),
    includedQuantity: "",
    includedPer: "order",
    minimumCharge: "",
    minUnits: "",
    maxUnits: "",
    minLines: "",
    maxLines: "",
    minPackages: "",
    maxPackages: "",
    packagingTypes: "",
    exclusiveGroup: "",
    priority: "",
    driverKey: "",
    driverKeyTouched: false,
    driverLabel: "",
    driverUnit: "",
    driverKind: "monthly_quantity",
    billingPeriod: "",
    longTerm: false,
    ltMode: "replace",
    ltReplaces: "",
    ltDays: "180",
    minAmount: "",
    minCategories: [],
    minInclude: [],
    minExclude: [],
    minShipping: false,
    description: "",
    helpText: "",
    source: "",
  };
}

export function valuesFromRule(rule: FeeRule, source: string | null): Values {
  const f = snapshotRuleToForm(rule);
  const driver = f.driver;
  return {
    ...blank(),
    name: f.name,
    key: f.key,
    keyTouched: true,
    category: f.category,
    scope: f.scope,
    basis: f.basis,
    method: f.method,
    amount: textOf(f.amount),
    percent: textOf(f.percent),
    percentBase: f.percentBase ?? "shipping_total",
    tiersOn: f.tiers?.on ?? (f.scope === "monthly" ? "monthly_quantity" : "order_quantity"),
    tiersMode: f.tiers?.mode ?? "graduated",
    tiersPricing: f.tiers?.pricing ?? "rate",
    brackets: f.tiers ? f.tiers.brackets.map((b) => ({ upTo: b.upTo === null ? "" : textOf(b.upTo), amount: textOf(b.amount) })) : defaultBrackets(),
    includedQuantity: textOf(f.includedQuantity),
    includedPer: f.includedPer ?? "order",
    minimumCharge: textOf(f.minimumCharge),
    minUnits: textOf(f.conditions?.minUnits),
    maxUnits: textOf(f.conditions?.maxUnits),
    minLines: textOf(f.conditions?.minLines),
    maxLines: textOf(f.conditions?.maxLines),
    minPackages: textOf(f.conditions?.minPackages),
    maxPackages: textOf(f.conditions?.maxPackages),
    packagingTypes: (f.conditions?.packagingTypes ?? []).join(", "),
    exclusiveGroup: f.exclusiveGroup ?? "",
    priority: f.priority === null ? "" : String(f.priority),
    driverKey: driver?.key ?? "",
    driverKeyTouched: true,
    driverLabel: driver?.label ?? "",
    driverUnit: driver?.unit ?? "",
    driverKind: driver?.kind === "returns_rate" ? "returns_rate" : "monthly_quantity",
    billingPeriod: driver?.billingPeriod ?? "",
    longTerm: !!driver?.longTerm,
    ltMode: driver?.longTerm?.mode ?? "replace",
    ltReplaces: driver?.longTerm?.replacesRuleKey ?? "",
    ltDays: driver?.longTerm ? String(driver.longTerm.thresholdDays) : "180",
    minAmount: textOf(f.minimum?.amount),
    minCategories: f.minimum?.appliesTo.categories ?? [],
    minInclude: f.minimum?.appliesTo.includeRuleKeys ?? [],
    minExclude: f.minimum?.appliesTo.excludeRuleKeys ?? [],
    minShipping: f.minimum?.includesShipping ?? false,
    description: f.description ?? "",
    helpText: f.helpText ?? "",
    source: source ?? "",
  };
}

// ---------------------------------------------------------------------------
// What each basis allows (the schema's rules, as the form's choices)
// ---------------------------------------------------------------------------
export const ALLOWANCE_BASES: readonly FeeBasis[] = ["unit", "line", "sku", "package", "shipment", "order_driver"];
export const NO_MINIMUM_CHARGE_BASES: readonly FeeBasis[] = ["month", "minimum", "shipping_percent"];
export const MONTHLY_TIER_BASES: readonly FeeBasis[] = ["order", "unit", "package", "shipment"];
export const isDriverBasis = (basis: FeeBasis) => basis === "driver" || basis === "order_driver";

export const singular = (plural: string) => (plural.endsWith("s") && plural.length > 3 ? plural.slice(0, -1) : plural);

export function nounOf(v: Values): { singular: string; plural: string } {
  switch (v.basis) {
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
    case "order_driver":
    case "driver": {
      const plural = v.driverUnit.trim() || (v.basis === "driver" ? "units" : "inserts");
      return { singular: singular(plural), plural };
    }
    default:
      return { singular: "unit", plural: "units" };
  }
}

/** The values a rule starts with when its scope or basis changes: the same choices a new rule would offer. */
export function withBasis(v: Values, basis: FeeBasis): Values {
  const next: Values = { ...v, basis };
  if (basis === "shipping_percent") next.method = "percent";
  else if (basis === "minimum") next.method = "minimum";
  else if (basis === "month") next.method = "flat";
  else if (v.method === "percent" || v.method === "minimum") next.method = "flat";
  if (next.scope === "monthly") next.tiersOn = "monthly_quantity";
  else if (next.tiersOn === "monthly_quantity" && !MONTHLY_TIER_BASES.includes(basis)) next.tiersOn = "order_quantity";
  if (isDriverBasis(basis) && !next.driverKeyTouched && next.driverKey === "") next.driverKey = next.key;
  if (basis === "driver" && v.driverKind !== "returns_rate") next.driverKind = "monthly_quantity";
  return next;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
export interface Preset {
  id: string;
  label: string;
  hint: string;
  values: Partial<Values>;
}

export const PRESETS: Preset[] = [
  {
    id: "first_pick",
    label: "First pick included",
    hint: "A flat charge for each order that covers picking and packing its first item. Add \"Additional units\" for the rest of the items.",
    values: { name: "Pick & pack, per order", category: "pick_pack", scope: "order", basis: "order", method: "flat" },
  },
  {
    id: "additional_units",
    label: "Additional units",
    hint: "A charge for every item in an order after the first one.",
    values: { name: "Each additional item", category: "pick_pack", scope: "order", basis: "unit", method: "flat", includedQuantity: "1", includedPer: "order" },
  },
  {
    id: "per_line",
    label: "Per line, first unit of each line free",
    hint: "Charges the units beyond the first of every order line. Pair it with a \"per order line\" fee that covers each line's first unit.",
    values: { name: "Additional units within a line", category: "pick_pack", scope: "order", basis: "unit", method: "flat", includedQuantity: "1", includedPer: "line" },
  },
  {
    id: "additional_packages",
    label: "Additional packages",
    hint: "A charge for every package in an order after the first one.",
    values: { name: "Each additional package", category: "packaging", scope: "order", basis: "package", method: "flat", includedQuantity: "1", includedPer: "order" },
  },
  {
    id: "percent_shipping",
    label: "Percent of shipping",
    hint: "A percentage of each order's shipping cost, for example a handling fee. It is never shown as a per-order figure when shipping could not be priced.",
    values: { name: "Shipping handling", category: "other", scope: "order", basis: "shipping_percent", method: "percent", percentBase: "shipping_total" },
  },
  {
    id: "storage",
    label: "Monthly storage per pallet",
    hint: "Your customer states how many pallets they store on average; the fee is that number times the rate each month.",
    values: {
      name: "Pallet storage",
      category: "storage",
      scope: "monthly",
      basis: "driver",
      method: "flat",
      tiersOn: "monthly_quantity",
      driverKey: "pallets_stored",
      driverKeyTouched: true,
      driverLabel: "Pallets of your products stored, on average",
      driverUnit: "pallets",
      driverKind: "monthly_quantity",
    },
  },
  {
    id: "long_term",
    label: "Long-term storage",
    hint: "A higher rate for pallets held longer than a number of days. \"Replace\" bills those pallets at this rate instead of the standard one; \"surcharge\" adds this rate on top.",
    values: {
      name: "Long-term pallet storage",
      category: "storage",
      scope: "monthly",
      basis: "driver",
      method: "flat",
      tiersOn: "monthly_quantity",
      driverKey: "long_term_pallets",
      driverKeyTouched: true,
      driverLabel: "Of those, pallets held longer than 180 days",
      driverUnit: "pallets",
      driverKind: "monthly_quantity",
      longTerm: true,
      ltMode: "replace",
      ltDays: "180",
    },
  },
  {
    id: "receiving_pallet",
    label: "Receiving per pallet",
    hint: "Your customer states how many pallets they send in each month. This is never prefilled from what they ship.",
    values: {
      name: "Pallet receiving",
      category: "receiving",
      scope: "monthly",
      basis: "driver",
      method: "flat",
      tiersOn: "monthly_quantity",
      driverKey: "pallets_received",
      driverKeyTouched: true,
      driverLabel: "Pallets you send in each month",
      driverUnit: "pallets",
      driverKind: "monthly_quantity",
    },
  },
  {
    id: "returns",
    label: "Returns per order",
    hint: "A charge for each returned order. Your customer states how many of every 100 orders come back, and the count scales with their order volume.",
    values: {
      name: "Returns processing",
      category: "returns",
      scope: "monthly",
      basis: "driver",
      method: "flat",
      tiersOn: "monthly_quantity",
      driverKey: "returns_rate",
      driverKeyTouched: true,
      driverLabel: "Out of every 100 orders, how many come back?",
      driverUnit: "returns",
      driverKind: "returns_rate",
    },
  },
  {
    id: "minimum",
    label: "Account minimum",
    hint: "If the fees counted toward the minimum in a month add up to less than this amount, the customer is charged the difference.",
    values: { name: "Monthly account minimum", category: "account", scope: "monthly", basis: "minimum", method: "minimum" },
  },
  {
    id: "flat_monthly",
    label: "Flat monthly fee",
    hint: "A fixed amount each month, whatever the customer ships.",
    values: { name: "Account administration", category: "account", scope: "monthly", basis: "month", method: "flat" },
  },
];

// ---------------------------------------------------------------------------
// Building the schema's input from the form
// ---------------------------------------------------------------------------
export function splitTypes(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .map((t) => (t === "*" ? "*" : normalisePackaging(t)));
}

/** The object `feeRuleInputSchema` parses. Fields that do not apply to the chosen basis and method are null, so they are never sent. */
export function buildInput(v: Values): Record<string, unknown> {
  const order = v.scope === "order";
  const tiered = v.method === "tiered";
  const percent = v.method === "percent";
  const allowance = order && ALLOWANCE_BASES.includes(v.basis) && !tiered;
  const pricingLocked = v.tiersMode === "graduated" || (order && v.tiersOn === "monthly_quantity");
  const driverKind = v.basis === "order_driver" ? "order_share" : v.driverKind;
  return {
    key: v.key,
    name: v.name,
    category: v.category,
    scope: v.scope,
    basis: v.basis,
    method: v.method,
    amount: v.method === "flat" ? v.amount : null,
    percent: percent ? v.percent : null,
    percentBase: percent ? v.percentBase : null,
    tiers: tiered
      ? {
          on: order ? v.tiersOn : "monthly_quantity",
          mode: v.tiersMode,
          pricing: pricingLocked ? "rate" : v.tiersPricing,
          brackets: v.brackets.map((b, i) => ({ upTo: i === v.brackets.length - 1 ? null : b.upTo, amount: b.amount })),
        }
      : null,
    includedQuantity: allowance ? v.includedQuantity : null,
    includedPer: allowance && v.includedQuantity.trim() !== "" ? v.includedPer : null,
    minimumCharge: NO_MINIMUM_CHARGE_BASES.includes(v.basis) ? null : v.minimumCharge,
    conditions: order
      ? {
          minUnits: v.minUnits,
          maxUnits: v.maxUnits,
          minLines: v.minLines,
          maxLines: v.maxLines,
          minPackages: v.minPackages,
          maxPackages: v.maxPackages,
          packagingTypes: v.basis === "package" ? splitTypes(v.packagingTypes) : undefined,
        }
      : null,
    exclusiveGroup: order ? v.exclusiveGroup : null,
    priority: order ? v.priority : null,
    driver: isDriverBasis(v.basis)
      ? {
          key: v.driverKey,
          label: v.driverLabel,
          unit: v.driverUnit,
          kind: driverKind,
          billingPeriod: driverKind === "monthly_quantity" && v.billingPeriod !== "" ? v.billingPeriod : undefined,
          longTerm: driverKind === "monthly_quantity" && v.longTerm ? { mode: v.ltMode, replacesRuleKey: v.ltReplaces, thresholdDays: v.ltDays } : undefined,
        }
      : null,
    minimum: v.basis === "minimum" ? { amount: v.minAmount, appliesTo: { categories: v.minCategories, includeRuleKeys: v.minInclude, excludeRuleKeys: v.minExclude }, includesShipping: v.minShipping } : null,
    description: v.description,
    helpText: v.helpText,
  };
}

/** The rule as a snapshot rule (what the customer's fee schedule is generated from); null if it cannot be built. */
export function previewOf(data: FeeRuleInput, position: number): FeeRule | null {
  try {
    return rowToSnapshotRule(ruleFormToRow(data, { versionId: "preview", tenantId: "preview", position }));
  } catch {
    return null;
  }
}

/** The schema's messages that read better to the person filling the form (same meaning, same field). */
export const FRIENDLY: Record<string, string> = {
  "amount is required": "Enter the amount in dollars.",
  "percent is required": "Enter the percentage.",
  "driver.key must be a short slug": "Enter a short key of lower-case letters, digits and underscores, starting with a letter.",
  "driver.label must be 1–200 characters": "Write the question your customer answers (up to 200 characters).",
  "driver.unit must be 1–40 characters": "Enter the unit word for the answer, such as pallets (up to 40 characters).",
  "longTerm.replacesRuleKey must name another rule": "Choose the standard storage rule this one is part of.",
  "bracket edges must be numbers": "Enter the highest quantity this bracket covers.",
  "bracket amounts must be numbers with up to 4 decimals": "Enter an amount with up to 4 decimals.",
  "key must be a short slug (letters, digits, underscores)": "Use lower-case letters, digits and underscores, starting with a letter (up to 61 characters).",
  "name must be 1–120 characters": "Enter a name of up to 120 characters.",
  // Messages that name a schema field ("minUnits", "longTerm.thresholdDays") rather than the box the person sees.
  "minimum.amount must be a number with up to 4 decimals": "Enter the monthly minimum in dollars, with up to 4 decimals.",
  "minUnits exceeds maxUnits": "The fewest items cannot be more than the most items.",
  "minLines exceeds maxLines": "The fewest order lines cannot be more than the most order lines.",
  "minPackages exceeds maxPackages": "The fewest packages cannot be more than the most packages.",
  "longTerm.thresholdDays must be 1–3650": "Enter a number of days from 1 to 3650.",
  "bracket edges must ascend": "Each bracket must end higher than the one before it.",
  "exclusive group must be a short slug": "Use a short group name of lower-case letters, digits and underscores, starting with a letter.",
  "priority applies to rules in an exclusive group only": "Enter a group name above, or clear the priority.",
};
export const friendly = (message: string) => FRIENDLY[message] ?? message;

export const TOP_LABELS: Record<string, string> = {
  key: "Key",
  name: "Name",
  category: "Category",
  scope: "Charged",
  basis: "Charged per",
  method: "Pricing",
  amount: "Amount",
  percent: "Percentage",
  percentBase: "Percentage of",
  tiers: "Tiers",
  includedQuantity: "Free allowance",
  includedPer: "Free allowance",
  minimumCharge: "Minimum charge",
  conditions: "Only some orders",
  exclusiveGroup: "Alternatives",
  priority: "Alternatives",
  driver: "Question for the customer",
  minimum: "Account minimum",
  description: "Description",
  helpText: "Help for the customer",
};

