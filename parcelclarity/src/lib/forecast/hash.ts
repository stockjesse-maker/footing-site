import { createHash } from "node:crypto";
import { canonicalAssumptions, type ForecastAssumptions } from "@/engine/forecast";

/**
 * Hashing for forecast assumptions. The engine stays free of Node imports, so it receives this
 * function through `ForecastDeps.hash`; the server action and the tests use the same one, so the
 * hash stored in a summary is the hash of exactly the canonical JSON the engine evaluated.
 */

/** sha-256 of a UTF-8 string, lower-case hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The identity of a set of assumptions: sha-256 of their canonical JSON (row order and number formatting do not matter). */
export function hashAssumptions(assumptions: ForecastAssumptions): string {
  return sha256Hex(canonicalAssumptions(assumptions));
}
