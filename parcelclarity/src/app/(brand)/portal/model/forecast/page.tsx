import type { Metadata } from "next";
import { ForecastNewView } from "@/components/forecast/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Forecast from assumptions" };

export default async function BrandForecastPage({ searchParams }: { searchParams: Promise<{ from?: string; date?: string }> }) {
  return ForecastNewView(await brandModelingView(), await searchParams);
}
