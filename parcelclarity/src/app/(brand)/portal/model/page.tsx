import type { Metadata } from "next";
import { ModelHubView } from "@/components/modeling/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Model Costs" };

export default async function ModelPage() {
  return ModelHubView(await brandModelingView());
}
