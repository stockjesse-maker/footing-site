import type { Metadata } from "next";
import { DatasetView } from "@/components/modeling/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Orders file" };

export default async function DatasetPage({ params }: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await params;
  return DatasetView(await brandModelingView(), datasetId);
}
