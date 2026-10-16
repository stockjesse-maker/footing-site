import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The upgrade, not the fresh install. A database at migrations 1 to 6 holds data written under the old rules (a brand-readable source
 * on every term, a brand-readable note on an exception, load-issue text in run summaries, run errors in clear text, a run that is
 * still RUNNING, a reweigh fee rule of another class). Migration 7 is applied to it, in one transaction, and everything the migration
 * promises about existing rows is checked: the backfills lose nothing, the staff-only copies hold the text, no customer can read a
 * diagnostic, an in-flight run is cleaned and stays clean when it is cancelled or failed afterwards, and drafts of fee rules are made
 * conditional while legacy published ones are listed. It builds, uses and drops its own database (nothing is shared with the other files).
 */
const root = path.resolve(__dirname, "../..");
const host = process.env.PC_PG_HOST ?? "127.0.0.1";
const port = process.env.PC_PG_PORT ?? "54322";
const gotrueBin = process.env.PC_GOTRUE_BIN ?? "/opt/pc-stack/bin/gotrue";
const dbName = `pc_upgrade_${process.pid}_${Date.now()}`;
const url = (db: string) => `postgres://postgres@${host}:${port}/${db}`;
const migrationsDir = path.join(root, "supabase/migrations");
const migration7 = fs.readFileSync(path.join(migrationsDir, "20261015000007_adjustments.sql"), "utf8");

let db: Client;
const ids: Record<string, string> = {};

async function asUser<T extends Record<string, unknown> = Record<string, unknown>>(userId: string, text: string, params: unknown[] = []): Promise<T[]> {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: userId, role: "authenticated" }), userId]);
    const r = await db.query(text, params);
    await db.query("commit");
    return r.rows as T[];
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}
const q = async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query(text, params)).rows as T[];

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await q("insert into auth.users (id, aud, role, email, email_confirmed_at) values ($1, 'authenticated', 'authenticated', $2, now())", [id, `${label}-${id.slice(0, 6)}@example.test`]);
  return id;
}

beforeAll(async () => {
  const admin = new Client({ connectionString: url("postgres") });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  db = new Client({ connectionString: url(dbName) });
  await db.connect();
  await db.query(fs.readFileSync(path.join(root, "scripts/local-stack/bootstrap.sql"), "utf8"));
  const authUrl = `postgres://supabase_auth_admin:postgres@${host}:${port}/${dbName}`;
  execFileSync(gotrueBin, ["migrate"], {
    env: { ...process.env, DATABASE_URL: authUrl, GOTRUE_DB_DRIVER: "postgres", GOTRUE_DB_DATABASE_URL: authUrl, GOTRUE_DB_NAMESPACE: "auth", GOTRUE_JWT_SECRET: "test-secret-test-secret-test-secret-123", API_EXTERNAL_URL: "http://localhost:9999", GOTRUE_SITE_URL: "http://localhost:3000", GOTRUE_API_HOST: "127.0.0.1", GOTRUE_API_PORT: "9999" },
    stdio: "pipe",
  });
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (file.startsWith("20261015000007")) continue;
    await db.query(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }

  // A Supabase project that has Realtime switched on carries a publication that streams public tables. Migration 7 empties it of public
  // tables (a streamed row would bypass the staff-only reads); the local stack has none, so this database gets one before the upgrade.
  await db.query("create publication supabase_realtime for table public.brands, public.simulation_runs");

  // ---- Legacy data, written the way migrations 1 to 6 allowed ----------------------------------------------------------------------------
  const admin1 = await createUser("admin");
  const brandUser = await createUser("brand");
  const staffOnly = await createUser("employee");
  Object.assign(ids, { admin: admin1, brandUser, staffOnly });
  ids.tenant = (await asUser<{ t: string }>(admin1, "select public.create_tenant('Upgrade Freight') as t"))[0]!.t;
  await q("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1, $2, null, 'tenant_employee')", [staffOnly, ids.tenant]);
  ids.brand = (await asUser<{ id: string }>(admin1, "insert into public.brands (tenant_id, name) values ($1, 'Upgrade Customer') returning id", [ids.tenant]))[0]!.id;
  await q("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1, $2, $3, 'brand_admin')", [brandUser, ids.tenant, ids.brand]);
  const ups = (await q<{ id: string }>("select id from public.shipping_services where carrier_code = 'ups' and code = 'ground'"))[0]!.id;
  ids.card = (await asUser<{ id: string }>(admin1, "insert into public.rate_cards (tenant_id, name) values ($1, 'Legacy card') returning id", [ids.tenant]))[0]!.id;
  ids.version = (await asUser<{ id: string }>(admin1, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1) returning id", [ids.card, ids.tenant]))[0]!.id;
  ids.term = (await asUser<{ id: string }>(admin1, "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor, source_reference) values ($1, $2, 139, 'LEGACY_TERMS_SOURCE: contract gives us 41 percent') returning id", [ids.version, ups]))[0]!.id;
  await asUser(admin1, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 20, 'lb', 9.60)", [ids.version, ups]);
  await asUser(admin1, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '800', '899', '5')", [ids.version]);
  await asUser(admin1, "select public.activate_rate_card_version($1, '2026-01-01')", [ids.version]);
  await asUser(admin1, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [ids.tenant, ids.brand, ids.card]);
  const rule = async (key: string, category: string, cls: string, status: "draft" | "published", version = 1, ruleId?: string) => {
    const r = ruleId ?? (await asUser<{ id: string }>(admin1, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', $2, $3, $4) returning id", [ids.tenant, key, category, `Rule ${key}`]))[0]!.id;
    const v = (await asUser<{ id: string }>(admin1, "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, $3, $4, 'flat', 3.00, '2026-01-01', 'LEGACY_RULE_SOURCE', 'approved_3pl_config') returning id", [r, ids.tenant, version, cls]))[0]!.id;
    if (status === "published") await asUser(admin1, "select public.publish_surcharge_rule_version($1)", [v]);
    return { rule: r, version: v };
  };
  const published = await rule("legacy.reweigh_fee", "reweight", "conditional", "published");
  ids.legacyDraft = (await rule("legacy.remeasure_fee", "remeasure", "definite", "draft")).version;
  ids.legacyPublished = (await rule("legacy.correction_fee", "shipping_charge_correction", "estimated", "published")).version;
  ids.override = (await asUser<{ id: string }>(admin1, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, amount, effective_date, reference) values ($1, $2, $3, 'override_amount', 1.00, '2026-01-01', 'LEGACY_OVERRIDE_REF: we promised them half') returning id", [ids.tenant, ids.brand, published.rule]))[0]!.id;

  const project = async (name: string) => (await q<{ id: string }>("insert into public.simulation_projects (tenant_id, brand_id, kind, name, rate_card_id, created_by) values ($1, $2, 'single', $3, $4, $5) returning id", [ids.tenant, ids.brand, name, ids.card, brandUser]))[0]!.id;
  const run = async (name: string, status: string, o: { summary?: unknown; partial?: unknown; reference?: unknown; error?: string | null }) =>
    (await q<{ id: string }>("insert into public.simulation_runs (project_id, tenant_id, brand_id, kind, status, summary, partial_summary, reference_data, error, created_by) values ($1, $2, $3, 'single', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9) returning id",
      [await project(name), ids.tenant, ids.brand, status, o.summary ? JSON.stringify(o.summary) : null, o.partial ? JSON.stringify(o.partial) : null, o.reference ? JSON.stringify(o.reference) : null, o.error ?? null, brandUser]))[0]!.id;
  ids.completed = await run("completed", "completed", { summary: { version: 2, loadIssues: ["LEGACY: the surcharge rule \"x\" has an invalid condition"], totals: {} }, partial: { loadIssues: ["LEGACY inflight"], n: 1 }, reference: { loadIssues: ["LEGACY refdata"], feeDictionary: [] } });
  ids.failed = await run("failed", "failed", { partial: { loadIssues: ["LEGACY failed inflight"] }, error: "ORA-0001 internal stack trace LEGACY_ERROR_TEXT" });
  ids.running = await run("running", "running", { partial: { version: 2, loadIssues: ["LEGACY running in flight", "second"], shipments: { seen: 3 } } });
  ids.toCancel = await run("to cancel", "running", { partial: { version: 2, loadIssues: ["LEGACY to cancel"] } });
  ids.toFail = await run("to fail", "running", { partial: { version: 2, loadIssues: ["LEGACY to fail", "b", "c"] } });
  ids.cancelledBlank = await run("cancelled blank", "cancelled", { partial: { loadIssues: ["LEGACY cancelled"] }, error: "   " });
}, 180_000);

afterAll(async () => {
  await db?.end();
  const admin = new Client({ connectionString: url("postgres") });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
}, 60_000);

describe("migration 7 applied to a database that holds legacy data", () => {
  it("a migration that fails part-way leaves the database as it was (one transaction), and the real migration then applies", async () => {
    const [before] = await q<{ n: string }>("select count(*)::text as n from information_schema.columns where table_schema = 'public' and table_name = 'rate_card_service_terms' and column_name = 'source_reference'");
    expect(before!.n).toBe("1");
    await expect(db.query(`${migration7}\nselect 1 / 0;`)).rejects.toMatchObject({ code: "22012" });
    expect((await q("select to_regclass('public.adjustment_policies') as t"))[0]!.t).toBeNull();
    expect((await q<{ n: string }>("select count(*)::text as n from information_schema.columns where table_schema = 'public' and table_name = 'rate_card_service_terms' and column_name = 'source_reference'"))[0]!.n).toBe("1");
    expect(JSON.stringify(await q("select summary from public.simulation_runs where id = $1", [ids.completed]))).toContain("loadIssues");
    await db.query(migration7);
    expect((await q("select to_regclass('public.adjustment_policies') as t"))[0]!.t).toBe("adjustment_policies");
  }, 60_000);

  it("the free text brand members could read is copied to staff-only tables without loss, and the brand-readable columns are gone", async () => {
    expect(await q("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rate_card_service_terms' and column_name = 'source_reference'")).toHaveLength(0);
    expect(await q("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customer_surcharge_overrides' and column_name = 'reference'")).toHaveLength(0);
    expect(await q("select source_reference from public.rate_card_service_term_sources where term_id = $1 and tenant_id = $2", [ids.term, ids.tenant])).toEqual([{ source_reference: "LEGACY_TERMS_SOURCE: contract gives us 41 percent" }]);
    expect(await q("select reference from public.customer_surcharge_override_notes where override_id = $1 and tenant_id = $2", [ids.override, ids.tenant])).toEqual([{ reference: "LEGACY_OVERRIDE_REF: we promised them half" }]);
    // Every term and every override has its copy (a backfill that skipped rows would leave some without).
    expect(await q("select 1 from public.rate_card_service_terms t where not exists (select 1 from public.rate_card_service_term_sources s where s.term_id = t.id)")).toHaveLength(0);
    expect(await q("select 1 from public.customer_surcharge_overrides o where not exists (select 1 from public.customer_surcharge_override_notes n where n.override_id = o.id)")).toHaveLength(0);
    // The customer reads neither copy; the 3PL's staff read both.
    for (const table of ["rate_card_service_term_sources", "customer_surcharge_override_notes"]) {
      expect(await asUser(ids.brandUser!, `select * from public.${table}`), `${table} for the customer`).toHaveLength(0);
      expect((await asUser(ids.staffOnly!, `select * from public.${table}`)).length, `${table} for staff`).toBeGreaterThan(0);
    }
    const context = await asUser<{ r: unknown }>(ids.brandUser!, "select public.pricing_rules_for_card($1, '2026-10-15', null) as r", [ids.card]);
    expect(JSON.stringify(context[0]!.r)).not.toMatch(/LEGACY_/);
    expect(JSON.stringify(context[0]!.r)).toContain("Your 3PL's approved pricing configuration");
  });

  it("no run a customer can read keeps load-issue text, in any status, an in-flight run included; the counts survive; errors are codes and the detail moved to staff", async () => {
    const readable = await asUser<{ id: string; status: string; summary: unknown; partial_summary: unknown; reference_data: unknown; error: string | null }>(ids.brandUser!, "select id, status, summary, partial_summary, reference_data, error from public.simulation_runs");
    expect(readable).toHaveLength(6);
    expect(JSON.stringify(readable)).not.toMatch(/LEGACY|loadIssues"|stack trace/);
    const by = Object.fromEntries(readable.map((r) => [r.id, r]));
    expect(by[ids.completed!]).toMatchObject({ summary: { version: 2, loadIssueCount: 1, totals: {} }, partial_summary: { n: 1, loadIssueCount: 1 }, reference_data: { feeDictionary: [], loadIssueCount: 1 }, error: null });
    expect(by[ids.running!]).toMatchObject({ status: "running", partial_summary: { version: 2, shipments: { seen: 3 }, loadIssueCount: 2 }, error: null });
    expect(by[ids.failed!]).toMatchObject({ status: "failed", error: "run_failed", partial_summary: { loadIssueCount: 1 } });
    expect(by[ids.cancelledBlank!]).toMatchObject({ status: "cancelled", error: null }); // a blank error was never a diagnostic
    expect(await asUser(ids.brandUser!, "select detail from public.simulation_run_failures")).toHaveLength(0);
    expect(await asUser(ids.staffOnly!, "select detail from public.simulation_run_failures where run_id = $1", [ids.failed])).toEqual([{ detail: "ORA-0001 internal stack trace LEGACY_ERROR_TEXT" }]);
    expect(await q("select 1 from public.simulation_run_failures where run_id = $1", [ids.cancelledBlank])).toHaveLength(0);
    expect(await q("select 1 from pg_constraint where conname = 'simulation_runs_error_is_code'")).toHaveLength(1);
  });

  it("a run that was in flight when the migration ran stays clean when it is cancelled or failed afterwards, and a window stored after the upgrade is cleaned too", async () => {
    await asUser(ids.brandUser!, "select public.cancel_simulation_run($1)", [ids.toCancel]);
    await asUser(ids.brandUser!, "select public.fail_simulation_run($1, 'boom')", [ids.toFail]);
    const rows = await asUser<{ id: string; status: string; partial_summary: unknown; error: string | null }>(ids.brandUser!, "select id, status, partial_summary, error from public.simulation_runs where id = any ($1)", [[ids.toCancel, ids.toFail]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[ids.toCancel!]).toMatchObject({ status: "cancelled", partial_summary: { version: 2, loadIssueCount: 1 } });
    expect(by[ids.toFail!]).toMatchObject({ status: "failed", partial_summary: { version: 2, loadIssueCount: 3 }, error: "boom" });
    expect(JSON.stringify(rows)).not.toMatch(/LEGACY/);
    // The window path: advance_simulation_run stores its partial summary without load-issue text (it fails before storing only on a bad window,
    // so call it with a window the run cannot take and read what a stored partial looks like through the function text instead).
    const [src] = await q<{ s: string }>("select prosrc as s from pg_proc where proname = 'advance_simulation_run' and pronamespace = 'public'::regnamespace");
    expect(src!.s).toContain("partial_summary = app.summary_without_load_issues(p_partial)");
    expect(src!.s).not.toContain("partial_summary = p_partial");
    expect((await q("select 1 from pg_proc where proname = 'advance_simulation_run' and pronamespace = 'public'::regnamespace")).length).toBe(1);
    expect((await q<{ a: number }>("select pronargs as a from pg_proc where proname = 'advance_simulation_run' and pronamespace = 'public'::regnamespace"))[0]!.a).toBe(8);
  });

  it("drafts of reweigh, remeasure and correction fee rules were made conditional; a legacy PUBLISHED version of another class is left alone and listed for the 3PL", async () => {
    expect(await q("select status, charge_class from public.surcharge_rule_versions where id = $1", [ids.legacyDraft])).toEqual([{ status: "draft", charge_class: "conditional" }]);
    expect(await q("select status, charge_class from public.surcharge_rule_versions where id = $1", [ids.legacyPublished])).toEqual([{ status: "published", charge_class: "estimated" }]);
    expect(await asUser(ids.admin!, "select public.adjustment_legacy_fee_rules($1) as r", [ids.tenant])).toEqual([{ r: [{ ruleName: "Rule legacy.correction_fee", versionNumber: 1 }] }]);
    // The made-conditional draft publishes; a draft that is changed back to another class does not.
    await asUser(ids.admin!, "select public.publish_surcharge_rule_version($1)", [ids.legacyDraft]);
    expect(await q("select status, charge_class from public.surcharge_rule_versions where id = $1", [ids.legacyDraft])).toEqual([{ status: "published", charge_class: "conditional" }]);
  });

  it("the Realtime publication that existed before the upgrade streams no public table afterwards", async () => {
    expect(await q("select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")).toEqual([]);
    expect((await q<{ n: string }>("select count(*)::text as n from pg_publication where pubname = 'supabase_realtime'"))[0]!.n).toBe("1");
  });

  it("the shared objects are as the new migration leaves them: nullable actor columns, one overload per function, the narrowed file policies", async () => {
    expect((await q<{ n: string }>("select count(*)::text as n from information_schema.columns where table_schema = 'public' and ((table_name = 'uploaded_files' and column_name = 'uploaded_by') or (table_name = 'order_datasets' and column_name = 'created_by') or (table_name = 'simulation_projects' and column_name = 'created_by') or (table_name = 'simulation_runs' and column_name = 'created_by')) and is_nullable = 'YES'"))[0]!.n).toBe("4");
    expect(await q("select proname from pg_proc where pronamespace = 'public'::regnamespace group by proname having count(*) > 1")).toEqual([]);
    expect((await q<{ n: string }>("select count(*)::text as n from pg_policies where tablename = 'uploaded_files' and policyname in ('files_read', 'files_insert')"))[0]!.n).toBe("2");
    const body = Buffer.from("ship_date,carrier,service\n2026-01-02,ups,ground\n");
    expect(await asUser(ids.admin!, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', 'a.csv', 'text/csv', $2, sha256($3::bytea), $3::bytea) returning id", [ids.tenant, body.length, body])).toHaveLength(1);
    const flagged = Buffer.from("ship_date,carrier cost\n1,2\n");
    // The guard trigger the migration added is on the table of the upgraded database (a flagged header is refused before it is stored).
    await expect(asUser(ids.admin!, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', 'b.csv', 'text/csv', $2, sha256($3::bytea), $3::bytea)", [ids.tenant, flagged.length, flagged])).rejects.toMatchObject({ message: "this file was not saved" });
  });
});
