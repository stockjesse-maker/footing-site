import type { Metadata } from "next";
import { CalculatorView } from "@/components/modeling/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Price one shipment" };

export default async function CustomerCalculatorPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return CalculatorView(await staffModelingView(brandId));
}
