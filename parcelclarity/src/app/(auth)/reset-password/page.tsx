import type { Metadata } from "next";
import { updatePassword } from "@/app/actions/auth";
import { ActionForm, SubmitButton, TextField } from "@/components/forms/action-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  await requireUser("/reset-password"); // reached via the emailed recovery link, which signs the user in
  return (
    <Card>
      <CardTitle className="text-2xl">Choose a new password</CardTitle>
      <CardDescription>You&apos;ll be signed out of your other devices.</CardDescription>
      <ActionForm action={updatePassword} className="mt-6 space-y-4">
        <TextField name="password" label="New password" type="password" autoComplete="new-password" required hint="At least 10 characters." />
        <TextField name="confirm" label="Confirm new password" type="password" autoComplete="new-password" required />
        <SubmitButton className="w-full" size="lg" pendingLabel="Saving…">Update password</SubmitButton>
      </ActionForm>
    </Card>
  );
}
