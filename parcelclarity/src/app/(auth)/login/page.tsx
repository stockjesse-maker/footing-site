import type { Metadata } from "next";
import Link from "next/link";
import { signIn } from "@/app/actions/auth";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { safeNext } from "@/lib/auth/safe-redirect";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  return (
    <Card>
      <CardTitle className="text-2xl">Sign in</CardTitle>
      <CardDescription>Welcome back.</CardDescription>
      {sp.error ? <Alert tone="danger" className="mt-4">That link is invalid or has expired. Please try again.</Alert> : null}
      <ActionForm action={signIn} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={next} />
        <TextField name="email" label="Email" type="email" autoComplete="email" required />
        <TextField name="password" label="Password" type="password" autoComplete="current-password" required />
        <SubmitButton className="w-full" size="lg" pendingLabel="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <div className="mt-5 flex flex-col gap-2 text-center text-sm">
        <Link className="inline-flex min-h-11 items-center justify-center font-medium text-accent-text hover:underline" href="/forgot-password">Forgot your password?</Link>
        <span className="text-muted">
          New 3PL?{" "}
          <Link className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline" href={next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`}>Create an account</Link>
        </span>
      </div>
    </Card>
  );
}
