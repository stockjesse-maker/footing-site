import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireBrandContext } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Model Costs" };

export default async function ModelPage() {
  await requireBrandContext("simulation.run");
  return (
    <>
      <PageHeader title="Model Costs" description="Single shipments, order files and forecasts." />
      <EmptyState title="Not available yet">
        The shipping calculator, bulk order modeling and forecasting arrive in upcoming releases. They need your 3PL&apos;s approved rate card, which hasn&apos;t been published to your account.
      </EmptyState>
    </>
  );
}
