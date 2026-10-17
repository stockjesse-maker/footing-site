import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { summariseHistory } from "@/engine/adjustments";
import type { HistoryBaseline, HistoryRecord, HistoryStatistics } from "@/engine/adjustments/types";
import type { PolicyRecord } from "@/lib/adjustments/action-schemas";
import { detectAdjustmentFile } from "@/lib/adjustments/mapping";
import { parseAdjustmentFile } from "@/lib/adjustments/parse";
import { toStoredValidation, applyAdjustmentMapping } from "@/lib/adjustments/validate";
import type { AdjustmentContext, AdjustmentDetection, AdjustmentMapping, AdjustmentValidationReport } from "@/lib/adjustments/types";
import type { ServiceCatalogEntry } from "@/lib/import/rate-card-mapping";

/**
 * Fixtures and helpers shared by the 3PL-side tests (adjustments-staff-*.test.ts). Everything is fictional: names, ids and amounts are
 * invented, and nothing is read from a database. The import library is the real one, run over the hand-written CSV fixtures.
 */
export const TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const BRAND_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const BRAND_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
export const BRAND_C = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
export const SVC_UPS_GROUND = "00000000-0000-4000-8000-0000000000a1";
export const SVC_USPS_GA = "00000000-0000-4000-8000-0000000000a2";
export const IMPORT_ID = "99999999-9999-4999-8999-999999999999";

export const BRANDS = [
  { id: BRAND_A, name: "Alpha Apparel", status: "active" },
  { id: BRAND_B, name: "Beta Beverages", status: "active" },
  { id: BRAND_C, name: "Gamma Goods", status: "suspended" },
];

export const CATALOG: ServiceCatalogEntry[] = [
  { id: SVC_UPS_GROUND, carrierCode: "ups", carrierName: "UPS", code: "ground", name: "UPS Ground" },
  { id: SVC_USPS_GA, carrierCode: "usps", carrierName: "USPS", code: "ground_advantage", name: "USPS Ground Advantage" },
];

export const TODAY = "2026-10-17";

export const html = (el: ReactElement): string => renderToStaticMarkup(el);

/** Visible text of server-rendered markup: tags gone, entities decoded, whitespace collapsed. */
export const textOf = (markup: string): string =>
  markup
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Every aria-label, title, alt and placeholder of the markup: what assistive technology reads that is not visible text. */
export const accessibleNames = (markup: string): string[] => [...markup.matchAll(/\b(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((m) => m[1]!);

export function policy(over: Partial<PolicyRecord> & Pick<PolicyRecord, "adjustmentType" | "component" | "handling">): PolicyRecord {
  return { id: `policy-${over.adjustmentType}-${over.component}-${over.brandId ?? "all"}`, brandId: null, validFrom: "2026-01-01", validTo: null, internalNote: null, createdAt: "2026-01-01T00:00:00Z", ...over };
}

/** Wording the 3PL's own screens must not use for the 3PL's own amounts. "carrier cost data" (the refusal about a file) is about what the product refuses, so it is the one allowed phrase. */
export const BANNED_OWN_AMOUNT = [/\bcosts?\b/i, /\bloss(es)?\b/i, /\bmargins?\b/i, /\bprofits?\b/i, /\bbuy[- ]rates?\b/i];
export const bannedIn = (text: string): string[] => {
  const cleaned = text.replace(/carrier cost data/gi, "");
  return BANNED_OWN_AMOUNT.filter((re) => re.test(cleaned)).map((re) => re.source);
};

// ---------------------------------------------------------------------------
// The import library over the real fixtures
// ---------------------------------------------------------------------------
const fx = (name: string) => path.resolve(__dirname, "../fixtures/adjustments", name);

export const importContext = (over: Partial<AdjustmentContext> = {}): AdjustmentContext => ({
  catalog: CATALOG,
  brands: BRANDS.map((b) => ({ id: b.id, name: b.name })),
  today: TODAY,
  ...over,
});

export interface ImportFixture {
  detection: AdjustmentDetection;
  mapping: AdjustmentMapping;
  report: AdjustmentValidationReport;
  headers: string[];
  sampleRows: Record<string, string>[];
}

/** A fixture file read, detected and validated exactly as the actions do. */
export async function importFixture(name: string, adjust: (m: AdjustmentMapping) => AdjustmentMapping = (m) => m): Promise<ImportFixture> {
  const parsed = await parseAdjustmentFile(readFileSync(fx(name)), "csv");
  if (parsed.status !== "ok") throw new Error(`fixture ${name} was not accepted: ${parsed.status}`);
  const detection = detectAdjustmentFile(parsed.tables, { catalog: CATALOG, brands: BRANDS.map((b) => ({ id: b.id, name: b.name })) });
  const mapping = adjust(detection.suggestion);
  const result = applyAdjustmentMapping(parsed.tables, mapping, importContext());
  const headers = detection.sheets[0]!.headers;
  const sampleRows = parsed.tables[0]!.rows.slice(1, 4).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { detection, mapping, report: toStoredValidation(result.report), headers, sampleRows };
}

// ---------------------------------------------------------------------------
// Statistics from the real engine
// ---------------------------------------------------------------------------
export function histRecord(i: number, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: `rec-${i}`,
    brandId: BRAND_A,
    carrierCode: "ups",
    serviceId: SVC_UPS_GROUND,
    shipDate: "2026-08-10",
    adjustmentType: "reweight",
    cause: "carrier_reweigh",
    packageRef: `1Z${String(i).padStart(6, "0")}`,
    originalCharge: "10.00",
    correctedCharge: "12.00",
    separateFee: "3.00",
    postageDifference: "2.00",
    ...over,
  };
}

export const baseline = (over: Partial<HistoryBaseline> = {}): HistoryBaseline => ({ id: "base-1", brandId: BRAND_A, carrierCode: null, serviceId: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", packagesTotal: 1000, labelsMissingWeight: null, ...over });

export function statistics(records: HistoryRecord[], baselines: HistoryBaseline[], over: { brandId?: string | null; today?: string; maturityDays?: number | null; window?: { from: string; to: string } | null } = {}): HistoryStatistics {
  const result = summariseHistory(records, baselines, { brandId: over.brandId === undefined ? BRAND_A : over.brandId, window: over.window ?? null, maturityDays: over.maturityDays ?? null, today: over.today ?? TODAY });
  if (result.status !== "ok") throw new Error(`statistics refused: ${result.message}`);
  return result;
}

/** Every element of a React tree (before it is rendered) whose type matches: lets a test read the props of a control whose second step is not in the static markup. */
export function findElements(node: ReactNode, match: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const n of node) findElements(n, match, out);
  else if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (match(el)) out.push(el);
    findElements(el.props.children, match, out);
  }
  return out;
}

/** The text of a React node made only of strings and elements (for a ConfirmAction's explanation). */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

/**
 * Wiring that assistive technology depends on: no id appears twice, and every label, description and heading reference points at an id that is
 * in the markup. Returns the problems (empty when the markup is well formed).
 */
export function idProblems(markup: string): string[] {
  const problems: string[] = [];
  const ids = [...markup.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`duplicate id ${id}`);
    seen.add(id);
  }
  for (const m of markup.matchAll(/\s(for|aria-labelledby|aria-describedby|aria-controls)="([^"]*)"/g)) {
    for (const ref of m[2]!.split(/\s+/).filter(Boolean)) if (!seen.has(ref)) problems.push(`${m[1]} points at a missing id ${ref}`);
  }
  return problems;
}

/** Controls that must have an accessible name: a label (for=), an aria-label, or a wrapping label. Returns the ones that have none. */
export function unnamedControls(markup: string): string[] {
  const out: string[] = [];
  const forIds = new Set([...markup.matchAll(/<label[^>]*\sfor="([^"]*)"/g)].map((m) => m[1]!));
  for (const m of markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    if (/type="hidden"/.test(attrs)) continue;
    const id = /\sid="([^"]*)"/.exec(attrs)?.[1];
    // Inside a label element that has text (an implicit label): the last <label before the control is not yet closed.
    const before = markup.slice(0, m.index);
    const insideLabel = before.lastIndexOf("<label") > before.lastIndexOf("</label>");
    const named = /aria-label="[^"]+"/.test(attrs) || /aria-labelledby="[^"]+"/.test(attrs) || (id !== undefined && forIds.has(id)) || insideLabel;
    if (!named) out.push(m[0].slice(0, 100));
  }
  return out;
}
