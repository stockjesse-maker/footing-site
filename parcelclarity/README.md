# ParcelClarity

> Know what fulfillment and shipping will cost before you ship.

ParcelClarity is a two-sided SaaS for third-party logistics providers (3PLs) and their ecommerce brand customers. A 3PL uploads its own **customer-facing** rate cards and fulfillment pricing; its brands get secure logins to model shipping and fulfillment cost per order. It never uses carrier buy rates.

**Status: Milestones 1–3 of 9 are complete** (foundation, authentication, multi-tenant authorization, app shell; rate-card import, versioning, surcharge rules, customer exceptions and a deterministic pricing engine; the customer portal's single-shipment calculator, order-file bulk modeling with resumable runs, saved scenarios and comparisons, and the 3PL's "model on behalf of a customer" view). Fulfillment fees, adjustment risk, PDF reports, billing and carrier intelligence are **not built yet**, and the engine has only been validated on fictional data. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for the honest, current picture.

> This app lives in the `parcelclarity/` folder of the repository. The repository root still holds an unrelated static website (GitHub Pages); nothing here touches it.

## Documentation

| Document | Contents |
|---|---|
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | What is done, what is not, what was verified and how |
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | Functional requirements and non-negotiable rules |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, module boundaries, request flow |
| [DATABASE.md](DATABASE.md) | Schema, roles, permissions, RLS policies |
| [PRICING_ENGINE.md](PRICING_ENGINE.md) | Calculation pipeline, precedence rules, import pipeline, what the engine does not do |
| [SECURITY.md](SECURITY.md) | Tenant isolation model, controls, known gaps |
| [TESTING.md](TESTING.md) | Test strategy and how to run everything |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Supabase + Vercel setup, email templates, production checklist |

## Requirements

* Node.js 22+ and npm
* A Supabase project (hosted) **or** the local stack below
* Optional: a [Resend](https://resend.com) API key for invitation email (otherwise the inviter is shown a link to share)

## Quick start (hosted Supabase)

```bash
cd parcelclarity
npm install
cp .env.example .env.local        # fill in the three NEXT_PUBLIC_* values
# Apply supabase/migrations/*.sql to your project (see DEPLOYMENT.md)
npm run dev                        # http://localhost:3000
```

## Quick start (local, with Docker)

```bash
npx supabase start                 # applies supabase/migrations automatically
# copy the API URL and anon key it prints into .env.local
npm run dev
```

`supabase start` has **not** been exercised in this repository's CI/sandbox (no Docker was available). The Docker-free stack below is what the automated tests actually ran against.

## Quick start (local, no Docker)

A Docker-free stack runs PostgreSQL 16, Supabase Auth (GoTrue), PostgREST, a one-port gateway and an SMTP sink that captures outgoing mail to files. It exists so every test in this repo can run in a plain Linux box.

```bash
# One-time: needs Go >= 1.24, PostgreSQL 16 server binaries, curl, xz
bash scripts/local-stack/install.sh          # fetches PostgREST, builds Supabase Auth
npm run stack:up                              # starts everything, writes the env file it prints
cp /var/lib/parcelclarity-stack/env .env.local   # path is printed by stack:up
npm run dev
npm run stack:down                            # stop (data kept); `bash scripts/local-stack/up.sh --reset` wipes it
```

Local mail lands in `<stack dir>/mail/*.eml` (no real email is ever sent).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development / production build / serve |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` (strict) |
| `npm test` | Unit tests incl. the pricing-engine golden dataset, order-file import and bulk summaries (no services needed) |
| `npx tsx tests/fixtures/pricing/generate.mts` | Regenerates the fictional fixture rate card used by the golden tests |
| `npm run test:db` | Authorization/RLS tests against real PostgreSQL + Supabase Auth schema (needs `stack:up`) |
| `npm run test:e2e` | Playwright against the built app (needs `stack:up`) |
| `npm run audit` | `npm audit` for production dependencies |

Playwright needs a Chromium. If `playwright install` can't run, set `PC_CHROMIUM_PATH=/path/to/chromium`.

## Making a platform administrator

Platform administrators are created out-of-band (never through the app):

```sql
insert into public.platform_admins (user_id) select id from auth.users where email = 'you@example.com';
```

## Project layout

```
src/app/            routes: (auth) pages, (tenant)/app = 3PL portal, (brand)/portal = customer portal, platform
src/app/actions/    Server Actions (validated with Zod, authorized server-side, RLS-backed)
src/components/     ui/ design system, forms/, shell/, team/, pricing/ (rate cards, rules, calculator), modeling/ (order files, runs, results)
src/engine/         pure pricing engine (no framework imports; see PRICING_ENGINE.md); engine/modeling folds bulk results
src/lib/auth/       roles/permissions, session + data-access layer, validation
src/lib/import/     spreadsheet parsing, rate-card mapping detection and validation (pure)
src/lib/orders/     order-file detection, mapping, validation and row materialisation (pure)
src/lib/modeling/   batch run core (time-boxed, resumable), list queries, page context for brand and on-behalf views
src/lib/pricing/    loads a rate card + rules from the database into the engine's context (with a per-run cache)
src/lib/supabase/   server client (user JWT only), session proxy helper
src/proxy.ts        session refresh + optimistic redirect (NOT an authorization boundary)
supabase/migrations SQL migrations (schema, RLS, functions)
tests/              unit/, db/ (RLS), e2e/ (Playwright), fixtures/pricing (fictional golden dataset), fixtures/modeling (order files)
scripts/local-stack Docker-free Supabase-compatible stack
```
