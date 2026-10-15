import type { Metadata } from "next";
import { ReportsView } from "@/components/modeling/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Compare models" };

export default async function CustomerReportsPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<{ a?: string; b?: string }> }) {
  const { brandId } = await params;
  return ReportsView(await staffModelingView(brandId), await searchParams);
}
