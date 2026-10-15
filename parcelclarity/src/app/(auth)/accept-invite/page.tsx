import type { Metadata } from "next";
import Link from "next/link";
import { acceptInvitation } from "@/app/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { getUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token;
  if (!token || token.length < 20 || token.length > 200) {
    return (
      <Card>
        <CardTitle className="text-2xl">Invitation link incomplete</CardTitle>
        <CardDescription>Open the full link from your invitation email, or ask the person who invited you to send a new one.</CardDescription>
      </Card>
    );
  }
  const next = `/accept-invite?token=${encodeURIComponent(token)}`;
  const user = await getUser();

  if (!user) {
    return (
      <Card>
        <CardTitle className="text-2xl">You&apos;ve been invited</CardTitle>
        <CardDescription>Sign in, or create an account, using the email address this invitation was sent to.</CardDescription>
        <div className="mt-6 flex flex-col gap-3">
          <ButtonLink href={`/signup?next=${encodeURIComponent(next)}`} size="lg">Create an account</ButtonLink>
          <ButtonLink href={`/login?next=${encodeURIComponent(next)}`} variant="secondary" size="lg">I already have an account</ButtonLink>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle className="text-2xl">Accept your invitation</CardTitle>
      <CardDescription>
        You&apos;re signed in as <strong className="font-medium text-fg">{user.email}</strong>. The invitation must have been sent to this address.
      </CardDescription>
      {user.email_confirmed_at ? null : <Alert tone="warning" className="mt-4">Confirm your email address first using the link we emailed you.</Alert>}
      <ActionForm action={acceptInvitation} className="mt-6 space-y-4">
        <input type="hidden" name="token" value={token} />
        <SubmitButton className="w-full" size="lg" pendingLabel="Joining…">Accept invitation</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-center text-sm text-muted">
        Wrong account? <Link className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline" href={`/login?next=${encodeURIComponent(next)}`}>Sign in with a different email</Link>
      </p>
    </Card>
  );
}
