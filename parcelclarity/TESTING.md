# Testing

Principle: a feature is not "done" until a test that could fail has passed. Authorization is tested at the layer that enforces it (PostgreSQL), and the user journeys are tested end to end against the real auth stack.

## Layers

| Layer | Location | Needs | What it proves |
|---|---|---|---|
| Unit (1,075 tests in 36 files) | `tests/unit` | nothing | Pricing engine: 32-scenario golden dataset (`engine-golden`), dimensional weight and rounding (`engine-dim`), zones/brackets/unavailable paths (`engine-rates-zones`), surcharge semantics (`engine-surcharges`), money and validation (`engine-money`), adversarial review suites (`engine-numerics-review`, `engine-semantics-review`), throughput guard (`engine-throughput`); rate-card import pipeline; order-file detection/mapping/validation on generic, Shopify and ShipHero fixtures (`orders-import`); bulk fold and summary with hand-derived expectations (`modeling-fold`); permission model, `safeNext`, validation schemas. **Milestone 4:** the fee engine against the hand-derived golden set (`fees-golden`, 35 scenarios), the fee-rule and answer schemas that mirror the SQL validators (`fees-schema`), the fold v2, summary finalisation and order-content apportionment (`modeling-fold`, `modeling-finalize`, `modeling-fee-input`), run assumptions and the fulfillment step's model (`modeling-assumptions`), the headline function, comparison and CSV builders (`modeling-headline`), the run, hub, overview and compare pages and the orders/monthly CSV routes against a fake client (`modeling-results`), the forecast engine with its golden grid and properties (`forecast-golden`, `forecast`), forecast zones, queries, actions, form model and views (`forecast-zones`, `forecast-queries`, `forecast-actions`, `forecast-ui`, `forecast-views`), the fee-schedule editor model, customer view and standing logic (`fees-ui`, `fees-ui-render`, `fees-queries-standing`) and the calculator's "what's in the box" block (`calculator-fees`); from the final sweep: the lists' lean select, the rebuilt headline inputs against the whole summary for 15 kinds of run, the minimum member naming and the rule that no React key is a rule key (`modeling-lean-lists`), the day run setup takes its questions from and the action that reads another day's (`modeling-setup-date`), and the forecast page's headline against the lists' (`forecast-headline-parity`) |
| Database / authorization (151 tests in 9 files) | `tests/db` | local stack Postgres + GoTrue binary | RLS and grants for every role, privilege escalation attempts, invitation lifecycle, status lifecycle, audit integrity, integrity constraints, rate limiting, TS↔SQL permission parity; pricing: card/version/rule/ZIP-list lifecycles, brand visibility (assignment, active version, allowed services, suspension), cross-tenant and cross-brand denial, overlap constraints, file access, audit of pricing events; modeling (`modeling.test.ts`): dataset materialise/finalize/discard, staff-private datasets and scenarios until shared, cross-brand and cross-tenant denial, scenario insert requires an assigned card, run start/batch/advance idempotency, finish reconciliation refusing a wrong summary, cancel, single-shipment saves, brand-safe RPC payloads, audit rows; fee schedules, runs with fees and forecasts (`fees.test.ts`, 22 tests): lifecycle and validity (rule validators, activation, freezing, copy, end/archive), assignment and visibility for staff, assigned brand, unassigned brand, other tenant, outsider and platform administrator with sentinel strings in sources and notes, trigger-written audit, one overload per public function, the forecast period and volume, start-run validation (`PC001`), advance refusals (`PC002`/`PC003`), finish recomputation of processing totals, monthly lines, minimum top-ups and the projected monthly total, ship-date runs across a price change, skipped fulfillment, forecast saves and their identities |
| End to end (54 tests: 48 desktop, 6 iPhone-emulated) | `tests/e2e` | local stack + built app + Chromium | Sign-up/confirm/reset by real emails, onboarding, customer + invitation flows, URL-manipulation isolation, suspension, platform console, token-hash links, axe accessibility, iPhone-emulated layout/PWA; rate-card import → terms → zone chart → activation → rule → calculator, assignment, cross-tenant URL denial, honest import failure (`pricing.spec.ts`); customer calculator (comparison view and single service, no 3PL internals) and saved scenario, order-file upload → mapping → run → results → CSV export, the 3PL modeling on behalf with a private-until-shared scenario, a second brand and a second 3PL denied by URL, and the customer's modeling pages on an emulated iPhone with axe (`modeling.spec.ts`). **Milestone 4** (`fees.spec.ts`, 22 serial desktop tests, fictional data): the 3PL builds a fee schedule rule by rule, tries an order, activates it and assigns it; the customer uploads the fixture, answers the fulfillment questions (a number, "not sure", "we don't use this"), is refused a blank or impossible answer, runs the model, reads the completeness label, the parts, order fees, monthly charges, the account minimum and what is not included, switches views, downloads `orders.csv` and `monthly.csv`, reruns with receiving answered, changes the date in step 1 and gets that date's questions, builds a forecast (errors named, a missing answer "at least", the full forecast checked by hand), edits it as a new forecast, compares it with the file run; the 3PL sees and prepares a run on the customer's behalf; nothing the 3PL wrote for its own eyes (keys, group names, notes, sources) reaches any customer page source or export; another customer and another 3PL are refused by URL; the calculator's box; a clean one-week file with a stated volume; axe on every new screen. `mobile.spec.ts` adds three iPhone-emulated tests (run setup step 2, run results in all three views, fee-schedule pages, the forecast form and results, the calculator, the editor and dialogs, the nine-tab admin bar: no sideways scroll, 16 px inputs, 44 px targets). `screen-checks.ts` holds the shared axe and phone-layout helpers |

## Running

```bash
npm run stack:up                       # PostgreSQL + Auth + PostgREST + SMTP sink (see README)
cp /var/lib/parcelclarity-stack/env .env.local
npm run typecheck && npm run lint
npm test                               # unit: npx vitest run --project unit
npm run test:db                        # authorization / RLS: needs the stack's environment (below)
npm run test:e2e                       # builds + starts the app, then Playwright
```

How to run each suite:

* **Unit** (`npx vitest run --project unit`, about 11 s): needs nothing. One file: `npx vitest run --project unit tests/unit/fees-golden.test.ts`.
* **Database** (`set -a; . ./.env.local; set +a; npx vitest run --project db`, about 5 s): needs PostgreSQL at `PC_PG_HOST:PC_PG_PORT` (default `127.0.0.1:54322`; `npm run stack:up` starts it) and the GoTrue binary (`PC_GOTRUE_BIN`, default `/opt/pc-stack/bin/gotrue`). The global setup creates a throwaway database, runs GoTrue's migrations and every file in `supabase/migrations`, and drops the database afterwards; sourcing `.env.local` loads the stack's environment. One file: `npx vitest run --project db tests/db/fees.test.ts`.
* **End to end** (`npm run test:e2e`): builds and serves the app on the stack, or reuses a server already listening on port 3000 (then it serves whatever build that server loaded: rebuild and restart it after a code change, or the run says nothing about the change). It owns the server and the `.next` build, so do not run a build or a second server beside it. `fees.spec.ts` writes the ids `mobile.spec.ts` needs to `tests/e2e/.state/fees.json` (git-ignored); the desktop project runs first, so a full run is fine, but `mobile.spec.ts` alone needs a prior `fees.spec.ts` run.

Measured at the end of Milestone 4 (after the final sweep): `tsc --noEmit` and `eslint .` clean; unit 1,075 of 1,075 passing (36 files); database 151 of 151 passing (9 files); end to end 54 of 54 passing (48 desktop, 6 iPhone-emulated); `next build` passes; `npm audit --omit=dev --audit-level=high` finds 0 vulnerabilities.

If Playwright's own browser can't be installed: `PC_CHROMIUM_PATH=/path/to/chromium npm run test:e2e`. Tests that mint recovery tokens read `SUPABASE_SERVICE_ROLE_KEY` from the environment (`set -a; . ./.env.local; set +a`).

## How the database tests work

`tests/db/global-setup.ts` creates a fresh throwaway database, installs the **real** Supabase Auth schema by running GoTrue's migrations, applies every file in `supabase/migrations/`, and drops the database afterwards. Tests then act as specific users with `set local role authenticated` plus `request.jwt.claims`, the same mechanism PostgREST uses, and never as superuser except to create fixtures or assert resulting state. `tests/db/world.ts` builds two tenants, three brands and a user for every role through the real invitation flow.

Every denial is asserted by its reason (`permission denied`, `row-level security`, named constraint/trigger message), so a test cannot pass because of an unrelated failure.

## Coverage map for the spec's authorization requirements

* Cross-tenant / cross-brand by ID, API parameter and URL manipulation: `isolation.test.ts`, `pricing.test.ts`, `flows.spec.ts`, `pricing.spec.ts`
* Brand visibility of pricing (assigned cards only, active version only, allowed services only, own overrides only): `pricing.test.ts`
* Uploaded-file access (database-stored; pricing files manager-only, order files per brand): `pricing.test.ts`, `modeling.test.ts`; storage-path manipulation: not applicable (no object storage yet)
* Brand visibility of modeling data (own datasets, rows, results, scenarios; staff-private until shared; assigned cards only): `modeling.test.ts`, `modeling.spec.ts`
* Trusted totals (a client cannot write a summary the stored rows do not support): `modeling.test.ts`
* Role escalation, invitation abuse: `privileges.test.ts`, `invitations.test.ts`
* Platform admin confidentiality: `isolation.test.ts`, `privileges.test.ts`, `flows.spec.ts`
* Audit append-only and unforgeable: `audit.test.ts`
* Brand visibility of fee schedules (assigned schedule only, active and archived versions only, never a draft, source or note; other brand, tenant, outsider and platform administrator see nothing): `fees.test.ts`; the customer's fee-schedule view prints no key, id, version number, source or note: `fees-ui.test.ts`
* Fee schedule immutability and activation checks (frozen rules, sources and notes, no overlapping active versions, minimum sets resolved and disjoint): `fees.test.ts`
* Trusted run figures with fees (order results agree with the file and the fee contexts; processing totals, monthly lines, minimum top-ups and the projected monthly total recomputed; forecast identities): `fees.test.ts`
* Brand-safe fee output (no rule keys, ids or version numbers in the run page, calculator, forecast payloads, CSV rows): `modeling-results.test.ts`, `calculator-fees.test.ts`, `forecast-actions.test.ts`, `forecast-ui.test.ts`
* Hand-derived fee and forecast arithmetic: `fees-golden.test.ts`, `forecast-golden.test.ts`

## Not yet covered (see IMPLEMENTATION_STATUS.md)

Validation against real (non-fictional) rate cards, fee schedules and carrier documents, a bulk run at the 20,000-order scale in a browser (the engine throughput and the batch loop are measured in unit and database tests; the e2e run is 24 orders), Stripe webhook/entitlement tests (7), load/performance tests (9), real-iPhone Safari testing, manual accessibility review, restore-from-backup drill.

Milestone 4 specifically: the browser journeys the design planned are covered on fictional data (see the end-to-end row), with two limits: the iPhone project is Chromium with an iPhone viewport, touch and user agent (no real iOS Safari run), and the orders file in the browser is 24 rows. Not covered: the client-side refresh of run setup's questions is exercised in a browser but not by a unit test of the hook; the lean select of the lists was run against the small local database only, not timed on 50 large projects. In SQL, the fee arithmetic is covered for flat monthly rules, a long-term replace pair and a graduated monthly-volume rate only; volume and flat-bracket tiers, tiered monthly rules, weekly or daily billing periods, returns rates and per-occurrence minimum charges have no SQL test, and no test compares the SQL functions with the TypeScript engine directly. The exports are exercised against a fake client in unit tests and downloaded in the browser tests, not read from PostgreSQL by a database test.

## CI recommendation

On every PR: `npm ci`, typecheck, lint, `npm test`, `npm run audit`. On main/nightly: provision Postgres 16 + Go, run `scripts/local-stack/install.sh` and `npm run stack:up`, then `test:db` and `test:e2e`. (Or use `supabase start` where Docker is available.) No workflow file is committed yet.

## Writing new tests

* New table → add isolation tests for every role in `world.ts` **in the same change** as the migration.
* New permission → update `src/lib/auth/permissions.ts` and the migration; the parity test fails otherwise.
* Never assert a denial without asserting why.
* Engine behaviour → add a scenario to `tests/fixtures/pricing/scenarios.json` and derive its expectation by hand (or independently of the engine) into `expected.json`; never paste engine output into `expected.json`.
* Order-file behaviour → add rows to `tests/fixtures/modeling/*.csv` and count the expected orders, shipments, packages, lines and issues by hand in `orders-import.test.ts`.
* Fee behaviour → add the rule to `tests/fixtures/fees/RULES.md` first, a scenario to `scenarios.json` (and a schedule to `schedules.json` if needed), and derive the expectation by hand into `expected.json`; never paste engine output there. A rule the SQL also implements (`app.fee_monthly_lines`, tiers, minimums) needs a database test with its own hand-derived figures in `tests/db/fees.test.ts`.
* Forecast behaviour → same method in `tests/fixtures/forecast`, plus a property test (weights sum to the volume, nothing definite, the allocation identity).
* A new function in the `public` schema → keep one overload per name (the signature test in `fees.test.ts` fails otherwise); drop the old overload in the migration.
