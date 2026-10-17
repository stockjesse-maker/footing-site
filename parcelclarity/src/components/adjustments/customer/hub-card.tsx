import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBrandExamples } from "@/lib/adjustments/queries";
import { ADJUSTMENTS_PATH, HUB_CARD_CTA, PAGE_TITLE, hubCardDescription } from "@/lib/adjustments/customer-copy";
import { HubCard } from "@/components/modeling/lists";

/**
 * The "Possible adjustments" card on the customer's Model Costs hub. It exists only for a customer (never on the 3PL's on-behalf hub)
 * and only while at least one example is current: a customer with nothing to read is not invited to an empty page, and a page full of
 * hidden examples is not advertised. It carries no figure, no count and no state of any example.
 */

/**
 * True when the signed-in customer has at least one current example. Reads the one database function a customer may call
 * (`brand_adjustment_examples`) through the shared projection, which fails closed; a failure or a thrown error is "no", never a broken hub.
 * Call it for a customer only; the 3PL's on-behalf hub must not call it.
 */
export async function hasCurrentAdjustmentExample(supabase: SupabaseClient, brandId: string): Promise<boolean> {
  try {
    const result = await loadBrandExamples(supabase, brandId);
    return result.status === "ok" && result.examples.some((e) => e.state === "current");
  } catch {
    return false;
  }
}

export function PossibleAdjustmentsHubCard({ tenantName }: { tenantName: string | null | undefined }) {
  return <HubCard title={PAGE_TITLE} description={hubCardDescription(tenantName)} href={ADJUSTMENTS_PATH} cta={HUB_CARD_CTA} />;
}
