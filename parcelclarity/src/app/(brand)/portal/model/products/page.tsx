import type { Metadata } from "next";
import { ProductsView } from "@/components/modeling/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Product weights" };

export default async function ProductsPage() {
  return ProductsView(await brandModelingView());
}
