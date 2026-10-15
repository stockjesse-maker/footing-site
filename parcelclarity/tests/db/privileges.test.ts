import { beforeAll, describe, expect, it } from "vitest";
import { asUser, expectDenied, newToken, sql } from "./harness";
import { buildWorld, type World } from "./world";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

const inviteSql = `insert into public.invitations (tenant_id, brand_id, email, role_key, token_hash, expires_at)
                   values ($1, $2, $3, $4, $5, now() + interval '48 hours')`;
const tryInvite = (user: string, tenant: string, brand: string | null, role: string) =>
  asUser(user, inviteSql, [tenant, brand, `target-${Math.random().toString(36).slice(2)}@example.test`, role, newToken().hash]);

describe("privilege escalation through invitations", () => {
  it("brand admins can invite only brand roles for their own brand", async () => {
    await tryInvite(w.brandA.admin.id, w.t1.id, w.brandA.id, "brand_employee");
    await tryInvite(w.brandA.admin.id, w.t1.id, w.brandA.id, "brand_admin");
    await expectDenied(tryInvite(w.brandA.admin.id, w.t1.id, null, "tenant_admin"), /row-level security/);
    await expectDenied(tryInvite(w.brandA.admin.id, w.t1.id, null, "tenant_employee"), /row-level security/);
  });

  it("brand admins cannot invite into a sibling brand or another tenant's brand", async () => {
    await expectDenied(tryInvite(w.brandA.admin.id, w.t1.id, w.brandB.id, "brand_employee"), /row-level security/);
    await expectDenied(tryInvite(w.brandA.admin.id, w.t2.id, w.brandC.id, "brand_employee"), /row-level security/);
  });

  it("brand employees and 3PL employees cannot invite anyone", async () => {
    await expectDenied(tryInvite(w.brandA.employee.id, w.t1.id, w.brandA.id, "brand_employee"), /row-level security/);
    await expectDenied(tryInvite(w.t1.employee.id, w.t1.id, w.brandA.id, "brand_employee"), /row-level security/);
    await expectDenied(tryInvite(w.t1.employee.id, w.t1.id, null, "tenant_admin"), /row-level security/);
  });

  it("a tenant admin cannot invite into another tenant, nor mismatch a brand and tenant", async () => {
    await expectDenied(tryInvite(w.t1.admin.id, w.t2.id, w.brandC.id, "brand_admin"), /row-level security/);
    await expectDenied(tryInvite(w.t1.admin.id, w.t1.id, w.brandC.id, "brand_admin"), /row-level security|foreign key/);
    await expectDenied(tryInvite(w.t1.admin.id, w.t1.id, null, "brand_admin"), /row-level security|check constraint/);
  });

  it("cannot spoof the inviter", async () => {
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.invitations (tenant_id, email, role_key, token_hash, expires_at, invited_by) values ($1,'x@example.test','tenant_employee',$2, now() + interval '1 day', $3)",
        [w.t1.id, newToken().hash, w.t1.admin2.id]),
      /permission denied/,
    );
  });

  it("rejects invitations that outlive the maximum window", async () => {
    await expectDenied(
      asUser(w.t1.admin.id, `insert into public.invitations (tenant_id, email, role_key, token_hash, expires_at)
                              values ($1, 'late@example.test', 'tenant_employee', $2, now() + interval '90 days')`, [w.t1.id, newToken().hash]),
      /invitations_expiry_window/,
    );
  });
});

describe("membership changes", () => {
  it("nobody can insert memberships directly", async () => {
    await expectDenied(
      asUser(w.outsider.id, "insert into public.memberships (user_id, tenant_id, role_key) values ($1, $2, 'tenant_admin')", [w.outsider.id, w.t1.id]),
      /permission denied/,
    );
    await expectDenied(
      asUser(w.t1.admin.id, "insert into public.memberships (user_id, tenant_id, role_key) values ($1, $2, 'tenant_admin')", [w.outsider.id, w.t1.id]),
      /permission denied/,
    );
  });

  it("a member cannot change their own role or status", async () => {
    expect(await asUser(w.brandA.admin.id, "update public.memberships set role_key = 'brand_employee' where user_id = $1 returning id", [w.brandA.admin.id])).toHaveLength(0);
    expect(await asUser(w.t1.admin.id, "update public.memberships set status = 'suspended' where user_id = $1 returning id", [w.t1.admin.id])).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "update public.memberships set role_key = 'tenant_admin' where user_id = $1 returning id", [w.t1.employee.id])).toHaveLength(0);
  });

  it("identity columns are not writable by users", async () => {
    await expectDenied(
      asUser(w.t1.admin.id, "update public.memberships set tenant_id = $1 where user_id = $2", [w.t2.id, w.t1.employee.id]),
      /permission denied/,
    );
    await expectDenied(
      asUser(w.t1.admin.id, "update public.memberships set user_id = $1 where user_id = $2", [w.outsider.id, w.t1.employee.id]),
      /permission denied/,
    );
  });

  it("a brand admin cannot promote anyone to a tenant role", async () => {
    await expectDenied(
      asUser(w.brandA.admin.id, "update public.memberships set role_key = 'tenant_admin' where user_id = $1", [w.brandA.employee.id]),
      /row-level security|check constraint/,
    );
  });

  it("a brand admin can suspend a colleague in their own brand but not in another brand or the staff", async () => {
    expect(await asUser(w.brandA.admin.id, "update public.memberships set status = 'suspended' where user_id = $1 returning id", [w.brandA.employee.id])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "update public.memberships set status = 'active' where user_id = $1 returning id", [w.brandA.employee.id])).toHaveLength(1);
    expect(await asUser(w.brandA.admin.id, "update public.memberships set status = 'suspended' where user_id = $1 returning id", [w.brandB.admin.id])).toHaveLength(0);
    expect(await asUser(w.brandA.admin.id, "update public.memberships set status = 'suspended' where user_id = $1 returning id", [w.t1.admin.id])).toHaveLength(0);
  });

  it("a suspended member immediately loses access", async () => {
    await asUser(w.t1.admin.id, "update public.memberships set status = 'suspended' where user_id = $1", [w.t1.employee.id]);
    expect(await asUser(w.t1.employee.id, "select id from public.brands")).toHaveLength(0);
    expect(await asUser(w.t1.employee.id, "select id from public.tenants")).toHaveLength(0);
    await asUser(w.t1.admin.id, "update public.memberships set status = 'active' where user_id = $1", [w.t1.employee.id]);
    expect(await asUser(w.t1.employee.id, "select id from public.brands")).toHaveLength(2);
  });
});

describe("column-level write restrictions", () => {
  it("tenant admins can rename their tenant but cannot change its status or slug", async () => {
    expect(await asUser(w.t1.admin.id, "update public.tenants set name = 'Northwind Logistics' where id = $1 returning id", [w.t1.id])).toHaveLength(1);
    await expectDenied(asUser(w.t1.admin.id, "update public.tenants set status = 'suspended' where id = $1", [w.t1.id]), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "update public.tenants set slug = 'taken' where id = $1", [w.t1.id]), /permission denied/);
  });

  it("users can edit their display name but not their email", async () => {
    expect(await asUser(w.outsider.id, "update public.profiles set full_name = 'Renamed' where id = $1 returning id", [w.outsider.id])).toHaveLength(1);
    await expectDenied(asUser(w.outsider.id, "update public.profiles set email = 'evil@example.test' where id = $1", [w.outsider.id]), /permission denied/);
    expect(await asUser(w.outsider.id, "update public.profiles set full_name = 'Hijack' where id = $1 returning id", [w.t1.admin.id])).toHaveLength(0);
  });

  it("roles and permissions are read-only reference data", async () => {
    await expectDenied(asUser(w.t1.admin.id, "insert into public.role_permissions (role_key, permission_key) values ('brand_employee', 'audit.view')"), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "delete from public.role_permissions"), /permission denied/);
  });

  it("no one can delete tenants, brands or memberships through the Data API", async () => {
    for (const table of ["tenants", "brands", "memberships", "invitations", "profiles"]) {
      await expectDenied(asUser(w.t1.admin.id, `delete from public.${table}`), /permission denied/);
    }
  });
});

describe("platform administrator operations", () => {
  it("only platform admins may change tenant status", async () => {
    await expectDenied(asUser(w.t1.admin.id, "select public.platform_set_tenant_status($1, 'suspended')", [w.t1.id]), /forbidden/);
    await expectDenied(asUser(w.outsider.id, "select public.platform_set_tenant_status($1, 'suspended')", [w.t1.id]), /forbidden/);
  });

  it("a suspended tenant loses all staff and brand access until reactivated", async () => {
    await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'suspended')", [w.t2.id]);
    try {
      expect(await asUser(w.t2.admin.id, "select id from public.brands")).toHaveLength(0);
      await expectDenied(asUser(w.t2.admin.id, "insert into public.brands (tenant_id, name) values ($1, 'New')", [w.t2.id]), /row-level security/);
      expect(await asUser(w.brandC.admin.id, "select id from public.brands")).toHaveLength(0);
      // Members can still see the tenant row so the UI can explain the suspension.
      const [row] = await asUser<{ status: string }>(w.t2.admin.id, "select status from public.tenants where id = $1", [w.t2.id]);
      expect(row?.status).toBe("suspended");
    } finally {
      await asUser(w.platformAdmin.id, "select public.platform_set_tenant_status($1, 'active')", [w.t2.id]);
    }
    expect(await asUser(w.t2.admin.id, "select id from public.brands")).toHaveLength(1);
  });

  it("platform status changes are audited and visible to the tenant's admins", async () => {
    const rows = await asUser<{ action: string }>(w.t2.admin.id, "select action from public.audit_events where action = 'tenant.status_changed'");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const [{ actor_id }] = await sql<{ actor_id: string }>("select actor_id from public.audit_events where tenant_id = $1 and action = 'tenant.status_changed' order by id limit 1", [w.t2.id]) as [{ actor_id: string }];
    expect(actor_id).toBe(w.platformAdmin.id);
  });
});
