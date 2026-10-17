import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { BrandExample, BrandExamplePayload } from "@/lib/adjustments/queries";
import { ALLOWED_NEGATIVE_SENTENCES } from "@/lib/adjustments/customer-copy";

/**
 * Fixtures and small helpers shared by the customer-side tests (adjustments-customer-*.test.ts). Fictional data: the amounts are the
 * hand-derived fuel v1 example of the customer review (UPS Ground, zone 2, residential, 5 lb corrected to 20 lb: 17.83 declared, 23.13
 * corrected, difference 5.30; separate fee 2.00). Nothing here is read from a database.
 */
export const TENANT = "Acme 3PL";
export const EXAMPLE_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const EXAMPLE_ID_2 = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
export const EXAMPLE_ID_3 = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3";

export type Payload = BrandExamplePayload;

const service = { carrier: "UPS", service: "UPS Ground" };

/** Postage difference passed on and a separate fee passed on: the first review example, 5 lb corrected to 20 lb. */
export function chargedPayload(over: Partial<Payload> = {}): Payload {
  return {
    v: 1,
    adjustmentType: "reweight",
    pricedOn: "2026-10-16",
    input: {
      service,
      direction: "increase",
      residential: true,
      zone: 2,
      declared: { packages: [{ weightLb: "5.000000" }] },
      corrected: { packages: [{ weightLb: "20.0" }] },
    },
    components: [
      { kind: "postage_difference", handling: "pass_through", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13" },
      { kind: "separate_fee", handling: "pass_through", amount: "2.00" },
    ],
    ...over,
  };
}

/** The fee is decided case by case; the shipping charge difference is passed on. */
export function mixedPayload(): Payload {
  return chargedPayload({
    components: [
      { kind: "postage_difference", handling: "pass_through", amount: "5.30", declaredTotal: "17.83", correctedTotal: "23.13" },
      { kind: "separate_fee", handling: "manual_approval", amount: "2.00" },
    ],
  });
}

/** Only a fee decided case by case. */
export function caseOnlyPayload(): Payload {
  return chargedPayload({ components: [{ kind: "separate_fee", handling: "manual_approval", amount: "2.00" }] });
}

export function example(over: Partial<BrandExample> = {}): BrandExample {
  return {
    id: EXAMPLE_ID,
    title: "If a 5 lb package is corrected to 20 lb",
    note: null,
    payload: chargedPayload(),
    pricedOn: "2026-10-16",
    ratesEffectiveFrom: "2026-01-01",
    validThrough: "2026-12-31",
    publishedAt: "2026-10-16T09:00:00.123456+00:00",
    state: "current",
    ...over,
  };
}

/** What the database sends while amounts are hidden: the neutral title, no note, no payload. */
export function hidden(state: "under_review" | "expired", over: Partial<BrandExample> = {}): BrandExample {
  return example({ id: state === "expired" ? EXAMPLE_ID_3 : EXAMPLE_ID_2, title: "Example", note: null, payload: null, state, ...over });
}

// ---------------------------------------------------------------------------
// Reading markup without a DOM
// ---------------------------------------------------------------------------
export const html = (node: ReactNode): string => renderToStaticMarkup(node as never);

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** The visible text of markup: tags removed, entities decoded, whitespace collapsed. */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

export const text = (node: ReactNode): string => textOf(html(node));

/** Every heading in order: its level and text. */
export function headings(markup: string): { level: number; text: string }[] {
  return [...markup.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: Number(m[1]), text: textOf(m[2]!) }));
}

/** The values of the attributes a screen reader or a tooltip can read (aria-label, alt, title, placeholder, value). */
export function readableAttributes(markup: string): string[] {
  return [...markup.matchAll(/\s(?:aria-label|aria-description|alt|title|placeholder|value)="([^"]*)"/g)].map((m) => textOf(m[1]!));
}

/** The markup with every approved negative sentence taken out, for scans that must find none of a word. */
export function withoutAllowedSentences(s: string): string {
  let out = s;
  for (const sentence of ALLOWED_NEGATIVE_SENTENCES) out = out.split(sentence).join(" ");
  return out;
}

/** The markup with the heading tags rewritten to one level, so two renders that differ only in heading level compare equal. */
export function flattenHeadings(markup: string): string {
  return markup.replace(/<(\/?)h[1-6]\b/g, "<$1h");
}
