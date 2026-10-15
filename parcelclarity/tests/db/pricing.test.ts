import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, expectDenied, sql } from "./harness";
import { buildWorld, type World } from "./world";

/**
 * Authorization and integrity of the pricing tables (Milestone 2). Builds a rate card through the
 * real flow (card → draft version → terms/rows/zones → activate → assign) as the 3PL administrator,
 * then checks what every role can see and do. All prices are fictional test values.
 */
let w: World;
let upsGround: string;
let uspsGa: string;
let cardId: string;
let v1: string;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function createDraft(adminId: string, tenantId: string, card: string, versionNumber: number): Promise<string> {
  const [row] = await asUser<{ id: string }>(adminId, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, $3) returning id", [card, tenantId, versionNumber]);
  return row!.id;
}

async function fillVersion(adminId: string, versionId: string) {
  await asUser(adminId, "insert into public.rate_card_service_terms (version_id, service_id, dim_divisor, min_charge) values ($1, $2, 139, 8.50)", [versionId, upsGround]);
  await asUser(
    adminId,
    `insert into public.rate_card_rows (version_id, service_id, origin_prefix, zone, weight_min, weight_max, weight_unit, price)
     values ($1, $2, null, '2', 0, 1, 'lb', 7.90), ($1, $2, null, '2', 1, 2, 'lb', 8.21), ($1, $2, null, '5', 0, 1, 'lb', 9.60), ($1, $2, null, '5', 1, 2, 'lb', 10.09)`,
    [versionId, upsGround],
  );
  await asUser(adminId, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '900', '935', '2'), ($1, 'ups', '900', '800', '899', '5')", [versionId]);
}

beforeAll(async () => {
  w = await buildWorld();
  [{ id: upsGround }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'ups' and code = 'ground'")) as [{ id: string }];
  [{ id: uspsGa }] = (await sql<{ id: string }>("select id from public.shipping_services where carrier_code = 'usps' and code = 'ground_advantage'")) as [{ id: string }];
  const [card] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Northwind standard card') returning id", [w.t1.id]);
  cardId = card!.id;
  v1 = await createDraft(w.t1.admin.id, w.t1.id, cardId, 1);
  await fillVersion(w.t1.admin.id, v1);
});

describe("reference data", () => {
  it("every signed-in user can read carriers and services; nobody can write them", async () => {
    expect((await asUser(w.brandC.admin.id, "select code from public.carriers")).length).toBeGreaterThanOrEqual(4);
    expect((await asUser(w.outsider.id, "select id from public.shipping_services")).length).toBeGreaterThan(10);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.carriers (code, name) values ('x', 'X')"), /permission denied/);
    await expectDenied(asUser(null, "select * from public.carriers"), /permission denied/);
  });
});

describe("rate card lifecycle", () => {
  it("activation requires rows and terms for every service, then becomes immutable", async () => {
    const empty = await createDraft(w.t1.admin.id, w.t1.id, cardId, 2);
    await expectDenied(asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2026-01-01')", [empty]), /no rate rows/);
    await asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 0, 4, 'oz', 4.95)", [empty, uspsGa]);
    await expectDenied(asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2026-01-01')", [empty]), /needs service terms/);
    await asUser(w.t1.admin.id, "select public.archive_rate_card_version($1)", [empty]);
    const [row] = await sql<{ status: string }>("select status from public.rate_card_versions where id = $1", [empty]);
    expect(row?.status).toBe("discarded");

    await asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2026-01-01', null)", [v1]);
    const [active] = await sql<{ status: string; row_count: number; activated_by: string }>("select status, row_count, activated_by from public.rate_card_versions where id = $1", [v1]);
    expect(active).toMatchObject({ status: "active", row_count: 4, activated_by: w.t1.admin.id });
    await expectDenied(asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '5', 2, 3, 'lb', 10.58)", [v1, upsGround]), /not a draft|row-level security/);
    // RLS hides non-draft rows from DELETE, so the statement affects nothing rather than erroring.
    expect(await asUser(w.t1.admin.id, "delete from public.rate_card_rows where version_id = $1 returning id", [v1])).toHaveLength(0);
    expect((await sql("select id from public.rate_card_rows where version_id = $1", [v1])).length).toBe(4);
    await expectDenied(sql("update public.rate_card_rows set price = 1 where version_id = $1", [v1]), /not a draft/);
    await expectDenied(sql("update public.rate_card_service_terms set dim_divisor = 100 where version_id = $1", [v1]), /not a draft/);
  });

  it("two active versions of one card cannot overlap in time", async () => {
    const v3 = await createDraft(w.t1.admin.id, w.t1.id, cardId, 3);
    await fillVersion(w.t1.admin.id, v3);
    await expectDenied(asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2026-06-01')", [v3]), /already covers those dates/);
    await expectDenied(asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2025-01-01', '2026-01-01')", [v3]), /already covers those dates/);
    await asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2025-01-01', '2025-12-31')", [v3]);
    await asUser(w.t1.admin.id, "select public.archive_rate_card_version($1)", [v3]);
    const [row] = await sql<{ status: string }>("select status from public.rate_card_versions where id = $1", [v3]);
    expect(row?.status).toBe("archived");
    await expectDenied(sql("update public.rate_card_versions set status = 'active' where id = $1", [v3]), /cannot change status/);
  });

  it("only pricing managers can activate or archive", async () => {
    await expectDenied(asUser(w.t1.employee.id, "select public.activate_rate_card_version($1, '2026-01-01')", [v1]), /version not found/);
    await expectDenied(asUser(w.brandA.admin.id, "select public.archive_rate_card_version($1)", [v1]), /version not found/);
    await expectDenied(asUser(w.t2.admin.id, "select public.archive_rate_card_version($1)", [v1]), /version not found/);
  });

  it("status cannot be changed by direct update, only by the RPCs", async () => {
    await expectDenied(asUser(w.t1.admin.id, "update public.rate_card_versions set status = 'archived' where id = $1", [v1]), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "update public.rate_card_versions set effective_date = '2020-01-01' where id = $1", [v1]), /permission denied/);
  });
});

describe("who can see and write rate cards", () => {
  let brandAssignment: string;
  beforeAll(async () => {
    const [a] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3) returning id", [w.t1.id, w.brandA.id, cardId]);
    brandAssignment = a!.id;
  });

  it("3PL staff see every version; employees can read but not write", async () => {
    expect((await asUser(w.t1.employee.id, "select id from public.rate_card_versions where rate_card_id = $1", [cardId])).length).toBeGreaterThanOrEqual(3);
    expect((await asUser(w.t1.employee.id, "select id from public.rate_card_rows where version_id = $1", [v1])).length).toBe(4);
    await expectDenied(asUser(w.t1.employee.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Nope')", [w.t1.id]), /row-level security/);
    await expectDenied(asUser(w.t1.employee.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 9)", [cardId, w.t1.id]), /row-level security/);
    expect(await asUser(w.t1.employee.id, "update public.rate_cards set name = 'Renamed' where id = $1 returning id", [cardId])).toHaveLength(0);
  });

  it("an assigned brand sees the card, its ACTIVE version, rows, zones and terms, but no drafts", async () => {
    expect(ids(await asUser(w.brandA.admin.id, "select id from public.rate_cards"))).toEqual([cardId]);
    const versions = await asUser<{ id: string; status: string }>(w.brandA.employee.id, "select id, status from public.rate_card_versions");
    expect(versions.map((v) => v.status)).toEqual(["active"]);
    expect(versions[0]?.id).toBe(v1);
    expect((await asUser(w.brandA.employee.id, "select id from public.rate_card_rows")).length).toBe(4);
    expect((await asUser(w.brandA.employee.id, "select id from public.rate_card_zones")).length).toBe(2);
    expect((await asUser(w.brandA.employee.id, "select id from public.rate_card_service_terms")).length).toBe(1);
    const draft = await createDraft(w.t1.admin.id, w.t1.id, cardId, 4);
    await fillVersion(w.t1.admin.id, draft);
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_versions where id = $1", [draft])).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_rows where version_id = $1", [draft])).toHaveLength(0);
    expect((await asUser(w.t1.admin.id, "select id from public.rate_card_rows where version_id = $1", [draft])).length).toBe(4);
  });

  it("brand members can never write pricing", async () => {
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Mine')", [w.t1.id]), /row-level security/);
    const draft = await createDraft(w.t1.admin.id, w.t1.id, cardId, 5);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '2', 0, 1, 'lb', 0.01)", [draft, upsGround]), /row-level security/);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandB.id, cardId]), /row-level security/);
  });

  it("an unassigned brand in the same tenant, and any other tenant, see nothing", async () => {
    for (const user of [w.brandB.admin, w.brandC.admin, w.t2.admin, w.outsider, w.platformAdmin]) {
      expect(await asUser(user.id, "select id from public.rate_cards where id = $1", [cardId]), user.email).toHaveLength(0);
      expect(await asUser(user.id, "select id from public.rate_card_versions where rate_card_id = $1", [cardId]), user.email).toHaveLength(0);
      expect(await asUser(user.id, "select id from public.rate_card_rows where version_id = $1", [v1]), user.email).toHaveLength(0);
      expect(await asUser(user.id, "select id from public.rate_card_service_terms where version_id = $1", [v1]), user.email).toHaveLength(0);
    }
  });

  it("another tenant cannot write into this tenant's card or assign it", async () => {
    await expectDenied(asUser(w.t2.admin.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 50)", [cardId, w.t1.id]), /row-level security/);
    await expectDenied(asUser(w.t2.admin.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 51)", [cardId, w.t2.id]), /row-level security|foreign key/);
    await expectDenied(asUser(w.t2.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t2.id, w.brandC.id, cardId]), /row-level security|foreign key/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandC.id, cardId]), /row-level security|foreign key/);
  });

  it("assignment can be ended and the brand immediately loses sight", async () => {
    expect(await asUser(w.t1.admin.id, "update public.brand_rate_card_assignments set unassigned_at = now(), unassigned_by = $2 where id = $1 returning id", [brandAssignment, w.t1.admin.id])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_cards")).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_rows")).toHaveLength(0);
    const [a] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3) returning id", [w.t1.id, w.brandA.id, cardId]);
    brandAssignment = a!.id;
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_cards")).toHaveLength(1);
  });

  it("a brand limited to some services cannot read the other services' rows or terms", async () => {
    await asUser(w.t1.admin.id, "update public.brand_rate_card_assignments set unassigned_at = now() where id = $1", [brandAssignment]);
    const [a] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id, allowed_service_ids) values ($1, $2, $3, $4) returning id", [w.t1.id, w.brandA.id, cardId, [uspsGa]]);
    try {
      expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_rows where version_id = $1", [v1])).toHaveLength(0); // v1 only has UPS Ground rows
      expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_service_terms where version_id = $1", [v1])).toHaveLength(0);
      const [json] = await asUser<{ rows: unknown[] }>(w.brandA.admin.id, "select public.rate_card_rows_json($1) as rows", [v1]);
      expect(json!.rows).toHaveLength(0);
      expect(await asUser(w.brandA.admin.id, "select id from public.rate_cards where id = $1", [cardId])).toHaveLength(1); // the card itself is still visible
    } finally {
      await asUser(w.t1.admin.id, "update public.brand_rate_card_assignments set unassigned_at = now() where id = $1", [a!.id]);
      const [back] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3) returning id", [w.t1.id, w.brandA.id, cardId]);
      brandAssignment = back!.id;
    }
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_rows where version_id = $1", [v1])).toHaveLength(4);
  });

  it("overlapping brackets and overlapping zone ranges are rejected by the database itself", async () => {
    const draft = await createDraft(w.t1.admin.id, w.t1.id, cardId, 40);
    await asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '2', 0, 5, 'lb', 9.00)", [draft, upsGround]);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '2', 3, 10, 'lb', 9.50)", [draft, upsGround]), /rate_card_rows_no_overlap/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '2', 64, 96, 'oz', 9.50)", [draft, upsGround]), /rate_card_rows_no_overlap/); // 4–6 lb overlaps 0–5 lb
    await asUser(w.t1.admin.id, "insert into public.rate_card_rows (version_id, service_id, zone, weight_min, weight_max, weight_unit, price) values ($1, $2, '2', 5, 10, 'lb', 9.50)", [draft, upsGround]); // adjacent is fine
    await asUser(w.t1.admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '100', '199', '8')", [draft]);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '150', '250', '7')", [draft]), /rate_card_zones_no_overlap/);
    await asUser(w.t1.admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '10001', '10099', '8')", [draft]); // different prefix length: allowed (more specific)
    await asUser(w.t1.admin.id, "select public.archive_rate_card_version($1)", [draft]);
  });

  it("an active version can be ended on a date so a successor can start the next day", async () => {
    const next = await createDraft(w.t1.admin.id, w.t1.id, cardId, 41);
    await fillVersion(w.t1.admin.id, next);
    await expectDenied(asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2027-01-01')", [next]), /already covers those dates/);
    await expectDenied(asUser(w.t1.employee.id, "select public.end_rate_card_version($1, '2026-12-31')", [v1]), /version not found/);
    await asUser(w.t1.admin.id, "select public.end_rate_card_version($1, '2026-12-31')", [v1]);
    await asUser(w.t1.admin.id, "select public.activate_rate_card_version($1, '2027-01-01')", [next]);
    const rows = await asUser<{ id: string; status: string; expiration_date: string | null }>(w.brandA.admin.id, "select id, status, expiration_date from public.rate_card_versions where rate_card_id = $1 order by version_number", [cardId]);
    expect(rows.map((r) => r.status)).toEqual(["active", "active"]); // both visible to the brand; dates decide which applies
    expect(await sql("select 1 from public.audit_events where action = 'ratecard.version_ended' and entity_id = $1", [v1])).toHaveLength(1);
    await asUser(w.t1.admin.id, "select public.archive_rate_card_version($1)", [next]);
    await sql("update public.rate_card_versions set expiration_date = null where id = $1", [v1]);
  });

  it("a suspended brand loses sight of its rate card until reactivated", async () => {
    await asUser(w.t1.admin.id, "update public.brands set status = 'suspended' where id = $1", [w.brandA.id]);
    try {
      expect(await asUser(w.brandA.admin.id, "select id from public.rate_cards")).toHaveLength(0);
    } finally {
      await asUser(w.t1.admin.id, "update public.brands set status = 'active' where id = $1", [w.brandA.id]);
    }
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_cards")).toHaveLength(1);
  });
});

describe("uploaded files and imports", () => {
  it("only pricing managers can store or read files; content size must match", async () => {
    const content = Buffer.from("carrier,service\nUPS,UPS Ground\n");
    const sha = createHash("sha256").update(content).digest();
    const [f] = await asUser<{ id: string }>(
      w.t1.admin.id,
      "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'rate_card', 'card.csv', 'text/csv', $2, $3, $4) returning id",
      [w.t1.id, content.length, sha, content],
    );
    expect(await asUser(w.t1.admin.id, "select id from public.uploaded_files where id = $1", [f!.id])).toHaveLength(1);
    for (const user of [w.t1.employee, w.brandA.admin, w.t2.admin, w.platformAdmin]) {
      expect(await asUser(user.id, "select id from public.uploaded_files where id = $1", [f!.id]), user.email).toHaveLength(0);
    }
    await expectDenied(
      asUser(w.t1.employee.id, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'rate_card', 'x.csv', 'text/csv', $2, $3, $4)", [w.t1.id, content.length, sha, content]),
      /row-level security/,
    );
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'rate_card', 'x.csv', 'text/csv', 999, $2, $3)", [w.t1.id, sha, content]),
      /uploaded_files_size_matches/,
    );
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.uploaded_files (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) values ($1, 'rate_card', 'x.csv', 'text/csv', $2, $3, $4)", [w.t2.id, content.length, sha, content]),
      /row-level security/,
    );

    const [imp] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_card_imports (tenant_id, rate_card_id, file_id, detected) values ($1, $2, $3, '{}') returning id", [w.t1.id, cardId, f!.id]);
    expect(await asUser(w.brandA.admin.id, "select id from public.rate_card_imports where id = $1", [imp!.id])).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select id from public.rate_card_imports where id = $1", [imp!.id])).toHaveLength(0);
    await expectDenied(asUser(w.t2.admin.id, "insert into public.rate_card_imports (tenant_id, rate_card_id, file_id, detected) values ($1, $2, $3, '{}')", [w.t2.id, cardId, f!.id]), /row-level security|foreign key/);
  });
});

describe("surcharge rules", () => {
  let ruleId: string;
  let ruleV1: string;
  it("managers create tenant rules and publish them through the RPC; published versions are immutable", async () => {
    const [r] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'northwind.residential', 'residential', 'Residential surcharge') returning id", [w.t1.id]);
    ruleId = r!.id;
    const [v] = await asUser<{ id: string }>(
      w.t1.admin.id,
      `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, conditions, effective_date, source_reference, verification_status)
       values ($1, $2, 1, 'definite', 'flat', 5.00, '[{"type":"residential","value":true}]', '2026-01-01', 'Customer agreement 2026', 'approved_3pl_config') returning id`,
      [ruleId, w.t1.id],
    );
    ruleV1 = v!.id;
    // Drafts are visible to staff but not to brands.
    expect(await asUser(w.brandA.admin.id, "select id from public.surcharge_rule_versions where id = $1", [ruleV1])).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select id from public.surcharge_rule_versions where id = $1", [ruleV1])).toHaveLength(1);
    await expectDenied(asUser(w.t1.employee.id, "select public.publish_surcharge_rule_version($1)", [ruleV1]), /not found/);
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [ruleV1]);
    // Brand users never read tenant rules directly; they get what applies to them through pricing_rules_for_card().
    expect(await asUser(w.brandA.admin.id, "select id from public.surcharge_rule_versions where id = $1", [ruleV1])).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select id from public.surcharge_rules where id = $1", [ruleId])).toHaveLength(0);
    expect(await asUser(w.brandC.admin.id, "select id from public.surcharge_rule_versions where id = $1", [ruleV1])).toHaveLength(0);
    const [viaRpc] = await asUser<{ r: { rules: { key: string; version: number }[] } }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01') as r", [cardId]);
    expect(viaRpc!.r.rules.map((r) => [r.key, r.version])).toEqual([["northwind.residential", 1]]);
    await expectDenied(asUser(w.brandB.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01')", [cardId]), /rate card not found/);
    await expectDenied(asUser(w.brandC.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01')", [cardId]), /rate card not found/);
    expect(await asUser(w.t2.admin.id, "select id from public.surcharge_rules where id = $1", [ruleId])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "update public.surcharge_rule_versions set amount = 9 where id = $1 returning id", [ruleV1])).toHaveLength(0); // policy: drafts only
    await expectDenied(sql("update public.surcharge_rule_versions set amount = 9 where id = $1", [ruleV1]), /immutable/);
  });

  it("a second published version cannot overlap the first; retiring frees the dates", async () => {
    const [v2] = await asUser<{ id: string }>(
      w.t1.admin.id,
      `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, conditions, effective_date, source_reference, verification_status)
       values ($1, $2, 2, 'definite', 'flat', 5.50, '[{"type":"residential","value":true}]', '2026-07-01', 'Customer agreement 2026 rev 2', 'approved_3pl_config') returning id`,
      [ruleId, w.t1.id],
    );
    await expectDenied(asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v2!.id]), /already covers those dates/);
    // Retiring keeps the old version for history: it still covers dates up to its last effective date.
    await asUser(w.t1.admin.id, "select public.retire_surcharge_rule_version($1, '2026-10-15')", [ruleV1]);
    await expectDenied(asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v2!.id]), /already covers those dates/);
    await sql("update public.surcharge_rule_versions set expiration_date = '2026-06-30' where id = $1", [ruleV1]);
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v2!.id]);
    const [march] = await asUser<{ r: { rules: { version: number; amount: string }[] } }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01') as r", [cardId]);
    expect(march!.r.rules.map((r) => [r.version, r.amount])).toEqual([[1, "5.0000"]]);
    const [august] = await asUser<{ r: { rules: { version: number; amount: string }[] } }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(august!.r.rules.map((r) => [r.version, r.amount])).toEqual([[2, "5.5000"]]);
    await expectDenied(sql("update public.surcharge_rule_versions set status = 'published' where id = $1", [ruleV1]), /cannot be reactivated|immutable/);
    await expectDenied(sql("update public.surcharge_rule_versions set amount = 1 where id = $1", [ruleV1]), /immutable/);
  });

  it("nobody can create platform-scope rules through the Data API, but everyone can read published ones", async () => {
    await expectDenied(asUser(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('platform', null, 'ups', 'ups.fuel', 'fuel', 'Fuel')"), /row-level security/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'sneaky', 'fuel', 'Fuel')", [w.t2.id]), /row-level security/);
    const [pr] = await sql<{ id: string }>("insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('platform', null, 'ups', 'ups.fuel', 'fuel', 'UPS fuel surcharge') returning id");
    const [pv] = await sql<{ id: string }>(
      `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, percent, effective_date, source_reference, verification_status, status, published_at)
       values ($1, null, 1, 'definite', 'percent', 0, '2026-01-01', 'placeholder: amount must be entered from the published schedule', 'verified', 'published', now()) returning id`,
      [pr!.id],
    );
    for (const user of [w.t1.admin, w.brandA.admin, w.brandC.admin, w.t2.admin]) {
      expect(await asUser(user.id, "select id from public.surcharge_rule_versions where id = $1", [pv!.id]), user.email).toHaveLength(1);
    }
    // A published platform version must not be unverified.
    await expectDenied(
      sql("insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, percent, effective_date, source_reference, verification_status, status) values ($1, null, 2, 'definite', 'percent', 1, '2027-01-01', 'x', 'unverified', 'published')", [pr!.id]),
      /srv_published_verified/,
    );
    expect(await asUser(w.t1.admin.id, "update public.surcharge_rules set name = 'x' where id = $1 returning id", [pr!.id])).toHaveLength(0);
    await expectDenied(asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [pv!.id]), /not found/);
  });

  it("tenant rule versions must claim 3PL approval and may not be inserted for another tenant", async () => {
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 7, 'definite', 'flat', 1, '2027-01-01', 'x', 'verified')", [ruleId, w.t1.id]),
      /row-level security/,
    );
    await expectDenied(
      asUser(w.t2.admin.id, "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 8, 'definite', 'flat', 1, '2027-01-01', 'x', 'approved_3pl_config')", [ruleId, w.t2.id]),
      /row-level security|foreign key/,
    );
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, percent, effective_date, source_reference, verification_status) values ($1, $2, 9, 'definite', 'flat', 1, 2, '2027-01-01', 'x', 'approved_3pl_config')", [ruleId, w.t1.id]),
      /srv_method_fields/,
    );
  });

  it("customer overrides are visible only to staff and the brand they concern", async () => {
    const [o] = await asUser<{ id: string }>(
      w.t1.admin.id,
      "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date, reference) values ($1, $2, $3, 'exclude', '2026-01-01', 'Waived per MSA') returning id",
      [w.t1.id, w.brandA.id, ruleId],
    );
    expect(await asUser(w.brandA.employee.id, "select id from public.customer_surcharge_overrides where id = $1", [o!.id])).toHaveLength(1);
    expect(await asUser(w.brandB.admin.id, "select id from public.customer_surcharge_overrides")).toHaveLength(0);
    expect(await asUser(w.t2.admin.id, "select id from public.customer_surcharge_overrides")).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select id from public.customer_surcharge_overrides where id = $1", [o!.id])).toHaveLength(1);
    await expectDenied(asUser(w.brandA.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date, reference) values ($1, $2, $3, 'exclude', '2026-01-01', 'self-serve')", [w.t1.id, w.brandA.id, ruleId]), /row-level security/);
    // Another tenant cannot reference this tenant's rule or brand.
    await expectDenied(asUser(w.t2.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date, reference) values ($1, $2, $3, 'exclude', '2026-01-01', 'x')", [w.t2.id, w.brandC.id, ruleId]), /row-level security/);
    await expectDenied(asUser(w.t2.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date, reference) values ($1, $2, $3, 'exclude', '2026-01-01', 'x')", [w.t2.id, w.brandA.id, ruleId]), /row-level security|foreign key/);
    // Two live exceptions for the same brand and rule may not overlap in time; ending one frees the dates.
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, percent, effective_date, reference) values ($1, $2, $3, 'markup_percent', 10, '2026-06-01', 'Addendum')", [w.t1.id, w.brandA.id, ruleId]),
      /cso_no_overlap/,
    );
    await asUser(w.t1.admin.id, "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [o!.id]);
    await asUser(w.t1.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, percent, effective_date, reference) values ($1, $2, $3, 'markup_percent', 10, '2026-06-01', 'Addendum')", [w.t1.id, w.brandA.id, ruleId]);
  });

  it("a rule scoped to one brand is delivered only to that brand", async () => {
    const [r] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name, brand_id) values ('tenant', $1, 'ups', 'northwind.alpha_handling', 'other', 'Alpha special handling', $2) returning id", [w.t1.id, w.brandA.id]);
    const [v] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, effective_date, source_reference, verification_status) values ($1, $2, 1, 'definite', 'flat', 2.50, '2026-01-01', 'Alpha MSA', 'approved_3pl_config') returning id", [r!.id, w.t1.id]);
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v!.id]);
    const [a] = await asUser<{ r: { rules: { key: string }[] } }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(a!.r.rules.map((x) => x.key)).toContain("northwind.alpha_handling");
    await asUser(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandB.id, cardId]);
    const [b] = await asUser<{ r: { rules: { key: string }[] } }>(w.brandB.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(b!.r.rules.map((x) => x.key)).not.toContain("northwind.alpha_handling");
    // Staff asking on behalf of brand B get brand B's view; asking for a brand of another tenant fails.
    const [staffB] = await asUser<{ r: { rules: { key: string }[] } }>(w.t1.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01', $2) as r", [cardId, w.brandB.id]);
    expect(staffB!.r.rules.map((x) => x.key)).not.toContain("northwind.alpha_handling");
    await expectDenied(asUser(w.t1.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01', $2)", [cardId, w.brandC.id]), /brand not found/);
    // A brand cannot ask for another brand's rules.
    await expectDenied(asUser(w.brandB.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01', $2)", [cardId, w.brandA.id]), /rate card not found/);
    await asUser(w.t1.admin.id, "update public.brand_rate_card_assignments set unassigned_at = now() where brand_id = $1 and rate_card_id = $2", [w.brandB.id, cardId]);
    // Another tenant cannot scope a rule to this tenant's brand.
    await expectDenied(asUser(w.t2.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name, brand_id) values ('tenant', $1, 'ups', 'sneaky.brand', 'other', 'x', $2)", [w.t2.id, w.brandA.id]), /row-level security|foreign key/);
  });

  it("ZIP lists: drafted, published, immutable afterwards, and delivered to brands only through the RPC", async () => {
    const [l] = await asUser<{ id: string }>(
      w.t1.admin.id,
      "insert into public.zip_lists (tenant_id, carrier_code, key, name, source_reference, verification_status, effective_date) values ($1, 'ups', 'northwind.das', 'DAS ZIPs', 'Uploaded from carrier bulletin', 'approved_3pl_config', '2026-01-01') returning id",
      [w.t1.id],
    );
    await expectDenied(asUser(w.t1.admin.id, "select public.publish_zip_list($1)", [l!.id]), /empty ZIP list/);
    await asUser(w.t1.admin.id, "insert into public.zip_list_entries (list_id, entry) values ($1, '93920'), ($1, '958')", [l!.id]);
    const [count] = await sql<{ entry_count: number }>("select entry_count from public.zip_lists where id = $1", [l!.id]);
    expect(count?.entry_count).toBe(2); // maintained by trigger, not by the client
    await asUser(w.t1.admin.id, "select public.publish_zip_list($1)", [l!.id]);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.zip_list_entries (list_id, entry) values ($1, '10001')", [l!.id]), /not a draft|row-level security/);
    await expectDenied(sql("delete from public.zip_list_entries where list_id = $1", [l!.id]), /not a draft/);
    // Brands do not read tenant lists directly…
    expect(await asUser(w.brandA.employee.id, "select entry from public.zip_list_entries where list_id = $1", [l!.id])).toHaveLength(0);
    expect(await asUser(w.brandC.admin.id, "select id from public.zip_lists where id = $1", [l!.id])).toHaveLength(0);
    expect(await asUser(w.t2.admin.id, "select id from public.zip_lists where id = $1", [l!.id])).toHaveLength(0);
    expect((await asUser(w.t1.employee.id, "select id from public.zip_lists where id = $1", [l!.id]))).toHaveLength(1);
    await expectDenied(asUser(w.t1.employee.id, "insert into public.zip_list_entries (list_id, entry) values ($1, '10001')", [l!.id]), /row-level security|not a draft/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.zip_lists (tenant_id, key, name, source_reference, verification_status, effective_date) values (null, 'ups.das', 'x', 'x', 'verified', '2026-01-01')"), /row-level security/);
    // …but a rule referencing the list brings it along through pricing_rules_for_card.
    const [r] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'northwind.das', 'das', 'Delivery area surcharge') returning id", [w.t1.id]);
    const [v] = await asUser<{ id: string }>(w.t1.admin.id, `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, conditions, effective_date, source_reference, verification_status) values ($1, $2, 1, 'definite', 'flat', 4.00, '[{"type":"destination_zip_in_list","listKey":"northwind.das"}]', '2026-01-01', 'Customer agreement', 'approved_3pl_config') returning id`, [r!.id, w.t1.id]);
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v!.id]);
    const [ctx] = await asUser<{ r: { zipLists: { key: string; entries: string[] }[] } }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(ctx!.r.zipLists).toEqual([expect.objectContaining({ key: "northwind.das", entries: ["93920", "958"] })]);
  });
});

describe("audit trail for pricing", () => {
  it("records card creation, activation, assignment and rule publication with the actor", async () => {
    const rows = await sql<{ action: string; actor_id: string }>("select action, actor_id from public.audit_events where tenant_id = $1 and action like 'ratecard.%' or (tenant_id = $1 and action like 'carrier_rule.%')", [w.t1.id]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["ratecard.created", "ratecard.version_active", "ratecard.version_archived", "ratecard.version_discarded", "ratecard.version_ended", "ratecard.assigned", "ratecard.unassigned", "carrier_rule.published", "carrier_rule.retired", "carrier_rule.zip_list_published", "ratecard.override_created", "ratecard.override_ended"]) {
      expect([...actions].sort()).toContain(a);
    }
    // Every user-initiated row names the administrator; the one superuser cleanup in these tests has no actor.
    expect(rows.filter((r) => r.actor_id !== null).every((r) => r.actor_id === w.t1.admin.id)).toBe(true);
    expect(rows.filter((r) => r.action === "ratecard.version_active").every((r) => r.actor_id === w.t1.admin.id)).toBe(true);
  });
});

describe("bulk read helpers respect RLS", () => {
  it("return a brand's visible rows and nothing for strangers", async () => {
    const [mine] = await asUser<{ rows: unknown[] }>(w.brandA.admin.id, "select public.rate_card_rows_json($1) as rows", [v1]);
    expect(mine!.rows).toHaveLength(4);
    const [filtered] = await asUser<{ rows: unknown[] }>(w.brandA.admin.id, "select public.rate_card_rows_json($1, $2) as rows", [v1, [uspsGa]]);
    expect(filtered!.rows).toHaveLength(0);
    const [zones] = await asUser<{ zones: unknown[] }>(w.brandA.admin.id, "select public.rate_card_zones_json($1) as zones", [v1]);
    expect(zones!.zones).toHaveLength(2);
    for (const user of [w.brandB.admin, w.t2.admin, w.brandC.admin]) {
      const [none] = await asUser<{ rows: unknown[] }>(user.id, "select public.rate_card_rows_json($1) as rows", [v1]);
      expect(none!.rows, user.email).toHaveLength(0);
    }
    const [list] = await sql<{ id: string }>("select id from public.zip_lists where key = 'northwind.das'");
    const [entries] = await asUser<{ e: string[] }>(w.t1.employee.id, "select public.zip_list_entries_array($1) as e", [list!.id]);
    expect(entries!.e).toEqual(["93920", "958"]);
    const [brandDirect] = await asUser<{ e: string[] }>(w.brandA.employee.id, "select public.zip_list_entries_array($1) as e", [list!.id]);
    expect(brandDirect!.e).toEqual([]);
    const [noEntries] = await asUser<{ e: string[] }>(w.brandC.admin.id, "select public.zip_list_entries_array($1) as e", [list!.id]);
    expect(noEntries!.e).toEqual([]);
  });
});

describe("review fixes: brand exceptions, hidden notes, archived cards, atomic zone charts", () => {
  it("a brand's live exceptions reach the calculation through the RPC, joined to the rule key", async () => {
    // brandA holds a markup_percent exception on northwind.residential from 2026-06-01 (created above).
    type Payload = { overrides: { id: string; ruleKey: string; mode: string; percent: string | null }[] };
    const [a] = await asUser<{ r: Payload }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(a!.r.overrides).toEqual([expect.objectContaining({ ruleKey: "northwind.residential", mode: "markup_percent", percent: "10.0000", amount: null, effectiveDate: "2026-06-01", expirationDate: null, reference: "Addendum" })]);
    expect(a!.r.overrides[0]!.id).toMatch(/^[0-9a-f-]{36}$/); // pinned by bulk runs
    const [early] = await asUser<{ r: Payload }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-03-01') as r", [cardId]);
    expect(early!.r.overrides).toEqual([]);
    // Staff modelling on behalf of the brand get the same; staff pricing for nobody get none.
    const [staff] = await asUser<{ r: Payload }>(w.t1.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01', $2) as r", [cardId, w.brandA.id]);
    expect(staff!.r.overrides).toHaveLength(1);
    const [nobody] = await asUser<{ r: Payload }>(w.t1.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(nobody!.r.overrides).toEqual([]);
  });

  it("a brand sees a fixed label instead of the 3PL's own source notes; staff see the notes", async () => {
    type Payload = { rules: { key: string; scope: string; sourceReference: string; sourceUrl: string | null }[]; zipLists: { key: string; sourceReference: string }[] };
    const [brand] = await asUser<{ r: Payload }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    const tenantRules = brand!.r.rules.filter((r) => r.scope === "tenant");
    expect(tenantRules.length).toBeGreaterThan(0);
    for (const r of tenantRules) {
      expect(r.sourceReference).toBe("Your 3PL's approved pricing configuration");
      expect(r.sourceUrl).toBeNull();
    }
    expect(brand!.r.zipLists.map((l) => l.sourceReference)).toEqual(["Your 3PL's approved pricing configuration"]);
    const [staff] = await asUser<{ r: Payload }>(w.t1.employee.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
    expect(staff!.r.rules.find((r) => r.key === "northwind.residential")?.sourceReference).toBe("Customer agreement 2026 rev 2");
    expect(staff!.r.zipLists.map((l) => l.sourceReference)).toEqual(["Uploaded from carrier bulletin"]);
  });

  it("ZIP lists referenced inside any_of groups are delivered too", async () => {
    const [r] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'northwind.das_any', 'das_extended', 'DAS either list') returning id", [w.t1.id]);
    const [v] = await asUser<{ id: string }>(
      w.t1.admin.id,
      `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, amount, conditions, effective_date, source_reference, verification_status)
       values ($1, $2, 1, 'definite', 'flat', 6.00, '[{"type":"any_of","conditions":[{"type":"destination_zip_in_list","listKey":"northwind.das"},{"type":"destination_zip_in_list","listKey":"northwind.nowhere"}]}]', '2026-01-01', 'Customer agreement', 'approved_3pl_config') returning id`,
      [r!.id, w.t1.id],
    );
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v!.id]);
    // Temporarily hide the top-level reference (northwind.das rule) so only the nested one remains.
    const [top] = await sql<{ id: string }>("select id from public.surcharge_rules where rule_key = 'northwind.das'");
    await sql("update public.surcharge_rules set archived_at = now() where id = $1", [top!.id]);
    try {
      const [ctx] = await asUser<{ r: { zipLists: { key: string }[] } }>(w.brandA.admin.id, "select public.pricing_rules_for_card($1, '2026-08-01') as r", [cardId]);
      expect(ctx!.r.zipLists.map((l) => l.key)).toEqual(["northwind.das"]);
    } finally {
      await sql("update public.surcharge_rules set archived_at = null where id = $1", [top!.id]);
      await sql("update public.surcharge_rules set archived_at = now() where id = $1", [r!.id]);
    }
  });

  it("an exception cannot target a rule scoped to another brand", async () => {
    const [scoped] = await sql<{ id: string }>("select id from public.surcharge_rules where rule_key = 'northwind.alpha_handling'");
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date, reference) values ($1, $2, $3, 'exclude', '2026-01-01', 'wrong brand')", [w.t1.id, w.brandB.id, scoped!.id]),
      /row-level security/,
    );
    const [ok] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.customer_surcharge_overrides (tenant_id, brand_id, rule_id, mode, effective_date, reference) values ($1, $2, $3, 'exclude', '2026-01-01', 'right brand') returning id", [w.t1.id, w.brandA.id, scoped!.id]);
    await asUser(w.t1.admin.id, "update public.customer_surcharge_overrides set ended_at = now() where id = $1", [ok!.id]);
  });

  it("an archived rate card accepts no new versions or assignments, even by direct insert", async () => {
    const [card] = await asUser<{ id: string }>(w.t1.admin.id, "insert into public.rate_cards (tenant_id, name) values ($1, 'Retired card') returning id", [w.t1.id]);
    await asUser(w.t1.admin.id, "update public.rate_cards set status = 'archived' where id = $1", [card!.id]);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.rate_card_versions (rate_card_id, tenant_id, version_number) values ($1, $2, 1)", [card!.id, w.t1.id]), /row-level security/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.brand_rate_card_assignments (tenant_id, brand_id, rate_card_id) values ($1, $2, $3)", [w.t1.id, w.brandA.id, card!.id]), /row-level security/);
  });

  it("replacing a zone chart is all-or-nothing and only for drafts the caller manages", async () => {
    const draft = await createDraft(w.t1.admin.id, w.t1.id, cardId, 60);
    await asUser(w.t1.admin.id, "insert into public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone) values ($1, 'ups', '900', '100', '199', '8')", [draft]);
    const good = [{ carrier_code: "ups", origin_prefix: "900", dest_prefix_from: "200", dest_prefix_to: "299", zone: "7", zone_chart_key: "default" }];
    const overlapping = [...good, { carrier_code: "ups", origin_prefix: "900", dest_prefix_from: "250", dest_prefix_to: "350", zone: "6", zone_chart_key: "default" }];
    await expectDenied(asUser(w.t1.admin.id, "select public.replace_rate_card_zones($1, $2::jsonb)", [draft, JSON.stringify(overlapping)]), /rate_card_zones_no_overlap/);
    // The failed call changed nothing: the original row is still there.
    expect(await asUser<{ zone: string }>(w.t1.admin.id, "select zone from public.rate_card_zones where version_id = $1", [draft])).toEqual([{ zone: "8" }]);
    const [n] = await asUser<{ n: number }>(w.t1.admin.id, "select public.replace_rate_card_zones($1, $2::jsonb) as n", [draft, JSON.stringify(good)]);
    expect(n!.n).toBe(1);
    expect(await asUser<{ zone: string }>(w.t1.admin.id, "select zone from public.rate_card_zones where version_id = $1", [draft])).toEqual([{ zone: "7" }]);
    await expectDenied(asUser(w.t1.employee.id, "select public.replace_rate_card_zones($1, $2::jsonb)", [draft, JSON.stringify(good)]), /not found/);
    await expectDenied(asUser(w.t2.admin.id, "select public.replace_rate_card_zones($1, $2::jsonb)", [draft, JSON.stringify(good)]), /not found/);
    await asUser(w.t1.admin.id, "select public.archive_rate_card_version($1)", [draft]);
    await expectDenied(asUser(w.t1.admin.id, "select public.replace_rate_card_zones($1, $2::jsonb)", [draft, JSON.stringify(good)]), /not a draft/);
  });
});
