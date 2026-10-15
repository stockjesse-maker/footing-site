import { readFileSync } from "node:fs";
import path from "node:path";
import type { PricingContext, RateCardSnapshot, RateRow, ServiceTerms, SurchargeOverride, SurchargeRule, ZipList, ZoneRow } from "@/engine/types";

/** Loads the FICTIONAL fixture rate card from this folder into an engine PricingContext. */
const dir = __dirname;

const CARRIERS: Record<string, string> = { UPS: "ups", USPS: "usps", FedEx: "fedex" };
const SERVICES: Record<string, { code: string; id: string }> = {
  "UPS Ground": { code: "ground", id: "svc-ups-ground" },
  "UPS 2nd Day Air": { code: "second_day_air", id: "svc-ups-2da" },
  "USPS Ground Advantage": { code: "ground_advantage", id: "svc-usps-ga" },
};

function csv(file: string): Record<string, string>[] {
  const lines = readFileSync(path.join(dir, file), "utf8").trim().split("\n");
  const headers = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

export function loadFixtureRateCard(opts: { effectiveDate?: string; expirationDate?: string | null } = {}): RateCardSnapshot {
  const rows: RateRow[] = csv("fixture-rate-card.csv").map((r) => ({
    serviceId: SERVICES[r.service!]!.id,
    originPrefix: r.origin_zip ? r.origin_zip : null,
    zone: r.zone!,
    weightMin: r.weight_min!,
    weightMax: r.weight_max!,
    weightUnit: r.weight_unit as "lb" | "oz",
    price: r.price!,
    minCharge: r.min_charge ? r.min_charge : null,
  }));
  const zones: ZoneRow[] = csv("fixture-zone-chart.csv").map((z) => ({
    carrierCode: CARRIERS[z.carrier!]!,
    originPrefix: z.origin_prefix!,
    destPrefixFrom: z.dest_prefix_from!,
    destPrefixTo: z.dest_prefix_to!,
    zone: z.zone!,
  }));
  const terms = JSON.parse(readFileSync(path.join(dir, "fixture-service-terms.json"), "utf8")) as Record<string, Omit<ServiceTerms, "serviceId" | "carrierCode" | "serviceCode" | "serviceName" | "termsVersion">>;
  const services: ServiceTerms[] = Object.entries(terms).map(([key, t]) => {
    const [carrierCode, serviceCode] = key.split("/") as [string, string];
    const name = Object.entries(SERVICES).find(([, s]) => s.code === serviceCode)!;
    return { serviceId: name[1].id, carrierCode, serviceCode, serviceName: name[0], termsVersion: "fixture-terms-v1", ...t };
  });
  return {
    rateCardId: "fixture-card",
    rateCardName: "Fixture Freight customer rate card (fictional)",
    versionId: "fixture-card-v1",
    versionNumber: 1,
    currency: "USD",
    effectiveDate: opts.effectiveDate ?? "2026-01-01",
    expirationDate: opts.expirationDate === undefined ? null : opts.expirationDate,
    services,
    rows,
    zones,
  };
}

export function loadFixtureRules(): SurchargeRule[] {
  return JSON.parse(readFileSync(path.join(dir, "fixture-rules.json"), "utf8")) as SurchargeRule[];
}

export function loadFixtureZipLists(): ZipList[] {
  return JSON.parse(readFileSync(path.join(dir, "fixture-zip-lists.json"), "utf8")) as ZipList[];
}

export function loadFixtureOverrides(): SurchargeOverride[] {
  return JSON.parse(readFileSync(path.join(dir, "fixture-overrides.json"), "utf8")) as SurchargeOverride[];
}

export function fixtureContext(opts: { withOverrides?: boolean; withZipLists?: boolean; rateCard?: RateCardSnapshot } = {}): PricingContext {
  return {
    rateCard: opts.rateCard ?? loadFixtureRateCard(),
    rules: loadFixtureRules(),
    zipLists: opts.withZipLists === false ? [] : loadFixtureZipLists(),
    overrides: opts.withOverrides ? loadFixtureOverrides() : [],
  };
}
