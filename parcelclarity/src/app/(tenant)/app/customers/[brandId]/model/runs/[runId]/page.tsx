import type { Metadata } from "next";
import { RunView } from "@/components/modeling/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Model results" };

export default async function CustomerRunPage({ params, searchParams }: { params: Promise<{ brandId: string; runId: string }>; searchParams: Promise<{ page?: string; status?: string }> }) {
  const { brandId, runId } = await params;
  return RunView(await staffModelingView(brandId), runId, await searchParams);
}
