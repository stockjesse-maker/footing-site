import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asOwnerWithGuardOpen, asOwnerWithoutTriggers, asUser, brandExamples, buildFixture, exampleState, expectCode, expectDenied, liveCopies, publish, publishRule, refusalHint, saveScenario, saveScenarioRaw,
  scenarioInput, scenarioResult, setPolicy, sha256Hex, sql, SENTINEL_PATTERN, SENTINELS, withTx, createBrand, createTenant, createUser, join, type Fixture,
} from "./adjustments-fixture";
import { POLICY_MATRIX, POLICY_MATRIX_CASES } from "./policy-matrix";
import { buildWorld, type World } from "./world";

/**
 * Milestone 5 (adjustment risk): policies, the closed allow-list guard, the SQL-built customer example, read-time staleness,
 * the D8 pricing filter, audit, offboarding and the step-0 fixes. Imports live in adjustments-imports.test.ts and the
 * confidentiality sweeps in adjustments-confidentiality.test.ts. Every expected value below was derived by hand from the
 * fixtures: rates are fictional, "5 lb to 12 lb" is an invented package, and no figure is read from the SQL it checks.
 */
let w: World;
let f: Fixture;

beforeAll(async () => {
  w = await buildWorld();
  f = await buildFixture(w);
});

const admin = () => w.t1.admin.id;

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
describe("adjustment policies (who pays)", () => {
  it("only administrators of the tenant set a decision; every refusal is the same class", async () => {
    const id = await setPolicy(admin(), w.t1.id, null, "reweight", "postage_difference", "pass_through");
    const [row] = await sql<Record<string, unknown>>("select tenant_id, brand_id, adjustment_type, component, handling, valid_from::text, valid_to, created_by from public.adjustment_policies where id = $1", [id]);
    expect(row).toEqual({ tenant_id: w.t1.id, brand_id: null, adjustment_type: "reweight", component: "postage_difference", handling: "pass_through", valid_from: f.today, valid_to: null, created_by: admin() });
    for (const user of [w.t1.employee, w.brandA.admin, w.brandB.admin, w.t2.admin, w.outsider, w.platformAdmin]) {
      await expectCode(setPolicy(user.id, w.t1.id, null, "reweight", "postage_difference", "absorbed"), "42501", /not allowed/);
    }
    await expectCode(asUser(null, "select public.set_adjustment_policy($1, null, 'reweight', 'postage_difference', 'absorbed')", [w.t1.id]), "42501", /permission denied/);
    // The brand must belong to the tenant: a foreign customer is "not found", the same as a missing one.
    await expectCode(setPolicy(admin(), w.t1.id, w.brandC.id, "reweight", "postage_difference", "absorbed"), "P0002", /not found/);
    await expectCode(setPolicy(admin(), w.t1.id, "00000000-0000-4000-8000-000000000000", "reweight", "postage_difference", "absorbed"), "P0002", /not found/);
  });

  it("rejects bad input: unknown values, a correction fee on postage, a date in the past, an over-long note", async () => {
    const bad: [string, string, string, string | null, string | null][] = [
      ["recount", "separate_fee", "absorbed", null, null],
      ["reweight", "surcharge", "absorbed", null, null],
      ["reweight", "separate_fee", "free", null, null],
      ["correction", "postage_difference", "absorbed", null, null],
      ["reweight", "separate_fee", "absorbed", "2020-01-01", null],
      ["reweight", "separate_fee", "absorbed", null, "x".repeat(1001)],
    ];
    for (const [type, component, handling, from, note] of bad) {
      await expectCode(setPolicy(admin(), w.t1.id, null, type, component, handling, from, note), "PC001");
    }
  });

  it("setting the same decision again changes nothing; changing it on the same day edits the row in place", async () => {
    const first = await setPolicy(admin(), w.t1.id, null, "reweight", "separate_fee", "manual_approval");
    expect(await setPolicy(admin(), w.t1.id, null, "reweight", "separate_fee", "manual_approval")).toBe(first);
    expect(await sql("select 1 from public.adjustment_policies where tenant_id = $1 and adjustment_type = 'reweight' and component = 'separate_fee' and brand_id is null", [w.t1.id])).toHaveLength(1);
    expect(await setPolicy(admin(), w.t1.id, null, "reweight", "separate_fee", "absorbed", null, "Private: we eat this one")).toBe(first);
    const [row] = await sql<{ handling: string; internal_note: string }>("select handling, internal_note from public.adjustment_policies where id = $1", [first]);
    expect(row).toEqual({ handling: "absorbed", internal_note: "Private: we eat this one" });
    // Put it back to manual approval for the publish tests below.
    await setPolicy(admin(), w.t1.id, null, "reweight", "separate_fee", "manual_approval", null, null);
  });

  it("a later decision closes the earlier one the day before; overlapping future rows are refused (P0007)", async () => {
    const tomorrow = (await sql<{ d: string }>("select (current_date + 10)::text as d"))[0]!.d;
    const dayBefore = (await sql<{ d: string }>("select (current_date + 9)::text as d"))[0]!.d;
    const first = await setPolicy(admin(), w.t1.id, w.brandB.id, "remeasure", "postage_difference", "pass_through");
    const second = await setPolicy(admin(), w.t1.id, w.brandB.id, "remeasure", "postage_difference", "absorbed", tomorrow);
    expect(second).not.toBe(first);
    expect(await sql("select valid_to::text as valid_to from public.adjustment_policies where id = $1", [first])).toEqual([{ valid_to: dayBefore }]);
    expect(await sql("select valid_from::text as valid_from, valid_to from public.adjustment_policies where id = $1", [second])).toEqual([{ valid_from: tomorrow, valid_to: null }]);
    // A decision dated before the future row would overlap it.
    const later = (await sql<{ d: string }>("select (current_date + 20)::text as d"))[0]!.d;
    await setPolicy(admin(), w.t1.id, w.brandB.id, "remeasure", "postage_difference", "manual_approval", later);
    await expectCode(setPolicy(admin(), w.t1.id, w.brandB.id, "remeasure", "postage_difference", "pass_through", dayBefore), "P0007", /overlaps/);
  });

  it("the overlap exclusion also holds for the account default (brand null), which a plain brand_id column would miss", async () => {
    await expectCode(
      sql("insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from) values ($1, null, 'reweight', 'postage_difference', 'absorbed', current_date)", [w.t1.id]),
      "23P01", /adjustment_policies_no_overlap/,
    );
    await expectCode(
      sql("insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from) values ($1, null, 'correction', 'postage_difference', 'absorbed', current_date)", [w.t1.id]),
      "23514", /adjustment_policies_valid_pair/,
    );
    await expectCode(
      sql("insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from, valid_to) values ($1, null, 'combined', 'separate_fee', 'absorbed', '2026-05-02', '2026-05-01')", [w.t1.id]),
      "23514", /adjustment_policies_dates/,
    );
  });

  it("ending a decision: row-scoped, idempotent, never extends; unknown and foreign ids look alike", async () => {
    const id = await setPolicy(admin(), w.t1.id, w.brandB.id, "combined", "postage_difference", "pass_through");
    await expectCode(asUser(w.t1.employee.id, "select public.end_adjustment_policy($1)", [id]), "P0002", /not found/);
    await expectCode(asUser(w.t2.admin.id, "select public.end_adjustment_policy($1)", [id]), "P0002", /not found/);
    await expectCode(asUser(admin(), "select public.end_adjustment_policy($1)", ["00000000-0000-4000-8000-000000000000"]), "P0002", /not found/);
    await expectCode(asUser(admin(), "select public.end_adjustment_policy($1, '2020-01-01')", [id]), "PC001", /precedes/);
    await asUser(admin(), "select public.end_adjustment_policy($1)", [id]);
    // Started today, so the last day is today (it still applies for the rest of the day); ending again is a no-op.
    expect(await sql("select valid_to::text as valid_to from public.adjustment_policies where id = $1", [id])).toEqual([{ valid_to: f.today }]);
    await asUser(admin(), "select public.end_adjustment_policy($1)", [id]);
    const [{ n }] = (await sql<{ n: string }>("select count(*)::text as n from public.audit_events where action = 'adjustment.policy_ended' and entity_id = $1", [id])) as [{ n: string }];
    expect(n).toBe("1");
  });

  it("resolves the shared policy matrix exactly as written (the TypeScript resolver runs the same rows)", async () => {
    const owner = await createUser("matrix-owner");
    const tenant = await createTenant(owner, "Matrix Freight");
    const x = await createBrand(owner, tenant, "Customer X");
    const y = await createBrand(owner, tenant, "Customer Y");
    const ids = { X: x, Y: y };
    for (const p of POLICY_MATRIX) {
      await sql(
        "insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from, valid_to) values ($1, $2, $3, $4, $5, $6, $7)",
        [tenant, p.brand ? ids[p.brand] : null, p.type, p.component, p.handling, p.validFrom, p.validTo],
      );
    }
    for (const c of POLICY_MATRIX_CASES) {
      const [r] = await sql<{ h: string }>("select app.adjustment_handling($1, $2, $3, $4, $5::date) as h", [tenant, c.brand ? ids[c.brand] : null, c.type, c.component, c.on]);
      expect(r!.h, `${c.brand ?? "default"} ${c.type}/${c.component} on ${c.on}: ${c.why}`).toBe(c.expected);
    }
  });

  it("policy rows are written only through the functions: direct changes fail for users and for the owner", async () => {
    const [p] = await sql<{ id: string }>("select id from public.adjustment_policies where tenant_id = $1 and brand_id is null limit 1", [w.t1.id]);
    await expectDenied(asUser(admin(), "update public.adjustment_policies set handling = 'absorbed' where id = $1", [p!.id]), /permission denied/);
    await expectDenied(asUser(admin(), "insert into public.adjustment_policies (tenant_id, adjustment_type, component, handling, valid_from) values ($1, 'remeasure', 'separate_fee', 'absorbed', current_date)", [w.t1.id]), /permission denied/);
    await expectDenied(asUser(admin(), "delete from public.adjustment_policies where id = $1", [p!.id]), /permission denied/);
    await expectCode(sql("update public.adjustment_policies set handling = 'absorbed' where id = $1", [p!.id]), "42501", /only through its functions/);
    await expectCode(sql("delete from public.adjustment_policies where id = $1", [p!.id]), "42501", /only through its functions/);
    // Even with the guard open, a row keeps its identity.
    await expectCode(asOwnerWithGuardOpen("update public.adjustment_policies set component = 'separate_fee' where id = $1", [p!.id]), "42501", /keeps its identity/);
  });
});

// ---------------------------------------------------------------------------
// The closed allow-list guard
// ---------------------------------------------------------------------------
describe("customer_json_ok: the closed allow-list", () => {
  const goodPackage = { weightLb: "5", lengthIn: "10", widthIn: "8", heightIn: "6" };
  const good = () => ({
    v: 1, adjustmentType: "reweight", pricedOn: "2026-10-16",
    input: { service: { carrier: "UPS", service: "UPS Ground" }, direction: "increase", residential: true, zone: 5, declared: { packages: [goodPackage] }, corrected: { packages: [{ ...goodPackage, weightLb: "12" }] } },
    components: [{ kind: "postage_difference", handling: "pass_through", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13" }, { kind: "separate_fee", handling: "manual_approval", amount: "2.00" }],
  });
  const ok = async (doc: unknown): Promise<boolean> => (await sql<{ ok: boolean }>("select app.customer_json_ok($1::jsonb, app.shape_published_payload()) as ok", [JSON.stringify(doc)]))[0]!.ok;
  const clone = () => structuredClone(good()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("accepts exactly the frozen payload", async () => {
    expect(await ok(good())).toBe(true);
    const noZone = clone(); noZone.input.zone = null; noZone.input.declared.packages = [{ weightLb: "0.5" }]; noZone.components = [noZone.components[1]];
    expect(await ok(noZone)).toBe(true);
  });

  it("refuses 30 hostile payloads, and never answers NULL", async () => {
    const mutate = (fn: (d: Record<string, any>) => void) => { const d = clone(); fn(d); return d; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const hostile: [string, unknown][] = [
      ["extra top-level key", mutate((d) => { d.absorbed = "1.00"; })],
      ["extra key in a component", mutate((d) => { d.components[0].incidencePct = "2.1"; })],
      ["extra key at depth 5 (in a package)", mutate((d) => { d.input.declared.packages[0].note = "x"; })],
      ["case variant of a key", mutate((d) => { d.Components = d.components; delete d.components; })],
      ["case variant of a required key", mutate((d) => { d.AdjustmentType = d.adjustmentType; delete d.adjustmentType; })],
      ["look-alike (Cyrillic a) key", mutate((d) => { d.components[0]["аmount"] = d.components[0].amount; delete d.components[0].amount; })],
      ["amount as a JSON number", mutate((d) => { d.components[0].amount = 5.3; })],
      ["amount with one decimal", mutate((d) => { d.components[0].amount = "5.3"; })],
      ["negative amount", mutate((d) => { d.components[0].amount = "-5.30"; })],
      ["amount with 8 integer digits", mutate((d) => { d.components[0].amount = "12345678.00"; })],
      ["amount padded with a space", mutate((d) => { d.components[0].amount = " 5.30"; })],
      ["amount null", mutate((d) => { d.components[0].amount = null; })],
      ["handling absorbed", mutate((d) => { d.components[0].handling = "absorbed"; })],
      ["handling unconfigured", mutate((d) => { d.components[0].handling = "unconfigured"; })],
      ["handling in the wrong case", mutate((d) => { d.components[0].handling = "Pass_through"; })],
      ["unknown component kind", mutate((d) => { d.components[0].kind = "incidence"; })],
      ["direction decrease", mutate((d) => { d.input.direction = "decrease"; })],
      ["adjustment type correction", mutate((d) => { d.adjustmentType = "correction"; })],
      ["seven components", mutate((d) => { d.components = Array.from({ length: 7 }, () => d.components[0]); })],
      ["no components", mutate((d) => { d.components = []; })],
      ["components not an array", mutate((d) => { d.components = {}; })],
      ["25 keys in one object", mutate((d) => { for (let i = 0; i < 25; i++) d[`k${i}`] = "x"; })],
      ["depth 9 nesting", mutate((d) => { let o: Record<string, any> = d; for (let i = 0; i < 10; i++) { o.input = { ...(o.input ?? {}) }; o = o.input; } })], // eslint-disable-line @typescript-eslint/no-explicit-any
      ["100 KB service name", mutate((d) => { d.input.service.service = "x".repeat(100_000); })],
      ["angle brackets in a name", mutate((d) => { d.input.service.service = "<script>alert(1)</script>"; })],
      ["control character in a name", mutate((d) => { d.input.service.carrier = "UPS\u0007"; })],
      ["bidi override in a name", mutate((d) => { d.input.service.carrier = "UPS‮evil"; })],
      ["zone as a string", mutate((d) => { d.input.zone = "5"; })],
      ["residential as a string", mutate((d) => { d.input.residential = "true"; })],
      ["impossible date", mutate((d) => { d.pricedOn = "2026-02-30"; })],
      ["date in another format", mutate((d) => { d.pricedOn = "10/16/2026"; })],
      ["weight in scientific notation", mutate((d) => { d.input.corrected.packages[0].weightLb = "1e3"; })],
      ["21 packages", mutate((d) => { d.input.declared.packages = Array.from({ length: 21 }, () => goodPackage); })],
      ["packages as an object", mutate((d) => { d.input.declared.packages = goodPackage; })],
      ["missing required key", mutate((d) => { delete d.input.residential; })],
      ["version 2", mutate((d) => { d.v = 2; })],
      ["a bare string", "absorbed 91317.29"],
      ["an array", [good()]],
    ];
    expect(hostile.length).toBeGreaterThanOrEqual(30);
    for (const [name, doc] of hostile) expect(await ok(doc), name).toBe(false);
    expect((await sql<{ ok: boolean }>("select app.customer_json_ok(null, app.shape_published_payload()) as ok"))[0]!.ok).toBe(false);
    expect((await sql<{ ok: boolean }>("select app.customer_json_ok('null'::jsonb, app.shape_published_payload()) as ok"))[0]!.ok).toBe(false);
    expect((await sql<{ ok: boolean }>("select app.customer_json_ok('{}'::jsonb, null) as ok"))[0]!.ok).toBe(false);
  });

  it("is also a CHECK on the table, so the owner cannot store a payload that fails it", async () => {
    const scenario = await saveScenario(f, { name: "Guard check" });
    const bad = clone(); bad.components[0].handling = "absorbed";
    await expectCode(
      sql(`insert into public.published_adjustment_examples (tenant_id, brand_id, source_scenario_id, title, payload, payload_sha256, priced_on, rates_effective_from, valid_through)
           values ($1, $2, $3, 'x', $4::jsonb, decode($5, 'hex'), current_date, current_date, current_date)`, [w.t1.id, w.brandA.id, scenario, JSON.stringify(bad), "00".repeat(32)]),
      "23514", /published_examples_payload_guard/,
    );
    for (const title of ["", "  ", "<b>x</b>", "x".repeat(121), "a\u0007b"]) {
      await expectCode(
        sql(`insert into public.published_adjustment_examples (tenant_id, brand_id, source_scenario_id, title, payload, payload_sha256, priced_on, rates_effective_from, valid_through)
             values ($1, $2, $3, $4, $5::jsonb, decode($6, 'hex'), current_date, current_date, current_date)`, [w.t1.id, w.brandA.id, scenario, title, JSON.stringify(good()), "00".repeat(32)]),
        "23514", /title/,
      );
    }
  });

  it("the shapes declare no key that names a confidential concept (a tripwire, not the control)", async () => {
    const [{ s }] = (await sql<{ s: unknown }>("select jsonb_build_array(app.shape_published_payload(), app.shape_brand_example()) as s")) as [{ s: unknown }];
    const keys = new Set<string>();
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const n = node as Record<string, unknown>;
      if (n.keys && typeof n.keys === "object") for (const [k, v] of Object.entries(n.keys as Record<string, unknown>)) { keys.add(k); walk(v); }
      if (n.items) walk(n.items);
      for (const [k, v] of Object.entries(n)) if (k !== "keys" && k !== "items") walk(v);
    };
    walk(s);
    expect([...keys].sort()).toEqual([
      "adjustmentType", "amount", "carrier", "components", "corrected", "correctedTotal", "declared", "declaredTotal", "direction", "handling", "heightIn", "id", "input", "kind", "lengthIn", "note", "packages",
      "payload", "publishedAt", "pricedOn", "ratesEffectiveFrom", "residential", "service", "state", "title", "v", "validThrough", "weightLb", "widthIn", "zone",
    ].sort());
    const denylist = /absorb|incid|loss|cost|margin|internal|policy|source|rule|exposure|forecast|scenario|wholesale|invoice|buy|rate_/i;
    for (const k of keys) expect(k, `key ${k}`).not.toMatch(denylist);
  });
});

// ---------------------------------------------------------------------------
// Saving scenarios
// ---------------------------------------------------------------------------
describe("saving an adjustment scenario", () => {
  it("stores the engine's input and result, pins what it priced with and resolves the handling itself", async () => {
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through");
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "manual_approval");
    const id = await saveScenario(f, { name: "Reweigh, customer A" });
    const [row] = await sql<Record<string, any>>("select brand_id, name, adjustment_type, rate_card_version_id, rule_version_ids, override_ids, policy_snapshot, priced_on::text, created_by, archived_at from public.adjustment_scenarios where id = $1", [id]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(row).toEqual({ brand_id: w.brandA.id, name: "Reweigh, customer A", adjustment_type: "reweight", rate_card_version_id: f.v1, rule_version_ids: [f.rules.reweigh.versionId], override_ids: [], policy_snapshot: { postage_difference: "pass_through", separate_fee: "manual_approval" }, priced_on: f.today, created_by: admin(), archived_at: null });
    const [audit] = await sql<{ actor_id: string; brand_id: string; metadata: Record<string, unknown> }>("select actor_id, brand_id, metadata from public.audit_events where action = 'adjustment.scenario_saved' and entity_id = $1", [id]);
    expect(audit).toMatchObject({ actor_id: admin(), brand_id: w.brandA.id });
    expect(JSON.stringify(audit!.metadata)).not.toMatch(SENTINEL_PATTERN);
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/5\.30|2\.00/);
  });

  it("refuses what is not valid: other tenants, other customers, bad pins, a policy that moved, oversize and malformed JSON", async () => {
    for (const user of [w.t1.employee, w.brandA.admin, w.t2.admin, w.outsider]) await expectCode(saveScenarioRaw(f, { by: user.id }), "42501", /not allowed/);
    await expectCode(saveScenarioRaw(f, { brand: w.brandC.id }), "P0002", /not found/);
    await expectCode(saveScenarioRaw(f, { brand: w.brandB.id }), "P0001", /not assigned to this customer/);
    await expectCode(saveScenarioRaw(f, { versionId: "00000000-0000-4000-8000-000000000000" }), "P0002", /not found/);
    await expectCode(saveScenarioRaw(f, { ruleVersionIds: ["00000000-0000-4000-8000-000000000000"] }), "P0002", /not found/);
    await expectCode(saveScenarioRaw(f, { ruleVersionIds: ["not-a-uuid"] }), "PC001", /invalid pins/);
    await expectCode(saveScenarioRaw(f, { overrideIds: ["00000000-0000-4000-8000-000000000000"] }), "P0002", /not found/);
    await expectCode(saveScenarioRaw(f, { brand: null, overrideIds: ["00000000-0000-4000-8000-000000000000"] }), "PC001", /no customer exceptions/);
    await expectCode(saveScenarioRaw(f, { type: "correction" }), "PC001", /invalid scenario/);
    await expectCode(saveScenarioRaw(f, { name: "  " }), "PC001", /invalid scenario/);
    await expectCode(saveScenarioRaw(f, { result: { ...scenarioResult(), status: "mostly" } }), "PC001", /status/);
    await expectCode(saveScenarioRaw(f, { result: { ...scenarioResult(), basis: "guess" } }), "PC001", /basis/);
    await expectCode(saveScenarioRaw(f, { result: scenarioResult({ postage: "5.3" }) }), "PC001", /component_amount/);
    await expectCode(saveScenarioRaw(f, { result: scenarioResult({ feeState: "maybe" }) }), "PC001", /component_state/);
    await expectCode(saveScenarioRaw(f, { result: { ...scenarioResult(), adjustmentType: "remeasure" } }), "PC001", /another adjustment type/);
    await expectCode(saveScenarioRaw(f, { input: { v: 1, padding: "x".repeat(17_000) } }), "PC001", /too large/);
    await expectCode(saveScenarioRaw(f, { pricedOn: "tomorrow" }), "PC001", /priced-on/);
    // The handling the engine reports must be what the policy resolves to today.
    await expectCode(saveScenarioRaw(f, { result: scenarioResult({ handling: { separate_fee: "absorbed" } }) }), "PC003", /policy changed/);
    expect(await saveScenario(f, { result: scenarioResult({ handling: { postage_difference: "pass_through", separate_fee: "manual_approval" } }) })).toMatch(/^[0-9a-f-]{36}$/);
    // A scenario without a customer is allowed (staff exploration) but pins no customer exceptions.
    expect(await saveScenario(f, { brand: null, name: "Exploration" })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("archiving is the only change a saved scenario accepts; it is idempotent and row-scoped", async () => {
    const id = await saveScenario(f, { name: "To archive" });
    await expectCode(asUser(w.t2.admin.id, "select public.archive_adjustment_scenario($1)", [id]), "P0002", /not found/);
    await expectCode(asUser(w.t1.employee.id, "select public.archive_adjustment_scenario($1)", [id]), "P0002", /not found/);
    await asUser(admin(), "select public.archive_adjustment_scenario($1)", [id]);
    const [{ archived_at }] = (await sql<{ archived_at: Date | null }>("select archived_at from public.adjustment_scenarios where id = $1", [id])) as [{ archived_at: Date | null }];
    expect(archived_at).not.toBeNull();
    await asUser(admin(), "select public.archive_adjustment_scenario($1)", [id]);
    await expectCode(asOwnerWithGuardOpen("update public.adjustment_scenarios set name = 'renamed' where id = $1", [id]), "42501", /only archiving/);
    await expectCode(asOwnerWithGuardOpen("update public.adjustment_scenarios set result = '{}' where id = $1", [id]), "42501", /only archiving/);
  });
});

// ---------------------------------------------------------------------------
// Publishing: the payload is built in SQL
// ---------------------------------------------------------------------------
describe("publishing an example to a customer", () => {
  let source: string;
  let published: string;

  it("previews exactly what a customer would read, then shares it; the client sends only text", async () => {
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through");
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "manual_approval");
    source = await saveScenario(f, { name: "Customer A, 5 lb to 12 lb" });
    const [pv] = await asUser<{ r: Record<string, any> }>(admin(), "select public.preview_customer_example($1, $2) as r", [source, w.brandA.id]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(pv!.r.ok).toBe(true);
    expect(pv!.r.pins).toBeUndefined(); // pins are staff-only and never returned by the preview
    expect(pv!.r.payload).toEqual({
      v: 1, adjustmentType: "reweight", pricedOn: f.today,
      input: { service: { carrier: "UPS", service: "UPS Ground" }, direction: "increase", residential: true, zone: 5, declared: { packages: [{ weightLb: "5", lengthIn: "10", widthIn: "8", heightIn: "6" }] }, corrected: { packages: [{ weightLb: "12", lengthIn: "10", widthIn: "8", heightIn: "6" }] } },
      components: [{ kind: "postage_difference", handling: "pass_through", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13" }, { kind: "separate_fee", handling: "manual_approval", amount: "2.00" }],
    });
    expect(pv!.r.hidden).toEqual([]);
    expect((await sql("select 1 from public.published_adjustment_examples where source_scenario_id = $1", [source]))).toHaveLength(0);

    published = await publish(f, source, { note: "Questions? Ask your account manager.", internal: `${SENTINELS.text}_PRIVATE: we absorb ${SENTINELS.absorbed} a month` });
    const [row] = await sql<Record<string, any>>("select * from public.published_adjustment_examples where id = $1", [published]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(row).toMatchObject({ tenant_id: w.t1.id, brand_id: w.brandA.id, source_scenario_id: source, title: "If a 5 lb package is corrected to 12 lb", note_to_customer: "Questions? Ask your account manager.", published_by: admin(), retired_at: null });
    expect(row!.payload).toEqual(pv!.r.payload);
    const [meta] = await sql<{ t: string; v: string; h: string; rates: string }>("select payload::text as t, valid_through::text as v, encode(payload_sha256, 'hex') as h, rates_effective_from::text as rates from public.published_adjustment_examples where id = $1", [published]);
    expect(meta!.h).toBe(sha256Hex(meta!.t));
    expect(meta!.v).toBe((await sql<{ d: string }>("select (current_date + 90)::text as d"))[0]!.d);
    expect(meta!.rates).toBe("2026-01-01"); // the pinned rate card version's effective date, never its number
    expect(row!.pins).toMatchObject({ rateCardVersionId: f.v1, serviceId: f.upsGround, adjustmentType: "reweight", handling: { postage_difference: "pass_through", separate_fee: "manual_approval" } });
    const [audit] = await sql<{ actor_id: string; metadata: Record<string, unknown> }>("select actor_id, metadata from public.audit_events where action = 'adjustment.scenario_published' and entity_id = $1", [published]);
    expect(audit!.actor_id).toBe(admin());
    expect(audit!.metadata).toMatchObject({ title: "If a 5 lb package is corrected to 12 lb", source_scenario_id: source, payload_sha256: meta!.h });
    expect(JSON.stringify(audit!.metadata)).not.toMatch(SENTINEL_PATTERN);
    expect(JSON.stringify(audit!.metadata)).not.toMatch(/5\.30|2\.00|17\.83/);
  });

  it("the customer's function returns only the projection; the staff-only text, figures and ids never appear", async () => {
    for (const user of [w.brandA.admin, w.brandA.employee]) {
      const out = await brandExamples(user.id, w.brandA.id);
      expect(out).toHaveLength(1);
      expect(Object.keys(out[0]!).sort()).toEqual(["id", "note", "payload", "pricedOn", "publishedAt", "ratesEffectiveFrom", "state", "title", "validThrough"]);
      expect(out[0]).toMatchObject({ id: published, state: "current", title: "If a 5 lb package is corrected to 12 lb", note: "Questions? Ask your account manager.", pricedOn: f.today });
      const text = JSON.stringify(out);
      expect(text).not.toMatch(SENTINEL_PATTERN);
      for (const secret of [f.v1, f.cardId, f.rules.reweigh.versionId, f.rules.reweigh.ruleId, source, "adjtest", "northwind", "reweigh_fee", "Adjustment card"]) expect(text, secret).not.toContain(secret);
    }
    // Staff of the tenant may read the same projection (the "what does my customer see" view); everyone else gets an empty list.
    expect(await brandExamples(w.t1.employee.id, w.brandA.id)).toHaveLength(1);
    for (const user of [w.brandB.admin, w.brandC.admin, w.t2.admin, w.outsider, w.platformAdmin]) expect(await brandExamples(user.id, w.brandA.id), user.email).toEqual([]);
    expect(await brandExamples(w.brandB.admin.id, w.brandB.id)).toEqual([]);
    expect(await brandExamples(w.brandA.admin.id, "00000000-0000-4000-8000-000000000000")).toEqual([]);
    await expectDenied(asUser(null, "select public.brand_adjustment_examples($1)", [w.brandA.id]), /permission denied/);
  });

  it("refuses to share what is not safe or not true, with the first reason named", async () => {
    const refuse = async (opts: Parameters<typeof saveScenario>[1], code: string, message: RegExp, brand = w.brandA.id) => {
      const id = await saveScenario(f, { name: `refusal ${code}`, ...opts });
      const [pv] = await asUser<{ r: { ok: boolean; problems: { code: string; message: string }[] } }>(admin(), "select public.preview_customer_example($1, $2) as r", [id, brand]);
      expect(pv!.r.ok).toBe(false);
      expect(pv!.r.problems.map((p) => p.code)).toContain(code);
      expect(await refusalHint(publish(f, id, { brand }), "P0001", message), `${code}: the refusal names its reason`).toBe(pv!.r.problems[0]!.code);
      expect(await liveCopies(id)).toHaveLength(0);
    };
    await refuse({ result: scenarioResult({ basis: "estimate" }) }, "estimate_basis", /estimated amounts/);
    await refuse({ result: scenarioResult({ direction: "decrease" }) }, "not_an_increase", /credit/);
    await refuse({ result: scenarioResult({ status: "no_adjustment" }) }, "no_adjustment", /Nothing changes/);
    await refuse({ result: scenarioResult({ status: "corrected_unavailable" }) }, "not_priced", /could not be priced/);
    await refuse({ result: scenarioResult({ postage: "0.00", fee: "0.00" }) }, "component_below_minimum", /at least \$0\.01/);
    await refuse({ result: scenarioResult({ feeState: "undecided" }) }, "component_undecided", /could not be decided/);
    await refuse({ brand: null }, "no_customer", /without a customer/);
    // Wrong customer: B has no card; the scenario is A's.
    const [scenarioA] = [await saveScenario(f, { name: "A's example" })];
    const [pvWrong] = await asUser<{ r: { problems: { code: string }[] } }>(admin(), "select public.preview_customer_example($1, $2) as r", [scenarioA, w.brandB.id]);
    expect(pvWrong!.r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["wrong_customer", "rate_card_not_assigned"]));
    await expectCode(publish(f, scenarioA, { brand: w.brandB.id }), "P0001", /different customer/);
    // A customer or scenario of another tenant is "not found", never a business refusal.
    await expectCode(publish(f, scenarioA, { brand: w.brandC.id }), "P0002", /not found/);
    await expectCode(publish(f, scenarioA, { by: w.t2.admin.id }), "P0002", /not found/);
    await expectCode(publish(f, "00000000-0000-4000-8000-000000000000"), "P0002", /not found/);
    for (const user of [w.t1.employee, w.brandA.admin, w.outsider, w.platformAdmin]) await expectCode(publish(f, scenarioA, { by: user.id }), "P0002", /not found/);
    // Text: the title and the note are plain text of bounded length.
    await expectCode(publish(f, scenarioA, { title: "" }), "PC001", /title/);
    await expectCode(publish(f, scenarioA, { title: "<img src=x onerror=alert(1)>" }), "PC001", /title/);
    await expectCode(publish(f, scenarioA, { note: "n".repeat(301) }), "PC001", /note to the customer/);
    await expectCode(publish(f, scenarioA, { note: "a​b" }), "PC001", /note to the customer/);
    await expectCode(publish(f, scenarioA, { internal: "p".repeat(1001) }), "PC001", /private note/);
  });

  it("an undecided component is named; an absorbed one is withheld and never appears, whatever it is worth", async () => {
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "absorbed");
    const absorbed = await saveScenario(f, { name: "Fee absorbed", result: scenarioResult({ fee: "7.77" }) });
    const [pv] = await asUser<{ r: { ok: boolean; hidden: { kind: string; reason: string }[]; payload: { components: { kind: string }[] } } }>(admin(), "select public.preview_customer_example($1, $2) as r", [absorbed, w.brandA.id]);
    expect(pv!.r.ok).toBe(true);
    expect(pv!.r.hidden).toEqual([{ kind: "separate_fee", reason: "absorbed" }]);
    expect(pv!.r.payload.components.map((c) => c.kind)).toEqual(["postage_difference"]);
    const id = await publish(f, absorbed);
    const [{ t }] = (await sql<{ t: string }>("select payload::text as t from public.published_adjustment_examples where id = $1", [id])) as [{ t: string }];
    expect(t).not.toContain("7.77");
    expect(JSON.stringify(await brandExamples(w.brandA.admin.id, w.brandA.id))).not.toContain("7.77");
    // Everything absorbed: nothing a customer could read, so nothing to share.
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "absorbed");
    const none = await saveScenario(f, { name: "All absorbed" });
    await expectCode(publish(f, none), "P0001", /nothing to share/);
    // The scenario saved before the change no longer matches the policy.
    await expectCode(publish(f, absorbed), "P0001", /decision on who pays changed/);
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through");
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "manual_approval");
  });

  it("a component that resolves to 'not decided' refuses, naming it; a fee with no rule is only a warning", async () => {
    const owner = await createUser("undecided-owner");
    const tenant = await createTenant(owner, "Undecided Freight");
    const brand = await createBrand(owner, tenant, "Undecided Customer");
    // Priced for a customer of another tenant it would be "not found"; here the point is the policy lookup, so build the pieces directly.
    const [card] = await sql<{ id: string }>("insert into public.rate_cards (tenant_id, name) values ($1, 'C') returning id", [tenant]);
    const [ver] = await sql<{ id: string }>("insert into public.rate_card_versions (rate_card_id, tenant_id, version_number, status, effective_date) values ($1, $2, 1, 'draft', null) returning id", [card!.id, tenant]);
    await sql("insert into public.rate_card_service_terms (version_id, service_id) values ($1, $2)", [ver!.id, f.upsGround]);
    await sql("insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 20, 'lb', 9.60)", [ver!.id, f.upsGround]);
    await sql("update public.rate_card_versions set status = 'active', effective_date = '2026-01-01' where id = $1", [ver!.id]);
    await sql("insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [tenant, brand, card!.id]);
    const pins = JSON.stringify({ rateCardVersionId: ver!.id, ruleVersionIds: [], overrideIds: [], pricedOn: f.today });
    const save = (result: unknown) => asUser<{ id: string }>(owner.id, "select public.save_adjustment_scenario($1, $2, 'Undecided', 'reweight', $3::jsonb, $4::jsonb, $5::jsonb, '1.0.0') as id", [tenant, brand, JSON.stringify(scenarioInput(f)), JSON.stringify(result), pins]);
    const [s1] = await save(scenarioResult());
    const [pv] = await asUser<{ r: { ok: boolean; problems: { code: string; message: string }[] } }>(owner.id, "select public.preview_customer_example($1, $2) as r", [s1!.id, brand]);
    expect(pv!.r.ok).toBe(false);
    expect(pv!.r.problems.map((p) => p.message)).toEqual(expect.arrayContaining(["Decide how the shipping charge difference is handled for this customer first.", "Decide how the separate adjustment fee is handled for this customer first."]));
    await asUser(owner.id, "select public.set_adjustment_policy($1, $2, 'reweight', 'postage_difference', 'pass_through')", [tenant, brand]);
    const [s2] = await save(scenarioResult({ fee: null }));
    const [pv2] = await asUser<{ r: { ok: boolean; hidden: unknown[]; warnings: string[] } }>(owner.id, "select public.preview_customer_example($1, $2) as r", [s2!.id, brand]);
    expect(pv2!.r.ok).toBe(true);
    const [s3] = await save(scenarioResult({ components: [{ kind: "postage_difference", state: "conditional", amount: "5.30" }, { kind: "separate_fee", state: "not_configured", amount: null }] }));
    const [pv3] = await asUser<{ r: { ok: boolean; hidden: { kind: string; reason: string }[]; warnings: string[] } }>(owner.id, "select public.preview_customer_example($1, $2) as r", [s3!.id, brand]);
    expect(pv3!.r).toMatchObject({ ok: true, warnings: ["separate_fee_not_configured"] });
    expect(pv3!.r.hidden).toEqual([{ kind: "separate_fee", reason: "not_configured" }]);
    const [s4] = await save(scenarioResult({ feeState: "waived_for_customer" }));
    expect((await asUser<{ r: { hidden: unknown[] } }>(owner.id, "select public.preview_customer_example($1, $2) as r", [s4!.id, brand]))[0]!.r.hidden).toEqual([{ kind: "separate_fee", reason: "waived_for_customer" }]);
  });

  it("two people sharing one example at once leave exactly one live copy; sharing again stops the old copy; stopping hides it at once", async () => {
    const id = await saveScenario(f, { name: "Race" });
    const [a, b] = await Promise.all([publish(f, id, { title: "Copy one" }), publish(f, id, { title: "Copy two", by: f.dual.id })]);
    expect(a).not.toBe(b);
    const live = await liveCopies(id);
    expect(live).toHaveLength(1);
    expect(await sql("select 1 from public.published_adjustment_examples where source_scenario_id = $1", [id])).toHaveLength(2);
    const retired = await sql<{ retired_by: string }>("select retired_by from public.published_adjustment_examples where source_scenario_id = $1 and retired_at is not null", [id]);
    expect([admin(), f.dual.id]).toContain(retired[0]!.retired_by);
    const shown = (await brandExamples(w.brandA.admin.id, w.brandA.id)).filter((e) => e.id === live[0]!.id);
    expect(shown).toHaveLength(1);
    // Stopping hides it from the customer immediately, is idempotent, and is row-scoped.
    await expectCode(asUser(w.t2.admin.id, "select public.retire_customer_example($1)", [live[0]!.id]), "P0002", /not found/);
    await expectCode(asUser(w.t1.employee.id, "select public.retire_customer_example($1)", [live[0]!.id]), "P0002", /not found/);
    await asUser(admin(), "select public.retire_customer_example($1)", [live[0]!.id]);
    await asUser(admin(), "select public.retire_customer_example($1)", [live[0]!.id]);
    expect((await brandExamples(w.brandA.admin.id, w.brandA.id)).filter((e) => e.id === live[0]!.id)).toHaveLength(0);
    expect(await sql("select 1 from public.audit_events where action = 'adjustment.scenario_retired' and entity_id = $1", [live[0]!.id])).toHaveLength(1);
    // A stopped example cannot be restarted or edited, even by the owner with the write guard open.
    await expectCode(asOwnerWithGuardOpen("update public.published_adjustment_examples set retired_at = null where id = $1", [live[0]!.id]), "42501", /cannot be restarted/);
    await expectCode(asOwnerWithGuardOpen("update public.published_adjustment_examples set title = 'edited' where id = $1", [live[0]!.id]), "42501", /immutable/);
    await expectCode(asOwnerWithGuardOpen("delete from public.published_adjustment_examples where id = $1", [live[0]!.id]), "42501", /offboarding functions/);
  });

  it("a suspended customer or tenant sees nothing at once", async () => {
    const id = await saveScenario(f, { name: "Suspension" });
    const ex = await publish(f, id);
    expect((await brandExamples(w.brandA.admin.id, w.brandA.id)).some((e) => e.id === ex)).toBe(true);
    await asUser(admin(), "update public.brands set status = 'suspended' where id = $1", [w.brandA.id]);
    try {
      expect(await brandExamples(w.brandA.admin.id, w.brandA.id)).toEqual([]);
      expect(await brandExamples(w.t1.employee.id, w.brandA.id)).toEqual([]);
      expect((await exampleState(admin(), ex)).causes).toContain("brand_inactive");
    } finally {
      await asUser(admin(), "update public.brands set status = 'active' where id = $1", [w.brandA.id]);
    }
    expect((await brandExamples(w.brandA.admin.id, w.brandA.id)).some((e) => e.id === ex)).toBe(true);
  });

  it("valid through: the shortest of the request (never beyond 90 days) and every end date the example depends on", async () => {
    const d = async (n: number) => (await sql<{ d: string }>("select (current_date + $1::int)::text as d", [n]))[0]!.d;
    const s = await saveScenario(f, { name: "Valid through" });
    const shorter = await publish(f, s, { validThrough: await d(30) });
    expect((await sql<{ v: string }>("select valid_through::text as v from public.published_adjustment_examples where id = $1", [shorter]))[0]!.v).toBe(await d(30));
    const longer = await publish(f, s, { validThrough: await d(400) });
    expect((await sql<{ v: string }>("select valid_through::text as v from public.published_adjustment_examples where id = $1", [longer]))[0]!.v).toBe(await d(90));
    // A pinned rule version that ends in 20 days caps it.
    const ending = await publishRule(w, "adjtest.reweigh_fee_seasonal", "reweight", "Seasonal reweigh fee", "3.00", { expiration: await d(20) });
    const s2 = await saveScenario(f, { name: "Seasonal", ruleVersionIds: [ending.versionId] });
    const capped = await publish(f, s2);
    expect((await sql<{ v: string }>("select valid_through::text as v from public.published_adjustment_examples where id = $1", [capped]))[0]!.v).toBe(await d(20));
    // A decision that ends in 10 days caps it too.
    const ended = (await sql<{ id: string }>("select id from public.adjustment_policies where tenant_id = $1 and brand_id = $2 and adjustment_type = 'reweight' and component = 'postage_difference'", [w.t1.id, w.brandA.id]))[0]!.id;
    await asUser(admin(), "select public.end_adjustment_policy($1, $2)", [ended, await d(10)]);
    const s3 = await saveScenario(f, { name: "Ends with the decision" });
    const capped2 = await publish(f, s3);
    expect((await sql<{ v: string }>("select valid_through::text as v from public.published_adjustment_examples where id = $1", [capped2]))[0]!.v).toBe(await d(10));
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through", await d(11));
  });

  it("caps: 25 live examples per customer, 200 saved scenarios, 200 saved estimates", async () => {
    const owner = await createUser("caps-owner");
    const tenant = await createTenant(owner, "Caps Freight");
    await createBrand(owner, tenant, "Caps Customer");
    // 200 scenarios (owner inserts: the cap is enforced where the application calls, i.e. the RPC)
    await sql(`insert into public.adjustment_scenarios (tenant_id, brand_id, name, adjustment_type, input, result, engine_version, priced_on)
               select $1, null, 'filler ' || g, 'reweight', '{}', '{}', '1.0.0', current_date from generate_series(1, 200) g`, [tenant]);
    await expectCode(
      asUser(owner.id, "select public.save_adjustment_scenario($1, null, 'one too many', 'reweight', $2::jsonb, $3::jsonb, $4::jsonb, '1.0.0')", [tenant, JSON.stringify(scenarioInput(f)), JSON.stringify(scenarioResult()), JSON.stringify({ ruleVersionIds: [], overrideIds: [], pricedOn: f.today })]),
      "P0001", /limit of 200 saved examples/,
    );
    await sql(`insert into public.risk_estimates (tenant_id, name, inputs, result, engine_version) select $1, 'filler ' || g, '{}', '{}', '1.0.0' from generate_series(1, 200) g`, [tenant]);
    await expectCode(asUser(owner.id, "select public.save_risk_estimate($1, null, 'one too many', '{}', '{}', '1.0.0')", [tenant]), "P0001", /limit of 200 saved estimates/);
    // 500 baselines (one per day)
    await sql(`insert into public.adjustment_baselines (tenant_id, period_start, period_end, packages_total) select $1, date '2020-01-01' + g, date '2020-01-01' + g, 10 from generate_series(1, 500) g`, [tenant]);
    await expectCode(asUser(owner.id, "select public.save_adjustment_baseline($1, null, null, null, '2024-01-01', '2024-01-31', 10)", [tenant]), "P0001", /limit of 500 baselines/);
  });
});

// ---------------------------------------------------------------------------
// Staleness is computed at read time
// ---------------------------------------------------------------------------
describe("an example that is no longer true hides its amounts", () => {
  const freshExample = async (name: string) => {
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through").catch(() => undefined);
    const rule = (await sql<{ id: string }>("select v.id from public.surcharge_rule_versions v join public.surcharge_rules r on r.id = v.rule_id where r.tenant_id = $1 and r.rule_key = 'adjtest.reweigh_fee' and v.status = 'published' and v.effective_date <= current_date and (v.expiration_date is null or v.expiration_date >= current_date)", [w.t1.id]))[0]!.id;
    const activeVersion = (await sql<{ id: string }>("select id from public.rate_card_versions where rate_card_id = $1 and status = 'active' and effective_date <= current_date and (expiration_date is null or expiration_date >= current_date)", [f.cardId]))[0]!.id;
    const scenario = await saveScenario(f, { name, ruleVersionIds: [rule], versionId: activeVersion });
    return publish(f, scenario);
  };
  const mine = async (id: string) => (await brandExamples(w.brandA.admin.id, w.brandA.id)).find((e) => e.id === id)!;

  it("is current while nothing changed", async () => {
    const ex = await freshExample("Fresh");
    expect(await exampleState(admin(), ex)).toEqual({ state: "current", causes: [] });
    // The whole account's list in one call: live examples only, with the state and the causes.
    const [all] = await asUser<{ r: { id: string; brandId: string; state: string; causes: string[] }[] }>(admin(), "select public.adjustment_example_states($1) as r", [w.t1.id]);
    expect(all!.r.find((x) => x.id === ex)).toEqual({ id: ex, brandId: w.brandA.id, state: "current", causes: [] });
    expect(all!.r.every((x) => ["current", "under_review", "expired"].includes(x.state))).toBe(true);
    await expectCode(asUser(w.t1.employee.id, "select public.adjustment_example_states($1)", [w.t1.id]), "42501", /not allowed/);
    await expectCode(asUser(w.t2.admin.id, "select public.adjustment_example_states($1)", [w.t1.id]), "42501", /not allowed/);
    expect(await mine(ex)).toMatchObject({ state: "current" });
    expect((await mine(ex)).payload).not.toBeNull();
    await expectCode(asUser(w.t2.admin.id, "select public.adjustment_example_state($1)", [ex]), "P0002", /not found/);
    await expectCode(asUser(w.brandA.admin.id, "select public.adjustment_example_state($1)", [ex]), "P0002", /not found/);
  });

  it("the policy moves to absorbed: under review, payload null, one neutral state for the customer", async () => {
    const ex = await freshExample("Policy flips");
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "absorbed");
    expect(await exampleState(admin(), ex)).toEqual({ state: "under_review", causes: ["policy_changed"] });
    const seen = await mine(ex);
    expect(seen).toMatchObject({ state: "under_review", payload: null, title: expect.any(String) });
    expect(JSON.stringify(seen)).not.toMatch(/policy|absorb|manual|5\.30|2\.00/i);
    // Putting the decision back makes it current again (nothing was edited; the state is computed).
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "manual_approval");
    expect(await exampleState(admin(), ex)).toEqual({ state: "current", causes: [] });
    expect((await mine(ex)).payload).not.toBeNull();
  });

  it("a customer exception on a pinned rule: under review", async () => {
    const ex = await freshExample("Exception");
    const pinnedRuleId = f.rules.reweigh.ruleId;
    const [o] = await asUser<{ id: string }>(admin(), "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date) values ($1, $2, $3, 'exclude', current_date) returning id", [w.t1.id, w.brandA.id, pinnedRuleId]);
    expect(await exampleState(admin(), ex)).toEqual({ state: "under_review", causes: ["exception_changed"] });
    expect(await mine(ex)).toMatchObject({ state: "under_review", payload: null });
    await asUser(admin(), "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [o!.id]);
    expect((await exampleState(admin(), ex)).state).toBe("current");
  });

  it("the customer's assignment or allowed services change: under review", async () => {
    const ex = await freshExample("Assignment");
    const [a] = await sql<{ id: string }>("select id from public.brand_rate_card_assignments where brand_id = $1 and rate_card_id = $2 and unassigned_at is null", [w.brandA.id, f.cardId]);
    await asUser(admin(), "update public.brand_rate_card_assignments set allowed_service_ids = $2 where id = $1", [a!.id, [f.uspsGa]]);
    expect(await exampleState(admin(), ex)).toEqual({ state: "under_review", causes: ["assignment_changed"] });
    await asUser(admin(), "update public.brand_rate_card_assignments set allowed_service_ids = null where id = $1", [a!.id]);
    expect((await exampleState(admin(), ex)).state).toBe("current");
  });

  it("a pinned rule version is replaced by a newer one: under review", async () => {
    const rule = await publishRule(w, "adjtest.reweigh_fee_v2", "reweight", "Reweigh fee, replaceable", "3.00");
    const scenario = await saveScenario(f, { name: "Rule replaced", ruleVersionIds: [rule.versionId] });
    const ex = await publish(f, scenario);
    expect(await exampleState(admin(), ex)).toEqual({ state: "current", causes: [] });
    // Retire v1 as of yesterday and publish v2 from today: the version in force today is no longer the pinned one.
    await asUser(admin(), "select public.retire_surcharge_rule_version($1, (current_date - 1))", [rule.versionId]);
    await publishRule(w, "adjtest.reweigh_fee_v2", "reweight", "Reweigh fee, replaceable", "3.50", { ruleId: rule.ruleId, version: 2, effective: f.today });
    expect(await exampleState(admin(), ex)).toEqual({ state: "under_review", causes: ["rule_changed"] });
    expect(await mine(ex)).toMatchObject({ state: "under_review", payload: null });
  });

  it("a new rate card version takes over: under review", async () => {
    const ex = await freshExample("Rate card");
    await asUser(admin(), "select public.end_rate_card_version($1, (current_date - 1))", [f.v1]);
    const [v2] = await asUser<{ id: string }>(admin(), "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 2) returning id", [f.cardId, w.t1.id]);
    await asUser(admin(), "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139)", [v2!.id, f.upsGround]);
    await asUser(admin(), "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 20, 'lb', 9.99)", [v2!.id, f.upsGround]);
    await asUser(admin(), "select public.activate_rate_card_version($1, current_date)", [v2!.id]);
    expect(await exampleState(admin(), ex)).toEqual({ state: "under_review", causes: ["rate_card_changed"] });
    expect(await mine(ex)).toMatchObject({ state: "under_review", payload: null });
    // A scenario priced on the old version can no longer be shared.
    const stale = await saveScenario(f, { name: "Old card", versionId: f.v1 });
    await expectCode(publish(f, stale), "P0001", /rate card/);
  });

  it("the shown-until date passes: expired, payload null, the customer is told it is expired (not why)", async () => {
    const ex = await freshExample("Expiry");
    await asOwnerWithoutTriggers("update public.published_adjustment_examples set valid_through = current_date - 1 where id = $1", [ex]);
    expect(await exampleState(admin(), ex)).toEqual({ state: "expired", causes: ["valid_through_passed"] });
    expect(await mine(ex)).toMatchObject({ state: "expired", payload: null });
  });
});

// ---------------------------------------------------------------------------
// D8: the pricing context a customer gets
// ---------------------------------------------------------------------------
describe("reweigh, remeasure and correction fee rules leave a customer's pricing context only when the decision is 'absorbed'", () => {
  type Rules = { rules: { key: string; category: string; scope: string; sourceReference: string }[]; overrides: { reference: string }[] };
  const ruleKeys = async (userId: string, brand: string | null, view = false) =>
    (await asUser<{ r: Rules }>(userId, "select public.pricing_rules_for_card($1, current_date, $2, null, $3) as r", [f.cardId, brand, view]))[0]!.r;
  // Platform-scope rules (published for everyone by other tests in the shared database) are not what these tests are about.
  const keys = (r: Rules) => r.rules.filter((x) => x.scope === "tenant").map((x) => x.key).sort();
  const all = ["adjtest.correction_fee", "adjtest.remeasure_fee", "adjtest.reweigh_fee"];

  it("not decided, passed through or decided case by case: the rule stays in the customer's schedule", async () => {
    const owner = await createUser("d8-owner");
    // Customer A's own rows decide; clean slate for the three fee types by using customer B's rows for other checks.
    expect(keys(await ruleKeys(w.brandA.admin.id, null))).toEqual(expect.arrayContaining(all));
    for (const t of [["reweight", "pass_through"], ["remeasure", "manual_approval"]] as const) await setPolicy(admin(), w.t1.id, w.brandA.id, t[0], "separate_fee", t[1]);
    expect(keys(await ruleKeys(w.brandA.admin.id, null))).toEqual(expect.arrayContaining(all));
    expect(owner.id).toBeTruthy();
  });

  it("absorbed removes exactly the matching rule for that customer, for the customer and for staff pricing on the customer's behalf", async () => {
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "absorbed");
    await setPolicy(admin(), w.t1.id, w.brandA.id, "correction", "separate_fee", "absorbed");
    for (const [user, brand] of [[w.brandA.admin.id, null], [w.brandA.employee.id, w.brandA.id], [admin(), w.brandA.id], [w.t1.employee.id, w.brandA.id]] as const) {
      expect(keys(await ruleKeys(user, brand)), `${user} for ${brand}`).toEqual(["adjtest.remeasure_fee"]);
    }
    // Staff pricing for nobody (the default context) and the staff-only unfiltered view still carry every rule.
    expect(keys(await ruleKeys(admin(), null))).toEqual(expect.arrayContaining(all));
    expect(keys(await ruleKeys(admin(), w.brandA.id, true))).toEqual(expect.arrayContaining(all));
    // The unfiltered view is honoured for staff only: a customer asking for it still gets the filtered context.
    expect(keys(await ruleKeys(w.brandA.admin.id, null, true))).toEqual(["adjtest.remeasure_fee"]);
    // The account default decides for customers without their own row.
    await setPolicy(admin(), w.t1.id, null, "remeasure", "separate_fee", "absorbed");
    expect(keys(await ruleKeys(w.t1.employee.id, w.brandB.id))).toEqual(expect.arrayContaining(["adjtest.reweigh_fee", "adjtest.correction_fee"]));
    expect(keys(await ruleKeys(w.t1.employee.id, w.brandB.id))).not.toContain("adjtest.remeasure_fee");
    // Changing the decision back restores the rule for the customer at once.
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "separate_fee", "manual_approval");
    expect(keys(await ruleKeys(w.brandA.admin.id, null))).toContain("adjtest.reweigh_fee");
  });

  it("the customer's exception notes and the 3PL's rule sources never reach the customer's pricing context", async () => {
    const [o] = await asUser<{ id: string }>(admin(), "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date) values ($1, $2, $3, 'exclude', current_date) returning id", [w.t1.id, w.brandA.id, f.rules.remeasure.ruleId]);
    await asUser(admin(), "insert into public.customer_surcharge_override_notes (override_id, tenant_id, reference) values ($1, $2, $3)", [o!.id, w.t1.id, `${SENTINELS.text}_OVERRIDE_NOTE: waived because they threatened to leave`]);
    const r = await ruleKeys(w.brandA.admin.id, null);
    expect(JSON.stringify(r)).not.toMatch(SENTINEL_PATTERN);
    expect(r.overrides.map((x) => x.reference)).toEqual(["Your 3PL's approved pricing configuration"]);
    expect(r.rules.filter((x) => x.scope === "tenant").every((x) => x.sourceReference === "Your 3PL's approved pricing configuration")).toBe(true);
    await asUser(admin(), "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [o!.id]);
  });
});

describe("D8 matrix: decision x fee type x who is asking (a fresh account, nothing else set)", () => {
  let w2: World;
  let f2: Fixture;
  const keyOf = { reweight: "adjtest.reweigh_fee", remeasure: "adjtest.remeasure_fee", correction: "adjtest.correction_fee" } as const;
  type Kind = keyof typeof keyOf;
  const present = async (userId: string, brand: string | null, view = false) => {
    const [r] = await asUser<{ r: { rules: { key: string; scope: string }[] } }>(userId, "select public.pricing_rules_for_card($1, current_date, $2, null, $3) as r", [f2.cardId, brand, view]);
    return r!.r.rules.filter((x) => x.scope === "tenant").map((x) => x.key).sort();
  };

  beforeAll(async () => {
    w2 = await buildWorld();
    f2 = await buildFixture(w2);
  });

  it("not decided keeps every rule in a customer's context (and for staff pricing on their behalf)", async () => {
    const all = Object.values(keyOf).sort();
    expect(await present(w2.brandA.admin.id, null)).toEqual(all);
    expect(await present(w2.t1.admin.id, w2.brandA.id)).toEqual(all);
    expect(await present(w2.t1.employee.id, null)).toEqual(all);
  });

  for (const kind of ["reweight", "remeasure", "correction"] as Kind[]) {
    it(`${kind}: absorbed removes only ${keyOf[kind]}; passed through and decided case by case keep it; the shipping-charge decision never matters`, async () => {
      const others = Object.entries(keyOf).filter(([k]) => k !== kind).map(([, v]) => v).sort();
      const user = w2.brandA.employee.id;
      await setPolicy(w2.t1.admin.id, w2.t1.id, w2.brandA.id, kind, "separate_fee", "absorbed");
      expect(await present(user, null), "absorbed").toEqual(others);
      expect(await present(w2.t1.admin.id, w2.brandA.id), "absorbed, staff on behalf").toEqual(others);
      expect(await present(w2.t1.admin.id, w2.brandA.id, true), "absorbed, staff unfiltered view").toContain(keyOf[kind]);
      await setPolicy(w2.t1.admin.id, w2.t1.id, w2.brandA.id, kind, "separate_fee", "pass_through");
      expect(await present(user, null), "pass_through").toContain(keyOf[kind]);
      await setPolicy(w2.t1.admin.id, w2.t1.id, w2.brandA.id, kind, "separate_fee", "manual_approval");
      expect(await present(user, null), "manual_approval").toContain(keyOf[kind]);
      if (kind !== "correction") {
        await setPolicy(w2.t1.admin.id, w2.t1.id, w2.brandA.id, kind, "postage_difference", "absorbed");
        expect(await present(user, null), "an absorbed shipping-charge decision keeps the fee rule").toContain(keyOf[kind]);
      }
      // The same decision for another customer or the account default behaves the same way.
      await setPolicy(w2.t1.admin.id, w2.t1.id, null, kind, "separate_fee", "absorbed");
      expect(await present(w2.t1.employee.id, w2.brandB.id), "account default absorbed, customer B").not.toContain(keyOf[kind]);
      expect(await present(user, null), "customer A has its own decision (manual approval) and keeps the rule").toContain(keyOf[kind]);
    });
  }

  it("each fee type follows its own decision: with every account default absorbed customer B has none; reopening one brings back only that one", async () => {
    // The loop above left the account default of all three types absorbed; customer B has no decision of its own.
    expect(await present(w2.t1.employee.id, w2.brandB.id)).toEqual([]);
    await setPolicy(w2.t1.admin.id, w2.t1.id, null, "correction", "separate_fee", "pass_through");
    expect(await present(w2.t1.employee.id, w2.brandB.id)).toEqual(["adjtest.correction_fee"]);
    await setPolicy(w2.t1.admin.id, w2.t1.id, null, "reweight", "separate_fee", "manual_approval");
    expect(await present(w2.t1.employee.id, w2.brandB.id)).toEqual(["adjtest.correction_fee", "adjtest.reweigh_fee"]);
    // A customer with no card has no pricing context at all (nothing to filter), whatever is decided.
    await expectCode(present(w2.brandB.admin.id, null), "P0003", /not found/);
  });
});

describe("a reweigh, remeasure or correction fee rule is a conditional charge", () => {
  it("a new version of such a rule cannot be counted (definite or estimated); other categories are unaffected; old rows are left alone", async () => {
    const [r] = await asUser<{ id: string }>(admin(), "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'adjtest.class_check', 'reweight', 'Class check') returning id", [w.t1.id]);
    for (const cls of ["definite", "estimated"]) {
      await expectCode(
        asUser(admin(), "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 1, $3, 'flat', 3, '2026-01-01', 'x', 'approved_3pl_config')", [r!.id, w.t1.id, cls]),
        "23514", /conditional charge/,
      );
    }
    const [ok] = await asUser<{ id: string }>(admin(), "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 1, 'conditional', 'flat', 3, '2026-01-01', 'x', 'approved_3pl_config') returning id", [r!.id, w.t1.id]);
    await expectCode(asUser(admin(), "update public.surcharge_rule_versions set charge_class = 'definite' where id = $1", [ok!.id]), "23514", /conditional charge/);
    const [other] = await asUser<{ id: string }>(admin(), "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'adjtest.class_other', 'residential', 'Residential') returning id", [w.t1.id]);
    await asUser(admin(), "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 1, 'definite', 'flat', 3, '2026-01-01', 'x', 'approved_3pl_config')", [other!.id, w.t1.id]);
    // A nonconforming row that already exists (inserted with the trigger off) can still be edited in other columns.
    const legacy = await asOwnerWithoutTriggers("insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 2, 'definite', 'flat', 3, '2026-02-01', 'x', 'approved_3pl_config') returning id", [r!.id, w.t1.id]);
    await asUser(admin(), "update public.surcharge_rule_versions set amount = 4 where id = $1", [legacy[0]!.id as string]);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
describe("audit", () => {
  it("clients can no longer write adjustment.* events; the other namespaces still work; there is still one log_audit_event", async () => {
    for (const user of [w.brandA.employee, w.t1.admin, f.dual]) {
      for (const action of ["adjustment.policy_set", "adjustment.scenario_published", "adjustment.scenario_retired", "adjustment.data_purged"]) {
        await expectCode(asUser(user.id, "select public.log_audit_event($1, null, $2, 'x', 'y')", [w.t1.id, action]), "42501", /not permitted/);
      }
    }
    await asUser(w.brandA.employee.id, "select public.log_audit_event($1, $2, 'simulation.run', 'simulation', 'sim-1')", [w.t1.id, w.brandA.id]);
    await asUser(admin(), "select public.log_audit_event($1, null, 'export.adjustment_history', 'export', 'x')", [w.t1.id]);
    expect(await sql("select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_audit_event'")).toHaveLength(1);
  });

  it("trigger rows carry the real actor and ids, names and counts only: never an amount, a note or a figure", async () => {
    const rows = await sql<{ action: string; actor_id: string | null; entity_id: string; metadata: Record<string, unknown> }>("select action, actor_id, entity_id, metadata from public.audit_events where tenant_id = $1 and action like 'adjustment.%'", [w.t1.id]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["adjustment.policy_set", "adjustment.policy_ended", "adjustment.scenario_saved", "adjustment.scenario_published", "adjustment.scenario_retired"]) expect([...actions], a).toContain(a);
    expect(rows.every((r) => r.actor_id === admin() || r.actor_id === f.dual.id)).toBe(true);
    for (const r of rows) {
      const text = JSON.stringify(r.metadata);
      expect(text, r.action).not.toMatch(SENTINEL_PATTERN);
      expect(text.length, r.action).toBeLessThan(2000);
    }
    // Brands, employees and platform administrators read none of it.
    for (const user of [w.brandA.admin, w.brandB.admin, w.t1.employee, w.platformAdmin, w.t2.admin, w.outsider]) {
      expect(await asUser(user.id, "select id from public.audit_events where action like 'adjustment.%'"), user.email).toHaveLength(0);
    }
    expect((await asUser(admin(), "select id from public.audit_events where action like 'adjustment.%'")).length).toBeGreaterThan(5);
    // Audit rows are written by triggers inside the transaction of the change: a refused change leaves none.
    const before = (await sql("select 1 from public.audit_events where action = 'adjustment.policy_set' and tenant_id = $1", [w.t1.id])).length;
    await expectCode(setPolicy(admin(), w.t1.id, null, "correction", "postage_difference", "absorbed"), "PC001");
    expect((await sql("select 1 from public.audit_events where action = 'adjustment.policy_set' and tenant_id = $1", [w.t1.id])).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------
describe("offboarding: purge functions", () => {
  it("leave zero rows for the tenant (or customer), touch nobody else's, and are not callable by a user", async () => {
    const owner = await createUser("purge-owner");
    const tenant = await createTenant(owner, "Purge Freight");
    const brand = await createBrand(owner, tenant, "Purge Customer");
    const other = await createBrand(owner, tenant, "Purge Other Customer");
    await asUser(owner.id, "select public.set_adjustment_policy($1, null, 'reweight', 'postage_difference', 'pass_through')", [tenant]);
    await asUser(owner.id, "select public.set_adjustment_policy($1, $2, 'reweight', 'separate_fee', 'absorbed')", [tenant, brand]);
    await asUser(owner.id, "select public.save_adjustment_baseline($1, $2, null, null, '2026-01-01', '2026-01-31', 1000)", [tenant, brand]);
    await asUser(owner.id, "select public.save_adjustment_baseline($1, $2, null, null, '2026-01-01', '2026-01-31', 500)", [tenant, other]);
    await asUser(owner.id, "select public.save_risk_estimate($1, $2, 'Estimate', '{}', '{}', '1.0.0')", [tenant, brand]);
    await asUser(owner.id, "select public.save_risk_estimate($1, null, 'Estimate, all customers', '{}', '{}', '1.0.0')", [tenant]);
    const [imp] = await sql<{ id: string }>("insert into public.adjustment_imports (tenant_id, name, status, accepted_count, committed_count, attested_by, attested_at) values ($1, 'old', 'committed', 2, 2, $2, now()) returning id", [tenant, owner.id]);
    await sql("insert into public.adjustment_records (tenant_id, import_id, row_no, brand_id, ship_date, carrier_code, adjustment_type, cause, declared_weight_basis) values ($1, $2, 1, $3, '2026-01-05', 'ups', 'reweight', 'carrier_reweigh', 'missing'), ($1, $2, 2, $4, '2026-01-06', 'ups', 'reweight', 'carrier_reweigh', 'missing')", [tenant, imp!.id, brand, other]);
    const counts = async (t: string) => (await sql<{ n: string }>(
      `select (select count(*) from public.adjustment_policies where tenant_id = $1) + (select count(*) from public.adjustment_baselines where tenant_id = $1) + (select count(*) from public.risk_estimates where tenant_id = $1)
            + (select count(*) from public.adjustment_records where tenant_id = $1) + (select count(*) from public.adjustment_imports where tenant_id = $1) as n`, [t]))[0]!.n;
    const t1Before = await counts(w.t1.id);
    expect(Number(await counts(tenant))).toBeGreaterThan(6);
    await expectDenied(asUser(owner.id, "select app.purge_tenant_adjustment_data($1)", [tenant]), /permission denied/);
    await expectDenied(asUser(owner.id, "select app.purge_brand_adjustment_data($1)", [brand]), /permission denied/);
    const brandPurge = (await sql<{ r: Record<string, number> }>("select app.purge_brand_adjustment_data($1) as r", [brand]))[0]!.r;
    expect(brandPurge).toMatchObject({ baselines: 1, estimates: 1, records: 1, policies: 1 });
    expect(await sql("select 1 from public.adjustment_baselines where brand_id = $1", [other])).toHaveLength(1); // another customer's data stays
    expect(await sql("select 1 from public.adjustment_records where brand_id = $1", [other])).toHaveLength(1);
    const tenantPurge = (await sql<{ r: Record<string, number> }>("select app.purge_tenant_adjustment_data($1) as r", [tenant]))[0]!.r;
    expect(tenantPurge).toMatchObject({ baselines: 1, estimates: 1, records: 1, imports: 1, policies: 1 });
    expect(await counts(tenant)).toBe("0");
    expect(await counts(w.t1.id)).toBe(t1Before);
    const audit = await sql<{ metadata: { scope: string }; brand_id: string | null }>("select metadata, brand_id from public.audit_events where tenant_id = $1 and action = 'adjustment.data_purged' order by id", [tenant]);
    expect(audit.map((a) => a.metadata.scope)).toEqual(["brand", "tenant"]);
    expect(audit[0]!.brand_id).toBe(brand);
    // Purging wrote one row per purge, not one per deleted baseline.
    expect(await sql("select 1 from public.audit_events where tenant_id = $1 and action = 'adjustment.baseline_deleted'", [tenant])).toHaveLength(0);
    // With the data gone the tenant can be deleted from the application's point of view: nothing in M5 blocks it any more.
    expect(await sql("select 1 from public.published_adjustment_examples where tenant_id = $1", [tenant])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 0: the leak fixes and the shared objects
// ---------------------------------------------------------------------------
describe("step 0: staff-only copies of free text a customer could read", () => {
  it("the brand-readable columns are gone; their text lives in tables only the 3PL's staff can read", async () => {
    expect(await sql("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rate_card_service_terms' and column_name = 'source_reference'")).toHaveLength(0);
    expect(await sql("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customer_surcharge_overrides' and column_name = 'reference'")).toHaveLength(0);
    // Customer A (assigned the card) reads the terms, never the source of the terms.
    expect((await asUser(w.brandA.employee.id, "select id from public.rate_card_service_terms")).length).toBeGreaterThan(0);
    for (const table of ["rate_card_service_term_sources", "customer_surcharge_override_notes"]) {
      for (const user of [w.brandA.admin, w.brandA.employee, w.brandB.admin, w.brandC.admin, w.outsider, w.platformAdmin, w.t2.admin]) {
        expect(await asUser(user.id, `select * from public.${table}`), `${table} ${user.email}`).toHaveLength(0);
      }
    }
    expect((await asUser(w.t1.employee.id, "select source_reference from public.rate_card_service_term_sources")).map((r) => r.source_reference as string)[0]).toContain(SENTINELS.text);
    // Writes follow pricing management; an active version's term sources are frozen like its terms.
    await expectDenied(asUser(w.t1.employee.id, "insert into public.rate_card_service_term_sources (term_id, tenant_id, source_reference) values (gen_random_uuid(), $1, 'x')", [w.t1.id]), /row-level security|not a draft/);
    const [t] = await sql<{ id: string }>("select id from public.rate_card_service_terms where version_id = $1", [f.v1]);
    await expectDenied(asUser(admin(), "update public.rate_card_service_term_sources set source_reference = 'changed' where term_id = $1", [t!.id]), /not a draft/);
    await expectDenied(asUser(admin(), "delete from public.rate_card_service_term_sources where term_id = $1", [t!.id]), /not a draft/);
  });

  it("an exception's note is staff-only and optional; the pricing audit never carries it", async () => {
    const [o] = await asUser<{ id: string }>(admin(), "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date) values ($1, $2, $3, 'exclude', current_date) returning id", [w.t1.id, w.brandA.id, f.rules.correction.ruleId]);
    await asUser(admin(), "insert into public.customer_surcharge_override_notes (override_id, tenant_id, reference) values ($1, $2, 'MSA section 4')", [o!.id, w.t1.id]);
    await expectDenied(asUser(w.t1.employee.id, "update public.customer_surcharge_override_notes set reference = 'x' where override_id = $1", [o!.id]).then((r) => { if (r.length === 0) throw new Error("row-level security"); }), /row-level security/);
    await expectDenied(asUser(w.t2.admin.id, "insert into public.customer_surcharge_override_notes (override_id, tenant_id, reference) values ($1, $2, 'x')", [o!.id, w.t2.id]), /row-level security/);
    const audit = await sql<{ metadata: unknown }>("select metadata from public.audit_events where action = 'ratecard.override_created' and entity_id = $1", [o!.id]);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain("MSA");
    await asUser(admin(), "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [o!.id]);
  });
});

describe("step 0: run summaries and run errors", () => {
  it("load-issue text becomes a count in everything a customer can read; staff keep the text in the run context", async () => {
    expect((await sql<{ s: unknown }>("select app.summary_without_load_issues($1::jsonb) as s", [JSON.stringify({ version: 2, loadIssues: ["a", "b", "a"], keep: 1 })]))[0]!.s).toEqual({ version: 2, loadIssueCount: 3, keep: 1 });
    expect((await sql<{ s: unknown }>("select app.summary_without_load_issues($1::jsonb) as s", [JSON.stringify({ version: 2, loadIssueCount: 4 })]))[0]!.s).toEqual({ version: 2, loadIssueCount: 4 });
    expect((await sql<{ s: unknown }>("select app.summary_without_load_issues(null) as s"))[0]!.s).toBeNull();
    // No stored run keeps the text (the migration's backfill ran, and the finishing functions strip it from now on).
    expect(await sql("select 1 from public.simulation_runs where summary ? 'loadIssues' or reference_data ? 'loadIssues' or partial_summary ? 'loadIssues'")).toHaveLength(0);
  });

  it("a forecast saved with load issues shows customers a count; the strings stay in the staff-only context", async () => {
    // Needs a fee schedule only for the version pin; none is assigned here, so use the no-schedule path.
    const assumptions = { asOfDate: f.today, monthlyOrders: "1000.00" };
    const summary = {
      basis: "assumptions", monthlyOrders: "1000.00", weightSum: "1000.00", shipping: { definite: "0.00", perOrder: "9.60" }, processing: { definite: "0.00", estimated: "0.00", perOrder: "0.00" },
      allocated: { perOrder: "0.00" }, allIn: { perOrder: "9.60" }, monthly: { total: "0.00", totalE4: 0 }, minimum: { topUp: "0.00" }, minimumStatus: "none", loadIssues: [`${SENTINELS.text}_ISSUE: rule "adjtest.reweigh_fee" has an invalid condition`],
    };
    const pins = { feeScheduleVersionId: null, rateCardVersionId: f.v1, ruleVersionIds: [], zipListIds: [], overrideIds: [], loadIssues: [`${SENTINELS.text}_PIN_ISSUE: rule "x" could not be applied`] };
    const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.save_forecast_run($1, $2, 'Forecast with issues', $3::jsonb, $4::jsonb, $5::jsonb, '2.2.0', '1.0.0') as id", [w.brandA.id, f.cardId, JSON.stringify(assumptions), JSON.stringify(summary), JSON.stringify(pins)]);
    const [run] = await asUser<{ summary: Record<string, unknown>; reference_data: Record<string, unknown> }>(w.brandA.admin.id, "select summary, reference_data from public.simulation_runs where project_id = $1", [p!.id]);
    expect(run!.summary).toMatchObject({ loadIssueCount: 1 });
    expect(run!.reference_data).toMatchObject({ loadIssueCount: 1 });
    expect(JSON.stringify(run)).not.toMatch(SENTINEL_PATTERN);
    expect(await asUser(w.brandA.admin.id, "select load_issues from public.simulation_run_contexts")).toHaveLength(0);
    const staff = await asUser<{ load_issues: string[] }>(w.t1.employee.id, "select c.load_issues from public.simulation_run_contexts c join public.simulation_runs r on r.id = c.run_id where r.project_id = $1", [p!.id]);
    expect(staff[0]!.load_issues[0]).toContain("PIN_ISSUE");
  });

  it("a failed run shows customers a code; the detail is for staff", async () => {
    const [p] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.save_forecast_run($1, $2, 'To fail', $3::jsonb, $4::jsonb, $5::jsonb, '2.2.0', '1.0.0') as id", [w.brandA.id, f.cardId, JSON.stringify({ asOfDate: f.today, monthlyOrders: "10.00" }),
      JSON.stringify({ basis: "assumptions", monthlyOrders: "10.00", weightSum: "10.00", shipping: { definite: "0.00" }, processing: { definite: "0.00", estimated: "0.00" }, monthly: { total: "0.00", totalE4: 0 }, minimum: { topUp: "0.00" }, minimumStatus: "none" }),
      JSON.stringify({ feeScheduleVersionId: null, rateCardVersionId: f.v1, ruleVersionIds: [], zipListIds: [], overrideIds: [], loadIssues: [] })]);
    // Forecast runs are completed at once; use the bulk path's failing function on a run that is still running.
    expect(p!.id).toBeTruthy();
    const code = (await sql<{ conname: string }>("select conname from pg_constraint where conname = 'simulation_runs_error_is_code'"))[0];
    expect(code).toBeTruthy();
    await expectCode(sql("update public.simulation_runs set error = 'The surcharge rule \"X\" has an invalid condition' where id = (select id from public.simulation_runs limit 1)"), "23514", /simulation_runs_error_is_code/);
  });
});

describe("step 0: shared objects", () => {
  it("deleting a user no longer fails because they uploaded a file or created a project", async () => {
    const owner = await createUser("deletable-owner");
    const tenant = await createTenant(owner, "Deletable Freight");
    const content = Buffer.from("a,b\n1,2\n");
    const [file] = await asUser<{ id: string }>(owner.id, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'rate_card', 'card.csv', 'text/csv', $2, decode($3, 'hex'), $4) returning id", [tenant, content.length, sha256Hex(content), content]);
    const [card] = await asUser<{ id: string }>(owner.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Card') returning id", [tenant]);
    expect(card).toBeTruthy();
    await sql("delete from auth.users where id = $1", [owner.id]);
    expect(await sql("select uploaded_by from public.uploaded_files where id = $1", [file!.id])).toEqual([{ uploaded_by: null }]);
    expect(await sql("select created_by from public.rate_cards where id = $1", [card!.id])).toEqual([{ created_by: null }]);
  });

  it("deleting a user who created M5 data nulls the actor column and nothing else (the write guard lets the foreign-key action through)", async () => {
    const owner = await createUser("m5-deletable");
    const tenant = await createTenant(owner, "M5 Deletable Freight");
    const brand = await createBrand(owner, tenant, "Customer");
    const policy = (await asUser<{ id: string }>(owner.id, "select public.set_adjustment_policy($1, null, 'reweight', 'separate_fee', 'absorbed') as id", [tenant]))[0]!.id;
    const baseline = (await asUser<{ id: string }>(owner.id, "select public.save_adjustment_baseline($1, $2, null, null, '2026-02-01', '2026-02-28', 100) as id", [tenant, brand]))[0]!.id;
    const estimate = (await asUser<{ id: string }>(owner.id, "select public.save_risk_estimate($1, null, 'E', '{}', '{}', '1.0.0') as id", [tenant]))[0]!.id;
    await sql("delete from auth.users where id = $1", [owner.id]);
    expect(await sql("select created_by, handling from public.adjustment_policies where id = $1", [policy])).toEqual([{ created_by: null, handling: "absorbed" }]);
    expect(await sql("select created_by, packages_total from public.adjustment_baselines where id = $1", [baseline])).toEqual([{ created_by: null, packages_total: 100 }]);
    expect(await sql("select created_by from public.risk_estimates where id = $1", [estimate])).toEqual([{ created_by: null }]);
  });

  it("a colleague who saved, shared and stopped examples can be deleted; the examples and their audit stay", async () => {
    const colleague = await createUser("m5-colleague");
    await join(w.t1.admin, colleague, { tenantId: w.t1.id, role: "tenant_admin" });
    // (An earlier test left a future-dated row for the shipping-charge decision; asking for the same decision today then overlaps it, which is fine here.)
    const decide = (component: string, handling: string) => setPolicy(colleague.id, w.t1.id, w.brandA.id, "reweight", component, handling).catch((e: { code?: string }) => { if (e.code !== "P0007") throw e; });
    await decide("postage_difference", "pass_through");
    await decide("separate_fee", "manual_approval");
    const activeVersion = (await sql<{ id: string }>("select id from public.rate_card_versions where rate_card_id = $1 and status = 'active' and effective_date <= current_date and (expiration_date is null or expiration_date >= current_date)", [f.cardId]))[0]!.id;
    const rule = (await sql<{ id: string }>("select v.id from public.surcharge_rule_versions v join public.surcharge_rules r on r.id = v.rule_id where r.tenant_id = $1 and r.rule_key = 'adjtest.reweigh_fee' and v.status = 'published'", [w.t1.id]))[0]!.id;
    const scenario = await saveScenario(f, { name: "By a colleague", by: colleague.id, versionId: activeVersion, ruleVersionIds: [rule] });
    const example = await publish(f, scenario, { by: colleague.id, title: "Shared by a colleague" });
    await asUser(colleague.id, "select public.retire_customer_example($1)", [example]);
    const [imp] = await sql<{ id: string }>("insert into public.adjustment_imports (tenant_id, name, status, accepted_count, committed_count, attested_by, attested_at, created_by) values ($1, 'colleague import', 'committed', 0, 0, $2, now(), $2) returning id", [w.t1.id, colleague.id]);
    await sql("delete from auth.users where id = $1", [colleague.id]);
    expect(await sql("select published_by, retired_by, title from public.published_adjustment_examples where id = $1", [example])).toEqual([{ published_by: null, retired_by: null, title: "Shared by a colleague" }]);
    expect(await sql("select created_by from public.adjustment_scenarios where id = $1", [scenario])).toEqual([{ created_by: null }]);
    expect(await sql("select created_by, attested_by, status from public.adjustment_imports where id = $1", [imp!.id])).toEqual([{ created_by: null, attested_by: null, status: "committed" }]);
    // The audit rows keep the actor's id (audit has no foreign keys, so it outlives the person).
    expect((await sql<{ actor_id: string }>("select actor_id from public.audit_events where action = 'adjustment.scenario_published' and entity_id = $1", [example]))[0]!.actor_id).toBe(colleague.id);
  });

  it("the file policies name their purposes: pricing documents follow pricing management, adjustment files follow adjustment management", async () => {
    const content = Buffer.from("ship_date,carrier\n2026-01-01,ups\n");
    const insertFile = (userId: string, purpose: string, brand: string | null = null) =>
      asUser<{ id: string }>(userId, "insert into public.uploaded_files (tenant_id, brand_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, $3, 'x.csv', 'text/csv', $4, decode($5, 'hex'), $6) returning id", [w.t1.id, brand, purpose, content.length, sha256Hex(content), content]);
    const mine = await insertFile(admin(), "adjustment_import");
    await insertFile(admin(), "rate_card");
    await expectDenied(insertFile(w.t1.employee.id, "adjustment_import"), /row-level security/);
    await expectDenied(insertFile(w.brandA.admin.id, "adjustment_import", w.brandA.id), /row-level security/);
    await expectDenied(insertFile(w.brandA.admin.id, "adjustment_import"), /row-level security/);
    await expectDenied(insertFile(admin(), "adjustment_import", w.brandA.id), /row-level security/);
    await expectDenied(insertFile(w.t2.admin.id, "adjustment_import"), /row-level security/);
    await expectDenied(insertFile(admin(), "history"), /row-level security|uploaded_files_purpose_check/);
    for (const user of [w.t1.employee, w.brandA.admin, w.brandA.employee, w.brandB.admin, w.t2.admin, w.outsider, w.platformAdmin]) {
      expect(await asUser(user.id, "select id from public.uploaded_files where id = $1", [mine[0]!.id]), user.email).toHaveLength(0);
    }
    expect(await asUser(admin(), "select id from public.uploaded_files where id = $1", [mine[0]!.id])).toHaveLength(1);
    // Narrowing, shown without changing any shared data: inside a rolled-back transaction, drop ONE of the two permissions from the role.
    const readable = async (removed: string) =>
      withTx(null, async (q) => {
        await q("delete from public.role_permissions where role_key = 'tenant_admin' and permission_key = $1", [removed]);
        await q("set local role authenticated");
        await q("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: admin(), role: "authenticated" }), admin()]);
        return (await q("select distinct purpose from public.uploaded_files where tenant_id = $1 order by 1", [w.t1.id])).rows.map((r) => r.purpose);
      }, { commit: false });
    expect(await readable("adjustment.manage")).not.toContain("adjustment_import");
    expect(await readable("adjustment.manage")).toContain("rate_card");
    expect(await readable("ratecard.manage")).toContain("adjustment_import");
    expect(await readable("ratecard.manage")).not.toContain("rate_card");
  });

  it("the Data API roles never see a realtime publication of public tables", async () => {
    expect(await sql("select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")).toHaveLength(0);
  });
});

describe("a suspended tenant", () => {
  it("loses every M5 read and write at once, and gets it back when reactivated", async () => {
    const t3 = f.t3;
    await asUser(t3.admin.id, "select public.set_adjustment_policy($1, null, 'reweight', 'separate_fee', 'absorbed')", [t3.id]);
    expect(await asUser(t3.admin.id, "select id from public.adjustment_policies")).toHaveLength(1);
    await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'suspended')", [t3.id]);
    try {
      expect(await asUser(t3.admin.id, "select id from public.adjustment_policies")).toHaveLength(0);
      await expectCode(asUser(t3.admin.id, "select public.set_adjustment_policy($1, null, 'remeasure', 'separate_fee', 'absorbed')", [t3.id]), "42501", /not allowed/);
      await expectCode(asUser(t3.admin.id, "select public.save_adjustment_baseline($1, null, null, null, '2026-01-01', '2026-01-31', 5)", [t3.id]), "42501", /not allowed/);
    } finally {
      await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'active')", [t3.id]);
    }
    expect(await asUser(t3.admin.id, "select id from public.adjustment_policies")).toHaveLength(1);
  });

  it("the dual-role user is treated as the member they are in each role", async () => {
    expect((await asUser(f.dual.id, "select id from public.adjustment_policies where tenant_id = $1", [w.t1.id])).length).toBeGreaterThan(0);
    await setPolicy(f.dual.id, w.t1.id, w.brandB.id, "combined", "separate_fee", "pass_through");
    expect(Array.isArray(await brandExamples(f.dual.id, w.brandA.id))).toBe(true);
    expect(await brandExamples(f.dual.id, w.brandB.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hardening after the phase-3 review (DB-1, DB-3, DB-4, DB-6, DB-10, DB-11, DB-12, F11 and the mutation survivors of DB-14).
// A fresh account of its own, so nothing above (policies, examples, the 25-example cap) is in the way.
// ---------------------------------------------------------------------------
describe("hardening after the phase-3 review", () => {
  let hw: World;
  let hf: Fixture;
  beforeAll(async () => {
    hw = await buildWorld();
    hf = await buildFixture(hw);
  });
  const ha = () => hw.t1.admin.id;
  const hA = () => hw.brandA.id;
  const decide = (type: string, component: string, handling: string, brand: string | null = hA()) => setPolicy(ha(), hw.t1.id, brand, type, component, handling);
  const utcDay = async (offset = 0) => (await sql<{ d: string }>("select ((now() at time zone 'UTC')::date + $1::int)::text as d", [offset]))[0]!.d;
  interface Preview { ok: boolean; problems: { code: string; message: string }[]; payload?: { components: { kind: string; handling: string; amount: string }[] }; hidden?: { kind: string; reason: string }[]; validThrough?: string }
  const previewOf = (id: string, brand = hA()) => asUser<{ r: Preview }>(ha(), "select public.preview_customer_example($1, $2) as r", [id, brand]).then((r) => r[0]!.r);
  const retireAll = () => asOwnerWithGuardOpen("update public.published_adjustment_examples set retired_at = now() where tenant_id = $1 and retired_at is null", [hw.t1.id]);
  const bothDecided = async () => { await decide("reweight", "postage_difference", "pass_through"); await decide("reweight", "separate_fee", "pass_through"); };
  const asBrandA = () => hw.brandA.admin.id;
  const mine = async (id: string) => (await brandExamples(asBrandA(), hA())).find((e) => e.id === id);

  // -------------------------------------------------------------------------
  describe("an amount carries one label: mixed handling is refused, an absorbed amount is never published (DB-1)", () => {
    const pins = () => [hf.rules.reweigh.versionId, hf.rules.correction.versionId];
    const post = (extra: Record<string, unknown> = {}) => ({ kind: "postage_difference", state: "conditional", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13", ...extra });
    const fee = (amount: string, extra: Record<string, unknown>) => ({ kind: "separate_fee", state: "conditional", amount, ...extra });
    const line = (ruleKey: string, handling: string, amount: string) => ({ ruleKey, amount, handling });
    const REWEIGH = "adjtest.reweigh_fee";
    const CORRECTION = "adjtest.correction_fee";
    let n = 0;
    const save = (components: Record<string, unknown>[], over: Record<string, unknown> = {}) => saveScenario(hf, { brand: hA(), name: `mixed handling ${++n}`, ruleVersionIds: pins(), result: scenarioResult({ components }), ...over });
    const refused = async (id: string, code = "mixed_handling") => {
      const pv = await previewOf(id);
      expect(pv.ok, "the preview refuses").toBe(false);
      expect(pv.problems.map((p) => p.code)).toContain(code);
      expect(pv.payload).toBeUndefined();
      expect(await refusalHint(publish(hf, id, { brand: hA() }), "P0001"), "publish refuses with the same code").toBe(pv.problems[0]!.code);
      expect(await liveCopies(id)).toHaveLength(0);
      return pv;
    };
    afterAll(retireAll);

    it("a separate fee whose fee lines differ ('mixed') is refused, whatever it adds up to", async () => {
      await bothDecided();
      await decide("correction", "separate_fee", "absorbed", null);
      const id = await save([post({ engineHandling: "pass_through", handling: "pass_through" }), fee("8.00", { engineHandling: "mixed", lines: [line(REWEIGH, "pass_through", "3.00"), line(CORRECTION, "absorbed", "5.00")] })]);
      const pv = await refused(id);
      expect(pv.problems[0]!.code).toBe("mixed_handling");
      expect(pv.problems[0]!.message).toMatch(/handled differently/);
    });

    it("an absorbed-only correction line under a pass-through type row is refused, not published as 'charged to you'", async () => {
      await bothDecided();
      await decide("correction", "separate_fee", "absorbed", null);
      const id = await save([post({ handling: "pass_through" }), fee("5.00", { engineHandling: "absorbed", lines: [line(CORRECTION, "absorbed", "5.00")] })]);
      await refused(id);
    });

    it("a pass-through correction line under an absorbed type row is refused, not hidden without a word", async () => {
      await decide("reweight", "postage_difference", "pass_through");
      await decide("reweight", "separate_fee", "absorbed");
      await decide("correction", "separate_fee", "pass_through", null);
      const id = await save([post({ handling: "pass_through" }), fee("5.00", { engineHandling: "pass_through", lines: [line(CORRECTION, "pass_through", "5.00")] })]);
      const pv = await refused(id);
      expect(pv.hidden ?? []).toEqual([]);
    });

    it("a line whose stored handling is no longer what today's decision for its own row gives (the correction decision moved after saving) is refused", async () => {
      await bothDecided();
      await decide("correction", "separate_fee", "pass_through", null);
      const id = await save([post({ handling: "pass_through" }), fee("8.00", { engineHandling: "pass_through", lines: [line(REWEIGH, "pass_through", "3.00"), line(CORRECTION, "pass_through", "5.00")] })]);
      expect((await previewOf(id)).ok).toBe(true);
      await decide("correction", "separate_fee", "manual_approval", null); // not a type row: the saved scenario's own snapshot does not notice
      await refused(id);
    });

    it("a postage component whose engine handling is not the type's decision is refused", async () => {
      await bothDecided();
      await decide("correction", "separate_fee", "pass_through", null);
      await refused(await save([post({ engineHandling: "absorbed" }), fee("3.00", { engineHandling: "pass_through", lines: [line(REWEIGH, "pass_through", "3.00")] })]));
    });

    it("lines that all agree with the decisions are shared under their one label: charged to you, or decided case by case", async () => {
      await bothDecided();
      await decide("correction", "separate_fee", "pass_through", null);
      const id = await save([post({ handling: "pass_through", engineHandling: "pass_through" }), fee("8.00", { handling: "pass_through", engineHandling: "pass_through", lines: [line(REWEIGH, "pass_through", "3.00"), line(CORRECTION, "pass_through", "5.00")] })]);
      const pv = await previewOf(id);
      expect(pv.ok).toBe(true);
      expect(pv.payload!.components).toEqual([{ kind: "postage_difference", handling: "pass_through", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13" }, { kind: "separate_fee", handling: "pass_through", amount: "8.00" }]);
      await publish(hf, id, { brand: hA() });
      await decide("reweight", "separate_fee", "manual_approval");
      await decide("correction", "separate_fee", "manual_approval", null);
      const id2 = await save([post({ handling: "pass_through" }), fee("8.00", { engineHandling: "manual_approval", lines: [line(REWEIGH, "manual_approval", "3.00"), line(CORRECTION, "manual_approval", "5.00")] })]);
      const shown = (await previewOf(id2)).payload!.components.find((c) => c.kind === "separate_fee");
      expect(shown).toEqual({ kind: "separate_fee", handling: "manual_approval", amount: "8.00" });
    });

    it("lines that are all absorbed are withheld: the amount appears nowhere a customer can read", async () => {
      await decide("reweight", "postage_difference", "pass_through");
      await decide("reweight", "separate_fee", "absorbed");
      await decide("correction", "separate_fee", "absorbed", null);
      const id = await save([post({ handling: "pass_through" }), fee("8.00", { engineHandling: "absorbed", lines: [line(REWEIGH, "absorbed", "3.00"), line(CORRECTION, "absorbed", "5.00")] })]);
      const pv = await previewOf(id);
      expect(pv.ok).toBe(true);
      expect(pv.hidden).toEqual([{ kind: "separate_fee", reason: "absorbed" }]);
      expect(pv.payload!.components.map((c) => c.kind)).toEqual(["postage_difference"]);
      const ex = await publish(hf, id, { brand: hA() });
      const [row] = await sql<{ t: string }>("select payload::text as t from public.published_adjustment_examples where id = $1", [ex]);
      expect(row!.t).not.toContain("8.00");
      expect(JSON.stringify(await brandExamples(asBrandA(), hA()))).not.toContain("8.00");
    });

    it("a line the example did not price with, a line on the postage component and a line of a rule that is not a fee are an invalid result", async () => {
      await bothDecided();
      await decide("correction", "separate_fee", "pass_through", null);
      // Only the reweigh rule is pinned, but a line names the correction rule.
      await refused(await save([post({ handling: "pass_through" }), fee("5.00", { engineHandling: "pass_through", lines: [line(CORRECTION, "pass_through", "5.00")] })], { ruleVersionIds: [hf.rules.reweigh.versionId] }), "invalid_result");
      await refused(await save([post({ handling: "pass_through", lines: [line(REWEIGH, "pass_through", "3.00")] }), fee("3.00", { handling: "pass_through" })]), "invalid_result");
      const residential = await publishRule(hw, "adjtest.residential_line", "residential", "Residential", "2.00");
      await refused(await save([post({ handling: "pass_through" }), fee("2.00", { engineHandling: "pass_through", lines: [line("adjtest.residential_line", "pass_through", "2.00")] })], { ruleVersionIds: [residential.versionId] }), "invalid_result");
    });

    it("the saved result's engine fields have a shape: bad handling, a lines list that is not a list, too many lines, a line without a key or a decision (PC001)", async () => {
      await bothDecided();
      const bad = (components: Record<string, unknown>[]) => saveScenarioRaw(hf, { brand: hA(), name: "bad shape", result: scenarioResult({ components }) });
      await expectCode(bad([post(), fee("3.00", { engineHandling: "maybe" })]), "PC001", /component_handling/);
      await expectCode(bad([post({ engineHandling: 5 }), fee("3.00", {})]), "PC001", /component_handling/);
      await expectCode(bad([post(), fee("3.00", { lines: "x" })]), "PC001", /component_lines/);
      await expectCode(bad([post(), fee("3.00", { lines: Array.from({ length: 41 }, () => line(REWEIGH, "pass_through", "3.00")) })]), "PC001", /component_lines/);
      await expectCode(bad([post(), fee("3.00", { lines: [{ amount: "3.00", handling: "pass_through" }] })]), "PC001", /component_lines/);
      await expectCode(bad([post(), fee("3.00", { lines: [{ ruleKey: REWEIGH, amount: "3.00" }] })]), "PC001", /component_lines/);
      await expectCode(bad([post(), fee("3.00", { lines: [{ ruleKey: REWEIGH, handling: "mixed" }] })]), "PC001", /component_lines/);
      await expectCode(bad([post(), fee("3.00", { lines: [{ ruleKey: "k".repeat(121), handling: "pass_through" }] })]), "PC001", /component_lines/);
      await expectCode(bad([post(), fee("3.00", { lines: ["x"] })]), "PC001", /component_lines/);
      // The shapes the engine really stores (extra keys, mixed, unconfigured) are accepted.
      await saveScenarioRaw(hf, { brand: hA(), name: "engine shape", ruleVersionIds: pins(), result: scenarioResult({ components: [post({ engineHandling: "unconfigured" }), fee("3.00", { engineHandling: "mixed", lines: [{ ruleKey: REWEIGH, label: "Reweigh fee", category: "reweight", packageIndex: null, amount: "3.00", handling: "unconfigured", method: "flat" }] })] }) });
    });
  });

  // -------------------------------------------------------------------------
  describe("the pricing context beyond the pinned versions: new rules, ZIP lists, exceptions (DB-4, DB-6)", () => {
    const fresh = (name: string, over: Record<string, unknown> = {}) => saveScenario(hf, { brand: hA(), name, ruleVersionIds: [hf.rules.reweigh.versionId], ...over });
    const contextOf = async () => (await sql<{ c: { ruleKeys: string[]; zipListIds: string[] } }>("select app.pricing_context_keys($1, $2, $3, (now() at time zone 'UTC')::date) as c", [hw.t1.id, hA(), hf.cardId]))[0]!.c;
    const storedContext = async (scenario: string) => (await sql<{ c: { ruleKeysInForce: string[]; zipListVersionIds: string[]; source: string } }>("select pricing_context as c from public.adjustment_scenarios where id = $1", [scenario]))[0]!.c;
    const saveWithPins = (extra: Record<string, unknown>) =>
      asUser<{ id: string }>(ha(), "select public.save_adjustment_scenario($1, $2, 'client context', 'reweight', $3::jsonb, $4::jsonb, $5::jsonb, '1.0.0') as id",
        [hw.t1.id, hA(), JSON.stringify(scenarioInput(hf)), JSON.stringify(scenarioResult()), JSON.stringify({ rateCardVersionId: hf.v1, ruleVersionIds: [hf.rules.reweigh.versionId], overrideIds: [], pricedOn: hf.today, ...extra })]).then((r) => r[0]!.id);
    const contextProblem = async (id: string) => (await previewOf(id)).problems.map((p) => p.code);
    afterAll(retireAll);

    it("a rule that did not exist when an example was priced turns it 'under review'; a scenario priced before it cannot be shared; pricing again can", async () => {
      await bothDecided();
      const before = await fresh("priced before the new rule");
      const ex = await publish(hf, await fresh("shared before the new rule"), { brand: hA() });
      expect(await exampleState(ha(), ex)).toEqual({ state: "current", causes: [] });
      const added = await publishRule(hw, "adjtest.new_residential", "residential", "New residential fee", "2.00");
      expect(await exampleState(ha(), ex)).toEqual({ state: "under_review", causes: ["rule_changed"] });
      expect(await mine(ex)).toMatchObject({ state: "under_review", payload: null });
      // The same comparison guards preview and publish: it would be born under review.
      expect(await contextProblem(before)).toEqual(["context_changed"]);
      expect(await refusalHint(publish(hf, before, { brand: hA() }), "P0001", /changed since it was priced/)).toBe("context_changed");
      expect(await liveCopies(before)).toHaveLength(0);
      // Priced again in the new context it is shared and current.
      const again = await fresh("priced after the new rule");
      expect((await storedContext(again)).ruleKeysInForce).toContain("adjtest.new_residential");
      expect((await previewOf(again)).ok).toBe(true);
      const ex2 = await publish(hf, again, { brand: hA() });
      expect(await exampleState(ha(), ex2)).toEqual({ state: "current", causes: [] });
      // A rule that goes away is as much a change: the set of keys in force differs.
      await asUser(ha(), "select public.retire_surcharge_rule_version($1, (current_date - 1))", [added.versionId]);
      expect(await exampleState(ha(), ex2)).toEqual({ state: "under_review", causes: ["rule_changed"] });
      // (An example is current exactly when what is in force is what it was priced with: once the new rule is gone again, the one priced
      // before it is current again, nothing having been edited.)
      expect(await exampleState(ha(), ex)).toEqual({ state: "current", causes: [] });
    });

    it("p_pins without the two optional arrays: the database prices the context itself, at save time, and records that it did", async () => {
      await bothDecided();
      const id = await fresh("server context");
      const ctx = await contextOf();
      expect(await storedContext(id)).toEqual({ ruleKeysInForce: ctx.ruleKeys, zipListVersionIds: ctx.zipListIds, source: "server" });
      expect(ctx.ruleKeys).toEqual(expect.arrayContaining(["adjtest.reweigh_fee", "adjtest.remeasure_fee", "adjtest.correction_fee"]));
      // The keys are the card's carriers' rules in force, whatever the policy says (an absorbed fee rule stays in the set).
      await decide("reweight", "separate_fee", "absorbed");
      expect((await contextOf()).ruleKeys).toContain("adjtest.reweigh_fee");
      await decide("reweight", "separate_fee", "pass_through");
    });

    it("p_pins with ruleKeysInForce and zipListVersionIds: the caller's context is stored as sent (sorted, distinct) and compared; a context that differs from what is in force refuses at once", async () => {
      await bothDecided();
      const ctx = await contextOf();
      const exact = await saveWithPins({ ruleKeysInForce: [...ctx.ruleKeys].reverse().concat(ctx.ruleKeys[0]!), zipListVersionIds: ctx.zipListIds });
      expect(await storedContext(exact)).toEqual({ ruleKeysInForce: ctx.ruleKeys, zipListVersionIds: ctx.zipListIds, source: "client" });
      expect((await previewOf(exact)).ok).toBe(true);
      // One key missing, or one key that is not in force: what was priced with is not what is in force.
      const fewer = await saveWithPins({ ruleKeysInForce: ctx.ruleKeys.slice(1), zipListVersionIds: ctx.zipListIds });
      expect(await contextProblem(fewer)).toEqual(["context_changed"]);
      const extra = await saveWithPins({ ruleKeysInForce: [...ctx.ruleKeys, "adjtest.never_existed"], zipListVersionIds: ctx.zipListIds });
      expect(await contextProblem(extra)).toEqual(["context_changed"]);
      // Only one of the two given: the other is the database's own (recorded as 'mixed').
      const half = await saveWithPins({ ruleKeysInForce: ctx.ruleKeys });
      expect(await storedContext(half)).toEqual({ ruleKeysInForce: ctx.ruleKeys, zipListVersionIds: ctx.zipListIds, source: "mixed" });
      expect((await previewOf(half)).ok).toBe(true);
      const none = await saveWithPins({ ruleKeysInForce: [] });
      expect((await storedContext(none)).ruleKeysInForce).toEqual([]);
      expect(await contextProblem(none)).toEqual(["context_changed"]);
    });

    it("rejects malformed context arrays: wrong types, too many, empty or over-long keys, unknown or foreign ZIP list versions", async () => {
      const ctx = await contextOf();
      for (const [label, extra] of [
        ["keys not a list", { ruleKeysInForce: "adjtest.x" }], ["keys null", { ruleKeysInForce: null }], ["a non-string key", { ruleKeysInForce: [5] }], ["an empty key", { ruleKeysInForce: [""] }],
        ["an over-long key", { ruleKeysInForce: ["k".repeat(121)] }], ["501 keys", { ruleKeysInForce: Array.from({ length: 501 }, (_, i) => `k${i}`) }],
        ["zip ids not a list", { zipListVersionIds: "x" }], ["a zip id that is not a uuid", { zipListVersionIds: ["nope"] }], ["a zip id that is a number", { zipListVersionIds: [5] }], ["201 zip ids", { zipListVersionIds: Array.from({ length: 201 }, () => "00000000-0000-4000-8000-000000000001") }],
      ] as [string, Record<string, unknown>][]) await expectCode(saveWithPins({ ruleKeysInForce: ctx.ruleKeys, ...extra }), ["PC001", "P0002"], /invalid pins|not found/).catch((e) => { throw new Error(`${label}: ${e.message}`); });
      await expectCode(saveWithPins({ zipListVersionIds: ["00000000-0000-4000-8000-000000000001"] }), "P0002", /not found/);
      // Another account's ZIP list version cannot be cited.
      const [foreign] = await asUser<{ id: string }>(hw.t2.admin.id, "insert into public.zip_lists (tenant_id, carrier_code, key, name, source_reference, verification_status, effective_date) values ($1, 'ups', 'adjtest.foreign', 'Foreign', 'x', 'approved_3pl_config', '2026-01-01') returning id", [hw.t2.id]);
      await expectCode(saveWithPins({ zipListVersionIds: [foreign!.id] }), "P0002", /not found/);
    });

    it("a ZIP list that is republished after an example was priced turns it 'under review' (zip_list_changed), and a scenario priced before cannot be shared", async () => {
      await bothDecided();
      const today = await utcDay();
      const publishList = async (version: number, effective: string) => {
        const [l] = await asUser<{ id: string }>(ha(), "insert into public.zip_lists (tenant_id, carrier_code, key, name, version, source_reference, verification_status, effective_date) values ($1, 'ups', 'adjtest.zl', 'Delivery area ZIPs', $2, 'x', 'approved_3pl_config', $3) returning id", [hw.t1.id, version, effective]);
        await asUser(ha(), "insert into public.zip_list_entries (list_id, entry) values ($1, '90001')", [l!.id]);
        await asUser(ha(), "select public.publish_zip_list($1)", [l!.id]);
        return l!.id;
      };
      const v1 = await publishList(1, "2026-01-01");
      const [rule] = await asUser<{ id: string }>(ha(), "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'adjtest.das_zip', 'residential', 'Delivery area surcharge') returning id", [hw.t1.id]);
      const [rv] = await asUser<{ id: string }>(ha(), "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, conditions, effective_date, source_reference, verification_status) values ($1, $2, 1, 'definite', 'flat', 2.50, $3::jsonb, '2026-01-01', 'x', 'approved_3pl_config') returning id", [rule!.id, hw.t1.id, JSON.stringify([{ type: "destination_zip_in_list", listKey: "adjtest.zl" }])]);
      await asUser(ha(), "select public.publish_surcharge_rule_version($1)", [rv!.id]);
      const pinsWithRule = { ruleVersionIds: [hf.rules.reweigh.versionId, rv!.id] };
      const before = await fresh("priced with ZIP list v1", pinsWithRule);
      expect((await storedContext(before)).zipListVersionIds).toEqual([v1]);
      const ex = await publish(hf, await fresh("shared with ZIP list v1", pinsWithRule), { brand: hA() });
      expect(await exampleState(ha(), ex)).toEqual({ state: "current", causes: [] });
      // Republish: version 1 ends yesterday, version 2 starts today.
      await asOwnerWithoutTriggers("update public.zip_lists set status = 'retired', expiration_date = (now() at time zone 'UTC')::date - 1 where id = $1", [v1]);
      const v2 = await publishList(2, today);
      expect(await exampleState(ha(), ex)).toEqual({ state: "under_review", causes: ["zip_list_changed"] });
      expect(await mine(ex)).toMatchObject({ state: "under_review", payload: null });
      expect(await contextProblem(before)).toEqual(["context_changed"]);
      const again = await fresh("priced with ZIP list v2", pinsWithRule);
      expect((await storedContext(again)).zipListVersionIds).toEqual([v2]);
      expect((await previewOf(again)).ok).toBe(true);
    });

    it("a customer exception, a changed rule version or a changed assignment between saving and sharing makes the example refuse to be shared (it would be born under review)", async () => {
      await bothDecided();
      // An exception on a pinned rule.
      const a = await fresh("exception between save and share");
      const [o] = await asUser<{ id: string }>(ha(), "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, amount, effective_date) values ($1, $2, $3, 'override_amount', 1.00, current_date) returning id", [hw.t1.id, hA(), hf.rules.reweigh.ruleId]);
      expect(await contextProblem(a)).toEqual(["context_changed"]);
      expect(await refusalHint(publish(hf, a, { brand: hA() }), "P0001")).toBe("context_changed");
      expect(await liveCopies(a)).toHaveLength(0);
      await asUser(ha(), "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [o!.id]);
      expect((await previewOf(a)).ok).toBe(true);
      // A pinned rule version replaced by a newer one.
      const rule = await publishRule(hw, "adjtest.ctx_rule", "reweight", "Context rule", "3.00");
      const b = await fresh("rule replaced between save and share", { ruleVersionIds: [rule.versionId] });
      await asUser(ha(), "select public.retire_surcharge_rule_version($1, (current_date - 1))", [rule.versionId]);
      await publishRule(hw, "adjtest.ctx_rule", "reweight", "Context rule", "3.50", { ruleId: rule.ruleId, version: 2, effective: hf.today });
      expect((await contextProblem(b)).sort()).toEqual(["context_changed", "ended"]); // (and the version it pinned has ended)
      // The customer's allowed services change.
      const c = await fresh("assignment between save and share");
      const [assignment] = await sql<{ id: string }>("select id from public.brand_rate_card_assignments where brand_id = $1 and rate_card_id = $2 and unassigned_at is null", [hA(), hf.cardId]);
      await asUser(ha(), "update public.brand_rate_card_assignments set allowed_service_ids = $2 where id = $1", [assignment!.id, [hf.uspsGa]]);
      expect((await contextProblem(c)).sort()).toEqual(["context_changed", "rate_card_not_assigned"]);
      await asUser(ha(), "update public.brand_rate_card_assignments set allowed_service_ids = null where id = $1", [assignment!.id]);
      expect((await previewOf(c)).ok).toBe(true); // everything is as it was when c was priced
    });
  });

  // -------------------------------------------------------------------------
  describe("decision dates (DB-10)", () => {
    const cell = (brand: string | null = hw.brandB.id) => ({ type: "combined", component: "postage_difference", brand });
    const rows = async () => sql<{ id: string; valid_from: string; valid_to: string | null; handling: string }>("select id, valid_from::text, valid_to::text, handling from public.adjustment_policies where tenant_id = $1 and brand_id = $2 and adjustment_type = 'combined' and component = 'postage_difference' order by valid_from", [hw.t1.id, hw.brandB.id]);
    const handlingOn = async (offset: number) => (await sql<{ h: string }>("select app.adjustment_handling($1, $2, 'combined', 'postage_difference', (now() at time zone 'UTC')::date + $3::int) as h", [hw.t1.id, hw.brandB.id, offset]))[0]!.h;

    it("a decision starts today or up to a year ahead; infinity and anything beyond are refused, so no cell can be blocked for good", async () => {
      const c = cell();
      for (const bad of ["infinity", "-infinity", await utcDay(367), await utcDay(-1), await utcDay(5000)]) {
        await expectCode(decide(c.type, c.component, "absorbed", c.brand).then(() => setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "absorbed", bad)), "PC001", /today up to a year ahead/);
      }
      const top = await setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "pass_through", await utcDay(366));
      expect(top).toMatch(/^[0-9a-f-]{36}$/);
      await asUser(ha(), "select public.end_adjustment_policy($1)", [top]); // not started: voided
      expect(await sql("select 1 from public.adjustment_policies where id = $1", [top])).toHaveLength(0);
    });

    it("a decision scheduled for later can be voided: its row goes, the decision it was to replace carries on, and the audit says so", async () => {
      const c = cell();
      const a = (await rows())[0]!.id; // today's decision from the test above (absorbed)
      const day30 = await utcDay(30);
      const b = await setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "pass_through", day30);
      expect((await rows()).map((r) => [r.valid_from, r.valid_to, r.handling])).toEqual([[await utcDay(), await utcDay(29), "absorbed"], [day30, null, "pass_through"]]);
      expect(await handlingOn(30)).toBe("pass_through");
      // A scheduled row blocks a new decision for today until it is voided.
      await expectCode(setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "manual_approval", await utcDay(10)), "P0007", /overlaps/);
      const auditBefore = (await sql("select 1 from public.audit_events where action = 'adjustment.policy_ended' and tenant_id = $1", [hw.t1.id])).length;
      await expectCode(asUser(hw.t1.employee.id, "select public.end_adjustment_policy($1)", [b]), "P0002", /not found/);
      await asUser(ha(), "select public.end_adjustment_policy($1)", [b]);
      expect((await rows()).map((r) => [r.id, r.valid_from, r.valid_to, r.handling])).toEqual([[a, await utcDay(), null, "absorbed"]]);
      expect(await handlingOn(30)).toBe("absorbed"); // the earlier decision runs on
      const [voided] = await sql<{ metadata: Record<string, unknown>; actor_id: string }>("select metadata, actor_id from public.audit_events where action = 'adjustment.policy_ended' and entity_id = $1", [b]);
      expect(voided).toMatchObject({ actor_id: ha(), metadata: { voided: true, adjustment_type: "combined", component: "postage_difference" } });
      expect((await sql("select 1 from public.audit_events where action = 'adjustment.policy_ended' and tenant_id = $1", [hw.t1.id])).length).toBe(auditBefore + 1);
      // The same cell can be decided today again.
      expect(await setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "manual_approval")).toBe(a);
    });

    it("voiding runs the earlier decision up to the NEXT scheduled one, not through it; a scheduled row given a last day is shortened, not voided; a row that started is ended, never deleted", async () => {
      const c = cell();
      const a = (await rows())[0]!.id;
      const b = await setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "pass_through", await utcDay(10));
      const d = await setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "absorbed", await utcDay(20));
      await asUser(ha(), "select public.end_adjustment_policy($1, $2)", [b, await utcDay(14)]); // shortened: b runs +10..+14
      expect((await rows()).find((r) => r.id === b)).toMatchObject({ valid_to: await utcDay(14) });
      // Void b: a runs until the day before d starts.
      await asUser(ha(), "select public.end_adjustment_policy($1)", [b]);
      expect((await rows()).map((r) => [r.id, r.valid_to])).toEqual([[a, await utcDay(19)], [d, null]]);
      await asUser(ha(), "select public.end_adjustment_policy($1)", [d]);
      expect((await rows()).map((r) => [r.id, r.valid_to])).toEqual([[a, null]]);
      // A row that has started is ended (the last day defaults to yesterday, or today when it began today), never deleted.
      await asUser(ha(), "select public.end_adjustment_policy($1)", [a]);
      expect((await rows()).map((r) => [r.id, r.valid_to])).toEqual([[a, await utcDay()]]);
      await expectCode(asOwnerWithGuardOpen("delete from public.adjustment_policies where id = $1", [a]), "42501", /offboarding functions/);
      // ... and a scheduled row cannot be deleted directly either (only end_adjustment_policy voids it, through the guard's one exception).
      const later = await setPolicy(ha(), hw.t1.id, c.brand, c.type, c.component, "pass_through", await utcDay(40));
      await expectDenied(asUser(ha(), "delete from public.adjustment_policies where id = $1", [later]), /permission denied/);
      await asUser(ha(), "select public.end_adjustment_policy($1)", [later]);
    });

    it("the same decision, still open, is a no-op: no new row, no change, no audit row, however old it is (DB-14: N24)", async () => {
      const brand = hw.brandB.id;
      // An open decision that began ten days ago (written by the owner with the guard open: time cannot be moved otherwise).
      await asOwnerWithGuardOpen("insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from) values ($1, $2, 'remeasure', 'postage_difference', 'pass_through', (now() at time zone 'UTC')::date - 10)", [hw.t1.id, brand]);
      const [old] = await sql<{ id: string }>("select id from public.adjustment_policies where tenant_id = $1 and brand_id = $2 and adjustment_type = 'remeasure' and component = 'postage_difference'", [hw.t1.id, brand]);
      const auditRows = async () => (await sql("select 1 from public.audit_events where tenant_id = $1 and entity_id = $2", [hw.t1.id, old!.id])).length;
      const before = await auditRows();
      expect(await setPolicy(ha(), hw.t1.id, brand, "remeasure", "postage_difference", "pass_through")).toBe(old!.id);
      expect((await sql("select 1 from public.adjustment_policies where tenant_id = $1 and brand_id = $2 and adjustment_type = 'remeasure' and component = 'postage_difference'", [hw.t1.id, brand]))).toHaveLength(1);
      expect(await auditRows()).toBe(before);
      expect(await sql("select valid_to from public.adjustment_policies where id = $1", [old!.id])).toEqual([{ valid_to: null }]);
      // A different decision closes the old row yesterday and opens a new one today.
      const next = await setPolicy(ha(), hw.t1.id, brand, "remeasure", "postage_difference", "absorbed");
      expect(next).not.toBe(old!.id);
      expect(await sql<{ valid_to: string }>("select valid_to::text from public.adjustment_policies where id = $1", [old!.id])).toEqual([{ valid_to: await utcDay(-1) }]);
    });
  });

  // -------------------------------------------------------------------------
  describe("what a customer reads while an example is under review or expired (DB-11, DB-12, DB-14)", () => {
    const publishReal = async (name: string) => {
      await bothDecided();
      return publish(hf, await saveScenario(hf, { brand: hA(), name, ruleVersionIds: [hf.rules.reweigh.versionId] }), { brand: hA(), title: "Real title with $5.30 in it", note: "Real note: this adds about $5.30" });
    };
    const setValidThrough = (id: string, expr: string) => asOwnerWithoutTriggers(`update public.published_adjustment_examples set valid_through = ${expr} where id = $1`, [id]);
    afterAll(retireAll);

    it("title and note are returned only while the example is current; under review and expired give a neutral title, no note, no payload (DB-11)", async () => {
      const ex = await publishReal("projection");
      expect(await mine(ex)).toMatchObject({ state: "current", title: "Real title with $5.30 in it", note: "Real note: this adds about $5.30" });
      await decide("reweight", "separate_fee", "absorbed");
      const review = await mine(ex);
      expect(review).toMatchObject({ state: "under_review", title: "Example", note: null, payload: null });
      expect(JSON.stringify(review)).not.toMatch(/5\.30|Real/);
      expect(JSON.stringify(await brandExamples(hw.t1.employee.id, hA()))).not.toMatch(/5\.30|Real/); // the staff-visible projection is the customer's
      await decide("reweight", "separate_fee", "pass_through");
      expect(await mine(ex)).toMatchObject({ state: "current", title: "Real title with $5.30 in it" });
      await setValidThrough(ex, "(now() at time zone 'UTC')::date - 1");
      const expired = await mine(ex);
      expect(expired).toMatchObject({ state: "expired", title: "Example", note: null, payload: null });
      expect(JSON.stringify(expired)).not.toMatch(/5\.30|Real/);
    });

    it("valid through is inclusive: an example is current on its last day and expired the day after (DB-14: P03)", async () => {
      const ex = await publishReal("boundary");
      await setValidThrough(ex, "(now() at time zone 'UTC')::date");
      expect(await exampleState(ha(), ex)).toEqual({ state: "current", causes: [] });
      expect(await mine(ex)).toMatchObject({ state: "current" });
      await setValidThrough(ex, "(now() at time zone 'UTC')::date - 1");
      expect(await exampleState(ha(), ex)).toEqual({ state: "expired", causes: ["valid_through_passed"] });
      await setValidThrough(ex, "(now() at time zone 'UTC')::date + 1");
      expect(await exampleState(ha(), ex)).toEqual({ state: "current", causes: [] });
    });

    it("dates follow UTC, not the zone a client asks for (Prefer: timezone): the expiry edge, 'starts today' and the default of a decision (DB-12)", async () => {
      const ex = await publishReal("time zones");
      const [{ zone }] = (await sql<{ zone: string }>("select case when (now() at time zone 'Pacific/Kiritimati')::date <> (now() at time zone 'UTC')::date then 'Pacific/Kiritimati' else 'Etc/GMT+12' end as zone")) as [{ zone: string }];
      const inZone = (userId: string, tz: string, text: string, params: unknown[] = []) => withTx(userId, async (q) => { await q(`set local time zone '${tz}'`); return (await q(text, params)).rows; });
      // Valid through today (UTC): current in every zone. Yesterday: expired in every zone.
      for (const [expr, expected] of [["(now() at time zone 'UTC')::date", "current"], ["(now() at time zone 'UTC')::date - 1", "expired"]] as const) {
        await setValidThrough(ex, expr);
        for (const tz of ["UTC", zone, "Pacific/Kiritimati", "Etc/GMT+12", "America/Los_Angeles"]) {
          const [r] = (await inZone(asBrandA(), tz, "select public.brand_adjustment_examples($1) as r", [hA()])) as { r: { id: string; state: string }[] }[];
          expect(r!.r.find((e) => e.id === ex)?.state, `${expr} in ${tz}`).toBe(expected);
          const [st] = (await inZone(ha(), tz, "select public.adjustment_example_state($1) as r", [ex])) as { r: { state: string } }[];
          expect(st!.r.state, `state in ${tz}`).toBe(expected);
        }
      }
      // A decision with no date starts today in UTC, in whatever zone the caller is; a date one day before UTC today is refused in every zone.
      const brand = hw.brandB.id;
      await inZone(ha(), zone, "select public.set_adjustment_policy($1, $2, 'combined', 'separate_fee', 'pass_through')", [hw.t1.id, brand]);
      expect(await sql("select valid_from::text as d from public.adjustment_policies where tenant_id = $1 and brand_id = $2 and adjustment_type = 'combined' and component = 'separate_fee'", [hw.t1.id, brand])).toEqual([{ d: await utcDay() }]);
      await expectCode(inZone(ha(), zone, "select public.set_adjustment_policy($1, $2, 'combined', 'separate_fee', 'absorbed', $3::date)", [hw.t1.id, brand, await utcDay(-1)]), "PC001", /today up to a year ahead/);
    });

    it("no function the migrations create reads the session's date: current_date and its relatives appear in none of them", async () => {
      const text = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261015000007_adjustments.sql"), "utf8");
      const names = [...new Set([...text.matchAll(/create (?:or replace )?function (?:public|app)\.(\w+)/gi)].map((m) => m[1]!))];
      expect(names.length).toBeGreaterThan(60);
      const offenders = await sql<{ n: string }>(
        "select p.pronamespace::regnamespace::text || '.' || p.proname as n from pg_proc p where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace) and p.proname = any ($1) and p.prosrc ~* '\\m(current_date|current_timestamp|localtimestamp|localtime|transaction_timestamp|statement_timestamp|clock_timestamp|timeofday)\\M' order by 1", [names]);
      expect(offenders.map((o) => o.n)).toEqual([]);
    });

    it("examples come back newest first, then by id (DB-14: P08)", async () => {
      await bothDecided();
      const first = await publish(hf, await saveScenario(hf, { brand: hA(), name: "older", ruleVersionIds: [hf.rules.reweigh.versionId] }), { brand: hA(), title: "Older" });
      const second = await publish(hf, await saveScenario(hf, { brand: hA(), name: "newer", ruleVersionIds: [hf.rules.reweigh.versionId] }), { brand: hA(), title: "Newer" });
      const ids = (await brandExamples(asBrandA(), hA())).map((e) => e.id);
      expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
      expect(ids.indexOf(second)).toBeGreaterThanOrEqual(0);
      const states = await asUser<{ r: { id: string }[] }>(ha(), "select public.adjustment_example_states($1) as r", [hw.t1.id]);
      const stateIds = states[0]!.r.map((e) => e.id);
      expect(stateIds.indexOf(second)).toBeLessThan(stateIds.indexOf(first));
    });
  });

  // -------------------------------------------------------------------------
  describe("the mutation survivors of DB-14", () => {
    it("publishing waits for a policy change that is being made at the same moment, and then refuses (the tenant lock): a publish that ignored the lock would succeed (M27)", async () => {
      await bothDecided();
      const id = await saveScenario(hf, { brand: hA(), name: "race with a decision", ruleVersionIds: [hf.rules.reweigh.versionId] });
      let publishing: Promise<string> | undefined;
      let settled = false;
      await withTx(ha(), async (q) => {
        // Connection A changes the decision and has not committed; B is asked to publish an example priced under the old decision.
        await q("select public.set_adjustment_policy($1, $2, 'reweight', 'separate_fee', 'absorbed')", [hw.t1.id, hA()]);
        publishing = publish(hf, id, { brand: hA() }).then((v) => `published ${v}`, (e: { code?: string; hint?: string }) => `${e.code} ${e.hint}`);
        void publishing.then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 500));
        expect(settled, "the publish is waiting for the other connection").toBe(false);
      });
      expect(await publishing).toBe("P0001 policy_changed");
      expect(await liveCopies(id)).toHaveLength(0);
      await decide("reweight", "separate_fee", "pass_through");
    });

    it("a suspended customer cannot be shared with; the refusal names the customer, and nothing is stored (N02)", async () => {
      await bothDecided();
      const id = await saveScenario(hf, { brand: hA(), name: "suspended customer", ruleVersionIds: [hf.rules.reweigh.versionId] });
      await asUser(ha(), "update public.brands set status = 'suspended' where id = $1", [hA()]);
      try {
        const pv = await previewOf(id);
        expect(pv.ok).toBe(false);
        expect(pv.problems.map((p) => p.code)).toContain("customer_inactive");
        expect(await refusalHint(publish(hf, id, { brand: hA() }), "P0001", /not active/)).toBe("customer_inactive");
        expect(await liveCopies(id)).toHaveLength(0);
      } finally {
        await asUser(ha(), "update public.brands set status = 'active' where id = $1", [hA()]);
      }
      expect((await previewOf(id)).ok).toBe(true);
    });

    it("offboarding removes the raw history files too, attached or not, and leaves other purposes alone (N21)", async () => {
      const owner = await createUser("purge-files-owner");
      const tenant = await createTenant(owner, "Purge Files Freight");
      const bytes = Buffer.from("ship_date,carrier,package_ref\n2026-01-05,ups,1Z1\n");
      const insertFile = (purpose: string) => asUser<{ id: string }>(owner.id, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, 'h.csv', 'text/csv', $3, decode($4, 'hex'), $5) returning id", [tenant, purpose, bytes.length, sha256Hex(bytes), bytes]).then((r) => r[0]!.id);
      const orphan = await insertFile("adjustment_import");
      const attached = await insertFile("adjustment_import");
      const other = await insertFile("rate_card");
      await asUser(owner.id, "select public.create_adjustment_import($1, 'attached', $2::jsonb)", [attached, JSON.stringify({ headers: ["ship_date", "carrier", "package_ref"] })]);
      const purged = (await sql<{ r: Record<string, number> }>("select app.purge_tenant_adjustment_data($1) as r", [tenant]))[0]!.r;
      expect(purged).toMatchObject({ files: 2, imports: 1 });
      expect(await sql("select id from public.uploaded_files where id = any ($1)", [[orphan, attached]])).toHaveLength(0);
      expect(await sql("select id from public.uploaded_files where id = $1", [other])).toHaveLength(1);
    });

    it("an adjustment record is never edited, whatever opens the guard (N33); only the owner's direct statement without the signal is refused for another reason", async () => {
      const [imp] = await sql<{ id: string }>("insert into public.adjustment_imports (tenant_id, name, status, accepted_count, committed_count, attested_by, attested_at) values ($1, 'immutable', 'committed', 1, 1, $2, now()) returning id", [hw.t1.id, ha()]);
      const [rec] = await sql<{ id: string }>("insert into public.adjustment_records (tenant_id, import_id, row_no, ship_date, carrier_code, adjustment_type, cause, declared_weight_basis) values ($1, $2, 1, '2026-01-05', 'ups', 'reweight', 'other', 'missing') returning id", [hw.t1.id, imp!.id]);
      await expectCode(asOwnerWithGuardOpen("update public.adjustment_records set ship_date = ship_date + 1 where id = $1", [rec!.id]), "42501", /never edited/);
      await expectCode(asOwnerWithGuardOpen("update public.adjustment_records set cause = 'scale_error' where id = $1", [rec!.id]), "42501", /never edited/);
      await expectCode(sql("update public.adjustment_records set cause = 'scale_error' where id = $1", [rec!.id]), "42501", /only through its functions/);
      expect(await sql("select cause, ship_date::text as d from public.adjustment_records where id = $1", [rec!.id])).toEqual([{ cause: "other", d: "2026-01-05" }]);
    });

    it("an adjustment file with a customer attached is not readable by the account's administrators (the null-brand branch of the read policy) (N17)", async () => {
      const bytes = Buffer.from("ship_date,carrier\n2026-01-05,ups\n");
      const [file] = (await asOwnerWithoutTriggers("insert into public.uploaded_files (tenant_id, brand_id, uploaded_by, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, $3, 'adjustment_import', 'branded.csv', 'text/csv', $4, decode($5, 'hex'), $6) returning id", [hw.t1.id, hA(), ha(), bytes.length, sha256Hex(bytes), bytes])) as { id: string }[];
      for (const user of [hw.t1.admin, hw.t1.employee, hw.brandA.admin, hw.platformAdmin]) expect(await asUser(user.id, "select id from public.uploaded_files where id = $1", [file!.id]), user.email).toHaveLength(0);
      const [plain] = (await asOwnerWithoutTriggers("insert into public.uploaded_files (tenant_id, uploaded_by, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, 'adjustment_import', 'plain.csv', 'text/csv', $3, decode($4, 'hex'), $5) returning id", [hw.t1.id, ha(), bytes.length, sha256Hex(bytes), bytes])) as { id: string }[];
      expect(await asUser(ha(), "select id from public.uploaded_files where id = $1", [plain!.id])).toHaveLength(1);
      await sql("delete from public.uploaded_files where id = any ($1)", [[file!.id, plain!.id]]);
    });

    it("an administrator cannot register an adjustment file under a customer: the insert policy demands no customer (N17)", async () => {
      const bytes = Buffer.from("ship_date,carrier\n2026-01-05,ups\n");
      // No RETURNING: the read policy would also refuse a file that has a customer, which would hide a hole in the insert policy.
      const insert = (userId: string, brand: string | null) => asUser(userId, "insert into public.uploaded_files (tenant_id, brand_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, $2, 'adjustment_import', 'n17.csv', 'text/csv', $3, decode($4, 'hex'), $5)", [hw.t1.id, brand, bytes.length, sha256Hex(bytes), bytes]);
      try {
        await expectDenied(insert(ha(), hA()), /row-level security/);
        expect(await sql("select 1 from public.uploaded_files where filename = 'n17.csv'")).toHaveLength(0);
        await insert(ha(), null);
        expect(await sql("select 1 from public.uploaded_files where filename = 'n17.csv' and brand_id is null")).toHaveLength(1);
      } finally {
        await sql("delete from public.uploaded_files where filename = 'n17.csv'");
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("a reweigh, remeasure or correction fee that is not a conditional charge cannot be published; legacy ones are listed (F11)", () => {
    const legacyVersion = async (key: string, category: string, charge: string, status: "draft" | "published", extra: { expiration?: string | null; archived?: boolean; tenant?: string; version?: number } = {}) => {
      const tenant = extra.tenant ?? hw.t1.id;
      const [r] = await sql<{ id: string }>("insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', $2, $3, $4) returning id", [tenant, key, category, `Legacy ${key}`]);
      const [v] = (await asOwnerWithoutTriggers(
        `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, status, charge_class, method, amount, effective_date, expiration_date, source_reference, verification_status, published_at)
         values ($1, $2, $3, $4, $5, 'flat', 3, '2026-01-01', $6, 'x', 'approved_3pl_config', ${status === "published" ? "now()" : "null"}) returning id`, [r!.id, tenant, extra.version ?? 1, status, charge, extra.expiration ?? null])) as { id: string }[];
      if (extra.archived) await sql("update public.surcharge_rules set archived_at = now() where id = $1", [r!.id]);
      return { rule: r!.id, version: v!.id };
    };
    const listed = async (userId: string, tenant = hw.t1.id) => (await asUser<{ r: { ruleName: string; versionNumber: number }[] }>(userId, "select public.adjustment_legacy_fee_rules($1) as r", [tenant]))[0]!.r;

    it("a draft of such a rule with another class is refused at publication (23514); made conditional it publishes; other categories are unaffected", async () => {
      for (const category of ["reweight", "remeasure", "shipping_charge_correction"]) {
        for (const cls of ["definite", "estimated"]) {
          const v = await legacyVersion(`adjtest.legacy_draft_${category}_${cls}`, category, cls, "draft");
          await expectCode(asUser(ha(), "select public.publish_surcharge_rule_version($1)", [v.version]), "23514", /conditional charge/);
          expect(await sql("select status, charge_class from public.surcharge_rule_versions where id = $1", [v.version])).toEqual([{ status: "draft", charge_class: cls }]);
          await asUser(ha(), "update public.surcharge_rule_versions set charge_class = 'conditional' where id = $1", [v.version]);
          await asUser(ha(), "select public.publish_surcharge_rule_version($1)", [v.version]);
          expect(await sql("select status, charge_class from public.surcharge_rule_versions where id = $1", [v.version])).toEqual([{ status: "published", charge_class: "conditional" }]);
        }
      }
      const other = await legacyVersion("adjtest.legacy_draft_residential", "residential", "definite", "draft");
      await asUser(ha(), "select public.publish_surcharge_rule_version($1)", [other.version]);
      expect(await sql("select status from public.surcharge_rule_versions where id = $1", [other.version])).toEqual([{ status: "published" }]);
    });

    it("lists the published versions that still count as definite or estimated: staff of the account only, with the rule name and version number", async () => {
      expect(await listed(ha())).toEqual([]);
      const a = await legacyVersion("adjtest.legacy_published_a", "reweight", "definite", "published");
      await legacyVersion("adjtest.legacy_published_b", "shipping_charge_correction", "estimated", "published", { version: 2 });
      await legacyVersion("adjtest.legacy_residential", "residential", "definite", "published"); // another category: never listed
      await legacyVersion("adjtest.legacy_ok", "remeasure", "conditional", "published"); // already conditional
      await legacyVersion("adjtest.legacy_draft", "remeasure", "definite", "draft"); // not in force
      await legacyVersion("adjtest.legacy_expired", "reweight", "definite", "published", { expiration: "2026-02-01" }); // ended
      await legacyVersion("adjtest.legacy_archived", "reweight", "definite", "published", { archived: true }); // archived rule
      await legacyVersion("adjtest.legacy_other_tenant", "reweight", "definite", "published", { tenant: hw.t2.id });
      expect(await listed(ha())).toEqual([{ ruleName: "Legacy adjtest.legacy_published_a", versionNumber: 1 }, { ruleName: "Legacy adjtest.legacy_published_b", versionNumber: 2 }]);
      expect(await listed(hw.t2.admin.id, hw.t2.id)).toEqual([{ ruleName: "Legacy adjtest.legacy_other_tenant", versionNumber: 1 }]); // each account sees its own
      // Retiring it takes it off the list.
      await asOwnerWithoutTriggers("update public.surcharge_rule_versions set status = 'retired', expiration_date = (now() at time zone 'UTC')::date - 1 where id = $1", [a.version]);
      expect((await listed(ha())).map((x) => x.versionNumber)).toEqual([2]);
      for (const user of [hw.t1.employee, hw.brandA.admin, hw.brandB.admin, hw.t2.admin, hw.outsider, hw.platformAdmin]) await expectCode(asUser(user.id, "select public.adjustment_legacy_fee_rules($1)", [hw.t1.id]), "42501", /not allowed/);
      await expectCode(asUser(null, "select public.adjustment_legacy_fee_rules($1)", [hw.t1.id]), "42501", /permission denied/);
      expect(Object.keys((await listed(ha()))[0]!).sort()).toEqual(["ruleName", "versionNumber"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("the rate-card term sources follow a deleted draft term (DB-3)", () => {
    it("a draft term that has a source row can be deleted: the source goes with it; an active version's sources are still frozen", async () => {
      const [v2] = await asUser<{ id: string }>(ha(), "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 2) returning id", [hf.cardId, hw.t1.id]);
      const makeTerm = async (service: string) => {
        const [t] = await asUser<{ id: string }>(ha(), "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139) returning id", [v2!.id, service]);
        await asUser(ha(), "insert into public.rate_card_service_term_sources (term_id, tenant_id, source_reference) values ($1, $2, 'draft source')", [t!.id, hw.t1.id]);
        return t!.id;
      };
      // Control: no source row.
      const [bare] = await asUser<{ id: string }>(ha(), "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139) returning id", [v2!.id, hf.uspsGa]);
      await asUser(ha(), "delete from public.rate_card_service_terms where id = $1", [bare!.id]);
      const term = await makeTerm(hf.upsGround);
      await asUser(ha(), "delete from public.rate_card_service_terms where id = $1", [term]);
      expect(await sql("select 1 from public.rate_card_service_term_sources where term_id = $1", [term])).toHaveLength(0);
      // The source of an ACTIVE version's term is frozen, and deleting it directly is refused with the same reason as before.
      const [active] = await sql<{ id: string }>("select id from public.rate_card_service_terms where version_id = $1", [hf.v1]);
      await expectDenied(asUser(ha(), "delete from public.rate_card_service_term_sources where term_id = $1", [active!.id]), /not a draft/);
      // A source of a draft term can still be deleted directly (the term stays).
      const [v3] = await asUser<{ id: string }>(ha(), "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 3) returning id", [hf.cardId, hw.t1.id]);
      const [t3] = await asUser<{ id: string }>(ha(), "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139) returning id", [v3!.id, hf.upsGround]);
      await asUser(ha(), "insert into public.rate_card_service_term_sources (term_id, tenant_id, source_reference) values ($1, $2, 'x')", [t3!.id, hw.t1.id]);
      await asUser(ha(), "delete from public.rate_card_service_term_sources where term_id = $1", [t3!.id]);
      expect(await sql("select 1 from public.rate_card_service_terms where id = $1", [t3!.id])).toHaveLength(1);
    });
  });
});

// Last on purpose: it fills customer A's 25 slots.
describe("the 25 live examples per customer cap", () => {
  it("the 26th live example is refused; stopping one frees a slot; re-sharing the same source does not use one", async () => {
    const live = async () => Number((await sql<{ n: string }>("select count(*)::text as n from public.published_adjustment_examples where brand_id = $1 and retired_at is null", [w.brandA.id]))[0]!.n);
    await setPolicy(admin(), w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through").catch(() => undefined);
    const activeVersion = (await sql<{ id: string }>("select id from public.rate_card_versions where rate_card_id = $1 and status = 'active' and effective_date <= current_date and (expiration_date is null or expiration_date >= current_date)", [f.cardId]))[0]!.id;
    const rule = (await sql<{ id: string }>("select v.id from public.surcharge_rule_versions v join public.surcharge_rules r on r.id = v.rule_id where r.tenant_id = $1 and r.rule_key = 'adjtest.reweigh_fee' and v.status = 'published'", [w.t1.id]))[0]!.id;
    const newOne = async (i: number) => publish(f, await saveScenario(f, { name: `Cap ${i}`, versionId: activeVersion, ruleVersionIds: [rule] }), { title: `Cap example ${i}` });
    let i = 0;
    while ((await live()) < 25) await newOne(i++);
    expect(await live()).toBe(25);
    const extra = await saveScenario(f, { name: "Cap overflow", versionId: activeVersion, ruleVersionIds: [rule] });
    await expectCode(publish(f, extra), "P0001", /limit of 25 shared examples/);
    expect(await brandExamples(w.brandA.admin.id, w.brandA.id)).toHaveLength(25);
    const [one] = await sql<{ id: string; source_scenario_id: string }>("select id, source_scenario_id from public.published_adjustment_examples where brand_id = $1 and retired_at is null and pins ->> 'rateCardVersionId' = $2 limit 1", [w.brandA.id, activeVersion]);
    await publish(f, one!.source_scenario_id, { title: "Same source again" });
    expect(await live()).toBe(25);
    await asUser(admin(), "select public.retire_customer_example($1)", [(await liveCopies(one!.source_scenario_id))[0]!.id]);
    expect(await live()).toBe(24);
    await publish(f, extra);
    expect(await live()).toBe(25);
  });
});
