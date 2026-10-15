import type { Metadata } from "next";
import { InviteForm } from "@/components/team/invite-form";
import { MembersList, PendingInvitations, type InvitationRow, type MemberRow } from "@/components/team/members";
import { PageHeader } from "@/components/ui/page-header";
import { assignableRoles, can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const ctx = await requireTenantContext("member.view");
  const supabase = await createClient();
  const [members, invites] = await Promise.all([
    supabase.from("memberships").select("id, user_id, role_key, status, profiles(full_name, email)").eq("tenant_id", ctx.active.tenantId).is("brand_id", null).order("created_at").overrideTypes<MemberRow[], { merge: false }>(),
    supabase.from("invitations").select("id, email, role_key, expires_at, brand_id").eq("tenant_id", ctx.active.tenantId).is("brand_id", null).is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }),
  ]);
  const canManage = can(ctx.active.role, "staff.manage");
  return (
    <>
      <PageHeader title="Team" description={`People at ${ctx.active.tenantName} who can manage customers and pricing.`} />
      <div className="space-y-8">
        <MembersList members={members.data ?? []} currentUserId={ctx.user.id} canManage={canManage} />
        <PendingInvitations invitations={(invites.data ?? []) as InvitationRow[]} canManage={canManage} />
        <InviteForm roles={assignableRoles(ctx.active.role, "tenant")} title="Invite a teammate" description="Administrators manage everything. Employees can work with customers and quotes but can't change account structure." />
      </div>
    </>
  );
}
