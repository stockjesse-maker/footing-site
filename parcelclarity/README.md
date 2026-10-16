# ParcelClarity

> Know what fulfillment and shipping will cost before you ship.

ParcelClarity is a two-sided SaaS for third-party logistics providers (3PLs) and their ecommerce brand customers. A 3PL uploads its own **customer-facing** rate cards and fulfillment pricing; its brands get secure logins to model shipping and fulfillment cost per order. It never uses carrier buy rates.

**Status: Milestones 1–4 of 9 are complete** (foundation, authentication, multi-tenant authorization, app shell; rate-card import, versioning, surcharge rules, customer exceptions and a deterministic pricing engine; the customer portal's single-shipment calculator, order-file bulk modeling with resumable runs, saved scenarios and comparisons, and the 3PL's "model on behalf of a customer" view; and, in Milestone 4, versioned fulfillment fee schedules, fees in the calculator and in bulk runs, monthly charges and account minimums, all-in cost per order, and forecasts from assumptions). Adjustment risk, PDF reports, billing and carrier intelligence are **not built yet**; the engines have only been validated on fictional data, and the browser (Playwright) tests of Milestone 4 run on fictional data with an emulated phone, not a real device. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for the honest, current picture.

> This app lives in the `parcelclarity/` folder of the repository. The repository root still holds an unrelated static website (GitHub Pages); nothing here touches it.

## Documentation

| Document | Contents |
|---|---|
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | What is done, what is not, what was verified and how |
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | Functional requirements and non-negotiable rules |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, module boundaries, request flow |
| [DATABASE.md](DATABASE.md) | Schema, roles, permissions, RLS policies |
| [PRICING_ENGINE.md](PRICING_ENGINE.md) | Calculation pipeline, precedence rules, import pipeline, the fulfillment fee engine and forecasts, what the engines do not do |
| [SECURITY.md](SECURITY.md) | Tenant isolation model, controls, known gaps |
| [TESTING.md](TESTING.md) | Test strategy and how to run everything |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Supabase + Vercel setup, email templates, production checklist |

## What it does today

**3PL (tenant) portal**

* Sign up, manage customers (brands) and staff with five roles; every table is protected by Row Level Security.
* Rate cards: import a customer-facing rate card (CSV/XLSX), review the detected mapping and validation, set per-service terms, upload zone charts, activate versions with effective dates, author surcharge rules with sources, set per-customer exceptions, assign cards to customers.
* **Fee schedules (Milestone 4):** author the fulfillment charges you make to customers (pick and pack, packaging, kitting, labeling, receiving, storage, returns, account fees, account minimums) as versioned rules with effective dates; try an order against any version; assign a schedule to each customer.
* Price a shipment, with or without what is in the box, on a customer's behalf; model a customer's orders file or forecast for them (private until shared).

**Customer (brand) portal**

* Price one shipment on the assigned rate card, and see order fees for what is in the box when a fee schedule is in effect.
* Upload an orders export, fix the mapping, answer the fulfillment questions generated from the fee schedule, run the whole file, and read shipping, order fees, monthly charges, the account minimum and the all-in cost per order, each labelled as definite, based on assumptions or not computed; download shipment, per-order and monthly CSVs; compare models.
* **Forecast from assumptions (Milestone 4):** model volume, parcel, zone and service mixes and typical orders without an orders file.
* See the fee schedule the 3PL assigned ("Your fee schedule").

All of it is validated on **fictional** data only. Estimates are never invoices. The tool never uses carrier buy rates.

## Setting up fees for a customer (3PL)

Fee schedules need no external credentials. Sign in to the 3PL portal with a role that has `ratecard.manage` (3PL administrator); a 3PL employee can read schedules.

1. **Create the schedule.** *Fee schedules* → *New fee schedule*. The name and description are shown to customers; choose how amounts are rounded (*Invoice line*, the recommended default: add up exactly and round to the cent once per charge; or *Transaction*: round the fee on every order to the cent). Rounding can be changed again while a version is a draft.
2. **Add rules to the draft (version 1).** Start from a preset (first pick included, additional units, per line, additional packages, percent of shipping, monthly storage per pallet, long-term storage, receiving per pallet, returns per order, account minimum, flat monthly fee) or from scratch. Each rule reads back in the customer's words as you type. Optionally add a staff-only source reference to a rule and a staff-only note to the version; customers never see either. Read *What fee schedules cannot model yet* before you start: those charges must be quoted outside the tool.
3. **Try an order.** Price one typed order on the draft (items, lines, packaging, shipping) and check every line before a customer sees it.
4. **Activate** the version with an effective date (and an optional end date). Activation checks the version as a whole (for example that account minimums count different charges) and freezes it: an active version's rules never change.
5. **Assign** the schedule to a customer on the customer's page. A customer is on one schedule at a time; moving a customer ends the old assignment. The customer's cost models, calculator and forecasts then price fees from it, and the customer sees it under *Your fee schedule*.
6. **To change prices**, make a new draft as a copy of the active version, edit it, end the old version on a date and activate the new one from the next day (two active versions cannot overlap). Runs already priced keep the version they used and say so.

A customer with no fee schedule, or whose schedule has nothing in effect on a date, gets shipping-only figures with a plain statement that no fee schedule applied, never a $0 fee.

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
| `npm test` | Unit tests incl. the pricing-engine golden dataset, order-file import, bulk summaries, the fee engine and forecast golden sets (no services needed) |
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
src/components/     ui/ design system, forms/, shell/, team/, pricing/ (rate cards, rules, calculator), modeling/ (order files, runs, results, fulfillment step), fees/ (fee-schedule editor and customer view), forecast/ (forecast form and results)
src/engine/         pure pricing engine (no framework imports; see PRICING_ENGINE.md); engine/modeling folds bulk results, engine/fees prices fulfillment fees, engine/forecast evaluates forecasts
src/lib/auth/       roles/permissions, session + data-access layer, validation
src/lib/import/     spreadsheet parsing, rate-card mapping detection and validation (pure)
src/lib/orders/     order-file detection, mapping, validation and row materialisation (pure)
src/lib/modeling/   batch run core (time-boxed, resumable, with fees), run assumptions, the headline function, list queries, page context for brand and on-behalf views
src/lib/fees/       fee-schedule read models and the rule/answer schemas shared by the editor, actions and tests
src/lib/forecast/   forecast read models, zones, assumptions hashing
src/lib/pricing/    loads a rate card + rules from the database into the engine's context (with a per-run cache)
src/lib/supabase/   server client (user JWT only), session proxy helper
src/proxy.ts        session refresh + optimistic redirect (NOT an authorization boundary)
supabase/migrations SQL migrations (schema, RLS, functions)
tests/              unit/, db/ (RLS), e2e/ (Playwright), fixtures/pricing (fictional golden dataset), fixtures/modeling (order files), fixtures/fees and fixtures/forecast (fictional fee and forecast golden sets)
scripts/local-stack Docker-free Supabase-compatible stack
```
