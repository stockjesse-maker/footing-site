import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, assignableRoles, can, isRole, portalForRole } from "@/lib/auth/permissions";

describe("role model", () => {
  it("maps every role to exactly one portal", () => {
    expect(ROLES.map((r) => [r, portalForRole(r)])).toEqual([
      ["tenant_admin", "tenant"],
      ["tenant_employee", "tenant"],
      ["brand_admin", "brand"],
      ["brand_employee", "brand"],
    ]);
  });

  it("only references known permissions", () => {
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });

  it("never gives brand roles any 3PL-only permission", () => {
    const tenantOnly = ["tenant.manage", "staff.manage", "brand.create", "brand.manage", "audit.view", "ratecard.manage", "adjustment.view", "adjustment.manage"] as const;
    for (const role of ["brand_admin", "brand_employee"] as const) for (const p of tenantOnly) expect(can(role, p), `${role} ${p}`).toBe(false);
  });

  it("only 3PL administrators manage account structure and the audit log", () => {
    for (const p of ["tenant.manage", "staff.manage", "brand.create", "brand.manage", "audit.view"] as const) {
      expect(can("tenant_admin", p)).toBe(true);
      expect(can("tenant_employee", p)).toBe(false);
    }
  });

  it("adjustment risk (policies, imported history, examples, estimates) is administrator-only", () => {
    for (const p of ["adjustment.view", "adjustment.manage"] as const) {
      expect(can("tenant_admin", p)).toBe(true);
      for (const role of ["tenant_employee", "brand_admin", "brand_employee"] as const) expect(can(role, p), `${role} ${p}`).toBe(false);
    }
  });

  it("brand admins manage their team but brand employees do not", () => {
    expect(can("brand_admin", "member.manage")).toBe(true);
    expect(can("brand_employee", "member.manage")).toBe(false);
    expect(can("brand_employee", "member.view")).toBe(false);
  });

  it("validates role strings", () => {
    expect(isRole("tenant_admin")).toBe(true);
    expect(isRole("superuser")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe("assignableRoles (no privilege escalation)", () => {
  it("lets 3PL admins grant staff and brand roles", () => {
    expect(assignableRoles("tenant_admin", "tenant")).toEqual(["tenant_admin", "tenant_employee"]);
    expect(assignableRoles("tenant_admin", "brand")).toEqual(["brand_admin", "brand_employee"]);
  });
  it("lets brand admins grant only brand roles", () => {
    expect(assignableRoles("brand_admin", "tenant")).toEqual([]);
    expect(assignableRoles("brand_admin", "brand")).toEqual(["brand_admin", "brand_employee"]);
  });
  it("lets employees grant nothing", () => {
    for (const role of ["tenant_employee", "brand_employee"] as const) {
      expect(assignableRoles(role, "tenant")).toEqual([]);
      expect(assignableRoles(role, "brand")).toEqual([]);
    }
  });
});
