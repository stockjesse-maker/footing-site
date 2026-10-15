# Testing

Principle: a feature is not "done" until a test that could fail has passed. Authorization is tested at the layer that enforces it (PostgreSQL), and the user journeys are tested end to end against the real auth stack.

## Layers

| Layer | Location | Needs | What it proves |
|---|---|---|---|
| Unit (279 tests) | `tests/unit` | nothing | Pricing engine: 32-scenario golden dataset (`engine-golden`), dimensional weight and rounding (`engine-dim`), zones/brackets/unavailable paths (`engine-rates-zones`), surcharge semantics (`engine-surcharges`), money and validation (`engine-money`), adversarial review suites (`engine-numerics-review`, `engine-semantics-review`); import pipeline; permission model, `safeNext`, validation schemas |
| Database / authorization (114 tests) | `tests/db` | local stack Postgres + GoTrue binary | RLS and grants for every role, privilege escalation attempts, invitation lifecycle, status lifecycle, audit integrity, integrity constraints, rate limiting, TS↔SQL permission parity; pricing: card/version/rule/ZIP-list lifecycles, brand visibility (assignment, active version, allowed services, suspension), cross-tenant and cross-brand denial, overlap constraints, file access, audit of pricing events |
| End to end (22 tests) | `tests/e2e` | local stack + built app + Chromium | Sign-up/confirm/reset by real emails, onboarding, customer + invitation flows, URL-manipulation isolation, suspension, platform console, token-hash links, axe accessibility, iPhone-emulated layout/PWA; rate-card import → terms → zone chart → activation → rule → calculator, assignment, cross-tenant URL denial, honest import failure (`pricing.spec.ts`) |

## Running

```bash
npm run stack:up                       # PostgreSQL + Auth + PostgREST + SMTP sink (see README)
cp /var/lib/parcelclarity-stack/env .env.local
npm run typecheck && npm run lint
npm test                               # unit
npm run test:db                        # authorization / RLS
npm run test:e2e                       # builds + starts the app, then Playwright
```

If Playwright's own browser can't be installed: `PC_CHROMIUM_PATH=/path/to/chromium npm run test:e2e`. Tests that mint recovery tokens read `SUPABASE_SERVICE_ROLE_KEY` from the environment (`set -a; . ./.env.local; set +a`).

## How the database tests work

`tests/db/global-setup.ts` creates a fresh throwaway database, installs the **real** Supabase Auth schema by running GoTrue's migrations, applies every file in `supabase/migrations/`, and drops the database afterwards. Tests then act as specific users with `set local role authenticated` plus `request.jwt.claims`, the same mechanism PostgREST uses, and never as superuser except to create fixtures or assert resulting state. `tests/db/world.ts` builds two tenants, three brands and a user for every role through the real invitation flow.

Every denial is asserted by its reason (`permission denied`, `row-level security`, named constraint/trigger message), so a test cannot pass because of an unrelated failure.

## Coverage map for the spec's authorization requirements

* Cross-tenant / cross-brand by ID, API parameter and URL manipulation: `isolation.test.ts`, `pricing.test.ts`, `flows.spec.ts`, `pricing.spec.ts`
* Brand visibility of pricing (assigned cards only, active version only, allowed services only, own overrides only): `pricing.test.ts`
* Uploaded-file access (database-stored, manager-only): `pricing.test.ts`; storage-path manipulation: not applicable yet (no object storage until Milestone 3)
* Role escalation, invitation abuse: `privileges.test.ts`, `invitations.test.ts`
* Platform admin confidentiality: `isolation.test.ts`, `privileges.test.ts`, `flows.spec.ts`
* Audit append-only and unforgeable: `audit.test.ts`

## Not yet covered (see IMPLEMENTATION_STATUS.md)

Validation against real (non-fictional) rate cards and carrier documents, order-file simulation tests (Milestone 3), Stripe webhook/entitlement tests (7), load/performance tests (9), real-iPhone Safari testing, manual accessibility review, restore-from-backup drill.

## CI recommendation

On every PR: `npm ci`, typecheck, lint, `npm test`, `npm run audit`. On main/nightly: provision Postgres 16 + Go, run `scripts/local-stack/install.sh` and `npm run stack:up`, then `test:db` and `test:e2e`. (Or use `supabase start` where Docker is available.) No workflow file is committed yet.

## Writing new tests

* New table → add isolation tests for every role in `world.ts` **in the same change** as the migration.
* New permission → update `src/lib/auth/permissions.ts` and the migration; the parity test fails otherwise.
* Never assert a denial without asserting why.
* Engine behaviour → add a scenario to `tests/fixtures/pricing/scenarios.json` and derive its expectation by hand (or independently of the engine) into `expected.json`; never paste engine output into `expected.json`.
