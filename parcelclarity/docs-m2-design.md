# Milestone 2 design: rate cards and pricing engine (review draft)

This is the implementation contract for the pricing engine (`src/engine`), the pricing schema
(`supabase/migrations/20261015000003_pricing.sql`) and the rate-card import pipeline. Types are
in `src/engine/types.ts`. Nothing below is implemented yet except the types and the migration draft.

## 1. Engine: `calculateShipment(input, context) → ShipmentCalculation`

Pure function. Inputs: `ShipmentInput` and `PricingContext` (rate-card snapshot, surcharge rules,
zip lists, customer overrides). No clock, no I/O, no randomness. Decimal arithmetic via decimal.js
(precision 28). All money lines rounded HALF_UP to 2 dp **once, when the line is created**; totals
are sums of rounded lines (so the itemization always adds up to the total).

### 1.1 Validation
Zod-validate the input (positive weights, 3 dims all-or-none, 5-digit ZIPs after stripping ZIP+4,
`shipDate` is a calendar date, ≥1 package, ≤ 200 packages). Invalid → `status: unavailable`,
reason `invalid_input`, with a message listing the first problems. Never throws for data problems;
throws only for programmer errors (e.g. snapshot missing).

### 1.2 Rate-card effectivity
If `shipDate` is outside `[effectiveDate, expirationDate]` → `unavailable: rate_card_not_effective`.
(The data layer picks the version by date before calling the engine; the engine re-checks.)

### 1.3 Service
`services.find(carrierCode, serviceCode)`; missing → `unavailable: service_not_on_rate_card`.

### 1.4 Per-package billable weight
1. actualLb = weight converted to lb (oz ÷ 16), exact decimal.
2. If dims present and not `dim.exempt` and `dim.divisor` not null:
   - round each dimension per `dimensionRounding` (`nearest_whole`: HALF_UP to integer; `up_whole`: ceil; `none`).
   - cubic = L×W×H (rounded dims).
   - if `thresholdCubicIn` is null or cubic > threshold: dimLb = cubic ÷ divisor (exact decimal), else dimLb = null (`basis: actual`).
3. If dims present but divisor null → dimLb null, basis `no_divisor`, warning `dim_divisor_missing`, and **the base line's class becomes `estimated`** (we cannot know whether DIM would apply).
4. If dims absent → basis `no_dimensions`, warning `dimensions_missing`, base line class `estimated` (same reason) unless `dim.exempt`.
5. raw = max(actualLb, dimLb ?? 0); if `minBillableLb` and raw < min → raw = min, basis `minimum`.
6. billableLb = round(raw) per `weightRounding`: `up_whole_lb` → ceil to integer lb; `up_whole_oz` → ceil to 1/16 lb; `none` → raw.
   Comparison for "which is larger" uses unrounded values; rounding is applied to the winner. (Carriers round the billable weight, not each candidate.)

### 1.5 Zone
If `destinationZone` provided → use it (`source: input`). Else need `destinationZip` and the card's zone chart:
- normalize ZIPs to 5 digits; try origin prefixes longest-first (5 then 3) for `carrierCode`;
- within those rows, a destination matches when the first `len(destPrefixFrom)` digits of the destination
  ZIP are lexicographically within `[destPrefixFrom, destPrefixTo]` (same length guaranteed by the schema);
- prefer the most specific row (5-digit ranges over 3-digit);
- none → `unavailable: zone_unresolved` with explanation "no zone chart row for origin/destination". If the card has no zone rows at all → same reason plus warning `zone_chart_missing`.

### 1.6 Base rate per package
Rows for the service, filtered by origin: rows with `originPrefix` equal to the origin's 5-digit or 3-digit prefix are preferred (5 over 3); if no origin-specific rows exist use rows with `originPrefix = null`; if origin-specific rows exist but none match the origin and no null rows exist → `unavailable: no_rate_for_origin`.
Then filter by `zone` (exact string match after trimming/upper-casing both sides). None → `no_rate_for_zone`.
Then convert billableLb to the row unit for comparison and pick the row with `weightMin < w ≤ weightMax` (comparison in the row's unit, exact decimals). None → `no_rate_for_weight` (message states the max weight the card covers for that zone).
Base amount = `price`. Then minimum: `max(row.minCharge, service.minCharge)` applied as a separate `minimum_charge` line = (min − price) when min > price, so the itemization shows it.

Multi-package shipments: each package priced independently (1.4–1.6); shipment-level lines (fuel, signature, per-shipment rules) computed once over the sum.

### 1.7 Surcharge evaluation
Candidate rules = `context.rules` where:
- `carrierCode` matches; `serviceCodes` null or includes service;
- `effectiveDate ≤ shipDate ≤ expirationDate`;
- rule key not in `service.excludedSurchargeKeys`;
- if multiple versions of a key are effective (should not happen; DB forbids overlap), take the highest version.

Apply customer overrides (by `ruleKey`, effective on shipDate): `exclude` removes the rule (recorded as warning `rule_overridden`), `override_amount`/`override_percent` replace the amount/percent and the line's rule reference notes the override.

Evaluate conditions per rule. Each condition is evaluated against the package (if `perPackage`) or the shipment (for per-shipment rules, dimension/weight conditions use the largest/heaviest package). Semantics:
- `residential` → `input.residential === value`.
- `weight_gt`/`weight_lte` → compare actual or billable lb of the package.
- `longest_side_gt`, `second_longest_side_gt` → sorted rounded dims; `length_plus_girth_gt` → L + 2(W+H) with L the longest; `cubic_in_gt`.
- `zone_in`, `destination_zip_prefix_in` (prefix match), `destination_zip_in_list` → zip list lookup (exact 5-digit or prefix entry).
- `declared_value_gt`, `signature_in`, `saturday_delivery`, `package_type_in`, `flag_present`, `ship_date_between`, `package_count_gt`.
Conditions needing dims when dims are missing → condition result "unknown".

Outcome per rule: `applies` / `not` / `unknown` (an input needed was missing, or a zip list referenced by `destination_zip_in_list` is not in `context.zipLists` → warning `zip_list_missing`).

**Exclusivity:** among applying rules sharing an `exclusivityGroup` (per package for per-package rules), keep the one with highest `exclusivityPriority`, ties → highest computed amount, ties → key order. Then for each kept rule, suppress rules listed in its `excludesRuleKeys`. Rules in `service.includedSurchargeKeys` are *listed* with `counted: false` and explanation "included in base price per your agreement".

Line class: rule's `chargeClass`, except `unknown` outcome → line emitted with `chargeClass: estimated`, `counted: false`, amount computed as if it applied, explanation says why it is uncertain. `conditional` rules are emitted `counted: false` and summed into `conditionalExposure`.

Amounts: `flat` → amount; `percent` → percent × base (see 1.8); `per_unit` (declared value) → amount × ceil((declaredValue − freeAllowance) / unitSize) when declaredValue > freeAllowance, else not applied.

### 1.8 Fuel and calculation bases
Fuel is a rule with `category: fuel`, `method: percent`, evaluated **after** all other surcharges. Its base is computed from counted lines: `base_rate` → base + minimum_charge lines; `base_plus_all_surcharges` → plus every counted non-fuel surcharge line; `base_plus_categories` → plus counted lines of the listed categories. Percent rules of other categories use the same base rules (rare). The basis string records "X% of Y".

### 1.9 Totals and charge classes
- definite = Σ counted lines with class definite; estimated = Σ counted lines with class estimated; expected = definite + estimated; conditionalExposure = Σ lines with class conditional (never counted).
- The base line (and any minimum-charge line) is `estimated` when DIM could not be evaluated (1.4 step 3–4); flat/per-unit surcharge lines carry their rule's class; a percentage line (fuel) is `estimated` when any counted line in its base is estimated, otherwise its rule's class.

### 1.11 Decisions on points the first draft left open (settled during the independent golden derivation)
- Exclusivity losers and bundled (excluded-by-another-rule) surcharges are **absent** from the itemization, not listed.
- A customer `exclude` override lists the line with `counted: false` and the rule's own class, and adds warning `rule_overridden`; amount/percent overrides add no warning (the line explanation names the agreement).
- Conditions whose input is simply absent (`declared_value_gt` with no declared value, `signature_in` with no signature option, `flag_present` with no flags) evaluate to **not applicable**, not unknown. Only missing dimensions, missing destination ZIP, unresolved zone, or a missing ZIP list yield **unknown**.
- `zip_list_missing` is warned only when a referenced list is absent from the context; an unknown outcome due to no destination ZIP produces no warning (the zone was entered directly).
- Zone chart: rows whose origin prefix equals the 5-digit origin are tried first; 3-digit origin rows are used only when none of the 5-digit rows match the destination.
- Unavailable results still carry the per-package weight results and service when those were computed before the failure.
- `rate_card_not_effective` is an unavailable reason, not a warning.
- Line order in results: per package (base, minimum adjustment, surcharges in carrier category order), then shipment-level lines, fuel last; consumers must not depend on order.
- Per-shipment rules in multi-package shipments: a greater-than condition holds if any package satisfies it, a less-than-or-equal condition only if all do; per-unit (declared value) charges are computed per package and summed.
- A billable weight can never match two brackets of a well-formed card (min exclusive, max inclusive); if a malformed card had overlapping rows the lightest matching bracket wins. Import validation rejects overlaps.

### 1.10 References and warnings
Every line carries its rule key/version/source/verification status; `references.rules` lists every rule that was evaluated as applying or unknown. `unverified_rule_applied` warning when any counted line's rule is `unverified`.

## 2. Carrier adapters (`src/engine/carriers`)
One module per carrier exporting `CarrierProfile { code, name, structuralDefaults: DimRules-without-divisor, categoryOrder }`. They hold **no amounts**. `structuralDefaults` are starting points for a rate card's service terms and are labeled in the UI as "default — verify against the carrier's current service guide"; the engine itself takes only what is in `ServiceTerms`. Unknown carrier code → generic profile.

## 3. Schema (see migration)
- `rate_cards` → `rate_card_versions` (draft/active/archived/discarded; exclusion constraint forbids two active versions on the same day) → `rate_card_rows`, `rate_card_zones`, `rate_card_service_terms` (immutable once not draft, enforced by trigger).
- `brand_rate_card_assignments` with optional `allowed_service_ids`.
- `surcharge_rules` (platform or tenant scope, stable key) → `surcharge_rule_versions` (draft/published/retired; published immutable; exclusion constraint forbids overlapping published versions).
- `customer_surcharge_overrides` (brand-level exceptions).
- `zip_lists`/`zip_list_entries` (platform or tenant).
- `uploaded_files` (bytea, ≤ 5 MB; staff only), `rate_card_imports` (state machine uploaded → mapped → validated → imported).
- RLS: staff with `ratecard.view` see everything in their tenant; brand members see only assigned cards' **active** versions, published rules, and their own overrides; never files or imports. Writes need `ratecard.manage`. Status transitions are RPCs.

## 4. Snapshot resolution (data layer, `src/lib/pricing`)
For a (tenant, brand?, rateCardId, shipDate): choose the active version with `effective ≤ shipDate ≤ expiration`; load terms, rows, zones; load published rule versions effective on shipDate for the card's carriers (platform + tenant scope); load zip lists referenced by those rules; load the brand's active overrides. Services offered to a brand = services in the version ∩ `allowed_service_ids` (if set).

## 5. Import pipeline
Formats: **long** (one row per service/zone/bracket) and **grid** (weights down, zones across, one service per sheet or per block). Steps: upload (size ≤ 5 MB; .csv/.xlsx by extension + content sniff; stored in `uploaded_files`) → detect sheets/headers/sample rows, suggest mapping (header synonyms, service name fuzzy match to `shipping_services`) → administrator edits/approves mapping → validate full parse (errors block, warnings don't): numeric parsing, negative/zero prices (error), overlapping brackets (error), gaps (warning), duplicate cells (error), unmapped service (error), zone format, price not monotonic with weight (warning), row count limits (≤ 50,000) → create draft version + rows + terms (divisor from file or mapping default) → activation with effective dates. AI is **not** used for mapping in this milestone; heuristics only, and the admin approves.
