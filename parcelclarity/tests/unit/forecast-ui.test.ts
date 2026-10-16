import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeAssumptions, evaluateForecast, type ForecastAssumptions, type ForecastDeps, type ForecastSummary } from "@/engine/forecast";
import type { ForecastContext, ForecastFormState } from "@/components/forecast/forecast-model";
import { FEE_ENGINE_VERSION, type FeeScheduleSnapshot } from "@/engine/fees/types";
import { ENGINE_VERSION } from "@/engine/types";

// queries.ts and the fee queries are server-only modules; the marker package refuses to load outside a server build.
vi.mock("server-only", () => ({}));
// The result view shares money formatting with the calculator, whose module graph reaches the surcharge actions.
vi.mock("@/app/actions/surcharges", () => ({ addSurchargeRuleVersion: vi.fn(), createSurchargeRule: vi.fn(), retireRuleVersion: vi.fn(), uploadZipList: vi.fn() }));
vi.mock("@/app/actions/forecast", () => ({ previewForecast: vi.fn(), saveForecast: vi.fn(), loadForecastFormContext: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { ForecastForm, latestOutcome } = await import("@/components/forecast/forecast-form");
const { ForecastResult, UnpriceableTable } = await import("@/components/forecast/forecast-result");
const model = await import("@/components/forecast/forecast-model");
const resultModel = await import("@/components/forecast/result-model");
const { forecastResultData } = await import("@/lib/forecast/queries");
const { driverQuestions } = await import("@/lib/fees/queries");
const { boxOptionsFromSnapshot } = await import("@/lib/pricing/calculator-schema");
const { scheduleReadsOrderContent } = await import("@/lib/modeling/assumptions");
const { zonesFromRows } = await import("@/lib/forecast/zone-model");
const { sha256Hex } = await import("@/lib/forecast/hash");
const { fixtureContext } = await import("../fixtures/pricing/load");

/**
 * The forecast screens' pure parts and their server render: form state → assumptions (the engine's
 * own validation decides what is valid), the headline a summary earns, what is not included and how
 * to add it, the brand-safe copy, and every component rendered on the server so a render path that
 * throws fails here, not in the browser. Money expectations come from the fixture rate card and the
 * "standard" fee schedule as the engine's tests derive them (tests/unit/forecast.test.ts).
 */
const schedules = JSON.parse(readFileSync(new URL("../fixtures/fees/schedules.json", import.meta.url), "utf8")) as Record<string, FeeScheduleSnapshot>;
const standard = schedules.standard!;
const UPS = "svc-ups-ground";
const USPS = "svc-usps-ga";
const pricing = fixtureContext();

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

function deps(over: Partial<ForecastDeps> = {}): ForecastDeps {
  return { pricing, schedule: standard, pinnedRates: {}, feeEngineVersion: FEE_ENGINE_VERSION, engineVersion: ENGINE_VERSION, hash: sha256Hex, ...over };
}

function context(over: Partial<ForecastContext> = {}): ForecastContext {
  const zoneMap = zonesFromRows(pricing.rateCard.rows, "90001", pricing.rateCard.services.map((t) => ({ serviceId: t.serviceId, zoneIndependent: t.zoneIndependent })));
  const box = boxOptionsFromSnapshot(standard);
  return {
    status: "ok",
    asOfDate: "2026-03-15",
    originZip: "90001",
    rateCard: { id: "fixture-card", name: "Fixture rate card", effectiveDate: "2026-01-01", expirationDate: null },
    cards: [{ id: "fixture-card", name: "Fixture rate card" }],
    services: pricing.rateCard.services.map((t) => ({ serviceId: t.serviceId, carrierCode: t.carrierCode, serviceCode: t.serviceCode, name: t.serviceName, zoneIndependent: t.zoneIndependent, dimExempt: t.dim.exempt, zones: zoneMap[t.serviceId] ?? [] })),
    schedule: { status: "ok", name: standard.name, effectiveDate: standard.effectiveDate, questions: driverQuestions(standard), packaging: box.packaging, allowOtherPackaging: box.allowOtherPackaging, readsOrderContent: scheduleReadsOrderContent(standard) },
    warnings: [],
    ...over,
  };
}

/** The assumptions of tests/unit/forecast.test.ts, which that suite prices by hand. */
function assumptions(over: Partial<ForecastAssumptions> = {}): ForecastAssumptions {
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
      { serviceId: UPS, carrierCode: "ups", serviceCode: "ground", name: "UPS Ground", sharePct: "70" },
      { serviceId: USPS, carrierCode: "usps", serviceCode: "ground_advantage", name: "USPS Ground Advantage", sharePct: "30" },
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

/** The form filled in with exactly `assumptions()`. */
function filledState(ctx: ForecastContext): ForecastFormState {
  const s = model.initialFormState(ctx);
  const answer = (value: string) => ({ choice: "number" as const, value });
  return {
    ...s,
    monthlyOrders: "1250",
    asOfDate: "2026-03-15",
    originZip: "90001",
    parcels: [
      { weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packaging: "box", sharePct: "60", unknownSize: false },
      { weightLb: "0.5", lengthIn: "", widthIn: "", heightIn: "", packaging: "poly mailer", sharePct: "40", unknownSize: true },
    ],
    zones: [
      { zone: "2", sharePct: "50" },
      { zone: "5", sharePct: "30" },
      { zone: "8", sharePct: "20" },
    ],
    services: [
      { serviceId: UPS, sharePct: "70" },
      { serviceId: USPS, sharePct: "30" },
    ],
    residentialPct: "80",
    multiPct: "10",
    packagesPerOrder: "2",
    contentRows: [
      { units: "1", lines: "1", sharePct: "60" },
      { units: "3", lines: "2", sharePct: "40" },
    ],
    fulfillment: {
      ...s.fulfillment,
      drivers: { pallets_stored: answer("10"), long_term_pallets: answer("2"), pallets_received: answer("4"), cases_received: answer("20"), returns_rate: answer("3") },
      shares: { inserts: { choice: "number", sharePct: "40", count: "2" } },
    },
  };
}

function summaryOf(a: ForecastAssumptions, d: ForecastDeps = deps(), options = {}): ForecastSummary {
  const r = evaluateForecast(a, d, options);
  if (r.status !== "ok") throw new Error(`expected an ok forecast, got ${r.status}`);
  return r.summary;
}

const NO_ANSWERS = { drivers: {}, orderShares: {} };
/** Rule keys that no customer-facing word collides with ("returns", "admin" and "minimum" are also plain words and categories). */
const DISTINCT_RULE_KEYS = standard.rules.map((r) => r.key).filter((k) => k.includes("_"));

describe("form state → assumptions", () => {
  const ctx = context();

  it("turns the filled-in form into exactly the assumptions the engine tests price", () => {
    const built = model.buildAssumptions(filledState(ctx), ctx, "2026-03-15");
    expect(built.errors).toEqual({});
    expect(built.general).toEqual([]);
    expect(canonicalizeAssumptions(built.assumptions!)).toEqual(canonicalizeAssumptions(assumptions()));
    expect(evaluateForecast(built.assumptions, deps()).status).toBe("ok");
  });

  it("round-trips a saved forecast through the form (edit as new forecast)", () => {
    const a = assumptions({ content: { averageUnits: "1.4", averageLines: "1.2" } });
    const state = model.initialFormState(ctx, a);
    expect(state.contentMode).toBe("average");
    expect(state.asOfDate).toBeNull();
    const built = model.buildAssumptions(state, ctx, "2026-03-15");
    expect(built.errors).toEqual({});
    expect(canonicalizeAssumptions(built.assumptions!)).toEqual(canonicalizeAssumptions(a));
  });

  it("leaves what the new date's rate card no longer offers blank instead of silently changing it", () => {
    const a = assumptions();
    const fewer = context({ services: ctx.services.filter((s) => s.serviceId === UPS) });
    const state = model.initialFormState(fewer, a);
    expect(state.services.map((s) => s.serviceId)).toEqual([UPS, ""]);
    expect(model.buildAssumptions(state, fewer, "2026-03-15").errors["services.1.serviceId"]).toBe("Choose a service.");
  });

  it("names every blank required field and never defaults one", () => {
    const state = model.initialFormState(ctx);
    const { assumptions: built, errors } = model.buildAssumptions(state, ctx, "2026-03-15");
    expect(built).toBeNull();
    expect(errors.monthlyOrders).toBe("Enter how many orders you ship in a month.");
    expect(errors["parcels.0.weightLb"]).toBe("Enter the parcel's weight in pounds.");
    expect(errors["services.0.serviceId"]).toBe("Choose a service.");
    expect(errors["zones.0.zone"]).toBe("Choose a zone.");
    expect(errors.residentialPct).toBe("Enter the share of orders delivered to homes (0 if none).");
    // Every question of the fee schedule needs a choice: a number, "not sure" or "we don't use this".
    expect(errors["fulfillment.drivers.pallets_stored"]).toContain("Choose one");
    expect(errors["fulfillment.orderShares.inserts"]).toContain("Choose one");
    // The order content is asked because a fee reads items per order, and it is blank, not 1 item.
    expect(errors["content.rows.0.units"]).toBe("Enter a whole number of items.");
  });

  it("asks for dimensions where a chosen service prices by size, unless the parcel's size is unknown", () => {
    const state = filledState(ctx);
    const noDims = { ...state, parcels: [{ ...state.parcels[0]!, lengthIn: "", widthIn: "", heightIn: "" }, state.parcels[1]!] };
    const errors = model.buildAssumptions(noDims, ctx, "2026-03-15").errors;
    expect(errors["parcels.0.dims"]).toBe(`UPS Ground, USPS Ground Advantage price by size. Give the parcel's length, width and height, or tick "I don't know the size".`);
    expect(errors["parcels.1.dims"]).toBeUndefined();
    const partial = { ...state, parcels: [{ ...state.parcels[0]!, widthIn: "" }, state.parcels[1]!] };
    expect(model.buildAssumptions(partial, ctx, "2026-03-15").errors["parcels.0.dims"]).toBe("Give the length, width and height, or leave all three empty.");
    const unknown = { ...noDims, parcels: [{ ...noDims.parcels[0]!, unknownSize: true }, noDims.parcels[1]!] };
    expect(model.buildAssumptions(unknown, ctx, "2026-03-15").errors).toEqual({});
  });

  it("needs no dimensions when every chosen service is exempt from dimensional weight", () => {
    const exempt = context({ services: ctx.services.map((s) => ({ ...s, dimExempt: true })) });
    const state = filledState(exempt);
    const noDims = { ...state, parcels: [{ ...state.parcels[0]!, lengthIn: "", widthIn: "", heightIn: "" }, state.parcels[1]!] };
    expect(model.buildAssumptions(noDims, exempt, "2026-03-15").errors).toEqual({});
  });

  it("reports shares that do not add up on the distribution, in words", () => {
    const state = filledState(ctx);
    const errors = model.buildAssumptions({ ...state, parcels: [state.parcels[0]!, { ...state.parcels[1]!, sharePct: "30" }] }, ctx, "2026-03-15").errors;
    expect(errors.parcels).toBe("Shares add up to 90.00%, not 100.00%.");
  });

  it("puts a share that is not a percentage on its row", () => {
    const state = filledState(ctx);
    const errors = model.buildAssumptions({ ...state, zones: [{ zone: "2", sharePct: "50.123" }, ...state.zones.slice(1)] }, ctx, "2026-03-15").errors;
    expect(errors["zones.0.sharePct"]).toBe("Share must be a percentage with up to 2 decimals.");
  });

  it("hides zones and sends the zone 'ALL' when every chosen service is priced without zones", () => {
    const independent = context({ services: ctx.services.map((s) => ({ ...s, zoneIndependent: true, zones: ["ALL"] })) });
    const state = { ...filledState(independent), zones: [{ zone: "", sharePct: "100.00" }] };
    expect(model.availableZones(independent.services, [UPS, USPS])).toEqual({ zones: [], hidden: true });
    const built = model.buildAssumptions(state, independent, "2026-03-15");
    expect(built.errors).toEqual({});
    expect(built.assumptions!.zones).toEqual([{ zone: "ALL", sharePct: "100" }]);
  });

  it("lists the union of the zones of the chosen services, numerically sorted, and every service's zones while none is chosen", () => {
    expect(model.availableZones(ctx.services, [UPS])).toEqual({ zones: ["2", "3", "4", "5", "6", "7", "8"], hidden: false });
    expect(model.availableZones(ctx.services, [USPS]).zones).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(model.availableZones(ctx.services, []).zones).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("skips fulfillment costs: no answers are asked, the order content is not asked, and the skip is carried", () => {
    const skipped = { ...filledState(ctx), fulfillment: { ...filledState(ctx).fulfillment, skip: true }, contentRows: [{ units: "", lines: "", sharePct: "" }] };
    expect(model.asksOrderContent(ctx, true)).toBe(false);
    const built = model.buildAssumptions(skipped, ctx, "2026-03-15");
    expect(built.errors).toEqual({});
    expect(built.assumptions!.fulfillment).toEqual({ skip: true, drivers: {}, orderShares: {} });
  });

  it("asks nothing about fulfillment when no fee schedule is in effect", () => {
    const none = context({ schedule: { status: "none" } });
    const state = { ...filledState(none), contentRows: [{ units: "", lines: "", sharePct: "" }] };
    const built = model.buildAssumptions(state, none, "2026-03-15");
    expect(built.errors).toEqual({});
    expect(built.assumptions!.fulfillment).toEqual({ drivers: {}, orderShares: {} });
  });

  it("carries 'not sure' as null and 'we don't use this' as 0, never as a missing answer", () => {
    const state = filledState(ctx);
    const answers = { ...state.fulfillment, drivers: { ...state.fulfillment.drivers, pallets_stored: { choice: "unsure" as const, value: "" }, returns_rate: { choice: "none" as const, value: "" } } };
    const built = model.buildAssumptions({ ...state, fulfillment: answers }, ctx, "2026-03-15");
    expect(built.assumptions!.fulfillment.drivers.pallets_stored).toBeNull();
    expect(built.assumptions!.fulfillment.drivers.returns_rate).toBe("0");
  });

  it("prices the 'not sure' form as not computed: pallet storage is listed as not included, not counted as $0", () => {
    const state = filledState(ctx);
    const answers = { ...state.fulfillment, drivers: { ...state.fulfillment.drivers, pallets_stored: { choice: "unsure" as const, value: "" } } };
    const built = model.buildAssumptions({ ...state, fulfillment: answers }, ctx, "2026-03-15");
    const summary = summaryOf(built.assumptions!);
    expect(resultModel.notIncludedItems(summary).map((i) => i.name)).toEqual(["Pallet storage"]);
    expect(summary.allIn).toBeNull();
  });
});

describe("problems → field errors", () => {
  it("keys the engine's problems by control and keeps the rest as general sentences", () => {
    const found = model.fieldErrorsFromProblems([
      "parcels.0.weightLb: must be a number with up to 4 decimals",
      "zones: shares add up to 90.00%, not 100.00%",
      "parcels.1.lengthIn: give all three dimensions or none",
      "parcels.1.widthIn: must be greater than zero",
      "content: the average number of lines per order cannot exceed the average number of items",
      "the mix has too many combinations to price: 14 parcels × 30 zones = 420 cells; use fewer rows",
      "assumptions: Unrecognized key",
    ]);
    expect(found.fields).toEqual({
      "parcels.0.weightLb": "Weight must be a number with up to 4 decimals.",
      zones: "Shares add up to 90.00%, not 100.00%.",
      "parcels.1.dims": "Give all three dimensions or none.",
      content: "The average number of lines per order cannot exceed the average number of items.",
    });
    expect(found.general).toEqual(["The mix has too many combinations to price: 14 parcels × 30 zones = 420 cells; use fewer rows.", "Unrecognized key."]);
  });
});

describe("pre-flight", () => {
  const ctx = context();
  it("names the product of the grid", () => {
    const s = model.initialFormState(ctx);
    expect(model.preflight(s, ctx).sentence).toBe("1 parcel × 1 zone × 1 service × 2 residential splits × 1 package class = 2 cells");
    const f = filledState(ctx);
    const p = model.preflight(f, ctx);
    expect(p.counts).toEqual({ parcels: 2, zones: 3, services: 2, residentialSplits: 2, packageClasses: 2, cells: 48 });
    expect(p.sentence).toBe("2 parcels × 3 zones × 2 services × 2 residential splits × 2 package classes = 48 cells");
    expect(p.overLimit).toBe(false);
  });

  it("drops the split when the share is 0 or 100, and flags more than 1,500 cells", () => {
    const f = { ...filledState(ctx), residentialPct: "100", multiPct: "0" };
    expect(model.preflight(f, ctx).counts).toMatchObject({ residentialSplits: 1, packageClasses: 1, cells: 12 });
    const many = { ...f, parcels: Array.from({ length: 14 }, () => model.emptyParcel("7.14")), zones: Array.from({ length: 12 }, () => ({ zone: "2", sharePct: "8.33" })), services: Array.from({ length: 10 }, () => ({ serviceId: UPS, sharePct: "10" })) };
    expect(model.preflight(many, ctx)).toMatchObject({ overLimit: true });
    expect(model.preflight(many, ctx).counts.cells).toBe(14 * 12 * 10);
    expect(model.preflight({ ...many, zones: many.zones.slice(0, 10) }, ctx).overLimit).toBe(false);
  });

  it("hides zones from the count when no zone is asked", () => {
    const independent = context({ services: ctx.services.map((s) => ({ ...s, zoneIndependent: true })) });
    expect(model.preflight(filledState(independent), independent).counts.zones).toBe(1);
  });
});

describe("context changes", () => {
  it("blanks a service or zone the new context does not offer, and keeps what it still offers", () => {
    const ctx = context();
    const state = filledState(ctx);
    const next = context({ services: ctx.services.filter((s) => s.serviceId === UPS).map((s) => ({ ...s, zones: ["2", "5"] })) });
    const reconciled = model.reconcileState(state, next);
    expect(reconciled.services.map((s) => s.serviceId)).toEqual([UPS, ""]);
    expect(reconciled.zones.map((z) => z.zone)).toEqual(["2", "5", ""]);
    expect(reconciled.zones.map((z) => z.sharePct)).toEqual(["50", "30", "20"]);
  });

  it("keeps the answers to questions both schedules ask and gives a new question an unanswered state", () => {
    const ctx = context();
    const state = filledState(ctx);
    if (ctx.schedule.status !== "ok") throw new Error("schedule");
    const extra = { ...ctx.schedule.questions.find((q) => q.answers === "drivers")!, key: "bins_stored", label: "Bins stored" };
    const next = context({ schedule: { ...ctx.schedule, questions: [...ctx.schedule.questions, extra] } });
    const reconciled = model.reconcileState(state, next);
    expect(reconciled.fulfillment.drivers.pallets_stored).toEqual({ choice: "number", value: "10" });
    expect(reconciled.fulfillment.drivers.bins_stored).toEqual({ choice: null, value: "" });
  });
});

describe("the headline a summary earns", () => {
  it("is 'All-in cost per order' when every category is priced, with the engine's figures", () => {
    const summary = summaryOf(assumptions());
    const h = resultModel.forecastHeadline(summary);
    expect(summary.allIn).not.toBeNull();
    expect(h.kind).toBe("all_in");
    expect(h.label).toBe("All-in cost per order");
    expect(h.perOrder).toBe(summary.allIn!.perOrder);
    expect(h.monthly).toBe(summary.allIn!.monthly);
    expect(h.annual).toBe(summary.allIn!.annual);
    expect(h.notIncluded).toEqual([]);
    // Shipping $14.35 + order fees $4.41 + monthly charges spread $0.34 = $19.10.
    expect(h.parts).toEqual({ shipping: "14.35", orderFees: "4.41", monthlyCharges: "0.34" });
    expect(h.perOrder).toBe("19.10");
  });

  it("is 'without …' with 'at least' and every unanswered fee, with its rate and where to add it, when answers are missing", () => {
    const summary = summaryOf(assumptions({ fulfillment: NO_ANSWERS }));
    const h = resultModel.forecastHeadline(summary);
    expect(summary.allIn).toBeNull();
    expect(h.kind).toBe("at_least");
    expect(h.label).toBe("All-in cost per order, without receiving, storage, returns and other fees");
    expect(h.perOrder).toBe(summary.allocation!.perOrder.allIn);
    const byName = Object.fromEntries(h.notIncluded.map((i) => [i.name, i]));
    expect(Object.keys(byName).sort()).toEqual(["Loose carton receiving", "Long-term pallet storage (over 180 days)", "Marketing inserts", "Pallet receiving", "Pallet storage", "Returns processing"].sort());
    expect(byName["Pallet storage"]).toMatchObject({ category: "storage", categoryLabel: "Storage", rate: "$15.00 per pallet per month.", reason: "no number was given", target: { kind: "driver", key: "pallets_stored" } });
    expect(byName["Returns processing"]!.target).toEqual({ kind: "driver", key: "returns_rate" });
    // An order-share fee has no single question to focus: Add takes the person to the fulfillment section.
    expect(byName["Marketing inserts"]).toMatchObject({ target: { kind: "fulfillment" }, orders: 1250 });
    expect(byName["Marketing inserts"]!.rate).toContain("$0.25 per insert");
  });

  it("says the account minimum is met, not 'could add more', when its upper bound is zero", () => {
    const summary = summaryOf(assumptions({ fulfillment: NO_ANSWERS }));
    expect(summary.minimumStatus).toBe("upper_bound");
    expect(summary.minimums[0]!.topUpE4).toBe(0);
    const line = resultModel.assumptionLines(summary).find((l) => l.id === "minimum_upper_bound")!;
    expect(line.text).toContain("already meet the account minimum");
    expect(resultModel.forecastHeadline(summary).minimumUpTo).toBeNull();
  });

  it("is shipping only when fulfillment costs are skipped, with the reason and no per-fee list", () => {
    const summary = summaryOf(assumptions({ fulfillment: { skip: true, drivers: {}, orderShares: {} } }));
    const h = resultModel.forecastHeadline(summary);
    expect(h).toMatchObject({ kind: "shipping_only", label: "Estimated shipping cost per order", perOrder: summary.shipping.perOrder, notIncluded: [], annual: null });
    expect(h.note).toBe("Fulfillment costs were skipped, so this is shipping only.");
  });

  it("is shipping only, with its own reason, when no fee schedule is in effect", () => {
    const summary = summaryOf(assumptions({ fulfillment: NO_ANSWERS }), deps({ schedule: null }));
    const h = resultModel.forecastHeadline(summary);
    expect(h.kind).toBe("shipping_only");
    expect(h.note).toBe("No fee schedule is in effect for you on Mar 15, 2026, so this is shipping only.");
  });

  it("has no combined figure when only part of the volume could be priced", () => {
    // Zone 9 is on no rate row: 20% of orders cannot be priced, and nothing is estimated for them.
    const a = assumptions({ zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] });
    expect(evaluateForecast(a, deps()).status).toBe("blocked");
    const summary = summaryOf(a, deps(), { priceOnlyCovered: true });
    const h = resultModel.forecastHeadline(summary);
    expect(summary.allIn).toBeNull();
    expect(h.kind).toBe("partial");
    expect(h.perOrder).toBeNull();
    expect(h.monthly).toBeNull();
    expect(h.label).toContain(`${summary.pricedSharePct}% of orders that could be priced`);
    expect(h.parts.shipping).toBe(summary.shipping.perOrder);
  });
});

describe("brand-safe copy", () => {
  const full = summaryOf(assumptions());

  it("blanks every rule key, service id, hash and engine version for a brand, and drops the per-cell records", () => {
    const scrubbed = resultModel.scrubForecast(full, "brand");
    const json = JSON.stringify(scrubbed);
    for (const key of DISTINCT_RULE_KEYS) expect(json, key).not.toContain(key);
    // The key fields themselves are blank, wherever they sit (including the keys that look like plain words).
    const keyFields: unknown[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (["key", "ruleKey", "serviceId"].includes(k)) keyFields.push(x);
          else walk(x);
        }
      }
    };
    walk(scrubbed);
    expect(keyFields.length).toBeGreaterThan(10);
    expect(keyFields.every((x) => x === "")).toBe(true);
    expect(json).not.toContain(UPS);
    expect(json).not.toContain(USPS);
    expect(json).not.toContain(full.assumptionsHash);
    expect(scrubbed.assumptionsHash).toBe("");
    expect(scrubbed.engineVersion).toBe("");
    expect(scrubbed.feeEngineVersion).toBe("");
    expect(scrubbed.cells).toEqual([]);
    // What the screen needs is left: names, rates, figures.
    expect(scrubbed.processing!.byRule.map((r) => r.name)).toContain("Each additional item");
    expect(scrubbed.shipping.perOrder).toBe(full.shipping.perOrder);
  });

  it("keeps the keys for staff (only the cells go) and never changes its input", () => {
    const staff = resultModel.scrubForecast(full, "staff");
    expect(staff.cells).toEqual([]);
    expect(staff.processing!.byRule[0]!.key).toBe(full.processing!.byRule[0]!.key);
    expect(full.cells.length).toBeGreaterThan(0);
    expect(full.assumptionsHash).not.toBe("");
  });
});

describe("the result renders", () => {
  const full = summaryOf(assumptions());
  const missing = summaryOf(assumptions({ fulfillment: NO_ANSWERS }));

  it("prints the sentence the design requires, the headline, the assumptions card and what was described", () => {
    const html = renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(full, "brand"), audience: "brand" }));
    const t = text(html);
    expect(t).toContain("Forecast from your assumptions at 1,250 orders a month. Each figure is the expected value over the mix you described; not a prediction for any month and not an invoice.");
    expect(t).toContain("All-in cost per order");
    expect(t).toContain("$19.10 per order");
    expect(t).toContain("$286,500.48 a year if every month looked like this");
    // Every allocated figure says what it is spread over.
    expect(t).toContain("monthly charges $0.34 (spread over 1,250 orders a month, the volume you gave)");
    expect(t).toContain("What this forecast assumes");
    expect(t).toContain("treated as independent of the others");
    expect(t).toContain("could not be decided (up to $56,485.00 a month)");
    expect(t).toContain("rate card Fixture Freight customer rate card (fictional), in effect from Jan 1, 2026");
    expect(t).toContain("fee schedule Fictional Standard Fulfillment 2026, in effect from Jan 1, 2026");
    expect(t).toContain("Order fees");
    expect(t).toContain("Monthly charges");
    expect(t).toContain("Account minimum");
    expect(t).toContain("If your volume were different");
    expect(t).toContain("0.5× your volume");
    expect(t).toContain("What you described");
  });

  it("prints no rule key, service id or driver key for a brand", () => {
    const html = renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(missing, "brand"), audience: "brand", onAdd: () => undefined }));
    for (const key of [...DISTINCT_RULE_KEYS, "pallets_stored", "long_term_pallets", "returns_rate", "cases_received", UPS, USPS]) expect(html, key).not.toContain(key);
  });

  it("lists a missing fee as not computed with its rate and an Add prompt, never as $0", () => {
    const data = forecastResultData(missing, "brand");
    const html = renderToStaticMarkup(createElement(ForecastResult, { data, audience: "brand", onAdd: () => undefined }));
    const t = text(html);
    expect(t).toContain("At least");
    expect(t).toContain("All-in cost per order, without receiving, storage, returns and other fees");
    expect(t).toContain("Pallet storage (storage) $15.00 per pallet per month. Not computed: no number was given.");
    expect(t).toContain("Marketing inserts (other fees)");
    expect(t).toContain("never counted as $0");
    expect(html.match(/>Add<span class="sr-only"> numbers for /g)).toHaveLength(6);
    // None of them is in the monthly charges table as a line with an amount.
    const monthlyTable = html.slice(html.indexOf('aria-label="Monthly charges"'));
    expect(monthlyTable.slice(0, monthlyTable.indexOf("</table>"))).not.toContain("Pallet storage");
    // Fees that could not be computed are not shown as zero amounts anywhere next to their names.
    expect(t).not.toMatch(/Pallet storage[^.]{0,40}\$0\.00/);
  });

  it("says 'not computed', never $0.00, for monthly charges none of which could be computed", () => {
    // A schedule of two storage charges and no answers: every monthly figure is unknown, and there are no order fees to count.
    const storage = schedules.storage_surcharge!;
    const summary = summaryOf(assumptions({ fulfillment: NO_ANSWERS }), deps({ schedule: storage }));
    const data = forecastResultData(summary, "brand");
    expect(data.headline.kind).toBe("at_least");
    expect(data.headline.parts.monthlyCharges).toBeNull();
    const t = text(renderToStaticMarkup(createElement(ForecastResult, { data, audience: "brand", onAdd: () => undefined })));
    expect(t).toContain("Counted so far: shipping");
    expect(t).toMatch(/monthly charges not computed\./);
    expect(t).not.toMatch(/monthly charges \$0\.00/);
    // The monthly card says so as well, and the volume table does not print a zero for what is unknown.
    expect(t).toContain("None could be computed from what you gave.");
    const sensitivity = text(renderToStaticMarkup(createElement(ForecastResult, { data, audience: "brand" }))).split("Cost per order at other volumes")[1]!;
    expect(sensitivity).toContain("not computed");
    expect(sensitivity).not.toMatch(/Monthly charges spread[^]*?\$0\.00 \$/);
  });

  it("says 'not computed', never $0.00, when no order fee could be computed", () => {
    // Only the inserts fee, with no answer: no order fee is counted, and the card names it instead of printing "$0.00 a month".
    const onlyInserts = { ...standard, rules: standard.rules.filter((r) => r.key === "inserts") };
    const summary = summaryOf(assumptions({ fulfillment: NO_ANSWERS }), deps({ schedule: onlyInserts }));
    expect(summary.processing!.byRule).toEqual([]);
    const data = forecastResultData(summary, "brand");
    expect(data.headline.parts.orderFees).toBeNull();
    const t = text(renderToStaticMarkup(createElement(ForecastResult, { data, audience: "brand", onAdd: () => undefined })));
    expect(t).toMatch(/order fees not computed/);
    expect(t).toContain("None of the order fees could be computed from what you gave.");
    // (The tags are replaced by spaces in `text`, so the bold name and the colon after it read as "Marketing inserts :".)
    expect(t).toContain("Marketing inserts : not computed for 100.00% of orders, because a number it needs was not given.");
    expect(t).not.toContain("No order fee applied");
    expect(t).not.toMatch(/Order fees \$0\.00 a month/);
  });

  it("names the fees that could not be computed for part of the orders, beside the ones that were", () => {
    // Without the catch-all packaging fee, packaging "pouch" is on no packaging fee: those orders are not charged one, and the card says for how many.
    const noCatchAll = { ...standard, rules: standard.rules.filter((r) => r.key !== "pack_other") };
    const a = assumptions({ parcels: [{ weightLb: "1", lengthIn: "10", widthIn: "8", heightIn: "4", packagingType: "box", sharePct: "70" }, { weightLb: "0.5", packagingType: "pouch", sharePct: "30", unknownSize: true }] });
    const summary = summaryOf(a, deps({ schedule: noCatchAll }));
    const u = summary.processing!.unresolved.find((x) => x.reason === "packaging_unmatched");
    expect(u).toBeDefined();
    const t = text(renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(summary, "brand"), audience: "brand" })));
    expect(t).toContain("not counting the fees listed below");
    expect(t).toContain(`${u!.name} : not computed for ${u!.sharePct}% of orders, because no charge on the fee schedule covers this packaging.`);
  });

  it("links Add to the fulfillment section on a saved forecast", () => {
    const html = renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(missing, "brand"), audience: "brand", editHref: "/portal/model/forecast?from=abc" }));
    expect(html).toContain('href="/portal/model/forecast?from=abc#forecast-fulfillment"');
    expect(html).not.toContain("<button");
  });

  it("uses the brand's vocabulary for a brand and the plain classes for staff", () => {
    const brand = text(renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(full, "brand"), audience: "brand" })));
    const staff = text(renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(full, "staff"), audience: "staff" })));
    expect(brand).toContain("From your rate card");
    expect(brand).toContain("Based on assumptions");
    expect(brand).not.toContain("Definite");
    expect(staff).toContain("Definite");
    expect(staff).toContain("Estimated");
    expect(staff).not.toContain("From your rate card");
  });

  it("shows only the shipping figure, with the reason, when fulfillment costs were skipped", () => {
    const skipped = summaryOf(assumptions({ fulfillment: { skip: true, drivers: {}, orderShares: {} } }));
    const t = text(renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(skipped, "brand"), audience: "brand" })));
    expect(t).toContain("Estimated shipping cost per order");
    expect(t).toContain("Fulfillment costs were skipped, so this is shipping only.");
    expect(t).not.toContain("Account minimum");
    expect(t).not.toContain("Monthly charges");
    expect(t).not.toContain("All-in cost per order");
  });

  it("shows the not-priced table and no all-in when only what the rate card covers was priced", () => {
    const partial = summaryOf(assumptions({ zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] }), deps(), { priceOnlyCovered: true });
    const t = text(renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(partial, "brand"), audience: "brand" })));
    expect(t).toContain("Not priced");
    expect(t).toContain("Some of the orders you described cannot be priced from your rate card. Nothing is estimated for them.");
    expect(t).toContain("The rate card has no rate for this zone".replace("The", "the").replace(/^./, "T"));
    expect(t).toContain("no all-in figure or projection is shown");
    expect(t).not.toContain("All-in cost per order");
    expect(t).not.toContain("a year if every month looked like this");
  });

  it("curates the reasons in the blocked table: a brand never reads the engine's own message", () => {
    const rows = [{ serviceId: UPS, serviceName: "UPS Ground", zone: "9", reason: "no_rate_for_zone", message: "ENGINE-MESSAGE rate_card_rows had no row", weight: "250", sharePct: "20.00" }];
    const brand = text(renderToStaticMarkup(createElement(UnpriceableTable, { rows, sharePct: "20.00", audience: "brand" })));
    expect(brand).toContain("20.00% of the orders you described cannot be priced from your rate card. Nothing is estimated for them.");
    expect(brand).toContain("UPS Ground 9 20.00% The rate card has no rate for this zone");
    expect(brand).not.toContain("ENGINE-MESSAGE");
    expect(text(renderToStaticMarkup(createElement(UnpriceableTable, { rows, sharePct: "20.00", audience: "staff" })))).toContain("ENGINE-MESSAGE");
  });
});

describe("the form renders", () => {
  const props = { audience: "brand" as const, tenantName: "Fixture 3PL" };

  it("with labelled controls, the live total of every distribution and the pre-flight line", () => {
    const html = renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context() }));
    const t = text(html);
    for (const label of ["Orders a month", "Rates and fees as of", "Ship-from ZIP code", "Weight (lb)", "Share of orders (%)", "Length (in)", "Packaging", "Orders delivered to homes (%)", "Orders shipped as several packages (%)", "Packages in each of those orders", "Average items per order"]) {
      if (label === "Average items per order") continue;
      expect(t, label).toContain(label);
    }
    expect(t).toContain("I don't know the size");
    expect(t).toContain("Shares add up to 100.00%.");
    expect((html.match(/>Spread evenly</g) ?? []).length).toBe(4);
    expect(t).toContain("This forecast prices 1 parcel × 1 zone × 1 service × 2 residential splits × 1 package class = 2 cells.");
    expect(t).toContain("Preview forecast");
    expect(t).toContain("Skip fulfillment costs (shipping only)");
    expect(t).toContain("What is in a typical order");
    // One three-way answer per driver question.
    for (const q of driverQuestions(standard)) expect(t, q.label).toContain(q.label);
    expect((html.match(/Not sure, leave it out/g) ?? []).length).toBe(driverQuestions(standard).length);
    expect((html.match(/We don&#x27;t use this/g) ?? []).length).toBe(driverQuestions(standard).length);
    // Packaging: the schedule's types, "another type" for the catch-all, and the leave-it-out choice.
    expect(t).toContain("No packaging fee, or not sure (packaging fees left out)");
    expect(t).toContain("Another type (not listed)");
    expect(html).not.toContain(" disabled=\"\" aria-describedby");
  });

  it("blocks with a message when there is no ship-from ZIP code", () => {
    const t = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context({ originZip: "" }) })));
    expect(t).toContain("No ship-from ZIP code is set for your account. Enter the ZIP code the orders ship from to continue.");
  });

  it("starts from a saved forecast and says so, with the date starting from today", () => {
    const html = renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context(), initial: assumptions(), editedFrom: { name: "Spring plan", asOfDate: "2026-03-15" } }));
    const t = text(html);
    expect(t).toContain("Starting from Spring plan (priced on Mar 15, 2026). Saving creates a new forecast; the original stays as it is. The date starts from today.");
    expect(html).toContain('value="1250"');
    expect(t).toContain("Shares add up to 100.00%.");
  });

  it("for staff, with the customer's wording", () => {
    const t = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, audience: "staff", brandId: "b", context: context() })));
    expect(t).toContain("The customer's fee schedule Fictional Standard Fulfillment 2026 (in effect from Jan 1, 2026)");
  });

  it("without a fee schedule, and when it could not be loaded or is not in effect", () => {
    const none = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context({ schedule: { status: "none" } }) })));
    expect(none).toContain("Fixture 3PL has not set up a fee schedule for you, so this forecast covers shipping only.");
    expect(none).not.toContain("What is in a typical order");
    const unavailable = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context({ schedule: { status: "unavailable" } }) })));
    expect(unavailable).toContain("The fee schedule could not be loaded, so fulfillment costs cannot be forecast right now.");
    const notEffective = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context({ schedule: { status: "not_effective", name: "Old schedule" } }) })));
    expect(notEffective).toContain("The fee schedule Old schedule has no fees in effect on");
  });

  it("offers a rate card choice only when there are several, and shows the origin notes", () => {
    const one = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context() })));
    expect(one).not.toContain("Rate card");
    const several = text(renderToStaticMarkup(createElement(ForecastForm, { ...props, context: context({ cards: [{ id: "a", name: "Card A" }, { id: "b", name: "Card B" }], warnings: ["UPS Ground: ZIP code 90001 is not on the zone chart of this rate card."] }) })));
    expect(several).toContain("Rate card");
    expect(several).toContain("not on the zone chart of this rate card");
  });
});

describe("adversarial review: figures and wording that read wrong", () => {
  const partialZones = { zones: [{ zone: "2", sharePct: "80" }, { zone: "9", sharePct: "20" }] };
  const render = (summary: ForecastSummary, audience: "brand" | "staff" = "brand") => text(renderToStaticMarkup(createElement(ForecastResult, { data: forecastResultData(summary, audience), audience, onAdd: () => undefined })));

  it("gives each not-included order fee its own order count, not the largest in its category", () => {
    // No catch-all packaging fee: parcels with no packaging type leave the box and poly mailer fees uncomputed for 50% of orders,
    // and "pouch" (30%) is on no fee at all. All three are packaging fees; each must name its own share of the 1,250 orders.
    const noCatchAll = { ...standard, rules: standard.rules.filter((r) => r.key !== "pack_other") };
    const parcel = (packagingType: string | null, sharePct: string) => ({ weightLb: "0.5", packagingType, sharePct, unknownSize: true });
    const a = assumptions({ parcels: [parcel(null, "50"), parcel("pouch", "30"), parcel("box", "20")] });
    const summary = summaryOf(a, deps({ schedule: noCatchAll }));
    const items = resultModel.notIncludedItems(summary).filter((i) => i.category === "packaging");
    const pouch = items.find((i) => i.reason === "no charge on the fee schedule covers this packaging")!;
    expect(pouch.orders).toBe(375);
    const unknown = items.filter((i) => i.reason === "the packaging was not given");
    expect(unknown.length).toBeGreaterThan(0);
    for (const i of unknown) expect(i.orders).toBe(625);
    expect(items.every((i) => i.orders > 0)).toBe(true);
  });

  it("says a minimum that counts shipping counted fees and shipping, because the amount includes the shipping", () => {
    const withShipping = summaryOf(assumptions({ fulfillment: NO_ANSWERS }), deps({ schedule: schedules.minimum_with_shipping! }));
    expect(withShipping.minimums[0]!.includesShipping).toBe(true);
    const t = render(withShipping);
    expect(t).toContain("Fees and shipping counted toward the minimum: $20,431.71 · Minimum: $1,000.00 · Added: $0.00");
    expect(t).not.toContain("Fees counted toward the minimum");
    // A minimum that counts fees only still says fees.
    expect(render(summaryOf(assumptions()))).toContain("Fees counted toward the minimum: $4,710.25");
  });

  it("describes why a minimum is only an upper bound in this screen's words (not computed, never 'not modeled')", () => {
    const t = render(summaryOf(assumptions({ fulfillment: NO_ANSWERS })));
    expect(t).toContain("Pallet storage is not computed");
    expect(t).not.toContain("not modeled");
    const partial = render(summaryOf(assumptions(partialZones), deps(), { priceOnlyCovered: true }));
    expect(partial).toContain("only 80.00% of orders could be priced");
    expect(partial).not.toContain("shipping priced for");
  });

  it("does not put the priced share's monthly shipping on all the orders when only part of the volume was priced", () => {
    const partial = summaryOf(assumptions(partialZones), deps(), { priceOnlyCovered: true });
    expect(partial.pricedSharePct).toBe("80.00");
    const t = render(partial);
    expect(t).toContain(`${"$"}12,809.94 a month, $12.81 per order on average (over the 80.00% of orders that could be priced), from your rate card.`);
    // Shipping only (fulfillment skipped) shows the same figure in the headline: it names the share it covers.
    const skipped = summaryOf(assumptions({ ...partialZones, fulfillment: { skip: true, drivers: {}, orderShares: {} } }), deps(), { priceOnlyCovered: true });
    const s = render(skipped);
    expect(s).toContain("about $12,809.94 a month over the 80.00% of orders that could be priced");
    expect(s).not.toContain("a month at 1,250 orders a month");
    // With every order priced the figure is for all of them, and says so.
    const whole = render(summaryOf(assumptions({ fulfillment: { skip: true, drivers: {}, orderShares: {} } })));
    expect(whole).toContain("a month at 1,250 orders a month");
    expect(whole).not.toContain("of orders that could be priced)");
  });

  it("says what the volume table holds constant, so a volume price break is not mistaken for no discount", () => {
    const t = render(summaryOf(assumptions()));
    expect(t).toContain("Shipping and order fees per order are held the same");
    expect(t).toContain("Price breaks that depend on your monthly volume are not read again");
  });

  it("says the parts of the all-in can differ from it by a cent", () => {
    expect(render(summaryOf(assumptions()))).toContain("Each figure is rounded to cents once, so the parts can differ from the total by a cent.");
  });
});

describe("adversarial review: the form", () => {
  const ctx = context();
  const blocked = { status: "blocked" as const, cellCount: 4, unpriceable: [], unpriceableSharePct: "20.00" };
  const ok = { status: "ok" as const, result: {} as never };
  const invalid = { status: "invalid" as const, problems: ["monthlyOrders: must be between 1 and 5,000,000"] };

  it("keeps the blocked table on screen when only 'price only what the rate card covers' was ticked, so it can be seen and undone", () => {
    const o = (response: Parameters<typeof latestOutcome>[0] extends infer T ? (T extends { response: infer R } ? R : never) : never) => ({ key: "k1", response });
    // Ticking the choice changes the key (not fresh) but not the inputs: the table stays.
    expect(latestOutcome(o(blocked), false, true).kind).toBe("blocked");
    // Any other change makes a blocked or invalid outcome say nothing about the inputs now.
    expect(latestOutcome(o(blocked), false, false).kind).toBe("none");
    expect(latestOutcome(o(invalid), false, true).kind).toBe("none");
    // A stale result stays (dimmed); a fresh outcome of any kind is shown.
    expect(latestOutcome(o(ok), false, false).kind).toBe("ok");
    expect(latestOutcome(o(invalid), true, true).kind).toBe("invalid");
    expect(latestOutcome(null, true, true).kind).toBe("none");
  });

  it("says a problem found on saving that belongs to no field of the save card", () => {
    const found = model.fieldErrorsFromProblems(["asOfDate: your rate card has no rates in effect on Mar 15, 2026. Choose another date."]);
    expect(found.general).toEqual([]);
    expect(model.saveProblemMessage(found)).toBe("Your rate card has no rates in effect on Mar 15, 2026. Choose another date.");
    // The name's problem is on its field; nothing else to say.
    expect(model.saveProblemMessage(model.fieldErrorsFromProblems(["name: Give the forecast a name."]))).toBeNull();
    // A general sentence comes first.
    expect(model.saveProblemMessage({ fields: { monthlyOrders: "x" }, general: ["General."] })).toBe("General.");
  });

  it("opens on the date it was given, and no longer says the date starts from today", () => {
    const html = renderToStaticMarkup(createElement(ForecastForm, { audience: "brand", tenantName: "Fixture 3PL", context: context({ asOfDate: "2026-04-01" }), startDate: "2026-04-01", initial: assumptions(), editedFrom: { name: "Spring plan", asOfDate: "2026-03-15" } }));
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-04-01"');
    const t = text(html);
    expect(t).toContain("Saving creates a new forecast; the original stays as it is.");
    expect(t).not.toContain("The date starts from today");
    // Not a date: ignored.
    expect(renderToStaticMarkup(createElement(ForecastForm, { audience: "brand", tenantName: "Fixture 3PL", context: context(), startDate: "2026-02-30" }))).not.toContain('value="2026-02-30"');
  });
});
