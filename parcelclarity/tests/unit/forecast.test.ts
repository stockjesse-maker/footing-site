import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allInAtVolumes,
  buildGrid,
  canonicalAssumptions,
  canonicalizeAssumptions,
  contentRows,
  evaluateForecast,
  forecastPinnedRates,
  validateForecastAssumptions,
  FORECAST_LIMITS,
  type ForecastAssumptions,
  type ForecastDeps,
  type ForecastSummary,
} from "@/engine/forecast";
import { X } from "@/engine/forecast/grid";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { ENGINE_VERSION } from "@/engine/types";
import { hashAssumptions, sha256Hex } from "@/lib/forecast/hash";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * Property tests for the forecast engine (design §7). Expectations are derived by hand from the
 * fixture rate card, the "standard" fee schedule and RULES.md; the golden 2×2×1×1 fixture lives in
 * tests/unit/forecast-golden.test.ts.
 *
 * Fixture facts used below: UPS Ground zone 2, 1 lb = $7.90 with an $8.50 service minimum, fuel
 * 14% (to 2026-09-30), residential $5.00, address correction $21.00 conditional on every UPS
 * shipment; USPS Ground Advantage rows are priced per origin prefix 900. Standard schedule: $2.50
 * per order, $0.50 per additional item, box $0.85 / poly mailer $0.30 per package, inserts $0.25
 * each after the first, 5% handling on shipping, pallets $15 (long-term $22 replaces), pallet
 * receiving $12, cartons $0.35, returns $3.00 each, admin $99 a month, $500 minimum over pick/pack,
 * packaging, storage and receiving.
 */

const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;

const UPS_GROUND = { serviceId: "svc-ups-ground", carrierCode: "ups", serviceCode: "ground", name: "UPS Ground" };
const USPS_GA = { serviceId: "svc-usps-ga", carrierCode: "usps", serviceCode: "ground_advantage", name: "USPS Ground Advantage" };

function base(over: Partial<ForecastAssumptions> = {}): ForecastAssumptions {
  return {
    version: 1,
    monthlyOrders: "1250",
    asOfDate: "2026-03-15",
    originZip: "90001",
    parcels: [
      { weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packagingType: "box", sharePct: "60" },
      { weightLb: "0.5", packagingType: "poly mailer", sharePct: "40", unknownSize: true },
    ],
    zones: [
      { zone: "2", sharePct: "50" },
      { zone: "5", sharePct: "30" },
      { zone: "8", sharePct: "20" },
    ],
    services: [
      { ...UPS_GROUND, sharePct: "70" },
      { ...USPS_GA, sharePct: "30" },
    ],
    residentialPct: "80",
    multiPackage: { pct: "10", packagesPerOrder: 2 },
    content: { rows: [{ units: 1, lines: 1, sharePct: "60" }, { units: 3, lines: 2, sharePct: "40" }] },
    fulfillment: {
      drivers: { pallets_stored: "10", long_term_pallets: "2", pallets_received: "4", cases_received: "20", returns_rate: "3" },
      orderShares: { inserts: { sharePct: "40", countPerOrder: 2 } },
      packagingDefault: null,
    },
    ...over,
  };
}

function deps(over: Partial<ForecastDeps> = {}): ForecastDeps {
  return { pricing: fixtureContext(), schedule: standard, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex, ...over };
}

function ok(assumptions: ForecastAssumptions, d: ForecastDeps = deps(), options?: { priceOnlyCovered?: boolean }): ForecastSummary {
  const result = evaluateForecast(assumptions, d, options);
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.summary;
}

const money = (s: string) => new X(s);
const rule = (summary: ForecastSummary, key: string) => summary.processing?.byRule.find((r) => r.key === key);
const category = (summary: ForecastSummary, name: string) => summary.completeness.find((c) => c.category === name)!;

/** Thirds that add up to exactly 100.00. */
const THIRDS = ["33.33", "33.33", "33.34"];

describe("forecast grid: weights", () => {
  for (const monthlyOrders of ["1", "3", "3333", "5000000"]) {
    it(`cell weights add up to exactly ${monthlyOrders} orders`, () => {
      const a = canonicalizeAssumptions(
        base({
          monthlyOrders,
          parcels: THIRDS.map((sharePct, i) => ({ weightLb: `${i + 1}.25`, packagingType: "box", sharePct, unknownSize: true })),
          zones: THIRDS.map((sharePct, i) => ({ zone: String(i + 2), sharePct })),
          residentialPct: "33.33",
          multiPackage: { pct: "0.01", packagesPerOrder: 3 },
        }),
      );
      const grid = buildGrid(a);
      expect(grid.counts.cells).toBe(3 * 3 * 2 * 2 * 2);
      expect(grid.weightSum).toBe(monthlyOrders);
      const sum = grid.cells.reduce((s, c) => s.plus(c.weight), new X(0));
      expect(sum.toFixed()).toBe(monthlyOrders);
      // Every cell is a product of the stated shares, exactly: first parcel (33.33%), zone 2 (33.33%), UPS Ground (70%), commercial (66.67%), one package (99.99%).
      const first = grid.cells[0]!;
      expect(first.key).toBe("svc-ups-ground|2|p0|com|k1");
      expect(first.weight).toBe(new X(monthlyOrders).times("0.3333").times("0.3333").times("0.7").times("0.6667").times("0.9999").toFixed());
    });
  }

  it("collapses the residential and package dimensions when a share is 0 or 100", () => {
    expect(buildGrid(canonicalizeAssumptions(base({ residentialPct: "0", multiPackage: { pct: "0", packagesPerOrder: 2 } }))).counts).toEqual({ parcels: 2, zones: 3, services: 2, residentialSplits: 1, packageClasses: 1, cells: 12 });
    const all = buildGrid(canonicalizeAssumptions(base({ residentialPct: "100", multiPackage: { pct: "100", packagesPerOrder: 4 } })));
    expect(all.counts.cells).toBe(12);
    expect(all.cells.every((c) => c.residential && c.packages === 4)).toBe(true);
    expect(all.weightSum).toBe("1250");
  });

  it("evaluates the summary with weightSum equal to monthlyOrders for 1 and 5,000,000 orders", () => {
    for (const monthlyOrders of ["1", "5000000"]) {
      const summary = ok(base({ monthlyOrders }));
      expect(summary.weightSum).toBe(monthlyOrders);
      expect(summary.pricedWeight).toBe(monthlyOrders);
      expect(summary.cells.reduce((s, [, w]) => s.plus(w), new X(0)).toFixed()).toBe(monthlyOrders);
    }
  });
});

describe("forecast canonical form and hash", () => {
  const shuffled = (): ForecastAssumptions => {
    const a = base();
    return {
      ...a,
      monthlyOrders: "001250",
      parcels: [...a.parcels].reverse().map((p) => ({ ...p, sharePct: p.sharePct === "60" ? "60.00" : "40.0", weightLb: p.weightLb === "1" ? "1.0000" : p.weightLb })),
      zones: [a.zones[2]!, a.zones[0]!, a.zones[1]!].map((z) => ({ ...z, zone: ` zone ${z.zone} ` })),
      services: [...a.services].reverse(),
      content: { rows: [...(a.content as { rows: ForecastAssumptions["content"] extends { rows: infer R } ? R : never }).rows].reverse() },
      fulfillment: {
        orderShares: { inserts: { countPerOrder: 2, sharePct: "40.00" } },
        drivers: { returns_rate: "3.0", cases_received: "20", pallets_received: "4", long_term_pallets: "2", pallets_stored: "10.00" },
        packagingDefault: null,
      },
    };
  };

  it("hashes shuffled rows and differently formatted numbers to the same value", () => {
    expect(canonicalAssumptions(shuffled())).toBe(canonicalAssumptions(base()));
    expect(hashAssumptions(shuffled())).toBe(hashAssumptions(base()));
    expect(hashAssumptions(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAssumptions(base({ monthlyOrders: "1251" }))).not.toBe(hashAssumptions(base()));
  });

  it("produces byte-identical output under shuffles of parcels, zones, services and content rows", () => {
    const one = ok(base());
    const two = ok(shuffled());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.assumptionsHash).toBe(hashAssumptions(base()));
    // Zones are normalised and sorted, parcels sorted by weight.
    expect(one.profile.zones.map((z) => z.zone)).toEqual(["2", "5", "8"]);
    expect(one.profile.parcels.map((p) => p.weightLb)).toEqual(["0.5", "1"]);
  });

  it("splits averages two-point and couples lines with items", () => {
    expect(contentRows({ averageUnits: "1.4", averageLines: "1" })).toEqual([
      { units: 1, lines: 1, sharePct: "60" },
      { units: 2, lines: 1, sharePct: "40" },
    ]);
    expect(contentRows({ averageUnits: "1.9", averageLines: "1.2" })).toEqual([
      { units: 1, lines: 1, sharePct: "10" },
      { units: 2, lines: 1, sharePct: "70" },
      { units: 2, lines: 2, sharePct: "20" },
    ]);
    expect(contentRows({ averageUnits: "2.1", averageLines: "1.9" })).toEqual([
      { units: 2, lines: 1, sharePct: "10" },
      { units: 2, lines: 2, sharePct: "80" },
      { units: 3, lines: 2, sharePct: "10" },
    ]);
    expect(contentRows({ averageUnits: "2", averageLines: "1" })).toEqual([{ units: 2, lines: 1, sharePct: "100" }]);
    expect(contentRows({ averageUnits: "1.2345", averageLines: "1" })).toEqual([
      { units: 1, lines: 1, sharePct: "76.55" },
      { units: 2, lines: 1, sharePct: "23.45" },
    ]);
    for (const rows of [contentRows({ averageUnits: "1.9", averageLines: "1.2" }), contentRows({ averageUnits: "2.1", averageLines: "1.9" })]) {
      expect(rows.reduce((s, r) => s.plus(r.sharePct), new X(0)).toFixed()).toBe("100");
      expect(rows.every((r) => r.lines <= r.units)).toBe(true);
    }
    // The split reproduces both averages exactly.
    const rows = contentRows({ averageUnits: "1.9", averageLines: "1.2" });
    expect(rows.reduce((s, r) => s.plus(new X(r.units).times(r.sharePct)), new X(0)).div(100).toFixed()).toBe("1.9");
    expect(rows.reduce((s, r) => s.plus(new X(r.lines).times(r.sharePct)), new X(0)).div(100).toFixed()).toBe("1.2");
  });
});

describe("forecast validation", () => {
  it("rejects averageLines above averageUnits", () => {
    const problems = validateForecastAssumptions(base({ content: { averageUnits: "1.2", averageLines: "1.5" } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("lines");
    const result = evaluateForecast(base({ content: { averageUnits: "1.2", averageLines: "1.5" } }), deps());
    expect(result.status).toBe("invalid");
  });

  it("rejects distributions that do not add up to exactly 100.00 and never rescales them", () => {
    const parcels = validateForecastAssumptions(base({ parcels: [{ weightLb: "1", packagingType: "box", sharePct: "60", unknownSize: true }, { weightLb: "2", packagingType: "box", sharePct: "30", unknownSize: true }] }));
    expect(parcels).toEqual(["parcels: shares add up to 90.00%, not 100.00%"]);
    expect(validateForecastAssumptions(base({ zones: [{ zone: "2", sharePct: "50" }, { zone: "5", sharePct: "50.01" }] }))).toEqual(["zones: shares add up to 100.01%, not 100.00%"]);
    expect(validateForecastAssumptions(base({ services: [{ ...UPS_GROUND, sharePct: "99.99" }] }))).toEqual(["services: shares add up to 99.99%, not 100.00%"]);
    expect(validateForecastAssumptions(base({ content: { rows: [{ units: 1, lines: 1, sharePct: "50" }, { units: 2, lines: 2, sharePct: "49.99" }] } }))).toEqual(["content.rows: shares add up to 99.99%, not 100.00%"]);
    expect(validateForecastAssumptions(base({ zones: [{ zone: "2", sharePct: "33.333" }, { zone: "5", sharePct: "66.667" }] }))[0]).toContain("up to 2 decimals");
    expect(validateForecastAssumptions(base())).toEqual([]);
  });

  it("rejects more than 1,500 cells and names the product", () => {
    const parcels = Array.from({ length: 14 }, (_, i) => ({ weightLb: `${i + 1}`, packagingType: "box", sharePct: i === 13 ? "7.18" : "7.14", unknownSize: true }));
    const zones = Array.from({ length: 6 }, (_, i) => ({ zone: String(i + 2), sharePct: i === 5 ? "16.70" : "16.66" }));
    const services = Array.from({ length: 10 }, (_, i) => ({ ...UPS_GROUND, serviceId: `svc-${i}`, serviceCode: `code-${i}`, sharePct: "10" }));
    const problems = validateForecastAssumptions(base({ parcels, zones, services }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("14 parcels × 6 zones × 10 services × 2 residential splits × 2 package classes = 3,360 cells");
    expect(problems[0]).toContain("1,500");
    // Collapsing the residential split brings the same rows under the limit.
    expect(validateForecastAssumptions(base({ parcels, zones, services, residentialPct: "100", multiPackage: { pct: "0", packagesPerOrder: 2 } }))).toEqual([]);
    expect(FORECAST_LIMITS.cells).toBe(1500);
  });

  it("rejects malformed inputs with plain-language problems", () => {
    expect(validateForecastAssumptions(base({ monthlyOrders: "0" }))[0]).toContain("monthlyOrders");
    expect(validateForecastAssumptions(base({ monthlyOrders: "12.5" }))[0]).toContain("whole number");
    expect(validateForecastAssumptions(base({ monthlyOrders: "5000001" }))[0]).toContain("5,000,000");
    expect(validateForecastAssumptions(base({ multiPackage: { pct: "10", packagesPerOrder: 1 } }))[0]).toContain("multiPackage.packagesPerOrder");
    expect(validateForecastAssumptions(base({ zones: [{ zone: "2", sharePct: "50" }, { zone: "Zone 2", sharePct: "50" }] }))[0]).toContain("listed twice");
    expect(validateForecastAssumptions(base({ asOfDate: "2026-02-30" }))[0]).toContain("real calendar date");
    expect(validateForecastAssumptions({ ...base(), version: 2 })[0]).toContain("version");
    expect(validateForecastAssumptions({ ...base(), extra: true })[0]).toContain("extra");
    expect(validateForecastAssumptions(base({ parcels: [{ weightLb: "1", lengthIn: "10", packagingType: null, sharePct: "100" }] }))[0]).toContain("all three dimensions");
    expect(validateForecastAssumptions(base({ parcels: [{ weightLb: "1", packagingType: null, sharePct: "100", unknownSize: true }, { weightLb: "1", packagingType: null, sharePct: "0", unknownSize: true }] }))[0]).toContain("greater than zero");
    expect(validateForecastAssumptions(base({ fulfillment: { drivers: { pallets_stored: "abc" }, orderShares: {} } }))[0]).toContain("pallets_stored");
    expect(validateForecastAssumptions(base({ fulfillment: { drivers: {}, orderShares: { inserts: { sharePct: "101", countPerOrder: 1 } } } }))[0]).toContain("at most 100");
    expect(validateForecastAssumptions(null)).toHaveLength(1);
  });

  it("requires a size, or 'unknown size', where a selected service bills dimensional weight", () => {
    const result = evaluateForecast(base({ parcels: [{ weightLb: "1", packagingType: "box", sharePct: "100" }] }), deps());
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.problems[0]).toContain("I don't know the size");
  });

  it("explains a long-term storage answer above the stored quantity in the rule's words", () => {
    const result = evaluateForecast(base({ fulfillment: { ...base().fulfillment, drivers: { ...base().fulfillment.drivers, long_term_pallets: "12" } } }), deps());
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.problems[0]).toContain("Long-term pallet storage");
      expect(result.problems[0]).not.toContain("storage_long_term");
    }
  });
});

describe("forecast evaluation", () => {
  it("prices every cell as an estimate: definite is 0.00 for shipping and processing", () => {
    const summary = ok(base());
    expect(summary.shipping.definite).toBe("0.00");
    expect(summary.processing?.definite).toBe("0.00");
    expect(summary.basis).toBe("assumptions");
    expect(summary.version).toBe(2);
    expect(summary.monthlyOrders).toBe("1250");
    expect(summary.weightSum).toBe("1250");
    expect(summary.cells).toHaveLength(48);
    expect(summary.cells.every(([, , e4]) => e4 !== null && e4 > 0)).toBe(true);
    expect(summary.unpriceable).toEqual([]);
    expect(summary.complete).toBe(true);
  });

  it("prices a known cell exactly: UPS Ground zone 2, 1 lb, commercial, one box", () => {
    const summary = ok(base());
    const cell = summary.cells.find(([key]) => key === "svc-ups-ground|2|p1|com|k1")!;
    // Parcel index 1 is the 1 lb box after canonical sorting (0.5 lb mailer first). Weight 1250 × 0.6 × 0.5 × 0.7 × 0.2 × 0.9 = 47.25 orders.
    expect(cell[1]).toBe("47.25");
    // 10×8×4 in = 320 in³ / 139 = 2.3 → 3 lb billable: $8.52 bracket (above the $8.50 minimum), fuel 14% = 1.19 → 9.71.
    expect(cell[2]).toBe(97100);
    const twoBoxes = summary.cells.find(([key]) => key === "svc-ups-ground|2|p1|com|k2")!;
    expect(twoBoxes[1]).toBe("5.25");
    expect(twoBoxes[2]).toBe(194200);
    const residential = summary.cells.find(([key]) => key === "svc-ups-ground|2|p1|res|k1")!;
    // + $5.00 residential, fuel on 13.52 = 1.89 → 15.41.
    expect(residential[2]).toBe(154100);
    // The 0.5 lb mailer of unknown size bills on actual weight: $7.90 → $8.50 minimum, fuel 1.19 → 9.69.
    expect(summary.cells.find(([key]) => key === "svc-ups-ground|2|p0|com|k1")![2]).toBe(96900);
  });

  it("gives $0.20 per order for a $0.50 additional-item rule at an average of 1.4 items", () => {
    const summary = ok(base({ content: { averageUnits: "1.4", averageLines: "1" } }));
    const additional = rule(summary, "pick_additional")!;
    expect(additional.perOrder).toBe("0.20");
    expect(additional.expected).toBe("250.00");
    expect(additional.quantityPerOrder).toBe("0.4000");
    expect(additional.ordersSharePct).toBe("40.00");
    expect(rule(summary, "pick_order")!.perOrder).toBe("2.50");
    expect(summary.profile.content).toEqual({ source: "averages", averageUnits: "1.4", averageLines: "1", rows: [{ units: 1, lines: 1, sharePct: "60" }, { units: 2, lines: 1, sharePct: "40" }] });
  });

  it("turns order-share drivers into expected values: 40% of orders with 2 inserts, first included, at $0.25 → $0.10 per order", () => {
    const summary = ok(base());
    const inserts = rule(summary, "inserts")!;
    expect(inserts.perOrder).toBe("0.10");
    expect(inserts.expected).toBe("125.00");
    expect(inserts.quantityPerOrder).toBe("0.4000");
    // Every order qualifies in expectation: no order is left unpriced.
    expect(summary.processing?.unresolved).toEqual([]);
    expect(category(summary, "other").state).toBe("priced");
  });

  it("prices packaging per package over the multi-package share: boxes 60% × (90% × 1 + 10% × 2) × $0.85", () => {
    const summary = ok(base());
    expect(rule(summary, "pack_box")!.expected).toBe("701.25");
    expect(rule(summary, "pack_box")!.quantityPerOrder).toBe("0.6600");
    expect(rule(summary, "pack_mailer")!.expected).toBe("165.00");
    // The catch-all packaging rule lost its exclusive group on every package and is not an unresolved rule.
    expect(rule(summary, "pack_other")).toBeUndefined();
    expect(category(summary, "packaging").state).toBe("priced");
  });

  it("computes monthly charges, the minimum and the allocation from the answers", () => {
    const summary = ok(base());
    // 8 pallets × $15 + 2 × $22 + 4 × $12 + 20 × $0.35 + 3% × 1,250 × $3 + $99 = 430.50
    expect(summary.monthly?.total).toBe("430.50");
    expect(summary.monthly?.totalE4).toBe(4305000);
    expect(summary.minimumStatus).toBe("exact");
    expect(summary.minimum).toEqual({ status: "exact", topUpE4: 0, topUp: "0.00" });
    expect(summary.allocation?.monthly.fixed).toBe("430.50");
    expect(summary.allocation?.perOrder.allocated).toBe("0.34");
    expect(summary.allocated).toEqual({ perOrder: "0.34", monthly: "430.50" });
    expect(summary.allIn).toEqual({ perOrder: summary.allocation!.perOrder.allIn, monthly: summary.allocation!.monthly.total, annual: summary.allocation!.monthly.annual });
    expect(summary.caveats).toEqual(["expected_values", "independent_distributions", "one_shipment_per_order", "exact_weights", "no_shipment_options", "delivery_area_undecided", "effective_dates"]);
  });

  it("adds an exact minimum top-up at low volume: 10 orders a month", () => {
    const summary = ok(base({ monthlyOrders: "10" }));
    // Counted: 25.00 pick + 4.00 additional + 5.61 boxes + 1.32 mailers + 164 storage + 55 receiving = 254.93 → top-up 245.07.
    expect(summary.minimums[0]?.countedE4).toBe(2549300);
    expect(summary.minimums[0]?.topUpE4).toBe(2450700);
    expect(summary.minimum.topUp).toBe("245.07");
    expect(summary.allocation?.monthly.minimumTopUp).toBe("245.07");
    expect(summary.allIn).not.toBeNull();
  });

  it("keeps the allocation identity: all-in = shipping + processing + allocated within $0.01", () => {
    const variants: ForecastAssumptions[] = [
      base(),
      base({ monthlyOrders: "1" }),
      base({ monthlyOrders: "3" }),
      base({ monthlyOrders: "7", residentialPct: "33.33" }),
      base({ monthlyOrders: "10" }),
      base({ monthlyOrders: "3333", multiPackage: { pct: "12.5", packagesPerOrder: 3 }, content: { averageUnits: "2.7", averageLines: "1.3" } }),
      base({ monthlyOrders: "999", residentialPct: "0", multiPackage: { pct: "0", packagesPerOrder: 2 } }),
    ];
    for (const a of variants) {
      const summary = ok(a);
      expect(summary.allIn, a.monthlyOrders).not.toBeNull();
      expect(summary.allocated?.perOrder).toBeTypeOf("string");
      const parts = money(summary.shipping.perOrder).plus(summary.processing!.perOrder).plus(summary.allocated!.perOrder ?? "0");
      expect(money(summary.allIn!.perOrder).minus(parts).abs().lte("0.01"), `${a.monthlyOrders}: ${summary.allIn!.perOrder} vs ${parts.toFixed()}`).toBe(true);
      // The figures the database checks on save.
      expect(new X(summary.weightSum).eq(a.monthlyOrders)).toBe(true);
      expect(summary.shipping.definite).toBe("0.00");
      expect(summary.processing!.definite).toBe("0.00");
      expect(summary.allIn!.monthly).toBe(summary.allocation!.monthly.total);
    }
  });

  it("carries conditional and undecided surcharges as upper bounds that are never added", () => {
    const summary = ok(base());
    // $21.00 address correction on every UPS shipment: 1,250 × 70% = 875 orders.
    expect(summary.shipping.conditionalUpTo).toBe("18375.00");
    // Priced by zone, delivery-area surcharges cannot be decided; a parcel of unknown size leaves handling surcharges undecided too.
    expect(summary.shipping.unresolvedUpToE4).toBeGreaterThan(0);
    expect(summary.shipping.expectedE4 + summary.shipping.conditionalUpToE4).toBeGreaterThan(summary.shipping.expectedE4);
    const cells = summary.cells.reduce((s, [, w, e4]) => s.plus(new X(w).times(e4 ?? 0)), new X(0));
    expect(cells.toDecimalPlaces(0).toNumber()).toBe(summary.shipping.expectedE4);
  });

  it("prices a supplied destination ZIP for the zone and refuses one that falls in another zone", () => {
    const zips: Record<string, string> = { "2": "90001", "5": "80001", "8": "10001" };
    const byZone = ok(base());
    const byZip = ok(base(), deps({ destinationZipForZone: (zone) => zips[zone] ?? null }));
    expect(byZip.shipping.unresolvedUpToE4).toBeLessThan(byZone.shipping.unresolvedUpToE4);
    expect(byZip.shipping.expectedE4).toBe(byZone.shipping.expectedE4);
    const wrong = evaluateForecast(base(), deps({ destinationZipForZone: (zone) => (zone === "5" ? "90001" : (zips[zone] ?? null)) }));
    expect(wrong.status).toBe("blocked");
    if (wrong.status === "blocked") {
      expect(wrong.unpriceable.map((u) => u.reason)).toEqual(["zone_mismatch", "zone_mismatch"]);
      expect(wrong.unpriceableSharePct).toBe("30.00");
    }
  });

  it("blocks on an unpriceable zone unless priceOnlyCovered, then averages over the priced volume only", () => {
    const withNine = base({
      zones: [
        { zone: "2", sharePct: "40" },
        { zone: "5", sharePct: "24" },
        { zone: "8", sharePct: "16" },
        { zone: "9", sharePct: "20" },
      ],
    });
    const blocked = evaluateForecast(withNine, deps());
    expect(blocked.status).toBe("blocked");
    if (blocked.status !== "blocked") return;
    expect(blocked.unpriceable.map((u) => [u.serviceName, u.zone, u.reason, u.sharePct])).toEqual([
      ["UPS Ground", "9", "no_rate_for_zone", "14.00"],
      ["USPS Ground Advantage", "9", "no_rate_for_zone", "6.00"],
    ]);
    expect(blocked.unpriceableSharePct).toBe("20.00");
    expect(blocked.cellCount).toBe(64);

    const covered = ok(withNine, deps(), { priceOnlyCovered: true });
    expect(covered.priceOnlyCovered).toBe(true);
    expect(covered.pricedWeight).toBe("1000");
    expect(covered.pricedSharePct).toBe("80.00");
    expect(covered.unpriceable).toHaveLength(2);
    expect(covered.allocation).toBeNull();
    expect(covered.allIn).toBeNull();
    expect(covered.allocated).toBeNull();
    expect(covered.complete).toBe(false);
    expect(covered.caveats).toContain("priced_only_covered");
    expect(covered.minimumStatus).toBe("upper_bound");
    // The priced zones keep the 50/30/20 mix of the base forecast, so the per-order averages are the same and the monthly sums carry no imputation.
    const reference = ok(base());
    expect(covered.shipping.perOrder).toBe(reference.shipping.perOrder);
    expect(covered.processing?.perOrder).toBe(reference.processing?.perOrder);
    expect(new X(covered.shipping.expectedE4).div(reference.shipping.expectedE4).toFixed(6)).toBe("0.800000");
    expect(covered.cells.filter(([, , e4]) => e4 === null)).toHaveLength(16);
    expect(covered.monthly?.total).toBe("430.50");
  });

  it("blocks on a service that is not on the rate card", () => {
    const result = evaluateForecast(base({ services: [{ ...UPS_GROUND, sharePct: "50" }, { serviceId: "svc-fedex", carrierCode: "fedex", serviceCode: "ground", name: "FedEx Ground", sharePct: "50" }] }), deps());
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.unpriceable.map((u) => [u.serviceName, u.zone, u.reason])).toEqual([["FedEx Ground", "2", "service_not_on_rate_card"], ["FedEx Ground", "5", "service_not_on_rate_card"], ["FedEx Ground", "8", "service_not_on_rate_card"]]);
  });

  it("reports a rule it could not compute with the share of volume affected, never as $0", () => {
    const summary = ok(base({ fulfillment: { ...base().fulfillment, orderShares: { inserts: null } } }));
    expect(rule(summary, "inserts")).toBeUndefined();
    expect(summary.processing?.unresolved).toEqual([{ key: "inserts", name: "Marketing inserts", reason: "assumption_missing", sharePct: "100.00", orders: 1250 }]);
    const other = category(summary, "other");
    expect(other.state).toBe("not_modeled");
    expect(other.notModeledOrders).toBe(1250);
    expect(other.rules.find((r) => r.key === "inserts")).toMatchObject({ state: "not_modeled", reason: "assumption_missing" });
    expect(summary.complete).toBe(false);
    expect(summary.allIn).toBeNull();
    expect(summary.allocation).not.toBeNull();
    expect(summary.caveats).toContain("not_all_categories_priced");
  });

  it("leaves packaging unresolved for a parcel of unknown packaging type, for that parcel's share", () => {
    const summary = ok(base({ parcels: [base().parcels[0]!, { ...base().parcels[1]!, packagingType: null }] }));
    expect(summary.processing?.unresolved.map((u) => [u.key, u.reason, u.sharePct, u.orders])).toEqual([
      ["pack_mailer", "packaging_unknown", "40.00", 500],
      ["pack_box", "packaging_unknown", "40.00", 500],
      ["pack_other", "packaging_unknown", "40.00", 500],
    ]);
    expect(category(summary, "packaging").state).toBe("not_modeled");
    expect(category(summary, "packaging").notModeledOrders).toBe(500);
    // The box parcel is still priced.
    expect(rule(summary, "pack_box")!.expected).toBe("701.25");
  });

  it("reports a packaging type that no rule prices under the packaging category", () => {
    const schedule: FeeScheduleSnapshot = { ...standard, rules: standard.rules.filter((r) => r.key !== "pack_other") };
    const summary = ok(base({ parcels: [base().parcels[0]!, { ...base().parcels[1]!, packagingType: "Tube" }] }), deps({ schedule }));
    expect(summary.processing?.unresolved).toEqual([{ key: "packaging:tube", name: "Packaging (Tube)", reason: "packaging_unmatched", sharePct: "40.00", orders: 500 }]);
    const packaging = category(summary, "packaging");
    expect(packaging.state).toBe("not_modeled");
    expect(packaging.rules.find((r) => r.key === "packaging:tube")).toMatchObject({ name: "Packaging (Tube)", state: "not_modeled", reason: "packaging_unmatched" });
  });

  it("marks monthly questions left out as not modeled and the minimum as an upper bound", () => {
    const summary = ok(base({ fulfillment: { ...base().fulfillment, drivers: { ...base().fulfillment.drivers, pallets_stored: null, long_term_pallets: null } } }));
    expect(summary.monthly?.notModeled.map((n) => [n.ruleKey, n.reason])).toEqual([
      ["storage_pallet", "no_answer"],
      ["storage_long_term", "no_answer"],
    ]);
    expect(category(summary, "storage").state).toBe("not_modeled");
    expect(summary.minimumStatus).toBe("upper_bound");
    expect(summary.allocation?.monthly.minimumTopUp).toBeNull();
    expect(summary.allIn).toBeNull();
    expect(summary.caveats).toContain("minimum_upper_bound");
  });

  it("models shipping only when there is no fee schedule or fulfillment is skipped", () => {
    const none = ok(base(), deps({ schedule: null }));
    expect(none.feeMode).toBe("no_schedule");
    expect(none.processing).toBeNull();
    expect(none.monthly).toBeNull();
    expect(none.allocation).toBeNull();
    expect(none.allIn).toBeNull();
    expect(none.minimumStatus).toBe("none");
    expect(none.completeness.every((c) => c.state === "not_in_schedule")).toBe(true);
    expect(none.caveats).toContain("no_fee_schedule");
    expect(none.shipping.perOrder).toBe(ok(base()).shipping.perOrder);
    expect(none.provenance.feeScheduleName).toBeNull();

    const skipped = ok(base({ fulfillment: { skip: true, drivers: {}, orderShares: {} } }));
    expect(skipped.feeMode).toBe("skipped");
    expect(skipped.processing).toBeNull();
    expect(skipped.completeness.find((c) => c.category === "pick_pack")?.rules.every((r) => r.state === "not_modeled" && r.reason === "skipped")).toBe(true);
    expect(skipped.caveats).toContain("fulfillment_skipped");
    expect(allInAtVolumes(skipped)).toEqual([]);
  });

  it("never puts rule keys in customer-facing text", () => {
    const summary = ok(base());
    const keys = standard.rules.map((r) => r.key).filter((k) => !["inserts", "returns", "admin", "minimum"].includes(k));
    const text = [
      ...summary.completeness.flatMap((c) => c.rules.map((r) => r.describe)),
      ...(summary.monthly?.lines.map((l) => l.explanation) ?? []),
      ...summary.unpriceable.map((u) => u.message),
    ].join("\n");
    for (const key of keys) expect(text).not.toContain(key);
  });
});

describe("forecast sensitivity: allInAtVolumes", () => {
  it("reproduces the allocation at 1× and rescales fixed charges, volume-driven lines and the minimum at other volumes", () => {
    const summary = ok(base());
    const points = allInAtVolumes(summary);
    expect(points.map((p) => p.multiplier)).toEqual(["0.5", "1", "2", "4"]);
    const one = points[1]!;
    expect(one.monthlyOrders).toBe("1250");
    expect(one.monthly).toEqual({ shipping: summary.allocation!.monthly.shipping, processing: summary.allocation!.monthly.processing, fixed: "430.50", minimumTopUp: "0.00", total: summary.allocation!.monthly.total });
    expect(one.perOrder).toEqual(summary.allocation!.perOrder);
    const two = points[2]!;
    expect(two.monthlyOrders).toBe("2500");
    expect(two.perOrder.shipping).toBe(summary.shipping.perOrder);
    expect(two.perOrder.processing).toBe(summary.processing!.perOrder);
    // Returns scale with volume (112.50 → 225.00); storage, receiving and admin do not.
    expect(two.monthly.fixed).toBe("543.00");
    expect(two.perOrder.allocated).toBe("0.22");
    expect(points[0]!.monthly.fixed).toBe("374.25");
    expect(points[3]!.monthly.fixed).toBe("768.00");
    expect(new X(two.monthly.shipping).toFixed()).toBe(new X(summary.shipping.expectedE4).times(2).div(10000).toDecimalPlaces(2).toFixed());
    // The all-in per order falls as fixed charges spread over more orders.
    expect(new X(points[0]!.perOrder.allIn).gt(one.perOrder.allIn)).toBe(true);
    expect(new X(two.perOrder.allIn).lt(one.perOrder.allIn)).toBe(true);
  });

  it("re-evaluates an exact minimum at each volume", () => {
    const summary = ok(base({ monthlyOrders: "10" }));
    const points = allInAtVolumes(summary, ["1", "2"]);
    expect(points[0]!.monthly.minimumTopUp).toBe("245.07");
    // At 20 orders the order-variable fees double: 2 × 35.93 + 219 = 290.86 counted → top-up 209.14.
    expect(points[1]!.monthly.minimumTopUp).toBe("209.14");
    expect(points[1]!.perOrder.allocated).toBe(new X("319.80").plus("209.14").div(20).toDecimalPlaces(2).toFixed(2));
    expect(() => allInAtVolumes(summary, ["-1"])).toThrow(RangeError);
  });
});

describe("forecast pinned monthly-volume rates", () => {
  const tiers = schedules.tiers!;
  it("resolves the rate of a monthly-quantity tier at the forecast volume", () => {
    const pins = forecastPinnedRates(base({ monthlyOrders: "3000", content: { averageUnits: "2.5", averageLines: "1" } }), tiers);
    // Graduated: 1,000 × $3.00 + 2,000 × $2.50 = $8,000 / 3,000 = $2.6667; volume: the $2.50 bracket.
    expect(pins).toEqual({
      pick_monthly_graduated: { rateE4: 26667, monthlyQuantity: "3000" },
      pick_monthly_volume: { rateE4: 25000, monthlyQuantity: "3000" },
    });
    expect(forecastPinnedRates(base(), null)).toEqual({});
  });

  it("prices with the pinned rate, and reports the rule as not modeled without one", () => {
    const a = base({ monthlyOrders: "3000", content: { rows: [{ units: 1, lines: 1, sharePct: "100" }] }, fulfillment: { drivers: {}, orderShares: {} } });
    const pinned = ok(a, deps({ schedule: tiers, pinnedRates: forecastPinnedRates(a, tiers) }));
    expect(rule(pinned, "pick_monthly_graduated")!.perOrder).toBe("2.67");
    expect(rule(pinned, "pick_monthly_graduated")!.expected).toBe("8000.10");
    expect(rule(pinned, "pick_monthly_volume")!.expected).toBe("7500.00");
    const unpinned = ok(a, deps({ schedule: tiers, pinnedRates: {} }));
    expect(unpinned.processing?.unresolved.map((u) => [u.key, u.reason, u.sharePct])).toEqual([
      ["pick_monthly_graduated", "assumption_missing", "100.00"],
      ["pick_monthly_volume", "assumption_missing", "100.00"],
    ]);
  });
});
