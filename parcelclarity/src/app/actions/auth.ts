"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { safeNext } from "@/lib/auth/safe-redirect";
import { fieldErrors, emailSchema, nameSchema, passwordSchema } from "@/lib/auth/validation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { setActiveContext } from "@/app/actions/context";

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const callbackUrl = (next: string) => `${publicEnv.NEXT_PUBLIC_SITE_URL}/auth/confirm?next=${encodeURIComponent(next)}`;

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password.").max(200) }).safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  const values = { email: String(formData.get("email") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // One message for wrong email and wrong password, so accounts cannot be enumerated.
    if (error.code === "email_not_confirmed") return { ok: false, message: "Please confirm your email address first. Check your inbox for the confirmation link.", values };
    return { ok: false, message: "Incorrect email or password.", values };
  }
  redirect(safeNext(formData.get("next")));
}

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const next = safeNext(formData.get("next"));
  const invited = next.startsWith("/accept-invite");
  const parsed = z
    .object({
      fullName: nameSchema,
      companyName: invited ? z.string().optional() : nameSchema,
      email: emailSchema,
      password: passwordSchema,
    })
    .safeParse({
      fullName: formData.get("fullName"),
      companyName: formData.get("companyName") ?? undefined,
      email: formData.get("email"),
      password: formData.get("password"),
    });
  const values = {
    fullName: String(formData.get("fullName") ?? ""),
    companyName: String(formData.get("companyName") ?? ""),
    email: String(formData.get("email") ?? ""),
  };
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    if (errors.companyName) errors.companyName = "Enter your company name.";
    return { ok: false, errors, values };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: callbackUrl(next),
      data: { full_name: parsed.data.fullName, ...(invited ? {} : { company_name: parsed.data.companyName }) },
    },
  });
  if (error) {
    if (error.code === "weak_password") return { ok: false, errors: { password: "Choose a stronger password." }, values };
    if (error.code === "over_email_send_rate_limit" || error.status === 429) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }
  // With email confirmation on (required in production) there is no session yet.
  if (data.session) redirect(next);
  return { ok: true, message: `Check ${parsed.data.email} for a confirmation link to finish creating your account.` };
}

export async function requestPasswordReset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  const values = { email: String(formData.get("email") ?? "") };
  if (!parsed.success) return { ok: false, errors: { email: parsed.error.issues[0]?.message ?? "Enter a valid email address." }, values };
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: callbackUrl("/reset-password") });
  if (error?.status === 429) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
  // Identical response whether or not the address has an account.
  return { ok: true, message: "If that email address has an account, a reset link is on its way." };
}

export async function updatePassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser("/reset-password");
  const parsed = z
    .object({ password: passwordSchema, confirm: z.string() })
    .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." })
    .safeParse({ password: formData.get("password"), confirm: formData.get("confirm") });
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === "same_password") return { ok: false, errors: { password: "Choose a password you haven't used before." } };
    if (error.code === "weak_password") return { ok: false, errors: { password: "Choose a stronger password." } };
    return { ok: false, message: GENERIC_FAILURE };
  }
  // End every other session so a stolen session cannot outlive a password change.
  await supabase.auth.signOut({ scope: "others" });
  redirect("/?password=updated");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function createWorkspace(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser("/onboarding");
  const parsed = z.object({ name: nameSchema }).safeParse({ name: formData.get("name") });
  const values = { name: String(formData.get("name") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "tenant.create", 5, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
  const { error } = await supabase.rpc("create_tenant", { p_name: parsed.data.name });
  if (error) {
    if (error.message.includes("tenant limit")) return { ok: false, message: "This account has reached its limit of workspaces.", values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }
  redirect("/");
}

export async function acceptInvitation(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();
  const token = String(formData.get("token") ?? "");
  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "invite.accept", 10, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE };
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) {
    if (error.message.includes("email_not_confirmed")) return { ok: false, message: "Confirm your email address first, then open the invitation link again." };
    return { ok: false, message: "This invitation is invalid, has expired, or was sent to a different email address." };
  }
  if (typeof data === "string") await setActiveContext(data);
  redirect("/");
}
