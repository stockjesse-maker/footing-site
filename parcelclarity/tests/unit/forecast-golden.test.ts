import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateOrderFees } from "@/engine/fees";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot, type OrderFeeContext, type OrderFeeInput } from "@/engine/fees/types";
import { evaluateForecast, EXPECTED_VALUE_ORDINAL, type ForecastAssumptions, type ForecastDeps, type ForecastSummary } from "@/engine/forecast";
import { X } from "@/engine/forecast/grid";
import { ENGINE_VERSION, type RateCardSnapshot } from "@/engine/types";
import { hashAssumptions, sha256Hex } from "@/lib/forecast/hash";
import { fixtureContext, loadFixtureRateCard } from "../fixtures/pricing/load";

/**
 * Golden test for the forecast-from-assumptions engine (design §7, §9: "forecast golden on a
 * 2×2×1×1 grid written before the code"). `tests/fixtures/forecast/expected.json` was derived by
 * hand from RULES.md, the "standard" fee schedule and the pricing fixtures by an agent that never
 * read `src/engine/forecast`; every `_working` string there shows the arithmetic. When the engine
 * and the expectation disagree, the disagreement is settled by re-deriving from RULES.md and the
 * fixtures, never by pasting engine output into the fixture.
 *
 * Three layers, so a disagreement is localised:
 *   1. the fixture's own arithmetic (sums, weights, shares) and its agreement with the pricing
 *      fixture for the two shipping scenarios it names;
 *   2. per cell and content row, the order fees the fee engine produces for the order the forecast
 *      prices (the forecast's expected-value rule for order-share drivers applied by hand);
 *   3. every figure `evaluateForecast` reports: cells, shipping, processing by rule, monthly
 *      charges, the minimum, the allocation, the all-in figures and the identities the database
 *      checks on save.
 */

// ---------------------------------------------------------------------------
// Fixture shapes (as the files state them)
// ---------------------------------------------------------------------------

/** The design-level shape of §7: numeric monthlyOrders, content rows as a bare list, services by id. */
interface FixtureAssumptions {
  monthlyOrders: number;
  asOfDate: string;
  originZip: string;
  parcels: ForecastAssumptions["parcels"];
  zones: ForecastAssumptions["zones"];
  services: { serviceId: string; sharePct: string }[];
  residentialPct: string;
  multiPackage: { pct: string; packagesPerOrder: number };
  content: { units: number; lines: number; sharePct: string }[];
  fulfillment: ForecastAssumptions["fulfillment"];
}

interface FixtureFile {
  _sources: { scenarioIds: string[] };
  schedule: FeeScheduleSnapshot;
  assumptions: FixtureAssumptions;
}

interface ExpectedFeeLine {
  ruleKey: string;
  name: string;
  quantity: string;
  unitAmountE4: number | null;
  amountE4: number;
  chargeClass: string;
}

interface ExpectedOrderFees {
  contentIndex: number;
  units: number;
  lines: number;
  sharePct: string;
  status: string;
  orderFeesE4: number;
  definiteE4: number;
  estimatedE4: number;
  warnings: string[];
  unresolved: { ruleKey: string; name: string; reason: string; replacedBy?: string }[];
  feeLines: ExpectedFeeLine[];
}

interface ExpectedCell {
  parcelIndex: number;
  zoneIndex: number;
  zone: string;
  weight: string;
  shippingE4: number;
  shipping: {
    billableLb: string;
    basis: string;
    baseRateE4: number;
    minimumAdjustmentE4: number;
    baseFreightE4: number;
    fuelE4: number;
    totalE4: number;
    definiteE4: number;
    estimatedE4: number;
    conditionalExposureE4: number;
    hasExposure: boolean;
  };
  orderFees: ExpectedOrderFees[];
  expectedOrderFeesE4: number;
  weighted: { shippingE4: number; processingE4: number };
}

interface ExpectedMonthlyLine {
  ruleKey: string;
  name: string;
  category: string;
  driverKey: string | null;
  quantity: string;
  unitAmountE4: number | null;
  amountE4: number;
  chargeClass: string;
  scalesWithVolume: boolean;
}

interface ExpectedFile {
  cells: Record<string, ExpectedCell>;
  aggregates: {
    weightSum: string;
    shipping: { definiteE4: number; estimatedE4: number; totalE4: number; monthly: string; perOrder: string };
    processing: { definiteE4: number; estimatedE4: number; totalE4: number; monthly: string; perOrder: string; byRuleE4: Record<string, number> };
    monthlyFixed: { lines: ExpectedMonthlyLine[]; notModeled: unknown[]; unusedAnswers: string[]; definiteE4: number; estimatedE4: number; totalE4: number; monthly: string };
    minimum: {
      ruleKey: string;
      name: string;
      minimumE4: number;
      countedE4: number;
      topUpE4: number;
      status: string;
      reasons: string[];
      members: { ruleKey: string; name: string; state: string }[];
      buckets: { month: string; minimumE4: number; countedE4: number; topUpE4: number }[];
    };
    allocation: {
      input: { months: string; monthlyOrders: string; modeledOrders: number; shippingExpectedE4: number; processingE4: number; populationOrders: number; monthlyFixedE4: number; minimumTopUpE4: number; minimumStatus: string };
      monthly: Record<string, string | null>;
      perOrder: Record<string, string | null>;
      coveragePct: string;
      extrapolated: boolean;
      caveatKinds: string[];
    };
    allIn: { perOrder: string; monthly: string; annual: string };
    identities: { weightSum: string; weightSumEqualsMonthlyOrders: boolean; shippingDefiniteE4: number; processingDefiniteE4: number; allInPerOrderEqualsParts: boolean; allInPerOrderParts: string[] };
  };
}

/** One priced scenario of the pricing golden fixture (only the fields this test reads). */
interface PricingExpectation {
  status: string;
  lines: { label: string; amount: string; counted: boolean; chargeClass: string }[];
  totals: { definite: string; estimated: string; expected: string; conditionalExposure: string };
}

const forecastDir = new URL("../fixtures/forecast/", import.meta.url);
const read = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf8")) as T;
const fixture = read<FixtureFile>(new URL("assumptions.json", forecastDir));
const expected = read<ExpectedFile>(new URL("expected.json", forecastDir));
const pricingExpected = read<Record<string, PricingExpectation>>(new URL("../fixtures/pricing/expected.json", import.meta.url));
const schedules = read<Record<string, FeeScheduleSnapshot>>(new URL("../fixtures/fees/schedules.json", import.meta.url));

/** Which pricing scenario each cell of the fixture reproduces exactly (from `_sources.cells` in assumptions.json). */
const SCENARIO_CELLS: Record<string, string> = {
  zone_entered_directly: "parcel1|zone1|service|res0|pkg1",
  ground_minimum_charge: "parcel0|zone0|service|res0|pkg1",
};

const cellEntries = Object.entries(expected.cells);
const volume = new X(fixture.assumptions.monthlyOrders);
const eq = (a: string | number, b: string | number) => new X(a).eq(b);
const cents = (x: InstanceType<typeof X>) => x.toDecimalPlaces(2, X.ROUND_HALF_UP).toFixed(2);
const moneyE4 = (amount: string) => new X(amount).times(10000).toNumber();
const share = (pct: string) => new X(pct).div(100);

/** The engine's `ForecastAssumptions` v1 for the fixture's design-level assumptions: carrier and service codes come from the fixture rate card, never typed here. */
function engineAssumptions(f: FixtureAssumptions, card: RateCardSnapshot): ForecastAssumptions {
  return {
    version: 1,
    monthlyOrders: String(f.monthlyOrders),
    asOfDate: f.asOfDate,
    originZip: f.originZip,
    parcels: f.parcels,
    zones: f.zones,
    services: f.services.map((s) => {
      const terms = card.services.find((t) => t.serviceId === s.serviceId);
      if (!terms) throw new Error(`service ${s.serviceId} is not on the fixture rate card`);
      return { serviceId: s.serviceId, carrierCode: terms.carrierCode, serviceCode: terms.serviceCode, name: terms.serviceName, sharePct: s.sharePct };
    }),
    residentialPct: f.residentialPct,
    multiPackage: f.multiPackage,
    content: { rows: f.content },
    fulfillment: f.fulfillment,
  };
}

const card = loadFixtureRateCard();
const assumptions = engineAssumptions(fixture.assumptions, card);
const serviceId = fixture.assumptions.services[0]!.serviceId;
const deps: ForecastDeps = { pricing: fixtureContext({ rateCard: card }), schedule: fixture.schedule, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex };

let memo: ForecastSummary | null = null;
function summary(): ForecastSummary {
  if (memo) return memo;
  const result = evaluateForecast(assumptions, deps);
  if (result.status !== "ok") throw new Error(`expected an ok forecast, got ${JSON.stringify(result)}`);
  memo = result.summary;
  return memo;
}

/** The engine's cell key for an expected cell: one service, commercial only, one package (the fixture asserts those collapses below). */
const engineKey = (cell: ExpectedCell) => `${serviceId}|${cell.zone}|p${cell.parcelIndex}|com|k1`;

/** Expected chargeable quantity and amount per order of a rule, over the whole mix, from the fixture's per-cell lines (Σ weight × row share × line) / volume. */
function perOrderFromCells(ruleKey: string): { quantity: InstanceType<typeof X>; amountE4: InstanceType<typeof X>; lineShare: InstanceType<typeof X> } {
  let quantity = new X(0);
  let amountE4 = new X(0);
  let lineShare = new X(0);
  for (const [, cell] of cellEntries) {
    for (const row of cell.orderFees) {
      const w = new X(cell.weight).times(share(row.sharePct));
      const line = row.feeLines.find((l) => l.ruleKey === ruleKey);
      if (!line) continue;
      quantity = quantity.plus(w.times(line.quantity));
      amountE4 = amountE4.plus(w.times(line.amountE4));
      lineShare = lineShare.plus(w);
    }
  }
  return { quantity: quantity.div(volume), amountE4: amountE4.div(volume), lineShare: lineShare.div(volume) };
}

// ---------------------------------------------------------------------------
// 1. The fixture's own arithmetic and its agreement with the pricing fixture
// ---------------------------------------------------------------------------

describe("forecast golden: the fixture is consistent with itself", () => {
  it("copies the standard fee schedule verbatim and describes a 2×2×1×1 grid", () => {
    expect(fixture.schedule).toEqual(schedules.standard);
    expect(fixture.assumptions.parcels).toHaveLength(2);
    expect(fixture.assumptions.zones).toHaveLength(2);
    expect(fixture.assumptions.services).toHaveLength(1);
    expect(eq(fixture.assumptions.residentialPct, 0)).toBe(true);
    expect(eq(fixture.assumptions.multiPackage.pct, 0)).toBe(true);
    expect(cellEntries).toHaveLength(4);
    // Parcels are listed lightest first and zones ascending, so the fixture's indexes survive the engine's canonical ordering.
    expect(fixture.assumptions.parcels.map((p) => p.weightLb)).toEqual(["1", "10"]);
    expect(fixture.assumptions.zones.map((z) => z.zone)).toEqual(["2", "7"]);
    for (const [key, cell] of cellEntries) {
      expect(key).toBe(`parcel${cell.parcelIndex}|zone${cell.zoneIndex}|service|res0|pkg1`);
      expect(cell.zone).toBe(fixture.assumptions.zones[cell.zoneIndex]!.zone);
    }
  });

  it("weights every cell as monthlyOrders × parcel share × zone share, adding up to monthlyOrders", () => {
    let sum = new X(0);
    for (const [, cell] of cellEntries) {
      const weight = volume.times(share(fixture.assumptions.parcels[cell.parcelIndex]!.sharePct)).times(share(fixture.assumptions.zones[cell.zoneIndex]!.sharePct));
      expect(eq(cell.weight, weight.toFixed())).toBe(true);
      sum = sum.plus(cell.weight);
    }
    expect(sum.toFixed()).toBe(expected.aggregates.weightSum);
    expect(eq(expected.aggregates.weightSum, fixture.assumptions.monthlyOrders)).toBe(true);
  });

  it("adds each cell's shipping lines and fee lines to the stated totals", () => {
    for (const [key, cell] of cellEntries) {
      const s = cell.shipping;
      expect(s.baseRateE4 + s.minimumAdjustmentE4, key).toBe(s.baseFreightE4);
      expect(s.baseFreightE4 + s.fuelE4, key).toBe(s.totalE4);
      expect(s.totalE4, key).toBe(cell.shippingE4);
      expect(s.definiteE4 + s.estimatedE4, key).toBe(s.totalE4);
      expect(s.hasExposure, key).toBe(s.conditionalExposureE4 > 0);
      let expectedFees = new X(0);
      for (const row of cell.orderFees) {
        const rowKey = `${key} content ${row.contentIndex}`;
        const content = fixture.assumptions.content[row.contentIndex]!;
        expect([row.units, row.lines, row.sharePct], rowKey).toEqual([content.units, content.lines, content.sharePct]);
        expect(row.feeLines.reduce((n, l) => n + l.amountE4, 0), rowKey).toBe(row.orderFeesE4);
        expect(row.definiteE4 + row.estimatedE4, rowKey).toBe(row.orderFeesE4);
        // The handling percentage is taken of the cell's counted shipping (A6): 5% × the cell's shipping in E4, exactly.
        const handling = row.feeLines.find((l) => l.ruleKey === "handling_pct")!;
        expect(eq(handling.quantity, new X(cell.shippingE4).div(10000).toFixed(4)), rowKey).toBe(true);
        expect(handling.amountE4, rowKey).toBe(new X(cell.shippingE4).times("5.0000").div(100).toDecimalPlaces(0, X.ROUND_HALF_UP).toNumber());
        // A flat line is quantity × unit amount, exactly (A4, invoice_line rounding A9).
        for (const l of row.feeLines) if (l.unitAmountE4 !== null) expect(new X(l.quantity).times(l.unitAmountE4).toNumber(), `${rowKey} ${l.ruleKey}`).toBe(l.amountE4);
        expectedFees = expectedFees.plus(share(row.sharePct).times(row.orderFeesE4));
      }
      expect(expectedFees.toNumber(), key).toBe(cell.expectedOrderFeesE4);
      expect(cell.weighted.shippingE4, key).toBe(new X(cell.weight).times(cell.shippingE4).toNumber());
      expect(cell.weighted.processingE4, key).toBe(new X(cell.weight).times(cell.expectedOrderFeesE4).toNumber());
    }
  });

  it("adds the weighted cells and the per-rule cross-check to the stated aggregates", () => {
    const agg = expected.aggregates;
    expect(cellEntries.reduce((n, [, c]) => n + c.weighted.shippingE4, 0)).toBe(agg.shipping.totalE4);
    expect(cellEntries.reduce((n, [, c]) => n + c.weighted.processingE4, 0)).toBe(agg.processing.totalE4);
    expect(agg.shipping.definiteE4 + agg.shipping.estimatedE4).toBe(agg.shipping.totalE4);
    expect(agg.processing.definiteE4 + agg.processing.estimatedE4).toBe(agg.processing.totalE4);
    expect(Object.values(agg.processing.byRuleE4).reduce((n, v) => n + v, 0)).toBe(agg.processing.totalE4);
    for (const [ruleKey, e4] of Object.entries(agg.processing.byRuleE4)) expect(perOrderFromCells(ruleKey).amountE4.times(volume).toNumber(), ruleKey).toBe(e4);
    expect(agg.shipping.monthly).toBe(cents(new X(agg.shipping.totalE4).div(10000)));
    expect(agg.processing.monthly).toBe(cents(new X(agg.processing.totalE4).div(10000)));
    expect(agg.shipping.perOrder).toBe(cents(new X(agg.shipping.totalE4).div(10000).div(volume)));
    expect(agg.processing.perOrder).toBe(cents(new X(agg.processing.totalE4).div(10000).div(volume)));
    const monthly = agg.monthlyFixed;
    expect(monthly.lines.reduce((n, l) => n + l.amountE4, 0)).toBe(monthly.totalE4);
    expect(monthly.lines.filter((l) => l.chargeClass === "definite").reduce((n, l) => n + l.amountE4, 0)).toBe(monthly.definiteE4);
    expect(monthly.lines.filter((l) => l.chargeClass === "estimated").reduce((n, l) => n + l.amountE4, 0)).toBe(monthly.estimatedE4);
    expect(monthly.monthly).toBe(cents(new X(monthly.totalE4).div(10000)));
    expect(agg.allocation.input).toMatchObject({ shippingExpectedE4: agg.shipping.totalE4, processingE4: agg.processing.totalE4, monthlyFixedE4: monthly.totalE4, minimumTopUpE4: agg.minimum.topUpE4, minimumStatus: agg.minimum.status });
    expect(agg.allIn).toEqual({ perOrder: agg.allocation.perOrder.allIn, monthly: agg.allocation.monthly.total, annual: agg.allocation.monthly.annual });
    const parts = agg.identities.allInPerOrderParts.reduce((s, p) => s.plus(p), new X(0));
    expect(agg.identities.allInPerOrderParts).toEqual([agg.allocation.perOrder.shipping, agg.allocation.perOrder.processing, agg.allocation.perOrder.allocated]);
    expect(parts.minus(agg.allIn.perOrder).abs().lte("0.01")).toBe(true);
    expect(agg.identities.allInPerOrderEqualsParts).toBe(parts.eq(agg.allIn.perOrder));
  });

  it("agrees with the pricing fixture for the shipping scenarios it names", () => {
    expect([...fixture._sources.scenarioIds].sort()).toEqual(Object.keys(SCENARIO_CELLS).sort());
    for (const [scenarioId, cellKey] of Object.entries(SCENARIO_CELLS)) {
      const scenario = pricingExpected[scenarioId];
      expect(scenario, `pricing/expected.json has no entry for ${scenarioId}`).toBeDefined();
      const cell = expected.cells[cellKey]!;
      expect(scenario!.status, scenarioId).toBe("ok");
      // The counted total (definite + estimated) of the scenario is the cell's expected shipping; the forecast re-classes all of it estimated.
      expect(cell.shippingE4, scenarioId).toBe(moneyE4(scenario!.totals.expected));
      expect(cell.shipping.conditionalExposureE4, scenarioId).toBe(moneyE4(scenario!.totals.conditionalExposure));
      const line = (label: string) => scenario!.lines.filter((l) => l.label === label).reduce((n, l) => n + moneyE4(l.amount), 0);
      expect(cell.shipping.baseRateE4, scenarioId).toBe(line("UPS Ground base rate"));
      expect(cell.shipping.minimumAdjustmentE4, scenarioId).toBe(line("Minimum charge adjustment"));
      expect(cell.shipping.fuelE4, scenarioId).toBe(line("Fuel surcharge"));
      expect(scenario!.lines.filter((l) => l.counted).reduce((n, l) => n + moneyE4(l.amount), 0), scenarioId).toBe(cell.shippingE4);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Per cell and content row: the fee engine on the order the forecast prices
// ---------------------------------------------------------------------------

describe("forecast golden: order fees per cell and content row", () => {
  const context: OrderFeeContext = { orderShares: fixture.assumptions.fulfillment.orderShares, pinnedRates: {}, packagingDefault: null };
  for (const [key, cell] of cellEntries) {
    for (const row of cell.orderFees) {
      it(`${key}, ${row.units} item(s) in ${row.lines} line(s)`, () => {
        const parcel = fixture.assumptions.parcels[cell.parcelIndex]!;
        // The order the forecast prices for this cell: every quantity assumed, the cell's counted shipping, and an ordinal that qualifies for every order share.
        const input: OrderFeeInput = {
          units: row.units,
          lines: row.lines,
          distinctSkus: row.lines,
          packages: [{ packagingType: parcel.packagingType }],
          shipments: 1,
          shipping: { totalE4: cell.shippingE4, baseFreightE4: cell.shipping.baseFreightE4, estimated: true, hasExposure: cell.shipping.hasExposure },
          assumed: { units: true, lines: true, skus: true, packaging: true },
          ordinal: EXPECTED_VALUE_ORDINAL,
        };
        const result = calculateOrderFees(input, fixture.schedule, context);
        expect(result.status).toBe(row.status);
        // Order-share drivers: the engine priced a qualifying order; the expected value over all orders is that line × the share of orders that qualify (A7 per order, then the mix).
        const lines = result.lines.map((l) => {
          const p = l.basis === "order_driver" ? share(context.orderShares[fixture.schedule.rules.find((r) => r.key === l.ruleKey)!.driver!.key]!.sharePct) : new X(1);
          return { ruleKey: l.ruleKey, name: l.name, quantity: new X(l.quantity).times(p).toFixed(), unitAmountE4: l.unitAmountE4, amountE4: new X(l.amountE4).times(p).toNumber() };
        });
        // chargeClass is not compared: the forecast re-classes every counted line estimated at the summary level (design §7 [M5]); the fee engine's own class is checked in fees-golden.test.ts.
        expect(lines).toEqual(row.feeLines.map((l) => ({ ruleKey: l.ruleKey, name: l.name, quantity: new X(l.quantity).toFixed(), unitAmountE4: l.unitAmountE4, amountE4: l.amountE4 })));
        expect(lines.reduce((n, l) => n + l.amountE4, 0)).toBe(row.orderFeesE4);
        expect(result.unresolved.map((u) => ({ ruleKey: u.ruleKey, name: u.name, reason: u.reason, ...(u.replacedBy ? { replacedBy: u.replacedBy } : {}) }))).toEqual(row.unresolved);
        expect([...result.warnings].sort()).toEqual([...row.warnings].sort());
        for (const l of result.lines) expect(l.explanation).not.toContain("_");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 3. evaluateForecast
// ---------------------------------------------------------------------------

describe("forecast golden: evaluateForecast on the 2×2×1×1 grid", () => {
  it("prices the grid and echoes the assumptions in canonical form", () => {
    const s = summary();
    expect(s.version).toBe(2);
    expect(s.basis).toBe("assumptions");
    expect(s.feeMode).toBe("modeled");
    expect(s.monthlyOrders).toBe(String(fixture.assumptions.monthlyOrders));
    expect(s.asOfDate).toBe(fixture.assumptions.asOfDate);
    expect(s.counts).toEqual({ parcels: 2, zones: 2, services: 1, residentialSplits: 1, packageClasses: 1, cells: 4 });
    expect(s.priceOnlyCovered).toBe(false);
    expect(s.unpriceable).toEqual([]);
    expect(s.pricedSharePct).toBe("100.00");
    expect(s.assumptionsHash).toBe(hashAssumptions(assumptions));
    expect(s.assumptionsHash).toMatch(/^[0-9a-f]{64}$/);
    // Canonical order keeps the fixture's parcel and zone indexes.
    expect(s.profile.parcels.map((p) => p.weightLb)).toEqual(fixture.assumptions.parcels.map((p) => new X(p.weightLb).toFixed()));
    expect(s.profile.zones.map((z) => z.zone)).toEqual(fixture.assumptions.zones.map((z) => z.zone));
    expect(s.profile.content).toEqual({ source: "rows", averageUnits: null, averageLines: null, rows: fixture.assumptions.content.map((r) => ({ ...r, sharePct: new X(r.sharePct).toFixed() })) });
    expect(s.provenance).toMatchObject({ rateCardName: card.rateCardName, feeScheduleName: fixture.schedule.name, feeScheduleEffectiveDate: fixture.schedule.effectiveDate, feeScheduleExpirationDate: null });
    expect(s.forecastEngineVersion).toBeTypeOf("string");
    expect(s.feeEngineVersion).toBe(FEE_ENGINE_VERSION);
    expect(s.engineVersion).toBe(ENGINE_VERSION);
  });

  it("weights and prices every cell as the fixture states", () => {
    const s = summary();
    expect(s.cells).toHaveLength(4);
    expect(s.weightSum).toBe(expected.aggregates.weightSum);
    expect(s.pricedWeight).toBe(expected.aggregates.weightSum);
    for (const [key, cell] of cellEntries) {
      const engineCell = s.cells.find(([k]) => k === engineKey(cell));
      expect(engineCell, `${key} → ${engineKey(cell)}`).toBeDefined();
      const [, weight, shippingE4] = engineCell!;
      expect(eq(weight, cell.weight), `${key} weight ${weight} vs ${cell.weight}`).toBe(true);
      expect(shippingE4, `${key} shipping`).toBe(cell.shippingE4);
    }
  });

  it("reports the expected shipping, its base freight and its upper bounds", () => {
    const s = summary();
    const agg = expected.aggregates.shipping;
    expect(s.shipping.expectedE4).toBe(agg.totalE4);
    expect(s.shipping.expected).toBe(agg.monthly);
    expect(s.shipping.estimated).toBe(new X(agg.estimatedE4).div(10000).toFixed(4));
    expect(s.shipping.definite).toBe("0.00");
    expect(agg.definiteE4).toBe(0);
    expect(s.shipping.perOrder).toBe(agg.perOrder);
    expect(s.shipping.baseFreightE4).toBe(cellEntries.reduce((n, [, c]) => n + new X(c.weight).times(c.shipping.baseFreightE4).toNumber(), 0));
    // The address-correction exposure of every cell, never added to the expected cost.
    const conditional = cellEntries.reduce((n, [, c]) => n + new X(c.weight).times(c.shipping.conditionalExposureE4).toNumber(), 0);
    expect(s.shipping.conditionalUpToE4).toBe(conditional);
    expect(s.shipping.conditionalUpTo).toBe(cents(new X(conditional).div(10000)));
    // Delivery-area surcharges cannot be decided when a zone is entered directly: an upper bound, never added (the fixture states the lines are "estimated, uncounted").
    expect(s.shipping.unresolvedUpToE4).toBeGreaterThan(0);
    expect(s.shipping.unresolvedUpTo).toBe(cents(new X(s.shipping.unresolvedUpToE4).div(10000)));
    expect(s.cells.reduce((sum, [, w, e4]) => sum.plus(new X(w).times(e4 ?? 0)), new X(0)).toNumber()).toBe(agg.totalE4);
  });

  it("reports the expected processing in total and by rule", () => {
    const s = summary();
    const agg = expected.aggregates.processing;
    expect(s.processing).not.toBeNull();
    const processing = s.processing!;
    expect(processing.expectedE4).toBe(agg.totalE4);
    expect(processing.expected).toBe(agg.monthly);
    expect(processing.estimated).toBe(new X(agg.estimatedE4).div(10000).toFixed(4));
    expect(processing.definite).toBe("0.00");
    expect(agg.definiteE4).toBe(0);
    expect(processing.perOrder).toBe(agg.perOrder);
    expect(processing.unresolved).toEqual([]);
    expect(processing.warnings).toEqual([{ code: "fee_base_excludes_exposure", sharePct: "100.00" }]);
    const byKey = new Map(processing.byRule.map((r) => [r.key, r]));
    for (const [ruleKey, e4] of Object.entries(agg.byRuleE4)) {
      const figure = byKey.get(ruleKey);
      if (e4 === 0) {
        // A rule that never produced a line (the catch-all packaging rule, replaced on every package) has no figure.
        expect(figure, ruleKey).toBeUndefined();
        continue;
      }
      expect(figure, ruleKey).toBeDefined();
      const rule = fixture.schedule.rules.find((r) => r.key === ruleKey)!;
      const fromCells = perOrderFromCells(ruleKey);
      expect(figure!.expectedE4, ruleKey).toBe(e4);
      expect(figure!.expected, ruleKey).toBe(cents(new X(e4).div(10000)));
      expect(figure!.perOrder, ruleKey).toBe(cents(new X(e4).div(10000).div(volume)));
      expect(figure!.quantityPerOrder, ruleKey).toBe(fromCells.quantity.toDecimalPlaces(4, X.ROUND_HALF_UP).toFixed(4));
      expect(figure!.name, ruleKey).toBe(rule.name);
      expect([figure!.category, figure!.basis], ruleKey).toEqual([rule.category, rule.basis]);
      // Share of orders that get a line: from the cells for ordinary rules; for an order-share driver it is the answered share of orders
      // (every qualifying order gets a line when countPerOrder exceeds the free allowance), not the 100% of orders its expected-value line covers.
      const lineShare =
        rule.basis === "order_driver" ? share(fixture.assumptions.fulfillment.orderShares[rule.driver!.key]!.sharePct) : fromCells.lineShare;
      expect(figure!.ordersSharePct, ruleKey).toBe(cents(lineShare.times(100)));
    }
    expect(processing.byRule.map((r) => r.key)).toEqual(Object.keys(agg.byRuleE4).filter((k) => agg.byRuleE4[k] !== 0));
  });

  it("computes the monthly charges from the answers", () => {
    const s = summary();
    const agg = expected.aggregates.monthlyFixed;
    expect(s.monthly).not.toBeNull();
    const monthly = s.monthly!;
    expect(monthly.lines.map((l) => l.ruleKey)).toEqual(agg.lines.map((l) => l.ruleKey));
    monthly.lines.forEach((l, i) => {
      const e = agg.lines[i]!;
      expect(l.name, l.ruleKey).toBe(e.name);
      expect(l.category, l.ruleKey).toBe(e.category);
      expect(l.driverKey, l.ruleKey).toBe(e.driverKey);
      expect(eq(l.quantity, e.quantity), `${l.ruleKey} quantity ${l.quantity} vs ${e.quantity}`).toBe(true);
      expect(l.unitAmountE4, l.ruleKey).toBe(e.unitAmountE4);
      expect(l.amountE4, l.ruleKey).toBe(e.amountE4);
      expect(l.chargeClass, l.ruleKey).toBe(e.chargeClass);
      expect(l.scalesWithVolume, l.ruleKey).toBe(e.scalesWithVolume);
      expect(l.explanation, l.ruleKey).not.toContain("_");
    });
    expect(monthly.notModeled).toEqual(agg.notModeled);
    expect(monthly.unusedAnswers).toEqual(agg.unusedAnswers);
    expect(monthly.totalE4).toBe(agg.totalE4);
    expect(monthly.total).toBe(agg.monthly);
    expect(monthly.lines.filter((l) => l.chargeClass === "definite").reduce((n, l) => n + l.amountE4, 0)).toBe(agg.definiteE4);
    expect(monthly.lines.filter((l) => l.chargeClass === "estimated").reduce((n, l) => n + l.amountE4, 0)).toBe(agg.estimatedE4);
  });

  it("evaluates the account minimum over one average month", () => {
    const s = summary();
    const agg = expected.aggregates.minimum;
    expect(s.minimums).toHaveLength(1);
    const m = s.minimums[0]!;
    expect(m.ruleKey).toBe(agg.ruleKey);
    expect(m.name).toBe(agg.name);
    expect(m.minimumE4).toBe(agg.minimumE4);
    expect(m.countedE4).toBe(agg.countedE4);
    expect(m.topUpE4).toBe(agg.topUpE4);
    expect(m.status).toBe(agg.status);
    expect(m.reasons).toEqual(agg.reasons);
    expect(m.members).toEqual(agg.members);
    expect(m.buckets).toEqual(agg.buckets);
    expect(m.includesShipping).toBe(false);
    expect(s.minimumStatus).toBe(agg.status);
    expect(s.minimum).toEqual({ status: agg.status, topUpE4: agg.topUpE4, topUp: cents(new X(agg.topUpE4).div(10000)) });
  });

  it("allocates monthly and per-order figures and the all-in cost", () => {
    const s = summary();
    const agg = expected.aggregates.allocation;
    expect(s.allocation).not.toBeNull();
    const allocation = s.allocation!;
    expect(allocation.monthly).toEqual(agg.monthly);
    expect(allocation.perOrder).toEqual(agg.perOrder);
    expect(allocation.coveragePct).toBe(agg.coveragePct);
    expect(allocation.extrapolated).toBe(agg.extrapolated);
    expect(allocation.caveats).toEqual(agg.caveatKinds);
    expect(s.allocated).toEqual({ perOrder: agg.perOrder.allocated, monthly: cents(new X(agg.monthly.fixed!).plus(agg.monthly.minimumTopUp ?? "0")) });
    expect(s.complete).toBe(true);
    expect(s.completeness.every((c) => c.state !== "not_modeled")).toBe(true);
    expect(s.allIn).toEqual(expected.aggregates.allIn);
    expect(s.caveats).toEqual(["expected_values", "independent_distributions", "one_shipment_per_order", "exact_weights", "no_shipment_options", "delivery_area_undecided", "effective_dates"]);
  });

  it("satisfies the identities the database checks on save", () => {
    const s = summary();
    const ids = expected.aggregates.identities;
    expect(ids.weightSumEqualsMonthlyOrders).toBe(true);
    expect(eq(s.weightSum, s.monthlyOrders)).toBe(true);
    expect(eq(s.weightSum, ids.weightSum)).toBe(true);
    expect(s.shipping.definite).toBe("0.00");
    expect(s.processing!.definite).toBe("0.00");
    expect([ids.shippingDefiniteE4, ids.processingDefiniteE4]).toEqual([0, 0]);
    const parts = new X(s.shipping.perOrder).plus(s.processing!.perOrder).plus(s.allocated!.perOrder!);
    expect([s.shipping.perOrder, s.processing!.perOrder, s.allocated!.perOrder]).toEqual(ids.allInPerOrderParts);
    expect(parts.minus(s.allIn!.perOrder).abs().lte("0.01")).toBe(true);
    expect(parts.eq(s.allIn!.perOrder)).toBe(ids.allInPerOrderEqualsParts);
    const monthlyParts = new X(s.allocation!.monthly.shipping!).plus(s.allocation!.monthly.processing!).plus(s.allocation!.monthly.fixed).plus(s.allocation!.monthly.minimumTopUp!);
    expect(monthlyParts.toFixed(2)).toBe(s.allocation!.monthly.total);
    // What save_forecast_run recomputes from the answers: the monthly total in E4.
    expect(s.monthly!.totalE4).toBe(expected.aggregates.monthlyFixed.totalE4);
  });

  it("never puts rule keys or ids in customer-facing text", () => {
    const s = summary();
    const text = [...s.completeness.flatMap((c) => c.rules.map((r) => r.describe)), ...s.monthly!.lines.map((l) => l.explanation), ...s.unpriceable.map((u) => u.message)].join("\n");
    for (const rule of fixture.schedule.rules) if (!rule.name.toLowerCase().includes(rule.key)) expect(text).not.toContain(rule.key);
    expect(JSON.stringify(s)).not.toContain(fixture.schedule.versionId);
  });
});
