import type { Metadata } from "next";
import { PossibleAdjustmentsView } from "@/components/adjustments/customer";
import { PAGE_TITLE } from "@/lib/adjustments/customer-copy";
import { loadSessionBrandExamples } from "@/lib/adjustments/queries";

export const metadata: Metadata = { title: PAGE_TITLE };

/**
 * "Possible adjustments": the examples the signed-in customer's 3PL has shared. The route needs `brand.view` and the brand comes from the
 * session (`loadSessionBrandExamples` checks the permission and never takes a brand from the request). The page's ONLY data source is
 * `brand_adjustment_examples`, which authorizes the caller on the brand and returns the explicit projection; no adjustment table is
 * selected here, so a customer can read nothing the 3PL has not chosen to share.
 */
export default async function PossibleAdjustmentsPage() {
  const loaded = await loadSessionBrandExamples();
  return <PossibleAdjustmentsView result={loaded} tenantName={loaded.tenantName} />;
}
