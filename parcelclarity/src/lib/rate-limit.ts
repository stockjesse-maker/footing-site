import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user, per-action rate limit backed by PostgreSQL (public.check_rate_limit), so it is
 * shared across all serverless instances. Fails closed: if the check itself errors the
 * action is refused.
 */
export async function withinRateLimit(supabase: SupabaseClient, action: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("check_rate_limit", { p_action: action, p_limit: limit, p_window_seconds: windowSeconds });
  return !error && data === true;
}

export const RATE_LIMITED_MESSAGE = "You're doing that too often. Please wait a few minutes and try again.";
