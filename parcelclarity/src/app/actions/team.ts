"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { assignableRoles, can, isRole, ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import { getContext, requireUser } from "@/lib/auth/session";
import { emailSchema, fieldErrors, nameSchema, uuidSchema } from "@/lib/auth/validation";
import { escapeHtml, sendEmail } from "@/lib/email";
import { publicEnv } from "@/lib/env";
import { RATE_LIMITED_MESSAGE, withinRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const GENERIC_FAILURE = "Something went wrong. Please try again.";
const NOT_ALLOWED = "You don't have permission to do that.";
const INVITATION_TTL_HOURS = 7 * 24;

async function requireAnyContext() {
  await requireUser();
  const ctx = await getContext();
  if (!ctx) redirect("/");
  return ctx;
}

// ---------------------------------------------------------------------------
// Customers (brand accounts): 3PL staff only
// ---------------------------------------------------------------------------
export async function createBrand(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireAnyContext();
  if (ctx.active.portal !== "tenant" || !can(ctx.active.role, "brand.create")) return { ok: false, message: NOT_ALLOWED };

  const parsed = z.object({ name: nameSchema }).safeParse({ name: formData.get("name") });
  const values = { name: String(formData.get("name") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  if (!(await withinRateLimit(supabase, "brand.create", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, values };
  const { data, error } = await supabase.from("brands").insert({ tenant_id: ctx.active.tenantId, name: parsed.data.name }).select("id").single();
  if (error) {
    if (error.code === "23505") return { ok: false, errors: { name: "You already have a customer with that name." }, values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }
  revalidatePath("/app/customers");
  redirect(`/app/customers/${data.id}`);
}

export async function setBrandStatus(brandId: string, status: "active" | "suspended" | "revoked"): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireAnyContext();
  const parsed = z.object({ brandId: uuidSchema, status: z.enum(["active", "suspended", "revoked"]) }).safeParse({ brandId, status });
  if (!parsed.success) return { ok: false, message: GENERIC_FAILURE };
  if (ctx.active.portal !== "tenant" || !can(ctx.active.role, "brand.manage")) return { ok: false, message: NOT_ALLOWED };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brands")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.brandId)
    .eq("tenant_id", ctx.active.tenantId)
    .select("id");
  if (error) return { ok: false, message: error.message.includes("cannot be reactivated") ? "A revoked customer cannot be reactivated." : GENERIC_FAILURE };
  if (!data?.length) return { ok: false, message: "Customer not found." };
  revalidatePath("/app/customers", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------
const inviteSchema = z.object({
  email: emailSchema,
  role: z.string().refine(isRole, "Choose a role."),
  brandId: z.preprocess((v) => (v === "" || v == null ? undefined : v), uuidSchema.optional()),
});

export async function inviteMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireAnyContext();
  const parsed = inviteSchema.safeParse({ email: formData.get("email"), role: formData.get("role"), brandId: formData.get("brandId") });
  const values = { email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };
  const role = parsed.data.role as Role;
  const brandId = parsed.data.brandId ?? null;

  // Scope check: where may this actor invite, and for which role? (RLS repeats this in the database.)
  const scope = brandId ? "brand" : "tenant";
  if (!assignableRoles(ctx.active.role, scope).includes(role)) return { ok: false, message: NOT_ALLOWED, values };
  if (brandId) {
    const allowedBrand = ctx.active.portal === "brand" ? ctx.active.brandId === brandId : true;
    if (!allowedBrand) return { ok: false, message: NOT_ALLOWED, values };
  } else if (ctx.active.portal !== "tenant") {
    return { ok: false, message: NOT_ALLOWED, values };
  }

  const supabase = await createClient();
  let brandName: string | null = null;
  if (brandId) {
    const { data: brand } = await supabase.from("brands").select("id, name, tenant_id, status").eq("id", brandId).maybeSingle();
    if (!brand || brand.tenant_id !== ctx.active.tenantId) return { ok: false, message: "Customer not found.", values };
    if (brand.status !== "active") return { ok: false, message: "Reactivate this customer before inviting new users.", values };
    brandName = brand.name;
  }

  if (!(await withinRateLimit(supabase, "invite.create", 30, 3600))) return { ok: false, message: RATE_LIMITED_MESSAGE, values };

  // The raw token exists only in this request, the email, and (if email is unavailable) the admin's screen.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = `\\x${createHash("sha256").update(token, "utf8").digest("hex")}`;
  const { error } = await supabase.from("invitations").insert({
    tenant_id: ctx.active.tenantId,
    brand_id: brandId,
    email: parsed.data.email,
    role_key: role,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000).toISOString(),
  });
  if (error) {
    if (error.code === "23505") return { ok: false, message: "There is already a pending invitation for that email address. Revoke it first to send a new one.", values };
    if (error.code === "42501") return { ok: false, message: NOT_ALLOWED, values };
    return { ok: false, message: GENERIC_FAILURE, values };
  }

  const link = `${publicEnv.NEXT_PUBLIC_SITE_URL}/accept-invite?token=${token}`;
  const inviter = ctx.profile.fullName ?? ctx.profile.email;
  const workspace = brandName ? `${brandName} (via ${ctx.active.tenantName})` : ctx.active.tenantName;
  const delivery = await sendEmail({
    to: parsed.data.email,
    subject: `${inviter} invited you to ${workspace} on ParcelClarity`,
    text: `${inviter} invited you to join ${workspace} on ParcelClarity as ${ROLE_LABELS[role]}.\n\nAccept the invitation: ${link}\n\nThis link expires in 7 days. Sign in or create an account using this email address (${parsed.data.email}).`,
    html: `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(workspace)}</strong> on ParcelClarity as ${escapeHtml(ROLE_LABELS[role])}.</p><p><a href="${escapeHtml(link)}">Accept the invitation</a></p><p>This link expires in 7 days. Sign in or create an account using this email address (${escapeHtml(parsed.data.email)}).</p>`,
  });

  revalidatePath("/app", "layout");
  revalidatePath("/portal", "layout");
  if (delivery === "sent") return { ok: true, message: `Invitation emailed to ${parsed.data.email}.` };
  return {
    ok: true,
    message:
      delivery === "not_configured"
        ? "Invitation created, but email delivery is not configured, so no email was sent. Share this link with the invitee yourself."
        : "Invitation created, but the email could not be sent. Share this link with the invitee yourself.",
    inviteLink: link,
  };
}

export async function revokeInvitation(invitationId: string): Promise<{ ok: boolean; message?: string }> {
  await requireAnyContext();
  if (!uuidSchema.safeParse(invitationId).success) return { ok: false, message: GENERIC_FAILURE };
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_invitation", { p_invitation: invitationId });
  if (error) return { ok: false, message: error.message.includes("no longer pending") ? "That invitation has already been used or revoked." : "Invitation not found." };
  revalidatePath("/app", "layout");
  revalidatePath("/portal", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
export async function setMembershipStatus(membershipId: string, status: "active" | "suspended" | "revoked"): Promise<{ ok: boolean; message?: string }> {
  const ctx = await requireAnyContext();
  const parsed = z.object({ id: uuidSchema, status: z.enum(["active", "suspended", "revoked"]) }).safeParse({ id: membershipId, status });
  if (!parsed.success) return { ok: false, message: GENERIC_FAILURE };
  if (!can(ctx.active.role, "member.manage") && !can(ctx.active.role, "staff.manage")) return { ok: false, message: NOT_ALLOWED };

  const supabase = await createClient();
  // RLS decides whether this membership is manageable by the caller; no rows means "not yours".
  const { data, error } = await supabase
    .from("memberships")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.id)
    .eq("tenant_id", ctx.active.tenantId)
    .select("id");
  if (error) return { ok: false, message: error.message.includes("at least one active administrator") ? "A workspace must keep at least one active administrator." : GENERIC_FAILURE };
  if (!data?.length) return { ok: false, message: NOT_ALLOWED };
  revalidatePath("/app", "layout");
  revalidatePath("/portal", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings and profile
// ---------------------------------------------------------------------------
export async function updateWorkspaceName(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireAnyContext();
  if (ctx.active.portal !== "tenant" || !can(ctx.active.role, "tenant.manage")) return { ok: false, message: NOT_ALLOWED };
  const parsed = z.object({ name: nameSchema }).safeParse({ name: formData.get("name") });
  const values = { name: String(formData.get("name") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };
  const supabase = await createClient();
  const { data, error } = await supabase.from("tenants").update({ name: parsed.data.name }).eq("id", ctx.active.tenantId).select("id");
  if (error || !data?.length) return { ok: false, message: GENERIC_FAILURE, values };
  revalidatePath("/app", "layout");
  return { ok: true, message: "Saved.", values };
}

export async function updateProfileName(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const parsed = z.object({ fullName: nameSchema }).safeParse({ fullName: formData.get("fullName") });
  const values = { fullName: String(formData.get("fullName") ?? "") };
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error), values };
  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").update({ full_name: parsed.data.fullName }).eq("id", user.id).select("id");
  if (error || !data?.length) return { ok: false, message: GENERIC_FAILURE, values };
  revalidatePath("/app", "layout");
  revalidatePath("/portal", "layout");
  return { ok: true, message: "Saved.", values };
}
