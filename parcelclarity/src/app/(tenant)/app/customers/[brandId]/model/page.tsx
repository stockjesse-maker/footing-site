import type { Metadata } from "next";
import { ModelHubView } from "@/components/modeling/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Model costs" };

export default async function CustomerModelPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return ModelHubView(await staffModelingView(brandId));
}
