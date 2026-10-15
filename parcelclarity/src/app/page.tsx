import { redirect } from "next/navigation";
import { getContext, hasSuspendedAccess, isPlatformAdmin, requireUser } from "@/lib/auth/session";

/** Routes a signed-in user to the right place; signed-out visitors are sent to sign in. */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  await requireUser();
  const ctx = await getContext();
  const flash = (await searchParams).password === "updated" ? "?password=updated" : "";
  if (ctx) redirect(`${ctx.active.portal === "tenant" ? "/app" : "/portal"}${flash}`);
  if (await isPlatformAdmin()) redirect("/platform");
  if (await hasSuspendedAccess()) redirect("/access-suspended");
  redirect("/onboarding");
}
