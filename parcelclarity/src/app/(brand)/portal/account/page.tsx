import type { Metadata } from "next";
import { signOut } from "@/app/actions/auth";
import { updateProfileName } from "@/app/actions/team";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { InviteForm } from "@/components/team/invite-form";
import { MembersList, PendingInvitations, type InvitationRow, type MemberRow } from "@/components/team/members";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { assignableRoles, can } from "@/lib/auth/permissions";
import { requireBrandContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const ctx = await requireBrandContext();
  const supabase = await createClient();
  const canView = can(ctx.active.role, "member.view");
  const canManage = can(ctx.active.role, "member.manage");
  const [members, invites] = canView
    ? await Promise.all([
        supabase.from("memberships").select("id, user_id, role_key, status, profiles(full_name, email)").eq("brand_id", ctx.active.brandId).order("created_at").overrideTypes<MemberRow[], { merge: false }>(),
        supabase.from("invitations").select("id, email, role_key, expires_at, brand_id").eq("brand_id", ctx.active.brandId).is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }),
      ])
    : [null, null];

  return (
    <>
      <PageHeader title="Account" description={`${ctx.active.brandName} · provided by ${ctx.active.tenantName}`} />
      <div className="space-y-8">
        <Card className="max-w-2xl">
          <CardTitle>Your profile</CardTitle>
          <CardDescription>Signed in as {ctx.profile.email}.</CardDescription>
          <ActionForm action={updateProfileName} className="mt-5 space-y-4">
            <TextField name="fullName" label="Your name" autoComplete="name" defaultValue={ctx.profile.fullName ?? ""} required />
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </ActionForm>
        </Card>

        {members ? (
          <section className="space-y-4" aria-labelledby="team-heading">
            <h2 id="team-heading" className="text-xl font-semibold tracking-tight">Your team</h2>
            <MembersList members={members.data ?? []} currentUserId={ctx.user.id} canManage={canManage} />
            <PendingInvitations invitations={(invites?.data ?? []) as InvitationRow[]} canManage={canManage} />
            <InviteForm brandId={ctx.active.brandId} roles={assignableRoles(ctx.active.role, "brand")} title="Invite a colleague" description="They'll get access to this brand's workspace only." />
          </section>
        ) : null}

        <Card className="max-w-2xl">
          <CardTitle>Session</CardTitle>
          <form action={signOut} className="mt-4">
            <Button type="submit" variant="secondary">Sign out</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
