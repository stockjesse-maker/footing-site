import type { Metadata } from "next";
import { ReportsView } from "@/components/modeling/views";
import { brandModelingView } from "@/lib/modeling/page-context";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  return ReportsView(await brandModelingView(), await searchParams);
}
