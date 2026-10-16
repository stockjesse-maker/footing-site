import type { FeeRule } from "@/engine/fees/types";

/**
 * What the "Try an order" panel asks for, and the object it sends to `tryFeeOrder`. Pure, so the
 * shape the panel posts is tested against the server's `tryOrderInputSchema`: an empty box means
 * unknown (null), never zero.
 */

export const MONTHLY_TIER_LABELS: Record<string, string> = { order: "Orders a month", unit: "Items a month", package: "Packages a month", shipment: "Shipments a month" };

export interface TryFields {
  units: string;
  lines: string;
  products: string;
  packages: { type: string }[];
  packagingDefault: string;
  shipments: string;
  shipTotal: string;
  baseFreight: string;
  estimated: boolean;
  /** Order-share driver key → answer. */
  shares: Record<string, { sharePct: string; count: string }>;
  shareKeys: string[];
  /** Basis → monthly volume, for rules tiered on the monthly quantity. */
  monthly: Record<string, string>;
  tierBases: string[];
  ordinal: string;
}

/** The questions this version asks: order-share drivers (key and wording) and the bases read against a monthly volume. */
export function tryOrderShape(rules: FeeRule[]): { shareDrivers: [string, string][]; tierBases: string[] } {
  const shareDrivers = [...new Map(rules.filter((r) => r.basis === "order_driver" && r.driver).map((r) => [r.driver!.key, r.driver!.label] as [string, string])).entries()];
  const tierBases = [...new Set(rules.filter((r) => r.scope === "order" && r.method === "tiered" && r.tiers?.on === "monthly_quantity").map((r) => r.basis as string))].filter((b) => b in MONTHLY_TIER_LABELS);
  return { shareDrivers, tierBases };
}

export function buildTryOrderInput(f: TryFields): Record<string, unknown> {
  return {
    units: f.units,
    lines: f.lines,
    distinctSkus: f.products,
    packages: f.packages.map((p) => ({ packagingType: p.type })),
    shipments: f.shipments,
    // Both boxes empty = the shipping cost is unknown; a base rate without a total is sent as typed so the server says what is missing.
    shipping: f.shipTotal.trim() === "" && f.baseFreight.trim() === "" ? null : { total: f.shipTotal, baseFreight: f.baseFreight, estimated: f.estimated },
    orderShares: Object.fromEntries(
      f.shareKeys.map((key) => {
        const s = f.shares[key];
        return [key, !s || (s.sharePct.trim() === "" && s.count.trim() === "") ? null : { sharePct: s.sharePct, countPerOrder: s.count }];
      }),
    ),
    monthlyQuantities: Object.fromEntries(f.tierBases.map((b) => [b, f.monthly[b] ?? ""])),
    packagingDefault: f.packagingDefault,
    ordinal: f.ordinal,
  };
}
