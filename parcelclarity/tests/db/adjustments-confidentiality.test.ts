import { beforeAll, describe, expect, it } from "vitest";
import {
  asUser, buildFixture, createUser, expectCode, publish, saveScenario, scenarioInput, scenarioResult, setPolicy, sha256Hex, sql, SENTINEL_PATTERN, SENTINELS, type Fixture, type TestUser,
} from "./adjustments-fixture";
import { buildWorld, type World } from "./world";

/**
 * Milestone 5 confidentiality sweeps. Nothing a 3PL authors for itself may reach a customer through ANY path: tables, functions,
 * errors, audit. The sweeps do not trust a list of tables: they enumerate every relation the Data API roles can touch, plant
 * letter and numeric sentinels in every staff-authored text column of M2 to M5, and scan what each kind of user can read.
 * A relation, column or function that appears (or changes) without a decision here fails the build on purpose.
 */
let w: World;
let f: Fixture;
let ids: { policy: string; import: string; file: string; scenario: string; published: string; baseline: string; estimate: string; t3Policy: string; t3Baseline: string };
let suspended: TestUser;

const M5_TABLES = ["adjustment_policies", "adjustment_imports", "adjustment_records", "adjustment_baselines", "adjustment_scenarios", "risk_estimates", "published_adjustment_examples"] as const;
/** Staff-only relations of earlier milestones plus the step-0 copies: brands have no policy on any of them. */
const STAFF_ONLY = [...M5_TABLES, "rate_card_service_term_sources", "customer_surcharge_override_notes", "fee_rule_sources", "fee_schedule_version_notes", "simulation_run_failures", "rate_card_imports", "audit_events"];
const API_SCHEMAS = ["public", "graphql_public"];

const T = SENTINELS.text;
const sentinel = (where: string) => `${T}_${where}`;

beforeAll(async () => {
  w = await buildWorld();
  f = await buildFixture(w);
  suspended = f.t3.admin;
  const admin = w.t1.admin.id;

  // --- M2: pricing text a 3PL writes for itself -----------------------------------------------------------------------
  await asUser(admin, "update public.rate_card_service_term_sources set source_reference = $2 where term_id in (select id from public.rate_card_service_terms where version_id = $1)", [f.v1, sentinel("TERMS_SOURCE_UPDATED")]).catch(() => undefined);
  const [zl] = await asUser<{ id: string }>(admin, "insert into public.zip_lists (tenant_id, carrier_code, key, name, source_reference, verification_status, effective_date) values ($1, 'ups', 'adjtest.das', 'DAS ZIPs', $2, 'approved_3pl_config', '2026-01-01') returning id", [w.t1.id, sentinel("ZIP_SOURCE")]);
  await asUser(admin, "insert into public.zip_list_entries (list_id, entry) values ($1, '90001')", [zl!.id]);
  await asUser(admin, "select public.publish_zip_list($1)", [zl!.id]);
  const [o] = await asUser<{ id: string }>(admin, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date) values ($1, $2, $3, 'exclude', current_date) returning id", [w.t1.id, w.brandA.id, f.rules.correction.ruleId]);
  await asUser(admin, "insert into public.customer_surcharge_override_notes (override_id, tenant_id, reference) values ($1, $2, $3)", [o!.id, w.t1.id, sentinel("OVERRIDE_NOTE")]);
  await asUser(admin, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'rate_card', $2, 'text/csv', 3, decode($3, 'hex'), 'abc')", [w.t1.id, `${sentinel("RATE_FILE")}.csv`, sha256Hex("abc")]);
  await sql("insert into public.rate_card_imports (tenant_id, rate_card_id, file_id, detected, created_by) select $1, $2, f.id, $3::jsonb, $4 from public.uploaded_files f where f.filename like $5", [w.t1.id, f.cardId, JSON.stringify({ headers: [sentinel("IMPORT_HEADER")] }), admin, `${T}_RATE_FILE%`]);

  // --- M4: fee schedule text --------------------------------------------------------------------------------------------
  const [fs] = await asUser<{ r: { scheduleId: string; versionId: string } }>(admin, "select public.create_fee_schedule($1, 'Standard fees', null, 'invoice_line') as r", [w.t1.id]);
  const [rule] = await asUser<{ id: string }>(admin, "insert into public.fee_rules (version_id, tenant_id, position, key, name, category, scope, basis, method, amount) values ($1, $2, 0, 'pick', 'Pick fee', 'pick_pack', 'order', 'unit', 'flat', 1.00) returning id", [fs!.r.versionId, w.t1.id]);
  await asUser(admin, "insert into public.fee_rule_sources (rule_id, tenant_id, source_reference) values ($1, $2, $3)", [rule!.id, w.t1.id, sentinel("FEE_SOURCE")]);
  await asUser(admin, "insert into public.fee_schedule_version_notes (version_id, tenant_id, notes) values ($1, $2, $3)", [fs!.r.versionId, w.t1.id, sentinel("FEE_NOTES")]);
  await asUser(admin, "select public.activate_fee_schedule_version($1, '2026-01-01')", [fs!.r.versionId]);
  await asUser(admin, "select public.assign_fee_schedule($1, $2)", [w.brandA.id, fs!.r.scheduleId]);

  // --- M3/M4: a forecast with load issues and a failure detail ----------------------------------------------------------
  const summary = { basis: "assumptions", monthlyOrders: "1000.00", weightSum: "1000.00", shipping: { definite: "0.00", perOrder: "9.60" }, processing: { definite: "0.00", estimated: "0.00", perOrder: "0.00" }, allocated: { perOrder: "0.00" }, allIn: { perOrder: "9.60" }, monthly: { total: "0.00", totalE4: 0 }, minimum: { topUp: "0.00" }, minimumStatus: "none", loadIssues: [sentinel("SUMMARY_ISSUE")] };
  const pins = { feeScheduleVersionId: fs!.r.versionId, rateCardVersionId: f.v1, ruleVersionIds: [], zipListIds: [], overrideIds: [], loadIssues: [sentinel("PIN_ISSUE")] };
  const [fp] = await asUser<{ id: string }>(w.brandA.admin.id, "select public.save_forecast_run($1, $2, 'Forecast', $3::jsonb, $4::jsonb, $5::jsonb, '2.2.0', '1.0.0') as id", [w.brandA.id, f.cardId, JSON.stringify({ asOfDate: f.today, monthlyOrders: "1000.00" }), JSON.stringify(summary), JSON.stringify(pins)]);
  await sql("insert into public.simulation_run_failures (run_id, tenant_id, detail) select id, tenant_id, $2 from public.simulation_runs where project_id = $1", [fp!.id, sentinel("FAILURE_DETAIL")]);

  // --- M5: everything staff write about adjustments ----------------------------------------------------------------------
  const policy = await setPolicy(admin, w.t1.id, w.brandA.id, "reweight", "postage_difference", "pass_through", null, sentinel("POLICY_NOTE"));
  await setPolicy(admin, w.t1.id, w.brandA.id, "reweight", "separate_fee", "manual_approval", null, sentinel("POLICY_NOTE_2"));
  await setPolicy(admin, w.t1.id, null, "remeasure", "separate_fee", "absorbed", null, `${sentinel("POLICY_NOTE_3")} ${SENTINELS.absorbed}`);
  const baseline = (await asUser<{ id: string }>(admin, "select public.save_adjustment_baseline($1, $2, 'ups', null, '2026-01-01', '2026-01-31', 1000, 40, $3) as id", [w.t1.id, w.brandA.id, `${sentinel("BASELINE_NOTE")} ${SENTINELS.incidence}`]))[0]!.id;
  const estimate = (await asUser<{ id: string }>(admin, "select public.save_risk_estimate($1, $2, $3, $4::jsonb, $5::jsonb, '1.0.0') as id", [w.t1.id, w.brandA.id, `${sentinel("ESTIMATE")} ${SENTINELS.severity}`, JSON.stringify({ incidence: SENTINELS.incidence, severity: SENTINELS.severity }), JSON.stringify({ v: 1, absorbed: SENTINELS.absorbed })]))[0]!.id;
  const scenario = await saveScenario(f, { name: `${sentinel("SCENARIO")} ${SENTINELS.absorbed}`, input: scenarioInput(f), result: scenarioResult() });
  const published = await publish(f, scenario, { internal: `${sentinel("PUBLISHED_NOTE")} ${SENTINELS.incidence}` });
  const content = Buffer.from("ship_date,carrier,package_ref,customer_charge_original\n2026-01-05,ups,1Z1,12.79\n");
  const [file] = await asUser<{ id: string }>(admin, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', $2, 'text/csv', $3, decode($4, 'hex'), $5) returning id", [w.t1.id, `${sentinel("HISTORY_FILE")}.csv`, content.length, sha256Hex(content), content]);
  const imp = (await asUser<{ r: { importId: string } }>(admin, "select public.create_adjustment_import($1, $2, $3::jsonb) as r", [file!.id, `${sentinel("IMPORT_NAME")} ${SENTINELS.absorbed}`, JSON.stringify({ headers: ["ship_date", "carrier", "package_ref", "customer_charge_original"], sampleRows: [{ ship_date: sentinel("SAMPLE_ROW") }] })]))[0]!.r.importId;
  await asUser(admin, "select public.set_adjustment_import_mapping($1, $2::jsonb, $3::jsonb, 'refuse', true)", [imp, JSON.stringify({ fields: { ship_date: "ship_date" } }), JSON.stringify({ counts: { rows: 2, accepted: 2 } })]);
  await asUser(admin, "select public.append_adjustment_records($1, 1, $2::jsonb)", [imp, JSON.stringify([
    { ship_date: "2026-01-05", carrier_code: "ups", adjustment_type: "reweight", cause: "carrier_reweigh", reason_text: `${sentinel("REASON")} ${SENTINELS.incidence}`, package_ref: sentinel("PKG_REF"), declared_weight_lb: "3", actual_weight_lb: "5", original_charge: "12.79", corrected_charge: "13.35", brand_id: w.brandA.id },
    { ship_date: "2026-01-06", carrier_code: "ups", adjustment_type: "reweight", cause: "other", declared_weight_basis: "missing" },
  ])]);
  // A second import is left part-way, with its raw file still stored.
  const [file2] = await asUser<{ id: string }>(admin, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'adjustment_import', $2, 'text/csv', $3, decode($4, 'hex'), $5) returning id", [w.t1.id, `${sentinel("OPEN_FILE")}.csv`, content.length, sha256Hex(content), content]);
  await asUser(admin, "select public.create_adjustment_import($1, $2, '{}')", [file2!.id, sentinel("OPEN_IMPORT")]);
  await asUser(admin, "select public.finalize_adjustment_import($1)", [imp]);

  // Another 3PL's own data (neither t1's staff nor customers may see it) and a third 3PL that gets suspended.
  await asUser(w.t2.admin.id, "select public.set_adjustment_policy($1, null, 'reweight', 'separate_fee', 'absorbed', null, $2)", [w.t2.id, "FOREIGN_TENANT_NOTE"]);
  const t3Policy = (await asUser<{ id: string }>(suspended.id, "select public.set_adjustment_policy($1, null, 'reweight', 'separate_fee', 'absorbed') as id", [f.t3.id]))[0]!.id;
  const t3Baseline = (await asUser<{ id: string }>(suspended.id, "select public.save_adjustment_baseline($1, null, null, null, '2026-01-01', '2026-01-31', 5) as id", [f.t3.id]))[0]!.id;
  ids = { policy, import: imp, file: file!.id, scenario, published, baseline, estimate, t3Policy, t3Baseline };
});

// ---------------------------------------------------------------------------
// Role matrix: every M5 table, every kind of user
// ---------------------------------------------------------------------------
describe("role matrix over every M5 table", () => {
  const nonStaff = () => [
    ["platform administrator (not a member)", w.platformAdmin], ["3PL employee", w.t1.employee], ["customer A administrator", w.brandA.admin], ["customer A employee", w.brandA.employee],
    ["customer B administrator", w.brandB.admin], ["customer C administrator (other 3PL)", w.brandC.admin], ["other 3PL's administrator", w.t2.admin], ["outsider", w.outsider],
  ] as const;

  it("only the account's administrators read a row; nobody inserts, updates or deletes through the Data API", async () => {
    for (const table of M5_TABLES) {
      const rows = await asUser(w.t1.admin.id, `select * from public.${table} where tenant_id = $1`, [w.t1.id]);
      expect(rows.length, `${table} for the administrator`).toBeGreaterThan(0);
      expect((await asUser(f.dual.id, `select * from public.${table} where tenant_id = $1`, [w.t1.id])).length, `${table} for the dual-role user as staff`).toBe(rows.length);
      for (const [label, user] of nonStaff()) expect(await asUser(user.id, `select * from public.${table} where tenant_id = $1`, [w.t1.id]), `${table}: ${label}`).toHaveLength(0);
      // Every user, the administrator included: no write privilege of any kind.
      for (const user of [w.t1.admin, f.dual, w.brandA.admin, w.t2.admin]) {
        await expectCode(asUser(user.id, `insert into public.${table} default values`), "42501", /permission denied for table/);
        await expectCode(asUser(user.id, `update public.${table} set tenant_id = tenant_id`), "42501", /permission denied for table/);
        await expectCode(asUser(user.id, `delete from public.${table}`), "42501", /permission denied for table/);
      }
      // Not even a table-level grant on an unrelated column is hiding behind that message.
      await expectCode(asUser(null, `select * from public.${table}`), "42501", /permission denied for table/);
      await expectCode(asUser(null, `insert into public.${table} default values`), "42501", /permission denied for table/);
    }
  });

  it("a suspended tenant's administrator reads nothing at once", async () => {
    expect(await asUser(suspended.id, "select * from public.adjustment_policies")).toHaveLength(1);
    await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'suspended')", [f.t3.id]);
    try {
      for (const table of M5_TABLES) expect(await asUser(suspended.id, `select * from public.${table}`), table).toHaveLength(0);
    } finally {
      await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'active')", [f.t3.id]);
    }
  });

  it("each table has exactly two policies (a permissive staff read and a restrictive 'never writable') and no write grant", async () => {
    for (const table of M5_TABLES) {
      const policies = await sql<{ policyname: string; permissive: string; cmd: string; roles: string; qual: string; with_check: string | null }>(
        "select policyname, permissive, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = $1 order by policyname", [table]);
      expect(policies.map((p) => [p.policyname, p.permissive, p.cmd, p.roles]), table).toEqual([
        [`${table}_staff_only`, "RESTRICTIVE", "ALL", "{authenticated}"],
        [`${table}_staff_read`, "PERMISSIVE", "SELECT", "{authenticated}"],
      ]);
      for (const p of policies) {
        expect(p.qual, `${p.policyname} qual`).toBe("(tenant_id IN ( SELECT app.adjustment_tenant_ids() AS adjustment_tenant_ids))");
        expect(`${p.qual} ${p.with_check}`, p.policyname).not.toMatch(/is_platform_admin|is_member_of_tenant|has_brand_permission|modeling_visible/);
      }
      expect(policies.find((p) => p.policyname.endsWith("_staff_only"))!.with_check).toBe("false");
      const grants = await sql<{ grantee: string; privilege_type: string }>("select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated', 'public') order by 1, 2", [table]);
      expect(grants, table).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
      expect(await sql("select 1 from pg_class where oid = ('public.' || $1)::regclass and relrowsecurity", [table]), `${table} has row level security`).toHaveLength(1);
      expect(await sql("select 1 from information_schema.column_privileges where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE')", [table]), `${table} column writes`).toHaveLength(0);
    }
    // No view, in any exposed schema, stands in front of M5 data (a view runs as its owner and would bypass RLS).
    expect(await sql("select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any ($1) and c.relkind in ('v', 'm')", [API_SCHEMAS])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Role matrix: every M5 function
// ---------------------------------------------------------------------------
describe("role matrix over every M5 function", () => {
  const dummy = "00000000-0000-4000-8000-000000000000";
  type Case = { name: string; kind: "tenant" | "row"; call: (tenant: string, brand: string | null, id: Record<string, string>) => [string, unknown[]] };
  const cases: Case[] = [
    { name: "set_adjustment_policy", kind: "tenant", call: (t) => ["select public.set_adjustment_policy($1, null, 'reweight', 'separate_fee', 'absorbed')", [t]] },
    { name: "save_adjustment_baseline", kind: "tenant", call: (t) => ["select public.save_adjustment_baseline($1, null, null, null, '2025-01-01', '2025-01-31', 10)", [t]] },
    { name: "save_adjustment_scenario", kind: "tenant", call: (t) => ["select public.save_adjustment_scenario($1, null, 'n', 'reweight', '{}', '{}', '{}', 'v')", [t]] },
    { name: "save_risk_estimate", kind: "tenant", call: (t) => ["select public.save_risk_estimate($1, null, 'n', '{}', '{}', 'v')", [t]] },
    { name: "end_adjustment_policy", kind: "row", call: (_t, _b, i) => ["select public.end_adjustment_policy($1)", [i.policy!]] },
    { name: "create_adjustment_import", kind: "row", call: (_t, _b, i) => ["select public.create_adjustment_import($1, 'n', '{}')", [i.file!]] },
    { name: "set_adjustment_import_mapping", kind: "row", call: (_t, _b, i) => ["select public.set_adjustment_import_mapping($1, '{\"fields\":{}}')", [i.import!]] },
    { name: "append_adjustment_records", kind: "row", call: (_t, _b, i) => ["select public.append_adjustment_records($1, 1, '[{}]')", [i.import!]] },
    { name: "finalize_adjustment_import", kind: "row", call: (_t, _b, i) => ["select public.finalize_adjustment_import($1)", [i.import!]] },
    { name: "discard_adjustment_import", kind: "row", call: (_t, _b, i) => ["select public.discard_adjustment_import($1)", [i.import!]] },
    { name: "withdraw_adjustment_import", kind: "row", call: (_t, _b, i) => ["select public.withdraw_adjustment_import($1)", [i.import!]] },
    { name: "reset_adjustment_import", kind: "row", call: (_t, _b, i) => ["select public.reset_adjustment_import($1)", [i.import!]] },
    { name: "delete_adjustment_baseline", kind: "row", call: (_t, _b, i) => ["select public.delete_adjustment_baseline($1)", [i.baseline!]] },
    { name: "archive_adjustment_scenario", kind: "row", call: (_t, _b, i) => ["select public.archive_adjustment_scenario($1)", [i.scenario!]] },
    { name: "archive_risk_estimate", kind: "row", call: (_t, _b, i) => ["select public.archive_risk_estimate($1)", [i.estimate!]] },
    { name: "preview_customer_example", kind: "row", call: (_t, b, i) => ["select public.preview_customer_example($1, $2)", [i.scenario!, b!]] },
    { name: "publish_customer_example", kind: "row", call: (_t, b, i) => ["select public.publish_customer_example($1, $2, 'Title')", [i.scenario!, b!]] },
    { name: "retire_customer_example", kind: "row", call: (_t, _b, i) => ["select public.retire_customer_example($1)", [i.published!]] },
    { name: "adjustment_example_state", kind: "row", call: (_t, _b, i) => ["select public.adjustment_example_state($1)", [i.published!]] },
    { name: "adjustment_example_states", kind: "tenant", call: (t) => ["select public.adjustment_example_states($1)", [t]] },
  ];

  it("the 20 staff functions refuse everyone who is not the account's administrator with one answer, and unknown ids look the same", async () => {
    expect(cases).toHaveLength(20);
    const target = { policy: ids.policy, file: ids.file, import: ids.import, baseline: ids.baseline, scenario: ids.scenario, estimate: ids.estimate, published: ids.published };
    const outsiders: [string, TestUser][] = [
      ["platform administrator", w.platformAdmin], ["3PL employee", w.t1.employee], ["customer A administrator", w.brandA.admin], ["customer A employee", w.brandA.employee],
      ["customer B administrator", w.brandB.admin], ["other 3PL's administrator", w.t2.admin], ["outsider", w.outsider],
    ];
    for (const c of cases) {
      for (const [label, user] of outsiders) {
        const [text, params] = c.call(w.t1.id, w.brandA.id, target);
        if (c.kind === "tenant") await expectCode(asUser(user.id, text, params), "42501", /^not allowed$/).catch((e) => { throw new Error(`${c.name} as ${label}: ${e.message}`); });
        else await expectCode(asUser(user.id, text, params), "P0002", /^not found$/).catch((e) => { throw new Error(`${c.name} as ${label}: ${e.message}`); });
        await expectCode(asUser(null, text, params), "42501", /permission denied for function/).catch((e) => { throw new Error(`${c.name} as anon: ${e.message}`); });
      }
      if (c.kind === "row") {
        // The administrator asking about a row that does not exist gets the very same words.
        const [text, params] = c.call(w.t1.id, w.brandA.id, { policy: dummy, file: dummy, import: dummy, baseline: dummy, scenario: dummy, estimate: dummy, published: dummy });
        await expectCode(asUser(w.t1.admin.id, text, params), "P0002", /^not found$/).catch((e) => { throw new Error(`${c.name} unknown id: ${e.message}`); });
      }
    }
    // The suspended tenant's administrator, and a tenant admin using another tenant's ids, get the same refusals.
    await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'suspended')", [f.t3.id]);
    try {
      await expectCode(asUser(suspended.id, "select public.end_adjustment_policy($1)", [ids.t3Policy]), "P0002", /^not found$/);
      await expectCode(asUser(suspended.id, "select public.delete_adjustment_baseline($1)", [ids.t3Baseline]), "P0002", /^not found$/);
      await expectCode(asUser(suspended.id, "select public.set_adjustment_policy($1, null, 'remeasure', 'separate_fee', 'absorbed')", [f.t3.id]), "42501", /^not allowed$/);
    } finally {
      await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'active')", [f.t3.id]);
    }
    await expectCode(asUser(w.t2.admin.id, "select public.end_adjustment_policy($1)", [ids.t3Policy]), "P0002", /^not found$/);
  });

  it("the two reading functions answer an empty list, not an error, to everyone who may not read", async () => {
    for (const user of [w.platformAdmin, w.brandB.admin, w.brandC.admin, w.t2.admin, w.outsider]) {
      expect((await asUser<{ r: unknown[] }>(user.id, "select public.brand_adjustment_examples($1) as r", [w.brandA.id]))[0]!.r, user.email).toEqual([]);
      expect((await asUser<{ r: unknown[] }>(user.id, "select public.adjustment_records_json($1) as r", [ids.import]))[0]!.r, user.email).toEqual([]);
    }
    for (const user of [w.brandA.admin, w.brandA.employee, w.t1.employee]) {
      expect((await asUser<{ r: unknown[] }>(user.id, "select public.adjustment_records_json($1) as r", [ids.import]))[0]!.r, user.email).toEqual([]);
    }
    await expectCode(asUser(null, "select public.brand_adjustment_examples($1)", [w.brandA.id]), "42501", /permission denied for function/);
    // The offboarding and internal functions cannot be called by any signed-in user.
    for (const fn of ["select app.purge_tenant_adjustment_data($1)", "select app.purge_brand_adjustment_data($1)", "select app.adjustment_handling($1, null, 'reweight', 'separate_fee', current_date)", "select app.build_customer_example($1, $1)"]) {
      for (const user of [w.t1.admin, w.brandA.admin]) await expectCode(asUser(user.id, fn, [w.t1.id]), "42501", /permission denied/);
    }
  });
});

// ---------------------------------------------------------------------------
// The generic leakage scan
// ---------------------------------------------------------------------------
interface Relation { schema: string; name: string; kind: string }
async function relations(): Promise<Relation[]> {
  return sql<Relation>(
    `select n.nspname as schema, c.relname as name, c.relkind as kind
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any ($1) and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege('authenticated', c.oid, 'select') or has_any_column_privilege('authenticated', c.oid, 'select'))
      order by 1, 2`, [API_SCHEMAS]);
}

/** Relations that hold at least one row the user can see, with the text of every visible row. */
async function visible(user: TestUser | null): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const r of await relations()) {
    const rows = await asUser<{ t: string }>(user?.id ?? null, `select to_jsonb(x)::text as t from "${r.schema}"."${r.name}" x`);
    if (rows.length) out[`${r.schema}.${r.name}`] = rows.map((x) => x.t);
  }
  return out;
}

/** M1 to M4 relations a customer's own members legitimately read (their own tenant's, brand's and card's rows only). */
const CUSTOMER_MAY_READ = new Set([
  "public.brand_fee_schedule_assignments", "public.brand_rate_card_assignments", "public.brands", "public.carriers", "public.customer_surcharge_overrides", "public.fee_rules", "public.fee_schedule_versions", "public.fee_schedules",
  "public.invitations", "public.memberships", "public.permissions", "public.profiles", "public.rate_card_rows", "public.rate_card_service_terms", "public.rate_card_versions", "public.rate_card_zones",
  "public.rate_cards", "public.role_permissions", "public.roles", "public.shipping_services", "public.simulation_projects", "public.simulation_run_fee_contexts",
  "public.simulation_runs", "public.tenants",
  // Platform-scope reference data (published for everyone; other tests in the shared database create some).
  "public.surcharge_rule_versions", "public.surcharge_rules", "public.zip_list_entries", "public.zip_lists",
]);

describe("what every kind of user can read across ALL relations (nothing is listed by name that could drift)", () => {
  it("customers read only their own M1 to M4 rows; no M5 relation and no staff-only relation is ever readable", async () => {
    for (const user of [w.brandA.admin, w.brandA.employee, w.brandB.admin, w.brandC.admin]) {
      const seen = await visible(user);
      for (const name of Object.keys(seen)) {
        expect(CUSTOMER_MAY_READ.has(name), `${user.email} can read rows of ${name}`).toBe(true);
        expect(STAFF_ONLY.some((s) => name.endsWith(`.${s}`)), `${user.email} must not read ${name}`).toBe(false);
      }
      for (const [name, rows] of Object.entries(seen)) for (const row of rows) expect(row, `${user.email}: ${name}`).not.toMatch(SENTINEL_PATTERN);
    }
  });

  it("a customer of another 3PL, an outsider, a platform administrator and the other 3PL's staff read none of this 3PL's data (and this 3PL's people none of theirs)", async () => {
    for (const user of [w.brandC.admin, w.outsider, w.platformAdmin, w.t2.admin]) {
      const seen = await visible(user);
      for (const [name, rows] of Object.entries(seen)) for (const row of rows) expect(row, `${user.email}: ${name}`).not.toMatch(SENTINEL_PATTERN);
    }
    expect(JSON.stringify(await visible(w.t2.admin))).toContain("FOREIGN_TENANT_NOTE"); // their own note is theirs to read
    for (const user of [w.t1.admin, w.t1.employee, w.brandA.admin, w.brandB.admin]) expect(JSON.stringify(await visible(user)), user.email).not.toContain("FOREIGN_TENANT_NOTE");
    // A platform administrator who is not a member reads reference data, tenants and their own profile: no more.
    const reference = ["public.carriers", "public.shipping_services", "public.permissions", "public.roles", "public.role_permissions", "public.profiles", "public.surcharge_rule_versions", "public.surcharge_rules", "public.zip_list_entries", "public.zip_lists"];
    const platform = Object.keys(await visible(w.platformAdmin));
    expect(platform.filter((n) => ![...reference, "public.tenants"].includes(n))).toEqual([]);
    const outsider = Object.keys(await visible(w.outsider));
    expect(outsider.filter((n) => !reference.includes(n))).toEqual([]);
    await expectCode(visible(null), "42501", /permission denied for table/);
  });

  it("the 3PL's own staff do read their staff text (the sentinels exist and are reachable by them): the scan is not vacuous", async () => {
    const staff = await visible(w.t1.admin);
    const text = JSON.stringify(staff);
    for (const planted of ["TERMS_SOURCE", "RULE_SOURCE", "ZIP_SOURCE", "OVERRIDE_NOTE", "FEE_SOURCE", "FEE_NOTES", "PIN_ISSUE", "FAILURE_DETAIL", "POLICY_NOTE", "BASELINE_NOTE", "ESTIMATE", "SCENARIO", "PUBLISHED_NOTE", "REASON", "PKG_REF", "IMPORT_NAME", "SAMPLE_ROW", "OPEN_FILE", "OPEN_IMPORT"]) {
      expect(text, planted).toContain(`${T}_${planted}`);
    }
    for (const numeric of [SENTINELS.incidence, SENTINELS.severity, SENTINELS.absorbed]) expect(text, numeric).toContain(numeric);
    // A relation readable by a customer must not hold a number of the sentinel family either, even where it is readable by staff.
    expect(JSON.stringify(await visible(w.brandA.admin))).not.toMatch(SENTINEL_PATTERN);
  });

  it("functions a customer can call return nothing staff wrote: pricing context, fee snapshot, rate rows, the example projection", async () => {
    const calls: [string, unknown[]][] = [
      ["select public.pricing_rules_for_card($1, current_date, null, null, true) as r", [f.cardId]],
      ["select public.pricing_rules_for_card($1, current_date) as r", [f.cardId]],
      ["select public.rate_card_rows_json($1) as r", [f.v1]],
      ["select public.rate_card_zones_json($1) as r", [f.v1]],
      ["select public.brand_fee_schedule_on($1, current_date) as r", [w.brandA.id]],
      ["select public.brand_adjustment_examples($1) as r", [w.brandA.id]],
    ];
    for (const user of [w.brandA.admin, w.brandA.employee]) {
      for (const [text, params] of calls) expect(JSON.stringify((await asUser(user.id, text, params))[0]), `${user.email}: ${text}`).not.toMatch(SENTINEL_PATTERN);
    }
    // Errors never carry values either: a malformed call as a customer names no staff text.
    for (const text of ["select public.fee_schedule_snapshot($1)", "select public.publish_customer_example($1, $2, 'x')"]) {
      const err = (await asUser(w.brandA.admin.id, text, [ids.scenario, w.brandA.id].slice(0, text.includes("$2") ? 2 : 1)).catch((e) => e)) as Error;
      expect(String(err.message ?? err)).not.toMatch(SENTINEL_PATTERN);
    }
  });

  it("every relation a customer or signed-out visitor can reach is accounted for, and anon reaches none", async () => {
    const authenticated = (await relations()).map((r) => `${r.schema}.${r.name}`);
    expect(authenticated).toEqual(KNOWN_READABLE_RELATIONS);
    const anon = await sql<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any ($1) and c.relkind in ('r', 'p', 'v', 'm', 'f') and (has_any_column_privilege('anon', c.oid, 'select') or has_any_column_privilege('anon', c.oid, 'insert')
              or has_any_column_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`, [API_SCHEMAS]);
    expect(anon).toEqual([]);
    // Relations the Data API roles can write to (column grants included): no M5, step-0 or run table is among them.
    const writable = await sql<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any ($1) and c.relkind in ('r', 'p') and (has_any_column_privilege('authenticated', c.oid, 'insert') or has_any_column_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
        order by 1`, [API_SCHEMAS]);
    expect(writable.map((r) => r.name)).toEqual(KNOWN_WRITABLE_RELATIONS);
    for (const t of [...M5_TABLES, "simulation_run_failures", "simulation_results", "simulation_runs", "audit_events"]) expect(writable.map((r) => r.name)).not.toContain(t);
  });

  it("the columns of every readable relation are pinned: a new column forces a decision about who may read it", async () => {
    const cols = await sql<{ rel: string; cols: string }>(
      `select c.relname as rel, string_agg(a.attname, ',' order by a.attnum) as cols
         from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = any ($1) and c.relkind in ('r', 'p', 'v', 'm', 'f') and (has_table_privilege('authenticated', c.oid, 'select') or has_any_column_privilege('authenticated', c.oid, 'select'))
        group by c.relname order by 1`, [API_SCHEMAS]);
    const actual = Object.fromEntries(cols.map((r) => [r.rel, r.cols.split(",")]));
    expect(actual).toEqual(COLUMN_SNAPSHOT);
    // The two columns M5 removed from customer-readable tables are really gone.
    expect(actual.rate_card_service_terms).not.toContain("source_reference");
    expect(actual.customer_surcharge_overrides).not.toContain("reference");
  });
});

// ---------------------------------------------------------------------------
// Catalog invariants for functions
// ---------------------------------------------------------------------------
describe("functions: inventory, search_path, privileges, platform administrators", () => {
  it("only the three known places mention is_platform_admin: no M5 policy or function does", async () => {
    const policies = await sql<{ n: string }>("select tablename || '.' || policyname as n from pg_policies where schemaname in ('public', 'app') and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%is_platform_admin%' order by 1");
    expect(policies.map((p) => p.n)).toEqual(["tenants.tenants_read"]);
    const fns = await sql<{ n: string }>("select n.nspname || '.' || p.proname as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and p.prosrc ilike '%is_platform_admin%' order by 1");
    expect(fns.map((x) => x.n)).toEqual(["public.is_platform_admin", "public.platform_set_tenant_status"]);
  });

  it("every SECURITY DEFINER function in public or app pins an empty search_path", async () => {
    const unpinned = await sql<{ n: string }>(
      `select n.nspname || '.' || p.proname as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app') and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false) order by 1`);
    expect(unpinned).toEqual([]);
    // The trigger and guard functions that are not definers pin it too, so nothing resolves a name through a caller's path.
    const loose = await sql<{ n: string }>(
      `select n.nspname || '.' || p.proname as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app') and p.prolang = (select oid from pg_language where lanname = 'plpgsql') and not coalesce(p.proconfig @> array['search_path=""'], false) order by 1`);
    expect(loose).toEqual([]);
  });

  it("no function in public or app is executable by PUBLIC or anon; the internal M5 helpers are not executable by signed-in users", async () => {
    const open = await sql<{ n: string }>(
      `select n.nspname || '.' || p.proname as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app') and (has_function_privilege('anon', p.oid, 'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))
        order by 1`);
    expect(open).toEqual([]);
    const internal = ["adjustment_policy_at", "adjustment_handling", "adjustment_lock", "adjustment_rows_problem", "build_customer_example", "example_state", "scenario_result_problem", "example_packages",
      "purge_tenant_adjustment_data", "purge_brand_adjustment_data", "guard_adjustment_write", "audit_adjustments", "customer_json_ok", "shape_published_payload", "shape_brand_example", "plain_text_ok",
      "adjustment_header_forbidden", "try_date", "try_uuid", "try_dec", "add_problem", "summary_without_load_issues"];
    for (const fn of internal) {
      const rows = await sql<{ ok: boolean }>("select has_function_privilege('authenticated', p.oid, 'execute') as ok from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = $1", [fn]);
      expect(rows.length, fn).toBeGreaterThan(0);
      expect(rows.every((r) => r.ok === false), `${fn} must not be callable by signed-in users`).toBe(true);
    }
  });

  it("the functions a signed-in user can execute are exactly these (one overload per name); a new one forces a decision", async () => {
    expect(await sql("select proname from pg_proc where pronamespace = 'public'::regnamespace group by proname having count(*) > 1")).toEqual([]);
    const pub = await sql<{ n: string }>("select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as n from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') order by 1");
    expect(pub.map((r) => r.n)).toEqual(PUBLIC_FUNCTIONS);
    const app = await sql<{ n: string }>("select p.proname as n from pg_proc p where p.pronamespace = 'app'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') order by 1");
    expect(app.map((r) => r.n)).toEqual(APP_FUNCTIONS);
    // Every one of the M5 functions above is a staff or customer entry point named in the design.
    const m5 = pub.map((r) => r.n.split("(")[0]!).filter((n) => /adjustment|customer_example|risk_estimate/.test(n)).sort();
    expect(m5).toEqual(["adjustment_example_state", "adjustment_example_states", "adjustment_records_json", "append_adjustment_records", "archive_adjustment_scenario", "archive_risk_estimate", "brand_adjustment_examples", "create_adjustment_import",
      "delete_adjustment_baseline", "discard_adjustment_import", "end_adjustment_policy", "finalize_adjustment_import", "preview_customer_example", "publish_customer_example", "reset_adjustment_import",
      "retire_customer_example", "save_adjustment_baseline", "save_adjustment_scenario", "save_risk_estimate", "set_adjustment_import_mapping", "set_adjustment_policy", "withdraw_adjustment_import"]);
  });
});

// The snapshots below are the decision record: each is exactly what the test's own catalog query returns today. When one of them
// fails, read the diff, decide whether the new relation, column or function may be reachable by signed-in users, then update the list.
const KNOWN_READABLE_RELATIONS: string[] = [
  "public.adjustment_baselines",
  "public.adjustment_imports",
  "public.adjustment_policies",
  "public.adjustment_records",
  "public.adjustment_scenarios",
  "public.audit_events",
  "public.brand_fee_schedule_assignments",
  "public.brand_rate_card_assignments",
  "public.brands",
  "public.carriers",
  "public.customer_surcharge_override_notes",
  "public.customer_surcharge_overrides",
  "public.fee_rule_sources",
  "public.fee_rules",
  "public.fee_schedule_version_notes",
  "public.fee_schedule_versions",
  "public.fee_schedules",
  "public.invitations",
  "public.memberships",
  "public.order_datasets",
  "public.order_lines",
  "public.orders",
  "public.packages",
  "public.permissions",
  "public.profiles",
  "public.published_adjustment_examples",
  "public.rate_card_imports",
  "public.rate_card_rows",
  "public.rate_card_service_term_sources",
  "public.rate_card_service_terms",
  "public.rate_card_versions",
  "public.rate_card_zones",
  "public.rate_cards",
  "public.risk_estimates",
  "public.role_permissions",
  "public.roles",
  "public.shipments",
  "public.shipping_services",
  "public.simulation_monthly_lines",
  "public.simulation_order_results",
  "public.simulation_projects",
  "public.simulation_results",
  "public.simulation_run_contexts",
  "public.simulation_run_failures",
  "public.simulation_run_fee_contexts",
  "public.simulation_runs",
  "public.sku_profiles",
  "public.surcharge_rule_versions",
  "public.surcharge_rules",
  "public.tenants",
  "public.uploaded_files",
  "public.zip_list_entries",
  "public.zip_lists"
];
const KNOWN_WRITABLE_RELATIONS: string[] = [
  "brand_rate_card_assignments",
  "brands",
  "customer_surcharge_override_notes",
  "customer_surcharge_overrides",
  "fee_rule_sources",
  "fee_rules",
  "fee_schedule_version_notes",
  "fee_schedule_versions",
  "fee_schedules",
  "invitations",
  "memberships",
  "order_datasets",
  "profiles",
  "rate_card_imports",
  "rate_card_rows",
  "rate_card_service_term_sources",
  "rate_card_service_terms",
  "rate_card_versions",
  "rate_card_zones",
  "rate_cards",
  "simulation_projects",
  "sku_profiles",
  "surcharge_rule_versions",
  "surcharge_rules",
  "tenants",
  "uploaded_files",
  "zip_list_entries",
  "zip_lists"
];
const COLUMN_SNAPSHOT: Record<string, string[]> = {
  "adjustment_baselines": [
    "id",
    "tenant_id",
    "brand_id",
    "carrier_code",
    "service_id",
    "period_start",
    "period_end",
    "packages_total",
    "labels_missing_weight",
    "note",
    "created_by",
    "created_at"
  ],
  "adjustment_imports": [
    "id",
    "tenant_id",
    "file_id",
    "name",
    "status",
    "detected",
    "mapping",
    "validation",
    "duplicate_handling",
    "row_count",
    "accepted_count",
    "committed_count",
    "skipped_count",
    "attested_by",
    "attested_at",
    "created_by",
    "created_at",
    "committed_at"
  ],
  "adjustment_policies": [
    "id",
    "tenant_id",
    "brand_id",
    "adjustment_type",
    "component",
    "handling",
    "valid_from",
    "valid_to",
    "internal_note",
    "created_by",
    "created_at"
  ],
  "adjustment_records": [
    "id",
    "tenant_id",
    "import_id",
    "row_no",
    "brand_id",
    "ship_date",
    "adjusted_on",
    "carrier_code",
    "service_id",
    "service_text",
    "adjustment_type",
    "cause",
    "reason_text",
    "package_ref",
    "declared_weight_lb",
    "declared_weight_basis",
    "actual_weight_lb",
    "orig_length_in",
    "orig_width_in",
    "orig_height_in",
    "corr_length_in",
    "corr_width_in",
    "corr_height_in",
    "original_charge",
    "corrected_charge",
    "separate_fee",
    "handling_recorded",
    "postage_difference"
  ],
  "adjustment_scenarios": [
    "id",
    "tenant_id",
    "brand_id",
    "name",
    "adjustment_type",
    "input",
    "result",
    "engine_version",
    "rate_card_version_id",
    "rule_version_ids",
    "override_ids",
    "policy_snapshot",
    "priced_on",
    "archived_at",
    "created_by",
    "created_at"
  ],
  "audit_events": [
    "id",
    "occurred_at",
    "actor_id",
    "tenant_id",
    "brand_id",
    "action",
    "entity_type",
    "entity_id",
    "metadata"
  ],
  "brand_fee_schedule_assignments": [
    "id",
    "tenant_id",
    "brand_id",
    "schedule_id",
    "assigned_by",
    "assigned_at",
    "unassigned_at",
    "unassigned_by"
  ],
  "brand_rate_card_assignments": [
    "id",
    "tenant_id",
    "brand_id",
    "rate_card_id",
    "allowed_service_ids",
    "assigned_by",
    "assigned_at",
    "unassigned_at",
    "unassigned_by",
    "default_origin_zip"
  ],
  "brands": [
    "id",
    "tenant_id",
    "name",
    "status",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "carriers": [
    "code",
    "name",
    "website"
  ],
  "customer_surcharge_override_notes": [
    "override_id",
    "tenant_id",
    "reference",
    "updated_by",
    "updated_at"
  ],
  "customer_surcharge_overrides": [
    "id",
    "tenant_id",
    "brand_id",
    "rule_id",
    "mode",
    "amount",
    "percent",
    "effective_date",
    "expiration_date",
    "created_by",
    "created_at",
    "ended_at"
  ],
  "fee_rule_sources": [
    "rule_id",
    "tenant_id",
    "source_reference",
    "updated_by",
    "updated_at"
  ],
  "fee_rules": [
    "id",
    "version_id",
    "tenant_id",
    "position",
    "key",
    "name",
    "category",
    "scope",
    "basis",
    "method",
    "amount",
    "percent",
    "percent_base",
    "tiers",
    "included_quantity",
    "included_per",
    "minimum_charge",
    "conditions",
    "exclusive_group",
    "priority",
    "driver",
    "minimum",
    "resolved_rule_keys",
    "description",
    "help_text",
    "created_at",
    "updated_at"
  ],
  "fee_schedule_version_notes": [
    "version_id",
    "tenant_id",
    "notes",
    "updated_by",
    "updated_at"
  ],
  "fee_schedule_versions": [
    "id",
    "schedule_id",
    "tenant_id",
    "version_number",
    "status",
    "effective_date",
    "expiration_date",
    "rounding",
    "rule_count",
    "activated_at",
    "activated_by",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "fee_schedules": [
    "id",
    "tenant_id",
    "name",
    "description",
    "status",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "invitations": [
    "id",
    "tenant_id",
    "brand_id",
    "email",
    "role_key",
    "token_hash",
    "invited_by",
    "expires_at",
    "accepted_at",
    "accepted_by",
    "revoked_at",
    "created_at"
  ],
  "memberships": [
    "id",
    "user_id",
    "tenant_id",
    "brand_id",
    "role_key",
    "status",
    "invited_by",
    "created_at",
    "updated_at"
  ],
  "order_datasets": [
    "id",
    "tenant_id",
    "brand_id",
    "file_id",
    "name",
    "status",
    "detected",
    "mapping",
    "validation",
    "shared_with_brand",
    "row_count",
    "order_count",
    "shipment_count",
    "package_count",
    "line_count",
    "materialised_at",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "order_lines": [
    "id",
    "order_id",
    "dataset_id",
    "line_no",
    "sku",
    "units"
  ],
  "orders": [
    "id",
    "dataset_id",
    "tenant_id",
    "brand_id",
    "external_order_id",
    "order_date",
    "destination_zip",
    "origin_zip",
    "residential",
    "units",
    "line_count",
    "cancelled",
    "issues",
    "seq"
  ],
  "packages": [
    "id",
    "shipment_id",
    "dataset_id",
    "seq",
    "weight",
    "weight_unit",
    "length_in",
    "width_in",
    "height_in",
    "declared_value",
    "packaging_type",
    "weight_derived",
    "dimensions_derived"
  ],
  "permissions": [
    "key",
    "description"
  ],
  "profiles": [
    "id",
    "email",
    "full_name",
    "created_at",
    "updated_at"
  ],
  "published_adjustment_examples": [
    "id",
    "tenant_id",
    "brand_id",
    "source_scenario_id",
    "title",
    "note_to_customer",
    "payload",
    "payload_sha256",
    "priced_on",
    "rates_effective_from",
    "valid_through",
    "pins",
    "internal_note",
    "published_by",
    "published_at",
    "retired_at",
    "retired_by"
  ],
  "rate_card_imports": [
    "id",
    "tenant_id",
    "rate_card_id",
    "file_id",
    "status",
    "detected",
    "mapping",
    "validation",
    "version_id",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "rate_card_rows": [
    "id",
    "version_id",
    "service_id",
    "origin_prefix",
    "zone",
    "weight_min",
    "weight_max",
    "weight_unit",
    "price",
    "min_charge",
    "weight_min_lb",
    "weight_max_lb"
  ],
  "rate_card_service_term_sources": [
    "term_id",
    "tenant_id",
    "source_reference",
    "updated_by",
    "updated_at"
  ],
  "rate_card_service_terms": [
    "id",
    "version_id",
    "service_id",
    "dim_divisor",
    "dim_threshold_cubic_in",
    "dimension_rounding",
    "weight_rounding",
    "min_billable_lb",
    "dim_exempt",
    "min_charge",
    "included_surcharge_keys",
    "excluded_surcharge_keys",
    "zone_chart_key",
    "zone_independent",
    "surcharge_markup_percent"
  ],
  "rate_card_versions": [
    "id",
    "rate_card_id",
    "tenant_id",
    "version_number",
    "status",
    "effective_date",
    "expiration_date",
    "currency",
    "source_file_id",
    "validation_summary",
    "row_count",
    "activated_at",
    "activated_by",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "rate_card_zones": [
    "id",
    "version_id",
    "carrier_code",
    "origin_prefix",
    "dest_prefix_from",
    "dest_prefix_to",
    "zone",
    "zone_chart_key"
  ],
  "rate_cards": [
    "id",
    "tenant_id",
    "name",
    "description",
    "status",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "risk_estimates": [
    "id",
    "tenant_id",
    "brand_id",
    "name",
    "inputs",
    "result",
    "engine_version",
    "archived_at",
    "created_by",
    "created_at"
  ],
  "role_permissions": [
    "role_key",
    "permission_key"
  ],
  "roles": [
    "key",
    "scope",
    "label",
    "description"
  ],
  "shipments": [
    "id",
    "order_id",
    "dataset_id",
    "row_no",
    "external_shipment_id",
    "service_text",
    "service_id",
    "origin_zip",
    "destination_zip",
    "ship_date",
    "residential",
    "issues"
  ],
  "shipping_services": [
    "id",
    "carrier_code",
    "code",
    "name",
    "category",
    "is_active"
  ],
  "simulation_monthly_lines": [
    "id",
    "run_id",
    "tenant_id",
    "brand_id",
    "rule_id",
    "driver_key",
    "quantity",
    "unit_amount",
    "amount",
    "charge_class",
    "status",
    "reason"
  ],
  "simulation_order_results": [
    "id",
    "run_id",
    "tenant_id",
    "brand_id",
    "order_id",
    "first_row_no",
    "order_month",
    "fee_date",
    "fee_schedule_version_id",
    "units",
    "lines",
    "distinct_skus",
    "packages",
    "shipments",
    "assumed",
    "fee_status",
    "processing_definite",
    "processing_estimated",
    "fee_lines",
    "unresolved",
    "warning_codes",
    "in_totals"
  ],
  "simulation_projects": [
    "id",
    "tenant_id",
    "brand_id",
    "kind",
    "name",
    "description",
    "dataset_id",
    "rate_card_id",
    "shared_with_brand",
    "archived_at",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "simulation_results": [
    "id",
    "run_id",
    "tenant_id",
    "brand_id",
    "shipment_id",
    "order_id",
    "row_no",
    "status",
    "unavailable_reason",
    "rate_card_version_id",
    "ship_date",
    "zone",
    "service_id",
    "billable_lb",
    "definite",
    "estimated",
    "expected",
    "conditional_exposure",
    "unresolved",
    "lines",
    "warning_codes",
    "in_totals"
  ],
  "simulation_run_contexts": [
    "id",
    "run_id",
    "tenant_id",
    "brand_id",
    "ship_date",
    "rate_card_version_id",
    "rule_version_ids",
    "zip_list_ids",
    "override_ids",
    "load_issues",
    "unavailable_reason"
  ],
  "simulation_run_failures": [
    "run_id",
    "tenant_id",
    "detail",
    "created_at"
  ],
  "simulation_run_fee_contexts": [
    "id",
    "run_id",
    "tenant_id",
    "brand_id",
    "fee_date",
    "fee_schedule_version_id",
    "unavailable_reason"
  ],
  "simulation_runs": [
    "id",
    "project_id",
    "tenant_id",
    "brand_id",
    "kind",
    "status",
    "pricing_basis",
    "as_of_date",
    "service_override_id",
    "unmapped_policy",
    "assumptions",
    "total_shipments",
    "processed_shipments",
    "next_row_no",
    "partial_summary",
    "summary",
    "reference_data",
    "engine_version",
    "modeled_orders",
    "modeled_shipments",
    "modeled_packages",
    "ok_shipments",
    "unavailable_shipments",
    "total_definite",
    "total_estimated",
    "total_expected",
    "total_conditional",
    "total_unresolved",
    "single_input",
    "single_result",
    "error",
    "started_at",
    "last_progress_at",
    "finished_at",
    "created_by",
    "created_at",
    "fee_schedule_id",
    "monthly_fee_schedule_version_id",
    "fee_rates",
    "fee_engine_version",
    "forecast_from",
    "forecast_to",
    "forecast_days",
    "forecast_months",
    "month_profile",
    "population_orders",
    "period_orders",
    "undated_orders",
    "volume_basis",
    "monthly_orders",
    "monthly_units",
    "monthly_packages",
    "monthly_shipments",
    "processing_orders",
    "processing_definite",
    "processing_estimated",
    "fee_status_counts",
    "monthly_fixed",
    "minimum_topup",
    "minimum_status",
    "projected_monthly"
  ],
  "sku_profiles": [
    "id",
    "tenant_id",
    "brand_id",
    "sku",
    "sku_normalized",
    "unit_weight",
    "weight_unit",
    "length_in",
    "width_in",
    "height_in",
    "packaging_type",
    "source",
    "created_by",
    "created_at",
    "updated_at"
  ],
  "surcharge_rule_versions": [
    "id",
    "rule_id",
    "tenant_id",
    "version_number",
    "status",
    "charge_class",
    "applies_to_service_ids",
    "method",
    "amount",
    "percent",
    "per_unit_basis",
    "per_unit_size",
    "per_unit_free_allowance",
    "per_unit_minimum_charge",
    "billable_weight_floor_lb",
    "calculation_base",
    "conditions",
    "exclusivity_group",
    "exclusivity_priority",
    "excludes_rule_keys",
    "per_package",
    "effective_date",
    "expiration_date",
    "source_reference",
    "source_url",
    "verification_status",
    "verified_by",
    "verified_at",
    "published_at",
    "published_by",
    "retired_at",
    "created_by",
    "created_at"
  ],
  "surcharge_rules": [
    "id",
    "scope",
    "tenant_id",
    "carrier_code",
    "rule_key",
    "category",
    "name",
    "brand_id",
    "archived_at",
    "created_by",
    "created_at"
  ],
  "tenants": [
    "id",
    "name",
    "slug",
    "status",
    "created_by",
    "created_at",
    "updated_at",
    "default_origin_zip"
  ],
  "uploaded_files": [
    "id",
    "tenant_id",
    "brand_id",
    "purpose",
    "filename",
    "mime_type",
    "byte_size",
    "sha256",
    "content",
    "uploaded_by",
    "created_at"
  ],
  "zip_list_entries": [
    "list_id",
    "entry"
  ],
  "zip_lists": [
    "id",
    "tenant_id",
    "carrier_code",
    "key",
    "name",
    "version",
    "source_reference",
    "source_url",
    "verification_status",
    "effective_date",
    "expiration_date",
    "entry_count",
    "status",
    "published_at",
    "source_file_id",
    "created_by",
    "created_at"
  ]
};
const PUBLIC_FUNCTIONS: string[] = [
  "accept_invitation(p_token text)",
  "activate_fee_schedule_version(p_version uuid, p_effective date, p_expiration date)",
  "activate_rate_card_version(p_version uuid, p_effective date, p_expiration date)",
  "adjustment_example_state(p_example uuid)",
  "adjustment_example_states(p_tenant uuid)",
  "adjustment_records_json(p_import uuid, p_from integer, p_limit integer)",
  "advance_simulation_run(p_run uuid, p_from_row bigint, p_to_row bigint, p_results jsonb, p_partial jsonb, p_contexts jsonb, p_order_results jsonb, p_fee_contexts jsonb)",
  "append_adjustment_records(p_import uuid, p_from_row integer, p_rows jsonb)",
  "archive_adjustment_scenario(p_id uuid)",
  "archive_fee_schedule(p_schedule uuid)",
  "archive_fee_schedule_version(p_version uuid)",
  "archive_rate_card_version(p_version uuid)",
  "archive_risk_estimate(p_id uuid)",
  "assign_fee_schedule(p_brand uuid, p_schedule uuid)",
  "brand_adjustment_examples(p_brand uuid)",
  "brand_fee_schedule_on(p_brand uuid, p_date date)",
  "cancel_simulation_run(p_run uuid)",
  "check_rate_limit(p_action text, p_limit integer, p_window_seconds integer)",
  "copy_fee_schedule_version(p_schedule uuid, p_from_version uuid)",
  "create_adjustment_import(p_file uuid, p_name text, p_detected jsonb)",
  "create_fee_schedule(p_tenant uuid, p_name text, p_description text, p_rounding text)",
  "create_tenant(p_name text)",
  "dataset_forecast_period(p_dataset uuid)",
  "delete_adjustment_baseline(p_id uuid)",
  "discard_adjustment_import(p_import uuid)",
  "discard_order_dataset(p_dataset uuid)",
  "end_adjustment_policy(p_policy uuid, p_last_day date)",
  "end_fee_schedule_version(p_version uuid, p_expiration date)",
  "end_rate_card_version(p_version uuid, p_expiration date)",
  "fail_simulation_run(p_run uuid, p_error text)",
  "fee_schedule_snapshot(p_version uuid)",
  "finalize_adjustment_import(p_import uuid)",
  "finalize_order_dataset(p_dataset uuid)",
  "finish_simulation_run(p_run uuid, p_summary jsonb, p_reference_data jsonb, p_engine_version text, p_monthly_lines jsonb)",
  "is_platform_admin()",
  "log_audit_event(p_tenant uuid, p_brand uuid, p_action text, p_entity_type text, p_entity_id text, p_metadata jsonb)",
  "materialise_order_rows(p_dataset uuid, p_orders jsonb, p_lines jsonb, p_shipments jsonb, p_packages jsonb)",
  "platform_set_tenant_status(p_tenant uuid, p_status text)",
  "preview_customer_example(p_source uuid, p_brand uuid)",
  "pricing_rules_for_card(p_rate_card uuid, p_ship_date date, p_brand uuid, p_known_lists uuid[], p_adjustment_view boolean)",
  "publish_customer_example(p_source uuid, p_brand uuid, p_title text, p_note text, p_valid_through date, p_internal_note text)",
  "publish_surcharge_rule_version(p_version uuid)",
  "publish_zip_list(p_list uuid)",
  "rate_card_rows_json(p_version uuid, p_service_ids uuid[])",
  "rate_card_zones_json(p_version uuid)",
  "reorder_fee_rules(p_version uuid, p_rule_ids uuid[])",
  "replace_rate_card_zones(p_version uuid, p_rows jsonb)",
  "reset_adjustment_import(p_import uuid)",
  "reset_order_dataset(p_dataset uuid)",
  "retire_customer_example(p_example uuid)",
  "retire_surcharge_rule_version(p_version uuid, p_last_effective date)",
  "revoke_invitation(p_invitation uuid)",
  "save_adjustment_baseline(p_tenant uuid, p_brand uuid, p_carrier text, p_service uuid, p_start date, p_end date, p_packages integer, p_missing integer, p_note text, p_id uuid)",
  "save_adjustment_scenario(p_tenant uuid, p_brand uuid, p_name text, p_type text, p_input jsonb, p_result jsonb, p_pins jsonb, p_engine_version text)",
  "save_forecast_run(p_brand uuid, p_rate_card uuid, p_name text, p_assumptions jsonb, p_summary jsonb, p_pins jsonb, p_engine_version text, p_fee_engine_version text)",
  "save_risk_estimate(p_tenant uuid, p_brand uuid, p_name text, p_inputs jsonb, p_result jsonb, p_engine_version text)",
  "save_single_simulation(p_brand uuid, p_rate_card uuid, p_name text, p_input jsonb, p_result jsonb, p_engine_version text)",
  "set_adjustment_import_mapping(p_import uuid, p_mapping jsonb, p_validation jsonb, p_duplicate_handling text, p_attested boolean)",
  "set_adjustment_policy(p_tenant uuid, p_brand uuid, p_type text, p_component text, p_handling text, p_valid_from date, p_note text)",
  "set_dataset_sharing(p_dataset uuid, p_shared boolean)",
  "set_scenario_sharing(p_project uuid, p_shared boolean)",
  "simulation_batch_input(p_run uuid, p_limit integer)",
  "start_simulation_run(p_project uuid, p_pricing_basis text, p_as_of_date date, p_service_override uuid, p_unmapped_policy text, p_assumptions jsonb)",
  "unassign_fee_schedule(p_assignment uuid)",
  "withdraw_adjustment_import(p_import uuid)",
  "zip_list_entries_array(p_list uuid)"
];
const APP_FUNCTIONS: string[] = [
  "adjustment_tenant_ids",
  "brand_fee_schedule",
  "brand_has_fee_schedule",
  "brand_has_rate_card",
  "can_access_brand_row",
  "can_assign_role",
  "can_manage_adjustments",
  "can_manage_fees",
  "can_manage_membership",
  "can_manage_pricing",
  "can_model_brand",
  "can_view_adjustments",
  "can_view_fee_version",
  "can_view_fees",
  "can_view_membership",
  "can_view_override",
  "can_view_profile",
  "can_view_rate_card",
  "can_view_rate_card_version",
  "can_view_tenant_scoped",
  "can_view_version_service",
  "fee_version_on",
  "has_brand_permission",
  "has_tenant_permission",
  "is_member_of_tenant",
  "is_platform_admin",
  "is_tenant_staff",
  "modelable_brand_ids",
  "modeling_visible",
  "order_file_shared",
  "project_visible"
];
void createUser; void scenarioInput; void scenarioResult;
