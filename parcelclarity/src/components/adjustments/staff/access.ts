import { can, type Role } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";

/**
 * What the signed-in staff member may do on the Adjustments screens. `adjustment.view` reads; `adjustment.manage` writes and also reads
 * (the database's `can_view_adjustments` is "view or manage"). Hiding a control is never the security: every action and the database
 * authorize again. This only decides what the page shows.
 */
export function adjustmentPermissions(role: Role): { canView: boolean; canManage: boolean } {
  const canManage = can(role, "adjustment.manage");
  return { canView: canManage || can(role, "adjustment.view"), canManage };
}

/**
 * The tenant context for an adjustments page. It does NOT 404 a member who lacks the permission (an employee who opens the URL reads the
 * "only administrators" notice instead, like the customer page does); the page renders `AdjustmentsRestricted` when `canView` is false.
 */
export async function adjustmentAccess() {
  const ctx = await requireTenantContext();
  return { ctx, tenantId: ctx.active.tenantId, tenantName: ctx.active.tenantName, ...adjustmentPermissions(ctx.active.role) };
}
