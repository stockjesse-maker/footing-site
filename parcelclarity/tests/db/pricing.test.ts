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
    expect(await asUser(w.brandA.admin.id, "select id from public.surcharge_rule_versions where id = $1 and status = 'published'", [ruleV1])).toHaveLength(1);
    expect(await asUser(w.brandC.admin.id, "select id from public.surcharge_rule_versions where id = $1", [ruleV1])).toHaveLength(0);
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
    await asUser(w.t1.admin.id, "select public.retire_surcharge_rule_version($1)", [ruleV1]);
    await asUser(w.t1.admin.id, "select public.publish_surcharge_rule_version($1)", [v2!.id]);
    expect(await asUser(w.brandA.admin.id, "select id from public.surcharge_rule_versions where rule_id = $1 and status = 'published'", [ruleId])).toHaveLength(1);
    await expectDenied(sql("update public.surcharge_rule_versions set status = 'published' where id = $1", [ruleV1]), /cannot be reactivated/);
  });

  it("nobody can create platform-scope rules through the Data API, but everyone can read published ones", async () => {
    await expectDenied(asUser(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('platform', null, 'ups', 'ups.fuel', 'fuel', 'Fuel')"), /row-level security/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('tenant', $1, 'ups', 'sneaky', 'fuel', 'Fuel')", [w.t2.id]), /row-level security/);
    const [pr] = await sql<{ id: string }>("insert into public.surcharge_rules (scope, tenant_id, carrier_code, rule_key, category, name) values ('platform', null, 'ups', 'ups.fuel', 'fuel', 'UPS fuel surcharge') returning id");
    const [pv] = await sql<{ id: string }>(
      `insert into public.surcharge_rule_versions (rule_id, tenant_id, version_number, charge_class, method, percent, effective_date, source_reference, verification_status, status, published_at)
       values ($1, null, 1, 'definite', 'percent', 0, '2026-01-01', 'placeholder: amount must be entered from the published schedule', 'unverified', 'published', now()) returning id`,
      [pr!.id],
    );
    for (const user of [w.t1.admin, w.brandA.admin, w.brandC.admin, w.t2.admin]) {
      expect(await asUser(user.id, "select id from public.surcharge_rule_versions where id = $1", [pv!.id]), user.email).toHaveLength(1);
    }
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
  });

  it("ZIP lists: tenant lists are readable by the tenant's brands only", async () => {
    const [l] = await asUser<{ id: string }>(
      w.t1.admin.id,
      "insert into public.zip_lists (tenant_id, carrier_code, key, name, source_reference, verification_status, effective_date, entry_count) values ($1, 'ups', 'northwind.das', 'DAS ZIPs', 'Uploaded from carrier bulletin', 'approved_3pl_config', '2026-01-01', 2) returning id",
      [w.t1.id],
    );
    await asUser(w.t1.admin.id, "insert into public.zip_list_entries (list_id, entry) values ($1, '93920'), ($1, '958')", [l!.id]);
    expect(await asUser(w.brandA.employee.id, "select entry from public.zip_list_entries where list_id = $1", [l!.id])).toHaveLength(2);
    expect(await asUser(w.brandC.admin.id, "select entry from public.zip_list_entries where list_id = $1", [l!.id])).toHaveLength(0);
    expect(await asUser(w.t2.admin.id, "select id from public.zip_lists where id = $1", [l!.id])).toHaveLength(0);
    await expectDenied(asUser(w.t1.employee.id, "insert into public.zip_list_entries (list_id, entry) values ($1, '10001')", [l!.id]), /row-level security/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.zip_lists (tenant_id, key, name, source_reference, verification_status, effective_date) values (null, 'ups.das', 'x', 'x', 'verified', '2026-01-01')"), /row-level security/);
  });
});

describe("audit trail for pricing", () => {
  it("records card creation, activation, assignment and rule publication with the actor", async () => {
    const rows = await sql<{ action: string; actor_id: string }>("select action, actor_id from public.audit_events where tenant_id = $1 and action like 'ratecard.%' or (tenant_id = $1 and action like 'carrier_rule.%')", [w.t1.id]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["ratecard.created", "ratecard.version_active", "ratecard.version_archived", "ratecard.version_discarded", "ratecard.assigned", "ratecard.unassigned", "carrier_rule.published", "carrier_rule.retired", "ratecard.override_created"]) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(rows.every((r) => r.actor_id === w.t1.admin.id)).toBe(true);
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
    const [entries] = await asUser<{ e: string[] }>(w.brandA.employee.id, "select public.zip_list_entries_array($1) as e", [list!.id]);
    expect(entries!.e).toEqual(["93920", "958"]);
    const [noEntries] = await asUser<{ e: string[] }>(w.brandC.admin.id, "select public.zip_list_entries_array($1) as e", [list!.id]);
    expect(noEntries!.e).toEqual([]);
  });
});
