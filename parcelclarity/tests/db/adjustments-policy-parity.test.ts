import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluateAdjustmentScenario, resolveHandling, scenarioStorageInput, scenarioStorageResult,
  type AdjustmentScenarioInput, type AdjustmentScenarioResult, type PolicyComponent, type PolicyRow, type PolicyType,
} from "@/engine/adjustments";
import type { PricingContext, ShipmentInput, SurchargeRule } from "@/engine/types";
import { buildContext, fixture, policyFnFromProfile, type PolicyProfile, type RulesFile } from "../unit/adjustments-engine-support";
import { asUser, buildFixture, saveScenario, setPolicy, withTx, type Fixture } from "./adjustments-fixture";
import { createBrand, createTenant, createUser, expectDenied, sql } from "./harness";
import { buildWorld, type World } from "./world";

/**
 * Design amendment A6: the TypeScript resolver (src/engine/adjustments/policy.ts) and the SQL function
 * app.adjustment_handling must give the same answer for every query of tests/fixtures/adjustments/policy-matrix.json.
 * The fixture was written by hand before either implementation existed: 28 resolution queries plus 7 exclusion-constraint
 * examples. The rows are inserted as the table owner with the write guard (app.adjustment_rpc) open, exactly what the
 * policy functions do, into a fresh tenant; the symbolic customers brandA, brandB and brandC become real customers of it.
 *
 * Second block: the JSON the engine would store for a saved scenario satisfies the database's own contract check,
 * app.scenario_result_problem, for every priced golden input (so the serializer and the SQL cannot drift apart).
 *
 * Third block: an engine result is saved with the engine's own documents (save_adjustment_scenario), previewed
 * (preview_customer_example) and published, and the amounts the SQL builder puts in the customer payload equal the
 * engine's, to the cent. The rate card of the database fixture is mirrored by hand into an engine context.
 */
interface MatrixPolicy extends PolicyRow {
  id: string;
}
interface Query {
  id: string;
  brandId: string | null;
  adjustmentType: string;
  component: string;
  on: string;
  expected: string;
  why: string;
}
interface Example {
  id: string;
  rows: MatrixPolicy[];
  overlap: boolean;
  note: string;
}
const matrix = fixture<{ policies: MatrixPolicy[]; queries: Query[]; constraintExamples: Example[] }>("policy-matrix.json");

const INSERT = "insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from, valid_to) values ($1, $2, $3, $4, $5, $6, $7)";

async function newTenant(label: string): Promise<{ tenant: string; brands: Record<string, string> }> {
  const owner = await createUser(`parity-${label}`);
  const tenant = await createTenant(owner, `Parity ${label}`);
  const brands = { brandA: await createBrand(owner, tenant, "Customer A"), brandB: await createBrand(owner, tenant, "Customer B"), brandC: await createBrand(owner, tenant, "Customer C") };
  return { tenant, brands };
}

describe("app.adjustment_handling and resolveHandling agree on the shared policy matrix", () => {
  it("answers every one of the 28 queries as the fixture says, in SQL and in TypeScript", async () => {
    expect(matrix.queries).toHaveLength(28);
    const { tenant, brands } = await newTenant("matrix");
    const sqlAnswers = await withTx(
      null,
      async (q) => {
        await q("select set_config('app.adjustment_rpc', 'on', true)");
        for (const p of matrix.policies) await q(INSERT, [tenant, p.brandId ? brands[p.brandId] : null, p.adjustmentType, p.component, p.handling, p.validFrom, p.validTo]);
        const out: Record<string, string> = {};
        for (const query of matrix.queries) {
          const { rows } = await q("select app.adjustment_handling($1, $2, $3, $4, $5::date) as h", [tenant, query.brandId ? brands[query.brandId] : null, query.adjustmentType, query.component, query.on]);
          out[query.id] = rows[0]!.h as string;
        }
        return out;
      },
      { commit: false },
    );
    for (const query of matrix.queries) {
      const ts = resolveHandling(matrix.policies, query.brandId, query.adjustmentType, query.component, query.on);
      expect(sqlAnswers[query.id], `SQL ${query.id}: ${query.why}`).toBe(query.expected);
      expect(ts, `TypeScript ${query.id}: ${query.why}`).toBe(query.expected);
      expect(ts, `parity ${query.id}`).toBe(sqlAnswers[query.id]);
    }
  });

  it("the stored rows are what the TypeScript resolver was given (dates inclusive, null brand is the account default)", async () => {
    const { tenant, brands } = await newTenant("rows");
    await withTx(
      null,
      async (q) => {
        await q("select set_config('app.adjustment_rpc', 'on', true)");
        for (const p of matrix.policies) await q(INSERT, [tenant, p.brandId ? brands[p.brandId] : null, p.adjustmentType, p.component, p.handling, p.validFrom, p.validTo]);
        const { rows } = await q("select brand_id, adjustment_type, component, handling, valid_from::text as valid_from, valid_to::text as valid_to from public.adjustment_policies where tenant_id = $1", [tenant]);
        expect(rows).toHaveLength(matrix.policies.length);
        const symbol = Object.fromEntries(Object.entries(brands).map(([k, v]) => [v, k]));
        const back: PolicyRow[] = rows.map((r) => ({ brandId: r.brand_id ? symbol[r.brand_id as string]! : null, adjustmentType: r.adjustment_type as string, component: r.component as string, handling: r.handling as string, validFrom: r.valid_from as string, validTo: (r.valid_to as string | null) ?? null }));
        for (const query of matrix.queries) expect(resolveHandling(back, query.brandId, query.adjustmentType, query.component, query.on), query.id).toBe(query.expected);
      },
      { commit: false },
    );
  });

  it("the seven exclusion examples: an overlapping second row is refused by the constraint (23P01), a disjoint one is accepted", async () => {
    expect(matrix.constraintExamples).toHaveLength(7);
    for (const ex of matrix.constraintExamples) {
      const { tenant, brands } = await newTenant(`excl-${ex.id.slice(0, 20)}`);
      const insert = (p: MatrixPolicy) =>
        withTx(null, async (q) => {
          await q("select set_config('app.adjustment_rpc', 'on', true)");
          await q(INSERT, [tenant, p.brandId ? brands[p.brandId] : null, p.adjustmentType, p.component, p.handling, p.validFrom, p.validTo]);
        });
      await insert(ex.rows[0]!);
      if (ex.overlap) {
        let code = "none";
        try {
          await insert(ex.rows[1]!);
        } catch (err) {
          code = (err as { code?: string }).code ?? "no code";
        }
        expect(code, `${ex.id}: ${ex.note}`).toBe("23P01");
      } else {
        await insert(ex.rows[1]!);
        const [{ n }] = (await sql<{ n: string }>("select count(*)::text as n from public.adjustment_policies where tenant_id = $1", [tenant])) as [{ n: string }];
        expect(n, `${ex.id}: ${ex.note}`).toBe("2");
      }
    }
  });

  it("without the write guard open the rows cannot be changed even by the owner: the matrix is only loadable the way the functions load it", async () => {
    const { tenant, brands } = await newTenant("guard");
    const p = matrix.policies[0]!;
    await withTx(null, async (q) => {
      await q("select set_config('app.adjustment_rpc', 'on', true)");
      await q(INSERT, [tenant, p.brandId ? brands[p.brandId] : null, p.adjustmentType, p.component, p.handling, p.validFrom, p.validTo]);
    });
    await expectDenied(sql("update public.adjustment_policies set handling = 'absorbed' where tenant_id = $1", [tenant]), /only through its functions/);
  });
});

describe("engine storage documents against the database contract (app.scenario_result_problem)", () => {
  const rules = fixture<RulesFile>("rules.json");
  const { scenarios, policyProfiles } = fixture<{ scenarios: { id: string; context: string; policy: string; input: AdjustmentScenarioInput }[]; policyProfiles: Record<string, PolicyProfile> }>("scenarios.json");

  it("accepts the stored result of every priced golden scenario and has no complaint to make", async () => {
    let checked = 0;
    for (const s of scenarios) {
      const result = evaluateAdjustmentScenario(s.input, buildContext(rules.contexts[s.context]!, rules.rules), policyFnFromProfile(policyProfiles[s.policy]));
      const doc = scenarioStorageResult(result);
      if (result.status !== "ok" && result.status !== "no_adjustment") {
        expect(doc.ok, s.id).toBe(false);
        continue;
      }
      if (!doc.ok) throw new Error(`${s.id}: ${doc.reason}`);
      const [row] = await sql<{ problem: string | null }>("select app.scenario_result_problem($1::jsonb) as problem", [JSON.stringify(doc.value)]);
      expect(row!.problem, s.id).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("the database refuses what the engine never produces: an unpriced status, a negative amount, a bad state", async () => {
    const problem = async (doc: unknown) => (await sql<{ problem: string | null }>("select app.scenario_result_problem($1::jsonb) as problem", [JSON.stringify(doc)]))[0]!.problem;
    const good = { status: "ok", direction: "increase", basis: "exact", components: [{ kind: "postage_difference", state: "conditional", amount: "0.56", declaredTotal: "12.79", correctedTotal: "13.35" }] };
    expect(await problem(good)).toBeNull();
    expect(await problem({ ...good, status: "corrected_unavailable", direction: null })).toBe("direction");
    expect(await problem({ ...good, components: [{ ...good.components[0], amount: "-1.70" }] })).toBe("component_amount");
    expect(await problem({ ...good, components: [{ ...good.components[0], state: "computed" }] })).toBe("component_state");
  });
});

// ---------------------------------------------------------------------------
// Engine documents through the real save, preview and publish functions
// ---------------------------------------------------------------------------
describe("an engine result survives save_adjustment_scenario, preview and publish with the same amounts", () => {
  let w: World;
  let f: Fixture;
  let ctx: PricingContext;

  /** The fixture card of tests/db/adjustments-fixture.ts (UPS Ground zone 5: up to 5 lb 9.60, over 5 up to 20 lb 14.50, DIM 139) as an engine context. */
  const engineContext = (): PricingContext => {
    const reweigh: SurchargeRule = {
      key: "adjtest.reweigh_fee", ruleId: f.rules.reweigh.ruleId, versionId: f.rules.reweigh.versionId, version: 1, scope: "tenant", brandId: null, carrierCode: "ups", serviceCodes: null,
      category: "reweight", name: "Reweigh fee", chargeClass: "conditional", method: "flat", amount: "3.00", percent: null, perUnit: null, billableWeightFloorLb: null, base: { kind: "base_rate" },
      conditions: [], exclusivityGroup: null, exclusivityPriority: 0, excludesRuleKeys: [], perPackage: false, effectiveDate: "2026-01-01", expirationDate: null, sourceReference: "fixture", sourceUrl: null, verificationStatus: "approved_3pl_config",
    };
    return {
      rateCard: {
        rateCardId: f.cardId, rateCardName: "Adjustment card", versionId: f.v1, versionNumber: 1, currency: "USD", effectiveDate: "2026-01-01", expirationDate: null,
        services: [{
          serviceId: f.upsGround, carrierCode: "ups", serviceCode: "ground", serviceName: "UPS Ground", minCharge: null, includedSurchargeKeys: [], excludedSurchargeKeys: [], zoneChartKey: "default", zoneIndependent: false,
          surchargeMarkupPercent: null, sourceReference: "fixture", termsVersion: "fixture-terms",
          dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: false },
        }],
        rows: [
          { serviceId: f.upsGround, originPrefix: null, zone: "5", weightMin: "0", weightMax: "5", weightUnit: "lb", price: "9.60", minCharge: null },
          { serviceId: f.upsGround, originPrefix: null, zone: "5", weightMin: "5", weightMax: "20", weightUnit: "lb", price: "14.50", minCharge: null },
        ],
        zones: [{ carrierCode: "ups", originPrefix: "900", destPrefixFrom: "800", destPrefixTo: "899", zone: "5", zoneChartKey: "default" }],
      },
      rules: [reweigh],
      zipLists: [],
      overrides: [],
    };
  };

  const shipment = (weight: string, withDims = true): ShipmentInput => ({
    shipDate: f.today, originZip: "90001", destinationZip: "85001", residential: false, carrierCode: "ups", serviceCode: "ground",
    packages: [{ weight, weightUnit: "lb", ...(withDims ? { length: "10", width: "8", height: "6" } : {}) }],
  });

  /** The policy function reads the database's own resolution, so the engine and the saved snapshot cannot disagree. */
  const dbPolicy = async (tenant: string, brand: string) => {
    const table: Record<string, string> = {};
    for (const type of ["reweight", "remeasure", "combined", "correction"]) {
      for (const component of ["postage_difference", "separate_fee"]) {
        const [row] = await sql<{ h: string }>("select app.adjustment_handling($1, $2, $3, $4, current_date) as h", [tenant, brand, type, component]);
        table[`${type}/${component}`] = row!.h;
      }
    }
    return (type: PolicyType, component: PolicyComponent) => table[`${type}/${component}`] as ReturnType<ReturnType<typeof policyFnFromProfile>>;
  };

  const save = async (input: AdjustmentScenarioInput, result: AdjustmentScenarioResult) => {
    const doc = scenarioStorageResult(result);
    const stored = scenarioStorageInput(input, result);
    if (!doc.ok || !stored.ok) throw new Error(`not storable: ${!doc.ok ? doc.reason : ""}`);
    return saveScenario(f, { input: stored.value as unknown as Record<string, unknown>, result: doc.value as unknown as Record<string, unknown>, type: doc.value.adjustmentType });
  };
  const preview = async (source: string) => (await asUser<{ r: Record<string, unknown> }>(w.t1.admin.id, "select public.preview_customer_example($1, $2) as r", [source, w.brandA.id]))[0]!.r;

  beforeAll(async () => {
    w = await buildWorld();
    f = await buildFixture(w);
    ctx = engineContext();
    await setPolicy(w.t1.admin.id, w.t1.id, null, "reweight", "postage_difference", "pass_through");
    await setPolicy(w.t1.admin.id, w.t1.id, null, "reweight", "separate_fee", "pass_through");
  });

  it("a 5 lb to 12 lb example: the database builds the customer payload with the engine's amounts to the cent", async () => {
    const policy = await dbPolicy(w.t1.id, w.brandA.id);
    const input: AdjustmentScenarioInput = { shipment: shipment("5"), corrections: [{ weight: "12", weightUnit: "lb" }], declaredSource: "entered" };
    const result = evaluateAdjustmentScenario(input, ctx, policy);
    expect(result).toMatchObject({ status: "ok", adjustmentType: "reweight", direction: "increase", basis: "exact" });
    const pd = result.components!.postage_difference;
    const fee = result.components!.separate_fee;
    expect([pd.declaredTotal, pd.correctedTotal, pd.amount, fee.amount]).toEqual(["9.60", "14.50", "4.90", "3.00"]); // by hand: 14.50 - 9.60, and the 3.00 rule

    const source = await save(input, result);
    const p = await preview(source);
    expect(p.ok, JSON.stringify(p.problems)).toBe(true);
    const payload = p.payload as { components: { kind: string; handling: string; amount: string; declaredTotal?: string; correctedTotal?: string }[]; input: { declared: { packages: { weightLb: string }[] }; corrected: { packages: { weightLb: string }[] }; zone: number } };
    expect(payload.components).toEqual([
      { kind: "postage_difference", handling: "pass_through", amount: pd.amount, declaredTotal: pd.declaredTotal, correctedTotal: pd.correctedTotal },
      { kind: "separate_fee", handling: "pass_through", amount: fee.amount },
    ]);
    expect(payload.input.declared.packages[0]!.weightLb).toBe("5.0");
    expect(payload.input.corrected.packages[0]!.weightLb).toBe("12.0");
    expect(payload.input.zone).toBe(5);
    // Nothing staff-only crossed: the engine's buckets, notes and notices are not in the payload.
    expect(JSON.stringify(payload)).not.toMatch(/totalsE4|notBilled|customerPays|engineHandling|notices|engineVersion|corrections/);

    const published = await asUser<{ id: string }>(w.t1.admin.id, "select public.publish_customer_example($1, $2, 'If a 5 lb package is corrected to 12 lb', null, null, null) as id", [source, w.brandA.id]);
    expect(published[0]!.id).toBeTruthy();
    const seen = await asUser<{ r: { state: string; payload: unknown }[] }>(w.brandA.admin.id, "select public.brand_adjustment_examples($1) as r", [w.brandA.id]);
    const mine = seen[0]!.r.find((e) => JSON.stringify(e.payload) === JSON.stringify(payload));
    expect(mine?.state).toBe("current");
  });

  it("a credit is stored but cannot be previewed as shareable (not an increase), and an estimate cannot either", async () => {
    const policy = await dbPolicy(w.t1.id, w.brandA.id);
    const credit: AdjustmentScenarioInput = { shipment: shipment("12"), corrections: [{ weight: "5", weightUnit: "lb" }], declaredSource: "entered" };
    const cr = evaluateAdjustmentScenario(credit, ctx, policy);
    expect(cr.direction).toBe("decrease");
    expect(cr.components!.postage_difference).toMatchObject({ state: "credit", amount: "-4.90", creditAmount: "4.90" });
    const creditPreview = await preview(await save(credit, cr));
    expect(creditPreview.ok).toBe(false);
    expect((creditPreview.problems as { code: string }[]).map((x) => x.code)).toContain("not_an_increase");

    const estimate: AdjustmentScenarioInput = { shipment: shipment("5", false), corrections: [{ weight: "12", weightUnit: "lb" }], declaredSource: "entered" };
    const es = evaluateAdjustmentScenario(estimate, ctx, policy);
    expect(es.basis).toBe("estimate");
    const estimatePreview = await preview(await save(estimate, es));
    expect(estimatePreview.ok).toBe(false);
    expect((estimatePreview.problems as { code: string }[]).map((x) => x.code)).toContain("estimate_basis");
  });

  it("a component the policy absorbs is stored with its handling and never reaches the customer payload", async () => {
    await setPolicy(w.t1.admin.id, w.t1.id, w.brandA.id, "reweight", "separate_fee", "absorbed");
    const policy = await dbPolicy(w.t1.id, w.brandA.id);
    const input: AdjustmentScenarioInput = { shipment: shipment("5"), corrections: [{ weight: "12", weightUnit: "lb" }], declaredSource: "entered" };
    const result = evaluateAdjustmentScenario(input, ctx, policy);
    expect(result.components!.separate_fee.handling).toBe("absorbed");
    expect(result.totalsE4).toMatchObject({ customerPays: 49000, notBilledToCustomer: 30000 });
    const p = await preview(await save(input, result));
    expect(p.ok, JSON.stringify(p.problems)).toBe(true);
    expect((p.payload as { components: { kind: string }[] }).components.map((c) => c.kind)).toEqual(["postage_difference"]);
    expect(p.hidden).toEqual([{ kind: "separate_fee", reason: "absorbed" }]);
    expect(JSON.stringify(p.payload)).not.toContain("3.00");
  });
});
