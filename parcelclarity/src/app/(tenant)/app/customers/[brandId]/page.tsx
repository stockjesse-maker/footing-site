import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setBrandStatus } from "@/app/actions/team";
import { ConfirmAction } from "@/components/forms/confirm-action";
import { InviteForm } from "@/components/team/invite-form";
import { MembersList, PendingInvitations, type InvitationRow, type MemberRow } from "@/components/team/members";
import { Alert } from "@/components/ui/alert";
import { Badge, statusTone } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { assignableRoles, can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerDetail({ params }: { params: Promise<{ brandId: string }> }) {
  const ctx = await requireTenantContext("brand.view");
  const { brandId } = await params;
  if (!uuidSchema.safeParse(brandId).success) notFound();

  const supabase = await createClient();
  // Row Level Security returns nothing for brands outside this tenant, so a guessed ID is a 404.
  const { data: brand } = await supabase.from("brands").select("id, name, status, tenant_id").eq("id", brandId).maybeSingle();
  if (!brand || brand.tenant_id !== ctx.active.tenantId) notFound();

  const role = ctx.active.role;
  const canViewMembers = can(role, "member.view");
  const canManageMembers = can(role, "member.manage");
  const [members, invites] = await Promise.all([
    canViewMembers
      ? supabase.from("memberships").select("id, user_id, role_key, status, profiles(full_name, email)").eq("brand_id", brandId).order("created_at").overrideTypes<MemberRow[], { merge: false }>()
      : Promise.resolve({ data: null }),
    canViewMembers
      ? supabase.from("invitations").select("id, email, role_key, expires_at, brand_id").eq("brand_id", brandId).is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })
      : Promise.resolve({ data: null }),
  ]);

  const manage = can(role, "brand.manage");
  return (
    <>
      <p className="mb-3 text-sm"><Link href="/app/customers" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">← Customers</Link></p>
      <PageHeader
        title={brand.name}
        description={<Badge tone={statusTone(brand.status)}>{brand.status}</Badge>}
        actions={
          manage && brand.status !== "revoked" ? (
            <>
              {brand.status === "active" ? (
                <ConfirmAction action={setBrandStatus.bind(null, brand.id, "suspended")} label="Suspend access" confirmLabel="Suspend">
                  Their users lose access immediately.
                </ConfirmAction>
              ) : (
                <ConfirmAction action={setBrandStatus.bind(null, brand.id, "active")} label="Reactivate" confirmLabel="Reactivate" variant="ghost" />
              )}
              <ConfirmAction action={setBrandStatus.bind(null, brand.id, "revoked")} label="Revoke" confirmLabel="Revoke permanently" variant="danger">
                Permanent. This cannot be undone.
              </ConfirmAction>
            </>
          ) : undefined
        }
      />
      {brand.status === "suspended" ? <Alert tone="warning" className="mb-6">This customer is suspended. Their users cannot sign in to the portal until you reactivate the account.</Alert> : null}
      {brand.status === "revoked" ? <Alert tone="danger" className="mb-6">This customer&apos;s access was permanently revoked.</Alert> : null}

      {canViewMembers ? (
        <div className="space-y-8">
          <section aria-labelledby="members-heading" className="space-y-3">
            <h2 id="members-heading" className="text-xl font-semibold tracking-tight">Team</h2>
            <MembersList members={members.data ?? []} currentUserId={ctx.user.id} canManage={canManageMembers} />
          </section>
          <PendingInvitations invitations={(invites.data ?? []) as InvitationRow[]} canManage={canManageMembers} />
          {brand.status === "active" ? (
            <InviteForm
              brandId={brand.id}
              roles={assignableRoles(role, "brand")}
              title="Invite a team member"
              description="They'll receive a link to create an account and see only this customer's workspace."
            />
          ) : null}
        </div>
      ) : (
        <Alert>You can view this customer, but only administrators can manage its team.</Alert>
      )}
    </>
  );
}
