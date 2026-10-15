import { beforeAll, describe, expect, it } from "vitest";
import { asUser, expectDenied } from "./harness";
import { buildWorld, type World } from "./world";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("anonymous access", () => {
  it.each(["tenants", "brands", "memberships", "invitations", "audit_events", "profiles", "platform_admins", "roles"])(
    "anon cannot read %s",
    async (table) => {
      await expectDenied(asUser(null, `select * from public.${table}`), /permission denied/);
    },
  );
  it("anon cannot call RPC functions", async () => {
    await expectDenied(asUser(null, "select public.create_tenant('x')"), /permission denied/);
    await expectDenied(asUser(null, "select public.accept_invitation('x')"), /permission denied/);
  });
});

describe("tenant isolation", () => {
  it("tenant admins see only their own tenant", async () => {
    expect(ids(await asUser(w.t1.admin.id, "select id from public.tenants"))).toEqual([w.t1.id]);
    expect(ids(await asUser(w.t2.admin.id, "select id from public.tenants"))).toEqual([w.t2.id]);
  });

  it("tenant admins see only their own tenant's brands", async () => {
    expect(ids(await asUser(w.t1.admin.id, "select id from public.brands"))).toEqual([w.brandA.id, w.brandB.id].sort());
    expect(ids(await asUser(w.t2.admin.id, "select id from public.brands"))).toEqual([w.brandC.id]);
  });

  it("fetching another tenant's records by ID returns nothing", async () => {
    expect(await asUser(w.t1.admin.id, "select id from public.brands where id = $1", [w.brandC.id])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "select id from public.tenants where id = $1", [w.t2.id])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "select id from public.memberships where tenant_id = $1", [w.t2.id])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "select id from public.audit_events where tenant_id = $1", [w.t2.id])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "select id from public.invitations where tenant_id = $1", [w.t2.id])).toHaveLength(0);
  });

  it("cannot create a brand in another tenant by supplying its tenant_id", async () => {
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.brands (tenant_id, name) values ($1, 'Smuggled')", [w.t2.id]),
      /row-level security/,
    );
  });

  it("cannot modify another tenant's brand or tenant row (0 rows affected)", async () => {
    expect(await asUser(w.t1.admin.id, "update public.brands set name = 'Hijacked' where id = $1 returning id", [w.brandC.id])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "update public.tenants set name = 'Hijacked' where id = $1 returning id", [w.t2.id])).toHaveLength(0);
  });

  it("users without any membership see nothing", async () => {
    for (const table of ["tenants", "brands", "memberships", "invitations", "audit_events"]) {
      expect(await asUser(w.outsider.id, `select * from public.${table}`), table).toHaveLength(0);
    }
  });
});

describe("brand isolation", () => {
  it("a brand member sees only their own brand and tenant", async () => {
    expect(ids(await asUser(w.brandA.admin.id, "select id from public.brands"))).toEqual([w.brandA.id]);
    expect(ids(await asUser(w.brandA.employee.id, "select id from public.brands"))).toEqual([w.brandA.id]);
    expect(ids(await asUser(w.brandB.admin.id, "select id from public.brands"))).toEqual([w.brandB.id]);
    expect(ids(await asUser(w.brandA.admin.id, "select id from public.tenants"))).toEqual([w.t1.id]);
  });

  it("a brand member cannot fetch a sibling brand (same tenant) or another tenant's brand by ID", async () => {
    expect(await asUser(w.brandA.admin.id, "select id from public.brands where id = $1", [w.brandB.id])).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select id from public.brands where id = $1", [w.brandC.id])).toHaveLength(0);
  });

  it("brand admins see only memberships of their own brand, never tenant staff or sibling brands", async () => {
    const rows = await asUser<{ user_id: string; brand_id: string | null }>(w.brandA.admin.id, "select user_id, brand_id from public.memberships");
    expect(rows.every((r) => r.brand_id === w.brandA.id || r.user_id === w.brandA.admin.id)).toBe(true);
    const users = rows.map((r) => r.user_id);
    expect(users).toEqual(expect.arrayContaining([w.brandA.admin.id, w.brandA.employee.id]));
    expect(users).not.toContain(w.t1.admin.id);
    expect(users).not.toContain(w.brandB.admin.id);
  });

  it("brand employees see only their own membership", async () => {
    const rows = await asUser<{ user_id: string }>(w.brandA.employee.id, "select user_id from public.memberships");
    expect(rows.map((r) => r.user_id)).toEqual([w.brandA.employee.id]);
  });

  it("brand members cannot read invitations or the audit log", async () => {
    expect(await asUser(w.brandA.employee.id, "select * from public.invitations")).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "select * from public.audit_events")).toHaveLength(0);
  });

  it("a brand admin cannot see profiles outside their brand", async () => {
    const rows = await asUser<{ id: string }>(w.brandA.admin.id, "select id from public.profiles");
    const seen = rows.map((r) => r.id);
    expect(seen).toEqual(expect.arrayContaining([w.brandA.admin.id, w.brandA.employee.id]));
    for (const other of [w.t1.admin.id, w.t2.admin.id, w.brandB.admin.id, w.brandC.admin.id, w.outsider.id]) {
      expect(seen).not.toContain(other);
    }
  });

  it("a brand member cannot rename or suspend their own brand", async () => {
    expect(await asUser(w.brandA.admin.id, "update public.brands set name = 'Mine' where id = $1 returning id", [w.brandA.id])).toHaveLength(0);
  });
});

describe("3PL employee permissions", () => {
  it("can view all brands of their tenant but not manage them", async () => {
    expect(ids(await asUser(w.t1.employee.id, "select id from public.brands"))).toEqual([w.brandA.id, w.brandB.id].sort());
    await expectDenied(asUser(w.t1.employee.id, "insert into public.brands (tenant_id, name) values ($1, 'Nope')", [w.t1.id]), /row-level security/);
    expect(await asUser(w.t1.employee.id, "update public.brands set status = 'suspended' where id = $1 returning id", [w.brandA.id])).toHaveLength(0);
  });

  it("cannot see members, invitations or audit events", async () => {
    const members = await asUser<{ user_id: string }>(w.t1.employee.id, "select user_id from public.memberships");
    expect(members.map((m) => m.user_id)).toEqual([w.t1.employee.id]);
    expect(await asUser(w.t1.employee.id, "select * from public.invitations")).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select * from public.audit_events")).toHaveLength(0);
  });
});

describe("platform administrators", () => {
  it("can list tenants but get no policy access to confidential tenant data", async () => {
    const tenants = ids(await asUser(w.platformAdmin.id, "select id from public.tenants"));
    expect(tenants).toEqual(expect.arrayContaining([w.t1.id, w.t2.id]));
    for (const table of ["brands", "invitations", "audit_events"]) {
      expect(await asUser(w.platformAdmin.id, `select * from public.${table}`), table).toHaveLength(0);
    }
    const memberships = await asUser<{ user_id: string }>(w.platformAdmin.id, "select user_id from public.memberships");
    expect(memberships).toHaveLength(0);
    const profiles = await asUser<{ id: string }>(w.platformAdmin.id, "select id from public.profiles");
    expect(profiles.map((p) => p.id)).toEqual([w.platformAdmin.id]);
  });

  it("cannot read the platform_admins table through the Data API", async () => {
    await expectDenied(asUser(w.platformAdmin.id, "select * from public.platform_admins"), /permission denied/);
  });

  it("cannot edit tenants directly", async () => {
    expect(await asUser(w.platformAdmin.id, "update public.tenants set name = 'x' where id = $1 returning id", [w.t1.id])).toHaveLength(0);
    await expectDenied(asUser(w.platformAdmin.id, "update public.tenants set status = 'suspended' where id = $1", [w.t1.id]), /permission denied/);
  });
});
