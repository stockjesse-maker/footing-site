import type { Metadata } from "next";
import Link from "next/link";
import { requestPasswordReset } from "@/app/actions/auth";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardTitle className="text-2xl">Reset your password</CardTitle>
      <CardDescription>Enter your email and we&apos;ll send you a link to choose a new password.</CardDescription>
      <ActionForm action={requestPasswordReset} className="mt-6 space-y-4">
        <TextField name="email" label="Email" type="email" autoComplete="email" required />
        <SubmitButton className="w-full" size="lg" pendingLabel="Sending…">Send reset link</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-center text-sm">
        <Link className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline" href="/login">Back to sign in</Link>
      </p>
    </Card>
  );
}
