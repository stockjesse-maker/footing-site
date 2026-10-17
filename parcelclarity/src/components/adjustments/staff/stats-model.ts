import type { HistoryFiltersInput } from "@/lib/adjustments/action-schemas";
import type { DirectionGroup, E4, HistoryRefused, HistoryStatistics, SeverityStat } from "@/engine/adjustments/types";
import { formatCount, formatE4, pluralize } from "@/lib/adjustments/staff-copy";

/**
 * The model behind the statistics screen: the filter form's text, how it becomes the action's input, and how a statistic reads as words.
 * Pure (no React, no I/O). Nothing here computes a statistic: the engine did, on the server; this only chooses words and refuses to show
 * an unknown number as zero.
 */
export interface StatsForm {
  /** "" = all customers together. */
  brandId: string;
  carrierCode: string;
  serviceId: string;
  adjustmentType: string;
  cause: string;
  from: string;
  to: string;
  /** Days after a period ends in which adjustments can still post; blank = no maturity warning. */
  maturityDays: string;
}

/** 30 days is a starting point the person can change or clear; it only decides when the immaturity warning shows. */
export const DEFAULT_MATURITY_DAYS = "30";

export const EMPTY_STATS_FORM: StatsForm = { brandId: "", carrierCode: "", serviceId: "", adjustmentType: "", cause: "", from: "", to: "", maturityDays: DEFAULT_MATURITY_DAYS };

export type StatsFormErrors = Partial<Record<"window" | "maturityDays", string>>;

/** The action's input from the form, or the sentences that say what to fix (nothing is sent until they are fixed). */
export function statsInput(f: StatsForm): { ok: true; input: HistoryFiltersInput } | { ok: false; errors: StatsFormErrors } {
  const errors: StatsFormErrors = {};
  const hasFrom = f.from.trim() !== "";
  const hasTo = f.to.trim() !== "";
  if (hasFrom !== hasTo) errors.window = "Enter both dates of the window, or neither.";
  else if (hasFrom && f.to < f.from) errors.window = "The window ends before it starts.";
  let maturityDays: number | null = null;
  if (f.maturityDays.trim() !== "") {
    const n = Number(f.maturityDays);
    if (!/^\d{1,4}$/.test(f.maturityDays.trim()) || !Number.isInteger(n) || n > 3650) errors.maturityDays = "Enter a whole number of days from 0 to 3,650, or leave it empty.";
    else maturityDays = n;
  }
  if (errors.window || errors.maturityDays) return { ok: false, errors };
  const input: HistoryFiltersInput = {
    brandId: f.brandId === "" ? null : f.brandId,
    carrierCode: f.carrierCode === "" ? null : f.carrierCode,
    serviceId: f.serviceId === "" ? null : f.serviceId,
    adjustmentType: f.adjustmentType === "" ? null : (f.adjustmentType as HistoryFiltersInput["adjustmentType"]),
    cause: f.cause === "" ? null : (f.cause as HistoryFiltersInput["cause"]),
    window: hasFrom ? { from: f.from, to: f.to } : null,
    maturityDays,
  };
  return { ok: true, input };
}

/** An amount that may be unknown: an unknown amount is "Not computed", never $0.00. */
export const amountText = (e4: E4 | null | undefined): string => (e4 === null || e4 === undefined ? "Not computed" : formatE4(e4));

export interface SeverityRow {
  /** How many records carry this amount. */
  n: number;
  mean: string;
  median: string;
  p90: string | null;
  largest: string | null;
}

/** What one severity block reads as. With no amounts at all every figure is "Not computed". */
export function severityRow(s: SeverityStat): SeverityRow {
  if (s.n === 0) return { n: 0, mean: "Not computed", median: "Not computed", p90: s.p90E4 === undefined ? null : "Not computed", largest: s.maxE4 === undefined ? null : "Not computed" };
  return { n: s.n, mean: amountText(s.meanE4), median: amountText(s.medianE4), p90: s.p90E4 === undefined ? null : amountText(s.p90E4), largest: s.maxE4 === undefined ? null : amountText(s.maxE4) };
}

export const DIRECTION_ORDER: readonly DirectionGroup[] = ["increase", "decrease", "zero", "unknown"];

/** "18 adjustments, 1.8000% of 1,000 packages shipped", or just the count when no baseline covers the window. */
export function directionLine(stats: HistoryStatistics, group: DirectionGroup): string {
  const d = stats.incidenceByDirection?.[group];
  const unit = stats.perRecordCounting ? "adjustment records" : "packages";
  if (!d) return "";
  const wordsK = d.k === 1 ? (stats.perRecordCounting ? "adjustment record" : "package") : unit;
  return `${formatCount(d.k)} ${wordsK}, ${d.pct4dp}%`;
}

/** The maturity warning, or null when the window has matured (or no maturity was asked for). */
export function maturityWarning(stats: HistoryStatistics): string | null {
  const m = stats.maturity;
  if (!m || !m.immature) return null;
  const ago = m.daysSinceWindowEnd <= 0 ? "ends today or later" : `ended ${pluralize(m.daysSinceWindowEnd, "day")} ago`;
  return `This period ${ago}. Adjustments can still be added for ${pluralize(m.maturityDays, "day")} after a period ends, so the counts for it may rise.`;
}

/** What to say about a refused statistic: the engine's own sentence, plus what to do where there is something to do. */
export function refusalAdvice(r: HistoryRefused): { message: string; link: { href: string; label: string } | null } {
  switch (r.code) {
    case "k_exceeds_n":
      return { message: `${r.message}${r.k !== undefined && r.N !== undefined ? ` (${formatCount(r.k)} adjusted packages, ${formatCount(r.N)} packages shipped.)` : ""}`, link: { href: "/app/adjustments/history/baselines", label: "Check packages shipped" } };
    case "baselines_overlap":
    case "scope_mismatch":
    case "baseline_not_found":
    case "invalid_baselines":
      return { message: r.message, link: { href: "/app/adjustments/history/baselines", label: "Check packages shipped" } };
    case "service_unresolved":
      return { message: r.unresolvedCount !== undefined ? `${r.message} (${pluralize(r.unresolvedCount, "record")} without a matched service.)` : r.message, link: null };
    default:
      return { message: r.message, link: null };
  }
}
