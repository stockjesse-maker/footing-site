// Role and permission model. The database (public.role_permissions) is the source of
// truth for Row Level Security; this module mirrors it for server-side checks and UI
// labels. tests/db/permissions-parity.test.ts fails if the two ever drift apart.

export const ROLES = ["tenant_admin", "tenant_employee", "brand_admin", "brand_employee"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "tenant.manage",
  "staff.manage",
  "brand.view",
  "brand.create",
  "brand.manage",
  "member.view",
  "member.manage",
  "audit.view",
  "ratecard.view",
  "ratecard.manage",
  "simulation.run",
  "report.view",
  "adjustment.view",
  "adjustment.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  tenant_admin: [
    "tenant.manage", "staff.manage", "brand.view", "brand.create", "brand.manage", "member.view",
    "member.manage", "audit.view", "ratecard.view", "ratecard.manage", "simulation.run", "report.view",
    // Milestone 5: adjustment policies, imported history, examples and risk estimates are administrator-only.
    "adjustment.view", "adjustment.manage",
  ],
  tenant_employee: ["brand.view", "ratecard.view", "simulation.run", "report.view"],
  brand_admin: ["brand.view", "member.view", "member.manage", "simulation.run", "report.view"],
  brand_employee: ["brand.view", "simulation.run", "report.view"],
};

export const ROLE_LABELS: Record<Role, string> = {
  tenant_admin: "3PL administrator",
  tenant_employee: "3PL employee",
  brand_admin: "Brand administrator",
  brand_employee: "Brand employee",
};

export type Portal = "tenant" | "brand";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function portalForRole(role: Role): Portal {
  return role === "tenant_admin" || role === "tenant_employee" ? "tenant" : "brand";
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles an actor may grant. Mirrors app.can_assign_role(): staff roles need staff.manage, brand roles need member.manage. */
export function assignableRoles(actor: Role, scope: Portal): Role[] {
  if (scope === "tenant") return can(actor, "staff.manage") ? ["tenant_admin", "tenant_employee"] : [];
  return can(actor, "member.manage") ? ["brand_admin", "brand_employee"] : [];
}
