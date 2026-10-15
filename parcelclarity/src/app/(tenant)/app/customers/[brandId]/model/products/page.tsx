import type { Metadata } from "next";
import { ProductsView } from "@/components/modeling/views";
import { staffModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Product weights" };

export default async function CustomerProductsPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return ProductsView(await staffModelingView(brandId));
}
