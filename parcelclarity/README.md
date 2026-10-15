# ParcelClarity

> Know what fulfillment and shipping will cost before you ship.

ParcelClarity is a two-sided SaaS for third-party logistics providers (3PLs) and their ecommerce brand customers. A 3PL uploads its own **customer-facing** rate cards and fulfillment pricing; its brands get secure logins to model shipping and fulfillment cost per order. It never uses carrier buy rates.

**Status: Milestone 1 of 9 is complete** (foundation, authentication, multi-tenant authorization, app shell). The pricing engine, rate cards, simulators, billing and reports are **not built yet**. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for the honest, current picture.

> This app lives in the `parcelclarity/` folder of the repository. The repository root still holds an unrelated static website (GitHub Pages); nothing here touches it.

## Documentation

| Document | Contents |
|---|---|
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | What is done, what is not, what was verified and how |
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | Functional requirements and non-negotiable rules |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, module boundaries, request flow |
| [DATABASE.md](DATABASE.md) | Schema, roles, permissions, RLS policies |
| [PRICING_ENGINE.md](PRICING_ENGINE.md) | Calculation design (formulas, precedence); engine not yet implemented |
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
| `npm test` | Unit tests (no services needed) |
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
src/components/     ui/ design system, forms/, shell/, team/
src/lib/auth/       roles/permissions, session + data-access layer, validation
src/lib/supabase/   server client (user JWT only), session proxy helper
src/proxy.ts        session refresh + optimistic redirect (NOT an authorization boundary)
supabase/migrations SQL migrations (schema, RLS, functions)
tests/              unit/, db/ (RLS), e2e/ (Playwright)
scripts/local-stack Docker-free Supabase-compatible stack
```
