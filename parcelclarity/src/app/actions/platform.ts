"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export async function setTenantStatus(tenantId: string, status: "active" | "suspended"): Promise<{ ok: boolean; message?: string }> {
  await requirePlatformAdmin();
  const parsed = z.object({ tenantId: uuidSchema, status: z.enum(["active", "suspended"]) }).safeParse({ tenantId, status });
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_set_tenant_status", { p_tenant: parsed.data.tenantId, p_status: parsed.data.status });
  if (error) return { ok: false, message: "Could not update the tenant." };
  revalidatePath("/platform");
  return { ok: true };
}
