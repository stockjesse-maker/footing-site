import type { Metadata } from "next";
import { CalculatorView } from "@/components/modeling/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Price one shipment" };

export default async function BrandCalculatorPage() {
  return CalculatorView(await brandModelingView());
}
