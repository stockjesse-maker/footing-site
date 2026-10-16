import { readFileSync } from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import type { PolicyFn, PolicyType, PolicyComponent, Handling } from "@/engine/adjustments";
import type { PricingContext, ServiceTerms, SurchargeOverride, SurchargeRule } from "@/engine/types";
import { fixtureContext } from "../fixtures/pricing/load";

/**
 * Shared helpers for the adjustment engine tests: the hand-derived fixtures (tests/fixtures/adjustments, written by
 * someone who never saw the engine), the context builder of RULES.md part A0, a structural comparison that reports
 * every mismatching path, and a seeded random generator for the property tests (no new dependency).
 */
const dir = path.resolve(__dirname, "../fixtures/adjustments");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
}

export interface ContextProfile {
  description: string;
  ruleKeys: string[];
  withOverrides?: boolean;
  withZipLists?: boolean;
  extraOverrides?: SurchargeOverride[];
  serviceTermsPatch?: Record<string, Partial<Pick<ServiceTerms, "includedSurchargeKeys">>>;
}

export interface RulesFile {
  rules: Partial<SurchargeRule>[];
  contexts: Record<string, ContextProfile>;
}

/** RULES.md A0: the M2 fixture context (untouched) plus the overlay rules a profile names. */
export function buildContext(profile: ContextProfile, overlay: Partial<SurchargeRule>[]): PricingContext {
  const base = fixtureContext({ withOverrides: profile.withOverrides === true, withZipLists: profile.withZipLists !== false });
  const extra = overlay
    .filter((r) => profile.ruleKeys.includes(r.key!))
    .map((r) => ({ brandId: null, billableWeightFloorLb: null, ...r, perUnit: r.perUnit ? { minimumCharge: null, ...(r.perUnit as object) } : null }) as SurchargeRule);
  const services = base.rateCard.services.map((s) => {
    const patch = profile.serviceTermsPatch?.[`${s.carrierCode}/${s.serviceCode}`];
    return patch ? { ...s, ...patch } : s;
  });
  return { ...base, rateCard: { ...base.rateCard, services }, rules: [...base.rules, ...extra], overrides: [...base.overrides, ...(profile.extraOverrides ?? [])] };
}

export type PolicyProfile = Record<string, Record<string, Handling | undefined> | undefined>;

export function policyFnFromProfile(profile: PolicyProfile | undefined): PolicyFn {
  return (type: PolicyType, component: PolicyComponent): Handling => (profile?.[type]?.[component] as Handling | undefined) ?? "unconfigured";
}

/**
 * Structural comparison: every key of `expected` must be present in `actual` with an equal value (extra keys in
 * `actual` are fine). Arrays must have the same length. Returns the mismatching paths with both values.
 * Weights and rounded dimensions (`billableLb`, `roundedDimensionsIn`) compare numerically ("4.0" equals "4"); arrays named `warnings` compare as sets.
 */
export function mismatches(actual: unknown, expected: unknown, at = "$"): string[] {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "string" && /\.(billableLb|roundedDimensionsIn\[\d\])$/.test(at) && typeof actual === "string") return new Decimal(actual).eq(expected) ? [] : [`${at}: ${actual} !== ${expected}`];
    return Object.is(actual, expected) ? [] : [`${at}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected an array, got ${JSON.stringify(actual)}`];
    if (actual.length !== expected.length) return [`${at}: length ${actual.length} !== ${expected.length} (${JSON.stringify(actual)} vs ${JSON.stringify(expected)})`];
    if (at.endsWith(".warnings") || at === "$.warnings") {
      const a = [...actual].sort();
      const e = [...expected].sort();
      return a.every((v, i) => v === e[i]) ? [] : [`${at}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)} (as sets)`];
    }
    return expected.flatMap((e, i) => mismatches(actual[i], e, `${at}[${i}]`));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return [`${at}: expected an object, got ${JSON.stringify(actual)}`];
  return Object.entries(expected as Record<string, unknown>).flatMap(([k, v]) => {
    const a = actual as Record<string, unknown>;
    if (!(k in a)) return [`${at}.${k}: missing (expected ${JSON.stringify(v)})`];
    return mismatches(a[k], v, `${at}.${k}`);
  });
}

/** Mulberry32: a tiny, seedable generator. Property tests loop over fixed seeds, so every failure reproduces. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
export const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
