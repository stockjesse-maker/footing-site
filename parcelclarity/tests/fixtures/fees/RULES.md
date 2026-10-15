# Fee engine rules (the contract the golden expectations are derived from)

These rules restate `m4-design-v2.md` §1, §2 and §4 precisely enough to compute every scenario in `scenarios.json` by hand. Expected results in `expected.json` are derived from THIS document and the fixtures, never from the code. Money in E4 = integer ten-thousandths of a dollar (12500 = $1.25); "cents" = HALF_UP to 2 dp.

## A. Order-scope rules (`calculateOrderFees(input, schedule, context)`)

Quantities (q) per basis: `order` 1; `unit` input.units; `line` input.lines; `sku` input.distinctSkus; `package` number of packages; `shipment` input.shipments; `shipping_percent` the base amount (see A6); `order_driver` the driver count (see A7). A null quantity is **unknown**. The caller derives them from the order file as: `lines` = the order's lines with units > 0, **null when there are none** (a file with no line data, or an order with no line rows); `distinctSkus` = distinct non-null SKUs among those lines, **null when lines is null or any counted line has no SKU** (a per-product fee is then not computed rather than undercounted).

A1. Free allowance: free = includedQuantity × count(includedPer) where count(order) = 1, count(line) = lines, count(sku) = distinctSkus, count(shipment) = shipments, (null includedPer) = 1. Chargeable c = max(0, q − free). If the count the allowance reads is unknown → the rule is unresolved (`lines_unknown` / `skus_unknown`).

A2. Conditions: minUnits/maxUnits read units, minLines/maxLines read lines, minPackages/maxPackages read the package count (inclusive bounds). A condition that reads an unknown quantity makes the rule unresolved (`units_unknown` / `lines_unknown`). `packagingTypes`: a package matches when its normalised type (trim, lower case, runs of whitespace/underscores/hyphens collapsed to one space) equals an entry, or the rule lists `"*"` and the package has a type. A package with no type: if context.packagingDefault is set it is used (and every line of a packaging-conditioned rule is estimated, warning `packaging_defaulted`); otherwise every packaging-conditioned rule is unresolved with reason `packaging_unknown`. A package whose type matches no packaging-conditioned rule at all (no catch-all): the result carries an unresolved entry `{ ruleKey: "packaging:<normalised type>", name: "Packaging (<type as given>)", reason: "packaging_unmatched" }` once per distinct type.

A3. Exclusive groups: for `package` basis rules the competition is per package: among the group's rules whose conditions match the package, the lowest `priority` wins (ties broken by `position`); a rule that matched but lost is listed once in `unresolved` with reason `replaced` and `replacedBy` = the winner's key. For other bases the competition is per order. The winner's quantity counts only the packages it won.

A4. Amount: `flat`: c × amount. `tiered` (`on = order_quantity`): brackets over c; `graduated` Σ over brackets max(0, min(c, upTo[i]) − upTo[i−1]) × amount[i] (upTo[−1] = 0, last bracket unbounded); `volume` with `pricing = rate`: c × amount of the first bracket with c ≤ upTo (last bracket otherwise); `volume` with `pricing = flat`: that bracket's amount is the whole price. A tiered rule never has a free allowance. `tiered` with `on = monthly_quantity`: the rule prices c × the pinned rate `context.pinnedRates[key].rateE4`; when no rate is pinned the rule is unresolved with reason `assumption_missing`. minimumCharge: when c > 0 and the amount is below minimumCharge, the amount is minimumCharge.

A5. A rule with c = 0 (or a percent base of 0) produces no line and no unresolved entry. Lines are ordered by rule `position`.

A6. `shipping_percent`: base = shipping.totalE4 (percentBase `shipping_total`) or shipping.baseFreightE4 (`base_freight`); quantity = base in dollars as a decimal string with 4 dp; amountE4 = HALF_UP(base × percent / 100) to an integer E4; shipping null → unresolved `shipping_unknown`; shipping.hasExposure → warning `fee_base_excludes_exposure`.

A7. `order_driver`: answer = context.orderShares[driver.key]; null or absent → unresolved `assumption_missing`. p = sharePct / 100 exactly; the order qualifies iff floor(ordinal × p) > floor((ordinal − 1) × p); q = countPerOrder when it qualifies, else 0. Lines from order drivers are always estimated.

A8. Charge class: `estimated` when any quantity the rule read was flagged assumed (`assumed.units` for unit quantities and unit conditions, `assumed.lines` for lines, `assumed.skus` for SKUs, `assumed.packaging` or a packaging default for packaging conditions), when a pinned monthly rate was used, when the rule is an order driver, or (percent) when shipping.estimated is true; otherwise `definite`.

A9. Rounding: `invoice_line` keeps amountE4 exact (products of a 4-dp rate and an integer are exact; percent lines round once to E4); `transaction` rounds every line HALF_UP to a multiple of 100 (cents).

A10. Result: definiteE4 / estimatedE4 = Σ lines by class; `status` = `ok` when no unresolved entry other than `replaced` exists, `partial` when at least one line was computed and at least one rule is unresolved, `no_content` when no line was computed and at least one rule is unresolved. unitAmountE4 = the rate per unit for flat and rate-tiered lines (for graduated tiers: null), null for percent and flat-bracket lines.

## B. Monthly-scope rules (`calculateMonthlyFees(answers, schedule, monthlyOrders)`)

B1. `month` basis: quantity 1, amount = rule amount, class definite, scalesWithVolume false.

B2. `driver` basis (kind `monthly_quantity`): answer = answers.drivers[key]; null or absent → notModeled `no_answer`; "0" → modeled at zero (a line with quantity 0 and amount 0 is still emitted). Quantity = answer × period factor (billingPeriod `week`: × 30.4375 / 7; `day`: × 30.4375; `month`/absent: × 1). Long-term `replace`: the replaced rule's quantity is reduced by this rule's answer (if the replaced rule is missing → notModeled `replaced_rule_missing`); `surcharge` leaves it unchanged. An answer for a long-term driver larger than the stored quantity is an input error (the engine throws). Amount: flat c × rate; tiered (on monthly_quantity, graduated/volume over the quantity) as in A4; minimumCharge applies when quantity > 0; amounts rounded HALF_UP to E4 once. Class: estimated. scalesWithVolume false.

B3. `driver` kind `returns_rate`: answer is a percent of orders; quantity = monthlyOrders × answer / 100 (not rounded); monthlyOrders null → notModeled `volume_unknown`; class estimated; scalesWithVolume true.

B4. `minimum` rules produce no monthly line (they are evaluated in C). `unusedAnswers` = answered driver keys no rule reads. totalE4 = Σ line amounts.

## C. Minimums (`evaluateMinimums(buckets, schedule, monthlyLines)`)

For each minimum rule with resolvedRuleKeys R and amount M, per bucket m with fraction f:
C1. counted_m = Σ over rules k ∈ R of their monthly invoice-line totals: for order-scope rules the bucket's `orderVariableByRuleE4[k]` (0 when absent), scaled by shippedOrders / modeledOrders when modeledOrders < shippedOrders (coverage extrapolation; see C3), each rounded to cents; for monthly-scope rules the monthly line amount × f, rounded to cents; plus shippingExpectedE4 (scaled the same way, rounded to cents) when includesShipping.
C2. minimum_m = M × f rounded to cents; topUp_m = max(0, minimum_m − counted_m). topUpE4 = Σ topUp_m; countedE4 = Σ counted_m; minimumE4 = Σ minimum_m.
C3. status: `not_computed` when there are no buckets; `upper_bound` when any rule in R is in the monthly `notModeled` list, or is listed in a bucket's `unresolvedRuleKeys`, or any bucket has modeledOrders < shippedOrders; otherwise `exact`. reasons name each cause ("storage_pallet not modeled", "coverage 80.0% in 2026-03").
C4. members: every key of R with state `priced`, `not_modeled` (in notModeled or in some bucket's unresolvedRuleKeys), or `not_in_schedule`.

## D. Allocation (`allocate(input)`)

D1. coveragePct = modeledOrders / populationOrders × 100 (1 dp; "0.0" when population is 0). V = monthlyOrders (decimal) or null.
D2. perOrder.shipping = shippingExpectedE4 / modeledOrders in cents (null when modeledOrders = 0); perOrder.processing likewise.
D3. extrapolated = V ≠ null and coveragePct ≥ 80 and modeledOrders < populationOrders. monthly.shipping = (shippingExpectedE4 / modeledOrders) × V in cents when V ≠ null and coveragePct ≥ 80; when coveragePct < 80 it is shippingExpectedE4 / months ("at least", caveat); null when V is null. monthly.processing likewise.
D4. monthly.fixed = monthlyFixedE4 in cents (always). monthly.minimumTopUp = minimumTopUpE4 / months in cents when minimumStatus = `exact`, else null (an upper bound is never added).
D5. monthly.total = shipping + processing + fixed + minimumTopUp (exact, then one rounding) when shipping is known; null when V is null. annual = total × 12 rounded once.
D6. perOrder.allocated = (monthly.fixed + monthly.minimumTopUp) / V in cents; perOrder.allIn = monthly.total / V in cents; both null when V is null or 0.
D7. caveats: "allocated" sentence always when V ≠ null; "at least" when coveragePct < 80; "upper_bound" when minimumStatus is upper_bound; "volume unknown" when V is null.

## E. Pinned monthly rates (`resolveMonthlyRate(rule, monthlyQuantity)`)

graduated: rateE4 = HALF_UP(graduated(Q) / Q) to an integer E4; volume: the rate of the bracket containing Q (Q ≤ upTo). Q = 0 → null (unresolvable).
