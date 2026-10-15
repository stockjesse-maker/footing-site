# Implementation status

_Last updated: end of Milestone 1. This file is the source of truth for what works. Nothing is listed as done unless it was run and verified; "how verified" is stated._

## Milestone checklist

| # | Milestone | Status |
|---|---|---|
| 1 | Project foundation | **Complete** (see below for caveats) |
| 2 | Rate cards and pricing engine | Not started |
| 3 | Customer shipping modeling | Not started |
| 4 | Fulfillment processing engine | Not started |
| 5 | Adjustment-risk module | Not started |
| 6 | Reports and branding | Not started |
| 7 | Billing (Stripe) | Not started |
| 8 | Carrier intelligence | Not started |
| 9 | Production readiness | Not started |

**There is no pricing engine, no rate-card import, no calculator, no PDF generation, no Stripe integration yet.** The brand portal's *Model Costs* and *Reports* pages are honest empty states, and the 3PL portal has no rate-card section; those routes were not built rather than faked.

## Milestone 1: what exists

| Capability | State | How verified |
|---|---|---|
| Next.js 16 (App Router), React 19, strict TypeScript, Tailwind 4 | Done | `tsc --noEmit`, `next build` |
| Design system: tokens, Button/Card/Field/Badge/Alert/Stat/EmptyState/Skeleton/DataList/PageHeader, icons | Done | axe checks, screenshots reviewed, mobile tests |
| Responsive shell: sidebar (desktop), bottom tab bar with safe-area support (phone) | Done | Playwright (desktop + iPhone-14 emulation), screenshots |
| Email/password sign-up, email confirmation, sign-in, sign-out | Done | E2E against real Supabase Auth (GoTrue) |
| Password reset (PKCE link and cross-device token-hash link) | Done | E2E, both routes |
| Session management: refresh in proxy, server-validated `getUser()`, HttpOnly cookies, other sessions revoked on password change | Done | E2E; cookie flags by inspection |
| 3PL workspace creation (self-serve onboarding) | Done | E2E |
| Five roles (platform admin, 3PL admin/employee, brand admin/employee) | Done | DB + unit + E2E |
| Customers (brands): create, list, suspend, reactivate, revoke | Done | DB + E2E |
| Invitations: create, email (Resend, optional), copy-link fallback, accept, revoke, expiry, single-use, email-match | Done (email delivery **not tested**, see below) | DB (invitation lifecycle suite) + E2E |
| Membership management: suspend, reinstate, remove; last-admin protection | Done | DB + E2E |
| Row Level Security on every table; column-scoped grants; no direct writes to memberships | Done | 83 DB tests on real PostgreSQL |
| Platform admin console: list tenants, suspend/restore; **no** access to tenant data | Done | DB + E2E |
| Audit log: trigger-written, append-only, tenant-scoped viewer | Done | DB + E2E |
| Durable per-user rate limiting for authenticated actions | Done | DB |
| PWA: manifest, icons (any + maskable + apple-touch), minimal service worker, offline page | Done | Playwright: manifest/icons/meta served. **Install on a real device not tested.** |
| Tenant and brand dashboards | Done, showing **real counts only** | E2E |

## Verification results (this session)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` (unit) | 34 / 34 pass |
| `npm run test:db` (RLS/authorization, real PostgreSQL 16 + real Supabase Auth schema) | 83 / 83 pass |
| `npm run test:e2e` (Playwright: 12 desktop incl. axe, 3 iPhone-emulated) | 15 / 15 pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm audit` (including dev tooling) | 1 high advisory in `braces` (dev-only, via the eslint-config-next toolchain) |
| `next build` | pass |

## Honest limitations and gaps

1. **Not exercised against hosted Supabase.** Everything ran on a Docker-free local stack: real PostgreSQL 16, Supabase Auth built from `supabase/auth` source (`scripts/local-stack/install.sh`), PostgREST 12.2.3, and a small gateway. That is faithful for SQL, RLS, auth flows and PostgREST behaviour, but it is not Supabase's hosted gateway/Kong, Storage, or its email stack. `supabase start` and `supabase db push` were not run (no Docker, no project). First hosted deploy must re-run the checks in DEPLOYMENT.md.
2. **Invitation and auth email delivery is untested on a real provider.** Locally mail is captured by an SMTP sink. The Resend integration is a ~20-line `fetch` and has never sent a real message. If `RESEND_API_KEY` is unset the UI says so and shows the link to share.
3. **No real iPhone testing.** iPhone behaviour was checked with Chromium device emulation (viewport, touch, UA, 16px inputs, 44px targets, safe-area CSS). Safari-specific behaviour, Add-to-Home-Screen install, and standalone-mode quirks are unverified.
4. **No strict Content-Security-Policy yet** (needs per-request nonces with Next.js). Other security headers are set. Tracked for Milestone 9.
5. **Rate limiting** covers authenticated server actions (PostgreSQL-backed). Sign-in, sign-up and password reset rely on Supabase Auth's own throttling, which must be configured in the hosted project.
6. **Accessibility**: automated axe-core checks (WCAG 2.1 A/AA) pass on the pages listed in `tests/e2e/a11y.spec.ts`. No manual screen-reader or keyboard-flow audit has been done.
7. **Multi-membership users** can switch workspace through a selector, but this path has only the DB-level tests, not a dedicated E2E.
8. **No tenant export/deletion workflow, retention controls, or backup verification** (Milestone 9). `tenants.status = 'pending_deletion'` exists as a placeholder state only.
9. **No CI workflow** is committed. Commands to run in CI are in TESTING.md.
10. **MFA, SSO, and OAuth sign-in** are not implemented.
11. **Storage, file upload, malware scanning, background jobs**: not started (first needed in Milestone 2/3).
12. TypeScript is pinned to 5.9.3 rather than 7.x because Next 16's type checking and the lint toolchain depend on the JavaScript compiler API.

## Decisions that need your confirmation

* **Location**: the app is in `parcelclarity/` because the repository root contains a live static site (`footingdbt.com` via GitHub Pages). If you want ParcelClarity in its own repository, the folder can be moved as-is.
* **Email provider**: Resend was chosen for invitation email (simple REST API). Say so if you prefer Postmark/SES/SMTP.
* **Rate-card file parsing**: for Milestone 2, SheetJS's npm package is stale and has known advisories, so I plan `read-excel-file` (XLSX) + Papa Parse (CSV). Confirm or object before that milestone.

## Next: Milestone 2: rate cards and pricing engine

Pure TypeScript engine in `src/engine` (no framework imports, enforced by ESLint), decimal-safe money, golden tests; rate-card CSV/XLSX import with preview and validation; versioned rate cards and surcharge rules with explicit verification status. Requires **no external credentials**. It does require your **real customer-facing rate card examples and carrier surcharge documents** to build the golden dataset; I will not invent them.
