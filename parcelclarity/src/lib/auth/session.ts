import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { can, isRole, portalForRole, type Permission, type Portal, type Role } from "@/lib/auth/permissions";

export const CONTEXT_COOKIE = "pc_ctx";

export interface Membership {
  id: string;
  tenantId: string;
  tenantName: string;
  brandId: string | null;
  brandName: string | null;
  role: Role;
  portal: Portal;
}

export interface Profile {
  id: string;
  email: string;
  fullName: string | null;
}

export interface AppContext {
  user: User;
  profile: Profile;
  /** All memberships that currently grant access (active member, active tenant, active brand). */
  memberships: Membership[];
  /** The membership driving this request. Re-validated on every request; the cookie is only a hint. */
  active: Membership;
}

export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  // getUser() asks the Auth server to validate the token, unlike reading the cookie alone.
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
});

export async function requireUser(next?: string): Promise<User> {
  const user = await getUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return user;
}

export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const user = await getUser();
  if (!user) return false;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  return !error && data === true;
});

interface MembershipRow {
  id: string;
  tenant_id: string;
  brand_id: string | null;
  role_key: string;
  tenants: { id: string; name: string; status: string } | null;
  brands: { id: string; name: string; status: string } | null;
}

/** Memberships the user may actually use right now. Suspended tenants/brands/memberships are filtered out. */
export const getMemberships = cache(async (): Promise<Membership[]> => {
  const user = await getUser();
  if (!user) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, tenant_id, brand_id, role_key, tenants(id, name, status), brands!memberships_brand_belongs_to_tenant(id, name, status)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .overrideTypes<MembershipRow[], { merge: false }>();
  if (error || !data) return [];

  const usable: Membership[] = [];
  for (const row of data) {
    if (!isRole(row.role_key) || !row.tenants || row.tenants.status !== "active") continue;
    if (row.brand_id && (!row.brands || row.brands.status !== "active")) continue;
    usable.push({
      id: row.id,
      tenantId: row.tenant_id,
      tenantName: row.tenants.name,
      brandId: row.brand_id,
      brandName: row.brands?.name ?? null,
      role: row.role_key,
      portal: portalForRole(row.role_key),
    });
  }
  // Staff memberships first so a user with both lands in the 3PL portal by default.
  return usable.sort((a, b) => Number(a.portal === "brand") - Number(b.portal === "brand"));
});

/** True when the user holds memberships that are active on paper but currently grant no access (suspended tenant or brand). */
export const hasSuspendedAccess = cache(async (): Promise<boolean> => {
  const user = await getUser();
  if (!user) return false;
  const supabase = await createClient();
  const { count } = await supabase.from("memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "active");
  return (count ?? 0) > 0 && (await getMemberships()).length === 0;
});

export const getContext = cache(async (): Promise<AppContext | null> => {
  const user = await getUser();
  if (!user) return null;
  const memberships = await getMemberships();
  const first = memberships[0];
  if (!first) return null;

  const wanted = (await cookies()).get(CONTEXT_COOKIE)?.value;
  const active = memberships.find((m) => m.id === wanted) ?? first;

  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id, email, full_name").eq("id", user.id).maybeSingle();
  const profile: Profile = { id: user.id, email: data?.email ?? user.email ?? "", fullName: data?.full_name ?? null };
  return { user, profile, memberships, active };
});

function assertPermission(ctx: AppContext, permission?: Permission) {
  if (permission && !can(ctx.active.role, permission)) notFound();
}

/** Page/layout guard for the 3PL portal (/app). */
export async function requireTenantContext(permission?: Permission): Promise<AppContext & { active: Membership & { brandId: null } }> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || ctx.active.portal !== "tenant") redirect("/");
  assertPermission(ctx, permission);
  return ctx as AppContext & { active: Membership & { brandId: null } };
}

/** Page/layout guard for the brand portal (/portal). */
export async function requireBrandContext(permission?: Permission): Promise<AppContext & { active: Membership & { brandId: string; brandName: string } }> {
  await requireUser();
  const ctx = await getContext();
  if (!ctx || ctx.active.portal !== "brand") redirect("/");
  assertPermission(ctx, permission);
  return ctx as AppContext & { active: Membership & { brandId: string; brandName: string } };
}

export async function requirePlatformAdmin(): Promise<User> {
  const user = await requireUser();
  if (!(await isPlatformAdmin())) notFound();
  return user;
}
