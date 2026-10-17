import type { BaselineInput } from "@/lib/adjustments/action-schemas";
import { BASELINE_ALL_CARRIERS, BASELINE_ALL_CUSTOMERS, BASELINE_ALL_SERVICES, formatCount, formatIsoDate } from "@/lib/adjustments/staff-copy";
import type { CatalogService } from "./import-model";

/**
 * Packages shipped ("baselines"): how many carrier packages were shipped in a period, for one customer or all together, one carrier or all,
 * one service or all. They are the denominator of how often adjustments happen. The unit is always the carrier package (one label is one
 * package). Pure: the form's text, how it becomes the action's input, and how a saved figure reads. Never summed across scopes.
 */
export interface BaselineForm {
  /** "" = all customers together. */
  brandId: string;
  carrierCode: string;
  serviceId: string;
  periodStart: string;
  periodEnd: string;
  packages: string;
  labelsMissing: string;
  note: string;
}

export const EMPTY_BASELINE_FORM: BaselineForm = { brandId: "", carrierCode: "", serviceId: "", periodStart: "", periodEnd: "", packages: "", labelsMissing: "", note: "" };

export type BaselineFormErrors = Partial<Record<"periodStart" | "periodEnd" | "packages" | "labelsMissing" | "note" | "brandId" | "carrierCode" | "serviceId", string>>;

const wholeNumber = (text: string): number | null => {
  const t = text.trim().replace(/,/g, "");
  return /^\d{1,10}$/.test(t) ? Number(t) : null;
};

/** The action's input, or what to fix first. Server-side rules (overlaps, the customer exists) are the action's. */
export function baselineInput(f: BaselineForm): { ok: true; input: BaselineInput } | { ok: false; errors: BaselineFormErrors } {
  const errors: BaselineFormErrors = {};
  if (f.periodStart.trim() === "") errors.periodStart = "Enter the first day of the period.";
  if (f.periodEnd.trim() === "") errors.periodEnd = "Enter the last day of the period.";
  if (!errors.periodStart && !errors.periodEnd && f.periodEnd < f.periodStart) errors.periodEnd = "The period ends before it starts.";
  const packages = wholeNumber(f.packages);
  if (packages === null || packages < 1) errors.packages = "Enter a whole number of packages, at least 1.";
  let labelsMissing: number | null = null;
  if (f.labelsMissing.trim() !== "") {
    labelsMissing = wholeNumber(f.labelsMissing);
    if (labelsMissing === null) errors.labelsMissing = "Enter a whole number, or leave it empty.";
    else if (packages !== null && labelsMissing > packages) errors.labelsMissing = "Labels without a weight cannot be more than the packages shipped.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      brandId: f.brandId === "" ? null : f.brandId,
      carrierCode: f.carrierCode === "" ? null : f.carrierCode,
      serviceId: f.serviceId === "" ? null : f.serviceId,
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      packagesTotal: packages!,
      labelsMissingWeight: labelsMissing,
      note: f.note.trim() === "" ? undefined : f.note.trim(),
    },
  };
}

export interface BaselineView {
  id: string;
  brandId: string | null;
  carrierCode: string | null;
  serviceId: string | null;
  periodStart: string;
  periodEnd: string;
  packagesTotal: number;
  labelsMissingWeight: number | null;
  note: string | null;
}

/** "Alpha Apparel, UPS, UPS Ground": the scope of a figure in words ("All customers together, All carriers, All services" when it covers everything). */
export function baselineScope(b: Pick<BaselineView, "brandId" | "carrierCode" | "serviceId">, brands: readonly { id: string; name: string }[], catalog: readonly CatalogService[]): string {
  const brand = b.brandId === null ? BASELINE_ALL_CUSTOMERS : (brands.find((x) => x.id === b.brandId)?.name ?? "A customer that is no longer listed");
  const carrier = b.carrierCode === null ? BASELINE_ALL_CARRIERS : (catalog.find((s) => s.carrierCode === b.carrierCode)?.carrierName ?? b.carrierCode);
  const service = b.serviceId === null ? BASELINE_ALL_SERVICES : (catalog.find((s) => s.id === b.serviceId)?.name ?? "A service that is no longer listed");
  return `${brand}, ${carrier}, ${service}`;
}

export const baselinePeriod = (b: Pick<BaselineView, "periodStart" | "periodEnd">): string => (b.periodStart === b.periodEnd ? formatIsoDate(b.periodStart) : `${formatIsoDate(b.periodStart)} to ${formatIsoDate(b.periodEnd)}`);

export const baselineSize = (b: Pick<BaselineView, "packagesTotal">): string => `${formatCount(b.packagesTotal)} ${b.packagesTotal === 1 ? "package" : "packages"} shipped`;

/** Newest period first, then by scope text, so the list does not move when something is added. */
export function sortBaselines<T extends Pick<BaselineView, "periodStart" | "id">>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : a.id < b.id ? -1 : 1));
}
