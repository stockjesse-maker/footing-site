import type { Metadata } from "next";
import { ForecastSavedView } from "@/components/forecast/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Saved forecast" };

export default async function BrandSavedForecastPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return ForecastSavedView(await brandModelingView(), projectId);
}
