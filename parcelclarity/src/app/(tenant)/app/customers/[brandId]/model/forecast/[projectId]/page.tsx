import type { Metadata } from "next";
import { ForecastSavedView } from "@/components/forecast/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Saved forecast" };

export default async function CustomerSavedForecastPage({ params }: { params: Promise<{ brandId: string; projectId: string }> }) {
  const { brandId, projectId } = await params;
  return ForecastSavedView(await staffModelingView(brandId), projectId);
}
