import Link from "next/link";
import type { BrandExample, BrandExamplesResult } from "@/lib/adjustments/queries";
import { BACK_LINK_LABEL, EMPTY_TITLE, PAGE_TITLE, emptyText, loadFailedText, pageIntro } from "@/lib/adjustments/customer-copy";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { ExampleView } from "./example-view";

/**
 * The customer's "Possible adjustments" page body: the title and what the examples are, then every example the 3PL has shared, or one
 * plain sentence when there is none or the list could not be read. It renders only what `loadSessionBrandExamples` returned.
 *
 * Headings: one h1 (the title); each example is an h2 and its groups are h3. The empty state is an h2 so the outline has no gap.
 * Examples whose amounts are shown come first; those under review or expired follow, in the order the database returned them. React keys
 * are positions, never ids.
 */

const STATE_ORDER: Record<BrandExample["state"], number> = { current: 0, under_review: 1, expired: 2 };

/** Current examples first, then under review, then expired; stable within each (the database sorts newest first). */
export function orderExamples(examples: readonly BrandExample[]): BrandExample[] {
  return examples.map((e, i) => ({ e, i })).sort((a, b) => STATE_ORDER[a.e.state] - STATE_ORDER[b.e.state] || a.i - b.i).map((x) => x.e);
}

export function PossibleAdjustmentsView({ result, tenantName }: { result: BrandExamplesResult; tenantName: string | null | undefined }) {
  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/portal/model" className="inline-flex min-h-11 items-center font-medium text-accent-text hover:underline">
          ← {BACK_LINK_LABEL}
        </Link>
      </p>
      <PageHeader title={PAGE_TITLE} description={pageIntro(tenantName)} />
      {result.status === "load_failed" ? (
        <Alert tone="danger">{loadFailedText(tenantName)}</Alert>
      ) : result.examples.length === 0 ? (
        <section className="rounded-card border border-dashed border-line-strong bg-raised px-6 py-12 text-center">
          <h2 className="text-base font-semibold">{EMPTY_TITLE}</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">{emptyText(tenantName)}</p>
        </section>
      ) : (
        <div className="space-y-6">
          {orderExamples(result.examples).map((example, i) => (
            <ExampleView key={`example-${i}`} example={example} tenantName={tenantName} idPrefix={`example-${i}`} />
          ))}
        </div>
      )}
    </>
  );
}
