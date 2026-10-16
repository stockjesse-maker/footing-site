import { SUMMARY_PARTS } from "@/lib/modeling/queries";

/**
 * What the lists' lean select returns for a run: one column per entry of `SUMMARY_PARTS`, holding that part of the
 * stored summary (null when the summary lacks it), exactly as PostgREST answers `alias:summary->path`. A fake
 * database ignores the select it is given, so tests that stand in for the lists hand it rows built here.
 */
export function leanColumns(summary: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [alias, path] of SUMMARY_PARTS) {
    let value: unknown = summary;
    for (const key of path.split("->")) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    out[alias] = value === undefined ? null : value;
  }
  return out;
}

/** The one column the lists read of a run's assumptions. */
export const leanAssumptions = (assumptions: unknown): { a_overrideAllServices: boolean | null } => ({
  a_overrideAllServices: (assumptions as { overrideAllServices?: boolean } | null)?.overrideAllServices ?? null,
});
