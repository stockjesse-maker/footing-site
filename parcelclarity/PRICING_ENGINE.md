# Pricing engine

> **Status: design only. Nothing in this document is implemented yet** (Milestone 2). It records the contract the implementation must satisfy so that the tests, not the prose, become the authority.

## Hard rules

* Base shipping price comes **only** from the customer-facing rate card supplied by the 3PL. Never from buy rates or carrier account APIs.
* No fabricated surcharge amounts or customer rates anywhere in code, seeds, tests or docs. Every rule carries a source reference, version, effective dates and verification status (`unverified | verified | approved_3pl_config`). Unverified rules cannot silently influence a "definite" total.
* Missing rate → explicit "rate unavailable" result. No extrapolation outside rate-card ranges unless an explicit approved rule allows it.
* AI may assist *mapping/interpretation*, never publish a rule or rate; a human approves, and uploaded-document text can never alter pricing logic (prompt-injection boundary).

## Architecture

`src/engine/` is a pure TypeScript package: no React/Next/Supabase imports (lint-enforced). Inputs and outputs are plain serializable objects validated with Zod at the boundary. Carrier differences live in **carrier adapters** (UPS, FedEx, DHL eCommerce, USPS, later others); there is no pretense that carriers share surcharge structures.

## Money

Decimal-safe integer arithmetic (minor units) or a decimal library: never binary floats. One documented rounding mode applied at defined points (per line item, then summed); totals are the sum of rounded line items. Currency stored with every amount.

## Calculation pipeline (per package)

1. **Validate** inputs; reject or flag impossible values (negative, NaN, absurd dimensions).
2. **Dimensional weight** = (L × W × H) ÷ divisor, using the carrier/service-specific divisor from configuration. Apply that service's measurement rounding, thresholds (e.g. minimum cubic size for DIM to apply), exemptions and weight rounding **in the order the carrier defines**. Never hardcode one divisor.
3. **Billable weight** per service rules (actual vs DIM, rounding up to the next unit, minimums, maximums).
4. **Zone** lookup from origin ZIP → destination (rate-card zone chart, or an approved zone table).
5. **Base charge** from the rate-card row matching service, zone, weight bracket and effective date; apply row minimum charge; apply customer-specific override if configured.
6. **Surcharges** (below), then **fuel**.
7. **Result**: itemized lines each with amount, calculation basis, explanation and rule/version reference; plus the rate-card version and rule versions used.

## Charge classes (never mixed silently)

1. **Definite**: base + surcharges known from the inputs.
2. **Estimated**: depend on assumptions (e.g. residential share, zone mix, DAS probability); labeled and itemized separately.
3. **Conditional**: possible post-shipment adjustments (reweight, remeasure, address correction); shown separately, never added to a definite total without a label.

## Surcharge rules

Each rule: carrier, applicable services, eligibility conditions, effective dates, source reference, version, calculation method (flat / percent / tiered), amount or percentage, **calculation base** (what the percentage applies to: base only, base + selected surcharges, …), inclusion/exclusion flags, override rules, verification status.

Categories supported by the model: fuel, residential, DAS, extended DAS, remote, additional handling, oversize/large package, demand/peak, address correction, signature, declared value, reweight, remeasurement, shipping-charge corrections, other configurable accessorials.

**Precedence and exclusivity** are per carrier and data-driven: a carrier's rule set declares mutually exclusive groups (e.g. only the highest of Additional Handling / Large Package applies where the carrier says so) and bundled-surcharge exclusions, so one surcharge is never counted twice. Fuel's calculation base is configured per carrier/service because carriers differ on what it applies to.

Order of operations is defined by the carrier adapter and recorded in the result so it is auditable.

## Order-level aggregation

* Package charges → shipment → **order**. Shipment, package and order counts are distinct.
* **Average shipping cost per order = Σ modeled shipping charges ÷ modeled orders.** Imported orders vs modeled orders are both shown, with coverage %, and incomplete orders are *not* silently dropped from the denominator.

## Processing and all-in (Milestone 4)

Separate engine for 3PL fees (fixed, per-unit, tiered, percentage, minimum rules; effective-dated schedule versions). Order-variable fees are kept apart from monthly allocated costs (storage, receiving, account minimums), which use a stated forecast period and order volume; a monthly minimum is applied once and never double-counted with the fees it covers. Storage is never derived from shipped orders alone without explicit inventory assumptions.

## Reweight / remeasure adjustment risk (Milestone 5)

Separates carrier correction amounts, separate correction fees, 3PL-absorbed losses and contractually customer-billable adjustments; per-adjustment policy: absorbed / passed-through / manual approval. Postage differences already in a corrected shipping forecast are not counted twice. Customers see only authorized scenarios, never internal failure rates.

## Test strategy (to be created in Milestone 2)

* A **golden dataset** whose expected values are calculated independently of the engine (spreadsheet or hand arithmetic, checked in with the derivation).
* Unit tests for every item in the spec's list: weight rounding, DIM and exemptions, per-service divisors, zones, brackets, minimums, fuel bases, residential, DAS/extended DAS, handling/oversize exclusions, peak effective dates, overrides, bundled exclusions, missing values, multi-package, multi-line, historical rule versions, money rounding, invalid data, tenant/customer isolation.
* The engine is **not** labeled production-ready until golden tests pass **and** real carrier/customer examples supplied by the 3PL have been validated against it.
