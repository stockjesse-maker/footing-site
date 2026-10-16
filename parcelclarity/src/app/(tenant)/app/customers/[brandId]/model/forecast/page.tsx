import type { Metadata } from "next";
import { ForecastNewView } from "@/components/forecast/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Forecast from assumptions" };

export default async function CustomerForecastPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<{ from?: string; date?: string }> }) {
  const { brandId } = await params;
  return ForecastNewView(await staffModelingView(brandId), await searchParams);
}
