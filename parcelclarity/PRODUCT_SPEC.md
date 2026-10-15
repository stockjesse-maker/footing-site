# Product specification

ParcelClarity is a two-sided SaaS for third-party logistics providers (3PLs) and their ecommerce brand customers.

**Value proposition:** "Know what fulfillment and shipping will cost before you ship."

## Non-negotiable rules

1. **Customer-facing rates only.** ParcelClarity must never require, import, store, display, or calculate with a 3PL's negotiated carrier buy rates. The only shipping base-rate source is the customer-facing rate card the 3PL provides. Carrier account-specific rate API responses are never customer pricing.
2. **No invented data.** No fabricated carrier surcharge amounts, customer rates, or "sample" figures presented as real. Missing rates are shown as unavailable, never extrapolated (unless an explicit, approved rule allows it).
3. **Confidentiality.** Brands never see buy rates, 3PL margins, internal losses, other customers' pricing, unassigned rate cards or carrier contracts. Platform administrators do not automatically see tenant data.
4. **Server-side enforcement.** Hidden UI is never a security mechanism. Tenant/brand isolation is enforced by PostgreSQL Row Level Security and server-side checks.
5. **Estimates are labeled.** Definite charges, assumption-based estimates and conditional post-shipment adjustments are always distinguished; estimates are never presented as invoices.
6. **Honest status.** Nothing is claimed to work unless tested (see IMPLEMENTATION_STATUS.md).

## Actors and roles

| Role | Scope | Summary |
|---|---|---|
| Platform administrator | Platform | Operates the service; can list/suspend tenants. Cannot read tenant data. |
| 3PL administrator | Tenant | Manages brands, staff, pricing, billing, audit log |
| 3PL employee | Tenant | Works with brands and quotes; cannot change account structure |
| Brand administrator | Brand | Manages brand team; runs models and reports |
| Brand employee | Brand | Runs models; views reports |

A 3PL is a tenant; a tenant has many brands; a brand has many users. A user may hold several memberships.

## Functional requirements and status

| Area | Requirement | Milestone | Status |
|---|---|---|---|
| Accounts | Email/password auth, confirmation, reset, sessions | 1 | Done |
| Accounts | Roles, invitations, suspension, revocation, audit log | 1 | Done |
| Accounts | Tenant/brand isolation by RLS with tests | 1 | Done |
| Portal | 3PL portal shell + overview; brand portal shell (Overview, Model Costs, Reports, Account) | 1 | Done (Reports holds the run comparison; PDF reports are Milestone 6) |
| Rate cards | CSV/XLSX import, validation preview, admin approval, versioning, overrides | 2 | **Done** (3PL side; fictional data only) |
| Engine | Deterministic shipping charge engine: DIM, billable weight, zones, brackets, minimums, surcharges with precedence and effective dates | 2 | **Done** (validated on fictional fixtures; not on real cards) |
| Modeling | Single shipment calculator; bulk order modeling (avg cost per order); manual forecasting; scenarios | 3 | **Done** except manual forecasting from assumptions (folded into 4, which supplies the packaging/storage assumptions it needs); fictional data only |
| Processing | Pick/pack, packaging, receiving, storage, returns, minimums; all-in cost per order | 4 | Not started |
| Risk | Reweight/WMS adjustment-risk module with confidentiality controls | 5 | Not started |
| Reports | Branded PDF reports; white-label branding; exports | 6 | Not started |
| Billing | Stripe subscriptions for 3PL (quote-project plans) and brands (premium), entitlements, sponsorship | 7 | Not started |
| Carrier rules | Versioned rule administration, change detection, review/approval workflow | 8 | Not started |
| Production | E2E, security review, accessibility audit, performance, deployment, monitoring, backups | 9 | Not started |

## Key definitions

* **Quote project**: a customer proposal that may include multiple service comparisons, revisions and exports. A revision does not consume another quote credit. (Billing, Milestone 7.)
* **Average shipping cost per order** = total modeled shipping charges ÷ number of modeled orders. Never the price of an "average-weight" package. Imported vs. modeled orders are reported separately with coverage percentages.
* **Order vs shipment vs package**: distinct counts; an order may have many packages.
* **Definite / estimated / conditional charges**: upfront certain charges / charges depending on assumptions / possible post-shipment adjustments.
* **Allocated fixed costs** (storage, receiving, monthly minimums) are labeled as allocations over a stated period and order volume, never as variable per-order fees.

## Design requirements

Premium, Apple-inspired: white/light-gray surfaces, charcoal text, one restrained blue accent, generous spacing, rounded cards/inputs, large numeric results, no clutter, no popups, minimal onboarding. Light mode now, tokens structured for dark mode later. Must be excellent on iPhone Safari and installable as a PWA; structure must keep native packaging (Capacitor) possible.
