import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createUser, expectDenied, invite, sql } from "./harness";
import { buildWorld, type World } from "./world";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

describe("audit trail", () => {
  it("records tenant, brand, invitation and membership lifecycle events with the real actor", async () => {
    const rows = await sql<{ action: string; actor_id: string | null }>("select action, actor_id from public.audit_events where tenant_id = $1 order by id", [w.t1.id]);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["tenant.created", "brand.created", "invitation.created", "invitation.accepted", "membership.created"]));
    const brandCreated = rows.filter((r) => r.action === "brand.created");
    expect(brandCreated.every((r) => r.actor_id === w.t1.admin.id)).toBe(true);
  });

  it("does not leak token hashes into audit metadata", async () => {
    const invitee = await createUser("audited");
    const inv = await invite(w.t1.admin, { tenantId: w.t1.id, email: invitee.email, role: "tenant_employee" });
    const rows = await sql<{ metadata: unknown }>("select metadata from public.audit_events where entity_id = $1", [inv.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.stringify(r.metadata)).not.toMatch(/token/i);
  });

  it("is readable only by users with audit.view in that tenant", async () => {
    expect((await asUser(w.t1.admin.id, "select id from public.audit_events")).length).toBeGreaterThan(0);
    const t1Ids = new Set((await sql<{ id: string }>("select id::text as id from public.audit_events where tenant_id = $1", [w.t1.id])).map((r) => r.id));
    const t2Sees = await asUser<{ id: string }>(w.t2.admin.id, "select id::text as id from public.audit_events");
    expect(t2Sees.some((r) => t1Ids.has(r.id))).toBe(false);
    for (const user of [w.t1.employee, w.brandA.admin, w.brandB.admin, w.outsider, w.platformAdmin]) {
      expect(await asUser(user.id, "select id from public.audit_events"), user.email).toHaveLength(0);
    }
  });

  it("is append-only for everyone, including privileged connections", async () => {
    await expectDenied(asUser(w.t1.admin.id, "delete from public.audit_events"), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "update public.audit_events set action = 'x.y'"), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "insert into public.audit_events (action) values ('simulation.run')"), /permission denied/);
    await expectDenied(sql("delete from public.audit_events"), /append-only/);
    await expectDenied(sql("update public.audit_events set action = 'x.y'"), /append-only/);
    await expectDenied(sql("truncate public.audit_events"), /append-only/);
  });
});

describe("log_audit_event()", () => {
  const log = (user: string, tenant: string, brand: string | null, action: string) =>
    asUser(user, "select public.log_audit_event($1, $2, $3, 'simulation', 'sim-1', '{\"n\":1}')", [tenant, brand, action]);

  it("lets members log permitted application events attributed to themselves", async () => {
    await log(w.brandA.employee.id, w.t1.id, w.brandA.id, "simulation.run");
    const [row] = await sql<{ actor_id: string; brand_id: string }>("select actor_id, brand_id from public.audit_events where action = 'simulation.run' and tenant_id = $1 order by id desc limit 1", [w.t1.id]);
    expect(row).toEqual({ actor_id: w.brandA.employee.id, brand_id: w.brandA.id });
  });

  it("rejects non-members, foreign brands and forged security actions", async () => {
    await expectDenied(log(w.outsider.id, w.t1.id, null, "simulation.run"), /not a member/);
    await expectDenied(log(w.t2.admin.id, w.t1.id, null, "simulation.run"), /not a member/);
    await expectDenied(log(w.brandA.admin.id, w.t1.id, w.brandB.id, "simulation.run"), /no access to brand/);
    await expectDenied(log(w.t1.admin.id, w.t1.id, w.brandC.id, "simulation.run"), /no access to brand/);
    await expectDenied(log(w.t1.admin.id, w.t1.id, null, "membership.created"), /not permitted/);
    await expectDenied(log(w.t1.admin.id, w.t1.id, null, "tenant.status_changed"), /not permitted/);
    // Pricing lifecycle events are trigger-only; a member cannot forge an activation or publication.
    await expectDenied(log(w.brandA.employee.id, w.t1.id, null, "ratecard.version_active"), /not permitted/);
    await expectDenied(log(w.t1.admin.id, w.t1.id, null, "carrier_rule.published"), /not permitted/);
    // Adjustment events (Milestone 5) are written by database triggers only, never by a client.
    for (const action of ["adjustment.policy_set", "adjustment.scenario_published", "adjustment.scenario_retired"]) {
      await expectDenied(log(w.brandA.employee.id, w.t1.id, w.brandA.id, action), /not permitted/);
      await expectDenied(log(w.t1.admin.id, w.t1.id, null, action), /not permitted/);
    }
  });
});
