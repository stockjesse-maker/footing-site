import type { Metadata } from "next";
import Link from "next/link";
import { signUp } from "@/app/actions/auth";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { safeNext } from "@/lib/auth/safe-redirect";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  const invited = next.startsWith("/accept-invite");
  return (
    <Card>
      <CardTitle className="text-2xl">{invited ? "Create your account" : "Create your 3PL account"}</CardTitle>
      <CardDescription>
        {invited ? "Use the email address your invitation was sent to." : "Set up your workspace to share customer-facing shipping and fulfillment pricing with your brands."}
      </CardDescription>
      <ActionForm action={signUp} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={next} />
        <TextField name="fullName" label="Your name" autoComplete="name" required />
        {invited ? null : <TextField name="companyName" label="Company name" autoComplete="organization" required />}
        <TextField name="email" label="Email" type="email" autoComplete="email" required />
        <TextField name="password" label="Password" type="password" autoComplete="new-password" required hint="At least 10 characters." />
        <SubmitButton className="w-full" size="lg" pendingLabel="Creating account…">Create account</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline" href={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </Card>
  );
}
