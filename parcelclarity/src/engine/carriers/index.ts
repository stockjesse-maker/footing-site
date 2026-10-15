import type { CarrierCode, DimRules, SurchargeCategory } from "../types";

/**
 * Carrier adapters describe STRUCTURE only: how a carrier measures and rounds, and the order in
 * which its surcharge categories are evaluated. They contain no amounts, divisors or ZIP lists;
 * those come from the 3PL's customer-facing rate card and from versioned, verified rules.
 *
 * `structuralDefaults` are starting points offered when a 3PL sets up service terms. They are
 * labelled "verify against the carrier's current service guide" in the UI and recorded as
 * `unverified` until the 3PL approves them; the engine itself only ever reads ServiceTerms.
 */
export interface CarrierProfile {
  code: CarrierCode;
  name: string;
  structuralDefaults: Omit<DimRules, "divisor">;
  /** Evaluation order of surcharge categories. Fuel is always last regardless of this list. */
  categoryOrder: SurchargeCategory[];
  /** Known mutually-exclusive groups for this carrier, for the rule editor's guidance only. */
  knownExclusivityGroups: { group: string; description: string }[];
  notes: string[];
}

const COMMON_ORDER: SurchargeCategory[] = [
  "residential",
  "das",
  "das_extended",
  "remote_area",
  "additional_handling",
  "oversize",
  "signature",
  "saturday_delivery",
  "declared_value",
  "peak",
  "other",
  "address_correction",
  "reweight",
  "remeasure",
  "shipping_charge_correction",
  "fuel",
];

const parcelDefaults: Omit<DimRules, "divisor"> = {
  thresholdCubicIn: null,
  dimensionRounding: "nearest_whole",
  weightRounding: "up_whole_lb",
  minBillableLb: null,
  exempt: false,
};

export const UPS: CarrierProfile = {
  code: "ups",
  name: "UPS",
  structuralDefaults: parcelDefaults,
  categoryOrder: COMMON_ORDER,
  knownExclusivityGroups: [
    { group: "ups.handling_vs_large_package", description: "Additional Handling and Large Package are mutually exclusive; Large Package takes precedence." },
    { group: "ups.das", description: "DAS, DAS Extended and Remote Area are mutually exclusive; the most remote tier applies." },
  ],
  notes: ["Structural defaults: dimensions rounded to the nearest whole inch, billable weight rounded up to the next whole pound. Verify against the current UPS Rate and Service Guide."],
};

export const FEDEX: CarrierProfile = {
  code: "fedex",
  name: "FedEx",
  structuralDefaults: parcelDefaults,
  categoryOrder: COMMON_ORDER,
  knownExclusivityGroups: [
    { group: "fedex.handling_vs_oversize", description: "Additional Handling and Oversize are mutually exclusive; Oversize takes precedence." },
    { group: "fedex.das", description: "DAS tiers (Contiguous, Extended, Remote, Alaska/Hawaii) are mutually exclusive." },
  ],
  notes: ["Structural defaults: dimensions rounded to the nearest whole inch, billable weight rounded up to the next whole pound. Verify against the current FedEx Service Guide."],
};

export const USPS: CarrierProfile = {
  code: "usps",
  name: "USPS",
  structuralDefaults: { ...parcelDefaults, weightRounding: "up_whole_oz", thresholdCubicIn: "1728" },
  categoryOrder: COMMON_ORDER,
  knownExclusivityGroups: [],
  notes: [
    "Structural defaults: weights under 1 lb are billed in whole ounces; dimensional weight applies only above one cubic foot (1,728 cubic inches) for the services that use it. Verify against the current USPS Price List (Notice 123).",
  ],
};

export const DHL_ECOMMERCE: CarrierProfile = {
  code: "dhl_ecommerce",
  name: "DHL eCommerce",
  structuralDefaults: { ...parcelDefaults, weightRounding: "up_whole_oz" },
  categoryOrder: COMMON_ORDER,
  knownExclusivityGroups: [],
  notes: ["Structural defaults: ounce-based weight tiers for lightweight parcels. Verify against the current DHL eCommerce Americas rate guide."],
};

export const GENERIC: CarrierProfile = {
  code: "generic",
  name: "Other carrier",
  structuralDefaults: parcelDefaults,
  categoryOrder: COMMON_ORDER,
  knownExclusivityGroups: [],
  notes: ["No carrier-specific defaults; configure every service term explicitly."],
};

const PROFILES: Record<string, CarrierProfile> = { ups: UPS, fedex: FEDEX, usps: USPS, dhl_ecommerce: DHL_ECOMMERCE };

export function carrierProfile(code: CarrierCode): CarrierProfile {
  return PROFILES[code] ?? GENERIC;
}

export function categoryRank(code: CarrierCode, category: SurchargeCategory | "base"): number {
  if (category === "base") return -1;
  const idx = carrierProfile(code).categoryOrder.indexOf(category);
  return idx === -1 ? 999 : idx;
}
