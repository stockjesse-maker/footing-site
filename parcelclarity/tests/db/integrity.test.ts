import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createTenant, createUser, expectDenied, sql } from "./harness";
import { buildWorld, type World } from "./world";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

describe("referential integrity", () => {
  it("a membership cannot pair a brand with the wrong tenant (composite FK)", async () => {
    const u = await createUser("fk");
    await expectDenied(
      sql("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1,$2,$3,'brand_admin')", [u.id, w.t1.id, w.brandC.id]),
      /memberships_brand_belongs_to_tenant/,
    );
  });

  it("role and scope must agree", async () => {
    const u = await createUser("scope");
    await expectDenied(sql("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1,$2,$3,'tenant_admin')", [u.id, w.t1.id, w.brandA.id]), /memberships_role_matches_scope/);
    await expectDenied(sql("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1,$2,null,'brand_admin')", [u.id, w.t1.id]), /memberships_role_matches_scope/);
  });

  it("a user has at most one membership per scope", async () => {
    await expectDenied(sql("insert into public.memberships (user_id, tenant_id, role_key) values ($1,$2,'tenant_employee')", [w.t1.employee.id, w.t1.id]), /memberships_staff_key/);
    await expectDenied(sql("insert into public.memberships (user_id, tenant_id, brand_id, role_key) values ($1,$2,$3,'brand_employee')", [w.brandA.admin.id, w.t1.id, w.brandA.id]), /memberships_brand_key/);
  });

  it("brand names are unique per tenant (case-insensitive) but may repeat across tenants", async () => {
    await expectDenied(asUser(w.t1.admin.id, "insert into public.brands (tenant_id, name) values ($1, '  ALPHA apparel ')", [w.t1.id]), /brands_tenant_name_key/);
    await asUser(w.t2.admin.id, "insert into public.brands (tenant_id, name) values ($1, 'Alpha Apparel')", [w.t2.id]);
  });
});

describe("guard triggers", () => {
  it("a tenant always keeps one active administrator", async () => {
    const solo = await createUser("solo");
    const tenant = await createTenant(solo, "Solo Freight");
    await expectDenied(sql("update public.memberships set status = 'suspended' where tenant_id = $1", [tenant]), /at least one active administrator/);
    await expectDenied(sql("update public.memberships set role_key = 'tenant_employee' where tenant_id = $1", [tenant]), /at least one active administrator/);
  });

  it("an admin can demote a peer admin while another remains", async () => {
    expect(await asUser(w.t1.admin.id, "update public.memberships set role_key = 'tenant_employee' where user_id = $1 returning id", [w.t1.admin2.id])).toHaveLength(1);
    await asUser(w.t1.admin.id, "update public.memberships set role_key = 'tenant_admin' where user_id = $1", [w.t1.admin2.id]);
  });

  it("membership identity columns are immutable even for privileged writers", async () => {
    await expectDenied(sql("update public.memberships set tenant_id = $1 where user_id = $2", [w.t2.id, w.t1.employee.id]), /immutable/);
  });

  it("a revoked brand can never be reactivated and a brand cannot move tenants", async () => {
    await asUser(w.t2.admin.id, "update public.brands set status = 'revoked' where id = $1", [w.brandC.id]);
    await expectDenied(asUser(w.t2.admin.id, "update public.brands set status = 'active' where id = $1", [w.brandC.id]), /cannot be reactivated/);
    await expectDenied(sql("update public.brands set tenant_id = $1 where id = $2", [w.t2.id, w.brandA.id]), /cannot change/);
    // Revoked brand members lose access; staff keep visibility.
    expect(await asUser(w.brandC.admin.id, "select id from public.brands")).toHaveLength(0);
    expect((await asUser(w.t2.admin.id, "select id from public.brands")).length).toBeGreaterThan(0);
  });

  it("limits how many tenants one user can create", async () => {
    const prolific = await createUser("prolific");
    for (const n of [1, 2, 3]) await createTenant(prolific, `Tenant ${n}`);
    await expectDenied(createTenant(prolific, "Tenant 4"), /tenant limit reached/);
  });

  it("rejects invalid tenant names", async () => {
    const u = await createUser("badname");
    await expectDenied(createTenant(u, "   "), /invalid tenant name/);
  });
});

describe("profiles", () => {
  it("are created automatically for new auth users with a lower-cased email", async () => {
    const u = await createUser("profile");
    const [p] = await sql<{ email: string; full_name: string }>("select email, full_name from public.profiles where id = $1", [u.id]);
    expect(p).toEqual({ email: u.email.toLowerCase(), full_name: "User profile" });
  });

  it("follow email changes made in Supabase Auth", async () => {
    const u = await createUser("emailchange");
    await sql("update auth.users set email = $2 where id = $1", [u.id, `Changed-${u.id.slice(0, 6)}@Example.test`]);
    const [p] = await sql<{ email: string }>("select email from public.profiles where id = $1", [u.id]);
    expect(p?.email).toBe(`changed-${u.id.slice(0, 6)}@example.test`);
  });
});

describe("role and permission reference data", () => {
  it("every permission referenced by a role exists and each role has a scope", async () => {
    const orphans = await sql("select rp.* from public.role_permissions rp left join public.permissions p on p.key = rp.permission_key where p.key is null");
    expect(orphans).toHaveLength(0);
    const roles = await sql<{ key: string; scope: string }>("select key, scope from public.roles order by key");
    expect(roles).toEqual([
      { key: "brand_admin", scope: "brand" },
      { key: "brand_employee", scope: "brand" },
      { key: "tenant_admin", scope: "tenant" },
      { key: "tenant_employee", scope: "tenant" },
    ]);
  });
});

describe("rate limiting", () => {
  it("allows up to the limit per window, per user and action, then blocks", async () => {
    const u = await createUser("ratelimited");
    const other = await createUser("bystander");
    const hit = (user: string, action = "invite.create") =>
      asUser<{ check_rate_limit: boolean }>(user, "select public.check_rate_limit($1, 3, 60) as check_rate_limit", [action]).then((r) => r[0]!.check_rate_limit);
    expect([await hit(u.id), await hit(u.id), await hit(u.id)]).toEqual([true, true, true]);
    expect(await hit(u.id)).toBe(false);
    expect(await hit(u.id, "brand.create")).toBe(true); // separate action budget
    expect(await hit(other.id)).toBe(true); // separate user budget
  });

  it("cannot be read or tampered with directly, and anon cannot call it", async () => {
    await expectDenied(asUser(w.t1.admin.id, "select * from public.rate_limit_counters"), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "delete from public.rate_limit_counters"), /permission denied/);
    await expectDenied(asUser(null, "select public.check_rate_limit('x.y', 1, 60)"), /permission denied/);
  });
});

describe("platform administrator check", () => {
  it("is true only for platform administrators", async () => {
    const check = (id: string) => asUser<{ is_platform_admin: boolean }>(id, "select public.is_platform_admin() as is_platform_admin").then((r) => r[0]!.is_platform_admin);
    expect(await check(w.platformAdmin.id)).toBe(true);
    expect(await check(w.t1.admin.id)).toBe(false);
    expect(await check(w.outsider.id)).toBe(false);
  });
});
