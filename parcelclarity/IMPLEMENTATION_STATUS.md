# Implementation status

_Last updated: end of Milestone 3. This file is the source of truth for what works. Nothing is listed as done unless it was run and verified; "how verified" is stated._

## Milestone checklist

| # | Milestone | Status |
|---|---|---|
| 1 | Project foundation | **Complete** |
| 2 | Rate cards and pricing engine | **Complete** (see caveats: validated on fictional data only) |
| 3 | Customer shipping modeling | **Complete** except manual forecasting from assumptions (moved into Milestone 4, see below); fictional data only |
| 4 | Fulfillment processing engine | Not started |
| 5 | Adjustment-risk module | Not started |
| 6 | Reports and branding | Not started |
| 7 | Billing (Stripe) | Not started |
| 8 | Carrier intelligence | Not started |
| 9 | Production readiness | Not started |

**What a 3PL can do today:** sign up, manage customers and staff, upload a customer-facing rate card (CSV/XLSX), review the detected mapping and validation, set per-service terms (DIM rules, rounding, minimums, included/waived surcharges, markup), upload zone charts, activate versions with effective dates, author and publish surcharge rules with source references and verification status, set per-customer exceptions, assign rate cards to customers, price a shipment in the calculator with an itemized, explained result, and open any customer's *Cost models* page to upload order files, run models and price shipments on their behalf (private to the 3PL until shared).

**What a brand customer can do today:** sign in to the portal, price one shipment on the rate card their 3PL assigned (with plain-language explanations, no 3PL internals), save it as a scenario, upload an orders export (generic, Shopify or ShipHero-style CSV/XLSX), review how it was read and fix the mapping, keep product weights per SKU for files without package weights, run the whole file against the rate card (at today's rates or each shipment's ship date, optionally forcing one service), watch progress and resume after a reload, read the result (total, average per modeled order, what is certain vs. estimated vs. conditional, coverage, exclusions by reason, breakdowns by service / zone / weight / month / surcharge, every shipment with its lines), download the shipment-level CSV, and compare two runs.

**What is not built:** manual forecasting from assumptions without an orders file (deferred into Milestone 4 together with the packaging, storage and receiving assumptions it needs), fulfillment/processing fees, adjustment risk, PDF reports and branding, Stripe billing, carrier intelligence. The engine has been validated only against **fictional** fixtures; no real rate card, carrier document or customer orders export has been run through it.

## Milestone 3: what exists

| Capability | State | How verified |
|---|---|---|
| Customer calculator on the assigned rate card (`/portal/model/calculator`): services limited to the assignment, origin defaulted from the 3PL's ship-from ZIP, result rendered for a customer audience (names and plain language only: no rule keys, ids, engine version or verification status); save as a scenario | Done | e2e (`modeling.spec.ts`), DB tests for the brand-safe RPC payload |
| Order-file import `src/lib/orders` (pure): CSV/XLSX up to 15 MB / 100k rows; detection of generic, Shopify and ShipHero-style layouts with header synonyms; explicit grouping of rows into orders → shipments → packages (never conflated); order-level fields must agree across rows; dates read as written with an explicit format; ZIP cleaning and padding; lb/oz/g/kg; residential, cancelled, declared value; per-SKU product weights to derive package weight when the file has none (priced as an assumption); strict per-order validation with blocking vs. informational issues; a downloadable template | Done (heuristics only, **no AI**) | `tests/unit/orders-import.test.ts` with hand-counted expectations on three fixtures |
| Modeling schema (`20261015000005_modeling.sql`): `sku_profiles`, `order_datasets` + `orders`/`order_lines`/`shipments`/`packages`, `simulation_projects`, `simulation_runs`, `simulation_run_contexts`, `simulation_results`; RLS keyed on `app.can_model_brand` and the shared-with-brand visibility; no direct writes to rows, results or sharing flags; lifecycle only through authorising functions that accept only the run's own rows and exact windows; `finish_simulation_run` recomputes the headline figures in SQL, refuses a summary that disagrees and marks the rows in the totals | Done | 15 DB tests (`tests/db/modeling.test.ts`): every role, cross-brand, cross-tenant, staff-private files/datasets/scenarios/runs, sharing functions, interrupted preparation, idempotent and validated windows, reconciliation refusal, retired cards |
| Bulk run loop: time-boxed server action (~4 s, windows of ≤100 whole orders) over a database cursor; the partial summary travels with the cursor so concurrent callers never fold onto a stale copy; pricing context cached per ship date and per rate-card version within a batch; results dictionary-encoded (~300 bytes/shipment); transient load failures retried, deterministic failures fail the run honestly; browser loop with back-off, resume on tab return/online, confirmed cancel; rerun from the displayed settings | Done | DB tests for the functions, unit tests for the fold, e2e for the full run, `engine-throughput.test.ts` (**0.61 ms per shipment** measured on the fixture card with rules and ZIP lists) |
| Summary semantics `src/engine/modeling` (pure): modeled order = not cancelled and every shipment priced; totals and averages over modeled orders only; coverage shown; exclusions counted by reason (cancelled orders are counted, never silently dropped); definite / estimated / conditional / unresolved kept apart and exposure never averaged; breakdowns by service, zone, billable-weight bracket, month and surcharge; assumptions counted | Done | `tests/unit/modeling-fold.test.ts` (19 tests, hand-derived expectations) |
| Saved scenarios (single and bulk) with full references pinned per ship date (rate-card version, rule versions, ZIP lists, exceptions), rename/archive, comparison of two runs on the Reports page | Done | DB tests, e2e |
| 3PL "model on behalf of a customer" (`/app/customers/[brand]/model/…`): same pages, staff-created datasets and scenarios private until *Share with customer*; a customer never sees a 3PL what-if as their own number | Done | DB tests, e2e |
| Shipment-level CSV export streamed under RLS with customer-safe columns | Done | e2e downloads and checks it |
| Dataset lifecycle: upload → review mapping → fix → prepare → ready; discard; share | Done | e2e, DB tests |
| Manual forecasting from assumptions (no orders file) | **Not built** (Milestone 4) | — |

## Verification results (this session)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` (unit) | 317 / 317 pass |
| `npm run test:db` (RLS/authorization, real PostgreSQL 16 + real Supabase Auth schema) | 129 / 129 pass |
| `npm run test:e2e` (Playwright: 26 desktop incl. axe, the pricing journey and the modeling journey with its own iPhone/axe pass; 3 iPhone-emulated) | 29 / 29 pass |
| `next build` | pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm audit` (including dev tooling) | 5 high advisories, all the same `braces` issue reachable only through the ESLint/Next lint toolchain (dev-only) |

## Honest limitations and gaps (Milestone 3)

1. **Fictional data only.** The orders fixtures (`tests/fixtures/modeling`) are invented, as are the rate card, rules and zone chart they are priced against. No real customer orders export has been imported, and no result has been checked against a real invoice. Until that happens, modeling output demonstrates mechanics, not prices.
2. **The page must stay open while a model runs.** Runs are driven by the browser calling a time-boxed server action in a loop (durable cursor in the database, idempotent windows, resume after reload or network loss, pause detection after two minutes without progress). There is **no background worker**: closing the tab pauses the run until it is reopened; a 20,000-order file takes on the order of a few minutes of open page. The batch core is written so a worker (cron or queue) can call it without changing the pricing path; that is the production step planned for Milestone 9.
3. **Scale was measured, not driven end to end.** Engine throughput is 0.61 ms per shipment in the unit test; the database functions and the fold are tested on small sets; the browser journey runs a 24-order file. A real 20,000-order run in a browser has not been exercised.
4. **No manual forecasting yet.** Modeling without an orders file (volume, weight and destination assumptions) is deferred to Milestone 4, where it will share the assumptions UI with fulfillment fees.
5. **Order-file formats** are detected heuristically (generic, Shopify, ShipHero-style). Other WMS exports fall back to manual column mapping in the wizard; multi-sheet workbooks use the first sheet that looks like orders. Only US destinations are modeled; international rows are excluded with a reason. Multi-package shipments need a package/shipment column or one row per package.
6. **Product weights** are a flat per-SKU list (weight and optional dimensions) applied as one package per shipment summed over line units; kitting, cartonisation and multi-box rules are not modelled, and the result says every such weight is an assumption.
7. **Results are kept indefinitely** and files are stored as bytes in PostgreSQL under RLS (15 MB cap). No retention policy, malware scanning or object storage yet.
8. **Rate limits** (per user, per hour, PostgreSQL-backed): 30 uploads, 20 preparations, 60 run starts, 3,000 batch calls, 120 scenario saves; calculator 600.
9. **Adversarial code review was run and acted on.** Three reviewers (authorization, data-path correctness, customer UX/honesty) produced 81 findings, each checked by a skeptic. The confirmed ones were fixed in this milestone with tests, among them: a brand could read a 3PL's not-yet-shared order file through the file table and drive or discard private datasets through the lifecycle functions; the customer calculator's "compare all services" view rendered the staff view (rule keys, ids, verification badges); engine explanations and warnings carried rule keys and version numbers; sharing a prepared orders file was impossible and the sharing flags were brand-writable; a stale partial summary from a concurrent caller could wedge a run; the saved mapping silently dropped the Shopify "requires shipping" column so gift-card orders were priced; product weights were capped at 1,000 rows by the Data API; the template's own layout produced a phantom weightless package; decimal-comma weights were read tenfold; orders with nothing to ship vanished from the exclusions; the results table and CSV showed the pricing date as the ship date and priced-but-excluded rows as part of the totals; a run with no modeled orders showed "$0.00"; the progress loop died silently when a request failed; several copy and phone-layout problems. Three findings were deliberately not built as proposed and are listed under *Design decisions*. Not addressed in this milestone: a count of shipments outside the active rate windows in the run pre-flight (the result lists them afterwards), and running the modeling pages under the iPhone and axe suites of the other specs (the modeling spec now runs its own phone/axe checks on the customer pages; the 3PL on-behalf pages are not covered).
10. **Subagent budget.** Part of the planned fan-out (an independent golden dataset for the bulk summary derived by a second agent) was cut short when the subagent budget ran out mid-milestone; the fold tests were written by one agent with hand-derived expectations and reviewed, not independently re-derived. The engine's own golden dataset is unaffected.
11. Milestone 1–2 limitations still apply: not exercised against hosted Supabase; email delivery untested on a real provider; no real iPhone testing; no CSP; no MFA/SSO; no CI workflow committed; no tenant export/deletion; rate cards weight-bracketed only; metric units and non-US destinations unsupported by the engine.

## Design decisions made in Milestone 3 (say so if you disagree)

* **A modeled order is one that is not cancelled and every one of whose shipments priced.** Averages are per modeled order; coverage states what share of the file that is; cancelled and unpriceable orders are counted by reason, never silently excluded from the denominator.
* **Exposure is never averaged.** Conditional charges ("may be added after shipping") and unresolved amounts are shown as "up to" totals and counts, never folded into the average cost per order.
* **Defaults are assumptions and say so.** A residential default, a default origin ZIP or a product weight make the dependent charges *estimates* and the run reports how many shipments relied on each.
* **Pricing basis is explicit**: at today's rates (one as-of date for the whole file) or at each shipment's ship date; runs pin the exact versions used per ship date.
* **Trusted figures are recomputed in SQL.** The headline totals and counts a customer sees come from the stored results, not from a summary the client sent.
* **Staff-prepared models are private until shared.** A 3PL can prepare and iterate on a customer's behalf; the customer sees nothing until *Share with customer*.
* **Brand-facing output carries no 3PL internals**: fixed label for the rule set, codes and ids only in storage, names and plain language in the UI and CSV, whoever ran the model.
* **Rejected review finding:** storing the full engine line explanations per shipment; lines are re-derived from the dictionary and codes on demand, which keeps a 20,000-shipment run small and reproducible.
* **Rejected review finding:** moving the batch writer behind a service-role credential now. The app deliberately holds no credential a signed-in user lacks (every query runs under the user's own JWT), so `advance_simulation_run` is callable by the user. What it accepts is now tightly checked (own rows only, exact windows, reconciled totals); a server-side worker credential is planned for Milestone 9 and SECURITY.md states the gap.
* **Rejected review finding:** stripping rule keys and version ids from the stored run dictionary. They are identifiers, not notes; keeping them is what makes a run reproducible for the 3PL. The data a customer must never see (source notes, exception references, verification vocabulary) is removed at the source instead.
* **A per-line, per-unit grams column (Shopify "Lineitem grams") is not a package weight** and is no longer mapped as one; such files are priced from product weights.

## Milestone 2: what exists (unchanged)

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
| Brand portal pricing pages | Built in Milestone 3 (see above) | e2e |

## Honest limitations and gaps (Milestone 2, still current unless superseded above)

1. **Fictional data only.** The golden dataset, fixture rate card, zone chart, rules and ZIP lists in `tests/fixtures/pricing` are invented for testing and labelled so. No real customer-facing rate card, carrier surcharge guide or zone chart has been imported or priced. Until that happens, calculator output must be treated as a demonstration of mechanics, not of prices.
2. **Rate cards are weight-bracketed only.** Volume-tiered products (e.g. USPS Cubic) and packaging-keyed rows (flat-rate boxes) are out of scope by decision; the importer would mis-read such sheets as weight brackets, so they must not be imported until a `bracket_basis` is added.
3. **Zone charts come from the 3PL.** The app ships no carrier zone data. A card without a zone chart for a carrier can still be priced by entering the zone directly.
4. **Platform-scope (carrier-verified) rules** can only be inserted with the service role today; the review/approval workflow is Milestone 8. Tenant rules must state a source reference and are marked `3pl_approved`, never "carrier-verified".
5. **Carrier adapters hold structure only** (rounding, measurement, category order, known exclusive groups) offered as defaults the 3PL must verify; no amounts, divisors or ZIP lists are shipped.
6. **Uploads** are stored as bytes in PostgreSQL under RLS (5 MB cap for pricing files, content sniffing, row/cell caps). No malware scanning and no object storage yet.
7. **Calculator rate limit** is 600 runs per user per hour (PostgreSQL-backed).
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
* **Real data for validation**: to move the engine from "mechanically verified" to "validated", I need at least one real customer-facing rate card (with the DIM/rounding terms you give customers), the surcharge schedule you bill from (with its source), a zone chart, and one anonymised customer orders export with the invoice it produced. I will not invent these.
* **Background worker for runs**: client-driven today (see limitation 2). Say whether you want a Vercel cron / queue worker added before Milestone 9.

## Credentials needed

None for Milestones 1–3. Milestone 4 needs none. Stripe keys are first needed in Milestone 7.

## Next: Milestone 4: fulfillment processing engine

3PL fulfillment pricing (pick/pack per order and per unit, packaging, receiving, storage, returns, minimums, custom fees) as versioned schedules; all-in cost per order (shipping + processing) in the bulk model and the calculator; manual forecasting from assumptions (volume, weight profile, destinations, packaging) carried over from Milestone 3. Requires **no external credentials**.

## Milestone 1 (unchanged, summary)

Next.js 16 / React 19 / strict TypeScript / Tailwind 4 design system and responsive shell with iPhone-safe bottom navigation; Supabase Auth sign-up/confirm/sign-in/reset with HttpOnly cookies and server-validated sessions; 3PL onboarding; five roles with permissions mirrored in TypeScript and SQL (parity-tested); customers (brands), invitations, memberships with last-admin protection; RLS on every table, column-scoped grants, append-only trigger-written audit; platform admin console without tenant-data access; durable rate limiting; PWA manifest, icons, minimal service worker and offline page. Verified by unit, DB (real PostgreSQL + GoTrue schema) and Playwright tests. See git history for the original Milestone 1 report.
