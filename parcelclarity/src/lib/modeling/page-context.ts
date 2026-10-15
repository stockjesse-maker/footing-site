import "server-only";
import { notFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireBrandContext, requireTenantContext } from "@/lib/auth/session";
import { uuidSchema } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

/** What every modeling view needs to know about who is looking and for which customer. */
export interface ModelingView {
  supabase: SupabaseClient;
  tenantId: string;
  tenantName: string;
  brandId: string;
  brandName: string;
  /** 3PL staff modeling on behalf of the customer (private by default, staff vocabulary allowed). */
  staff: boolean;
  basePath: string;
  reportsPath: string;
  tenantDefaultOriginZip: string | null;
}

async function tenantDefaultOrigin(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await supabase.from("tenants").select("default_origin_zip").eq("id", tenantId).maybeSingle();
  return (data?.default_origin_zip as string | null | undefined) ?? null;
}

/** Brand portal pages: the signed-in customer models for its own brand. */
export async function brandModelingView(): Promise<ModelingView> {
  const ctx = await requireBrandContext("simulation.run");
  const supabase = await createClient();
  return {
    supabase,
    tenantId: ctx.active.tenantId,
    tenantName: ctx.active.tenantName,
    brandId: ctx.active.brandId,
    brandName: ctx.active.brandName,
    staff: false,
    basePath: "/portal/model",
    reportsPath: "/portal/reports",
    tenantDefaultOriginZip: await tenantDefaultOrigin(supabase, ctx.active.tenantId),
  };
}

/** 3PL pages under /app/customers/[brandId]/model: staff model on behalf of one of their customers. */
export async function staffModelingView(brandId: string): Promise<ModelingView> {
  const ctx = await requireTenantContext("simulation.run");
  if (!uuidSchema.safeParse(brandId).success) notFound();
  const supabase = await createClient();
  const { data: brand } = await supabase.from("brands").select("id, name, tenant_id, status").eq("id", brandId).maybeSingle();
  if (!brand || brand.tenant_id !== ctx.active.tenantId) notFound();
  return {
    supabase,
    tenantId: ctx.active.tenantId,
    tenantName: ctx.active.tenantName,
    brandId: brand.id,
    brandName: brand.name,
    staff: true,
    basePath: `/app/customers/${brand.id}/model`,
    reportsPath: `/app/customers/${brand.id}/model/reports`,
    tenantDefaultOriginZip: await tenantDefaultOrigin(supabase, ctx.active.tenantId),
  };
}
