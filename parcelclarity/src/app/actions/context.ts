"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CONTEXT_COOKIE, getMemberships, requireUser } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";

export async function setActiveContext(membershipId: string): Promise<boolean> {
  const parsed = uuidSchema.safeParse(membershipId);
  if (!parsed.success) return false;
  // Only memberships the signed-in user genuinely holds are accepted; the cookie is just a hint.
  const owned = (await getMemberships()).some((m) => m.id === parsed.data);
  if (!owned) return false;
  (await cookies()).set(CONTEXT_COOKIE, parsed.data, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return true;
}

export async function switchContext(formData: FormData) {
  await requireUser();
  await setActiveContext(String(formData.get("membershipId") ?? ""));
  redirect("/");
}
