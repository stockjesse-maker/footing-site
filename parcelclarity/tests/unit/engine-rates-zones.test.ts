import { describe, expect, it } from "vitest";
import { calculateShipment, dec, lookupRate, normalizeZone, resolveZone } from "@/engine";
import type { RateLookup, RateMiss } from "@/engine/rates";
import type { PricingContext, RateCardSnapshot, RateRow, ShipmentInput, ZoneRow } from "@/engine/types";
import { fixtureContext, loadFixtureRateCard } from "../fixtures/pricing/load";

/**
 * Zone resolution (resolveZone), rate lookup (lookupRate) and the "unavailable" paths of
 * calculateShipment, against the FICTIONAL fixture rate card in tests/fixtures/pricing.
 *
 * Every expected number below is derived by hand from the fixture files (never from engine
 * output). The fixture formulas, from tests/fixtures/pricing/generate.mts:
 *
 *   UPS Ground (any origin), zone z, bracket (lb−1, lb], 1..150 lb:
 *       price = base[z] + perLb[z] × (lb − 1)
 *       base  = {2: 7.90, 3: 8.35, 4: 8.90, 5: 9.60, 6: 10.40, 7: 11.30, 8: 12.50}
 *       perLb = {2: 0.31, 3: 0.36, 4: 0.42, 5: 0.49, 6: 0.57, 7: 0.66, 8: 0.78}
 *       service terms: minCharge 8.50, DIM ÷139, round up to whole lb.
 *   UPS 2nd Day Air (any origin), zone 2, 1..30 lb: 18.20 + 1.10 × (lb − 1); no minimum charge.
 *   USPS Ground Advantage (origin prefix 900 ONLY), zone 5:
 *       oz rows (0,4] 4.95, (4,8] 5.40, (8,12] 5.85, (12,15.999] 6.30
 *       lb rows (0.99994,1] 7.05, then 7.05 + 0.78 × (lb − 1) up to 70 lb
 *       service terms: DIM ÷166 above 1728 cu in, round up to whole oz, no minimum charge.
 *   Zone chart (UPS and USPS rows are identical), origin 900:
 *       900–935→2, 936–961→3, 962–994→4, 995–999→8, 800–899→5, 600–799→6, 300–599→7, 005–299→8
 *       origin 90210: 903–903→3 (the only 5-digit origin row).
 */

const CARD_NAME = "Fixture Freight customer rate card (fictional)";
const GROUND = "svc-ups-ground";
const USPS_GA = "svc-usps-ga";

const card = loadFixtureRateCard();
const rows = card.rows;
const zones = card.zones;

function hit(found: RateLookup | RateMiss): RateLookup {
  if (!found.ok) throw new Error(`expected a rate, got ${found.reason}: ${found.message}`);
  return found;
}

function miss(found: RateLookup | RateMiss): RateMiss {
  if (found.ok) throw new Error(`expected a miss, got row ${JSON.stringify(found.row)}`);
  return found;
}

/** A hand-built rate row; defaults: any origin, zone 2, (0,1] lb, price 1.00. */
const row = (o: Partial<RateRow>): RateRow => ({
  serviceId: "svc-custom",
  originPrefix: null,
  zone: "2",
  weightMin: "0",
  weightMax: "1",
  weightUnit: "lb",
  price: "1.00",
  minCharge: null,
  ...o,
});

/** Fixture card with NO surcharge rules, so totals are base (+ minimum adjustment) only. */
function baseOnly(rateCard: RateCardSnapshot = loadFixtureRateCard()): PricingContext {
  return { rateCard, rules: [], zipLists: [], overrides: [] };
}

/** 1 lb in a 6×4×2 in box: 48 cu in ÷ 139 = 0.345 lb DIM < 1 lb actual → billable 1.0 lb. */
const ONE_LB: ShipmentInput["packages"][number] = { weight: "1", weightUnit: "lb", length: "6", width: "4", height: "2" };

/** UPS Ground from 90001 to 90210 (prefix 902 is in 900–935 → zone 2), one 1 lb package. */
function ground(overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  return {
    shipDate: "2026-10-15",
    originZip: "90001",
    destinationZip: "90210",
    residential: false,
    carrierCode: "ups",
    serviceCode: "ground",
    packages: [ONE_LB],
    ...overrides,
  };
}

/** Same shipment with the zone entered directly instead of a destination ZIP. */
function groundZone(zone: string, overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  const { destinationZip: _zip, ...rest } = ground(overrides);
  return { ...rest, destinationZone: zone };
}

// ---------------------------------------------------------------------------
// resolveZone
// ---------------------------------------------------------------------------

/** Adapter: the engine now takes a chart key and returns a discriminated lookup; these tests assert on the zone result or null. */
const rz = (rows: ZoneRow[], carrier: string, origin: string, dest: string) => {
  const r = resolveZone(rows, carrier, "default", origin, dest);
  return r.ok ? r.zone : null;
};

describe("resolveZone (rate card zone chart)", () => {
  it("prefers the 5-digit origin row: 90210 → 90301 is zone 3 although the 900 row says 900–935 is zone 2", () => {
    expect(rz(zones, "ups", "90210", "90301")).toEqual({
      zone: "3",
      source: "zone_chart",
      explanation: "Zone 3 from the rate card zone chart: origin 90210 to destinations 903–903.",
    });
    // 903 is also the inclusive upper bound of that 5-digit origin row.
    expect(rz(zones, "ups", "90210", "90399")?.zone).toBe("3");
  });

  it("falls back to the origin's own 3-digit rows only when no 5-digit origin row matches the destination", () => {
    // Hand-built chart: origin 90001 has one 5-digit row (903 → zone 3); origin 900 has the wider ranges.
    const custom: ZoneRow[] = [
      { carrierCode: "ups", originPrefix: "90001", destPrefixFrom: "903", destPrefixTo: "903", zone: "3", zoneChartKey: "default" },
      { carrierCode: "ups", originPrefix: "900", destPrefixFrom: "900", destPrefixTo: "935", zone: "2", zoneChartKey: "default" },
      { carrierCode: "ups", originPrefix: "900", destPrefixFrom: "800", destPrefixTo: "899", zone: "5", zoneChartKey: "default" },
    ];
    // 90001 → 90301: the 5-digit row matches (903) and beats the 900 row that says 900–935 → 2.
    expect(rz(custom, "ups", "90001", "90301")?.zone).toBe("3");
    // 90001 → 85001: the 5-digit row covers 903 only; fall back to origin 900: 850 in 800–899 → zone 5.
    expect(rz(custom, "ups", "90001", "85001")).toEqual({
      zone: "5",
      source: "zone_chart",
      explanation: "Zone 5 from the rate card zone chart: origin 900 to destinations 800–899.",
    });
    // 90001 → 90400: 904 is just outside 903–903 → origin 900 row 900–935 → zone 2.
    expect(rz(custom, "ups", "90001", "90400")?.zone).toBe("2");
    // Fixture chart: from 90210 the 3-digit fallback prefix is 902, which has no rows (the 3-digit rows
    // are for 900), so a destination the 90210 row does not cover resolves to nothing.
    expect(rz(zones, "ups", "90210", "85001")).toBeNull();
    // A 5-digit origin row with no 3-digit sibling has nothing to fall back to.
    const only5: ZoneRow[] = [{ carrierCode: "ups", originPrefix: "90210", destPrefixFrom: "903", destPrefixTo: "903", zone: "3", zoneChartKey: "default" }];
    expect(rz(only5, "ups", "90210", "85001")).toBeNull();
  });

  it("treats destination range bounds as inclusive at both ends", () => {
    // 935 is the top of 900–935 (zone 2); 936 is the bottom of 936–961 (zone 3).
    expect(rz(zones, "ups", "90001", "93599")?.zone).toBe("2");
    expect(rz(zones, "ups", "90001", "93600")?.zone).toBe("3");
    // 961 / 962: boundary between zone 3 and zone 4.
    expect(rz(zones, "ups", "90001", "96199")?.zone).toBe("3");
    expect(rz(zones, "ups", "90001", "96200")?.zone).toBe("4");
    // Chart extremes: 005 is the lowest bound (005–299 → 8); 999 the highest (995–999 → 8).
    expect(rz(zones, "ups", "90001", "00500")?.zone).toBe("8");
    expect(rz(zones, "ups", "90001", "99999")?.zone).toBe("8");
  });

  it("returns null when no row covers the destination, the origin, or the chart is empty", () => {
    expect(rz(zones, "ups", "90001", "00499")).toBeNull(); // 004 < 005, below every range
    expect(rz(zones, "ups", "10001", "85001")).toBeNull(); // no rows for origin 10001 or 100
    expect(rz([], "ups", "90001", "85001")).toBeNull();
  });

  it("filters rows by carrier", () => {
    expect(rz(zones, "fedex", "90001", "85001")).toBeNull();
    expect(rz(zones, "usps", "90001", "85001")?.zone).toBe("5");
    const upsOnly = zones.filter((z) => z.carrierCode === "ups");
    expect(rz(upsOnly, "usps", "90001", "85001")).toBeNull();
    expect(rz(upsOnly, "ups", "90001", "85001")?.zone).toBe("5");
  });

  it("prefers a 5-digit destination range over a 3-digit range for the same origin", () => {
    const custom: ZoneRow[] = [
      { carrierCode: "ups", originPrefix: "900", destPrefixFrom: "800", destPrefixTo: "899", zone: "5", zoneChartKey: "default" },
      { carrierCode: "ups", originPrefix: "900", destPrefixFrom: "85001", destPrefixTo: "85001", zone: "44", zoneChartKey: "default" },
    ];
    expect(rz(custom, "ups", "90001", "85001")).toEqual({
      zone: "44",
      source: "zone_chart",
      explanation: "Zone 44 from the rate card zone chart: origin 900 to destinations 85001–85001.",
    });
    expect(rz(custom, "ups", "90001", "85002")?.zone).toBe("5");
  });

  it("normalizeZone trims, upper-cases and strips a leading 'zone'", () => {
    expect(normalizeZone("zone 5")).toBe("5");
    expect(normalizeZone("  Zone5 ")).toBe("5");
    expect(normalizeZone("ZONE   7")).toBe("7");
    expect(normalizeZone("b")).toBe("B");
    expect(normalizeZone("5")).toBe("5");
  });

  it("calculateShipment strips ZIP+4 (dashed or 9-digit) before consulting the chart", () => {
    const r = calculateShipment(ground({ originZip: "90210-0001", destinationZip: "903019999" }), baseOnly());
    expect(r.status).toBe("ok");
    expect(r.input.originZip).toBe("90210");
    expect(r.input.destinationZip).toBe("90301");
    expect(r.zone?.zone).toBe("3");
    // zone 3 (0,1]: 8.35; service minimum 8.50 → adjustment 0.15; definite 8.50
    expect(r.lines.map((l) => [l.kind, l.amount.amount])).toEqual([
      ["base", "8.35"],
      ["minimum_charge", "0.15"],
    ]);
    expect(r.totals.definite.amount).toBe("8.50");
  });
});

// ---------------------------------------------------------------------------
// lookupRate: bracket semantics
// ---------------------------------------------------------------------------

describe("lookupRate (bracket semantics: weightMin exclusive, weightMax inclusive)", () => {
  it("billable exactly 1.0 lb picks the (0,1] bracket, not (1,2]", () => {
    const found = hit(lookupRate(rows, GROUND, "90001", "2", dec("1")));
    // zone 2, 1 lb: 7.90 (the (1,2] row would be 7.90 + 0.31 = 8.21)
    expect(found.row).toMatchObject({ weightMin: "0", weightMax: "1", weightUnit: "lb", price: "7.90", originPrefix: null });
    expect(found.comparedWeight.toString()).toBe("1");
    expect(found.originScope).toBe("any_origin");
  });

  it("just above a bracket maximum moves to the next bracket", () => {
    // zone 2 (1,2]: 7.90 + 0.31 × 1 = 8.21
    expect(hit(lookupRate(rows, GROUND, "90001", "2", dec("1.01"))).row).toMatchObject({ weightMin: "1", weightMax: "2", price: "8.21" });
    expect(hit(lookupRate(rows, GROUND, "90001", "2", dec("2"))).row).toMatchObject({ weightMin: "1", weightMax: "2", price: "8.21" });
  });

  it("the heaviest bracket is inclusive at its maximum and nothing above it is extrapolated", () => {
    // zone 2 (149,150]: 7.90 + 0.31 × 149 = 7.90 + 46.19 = 54.09
    expect(hit(lookupRate(rows, GROUND, "90001", "2", dec("150"))).row).toMatchObject({ weightMin: "149", weightMax: "150", price: "54.09" });
    const over = miss(lookupRate(rows, GROUND, "90001", "2", dec("150.5")));
    expect(over).toEqual({
      ok: false,
      reason: "no_rate_for_weight",
      message: "Billable weight 150.5 lb exceeds the heaviest bracket on the rate card for zone 2 (150.0 lb). Rates are not extrapolated.",
    });
  });

  it("a weight in a gap between brackets (or zero) is no_rate_for_weight with a 'no bracket covering' message", () => {
    const gappy = [row({ weightMin: "0", weightMax: "1", price: "1.00" }), row({ weightMin: "2", weightMax: "3", price: "3.00" })];
    expect(miss(lookupRate(gappy, "svc-custom", "90001", "2", dec("1.5")))).toEqual({
      ok: false,
      reason: "no_rate_for_weight",
      message: "The rate card has no bracket covering 1.5 lb for zone 2.",
    });
    expect(miss(lookupRate(gappy, "svc-custom", "90001", "2", dec("3.5"))).message).toBe(
      "Billable weight 3.5 lb exceeds the heaviest bracket on the rate card for zone 2 (3.0 lb). Rates are not extrapolated.",
    );
    // weightMin is exclusive, so 0 lb never matches a (0,1] bracket.
    expect(miss(lookupRate(rows, GROUND, "90001", "2", dec("0"))).message).toBe("The rate card has no bracket covering 0.0 lb for zone 2.");
    // Overlapping (malformed) rows: the lightest matching bracket wins (design 1.11).
    const overlapping = [row({ weightMin: "0", weightMax: "5", price: "5.00" }), row({ weightMin: "0", weightMax: "2", price: "2.00" })];
    expect(hit(lookupRate(overlapping, "svc-custom", "90001", "2", dec("1.5"))).row.price).toBe("2.00");
  });

  it("compares in the row's unit: ounce rows and pound rows for one billable weight (USPS zone 5)", () => {
    // 0.25 lb = 4 oz: (0,4] oz at its inclusive max → 4.95, not (4,8] → 5.40
    const four = hit(lookupRate(rows, USPS_GA, "90001", "5", dec("0.25")));
    expect(four.row).toMatchObject({ weightMin: "0", weightMax: "4", weightUnit: "oz", price: "4.95", originPrefix: "900" });
    expect(four.comparedWeight.toString()).toBe("4");
    expect(four.originScope).toBe("origin_3");
    // 0.9375 lb = 15 oz: (12,15.999] oz → 6.30 (the first lb row starts above 0.99994 lb)
    const fifteen = hit(lookupRate(rows, USPS_GA, "90001", "5", dec("0.9375")));
    expect(fifteen.row).toMatchObject({ weightMin: "12", weightMax: "15.999", weightUnit: "oz", price: "6.30" });
    expect(fifteen.comparedWeight.toString()).toBe("15");
    // 1 lb = 16 oz: above 15.999 oz, so the (0.99994,1] lb row → 7.05
    const one = hit(lookupRate(rows, USPS_GA, "90001", "5", dec("1")));
    expect(one.row).toMatchObject({ weightMin: "0.99994", weightMax: "1", weightUnit: "lb", price: "7.05" });
    expect(one.comparedWeight.toString()).toBe("1");
    // 1.0625 lb = 17 oz: (1,2] lb → 7.05 + 0.78 = 7.83
    const seventeen = hit(lookupRate(rows, USPS_GA, "90001", "5", dec("1.0625")));
    expect(seventeen.row).toMatchObject({ weightMin: "1", weightMax: "2", weightUnit: "lb", price: "7.83" });
    expect(seventeen.comparedWeight.toString()).toBe("1.0625");
  });
});

// ---------------------------------------------------------------------------
// lookupRate: origin and zone scoping
// ---------------------------------------------------------------------------

describe("lookupRate (origin and zone scoping)", () => {
  it("prefers 5-digit origin rows over 3-digit over any-origin", () => {
    const scoped = [row({ originPrefix: "90001", price: "1.00" }), row({ originPrefix: "900", price: "2.00" }), row({ originPrefix: null, price: "3.00" })];
    const five = hit(lookupRate(scoped, "svc-custom", "90001", "2", dec("1")));
    expect([five.row.price, five.originScope]).toEqual(["1.00", "origin_5"]);
    const three = hit(lookupRate(scoped, "svc-custom", "90002", "2", dec("1")));
    expect([three.row.price, three.originScope]).toEqual(["2.00", "origin_3"]);
    const any = hit(lookupRate(scoped, "svc-custom", "10001", "2", dec("1")));
    expect([any.row.price, any.originScope]).toEqual(["3.00", "any_origin"]);
  });

  it("no_rate_for_origin when the service is priced per origin and no row matches the origin", () => {
    const perOrigin = [row({ originPrefix: "90001", price: "1.00" }), row({ originPrefix: "900", price: "2.00" })];
    expect(miss(lookupRate(perOrigin, "svc-custom", "10001", "2", dec("1")))).toEqual({
      ok: false,
      reason: "no_rate_for_origin",
      message: "The rate card prices this service by origin and has no rates for origin ZIP 10001 in zone 2.",
    });
    // Fixture: USPS rows exist for origin prefix 900 only.
    expect(miss(lookupRate(rows, USPS_GA, "10001", "5", dec("1"))).reason).toBe("no_rate_for_origin");
    expect(hit(lookupRate(rows, USPS_GA, "90099", "5", dec("1"))).originScope).toBe("origin_3");
  });

  it("the zone is matched first; origin preference is decided among that zone's rows only", () => {
    // Origin 90001 has a 5-digit row for zone 3 only. For zone 2 the candidates are the 900 row and
    // the any-origin row, and the 3-digit origin row wins over any-origin.
    const scoped = [row({ originPrefix: "90001", zone: "3", price: "1.00" }), row({ originPrefix: "900", zone: "2", price: "2.00" }), row({ originPrefix: null, zone: "2", price: "3.00" })];
    const hit = lookupRate(scoped, "svc-custom", "90001", "2", dec("1"));
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.row.price).toBe("2.00");
      expect(hit.originScope).toBe("origin_3");
    }
    // Zone 3 from a different origin: only the 5-digit row exists and it is for 90001 → no rate for that origin.
    expect(miss(lookupRate(scoped, "svc-custom", "10001", "3", dec("1"))).reason).toBe("no_rate_for_origin");
  });

  it("no_rate_for_zone lists the zones the scope covers, sorted", () => {
    expect(miss(lookupRate(rows, GROUND, "90001", "9", dec("1")))).toEqual({
      ok: false,
      reason: "no_rate_for_zone",
      message: "The rate card has no rates for zone 9 on this service (zones covered: 2, 3, 4, 5, 6, 7, 8).",
    });
    expect(miss(lookupRate(rows, USPS_GA, "90001", "0", dec("1"))).message).toBe(
      "The rate card has no rates for zone 0 on this service (zones covered: 1, 2, 3, 4, 5, 6, 7, 8).",
    );
  });

  it("normalizes both the wanted zone and the row zone before matching", () => {
    // zone 5 (0,1]: 9.60
    expect(hit(lookupRate(rows, GROUND, "90001", "zone 5", dec("1"))).row.price).toBe("9.60");
    expect(hit(lookupRate(rows, GROUND, "90001", " Zone 5 ", dec("1"))).row.price).toBe("9.60");
    const labelled = [row({ zone: "Zone 5", price: "4.44" })];
    expect(hit(lookupRate(labelled, "svc-custom", "90001", "5", dec("1"))).row.price).toBe("4.44");
    expect(hit(lookupRate(labelled, "svc-custom", "90001", "zone 5", dec("1"))).row.price).toBe("4.44");
    // The miss message uses the normalized zone.
    expect(miss(lookupRate(rows, GROUND, "90001", "zone 9", dec("1"))).message).toContain("no rates for zone 9 on this service");
  });

  it("service_not_on_rate_card when the service has no rows at all", () => {
    expect(miss(lookupRate(rows, "svc-missing", "90001", "2", dec("1")))).toEqual({
      ok: false,
      reason: "service_not_on_rate_card",
      message: "The rate card has no rows for this service.",
    });
  });
});

// ---------------------------------------------------------------------------
// calculateShipment: unavailable paths
// ---------------------------------------------------------------------------

describe("calculateShipment: unavailable paths", () => {
  it("service_not_on_rate_card: the carrier/service pair must both match; the result is empty", () => {
    const r = calculateShipment(ground({ carrierCode: "fedex" }), fixtureContext());
    expect(r).toMatchObject({
      status: "unavailable",
      unavailableReason: "service_not_on_rate_card",
      unavailableMessage: `fedex/ground is not on rate card "${CARD_NAME}".`,
      currency: "USD",
      service: null,
      zone: null,
      packages: [],
      lines: [],
      totals: {
        definite: { amount: "0.00", currency: "USD" },
        estimated: { amount: "0.00", currency: "USD" },
        expected: { amount: "0.00", currency: "USD" },
        conditionalExposure: { amount: "0.00", currency: "USD" },
      },
      references: { rateCardId: "fixture-card", rateCardVersionId: "fixture-card-v1", rateCardVersionNumber: 1, termsVersion: null, rules: [] },
      warnings: [],
    });
    // usps has only ground_advantage; ups has only ground and second_day_air.
    expect(calculateShipment(ground({ carrierCode: "usps", serviceCode: "ground" }), fixtureContext()).unavailableReason).toBe("service_not_on_rate_card");
    expect(calculateShipment(ground({ carrierCode: "ups", serviceCode: "ground_advantage" }), fixtureContext()).unavailableReason).toBe("service_not_on_rate_card");
  });

  it("rate_card_not_effective outside [effectiveDate, expirationDate]; both bounds are inclusive", () => {
    const dated = loadFixtureRateCard({ effectiveDate: "2026-10-15", expirationDate: "2026-10-20" });
    const before = calculateShipment(ground({ shipDate: "2026-10-14" }), baseOnly(dated));
    expect(before.status).toBe("unavailable");
    expect(before.unavailableReason).toBe("rate_card_not_effective");
    expect(before.unavailableMessage).toBe(`Rate card "${CARD_NAME}" has no rates in effect on 2026-10-14 (this version is effective 2026-10-15 to 2026-10-20).`);
    expect(before.service).toBeNull();
    expect(before.packages).toEqual([]);

    for (const shipDate of ["2026-10-15", "2026-10-20"]) {
      const ok = calculateShipment(ground({ shipDate }), baseOnly(dated));
      expect(ok.status, shipDate).toBe("ok");
      expect(ok.lines[0]?.amount.amount, shipDate).toBe("7.90"); // zone 2 (0,1]
    }

    const after = calculateShipment(ground({ shipDate: "2026-10-21" }), baseOnly(dated));
    expect(after.unavailableReason).toBe("rate_card_not_effective");
    expect(after.unavailableMessage).toBe(`Rate card "${CARD_NAME}" has no rates in effect on 2026-10-21 (this version is effective 2026-10-15 to 2026-10-20).`);
  });

  it("an open-ended card (no expiration) prices any later date and names only the effective date when too early", () => {
    const open = loadFixtureRateCard({ effectiveDate: "2026-01-01", expirationDate: null });
    expect(calculateShipment(ground({ shipDate: "2099-12-31" }), baseOnly(open)).status).toBe("ok");
    const early = calculateShipment(ground({ shipDate: "2025-12-31" }), baseOnly(open));
    expect(early.unavailableReason).toBe("rate_card_not_effective");
    expect(early.unavailableMessage).toBe(`Rate card "${CARD_NAME}" has no rates in effect on 2025-12-31 (this version is effective 2026-01-01).`);
  });

  it("invalid_input: zero weight", () => {
    const input = ground({ packages: [{ weight: "0", weightUnit: "lb" }] });
    const r = calculateShipment(input, fixtureContext());
    expect(r.status).toBe("unavailable");
    expect(r.unavailableReason).toBe("invalid_input");
    expect(r.unavailableMessage).toBe("The shipment could not be priced: packages.0.weight: must be greater than zero.");
    expect(r.service).toBeNull();
    expect(r.packages).toEqual([]);
    expect(r.input).toBe(input); // the raw input is echoed back untouched
  });

  it("invalid_input: 4-digit ZIP", () => {
    const r = calculateShipment(ground({ originZip: "9000" }), fixtureContext());
    expect(r.unavailableReason).toBe("invalid_input");
    expect(r.unavailableMessage).toBe("The shipment could not be priced: originZip: must be a 5-digit US ZIP code.");
  });

  it("invalid_input: neither destination ZIP nor destination zone", () => {
    const { destinationZip: _zip, ...noDestination } = ground();
    const r = calculateShipment(noDestination as ShipmentInput, fixtureContext());
    expect(r.unavailableReason).toBe("invalid_input");
    expect(r.unavailableMessage).toBe("The shipment could not be priced: destinationZip: provide a destination ZIP or a destination zone.");
  });

  it("invalid_input: 201 packages (200 is the limit and is priced)", () => {
    const packages = (n: number) => Array.from({ length: n }, () => ONE_LB);
    const tooMany = calculateShipment(ground({ packages: packages(201) }), fixtureContext());
    expect(tooMany.unavailableReason).toBe("invalid_input");
    expect(tooMany.unavailableMessage).toBe("The shipment could not be priced: packages: at most 200 packages per shipment.");

    const atLimit = calculateShipment(ground({ packages: packages(200) }), baseOnly());
    expect(atLimit.status).toBe("ok");
    expect(atLimit.packages).toHaveLength(200);
    // 200 × (7.90 base + 0.60 adjustment up to the 8.50 minimum) = 200 × 8.50 = 1700.00
    expect(atLimit.lines).toHaveLength(400);
    expect(atLimit.totals.definite.amount).toBe("1700.00");
  });

  it("invalid_input: partial dimensions", () => {
    const r = calculateShipment(ground({ packages: [{ weight: "1", weightUnit: "lb", length: "6", width: "4" }] }), fixtureContext());
    expect(r.unavailableReason).toBe("invalid_input");
    expect(r.unavailableMessage).toBe("The shipment could not be priced: packages.0.length: provide all three dimensions or none.");
  });

  it("invalid_input: several problems are listed in one message, joined by '; '", () => {
    const r = calculateShipment(ground({ originZip: "9000", packages: [{ weight: "0", weightUnit: "lb" }] }), fixtureContext());
    expect(r.unavailableReason).toBe("invalid_input");
    expect(r.unavailableMessage).toContain("originZip: must be a 5-digit US ZIP code");
    expect(r.unavailableMessage).toContain("packages.0.weight: must be greater than zero");
    expect(r.unavailableMessage).toMatch(/^The shipment could not be priced: .+; .+\.$/);
  });

  it("zone_unresolved carries the service and per-package weights computed before the failure", () => {
    const r = calculateShipment(ground({ destinationZip: "00401" }), fixtureContext());
    expect(r.status).toBe("unavailable");
    expect(r.unavailableReason).toBe("zone_unresolved");
    expect(r.unavailableMessage).toBe("No zone chart row covers origin 90001 to destination 00401.");
    expect(r.service).toEqual({ serviceId: GROUND, serviceCode: "ground", serviceName: "UPS Ground", carrierCode: "ups" });
    expect(r.zone).toBeNull();
    // 1 lb actual; 6×4×2 = 48 cu in ÷ 139 = 0.3453… lb DIM (reported rounded up at 12 dp), below actual → billable 1.0 on actual
    expect(r.packages).toHaveLength(1);
    expect(r.packages[0]).toMatchObject({ packageIndex: 0, actualLb: "1.0", cubicIn: "48.0", dimLb: "0.345323741008", billableLb: "1.0", basis: "actual" });
    expect(r.lines).toEqual([]);
    expect(r.references.termsVersion).toBe("fixture-terms-v1");
    expect(r.warnings).toEqual([]);
  });

  it("zone_unresolved adds zone_chart_missing when the card has no chart rows for the carrier", () => {
    const noUpsChart = loadFixtureRateCard();
    noUpsChart.zones = noUpsChart.zones.filter((z) => z.carrierCode !== "ups");
    const r = calculateShipment(ground(), baseOnly(noUpsChart));
    expect(r.unavailableReason).toBe("zone_unresolved");
    expect(r.warnings).toEqual([{ code: "zone_chart_missing", message: 'The rate card has no "default" zone chart for ups. Enter the zone directly or add a zone chart.' }]);
    // The same card still resolves USPS destinations through the USPS rows.
    const usps = calculateShipment(ground({ carrierCode: "usps", serviceCode: "ground_advantage", destinationZip: "85001" }), baseOnly(noUpsChart));
    expect(usps.status).toBe("ok");
    expect(usps.zone?.zone).toBe("5");
    // And entering the zone directly sidesteps the missing chart.
    expect(calculateShipment(groundZone("2"), baseOnly(noUpsChart)).status).toBe("ok");
  });

  it("no_rate_for_origin via calculateShipment names the origin and the package's billable weight", () => {
    const r = calculateShipment(
      {
        shipDate: "2026-10-15",
        originZip: "10001",
        destinationZone: "5",
        residential: false,
        carrierCode: "usps",
        serviceCode: "ground_advantage",
        packages: [{ weight: "6", weightUnit: "oz", length: "10", width: "6", height: "1" }],
      },
      fixtureContext(),
    );
    expect(r.status).toBe("unavailable");
    expect(r.unavailableReason).toBe("no_rate_for_origin");
    // 6 oz = 0.375 lb; 60 cu in is under the 1728 cu in threshold; whole-ounce rounding leaves 0.375
    expect(r.unavailableMessage).toBe("The rate card prices this service by origin and has no rates for origin ZIP 10001 in zone 5. (package 1: billable 0.375 lb)");
    expect(r.zone).toEqual({ zone: "5", source: "input", explanation: "Zone 5 as entered." });
    expect(r.service?.serviceId).toBe(USPS_GA);
    expect(r.packages[0]).toMatchObject({ actualLb: "0.375", billableLb: "0.375", basis: "actual" });
  });

  it("no_rate_for_zone via calculateShipment lists the zones on the card", () => {
    const r = calculateShipment(groundZone("9"), fixtureContext());
    expect(r.status).toBe("unavailable");
    expect(r.unavailableReason).toBe("no_rate_for_zone");
    expect(r.unavailableMessage).toBe("The rate card has no rates for zone 9 on this service (zones covered: 2, 3, 4, 5, 6, 7, 8). (package 1: billable 1.0 lb)");
    expect(r.zone).toEqual({ zone: "9", source: "input", explanation: "Zone 9 as entered." });
    expect(r.service?.serviceId).toBe(GROUND);
    expect(r.lines).toEqual([]);
  });

  it("no_rate_for_weight via calculateShipment: nothing above the heaviest bracket is extrapolated", () => {
    const r = calculateShipment(ground({ destinationZip: "85001", packages: [{ weight: "151", weightUnit: "lb", length: "20", width: "20", height: "20" }] }), fixtureContext());
    expect(r.status).toBe("unavailable");
    expect(r.unavailableReason).toBe("no_rate_for_weight");
    // 20×20×20 = 8000 cu in ÷ 139 = 57.554 lb DIM < 151 lb actual → billable 151; UPS Ground stops at 150 lb
    expect(r.unavailableMessage).toBe(
      "Billable weight 151.0 lb exceeds the heaviest bracket on the rate card for zone 5 (150.0 lb). Rates are not extrapolated. (package 1: billable 151.0 lb)",
    );
    expect(r.zone?.zone).toBe("5");
    expect(r.packages[0]).toMatchObject({ actualLb: "151.0", dimLb: "57.553956834533", billableLb: "151.0", basis: "actual" });
    expect(r.totals.expected.amount).toBe("0.00");
  });

  it("no_rate_for_weight for a lower service ceiling (2nd Day Air, 30 lb) keeps the warnings gathered before the failure", () => {
    const r = calculateShipment(ground({ serviceCode: "second_day_air", packages: [{ weight: "31", weightUnit: "lb" }] }), fixtureContext());
    expect(r.unavailableReason).toBe("no_rate_for_weight");
    expect(r.unavailableMessage).toBe(
      "Billable weight 31.0 lb exceeds the heaviest bracket on the rate card for zone 2 (30.0 lb). Rates are not extrapolated. (package 1: billable 31.0 lb)",
    );
    expect(r.packages[0]?.basis).toBe("no_dimensions");
    expect(r.warnings.map((w) => w.code)).toEqual(["dimensions_missing"]);
    expect(r.references.termsVersion).toBe("fixture-terms-v1");
  });

  it("a multi-package shipment fails as a whole and names the offending package", () => {
    const r = calculateShipment(
      ground({
        destinationZip: "85001",
        packages: [
          { weight: "3", weightUnit: "lb", length: "10", width: "8", height: "6" },
          { weight: "151", weightUnit: "lb", length: "20", width: "20", height: "20" },
        ],
      }),
      fixtureContext(),
    );
    expect(r.status).toBe("unavailable");
    expect(r.unavailableReason).toBe("no_rate_for_weight");
    expect(r.unavailableMessage).toMatch(/ \(package 2: billable 151\.0 lb\)$/);
    // package 1: 10×8×6 = 480 cu in ÷ 139 = 3.453 lb DIM > 3 lb actual → rounds up to 4 lb
    expect(r.packages.map((p) => p.billableLb)).toEqual(["4.0", "151.0"]);
    expect(r.zone?.zone).toBe("5");
    expect(r.lines).toEqual([]);
    expect(r.totals.expected.amount).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// calculateShipment: base bracket, minimum charge, direct zone
// ---------------------------------------------------------------------------

describe("calculateShipment: base bracket, minimum charge and zone entered directly", () => {
  it("16 oz is exactly 1.0 lb and prices on the (0,1] bracket; 1.01 lb rounds up to the (1,2] bracket", () => {
    const sixteenOz = calculateShipment(ground({ packages: [{ ...ONE_LB, weight: "16", weightUnit: "oz" }] }), baseOnly());
    expect(sixteenOz.status).toBe("ok");
    expect(sixteenOz.packages[0]).toMatchObject({ actualLb: "1.0", billableLb: "1.0", basis: "actual" });
    expect(sixteenOz.lines[0]).toMatchObject({
      kind: "base",
      category: "base",
      label: "UPS Ground base rate",
      amount: { amount: "7.90", currency: "USD" }, // zone 2 (0,1], not the (1,2] rate 8.21
      chargeClass: "definite",
      counted: true,
      packageIndex: 0,
      explanation: `Zone 2, 1.0 lb billable (bracket 0.0–1.0 lb), rate card "${CARD_NAME}".`,
      basis: `rate_card:fixture-card-v1:${GROUND}:2:1lb`,
      rule: null,
    });

    const justOver = calculateShipment(ground({ packages: [{ ...ONE_LB, weight: "1.01" }] }), baseOnly());
    expect(justOver.packages[0]).toMatchObject({ actualLb: "1.01", billableLb: "2.0" });
    // zone 2 (1,2]: 7.90 + 0.31 = 8.21; minimum 8.50 → adjustment 0.29
    expect(justOver.lines.map((l) => [l.kind, l.amount.amount])).toEqual([
      ["base", "8.21"],
      ["minimum_charge", "0.29"],
    ]);
    expect(justOver.lines[0]?.basis).toBe(`rate_card:fixture-card-v1:${GROUND}:2:2lb`);
    expect(justOver.totals.definite.amount).toBe("8.50");
  });

  it("minimum charge from the service terms is a separate counted line for the shortfall", () => {
    const r = calculateShipment(ground(), baseOnly());
    expect(r.status).toBe("ok");
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toEqual({
      kind: "minimum_charge",
      category: "base",
      label: "Minimum charge adjustment",
      amount: { amount: "0.60", currency: "USD" }, // 8.50 − 7.90
      chargeClass: "definite",
      counted: true,
      status: "charged",
      packageIndex: 0,
      // Explanation/basis figures go through fmt(), which trims trailing zeros ("8.50" → "8.5").
      explanation: "The rate card minimum charge of 8.5 exceeds the bracket rate of 7.9.",
      basis: "minimum:8.5",
      rule: null,
    });
    expect(r.totals).toEqual({
      definite: { amount: "8.50", currency: "USD" },
      estimated: { amount: "0.00", currency: "USD" },
      expected: { amount: "8.50", currency: "USD" },
      conditionalExposure: { amount: "0.00", currency: "USD" },
      unresolved: { amount: "0.00", currency: "USD" },
    });
  });

  it("row minimum vs service minimum: the larger wins", () => {
    const priced = (rowMin: string, serviceMin: string | null) => {
      const custom = loadFixtureRateCard();
      const target = custom.rows.find((x) => x.serviceId === GROUND && x.originPrefix === null && x.zone === "2" && x.weightMax === "1")!;
      target.minCharge = rowMin;
      custom.services.find((s) => s.serviceId === GROUND)!.minCharge = serviceMin;
      return calculateShipment(ground(), baseOnly(custom));
    };
    // (basis/explanation figures are fmt()-formatted, i.e. trailing zeros trimmed: "9.00" → "9.0")
    // row 9.00 > service 8.50 → 9.00 − 7.90 = 1.10
    const rowWins = priced("9.00", "8.50");
    expect(rowWins.lines[1]).toMatchObject({ kind: "minimum_charge", amount: { amount: "1.10" }, basis: "minimum:9.0" });
    expect(rowWins.lines[1]?.explanation).toBe("The rate card minimum charge of 9.0 exceeds the bracket rate of 7.9.");
    expect(rowWins.totals.definite.amount).toBe("9.00");
    // row 8.00 < service 8.50 → service wins: 8.50 − 7.90 = 0.60
    const serviceWins = priced("8.00", "8.50");
    expect(serviceWins.lines[1]).toMatchObject({ kind: "minimum_charge", amount: { amount: "0.60" }, basis: "minimum:8.5" });
    // row only (service has none): 8.00 − 7.90 = 0.10
    const rowOnly = priced("8.00", null);
    expect(rowOnly.lines[1]).toMatchObject({ kind: "minimum_charge", amount: { amount: "0.10" }, basis: "minimum:8.0" });
    expect(rowOnly.totals.definite.amount).toBe("8.00");
  });

  it("no minimum line when the bracket rate meets or exceeds the minimum, or when there is no minimum", () => {
    // zone 2 (2,3]: 7.90 + 0.31 × 2 = 8.52 > 8.50
    const above = calculateShipment(ground({ packages: [{ ...ONE_LB, weight: "3" }] }), baseOnly());
    expect(above.lines.map((l) => [l.kind, l.amount.amount])).toEqual([["base", "8.52"]]);
    expect(above.totals.definite.amount).toBe("8.52");
    // exactly equal: service minimum set to the (1,2] rate 8.21 → no adjustment (strictly greater is required)
    const custom = loadFixtureRateCard();
    custom.services.find((s) => s.serviceId === GROUND)!.minCharge = "8.21";
    const equal = calculateShipment(ground({ packages: [{ ...ONE_LB, weight: "2" }] }), baseOnly(custom));
    expect(equal.lines.map((l) => [l.kind, l.amount.amount])).toEqual([["base", "8.21"]]);
    expect(equal.totals.definite.amount).toBe("8.21");
    // neither row nor service minimum (2nd Day Air): zone 2 (0,1] = 18.20
    const none = calculateShipment(ground({ serviceCode: "second_day_air" }), baseOnly());
    expect(none.lines.map((l) => [l.kind, l.amount.amount])).toEqual([["base", "18.20"]]);
    expect(none.totals.definite.amount).toBe("18.20");
  });

  it("a zone entered directly is trimmed and upper-cased, reported with source 'input', and priced as-is", () => {
    const r = calculateShipment(groundZone(" 7 "), baseOnly());
    expect(r.status).toBe("ok");
    expect(r.zone).toEqual({ zone: "7", source: "input", explanation: "Zone 7 as entered." });
    // zone 7 (0,1]: 11.30, above the 8.50 minimum so no adjustment line
    expect(r.lines.map((l) => [l.kind, l.amount.amount])).toEqual([["base", "11.30"]]);
    expect(r.lines[0]?.basis).toBe(`rate_card:fixture-card-v1:${GROUND}:7:1lb`);
    // lower-case letters are upper-cased before the lookup and in the message
    const letter = calculateShipment(groundZone("b"), baseOnly());
    expect(letter.unavailableReason).toBe("no_rate_for_zone");
    expect(letter.zone?.zone).toBe("B");
    expect(letter.unavailableMessage).toContain("no rates for zone B on this service");
  });

  it("'zone 5' entered directly prices on the zone 5 rows", () => {
    const r = calculateShipment(groundZone("zone 5"), baseOnly());
    expect(r.status).toBe("ok");
    // zone 5 (0,1]: 9.60 > 8.50, no minimum line
    expect(r.lines.map((l) => [l.kind, l.amount.amount])).toEqual([["base", "9.60"]]);
    expect(r.lines[0]?.basis).toBe(`rate_card:fixture-card-v1:${GROUND}:5:1lb`);
  });

  // ENGINE DEFECT: calculate.ts only trims and upper-cases a directly entered zone ("zone 5" →
  // "ZONE 5") instead of running it through normalizeZone (which lookupRate and zone_in
  // conditions use). The rate lookup still succeeds, but ZoneResult.zone is "ZONE 5", its
  // explanation reads "Zone ZONE 5 as entered." and the base line explanation "Zone ZONE 5, …".
  // Expected: "zone 5" → "5" (normalized), explanation "Zone 5 as entered.".
  it("'zone 5' entered directly is reported as zone '5' (normalized)", () => {
    const r = calculateShipment(groundZone("zone 5"), baseOnly());
    expect(r.zone).toEqual({ zone: "5", source: "input", explanation: "Zone 5 as entered." });
    expect(r.lines[0]?.explanation).toMatch(/^Zone 5, /);
  });

  it("USPS prices ounce rows and pound rows from the origin-specific (900) rows", () => {
    const usps = (weightOz: string) =>
      calculateShipment(
        {
          shipDate: "2026-10-15",
          originZip: "90001",
          destinationZip: "85001",
          residential: false,
          carrierCode: "usps",
          serviceCode: "ground_advantage",
          packages: [{ weight: weightOz, weightUnit: "oz", length: "10", width: "6", height: "1" }],
        },
        baseOnly(),
      );
    // 15 oz = 0.9375 lb; 60 cu in is under the 1728 cu in DIM threshold; (12,15.999] oz → 6.30
    const fifteen = usps("15");
    expect(fifteen.status).toBe("ok");
    expect(fifteen.zone?.zone).toBe("5");
    expect(fifteen.packages[0]).toMatchObject({ actualLb: "0.9375", billableLb: "0.9375", basis: "actual" });
    expect(fifteen.lines).toHaveLength(1);
    expect(fifteen.lines[0]).toMatchObject({
      label: "USPS Ground Advantage base rate",
      amount: { amount: "6.30", currency: "USD" },
      explanation: `Zone 5, 15.0 oz billable (bracket 12.0–15.999 oz) from origin 900, rate card "${CARD_NAME}".`,
      basis: `rate_card:fixture-card-v1:${USPS_GA}:5:15.999oz`,
    });
    expect(fifteen.totals.definite.amount).toBe("6.30");
    // 16 oz = 1 lb: above 15.999 oz, so the (0.99994,1] lb row → 7.05
    const sixteen = usps("16");
    expect(sixteen.packages[0]).toMatchObject({ actualLb: "1.0", billableLb: "1.0" });
    expect(sixteen.lines).toHaveLength(1);
    expect(sixteen.lines[0]).toMatchObject({ amount: { amount: "7.05", currency: "USD" }, basis: `rate_card:fixture-card-v1:${USPS_GA}:5:1lb` });
    expect(sixteen.lines[0]?.explanation).toContain("Zone 5, 1.0 lb billable");
    expect(sixteen.lines[0]?.explanation).toContain("from origin 900");
    expect(sixteen.totals.definite.amount).toBe("7.05");
  });
});
