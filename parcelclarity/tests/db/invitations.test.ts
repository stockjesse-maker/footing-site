import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createUser, expectDenied, invite, sql } from "./harness";
import { buildWorld, type World } from "./world";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});

const accept = (userId: string, token: string) => asUser<{ accept_invitation: string }>(userId, "select public.accept_invitation($1) as accept_invitation", [token]);

describe("invitation acceptance", () => {
  it("creates exactly the invited membership and marks the invitation accepted", async () => {
    const invitee = await createUser("newhire");
    const { id, token } = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: invitee.email, role: "brand_employee" });
    const [{ accept_invitation: membershipId }] = (await accept(invitee.id, token)) as [{ accept_invitation: string }];
    const [m] = await sql<{ tenant_id: string; brand_id: string; role_key: string; status: string; user_id: string }>("select * from public.memberships where id = $1", [membershipId]);
    expect(m).toMatchObject({ tenant_id: w.t1.id, brand_id: w.brandA.id, role_key: "brand_employee", status: "active", user_id: invitee.id });
    const [inv] = await sql<{ accepted_by: string; accepted_at: Date }>("select accepted_by, accepted_at from public.invitations where id = $1", [id]);
    expect(inv?.accepted_by).toBe(invitee.id);
    expect(inv?.accepted_at).toBeTruthy();
    // The new member can now see the brand, and only that brand.
    expect((await asUser<{ id: string }>(invitee.id, "select id from public.brands")).map((b) => b.id)).toEqual([w.brandA.id]);
  });

  it("never stores the raw token", async () => {
    const invitee = await createUser("hashcheck");
    const { id, token } = await invite(w.t1.admin, { tenantId: w.t1.id, email: invitee.email, role: "tenant_employee" });
    const [row] = await sql<{ token_hash: Buffer }>("select token_hash from public.invitations where id = $1", [id]);
    expect(row?.token_hash.toString("hex")).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row?.token_hash.toString("utf8")).not.toContain(token);
  });

  it("is single-use", async () => {
    const invitee = await createUser("once");
    const { token } = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: invitee.email, role: "brand_employee" });
    await accept(invitee.id, token);
    await expectDenied(accept(invitee.id, token), /invalid_or_expired_invitation/);
  });

  it("rejects a signed-in user whose email differs from the invitation", async () => {
    const intended = await createUser("intended");
    const thief = await createUser("thief");
    const { token } = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: intended.email, role: "brand_admin" });
    await expectDenied(accept(thief.id, token), /invalid_or_expired_invitation/);
    expect(await sql("select 1 from public.memberships where user_id = $1", [thief.id])).toHaveLength(0);
    await accept(intended.id, token); // still valid for the right person
  });

  it("requires a confirmed email address", async () => {
    const unconfirmed = await createUser("unconfirmed", { confirmed: false });
    const { token } = await invite(w.t1.admin, { tenantId: w.t1.id, email: unconfirmed.email, role: "tenant_employee" });
    await expectDenied(accept(unconfirmed.id, token), /email_not_confirmed/);
  });

  it("rejects expired, revoked, unknown and malformed tokens with the same error", async () => {
    const invitee = await createUser("badtokens");
    const expired = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: invitee.email, role: "brand_employee", expiresInHours: 1 });
    await sql("update public.invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '2 hours' where id = $1", [expired.id]);
    await expectDenied(accept(invitee.id, expired.token), /invalid_or_expired_invitation/);

    const revoked = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandB.id, email: invitee.email, role: "brand_employee" });
    await asUser(w.t1.admin.id, "select public.revoke_invitation($1)", [revoked.id]);
    await expectDenied(accept(invitee.id, revoked.token), /invalid_or_expired_invitation/);

    await expectDenied(accept(invitee.id, "A".repeat(43)), /invalid_or_expired_invitation/);
    await expectDenied(accept(invitee.id, "short"), /invalid_or_expired_invitation/);
  });

  it("cannot accept an invitation to a suspended brand", async () => {
    const invitee = await createUser("suspendedbrand");
    const { token } = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandB.id, email: invitee.email, role: "brand_employee" });
    await asUser(w.t1.admin.id, "update public.brands set status = 'suspended' where id = $1", [w.brandB.id]);
    try {
      await expectDenied(accept(invitee.id, token), /invalid_or_expired_invitation/);
    } finally {
      await asUser(w.t1.admin.id, "update public.brands set status = 'active' where id = $1", [w.brandB.id]);
    }
    await accept(invitee.id, token);
  });

  it("re-activates a previously revoked membership with the newly invited role", async () => {
    const person = await createUser("returning");
    const first = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: person.email, role: "brand_employee" });
    await accept(person.id, first.token);
    await asUser(w.t1.admin.id, "update public.memberships set status = 'revoked' where user_id = $1 and brand_id = $2", [person.id, w.brandA.id]);
    expect(await asUser(person.id, "select id from public.brands")).toHaveLength(0);
    const second = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: person.email, role: "brand_admin" });
    await accept(person.id, second.token);
    const rows = await sql<{ role_key: string; status: string }>("select role_key, status from public.memberships where user_id = $1", [person.id]);
    expect(rows).toEqual([{ role_key: "brand_admin", status: "active" }]);
  });

  it("allows only one pending invitation per email and scope", async () => {
    const email = `dup-${Date.now()}@example.test`;
    await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email, role: "brand_employee" });
    await expectDenied(invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email, role: "brand_employee" }), /invitations_pending_key/);
  });
});

describe("invitation visibility and revocation", () => {
  it("tenant admins see tenant and brand invitations; brand admins see only their brand's", async () => {
    const a = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: `va-${Date.now()}@example.test`, role: "brand_employee" });
    const b = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandB.id, email: `vb-${Date.now()}@example.test`, role: "brand_employee" });
    const staff = await invite(w.t1.admin, { tenantId: w.t1.id, email: `vs-${Date.now()}@example.test`, role: "tenant_employee" });
    const adminSees = (await asUser<{ id: string }>(w.t1.admin.id, "select id from public.invitations")).map((r) => r.id);
    expect(adminSees).toEqual(expect.arrayContaining([a.id, b.id, staff.id]));
    const brandSees = (await asUser<{ id: string }>(w.brandA.admin.id, "select id from public.invitations")).map((r) => r.id);
    expect(brandSees).toContain(a.id);
    expect(brandSees).not.toContain(b.id);
    expect(brandSees).not.toContain(staff.id);
    expect((await asUser(w.brandC.admin.id, "select id from public.invitations where id = $1", [a.id]))).toHaveLength(0);
  });

  it("only someone who can manage the scope may revoke", async () => {
    const inv = await invite(w.t1.admin, { tenantId: w.t1.id, brandId: w.brandA.id, email: `rv-${Date.now()}@example.test`, role: "brand_employee" });
    await expectDenied(asUser(w.brandB.admin.id, "select public.revoke_invitation($1)", [inv.id]), /invitation not found/);
    await expectDenied(asUser(w.brandC.admin.id, "select public.revoke_invitation($1)", [inv.id]), /invitation not found/);
    await expectDenied(asUser(w.t1.employee.id, "select public.revoke_invitation($1)", [inv.id]), /invitation not found/);
    await asUser(w.brandA.admin.id, "select public.revoke_invitation($1)", [inv.id]);
    await expectDenied(asUser(w.t1.admin.id, "select public.revoke_invitation($1)", [inv.id]), /no longer pending/);
  });

  it("invitations cannot be updated or deleted directly", async () => {
    await expectDenied(asUser(w.t1.admin.id, "update public.invitations set role_key = 'tenant_admin'"), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "update public.invitations set revoked_at = null"), /permission denied/);
    await expectDenied(asUser(w.t1.admin.id, "delete from public.invitations"), /permission denied/);
  });
});
