import type { Metadata } from "next";
import { DatasetView } from "@/components/modeling/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Orders file" };

export default async function CustomerDatasetPage({ params }: { params: Promise<{ brandId: string; datasetId: string }> }) {
  const { brandId, datasetId } = await params;
  return DatasetView(await staffModelingView(brandId), datasetId);
}
