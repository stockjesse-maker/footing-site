# Adjustment golden rules (Milestone 5)

These rules restate `m5-design-v2.md` sections 3.1 to 3.4, 5 and 9 precisely enough to compute every case in `scenarios.json` by hand. The expectations in `expected.json`, `policy-matrix.json` and `import-expected.json` were derived from THIS document and the M2 fixtures (`tests/fixtures/pricing/**`, untouched), never from engine code: the engine for this milestone did not exist when they were written. All data is fictional.

Each rule is tagged **[v2 §x]** when design v2 states it, and **[G-n]** when v2 is silent or ambiguous and the golden writer had to choose. Every `G-n` is a decision for the lead to confirm; the cases that pin it are named so it can be reversed by editing the case. If a `G-n` and a later design text disagree, the design wins and the named cases change.

Money: amounts in fixtures are decimal strings (cents). `E4` = integer ten-thousandths of a dollar (12500 = $1.25). Rounding is HALF_UP (ties away from zero) on exact decimals, once per reported figure, the M4 convention [v2 §3.3, PRICING_ENGINE.md]. Weights are decimal strings (`"4.0"`), compare numerically.

## Files

| File | Content |
|---|---|
| `rules.json` | overlay surcharge rules (`rules`) and context profiles (`contexts`) |
| `scenarios.json` | `policyProfiles`, `scenarios` (scenario inputs), `historyCases`, `riskCases` |
| `expected.json` | `scenarios`, `history`, `risk`: expected results keyed by case id |
| `history-records.json` | `recordSets`: named arrays of history records |
| `history-baselines.json` | `baselineSets`: named arrays of typed baselines |
| `policy-matrix.json` | policies, queries with expected handling, exclusion-constraint examples |
| `header-guard.json` | forbidden-header table (import guard) |
| `history-sample.csv` | 40 fictional rows for the importer and e2e (template headers) |
| `history-errors.csv` | 12 rows, one defect per defective row, for validation counts |
| `history-carrier-cost.csv` | carrier-cost-looking headers: must be refused before anything is stored |
| `import-expected.json` | hand-counted validation expectations for the three CSV files |

## Part A. Scenario evaluation `evaluateAdjustmentScenario(input, ctx, policyFn)` [v2 §3.1]

### A0 Building the context (the M2 fixture is untouched)

For a scenario with `context = name`, take `rules.json -> contexts[name]`:

```
base = fixtureContext({ withOverrides: ctx.withOverrides === true, withZipLists: ctx.withZipLists !== false })
rules     = [...base.rules, ...overlayRules.filter(r => ctx.ruleKeys.includes(r.key))]
overrides = [...base.overrides, ...(ctx.extraOverrides ?? [])]       // base.overrides already holds the two fixture overrides when withOverrides
serviceTermsPatch: for each "carrier/service" key, replace includedSurchargeKeys of the matching ServiceTerms
```

`policyFn(type, component)` is built from `scenarios.json -> policyProfiles[policy]`: `profile[type]?.[component] ?? "unconfigured"`. Types: `reweight`, `remeasure`, `combined`, `correction` (`correction` has only `separate_fee`) [v2 §0 D9].

### A1 Input shape [G-1]

```
input = { shipment: ShipmentInput (the DECLARED shipment, M2 shape),
          corrections: [ {weight?, weightUnit?, length?, width?, height?} per package ],
          declaredSource: "entered" | "wms_fallback" }
```

`corrections.length` must equal `shipment.packages.length` (the package count may not differ). The corrected package is the declared package overlaid with the fields present in its correction (merge). The goldens always give `weightUnit` with `weight`; behaviour when a unit is omitted is unspecified here. Everything outside weight, unit and dimensions is identical on both sides [v2 §3.1].

### A2 Validation order (first failure wins), status `invalid_input` [v2 §3.1 (1), (7); G-3]

1. `corrections.length != packages.length` -> invalid (message contains "package count").
2. `declaredSource = wms_fallback` and any declared weight <= 0 -> invalid, message contains `a label cannot be created at 0 lb; enter the fallback your system used` [v2 §3.1; spec review F1].
3. No package differs (weights compared in EXACT lb, so 0.5 lb equals 8 oz; dimensions compared as entered) -> invalid, message contains `nothing to correct` [v2 §3.1 (1)].
4. Both sides are then priced. If EITHER side returns the engine reason `invalid_input` (bad ZIP, weight not above zero, partial dimensions), the scenario status is `invalid_input` even when the other side is unavailable [G-3] (an input error is not a pricing unavailability). `declared weight 0` entered with source `entered` takes this path.

For `invalid_input`: `adjustmentType`, `direction`, `basis` are null; `components`, `undecided`, `totalsE4` are null; `messageContains` lists substrings the message must contain (empty when the text is the engine's). When the invalidity came from the engine, `sides` carries the engine reasons.

### A3 Classification from the INPUT diff [v2 §3.1 (1); G-2]

`weightChanged` = any package whose weight in exact lb differs; `dimensionsChanged` = any package whose merged `(length, width, height)` differs from the declared one AS ENTERED (not the rounded dimensions: 15.4 -> 15.3 is a remeasure although both round to 15). Dimensions added where none were known are a change. Result: both -> `combined`, weight only -> `reweight`, dimensions only -> `remeasure`. A package is "corrected" (for A7) when its own weight or dimensions changed.

### A4 Rules priced on each side [v2 §3.1 (2), (3)]

* Adjustment-fee categories are `reweight`, `remeasure`, `shipping_charge_correction`.
* DECLARED pricing: every adjustment-fee rule removed.
* CORRECTED pricing: keep rules of category `reweight` for a reweight, `remeasure` for a remeasure, both for a combined, and `shipping_charge_correction` for every type; drop the other adjustment-fee categories BEFORE pricing so engine exclusivity behaves as configured.
* Every kept adjustment-fee rule is forced to charge class `conditional`. A kept rule whose stored class was not `conditional` adds the scenario warning `adjustment_fee_rule_not_conditional` (once) [v2 §3.1 (2)]. A forced rule never enters a counted total.
* All other rules, the overrides, the rate card, the service, ZIPs, ship date and options are identical on both sides.

### A5 Status [v2 §3.1 (7); G-3]

`ok | no_adjustment | declared_unavailable | corrected_unavailable | both_unavailable | invalid_input`. A side is unavailable when the engine returns `status: unavailable` (reasons as in M2: `no_rate_for_weight`, ...). For the three unavailable statuses: `adjustmentType` is set, `direction` and `basis` are null, `components`, `undecided` and `totalsE4` are null (no partial figures, never extrapolate, never switch service [v2 H6]); `sides.<side>` carries `{status, unavailableReason}` only.

### A6 Postage difference, direction, no_adjustment [v2 §3.1 (4), (6), (8)]

* `countedTotal(side)` = engine `totals.expected` (definite + estimated, counted lines only; conditional, unknown, waived and included lines excluded).
* `postage_difference.amount` = `countedTotal(corrected) - countedTotal(declared)`, the difference of two independently rounded cent totals (E2 = 0.56, not 0.57).
* `direction`: `increase` (> 0), `decrease` (< 0), `none` (= 0).
* `status = no_adjustment` when `countedTotal` is equal AND every package's `billableLb` is equal; otherwise `ok`. When the totals are equal but a billable weight differs (a price plateau, case `plateau_billable_differs_zero_delta`), the status is `ok`, the amount `0.00` and the direction `none` [G-4]; the fee is then not shown because v2 shows it only for `increase`.
* `postage_difference.state` = `computed`, or `credit` when the direction is `decrease` (the amount is negative and `creditAmount` is its absolute value) [G-6].

### A7 Separate fee component [v2 §3.1 (5), (6); G-5]

* Candidates = adjustment-fee rules KEPT by A4 that are carrier-matched, service-matched (`serviceCodes`), effective on the ship date and not in the service's `excludedSurchargeKeys` (whether or not their conditions apply).
* Fee lines = lines of those rules on the corrected pricing, kept only where `packageIndex` is null or the package is corrected (a per-package rule never fires for an untouched package).
* State, first match wins:
  1. no candidate -> `not_configured` (never 0.00);
  2. direction is not `increase` -> `not_triggered`;
  3. no kept line (candidates exist but none applies, or only untouched packages) -> `not_triggered`;
  4. any kept line is `unknown` -> `undecided`, `amount` null, `upTo` = sum of the unknown lines' amounts;
  5. any kept line is `conditional` -> `conditional`, `amount` = sum of the conditional lines, `lines` listed;
  6. any kept line is `waived` -> `waived_for_customer` (no amount);
  7. otherwise (`included`) -> `included_in_rate` (no amount).
* A waived line is a customer exception (`exclude` override) on the rule; an included line is a rule key in the service's `includedSurchargeKeys`. Percent fees use the engine's own basis: `10.00%` of the corrected `base_rate` line (E7: 1.16, not 0.06 and not 1.34), no fuel on it.
* `lines[]` = `{ruleKey, label, category, packageIndex, amount, handling}` sorted by `(ruleKey, packageIndex)`.

### A8 Basis [v2 §3.1 (9)]

`estimate` when either side has a counted line of class `estimated`, any `unknown` line, `totals.unresolved > 0`, or a warning in `{dimensions_missing, dim_divisor_missing, zip_list_missing, assumed_inputs, unverified_rule_applied}`; otherwise `exact`.

### A9 `undecided` and `unresolved` [v2 §3.1 (9); G-7]

* `sides.<side>.unresolved` = the engine's `totals.unresolved` of that side's pricing (sum of its `unknown` lines; on the corrected side this includes an unknown fee line).
* `undecided` = for each side and each `unknown` line on it whose rule key (same `packageIndex`) is a COUNTED line on the OTHER side: `{label, upTo: line amount, side, packageIndex}`; declared side first. It lists the amounts INCLUDED in the difference that rest on a charge that could not be decided ("includes $20.00 that could not be decided on the declared side"). Unknown lines with no counted counterpart (the declared Large package 100.00 in the 41.78 case) are only in `unresolved`. A fee rule's own unknown outcome is reported by the fee state `undecided`, not here.

### A10 Handling and totals [v2 §3.1 (10); G-8, G-9]

* `postage_difference.handling = policyFn(type, "postage_difference")`.
* Per fee line: policy type = the scenario type for `reweight` and `remeasure` lines and `correction` for `shipping_charge_correction` lines; line handling = `policyFn(policyType, "separate_fee")`. The component `handling` is the single handling of its conditional lines, `"mixed"` when they differ, and `policyFn(type, "separate_fee")` when it has no conditional line.
* `totalsE4 = {customerPays (pass_through), decidedCaseByCase (manual_approval), notBilledToCustomer (absorbed), notDecided (unconfigured)}`, integers, summing the E4 amount of the postage difference and of each conditional fee line by its handling, ONLY when `direction = increase`; all four are 0 otherwise (a credit never enters a bucket) [G-6, G-9].
* `policySnapshot` = the policy rows consulted: `(type, postage_difference)`, `(type, separate_fee)`, plus `(correction, separate_fee)` when a conditional fee line has category `shipping_charge_correction` [G-8].

### A11 Scenario warnings [G-10]

`warnings` (scenario level, compare as a set): `adjustment_fee_rule_not_conditional` (A4), and `adjustment_fee_rules_stack` when the conditional fee lines come from two or more distinct rule keys (two in-scope fee rules both fire; v2 asks the builder to warn). Engine warnings are in `sides.<side>.warnings` (informational).

### A12 Echo fields

`sides.<side>.packages[] = {index, billableLb, basis, roundedDimensionsIn}`: `billableLb` is the M2 style decimal string (`"4.0"`, `"0.5625"`), `basis` the engine's weight basis (`dim`, `actual`, `no_dimensions`), `roundedDimensionsIn` the `[length, width, height]` strings after the service's dimension rounding (nearest_whole = HALF_UP, 15.5 -> 16) or null when no dimensions [v2 §3.1 report echo, E8; G-12]. `zone` is the engine's zone.

### Asserted fields for scenarios

Assert (exactly): `status`, `adjustmentType`, `direction`, `basis`, `declaredSource`, `sides.<side>.status`, `unavailableReason`, `countedTotal`, `unresolved`, `packages[].billableLb` (numerically) and `roundedDimensionsIn`, `components.postage_difference.{state, amount, declaredTotal, correctedTotal, handling, creditAmount}`, `components.separate_fee.{state, amount, upTo, handling, lines[].{ruleKey, category, packageIndex, amount, handling}}`, `undecided[].{label, upTo, side}`, `totalsE4`, `policySnapshot`, `warnings` (set). Informational (assert if your result exposes them): `sides.<side>.warnings`, `zone`, `packages[].basis`, `lines[].label`, `undecided[].packageIndex`. `messageContains` is a list of substrings the message must contain.

## Part B. Scenario catalogue (what each group pins)

| Group | Cases |
|---|---|
| E1, bracket crossing, same bracket, DIM-governed zero | `e1_dim_governs_no_adjustment`, `e2_reweight_bracket_crossing`, `same_bracket_zero_4_2_to_4_8`, `dim_governed_zero_14x10x8_2_to_5`, `plateau_billable_differs_zero_delta` |
| remeasure, dimensions added, rounded-dimensions echo | `remeasure_only_14x10x8`, `remeasure_dimensions_added`, `remeasure_rounded_dimensions_echo_15_4_to_15_5`, `remeasure_same_rounded_dimensions_zero_15_4_to_15_3` |
| combined non-additivity 0.56 / 2.83 / 2.83, fee stacking, exclusivity group | `e2_...` (0.56), `remeasure_only_14x10x8` (2.83), `e4_combined_non_additive` (2.83, fee 7.00 + stack warning), `e4_combined_grouped_pair` (4.00), `weight_only_with_grouped_pair`, `dims_only_with_grouped_pair`, `weight_only_both_rules_present`, `dims_only_both_rules_present` |
| surcharge flip | `e3_surcharge_flip_49_to_52` (32.34 with an unchanged billable weight) |
| estimate and undecided | `e5_estimate_with_undecided_41_78`, `e5_estimate_6lb_no_dimensions_to_50x10x10` |
| percent fee, brand contexts | `e7_percent_fee_1_16`, `e7_residential_tenant_default` (0.57), `e7_residential_beta_overrides` (0.54) |
| fee states | `waived_for_customer`, `included_in_rate`, `not_configured_usps_ounces_e8`, `not_configured_no_overlay_rules`, `not_configured_remeasure_rule_only_weight_change`, `fee_not_triggered_das_condition_false`, `fee_conditional_das_condition_true`, `fee_undecided_zip_list_missing` |
| unavailable | `declared_unavailable_151_to_140`, `e5_corrected_unavailable_151lb`, `e5_corrected_unavailable_dim_691`, `e5_corrected_unavailable_2da_31lb`, `both_unavailable_151_to_160` |
| invalid input | `invalid_input_nothing_to_correct`, `..._unit_equivalent_no_change`, `..._declared_weight_zero`, `..._wms_fallback_zero`, `..._bad_origin_zip`, `..._correction_count_mismatch`, `..._partial_dimensions_added` |
| credits | `credit_decrease_8_to_5`, `credit_multi_package_5_5_to_5_3_residential` |
| multi package | `e6_multi_package_one_corrected_flat_fee`, `e6_multi_package_one_corrected_per_package_fee` |
| dates | `fuel_v1_ship_20260915_*`, `fuel_v2_ship_20261015_*`, `fuel_v2_peak_ship_20261201_*` |
| WMS fallback | `wms_fallback_dims_known_1lb_to_5lb`, `wms_fallback_no_dimensions_combined` |
| rule misconfiguration, correction category | `definite_class_rule_forced_conditional_warning`, `correction_rule_kept_for_every_type`, `mixed_handling_reweight_and_correction_rules` |
| policy resolution inside a scenario | `policy_*` (absorbed, manual approval, unconfigured, none, combined_explicit rows, remeasure and reweight rows) |

The shared fixtures: UPS Ground, ship 2026-10-15, origin 90001, destination 85001 (zone 5), declared 3 lb 10x8x6, fuel v2 15.50 percent, except where a case says otherwise. Hand arithmetic for each case is in `README.md` of the derivation folder (scratchpad `m5-golden-derivation`).

## Part C. History statistics `summariseHistory(records, baselines, filters)` [v2 §3.2]

Inputs: `records` (a `recordSets` entry), `baselines` (a `baselineSets` entry), `filters = {brandId, carrierCode?, serviceId?, adjustmentType?, cause?, window?: {from, to}, baselineIds?: [], maturityDays?, today?}` (`brandId` null = tenant-wide; dates inclusive; `today` is passed in, the engine has no clock).

Record: `{id, brandId, carrierCode, serviceId, shipDate, adjustmentType, cause, packageRef, originalCharge, correctedCharge, separateFee, postageDifference}`. A money value null means UNKNOWN, never 0; an explicit `"0.00"` fee is a fee of zero; `postageDifference` = corrected - original when both are present, else null (the generated column) [v2 §2 table 3].
Baseline: `{id, brandId, carrierCode, serviceId, periodStart, periodEnd, packagesTotal, labelsMissingWeight}`.

### C1 Baseline selection [v2 §3.2; G-14]

1. Without `baselineIds`: baselines whose `(brandId, carrierCode, serviceId)` EQUAL `(filters.brandId, filters.carrierCode ?? null, filters.serviceId ?? null)` exactly. A brand statistic uses only that brand's baselines; a tenant-wide one only brand-null baselines; carrier- and service-null baselines are never reused for a carrier or service filter and scopes are never summed.
2. With `baselineIds`: exactly those baselines; any whose `brandId` differs from `filters.brandId` -> refused `scope_mismatch` (a brand numerator over a tenant denominator, or the reverse).
3. With `window`: only baselines wholly inside it (`window.from <= periodStart and periodEnd <= window.to`); `baseline.outsideWindowCount` counts the others.
4. Two selected baselines whose periods overlap (a later start on or before an earlier end) -> refused `baselines_overlap`. Adjacent periods (31 Jan, 1 Feb) do not overlap and are summed: `N = sum(packagesTotal)`.

### C2 Numerator [v2 §3.2; G-15]

Candidate records match brand (tenant-wide: every record, including `brandId` null), carrier, type and cause. If a `serviceId` filter is set and any candidate lying in scope has `serviceId` null -> refused `service_unresolved` with `unresolvedCount` (the filter is disabled, never silently ignored); otherwise candidates are limited to that service. The numerator is the candidates whose `shipDate` lies in a selected baseline period (or, with no baseline, in the window when one is given, else all). `excludedOutsideBaseline` counts the candidates left out (records, not keys). Denominator filters are brand, carrier, service and window only; type and cause filter the numerator only.

`affected` (k) = count of distinct `packageRef ?? id` over the numerator [v2 §3.2]: two records on one reference count once; a record without a reference counts once by itself and `perRecordCounting` is true. `k > N` -> refused `k_exceeds_n`. No selected baseline -> `incidence`, `incidenceByDirection` null with `incidenceReason: "no_baseline"` and only severity statistics are produced (never 0.00).

### C3 Incidence, direction, Wilson [v2 §3.2; G-16, G-23]

* `incidence = {k, N, pct4dp, wilson}`: exact fraction k/N, `pct4dp` = percent HALF_UP at 4 dp (`1.2000`, `0.0313` for k=1, N=3200). `wilson = {lowerPct4dp, upperPct4dp, lowerPct10dp, upperPct10dp}`: Wilson score interval, z = 1.96 exactly, closed form `((p + z^2/2N) +- z * sqrt(p(1-p)/N + z^2/4N^2)) / (1 + z^2/N)`, sqrt at 60 significant digits (Decimal), lower bound clamped at 0, reported as percent rounded HALF_UP at 4 dp (and 10 dp for tolerance tests). Statement printed: "range reflects incidence uncertainty only".
* Direction of a record = sign of `postageDifference`: `increase` (> 0), `decrease` (< 0), `zero`, `unknown` (null). `incidenceByDirection[g] = {k (distinct keys among that group's records), pct4dp, wilson}`. A package key present in two groups counts in each (fixtures avoid it).

### C4 Severity [v2 §3.2; G-17, G-18, G-19]

Per direction group and per parameter (`postage` = `postageDifference`, `fee` = `separateFee`), over the group's records that HAVE the amount: `{n, sumE4, meanE4, medianE4}` (all null when n = 0). `meanE4` = sumE4 / n rounded HALF_UP to an integer; `medianE4` = middle value, or for an even n the average of the two middle values; for the `increase` group also `p90E4` (nearest rank: the `ceil(0.9 n)`-th smallest) and `maxE4`.

* `chargesOnly = {n, meanE4}` = the increase group's postage block. `netOfCredits = {n, sumE4, meanE4}` over every record with a postage difference (increase, decrease and zero) [v2 §3.2; customer review F14]. Credits never enter exposure; net is a memo.
* `topRecordOver25Pct.{postage, fee}` is true when the increase group's largest amount is strictly more than 25 percent of its sum.
* Severity statistics are per RECORD (a package with two records has two severities; no per-package mean in v1).

### C5 Confidence, maturity, rates [v2 §3.2; G-20, G-21, G-22]

* `confidence.incidence`: `none` when k = 0 (or no baseline); otherwise by the relative half-width `(upper - lower) / 2 / (k/N)` of the exact Wilson interval: above 0.5 `low`, above 0.25 up to 0.5 `moderate`, at most 0.25 `adequate`. `confidence.postage` / `.fee` by the increase group's n: 0 `none`, 1-29 `low`, 30 or more `adequate`.
* `maturity` (only when `maturityDays` is given): `windowEnd` = `window.to`, else the latest selected `periodEnd`; `daysSinceWindowEnd = today - windowEnd`; `immature = daysSinceWindowEnd < maturityDays` (strict: ending exactly maturityDays ago is mature).
* `missingRatePct = sum(labelsMissingWeight) / N` as percent 4 dp and `correctionRatePct = (distinct keys with cause wms_no_weight) / sum(labelsMissingWeight)` as percent 4 dp, only when EVERY selected baseline has `labelsMissingWeight` typed (else both null); `correctionRatePct` is null when the sum is 0 or a cause filter is set. Never inferred from adjustments alone.

### Asserted fields for history

`status`, `code` (+ `unresolvedCount`, `k`, `N`, `ids` for refusals), `scope`, `baseline.{present, ids, packagesTotal, outsideWindowCount}`, `excludedOutsideBaseline`, `recordsInScope`, `affected`, `perRecordCounting`, `incidence`, `incidenceByDirection`, `incidenceReason`, `severity`, `chargesOnly`, `netOfCredits`, `topRecordOver25Pct`, `confidence`, `maturity`, `missingRatePct`, `correctionRatePct`, `labelsMissingWeight`, `wmsNoWeightAffected`. Wilson `*10dp` values compare with a tolerance of 1e-9 percent; the `4dp` values exactly.

## Part D. Risk forecast `forecastAdjustmentRisk(inputs)` [v2 §3.3]

Input: `{monthlyVolume (decimal string), incidence: {source:"history", k, N} | {source:"entered", pct}, severity: {postage_difference: {source: entered|history|example, e4: int|null, n?}, separate_fee: {...}}, basis: declared_weights | actual_weights, handling: {postage_difference, separate_fee}, credits?: {k, severityE4}}`. Severities are INTEGER E4: a history mean is rounded HALF_UP to E4 once when the statistic is produced and the forecast multiplies that integer [G-24]. Handling is already resolved by policy.

### D1 Refusals (status `refused`, `code`) [v2 §3.3; edge cases; G-30]

`volume_invalid` (not a decimal), `volume_negative`, `volume_too_large` (> 5,000,000), `basis_required` (no default), `k_exceeds_n`, `k_negative`, `p_out_of_range` (entered outside 0..100), `severity_negative` (credits are never an exposure input), `overflow` (an E4 figure above 2^53 - 1: the engine throws RangeError like `wholeE4`).

### D2 Incidence and affected [v2 §3.3]

History: p = k/N exact; N = 0 (no baseline) -> `incidence: null`, `incidenceReason: "no_baseline"`, every component `not_computed` (reason `incidence_unknown`), total null: never 0.00. Entered: p = pct/100 as typed, the result echoes `{source:"entered", pctAsEntered}`. `affected.exact` = V x p (exact decimal string, trailing zeros trimmed), `affected.display1dp` HALF_UP at 1 dp (4.995 -> 5.0). `incidence.pct4dp` for history. V = 0 -> affected 0.

### D3 Components, basis and the truth table T1 [v2 §3.3; math review T1; G-26]

Component amount (exact, E4) = affected x severity_e4, rounded HALF_UP to an integer ONCE per component. `separate_fee` is ALWAYS counted here; `postage_difference` is counted here only under `declared_weights`.

| basis | handling of postage | counted here (bucket) | staff memo |
|---|---|---|---|
| declared | pass_through | customerPays | none |
| declared | manual_approval | decidedCaseByCase (range 0..amount) | none |
| declared | absorbed | notBilledToCustomer | none |
| declared | unconfigured | notDecided ("So far") | none |
| actual | pass_through | not counted (in the forecast): state `in_forecast` | none |
| actual | manual_approval | not counted | `inForecastDecidedCaseByCaseE4` = amount, warning `forecast_includes_unbilled_postage` |
| actual | absorbed | not counted | `inForecastNotBilledE4` = amount, same warning |
| actual | unconfigured | not counted | none (no bucket, no memo) [G-26] |

`notBilledToCustomer + inForecastNotBilledE4` is therefore invariant under a basis flip for postage (v2 section 9 lists "basis flip never changes notBilledToCustomer"; section 3.3 moves the in-forecast amount to a memo, the goldens follow 3.3: see open question Q-2 in the report). Fee components: bucket by handling, `unconfigured` -> `notDecided`.

### D4 Totals, identity, derived figures [v2 §3.3; G-25, G-27, G-31, G-32]

* `countedHereE4` = the SUM of the integer E4 amounts of the counted-here components; `buckets` (`customerPays`, `decidedCaseByCase`, `notBilledToCustomer`, `notDecided`) sum to it exactly in E4 (asserted). `decidedCaseByCaseRangeE4 = {lowE4: 0, highE4: bucket}` (the 3PL's own possible cost, no assumed approval share).
* `perShipmentE4`, `per1000E4`, `annualE4` are computed from the EXACT (unrounded) sum of the counted-here components, rounded HALF_UP once: per shipment = exact sum / V, per 1,000 = exact sum x 1000 / V, annual = exact sum x 12 (never a rounded monthly x 12). `perShipmentE4` and `per1000E4` are null when V = 0. Case `r4_d_e4_then_cents_0_12495` pins the difference: components 0.12495 -> 0.1250 each, total 2500 E4, exact sum 2499 E4, per shipment 2, per 1,000 2499, annual 29988.
* `perAffectedE4` = sum of the severities of the counted-here components that have one.
* A component with null severity is `not_computed` (reason `severity_unknown`), never 0.00; `atLeast` is true when a counted-here component is not computed while another is; when no counted-here component is computed the total, buckets and derived figures are null. When the multiplier is exactly 0 (V = 0, or incidence 0: k = 0 or entered 0) the amount is 0 whatever the severity, `computed` [v2 §3.3 "k=0 -> expected exposure 0.00"; G-27]. `soFar` = `buckets.notDecided > 0`.
* `range` (history incidence only): incidence Wilson bounds (4 dp), `lowAffected1dp` / `highAffected1dp` = V x bound, `lowE4` / `highE4` = V x bound x (sum of the counted-here severities), rounded HALF_UP once; with no known severity `highE4` is null and `lowE4` is 0 when the lower bound is 0 [v2 §3.3; G-28]. "Range reflects incidence uncertainty only."
* `credits` (optional, history N): `creditsMemoE4 = round(V x k / N x severityE4)` (negative) and `netMemoE4 = countedHereE4 + creditsMemoE4`: a memo that assumes credits are returned; credits never enter the buckets [v2 §3.2; math R5; G-29].
* `confidence = {incidence, postage_difference, separate_fee, overall}`: incidence from the Wilson relative half-width as in C5 (k = 0: `none`, or `low` when any severity is `entered`); severity `history` by its `n` (none/low/adequate), `entered` and `example` are not rated; `overall` = the weakest rated one (order none < low < moderate < adequate), `entered` when nothing is rated [v2 §3.2; G-31].

### Asserted fields for risk

`status`, `code`, `incidence`, `incidenceReason`, `affected`, `components.*.{state, amountE4, handling, reason}`, `countedHereE4`, `buckets`, `decidedCaseByCaseRangeE4`, `inForecastMemoE4`, `soFar`, `atLeast`, `perAffectedE4`, `perShipmentE4`, `per1000E4`, `annualE4`, `range`, `creditsMemoE4`, `netMemoE4`, `warnings` (set), `confidence`.

## Part E. Policy resolution `resolveHandling(policies, brandId, type, component, date)` [v2 §2 table 1, §3.4]

`policy-matrix.json`: `policies` (single tenant; `brandId` symbolic, null = tenant default), `queries` with `expected`. Rules: a row is IN EFFECT on `date` when `validFrom <= date <= validTo` (`validTo` null = open; both inclusive, `daterange '[]'`); the brand's own row in effect beats the tenant default; no row in effect -> `unconfigured`; the pair `(correction, postage_difference)` is invalid and resolves to `unconfigured`; nothing is derived from another type (`combined` is an explicit row, no hidden precedence) [v2 D9; G-33]. The TypeScript function and `app.adjustment_handling(tenant, brand, type, component, on)` must both reproduce every query. `constraintExamples` lists row sequences for the exclusion constraint test (`overlap: true` -> the second insert fails).

## Part F. Import [v2 §5; G-34]

### F1 Header guard (`header-guard.json`)

Normalise a header (lower case, every run of non-alphanumeric characters becomes one space, trim). A header equal (normalised) to a TEMPLATE header always passes. Otherwise it is REFUSED when it contains any whole word `cost, rate, postage, label, carrier, net, wholesale, negotiated, paid, invoice, buy` (optional plural `s`). The guard runs over every header of every sheet BEFORE anything is stored; the refusal names the first offending header in file order and never echoes a cell value; nothing from the file is saved (no `uploaded_files` row, no `adjustment_imports` row). A passing header auto-maps to a money field only when it is an exact template money header (`customer_charge_original`, `customer_charge_corrected`, `customer_adjustment_fee`), or contains `charged to` / `billed to`, or contains the word `customer` together with one of `charge, charges, charged, amount, fee, price, total`; any other money-like header (`Adjustment Amount`, `Original Charge`, `Total`) is left unmapped and listed under "Columns we will ignore". The table lists false positives on purpose (`Carrier Name`, `Net Weight`, `Label ID`, `Rate Card`, `Customer Postage Charge`): the rule is deliberately strict and the user renames the column. No guard can prove a number is customer-facing [v2 H1].

### F2 Validation codes (`import-expected.json`)

Errors (block commit): `invalid_date`, `non_positive_weight` (a weight present and <= 0; a blank declared weight is NOT an error), `partial_dimensions` (original or corrected dimensions not all-or-none), `negative_amount` (`(3.20)` or `-5.00`), `invalid_amount` (not a number; a decimal comma like `12,50` is refused, never read as 12.50) [G-34], `duplicate_reference` (a later row with the same `(package_ref, adjustment_type)` in the file while `duplicate_handling = refuse`; counts the repeat rows, not the first). Information (do not block): `unknown_customer` (a brand name that is not a customer; blank = unassigned and not counted), `no_amounts` (original, corrected and fee all blank: counts for incidence only), `credit_row` (corrected < original), `possible_double_count` (corrected - original equals the fee within 0.01), `missing_weight` (declared weight blank). `duplicate_handling = sum` merges the repeat into the first row, `first` ignores it.

## Part G. How to consume the fixtures (engine tests)

```ts
const fx = (n: string) => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/adjustments", n), "utf8"));
const { rules, contexts } = fx("rules.json");                       // overlay + profiles
const { scenarios, policyProfiles, historyCases, riskCases } = fx("scenarios.json");
const expected = fx("expected.json");                               // .scenarios[id], .history[id], .risk[id]
for (const s of scenarios) {
  const ctx = buildContext(contexts[s.context], rules);             // Part A0
  const policyFn = (type, component) => policyProfiles[s.policy]?.[type]?.[component] ?? "unconfigured";
  const got = evaluateAdjustmentScenario(s.input, ctx, policyFn);   // compare with expected.scenarios[s.id] (asserted fields)
}
for (const c of historyCases) {                                     // records: history-records.json recordSets[c.records], baselines: history-baselines.json baselineSets[c.baselines]
  const got = summariseHistory(records, baselines, c.filters);      // compare with expected.history[c.id]
}
for (const c of riskCases) { const got = forecastAdjustmentRisk(c.input); /* expected.risk[c.id] */ }
```

Property tests the goldens support (v2 §9): the E4 identity (`buckets` sum to `countedHereE4`) over every `ok` risk case; `affected x severity` scale invariance (V x 2 doubles every exact component); order invariance of `summariseHistory` over record order; heavier corrected weight at the same dimensions never lowers the difference on the fixture card (see `e1`, `e2`, `e3`); `low <= expected <= high` over the history-derived risk cases.

## Part H. What the goldens do NOT cover

Fee-schedule percent-of-shipping effects and fuel on the adjustment fee are not modeled (v2 D12 C11, C12) and so have no case. Customer-facing copy, SQL authorization, staleness and the publish payload are not engine arithmetic and are tested elsewhere. Weight unit conversion for kg and g rows (`history-sample.csv` rows 16 and 17) is exercised by the importer but not asserted here, because the stored lb values depend on the shared `weightToLb` factors.

## Part I. Decision register (every G-n, and the cases that pin it)

Reverse a decision by editing the named cases in `expected.json` (and the derivation README). `G-11` and `G-13` are unused numbers.

| ID | Decision (design v2 is silent or ambiguous) | Pinned by |
|---|---|---|
| G-1 | scenario input shape `{shipment, corrections[], declaredSource}`, merge semantics, one correction entry per package | every scenario |
| G-2 | classification compares weights in exact lb and dimensions AS ENTERED (not rounded), so 0.5 lb vs 8 oz is no change and 15.4 -> 15.3 is a remeasure with no price effect | `invalid_input_unit_equivalent_no_change`, `remeasure_same_rounded_dimensions_zero_15_4_to_15_3` |
| G-3 | validation order; an engine `invalid_input` on either side makes the scenario `invalid_input` (not `*_unavailable`) | `invalid_input_declared_weight_zero`, `..._bad_origin_zip`, `..._partial_dimensions_added`, `..._correction_count_mismatch`, `..._wms_fallback_zero` |
| G-4 | equal counted totals with a different billable weight: status `ok`, `0.00`, direction `none`, fee not shown | `plateau_billable_differs_zero_delta` |
| G-5 | fee-state precedence and the definition of a candidate; `not_configured` means no in-scope rule exists (a remeasure rule does not count for a reweight) | `not_configured_remeasure_rule_only_weight_change`, `fee_not_triggered_das_condition_false`, `fee_undecided_zip_list_missing`, `waived_for_customer`, `included_in_rate` |
| G-6 | decrease: negative amount, state `credit`, `creditAmount`, fee `not_triggered`, every bucket 0 | `credit_decrease_8_to_5`, `credit_multi_package_5_5_to_5_3_residential` |
| G-7 | `undecided` = unknown lines with a counted counterpart on the other side (the 20.00); `unresolved` = the engine's per-side total (the 120.00) | `e5_estimate_with_undecided_41_78`, `remeasure_dimensions_added`, `fee_undecided_zip_list_missing` |
| G-8 | per-line fee handling (correction rule -> `correction` row), component handling `mixed`, `policySnapshot` contents | `correction_rule_kept_for_every_type`, `mixed_handling_reweight_and_correction_rules` |
| G-9 | `totalsE4` is 0 unless the direction is `increase` | `credit_*`, `e1_*`, `plateau_*` |
| G-10 | scenario warning codes `adjustment_fee_rule_not_conditional` (named in v2) and `adjustment_fee_rules_stack` (name chosen here) | `definite_class_rule_forced_conditional_warning`, `e4_combined_non_additive`, `mixed_handling_*` |
| G-12 | echo fields `billableLb` (M2 string style) and `roundedDimensionsIn` | `remeasure_rounded_dimensions_echo_15_4_to_15_5`, `e5_*` |
| G-14 | baseline selection by exact `(brandId, carrierCode, serviceId)` key, window must wholly contain a baseline, explicit `baselineIds` scope mismatch refused | `h07`, `h09`, `h10`, `h11`, `h33` to `h36` |
| G-15 | numerator definition, `excludedOutsideBaseline` counts records (not keys), no-baseline statistics over the window | `h01`, `h07`, `h11` |
| G-16 | direction groups and incidence by direction | `h01`, `h23` |
| G-17 | severity per RECORD, E4 mean HALF_UP, p90 nearest rank | `h01`, `h19`, `h20`, `h24` |
| G-18 | `netOfCredits` covers increase, decrease and zero records; `chargesOnly` = increase group | `h01`, `h23` |
| G-19 | top-record warning strictly above 25 percent, increase group only | `h01`, `h18`, `h20` |
| G-20 | statistics confidence: k = 0 -> `none`; relative half-width thresholds; severity by the increase group's n | `h13`, `h14`, `h15`, `h19`, `h20` |
| G-21 | maturity strict (`days < maturityDays`) | `h26`, `h27`, `h28` |
| G-22 | missing and correction rates need every selected baseline typed; correction null when the sum is 0 or a cause filter is set | `h29` to `h32` |
| G-23 | Wilson lower bound clamped at 0; 4 dp HALF_UP percent plus 10 dp reference | `h13`, `h14`, `h15` |
| G-24 | severities in the forecast are integer E4 (a history mean is rounded to E4 once when produced) | all risk cases |
| G-25 | total = sum of the rounded component amounts; per shipment, per 1,000 and annual from the exact sum | `r4_d_e4_then_cents_0_12495`, `r4_b_fee_mean_2_025`, `r4_c_k1_n3200_v1m` |
| G-26 | actual basis: postage not counted, memo for absorbed and manual_approval, nothing for pass_through or unconfigured | `t1_act_*`, `r2_actual_postage_absorbed` |
| G-27 | a multiplier of exactly 0 (V = 0, k = 0, entered 0) gives `computed` 0 even when the severity is unknown | `r6_k0_severity_unknown`, `edge_v0`, `edge_p0_entered` |
| G-28 | range fields (history incidence only) | `r1`, `r6_*`, `r7_*` |
| G-29 | optional `credits` input and the `creditsMemoE4` / `netMemoE4` fields | `r5_credits_excluded_from_exposure` |
| G-30 | refusal codes | `refuse_*` |
| G-31 | risk confidence object | `r1`, `r6_*`, `r7_*`, `r4_a` |
| G-32 | `atLeast`, `soFar` and null totals | `edge_postage_severity_null_declared`, `edge_both_severities_null`, `edge_fee_severity_null_actual`, `r3_*` |
| G-33 | invalid policy pair resolves to `unconfigured`; inclusive dates | `policy-matrix.json` queries |
| G-34 | import validation codes, error versus information split, the strict header-guard word list and money auto-mapping | `import-expected.json`, `header-guard.json` |
