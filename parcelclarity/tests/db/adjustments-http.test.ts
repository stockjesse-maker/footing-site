import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Milestone 5, over HTTP: the same questions as the database tests, asked the way a hostile customer would ask them, with real
 * JSON Web Tokens (Supabase Auth password sign-in) through the real PostgREST. Customers call the Data API by hand: every M5
 * table is empty to them, embedding finds nothing, staff functions are refused, and the one function they may call returns only
 * the explicit projection.
 *
 * It needs the local stack's API and database (see TESTING.md: `npm run stack:up`, `cp /var/lib/parcelclarity-stack/env .env.local`,
 * then load it into the environment). Without them every test here is skipped, and says so. It creates its own uniquely named
 * tenants in the stack's database (as the end-to-end tests do) and leaves them there.
 */
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB = process.env.PC_DATABASE_URL;
const configured = Boolean(URL_ && ANON && SERVICE && DB);

const SENTINEL = /SENTINEL_|7\.3719|42\.6143|91317\.29/;
const run = randomUUID().slice(0, 8);
const PASSWORD = "Adjustments-Test-9f3a1c";

let reachable = false;
let pool: Pool;
const tokens: Record<"admin" | "brandA" | "brandB" | "outsider", string> = { admin: "", brandA: "", brandB: "", outsider: "" };
const userIds: Record<string, string> = {};
let tenantId = "";
let brandA = "";
let brandB = "";
let exampleId = "";

interface Reply { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(method: string, path: string, opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { apikey: ANON!, ...(opts.token === null ? {} : { Authorization: `Bearer ${opts.token ?? ANON}` }), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

async function createUser(label: string): Promise<{ id: string; token: string }> {
  const email = `m5http-${label}-${run}@example.test`;
  const created = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: "POST", headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `HTTP ${label}` } }),
  });
  if (!created.ok) throw new Error(`could not create ${label}: ${created.status} ${await created.text()}`);
  const user = (await created.json()) as { id: string };
  const login = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON!, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!login.ok) throw new Error(`could not sign in ${label}: ${login.status} ${await login.text()}`);
  return { id: user.id, token: ((await login.json()) as { access_token: string }).access_token };
}

/** Runs one statement in the stack's database as a signed-in user (like PostgREST does), to build fixtures. */
async function asUser<T = Record<string, unknown>>(userId: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: userId, role: "authenticated" }), userId]);
    const res = await client.query(text, params);
    await client.query("commit");
    return res.rows as T[];
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!configured) return;
  try {
    const ping = await fetch(`${URL_}/rest/v1/`, { headers: { apikey: ANON! } });
    const auth = await fetch(`${URL_}/auth/v1/health`);
    reachable = ping.status < 500 && auth.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return;
  pool = new Pool({ connectionString: DB, max: 3 });
  const [admin, a, b, outsider] = await Promise.all([createUser("admin"), createUser("brandA"), createUser("brandB"), createUser("outsider")]);
  Object.assign(userIds, { admin: admin.id, brandA: a.id, brandB: b.id, outsider: outsider.id });
  Object.assign(tokens, { admin: admin.token, brandA: a.token, brandB: b.token, outsider: outsider.token });

  tenantId = (await asUser<{ t: string }>(admin.id, "select public.create_tenant($1) as t", [`HTTP Freight ${run}`]))[0]!.t;
  brandA = (await asUser<{ id: string }>(admin.id, "insert into public.brands (tenant_id, name) values ($1, $2) returning id", [tenantId, `HTTP Customer A ${run}`]))[0]!.id;
  brandB = (await asUser<{ id: string }>(admin.id, "insert into public.brands (tenant_id, name) values ($1, $2) returning id", [tenantId, `HTTP Customer B ${run}`]))[0]!.id;
  await pool.query("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1, $2, $3, 'brand_admin'), ($4, $2, $5, 'brand_admin')", [a.id, tenantId, brandA, b.id, brandB]);

  const [ups] = (await pool.query("select id from public.shipping_services where carrier_code = 'ups' and code = 'ground'")).rows;
  const card = (await asUser<{ id: string }>(admin.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'HTTP card') returning id", [tenantId]))[0]!.id;
  const version = (await asUser<{ id: string }>(admin.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1) returning id", [card, tenantId]))[0]!.id;
  const term = (await asUser<{ id: string }>(admin.id, "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor) values ($1, $2, 139) returning id", [version, ups.id]))[0]!.id;
  await asUser(admin.id, "insert into public.rate_card_service_term_sources (term_id, tenant_id, source_reference) values ($1, $2, 'SENTINEL_TEXT_HTTP_TERMS_SOURCE')", [term, tenantId]);
  await asUser(admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 20, 'lb', 9.60)", [version, ups.id]);
  await asUser(admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '800', '899', '5')", [version]);
  await asUser(admin.id, "select public.activate_rate_card_version($1, '2026-01-01')", [version]);
  await asUser(admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [tenantId, brandA, card]);
  const rule = (await asUser<{ id: string }>(admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', $2, 'reweight', 'Reweigh fee') returning id", [tenantId, `http.reweigh.${run}`]))[0]!.id;
  const ruleVersion = (await asUser<{ id: string }>(admin.id, "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 1, 'conditional', 'flat', 3.00, '2026-01-01', 'SENTINEL_TEXT_HTTP_RULE_SOURCE', 'approved_3pl_config') returning id", [rule, tenantId]))[0]!.id;
  await asUser(admin.id, "select public.publish_surcharge_rule_version($1)", [ruleVersion]);
  const override = (await asUser<{ id: string }>(admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date) values ($1, $2, $3, 'exclude', '2026-01-01') returning id", [tenantId, brandA, rule]))[0]!.id;
  await asUser(admin.id, "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [override]);
  await asUser(admin.id, "insert into public.customer_surcharge_override_notes (override_id, tenant_id, reference) values ($1, $2, 'SENTINEL_TEXT_HTTP_OVERRIDE_NOTE')", [override, tenantId]);

  // The M5 data, created over HTTP by the 3PL's administrator (so the staff functions are exercised the same way).
  const rpc = async (name: string, body: unknown) => {
    const r = await api("POST", `/rest/v1/rpc/${name}`, { token: admin.token, body });
    if (r.status >= 300) throw new Error(`${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  await rpc("set_adjustment_policy", { p_tenant: tenantId, p_brand: brandA, p_type: "reweight", p_component: "postage_difference", p_handling: "pass_through", p_note: "SENTINEL_TEXT_HTTP_POLICY_NOTE" });
  await rpc("set_adjustment_policy", { p_tenant: tenantId, p_brand: brandA, p_type: "reweight", p_component: "separate_fee", p_handling: "manual_approval" });
  await rpc("save_adjustment_baseline", { p_tenant: tenantId, p_brand: brandA, p_carrier: "ups", p_service: null, p_start: "2026-01-01", p_end: "2026-01-31", p_packages: 1000, p_missing: 40, p_note: "SENTINEL_TEXT_HTTP_BASELINE 7.3719" });
  await rpc("save_risk_estimate", { p_tenant: tenantId, p_brand: brandA, p_name: "SENTINEL_TEXT_HTTP_ESTIMATE", p_inputs: { incidence: "7.3719" }, p_result: { absorbed: "91317.29", severity: "42.6143" }, p_engine_version: "1.0.0" });
  const today = (await pool.query("select current_date::text as d")).rows[0].d as string;
  const scenario = (await rpc("save_adjustment_scenario", {
    p_tenant: tenantId, p_brand: brandA, p_name: "SENTINEL_TEXT_HTTP_SCENARIO", p_type: "reweight", p_engine_version: "1.0.0",
    p_input: { v: 1, serviceId: ups.id, residential: true, zone: 5, declared: { packages: [{ weightLb: "5" }] }, corrected: { packages: [{ weightLb: "12" }] }, staffOnly: "SENTINEL_TEXT_HTTP_INPUT" },
    p_result: { v: 1, status: "ok", adjustmentType: "reweight", direction: "increase", basis: "exact", components: [{ kind: "postage_difference", state: "conditional", amount: "5.30" }, { kind: "separate_fee", state: "conditional", amount: "2.00" }], totals: { notBilledToCustomer: "91317.29", incidence: "7.3719" } },
    p_pins: { rateCardVersionId: version, ruleVersionIds: [ruleVersion], overrideIds: [], pricedOn: today },
  })) as string;
  exampleId = (await rpc("publish_customer_example", { p_source: scenario, p_brand: brandA, p_title: "If a 5 lb package is corrected to 12 lb", p_note: "Ask your account manager.", p_internal_note: "SENTINEL_TEXT_HTTP_PRIVATE 91317.29" })) as string;
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

const T = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => {
  if (!configured || !reachable) {
    console.warn(`skipped (${configured ? "the local stack's API is not reachable" : "no local stack configured; see TESTING.md"}): ${name}`);
    ctx.skip();
    return;
  }
  await fn();
}, 60_000);

const M5 = ["adjustment_policies", "adjustment_imports", "adjustment_records", "adjustment_baselines", "adjustment_scenarios", "risk_estimates", "published_adjustment_examples", "rate_card_service_term_sources", "customer_surcharge_override_notes", "simulation_run_failures"];

describe("the Data API, with real customer tokens", () => {
  T("the 3PL's administrator reads their M5 rows (so an empty answer for a customer means something)", async () => {
    for (const table of ["adjustment_policies", "adjustment_baselines", "adjustment_scenarios", "risk_estimates", "published_adjustment_examples"]) {
      const r = await api("GET", `/rest/v1/${table}?select=*`, { token: tokens.admin });
      expect(r.status, table).toBe(200);
      expect(r.body.length, table).toBeGreaterThan(0);
    }
    expect(JSON.stringify((await api("GET", "/rest/v1/rate_card_service_term_sources?select=*", { token: tokens.admin })).body)).toContain("SENTINEL_TEXT_HTTP_TERMS_SOURCE");
  });

  T("every M5 table and staff-only table is empty for a customer, another customer and a stranger", async () => {
    for (const who of ["brandA", "brandB", "outsider"] as const) {
      for (const table of M5) {
        const r = await api("GET", `/rest/v1/${table}?select=*`, { token: tokens[who] });
        expect(r.status, `${who} ${table}`).toBe(200);
        expect(r.body, `${who} ${table}`).toEqual([]);
      }
    }
    // Counting is no better: the exact count header says zero too.
    const count = await api("GET", "/rest/v1/adjustment_policies?select=id", { token: tokens.brandA, headers: { Prefer: "count=exact", Range: "0-0" } });
    expect(count.body).toEqual([]);
  });

  T("embedding the M5 tables from a table the customer can read finds nothing", async () => {
    for (const select of ["*,adjustment_policies(*)", "*,adjustment_baselines(*)", "*,adjustment_scenarios(*)", "*,risk_estimates(*)", "*,published_adjustment_examples(*)", "*,adjustment_records(*)"]) {
      const r = await api("GET", `/rest/v1/brands?select=${encodeURIComponent(select)}`, { token: tokens.brandA });
      if (r.status === 200) {
        expect(r.body.length).toBeGreaterThan(0);
        for (const row of r.body) for (const [k, v] of Object.entries(row)) if (k.startsWith("adjustment_") || k.startsWith("risk_") || k.startsWith("published_")) expect(v, `${select} ${k}`).toEqual([]);
      } else {
        expect(r.status, select).toBeGreaterThanOrEqual(400); // no such relationship is also an answer: still nothing leaked
      }
      expect(JSON.stringify(r.body)).not.toMatch(SENTINEL);
    }
    const fromExamples = await api("GET", `/rest/v1/published_adjustment_examples?select=${encodeURIComponent("*,adjustment_scenarios(*)")}`, { token: tokens.brandA });
    expect(JSON.stringify(fromExamples.body)).not.toMatch(SENTINEL);
    const termSource = await api("GET", `/rest/v1/rate_card_service_terms?select=${encodeURIComponent("*,rate_card_service_term_sources(*)")}`, { token: tokens.brandA });
    expect(JSON.stringify(termSource.body)).not.toMatch(SENTINEL);
  });

  T("the customer-readable tables no longer carry the two free-text columns", async () => {
    const terms = await api("GET", "/rest/v1/rate_card_service_terms?select=*", { token: tokens.brandA });
    expect(terms.status).toBe(200);
    expect(terms.body.length).toBeGreaterThan(0);
    for (const row of terms.body) expect(Object.keys(row)).not.toContain("source_reference");
    const overrides = await api("GET", "/rest/v1/customer_surcharge_overrides?select=*", { token: tokens.brandA });
    expect(overrides.status).toBe(200);
    for (const row of overrides.body) expect(Object.keys(row)).not.toContain("reference");
    expect((await api("GET", "/rest/v1/rate_card_service_terms?select=source_reference", { token: tokens.brandA })).status).toBeGreaterThanOrEqual(400);
    const context = await api("POST", "/rest/v1/rpc/pricing_rules_for_card", { token: tokens.brandA, body: { p_rate_card: (await pool.query("select rate_card_id from public.brand_rate_card_assignments where brand_id = $1", [brandA])).rows[0].rate_card_id, p_ship_date: "2026-10-15", p_adjustment_view: true } });
    expect(context.status).toBe(200);
    expect(JSON.stringify(context.body)).not.toMatch(SENTINEL);
    expect(JSON.stringify(context.body)).toContain("Your 3PL's approved pricing configuration");
  });

  T("a customer cannot write anything: tables refuse (403) and staff functions refuse with the staff-only answers", async () => {
    for (const table of ["adjustment_policies", "published_adjustment_examples", "adjustment_baselines"]) {
      for (const who of ["brandA", "admin"] as const) {
        const post = await api("POST", `/rest/v1/${table}`, { token: tokens[who], body: { tenant_id: tenantId }, headers: { Prefer: "return=representation" } });
        expect(post.status, `${who} POST ${table}`).toBe(403);
        expect(post.body.code).toBe("42501");
        expect((await api("PATCH", `/rest/v1/${table}?tenant_id=eq.${tenantId}`, { token: tokens[who], body: { tenant_id: tenantId } })).status, `${who} PATCH ${table}`).toBe(403);
        expect((await api("DELETE", `/rest/v1/${table}?tenant_id=eq.${tenantId}`, { token: tokens[who] })).status, `${who} DELETE ${table}`).toBe(403);
      }
    }
    const staffOnly: [string, Record<string, unknown>][] = [
      ["set_adjustment_policy", { p_tenant: tenantId, p_brand: brandA, p_type: "reweight", p_component: "separate_fee", p_handling: "absorbed" }],
      ["save_adjustment_baseline", { p_tenant: tenantId, p_brand: null, p_carrier: null, p_service: null, p_start: "2025-01-01", p_end: "2025-01-31", p_packages: 5 }],
      ["publish_customer_example", { p_source: randomUUID(), p_brand: brandA, p_title: "x" }],
      ["retire_customer_example", { p_example: exampleId }],
      ["adjustment_example_state", { p_example: exampleId }],
      ["withdraw_adjustment_import", { p_import: randomUUID() }],
    ];
    for (const [name, body] of staffOnly) {
      const r = await api("POST", `/rest/v1/rpc/${name}`, { token: tokens.brandA, body });
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(["42501", "P0002"], name).toContain(r.body.code);
      expect(JSON.stringify(r.body), name).not.toMatch(SENTINEL);
      expect((await api("POST", `/rest/v1/rpc/${name}`, { token: null, body })).status, `${name} signed out`).toBeGreaterThanOrEqual(401);
    }
    // The offboarding functions live in a schema the API does not expose.
    expect((await api("POST", "/rest/v1/rpc/purge_tenant_adjustment_data", { token: tokens.admin, body: { p_tenant: tenantId } })).status).toBe(404);
  });

  T("the one function a customer may call returns only the projection, and only for their own customer", async () => {
    const mine = await api("POST", "/rest/v1/rpc/brand_adjustment_examples", { token: tokens.brandA, body: { p_brand: brandA } });
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(Object.keys(mine.body[0]).sort()).toEqual(["id", "note", "payload", "pricedOn", "publishedAt", "ratesEffectiveFrom", "state", "title", "validThrough"]);
    expect(mine.body[0]).toMatchObject({ id: exampleId, title: "If a 5 lb package is corrected to 12 lb", note: "Ask your account manager.", state: "current" });
    expect(mine.body[0].payload.components.map((c: { kind: string; handling: string }) => [c.kind, c.handling])).toEqual([["postage_difference", "pass_through"], ["separate_fee", "manual_approval"]]);
    expect(JSON.stringify(mine.body)).not.toMatch(SENTINEL);
    for (const [who, brand] of [["brandB", brandA], ["brandB", brandB], ["outsider", brandA], ["brandA", brandB], ["brandA", randomUUID()]] as const) {
      const r = await api("POST", "/rest/v1/rpc/brand_adjustment_examples", { token: tokens[who], body: { p_brand: brand } });
      expect(r.status, `${who} for ${brand}`).toBe(200);
      expect(r.body, `${who} for ${brand}`).toEqual([]);
    }
    expect((await api("POST", "/rest/v1/rpc/brand_adjustment_examples", { token: null, body: { p_brand: brandA } })).status).toBeGreaterThanOrEqual(401);
    // Stopping the example from the 3PL's side hides it from the customer at once.
    const stop = await api("POST", "/rest/v1/rpc/retire_customer_example", { token: tokens.admin, body: { p_example: exampleId } });
    expect(stop.status).toBeLessThan(300);
    expect((await api("POST", "/rest/v1/rpc/brand_adjustment_examples", { token: tokens.brandA, body: { p_brand: brandA } })).body).toEqual([]);
  });

  T("the schema document names tables and functions only; none of it carries a value, and no internal function is listed", async () => {
    for (const token of [tokens.brandA, ANON]) {
      const root = await api("GET", "/rest/v1/", { token });
      expect(root.status).toBe(200);
      const text = JSON.stringify(root.body);
      expect(text).not.toMatch(SENTINEL);
      expect(text).not.toContain("purge_tenant_adjustment_data");
      expect(text).not.toContain("build_customer_example");
      expect(text).not.toContain("customer_json_ok");
    }
    const asBrand = JSON.stringify((await api("GET", "/rest/v1/", { token: tokens.brandA })).body);
    expect(asBrand).toContain("brand_adjustment_examples");
  });
});
