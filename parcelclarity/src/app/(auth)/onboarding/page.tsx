import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createWorkspace, signOut } from "@/app/actions/auth";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { getContext, requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Set up your workspace" };

export default async function OnboardingPage() {
  const user = await requireUser("/onboarding");
  if (await getContext()) redirect("/");
  const suggested = typeof user.user_metadata?.company_name === "string" ? user.user_metadata.company_name : "";
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle className="text-2xl">Set up your 3PL workspace</CardTitle>
        <CardDescription>This is the name your brand customers will see.</CardDescription>
        <ActionForm action={createWorkspace} className="mt-6 space-y-4">
          <TextField name="name" label="Company name" autoComplete="organization" defaultValue={suggested} required />
          <SubmitButton className="w-full" size="lg" pendingLabel="Creating…">Create workspace</SubmitButton>
        </ActionForm>
      </Card>
      <Card className="text-sm">
        <p className="font-medium">Were you invited by a 3PL?</p>
        <p className="mt-1 text-muted">Open the link in your invitation email while signed in as {user.email}. You don&apos;t need to create a workspace.</p>
        <form action={signOut} className="mt-3">
          <Button type="submit" variant="secondary" size="sm">Sign out</Button>
        </form>
      </Card>
    </div>
  );
}
