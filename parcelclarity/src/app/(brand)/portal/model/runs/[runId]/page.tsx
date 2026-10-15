import type { Metadata } from "next";
import { RunView } from "@/components/modeling/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Model results" };

export default async function RunPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Promise<{ page?: string; status?: string }> }) {
  const { runId } = await params;
  return RunView(await brandModelingView(), runId, await searchParams);
}
