import { projectBrandExamples } from "@/lib/adjustments/queries";
import { NEUTRAL_TITLE } from "@/lib/adjustments/customer-copy";
import type { ExampleViewExample } from "./example-view";

/**
 * Turns what the database's preview function returned into the props `ExampleView` takes, through the SAME field-by-field projection the
 * customer's page uses (`projectBrandExamples`). A payload that is not what the customer's function would return is refused (null)
 * rather than rendered, so the preview can never show more or other than a customer would see.
 *
 * `title` and `note` are what the 3PL typed in the share form (the preview shows them as the customer would read them); `sharedOn` is
 * the date the example would be shared (today, "YYYY-MM-DD"). Server-side only (it imports the customer read model).
 */
const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

export function exampleFromPreview(args: {
  title: string;
  note: string | null;
  preview: { payload?: unknown; pricedOn?: string; ratesEffectiveFrom?: string; validThrough?: string };
  sharedOn: string;
}): ExampleViewExample | null {
  const { preview } = args;
  const projected = projectBrandExamples([
    {
      id: PREVIEW_ID,
      title: args.title.trim() || NEUTRAL_TITLE,
      note: args.note && args.note.trim() ? args.note.trim() : null,
      payload: preview.payload ?? null,
      pricedOn: preview.pricedOn,
      ratesEffectiveFrom: preview.ratesEffectiveFrom,
      validThrough: preview.validThrough,
      publishedAt: args.sharedOn,
      state: "current",
    },
  ]);
  const one = projected?.[0];
  if (!one) return null;
  const { title, note, payload, pricedOn, ratesEffectiveFrom, validThrough, publishedAt, state } = one;
  return { title, note, payload, pricedOn, ratesEffectiveFrom, validThrough, publishedAt, state };
}
