import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { asUser, createBrand, createTenant, createUser, expectDenied, join, sql, superPool, type TestUser } from "./harness";
import type { World } from "./world";

/**
 * Shared fixtures for the Milestone 5 database tests: a priced rate card assigned to customer A (not B), reweigh / remeasure /
 * correction fee rules, builders for the JSON the TypeScript layer sends (scenario input and result), a dual-role user and a
 * tenant that can be suspended. Every amount, name and weight is fictional. The "planted" sentinels are values no customer
 * may ever read; the leakage tests look for them everywhere a customer can reach.
 */
export const SENTINELS = {
  /** Letters, planted in every staff-authored text column of M2 to M5. */
  text: "SENTINEL_TEXT",
  /** Distinctive numbers, planted in staff-only figures (incidence, severity, an absorbed amount). */
  incidence: "7.3719",
  severity: "42.6143",
  absorbed: "91317.29",
} as const;
export const SENTINEL_PATTERN = /SENTINEL_|7\.3719|42\.6143|91317\.29/;

/** Asserts a statement is rejected with one of the SQLSTATEs (and a message matching `pattern`). */
export async function expectCode(promise: Promise<unknown>, code: string | string[], pattern: RegExp = /./): Promise<void> {
  const codes = Array.isArray(code) ? code : [code];
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (!codes.includes(e.code ?? "") || !pattern.test(e.message ?? "")) throw new Error(`Rejected, but with ${e.code ?? "no code"}: ${e.message}`);
    return;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded.");
}

/** Asserts a refusal and returns its machine-readable hint (the publish refusals carry the problem code there). */
export async function refusalHint(promise: Promise<unknown>, code: string, pattern: RegExp = /./): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message?: string; hint?: string };
    if (e.code !== code || !pattern.test(e.message ?? "")) throw new Error(`Rejected, but with ${e.code ?? "no code"}: ${e.message}`);
    return e.hint;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded.");
}

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A transaction on its own connection, as a signed-in user, that stays open until the callback ends (for races). */
export async function withTx<T>(userId: string | null, fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>, opts: { commit?: boolean } = {}): Promise<T> {
  const client: PoolClient = await superPool.connect();
  try {
    await client.query("begin");
    if (userId) {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: userId, role: "authenticated" }), userId]);
    }
    const out = await fn((text, params = []) => client.query(text, params));
    await client.query(opts.commit === false ? "rollback" : "commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs statements as the database owner with the adjustment write-guard opened (what an RPC does), then closes it. */
export async function asOwnerWithGuardOpen(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return withTx(null, async (q) => {
    await q("select set_config('app.adjustment_rpc', 'on', true)");
    return (await q(text, params)).rows;
  });
}

/** Runs statements as the database owner with triggers disabled (to make time pass: move dates into the past). */
export async function asOwnerWithoutTriggers(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return withTx(null, async (q) => {
    await q("set local session_replication_role = replica");
    return (await q(text, params)).rows;
  });
}

export interface RuleRef { ruleId: string; versionId: string }

export interface Fixture {
  w: World;
  upsGround: string;
  uspsGa: string;
  cardId: string;
  v1: string;
  today: string;
  rules: { reweigh: RuleRef; remeasure: RuleRef; correction: RuleRef };
  /** Tenant staff (administrator) and customer A's employee at once. */
  dual: TestUser;
  /** A third 3PL that is suspended by a platform administrator inside the tests. */
  t3: { id: string; admin: TestUser };
}

export async function buildFixture(w: World): Promise<Fixture> {
  const [{ id: upsGround }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'ups' and code = 'ground'")) as [{ id: string }];
  const [{ id: uspsGa }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'usps' and code = 'ground_advantage'")) as [{ id: string }];
  const [{ d: today }] = (await sql<{ d: string }>("select current_date::text as d")) as [{ d: string }];
  const admin = w.t1.admin.id;
  const [card] = await asUser<{ id: string }>(admin, "insert into public.rate_cards (tenant_id, name) values ($1, 'Adjustment card') returning id", [w.t1.id]);
  const cardId = card!.id;
  const [v] = await asUser<{ id: string }>(admin, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1) returning id", [cardId, w.t1.id]);
  const v1 = v!.id;
  const [term] = await asUser<{ id: string }>(admin, "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139) returning id", [v1, upsGround]);
  await asUser(admin, "insert into public.rate_card_service_term_sources (term_id, tenant_id, source_reference) values ($1, $2, $3)", [term!.id, w.t1.id, `${SENTINELS.text}_TERMS_SOURCE: our contract gives us 41% off`]);
  await asUser(admin, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 5, 'lb', 9.60), ($1, $2, '5', 5, 20, 'lb', 14.50)", [v1, upsGround]);
  await asUser(admin, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '800', '899', '5')", [v1]);
  await asUser(admin, "select public.activate_rate_card_version($1, '2026-01-01')", [v1]);
  await asUser(admin, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandA.id, cardId]);

  const rules = {
    reweigh: await publishRule(w, "adjtest.reweigh_fee", "reweight", "Reweigh fee", "3.00"),
    remeasure: await publishRule(w, "adjtest.remeasure_fee", "remeasure", "Remeasure fee", "4.00"),
    correction: await publishRule(w, "adjtest.correction_fee", "shipping_charge_correction", "Shipping charge correction fee", "5.00"),
  };

  const dual = await createUser("dual-role");
  await join(w.t1.admin, dual, { tenantId: w.t1.id, role: "tenant_admin" });
  await join(w.brandA.admin, dual, { tenantId: w.t1.id, brandId: w.brandA.id, role: "brand_employee" });

  const owner3 = await createUser("t3admin");
  const t3 = await createTenant(owner3, "Third Party Logistics");
  return { w, upsGround, uspsGa, cardId, v1, today, rules, dual, t3: { id: t3, admin: owner3 } };
}

/** A published tenant rule version (flat, conditional) in the given category. The source text is a planted sentinel. */
export async function publishRule(w: World, key: string, category: string, name: string, amount: string, opts: { effective?: string; expiration?: string | null; ruleId?: string; version?: number } = {}): Promise<RuleRef> {
  const admin = w.t1.admin.id;
  let ruleId = opts.ruleId;
  if (!ruleId) {
    const [r] = await asUser<{ id: string }>(admin, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', $2, $3, $4) returning id", [w.t1.id, key, category, name]);
    ruleId = r!.id;
  }
  const [rv] = await asUser<{ id: string }>(
    admin,
    `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, expiration_date, source_reference, verification_status)
     values ($1, $2, $3, 'conditional', 'flat', $4, $5, $6, $7, 'approved_3pl_config') returning id`,
    [ruleId, w.t1.id, opts.version ?? 1, amount, opts.effective ?? "2026-01-01", opts.expiration ?? null, `${SENTINELS.text}_RULE_SOURCE_${key}`],
  );
  await asUser(admin, "select public.publish_surcharge_rule_version($1)", [rv!.id]);
  return { ruleId, versionId: rv!.id };
}

export const setPolicy = (userId: string, tenant: string, brand: string | null, type: string, component: string, handling: string, from: string | null = null, note: string | null = null) =>
  asUser<{ id: string }>(userId, "select public.set_adjustment_policy($1, $2, $3, $4, $5, $6, $7) as id", [tenant, brand, type, component, handling, from, note]).then((r) => r[0]!.id);

export const pkg = (weightLb: string, dims?: [string, string, string]) => ({ weightLb, ...(dims ? { lengthIn: dims[0], widthIn: dims[1], heightIn: dims[2] } : {}) });

/** The scenario input the TypeScript layer stores (contract in the migration header). Extra keys are staff-only. */
export function scenarioInput(f: Fixture, over: Record<string, unknown> = {}) {
  return {
    v: 1, serviceId: f.upsGround, residential: true, zone: 5, declaredSource: "entered",
    declared: { packages: [pkg("5", ["10", "8", "6"])] },
    corrected: { packages: [pkg("12", ["10", "8", "6"])] },
    staffOnly: { note: `${SENTINELS.text}_SCENARIO_NOTE`, incidence: SENTINELS.incidence },
    ...over,
  };
}

/** The scenario result (contract in the migration header): postage difference $5.30 and a separate fee of $2.00 by default. */
export function scenarioResult(over: Partial<{ status: string; direction: string; basis: string; postage: string | null; fee: string | null; postageState: string; feeState: string; handling: Record<string, string>; extra: Record<string, unknown>; components: Record<string, unknown>[] }> = {}) {
  const components: Record<string, unknown>[] = over.components ? [...over.components] : [];
  if (!over.components && over.postage !== null) components.push({ kind: "postage_difference", state: over.postageState ?? "conditional", amount: over.postage ?? "5.30", declaredTotal: "17.83", correctedTotal: "23.13", ...(over.handling?.postage_difference ? { handling: over.handling.postage_difference } : {}) });
  if (!over.components && over.fee !== null) components.push({ kind: "separate_fee", state: over.feeState ?? "conditional", amount: over.fee ?? "2.00", ...(over.handling?.separate_fee ? { handling: over.handling.separate_fee } : {}) });
  return {
    v: 1, status: over.status ?? "ok", adjustmentType: "reweight", direction: over.direction ?? "increase", basis: over.basis ?? "exact", components,
    // Staff-only figures that must never reach a customer, in any form.
    totals: { customerPays: "5.30", notBilledToCustomer: SENTINELS.absorbed, incidence: SENTINELS.incidence, severity: SENTINELS.severity },
    ...(over.extra ?? {}),
  };
}

export interface ScenarioOpts {
  brand?: string | null; name?: string; type?: string; input?: Record<string, unknown>; result?: Record<string, unknown>; versionId?: string | null;
  ruleVersionIds?: string[]; overrideIds?: string[]; pricedOn?: string; by?: string;
}

export function saveScenarioRaw(f: Fixture, o: ScenarioOpts = {}) {
  const pins = { rateCardVersionId: o.versionId === undefined ? f.v1 : o.versionId, ruleVersionIds: o.ruleVersionIds ?? [f.rules.reweigh.versionId], overrideIds: o.overrideIds ?? [], pricedOn: o.pricedOn ?? f.today };
  return asUser<{ id: string }>(
    o.by ?? f.w.t1.admin.id,
    "select public.save_adjustment_scenario($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, '1.0.0') as id",
    [f.w.t1.id, o.brand === undefined ? f.w.brandA.id : o.brand, o.name ?? "Reweigh 5 lb to 12 lb", o.type ?? "reweight", JSON.stringify(o.input ?? scenarioInput(f)), JSON.stringify(o.result ?? scenarioResult()), JSON.stringify(pins)],
  );
}
export const saveScenario = async (f: Fixture, o: ScenarioOpts = {}) => (await saveScenarioRaw(f, o))[0]!.id;

export const publish = (f: Fixture, source: string, o: { brand?: string; title?: string; note?: string | null; validThrough?: string | null; internal?: string | null; by?: string } = {}) =>
  asUser<{ id: string }>(
    o.by ?? f.w.t1.admin.id,
    "select public.publish_customer_example($1, $2, $3, $4, $5, $6) as id",
    [source, o.brand ?? f.w.brandA.id, o.title ?? "If a 5 lb package is corrected to 12 lb", o.note ?? null, o.validThrough ?? null, o.internal ?? null],
  ).then((r) => r[0]!.id);

export const brandExamples = (userId: string, brand: string) =>
  asUser<{ r: ExampleOut[] }>(userId, "select public.brand_adjustment_examples($1) as r", [brand]).then((r) => r[0]!.r);

export interface ExampleOut {
  id: string; title: string; note: string | null; payload: Record<string, unknown> | null; pricedOn: string; ratesEffectiveFrom: string; validThrough: string; publishedAt: string; state: string;
}

export const exampleState = (userId: string, id: string) =>
  asUser<{ r: { state: string; causes: string[] } }>(userId, "select public.adjustment_example_state($1) as r", [id]).then((r) => r[0]!.r);

/** Customer A's brand-visible examples as a flat list of ids (live, any state). */
export const liveCopies = (source: string) => sql<{ id: string }>("select id from public.published_adjustment_examples where source_scenario_id = $1 and retired_at is null", [source]);

export { asUser, createBrand, createTenant, createUser, expectDenied, join, sql, superPool };
export type { TestUser };
