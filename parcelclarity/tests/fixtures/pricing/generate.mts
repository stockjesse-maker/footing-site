/**
 * Generates the FICTIONAL golden-test rate card for the pricing engine.
 *
 * Nothing here is a real carrier rate, surcharge amount or 3PL price. The numbers are made up so
 * that every expected result can be recomputed by hand from the CSV/JSON files in this folder.
 * They must never be shown to a user as example pricing.
 *
 * Run: npx tsx tests/fixtures/pricing/generate.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
mkdirSync(dir, { recursive: true });

const cents = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

// --- UPS Ground: zones 2-8, 1..150 lb, price = base[zone] + perLb[zone] * (lb - 1) --------------
const groundBase: Record<string, number> = { "2": 7.9, "3": 8.35, "4": 8.9, "5": 9.6, "6": 10.4, "7": 11.3, "8": 12.5 };
const groundPerLb: Record<string, number> = { "2": 0.31, "3": 0.36, "4": 0.42, "5": 0.49, "6": 0.57, "7": 0.66, "8": 0.78 };
const long: string[] = ["carrier,service,origin_zip,zone,weight_min,weight_max,weight_unit,price,min_charge"];
for (const zone of Object.keys(groundBase)) {
  for (let lb = 1; lb <= 150; lb++) {
    long.push(`UPS,UPS Ground,,${zone},${lb - 1},${lb},lb,${cents(groundBase[zone]! + groundPerLb[zone]! * (lb - 1))},`);
  }
}
// --- UPS 2nd Day Air: zones 2-8, 1..30 lb ---------------------------------------------------------
const airBase: Record<string, number> = { "2": 18.2, "3": 21.4, "4": 25.1, "5": 29.3, "6": 33.9, "7": 38.8, "8": 44.6 };
const airPerLb: Record<string, number> = { "2": 1.1, "3": 1.3, "4": 1.55, "5": 1.85, "6": 2.2, "7": 2.6, "8": 3.05 };
for (const zone of Object.keys(airBase)) {
  for (let lb = 1; lb <= 30; lb++) {
    long.push(`UPS,UPS 2nd Day Air,,${zone},${lb - 1},${lb},lb,${cents(airBase[zone]! + airPerLb[zone]! * (lb - 1))},`);
  }
}
// --- USPS Ground Advantage: ounce brackets then pounds, priced per origin 900 only --------------
const ozBrackets: [number, number][] = [[0, 4], [4, 8], [8, 12], [12, 15.999]];
const gaOzBase: Record<string, number> = { "1": 4.1, "2": 4.1, "3": 4.3, "4": 4.6, "5": 4.95, "6": 5.35, "7": 5.8, "8": 6.3 };
for (const zone of Object.keys(gaOzBase)) {
  ozBrackets.forEach(([min, max], i) => long.push(`USPS,USPS Ground Advantage,900,${zone},${min},${max},oz,${cents(gaOzBase[zone]! + 0.45 * i)},`));
  for (let lb = 1; lb <= 70; lb++) {
    long.push(`USPS,USPS Ground Advantage,900,${zone},${lb === 1 ? 0.99994 : lb - 1},${lb},lb,${cents(gaOzBase[zone]! + 2.1 + 0.52 * (lb - 1) * (1 + Number(zone) / 10))},`);
  }
}
writeFileSync(path.join(dir, "fixture-rate-card.csv"), long.join("\n") + "\n");

// --- Zone chart (UPS and USPS share it in this fixture) from origin 900xx ---------------------
const zones = ["carrier,origin_prefix,dest_prefix_from,dest_prefix_to,zone"];
const ranges: [string, string, string][] = [
  ["900", "935", "2"], ["936", "961", "3"], ["962", "994", "4"], ["995", "999", "8"],
  ["800", "899", "5"], ["600", "799", "6"], ["300", "599", "7"], ["005", "299", "8"],
];
for (const carrier of ["UPS", "USPS"]) {
  for (const [from, to, zone] of ranges) zones.push(`${carrier},900,${from},${to},${zone}`);
  // A more specific origin row: shipments from exactly 90210 to 902xx are zone 2 either way, but 903xx are zone 3 from 90210.
  zones.push(`${carrier},90210,903,903,3`);
}
writeFileSync(path.join(dir, "fixture-zone-chart.csv"), zones.join("\n") + "\n");

// --- Service terms ----------------------------------------------------------------------------
const terms = {
  "ups/ground": { dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: false }, minCharge: "8.50", includedSurchargeKeys: [], excludedSurchargeKeys: [] },
  "ups/second_day_air": { dim: { divisor: "139", thresholdCubicIn: null, dimensionRounding: "nearest_whole", weightRounding: "up_whole_lb", minBillableLb: null, exempt: false }, minCharge: null, includedSurchargeKeys: ["fixture.ups.residential"], excludedSurchargeKeys: ["fixture.ups.das_extended"] },
  "usps/ground_advantage": { dim: { divisor: "166", thresholdCubicIn: "1728", dimensionRounding: "nearest_whole", weightRounding: "up_whole_oz", minBillableLb: null, exempt: false }, minCharge: null, includedSurchargeKeys: [], excludedSurchargeKeys: [] },
};
writeFileSync(path.join(dir, "fixture-service-terms.json"), JSON.stringify(terms, null, 2));

// --- Surcharge rules (fictional, tenant-approved) ---------------------------------------------
const rule = (o: Record<string, unknown>) => ({
  scope: "tenant", serviceCodes: null, chargeClass: "definite", method: "flat", amount: null, percent: null, perUnit: null,
  base: { kind: "base_rate" }, conditions: [], exclusivityGroup: null, exclusivityPriority: 0, excludesRuleKeys: [], perPackage: true,
  effectiveDate: "2026-01-01", expirationDate: null, sourceReference: "FIXTURE: fictional amount for engine tests", sourceUrl: null,
  verificationStatus: "approved_3pl_config", ...o,
});
const rules = [
  rule({ key: "fixture.ups.residential", ruleId: "r-res", versionId: "r-res-1", version: 1, carrierCode: "ups", category: "residential", name: "Residential surcharge", amount: "5.00", conditions: [{ type: "residential", value: true }] }),
  rule({ key: "fixture.ups.das", ruleId: "r-das", versionId: "r-das-1", version: 1, carrierCode: "ups", category: "das", name: "Delivery area surcharge", amount: "4.00", conditions: [{ type: "destination_zip_in_list", listKey: "fixture.ups.das_zips" }], exclusivityGroup: "ups.das", exclusivityPriority: 1 }),
  rule({ key: "fixture.ups.das_extended", ruleId: "r-dasx", versionId: "r-dasx-1", version: 1, carrierCode: "ups", category: "das_extended", name: "Extended delivery area surcharge", amount: "6.00", conditions: [{ type: "destination_zip_in_list", listKey: "fixture.ups.das_extended_zips" }], exclusivityGroup: "ups.das", exclusivityPriority: 2 }),
  rule({ key: "fixture.ups.additional_handling_length", ruleId: "r-ahl", versionId: "r-ahl-1", version: 1, carrierCode: "ups", category: "additional_handling", name: "Additional handling (length)", amount: "20.00", conditions: [{ type: "longest_side_gt", inches: "48" }], exclusivityGroup: "ups.handling_vs_large_package", exclusivityPriority: 1 }),
  rule({ key: "fixture.ups.additional_handling_weight", ruleId: "r-ahw", versionId: "r-ahw-1", version: 1, carrierCode: "ups", category: "additional_handling", name: "Additional handling (weight)", amount: "28.00", conditions: [{ type: "weight_gt", valueLb: "50", basis: "actual" }], exclusivityGroup: "ups.handling_vs_large_package", exclusivityPriority: 1 }),
  rule({ key: "fixture.ups.large_package", ruleId: "r-lp", versionId: "r-lp-1", version: 1, carrierCode: "ups", category: "oversize", name: "Large package surcharge", amount: "100.00", conditions: [{ type: "length_plus_girth_gt", inches: "130" }], exclusivityGroup: "ups.handling_vs_large_package", exclusivityPriority: 2 }),
  rule({ key: "fixture.ups.peak_residential", ruleId: "r-peak", versionId: "r-peak-1", version: 1, carrierCode: "ups", category: "peak", name: "Peak residential surcharge", amount: "1.50", conditions: [{ type: "residential", value: true }], effectiveDate: "2026-10-27", expirationDate: "2027-01-17" }),
  rule({ key: "fixture.ups.signature", ruleId: "r-sig", versionId: "r-sig-1", version: 1, carrierCode: "ups", category: "signature", name: "Delivery signature", amount: "6.50", conditions: [{ type: "signature_in", values: ["direct", "adult"] }], perPackage: false }),
  rule({ key: "fixture.ups.declared_value", ruleId: "r-dv", versionId: "r-dv-1", version: 1, carrierCode: "ups", category: "declared_value", name: "Declared value", method: "per_unit", amount: "1.05", perUnit: { basis: "declared_value", unitSize: "100", freeAllowance: "100" }, conditions: [{ type: "declared_value_gt", amount: "100" }] }),
  rule({ key: "fixture.ups.address_correction", ruleId: "r-ac", versionId: "r-ac-1", version: 1, carrierCode: "ups", category: "address_correction", name: "Address correction (if needed)", amount: "21.00", chargeClass: "conditional", perPackage: false }),
  rule({ key: "fixture.ups.fuel", ruleId: "r-fuel", versionId: "r-fuel-1", version: 1, carrierCode: "ups", category: "fuel", name: "Fuel surcharge", method: "percent", percent: "14.00", base: { kind: "base_plus_categories", categories: ["residential", "das", "das_extended", "additional_handling", "oversize", "peak"] }, effectiveDate: "2026-01-01", expirationDate: "2026-09-30" }),
  rule({ key: "fixture.ups.fuel", ruleId: "r-fuel", versionId: "r-fuel-2", version: 2, carrierCode: "ups", category: "fuel", name: "Fuel surcharge", method: "percent", percent: "15.50", base: { kind: "base_plus_categories", categories: ["residential", "das", "das_extended", "additional_handling", "oversize", "peak"] }, effectiveDate: "2026-10-01", expirationDate: null }),
  rule({ key: "fixture.usps.nonstandard_length", ruleId: "r-nsl", versionId: "r-nsl-1", version: 1, carrierCode: "usps", category: "oversize", name: "Nonstandard length fee", amount: "4.00", conditions: [{ type: "longest_side_gt", inches: "22" }] }),
  rule({ key: "fixture.usps.unverified_handling", ruleId: "r-unv", versionId: "r-unv-1", version: 1, carrierCode: "usps", category: "other", name: "Unverified handling fee (test)", amount: "0.75", conditions: [{ type: "flag_present", flag: "fragile" }], verificationStatus: "unverified", sourceReference: "FIXTURE: deliberately unverified" }),
];
writeFileSync(path.join(dir, "fixture-rules.json"), JSON.stringify(rules, null, 2));

const zipLists = [
  { key: "fixture.ups.das_zips", version: 1, sourceReference: "FIXTURE", entries: ["93920", "9362", "958", "95995"] },
  { key: "fixture.ups.das_extended_zips", version: 1, sourceReference: "FIXTURE", entries: ["93921", "9599"] },
];
writeFileSync(path.join(dir, "fixture-zip-lists.json"), JSON.stringify(zipLists, null, 2));

const overrides = [
  { ruleKey: "fixture.ups.residential", mode: "exclude", amount: null, percent: null, effectiveDate: "2026-01-01", expirationDate: null, reference: "FIXTURE agreement: residential waived for Beta Beverages" },
  { ruleKey: "fixture.ups.fuel", mode: "override_percent", amount: null, percent: "10.00", effectiveDate: "2026-01-01", expirationDate: null, reference: "FIXTURE agreement: fuel capped at 10% for Beta Beverages" },
];
writeFileSync(path.join(dir, "fixture-overrides.json"), JSON.stringify(overrides, null, 2));

console.log(`wrote fixtures to ${dir}: ${long.length - 1} rate rows, ${zones.length - 1} zone rows, ${rules.length} rule versions`);
