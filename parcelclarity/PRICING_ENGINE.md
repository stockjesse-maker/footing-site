# Pricing engine

`src/engine` is a pure, deterministic TypeScript library: no I/O, no clock, no randomness, no framework imports (enforced by an ESLint rule). It prices one shipment against a **customer-facing** rate card and the surcharge rules in force on the ship date, and returns an itemized result that always adds up and always says what it does not know.

> **Status:** implemented and tested against an independently derived golden dataset of 32 fictional scenarios plus per-area unit tests. **Not validated against real carrier/customer examples yet**: no real rate card or carrier surcharge document has been run through it. It must not be called production-ready until that happens (see IMPLEMENTATION_STATUS.md).

## Hard rules (and where they are enforced)

| Rule | Enforcement |
|---|---|
| Base shipping price comes only from the 3PL's customer-facing rate card | The engine has no other price input; the schema has no column for a buy rate |
| No fabricated surcharge amounts or customer prices | No amounts in code or seeds; every rule version records `source_reference`, dates and `verification_status`; fixtures are labelled fictional |
| Missing rate → explicit *unavailable*, never extrapolated | `lookupRate` returns `no_rate_for_weight` / `no_rate_for_zone` / `no_rate_for_origin` |
| Definite / estimated / conditional charges are never mixed silently | Every line carries `chargeClass` and `counted`; totals are split |
| No double counting of bundled or mutually exclusive surcharges | Exclusivity groups, `excludesRuleKeys`, included/excluded keys on service terms |
| Reproducible history | Results reference rate-card version, terms version and every rule key@version |

## API

```ts
import { calculateShipment } from "@/engine";
const result = calculateShipment(input, { rateCard, rules, zipLists, overrides });
```

Types are in `src/engine/types.ts`. All money and weights are decimal strings; arithmetic uses decimal.js (precision 28, HALF_UP where rounding is explicit). Line amounts are rounded to cents **once, when the line is created**; totals are sums of rounded lines.

## Calculation pipeline

1. **Validate** (`validate.ts`, Zod): positive weights, all-or-none dimensions, 5-digit ZIPs (ZIP+4 accepted and trimmed), a real calendar date, 1–200 packages, ZIP or zone. Invalid → `status: "unavailable"`, reason `invalid_input`, with messages. The engine never throws for data problems.
2. **Rate-card effectivity**: `effectiveDate ≤ shipDate ≤ expirationDate` (inclusive) or `rate_card_not_effective`.
3. **Service**: `(carrierCode, serviceCode)` must be on the card → else `service_not_on_rate_card`.
4. **Billable weight per package** (`dim.ts`): actual weight → lb; round each dimension per `dimensionRounding`; cubic inches; if a `thresholdCubicIn` is set, DIM applies only above it; DIM lb = cubic ÷ divisor (exact decimal); compare **unrounded** actual vs DIM; apply `minBillableLb`; round the winner per `weightRounding` (`up_whole_lb`, `up_whole_oz` = next 1/16 lb, `none`). Exempt services use actual weight. If dimensions are missing or the card states no divisor, the engine prices on actual weight, classes the base line **estimated**, and warns (`dimensions_missing` / `dim_divisor_missing`).
5. **Zone** (`zones.ts`): the zone entered directly (normalized: trimmed, upper-cased, "Zone 5" → "5"), or from the card's zone chart: rows whose origin prefix equals the 5-digit origin are tried first, then 3-digit; a destination matches when its first N digits fall within `[destPrefixFrom, destPrefixTo]` (same length); 5-digit ranges beat 3-digit. None → `zone_unresolved` (+ `zone_chart_missing` warning if the card has no chart for the carrier).
6. **Base rate per package** (`rates.ts`): rows for the service scoped by origin (5-digit > 3-digit > any-origin; origin-priced cards with no match → `no_rate_for_origin`), then zone (`no_rate_for_zone` names the zones covered), then bracket with `weightMin < w ≤ weightMax` compared in the row's unit (`no_rate_for_weight` states the heaviest bracket and that rates are not extrapolated). Minimum charge = max(row, service) → a separate `minimum_charge` line for the difference.
7. **Surcharges** (`surcharges.ts`, `calculate.ts`): candidate rules = carrier matches, service listed or null, effective on the ship date, highest version per key, not in the service's `excludedSurchargeKeys`. Customer overrides by key (effective on the date): `exclude` lists the line uncounted with warning `rule_overridden`; `override_amount`/`override_percent` replace the figure. Conditions are ANDed; each evaluates to *applies*, *not*, or *unknown* (needed input missing: dimensions, destination ZIP, zone, or a ZIP list not loaded). Per-package rules evaluate per package; per-shipment rules evaluate once (greater-than tests hold if any package satisfies them, less-than-or-equal only if all do). **Exclusivity**: within a group (per package), the applying rule with the highest priority wins (ties → higher amount → key order); losers are omitted. **Bundling**: an applying rule suppresses the keys in `excludesRuleKeys`. Rules in `includedSurchargeKeys` are listed uncounted ("included in base rate"). *Unknown* outcomes are listed uncounted and classed **estimated**. `conditional` rules are listed uncounted and summed into `conditionalExposure`.
8. **Amounts**: `flat`; `per_unit` = amount × ceil((declared value − free allowance) ÷ unit size) per package, summed; `percent` = percent × base, computed **after** all other lines. Base kinds: `base_rate` (base + minimum lines), `base_plus_all_surcharges`, `base_plus_categories`. Percent rules are computed per package (one line each) plus one shipment-level line when shipment-level lines are in the base, so rounding matches carrier billing. A percentage of an estimated base is itself **estimated**. Fuel is a `fuel`-category percent rule and is always last.
9. **Totals**: definite = Σ counted definite lines; estimated = Σ counted estimated lines; expected = definite + estimated; conditionalExposure = Σ conditional lines (never counted).
10. **References and warnings**: every line with a rule carries key, version, scope, source reference and verification status; `references.rules` lists every rule that produced a line; `unverified_rule_applied` warns when a counted line comes from an unverified rule.

Line order in results: per package (base, minimum, surcharges in the carrier's category order), then shipment-level lines, fuel last. Consumers must not depend on order.

## Carrier adapters

`src/engine/carriers/index.ts` holds **structure only**: how a carrier rounds and measures (offered as *structural defaults* when a 3PL sets up service terms, labelled "verify against the carrier's current service guide"), the evaluation order of surcharge categories, and the known mutually exclusive groups for the rule editor's guidance. No amounts, divisors or ZIP lists live there. The engine reads only `ServiceTerms`, so a 3PL can override every structural default per service.

## Data the engine receives

* `RateCardSnapshot`: one active version (services with DIM rules, minimum charge, included/excluded surcharge keys; rate rows; zone chart). Built by `src/lib/pricing/snapshot.ts` under the caller's Row Level Security, so a brand user can only ever load cards assigned to their brand.
* `SurchargeRule[]`: published rule versions in force (platform scope or the tenant's own), each with `verification_status`.
* `ZipList[]`: lists referenced by `destination_zip_in_list` conditions (platform or tenant).
* `SurchargeOverride[]`: the brand's active exceptions.

## Rate-card import (`src/lib/import`)

CSV/XLSX → tables (`parse-table.ts`, 5 MB, 50,000 rows and 600,000 cells per sheet caps; type sniffing) → detection (`rate-card-mapping.ts`: header synonyms for the long layout, grid layout detection, service-name suggestions with confidence; **heuristics only, no AI; the administrator approves**) → validation (`rate-card-validate.ts`: strict numeric parsing, bracket derivation and overlap/duplicate/gap checks, zone and origin formats, unmapped services, decreasing-price warnings, per-service coverage summary) → draft version with rows and service terms → activation with effective dates (two active versions can never overlap; enforced by a database exclusion constraint).

## Testing

* `tests/unit/engine-golden.test.ts`: 32 scenarios against `tests/fixtures/pricing/expected.json`, whose values were derived **independently of the engine** by two separate computations (one scripted, one by hand) from the design document and the fixture files, then reconciled. One deliberate post-reconciliation decision is recorded in the file (fuel on an estimated base is estimated).
* `tests/unit/engine-*.test.ts`: per-area tests (dimensional weight and rounding, zones and brackets and unavailable paths, surcharge semantics, money and validation) with hand-derived expectations.
* `tests/unit/import-pipeline.test.ts`: parsers, mapping heuristics, validation.
* `tests/db/pricing.test.ts`: who can see and change pricing data (RLS), activation/publication state machines, audit.

All fixture data is fictional and must never be shown as real pricing.

## Not implemented yet

Order-level aggregation and average cost per order (Milestone 3), processing/fulfillment fees (4), reweight/remeasure adjustment risk (5), metric units, non-US destinations, carrier-published rule monitoring (8). Platform-scope (carrier-verified) rules can only be inserted by the service role today; the review/approval workflow arrives in Milestone 8.
