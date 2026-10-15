import type { Metadata } from "next";
import { signOut } from "@/app/actions/auth";
import { updateDefaultOriginZip } from "@/app/actions/modeling";
import { updateProfileName, updateWorkspaceName } from "@/app/actions/team";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { requireTenantContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireTenantContext();
  const supabase = await createClient();
  const { data: tenant } = await supabase.from("tenants").select("default_origin_zip").eq("id", ctx.active.tenantId).maybeSingle();
  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-6">
        {can(ctx.active.role, "tenant.manage") ? (
          <Card>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>The name your customers see in their portal.</CardDescription>
            <ActionForm action={updateWorkspaceName} className="mt-5 space-y-4">
              <TextField name="name" label="Company name" defaultValue={ctx.active.tenantName} required />
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}
        {can(ctx.active.role, "ratecard.manage") ? (
          <Card>
            <CardTitle>Ship-from ZIP code</CardTitle>
            <CardDescription>Assumed origin when a customer&apos;s orders file carries none (per-customer values can be set on the assignment). Prices built on it are shown as estimates.</CardDescription>
            <ActionForm action={updateDefaultOriginZip} className="mt-5 space-y-4">
              <TextField name="defaultOriginZip" label="Warehouse ZIP code" defaultValue={(tenant?.default_origin_zip as string | null) ?? ""} placeholder="e.g. 90001" />
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}
        <Card>
          <CardTitle>Your profile</CardTitle>
          <CardDescription>Signed in as {ctx.profile.email}.</CardDescription>
          <ActionForm action={updateProfileName} className="mt-5 space-y-4">
            <TextField name="fullName" label="Your name" autoComplete="name" defaultValue={ctx.profile.fullName ?? ""} required />
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle>Session</CardTitle>
          <form action={signOut} className="mt-4">
            <Button type="submit" variant="secondary">Sign out</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
