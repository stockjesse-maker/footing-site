# Implementation status

_Last updated: end of Milestone 2. This file is the source of truth for what works. Nothing is listed as done unless it was run and verified; "how verified" is stated._

## Milestone checklist

| # | Milestone | Status |
|---|---|---|
| 1 | Project foundation | **Complete** |
| 2 | Rate cards and pricing engine | **Complete** (see caveats: validated on fictional data only) |
| 3 | Customer shipping modeling | Not started |
| 4 | Fulfillment processing engine | Not started |
| 5 | Adjustment-risk module | Not started |
| 6 | Reports and branding | Not started |
| 7 | Billing (Stripe) | Not started |
| 8 | Carrier intelligence | Not started |
| 9 | Production readiness | Not started |

**What a 3PL can do today:** sign up, manage customers and staff, upload a customer-facing rate card (CSV/XLSX), review the detected mapping and validation, set per-service terms (DIM rules, rounding, minimums, included/waived surcharges, markup), upload zone charts, activate versions with effective dates, author and publish surcharge rules with source references and verification status, set per-customer exceptions, assign rate cards to customers, and price a shipment in the calculator with an itemized, explained result.

**What is not built:** the brand portal's *Model Costs* and *Reports* pages are still honest empty states (brand-side calculator, order-file modeling, fulfillment fees, adjustment risk, PDF reports, Stripe billing, carrier intelligence). The engine has been validated only against **fictional** fixtures; no real rate card or carrier document has been run through it.

## Milestone 2: what exists

| Capability | State | How verified |
|---|---|---|
| Pure pricing engine `src/engine` (no framework imports, enforced by ESLint): decimal money, DIM/billable weight with service rounding (incl. postal), zone charts per service, weight-bracket rate lookup with origin scoping, surcharge rules (flat / per-unit / percent, conditions incl. ZIP lists, `any_of`, `rule_applied`), exclusivity groups, bundling, rule-imposed billable-weight floors, customer overrides (5 modes), service markup, line statuses (charged / included / waived / conditional / unknown), charge classes (definite / estimated / conditional), split totals incl. `unresolved`, full references (engine, card, terms, rule key@version, ZIP lists, overrides) and warnings | Done | 279 unit tests: 32-scenario golden dataset derived independently of the engine, per-area suites, two adversarial review suites whose findings were fixed |
| Rate-card schema: carriers/services reference data, rate cards, versions (draft → active → archived/discarded, non-overlapping active windows), per-service terms, rows (generated bracket bounds, no overlaps), zone charts, brand assignments (optionally limited to services), uploaded files (bytea, 5 MB), imports | Done | 31 DB tests on real PostgreSQL (114 DB tests in total), exclusion constraints exercised |
| Surcharge rules: platform or tenant scope (optionally one brand), immutable published versions, retire, verification status + source reference required, ZIP lists (draft/published, entries), customer overrides with non-overlapping dates | Done | DB tests + engine tests |
| RLS: brands see only cards assigned to them, only the active version, only allowed services; never drafts, imports, files, other brands' overrides or other tenants; writes need `ratecard.manage`; lifecycle only via SECURITY DEFINER RPCs; `pricing_rules_for_card` authorizes once and returns only what the caller may see | Done | `tests/db/pricing.test.ts` (every role, cross-tenant, cross-brand, suspended brand, ended assignment) |
| Audit: card creation, activation, assignment, rule publication, calculator runs; lifecycle namespaces unforgeable through `log_audit_event` | Done | DB tests |
| Import pipeline `src/lib/import`: CSV + XLSX parsing with size/row/cell caps and type sniffing; long-format and grid-format detection with header synonyms; service suggestion; strict validation (brackets, overlaps, gaps, zones, origins, decreasing prices); administrator approves the mapping; draft creation copies forward terms and zones | Done (heuristics only, **no AI**) | `tests/unit/import-pipeline.test.ts`, e2e import flow |
| 3PL portal: rate cards list/detail, import wizard (upload → mapping → validation → draft), version page (rows, terms editor, zone-chart upload, activate/end/archive), surcharge rules list/new/detail (versions, publish, retire), customer page (assignments, exceptions), calculator with itemized result and explanations | Done | `next build`, e2e (`tests/e2e/pricing.spec.ts`), typecheck, lint |
| Downloadable CSV template for the long format | Done | route built; e2e downloads it |
| Brand portal pricing pages | **Not built** (Milestone 3); empty states say so | e2e |

## Verification results (this session)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` (unit) | 279 / 279 pass |
| `npm run test:db` (RLS/authorization, real PostgreSQL 16 + real Supabase Auth schema) | 114 / 114 pass |
| `npm run test:e2e` (Playwright: 19 desktop incl. axe and the pricing journey, 3 iPhone-emulated) | 22 / 22 pass |
| `next build` | pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm audit` (including dev tooling) | 5 high advisories, all the same `braces` issue reachable only through the ESLint/Next lint toolchain (dev-only) |

## Honest limitations and gaps (Milestone 2)

1. **Fictional data only.** The golden dataset, fixture rate card, zone chart, rules and ZIP lists in `tests/fixtures/pricing` are invented for testing and labelled so. No real customer-facing rate card, carrier surcharge guide or zone chart has been imported or priced. Until that happens, calculator output must be treated as a demonstration of mechanics, not of prices.
2. **Rate cards are weight-bracketed only.** Volume-tiered products (e.g. USPS Cubic) and packaging-keyed rows (flat-rate boxes) are out of scope by decision; the importer would mis-read such sheets as weight brackets, so they must not be imported until a `bracket_basis` is added.
3. **Zone charts come from the 3PL.** The app ships no carrier zone data. A card without a zone chart for a carrier can still be priced by entering the zone directly.
4. **Platform-scope (carrier-verified) rules** can only be inserted with the service role today; the review/approval workflow is Milestone 8. Tenant rules must state a source reference and are marked `3pl_approved`, never "carrier-verified".
5. **Carrier adapters hold structure only** (rounding, measurement, category order, known exclusive groups) offered as defaults the 3PL must verify; no amounts, divisors or ZIP lists are shipped.
6. **Uploads** are stored as bytes in PostgreSQL under RLS (5 MB cap, content sniffing, row/cell caps). No malware scanning and no object storage yet (Milestone 3, with order files).
7. **Calculator rate limit** is 600 runs per user per hour (PostgreSQL-backed). Bulk pricing (order files) is Milestone 3.
8. **Grid-format import** requires a labelled weight column and zone headers; unusual layouts fall back to manual mapping in the wizard, and some may need re-saving in the long format (template provided).
9. **Metric units and non-US destinations** are not supported by the engine or forms.
10. **End-to-end coverage is a single journey.** `pricing.spec.ts` drives the long-format CSV fixture through import → terms → zone chart → activation → three rules → calculator (three golden scenarios) → assignment, plus cross-tenant 404s and an honest import failure. Not driven in a browser: grid/XLSX imports, customer exceptions and ZIP-list uploads, version end/archive, rule retire/new-version, multi-package and USPS ounce scenarios, the brand side of an assignment, and axe/iPhone checks on the new pages (unit and database tests cover the logic; the UI paths are untested).
11. **Adversarial code review was run and acted on.** Three reviewers (authorization, data-path correctness, UI honesty/accessibility) produced 40 findings; the confirmed ones were fixed in this milestone (brand exceptions were silently dropped for brand callers, inclusive-integer weight ranges imported with holes, unknown weight units fell back to a default, over-long sheets were truncated silently, zone charts could be replaced half-way, archived cards still accepted versions, and others) and each fix has a test. One finding was rejected after discussion: the surcharge markup percentage is a term of the customer's own rate card, so customers may see it; it is labelled as customer-visible in the terms form.
12. Milestone 1 limitations still apply: not exercised against hosted Supabase; email delivery untested on a real provider; no real iPhone testing; no CSP; no MFA/SSO; no CI workflow committed; no tenant export/deletion.

## Design decisions made in Milestone 2 (say so if you disagree)

* **Fuel and other percentage rules cover shipment-level charges even when configured per package** (one shipment-level line over counted shipment-level surcharges). A per-package rule never silently exempts a shipment-level surcharge from fuel.
* **Exclusivity is resolved before bundling, to a fixed point**; a waived rule that would otherwise have won its group stays visible as *waived*; an unknown higher-priority member stays listed as an uncounted estimate and the winner's explanation says the charge may be replaced.
* **Rule-imposed billable-weight floors** apply only from rules that survive conflict resolution; conditions are evaluated on the package before any floor.
* **Reported weights** are exact when they terminate within 12 decimals, otherwise rounded up at the 12th decimal, so a reported billable weight never falls below what was priced; the UI formats for display.
* **A counted line from an unverified rule is an estimate**, never definite; a percentage of an estimated base is an estimate.
* **Customer exception modes**: exclude, override amount, override percent, markup percent, add percentage points; at most one live exception per rule per customer on any date (database-enforced).
* **Service markup** ("published + X%") scales charged surcharges unless a customer exception replaces the figure.

## Decisions that still need your confirmation

* **Location**: the app is in `parcelclarity/` because the repository root contains a live static site. It can be moved to its own repository as-is.
* **Email provider**: Resend for invitation email. Say so if you prefer Postmark/SES/SMTP.
* **Real data for validation**: to move the engine from "mechanically verified" to "validated", I need at least one real customer-facing rate card (with the DIM/rounding terms you give customers), the surcharge schedule you bill from (with its source), and a zone chart. I will not invent these.

## Credentials needed

None for Milestones 1–2. Milestone 3 needs none either (order-file uploads reuse the database-backed storage; object storage can wait). Stripe keys are first needed in Milestone 7.

## Next: Milestone 3: customer shipping modeling

Brand-portal single-shipment calculator and order-file (CSV/XLSX) bulk modeling against the assigned rate card: per-order pricing, totals, average cost per order, breakdown by service/zone/weight, unknown/estimated exposure; saved simulations with full references; 3PL "model on behalf of a customer"; large-file processing and progress; downloadable results. Requires **no external credentials**.

## Milestone 1 (unchanged, summary)

Next.js 16 / React 19 / strict TypeScript / Tailwind 4 design system and responsive shell with iPhone-safe bottom navigation; Supabase Auth sign-up/confirm/sign-in/reset with HttpOnly cookies and server-validated sessions; 3PL onboarding; five roles with permissions mirrored in TypeScript and SQL (parity-tested); customers (brands), invitations, memberships with last-admin protection; RLS on every table, column-scoped grants, append-only trigger-written audit; platform admin console without tenant-data access; durable rate limiting; PWA manifest, icons, minimal service worker and offline page. Verified by unit, DB (real PostgreSQL + GoTrue schema) and Playwright tests. See git history for the original Milestone 1 report.
