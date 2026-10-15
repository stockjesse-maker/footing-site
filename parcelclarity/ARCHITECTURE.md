# Architecture

A **modular monolith**: one Next.js application and one PostgreSQL database (Supabase). No microservices.

```
Browser / iPhone PWA
   │  HTTPS
   ▼
Next.js (App Router, Server Components + Server Actions)         Vercel-compatible
   │  src/proxy.ts: refreshes session cookie, optimistic redirect only
   │  src/lib/auth: server-side data-access layer (validates user, resolves membership)
   │  src/app/actions: Zod-validated, permission-checked mutations
   ▼
Supabase (user's JWT on every request)
   ├─ Auth (GoTrue): identities, email confirmation, recovery
   └─ PostgreSQL + PostgREST: RLS is the enforcement boundary
```

## Principles

1. **Defense in depth, with the database last and strongest.** UI hides what a role cannot do (convenience). Server code re-checks permissions (`requireTenantContext(permission)`, per-action checks). PostgreSQL RLS refuses anything else. Each layer is tested separately.
2. **The user's JWT, always.** `createClient()` in `src/lib/supabase/server.ts` uses the anon key plus the user's session, so RLS applies to every query. There is **no service-role client** in the application today. Operations that need elevation are `SECURITY DEFINER` SQL functions with explicit checks (`create_tenant`, `accept_invitation`, `revoke_invitation`, `platform_set_tenant_status`, `log_audit_event`, `check_rate_limit`).
3. **The proxy is not a security boundary.** `src/proxy.ts` only keeps the session fresh and redirects signed-out visitors. Next.js docs are explicit that proxies run separately from rendering; authorization lives in server code and RLS.
4. **Pricing engine independence.** Pricing logic will live in `src/engine/`, a pure TypeScript module with no imports from React, Next.js, Supabase or UI code. An ESLint `no-restricted-imports` rule enforces this today (the folder is created in Milestone 2). Goal: reuse from an iOS app or external API.
5. **Reproducible calculations.** (Design for Milestone 2+) every result stores the rate-card version, surcharge rule versions and inputs used, with explicit effective dates and UTC timestamps.
6. **Keep the PWA/native door open.** No server-only assumptions in UI components, no reliance on cookies readable by client JS, standard web APIs only; Capacitor packaging remains possible.

## Request flow (authenticated page)

1. `proxy.ts`: `supabase.auth.getUser()` (validated by the Auth server) refreshes cookies; signed-out requests to protected prefixes go to `/login?next=…`.
2. Route-group layout calls `requireTenantContext()` or `requireBrandContext()` (`src/lib/auth/session.ts`): validates the user, loads usable memberships through RLS, picks the active membership (cookie `pc_ctx` is a hint, re-validated every request), redirects on portal mismatch.
3. Page calls `requireTenantContext("permission")` for page-level permission; queries run under RLS; cross-tenant IDs return no rows → `notFound()`.
4. Mutations are Server Actions: Zod parse → permission check (TS mirror of the DB matrix) → rate limit → query under RLS → `revalidatePath`.

## Authentication and sessions

* Supabase Auth with PKCE; email confirmation required.
* `/auth/confirm` is the single landing route for emailed links: PKCE `?code=` (default templates; same browser only) or `?token_hash=` (recommended templates; works cross-device). `next` goes through `safeNext()` to prevent open redirects; failures land on `/login?error=link`.
* Session cookies are HttpOnly, SameSite=Lax, Secure in production (`src/lib/supabase/cookie-options.ts`).
* A password change signs out every other session.

## Multi-membership and context

A user can hold several memberships (e.g. a consultant for two 3PLs). RLS grants the union of what each membership allows; the application narrows each request to the *active* membership and always filters by its `tenant_id`. The workspace switcher appears only when more than one membership exists.

## Directory map

See the README. Notable boundaries: `src/lib/auth` (identity + authorization), `src/components/ui` (design system, no business logic), `src/app/actions` (all writes), `supabase/migrations` (all schema).

## Decisions and trade-offs

| Decision | Reason | Cost |
|---|---|---|
| RLS + SECURITY DEFINER helpers in a private `app` schema | Single, testable enforcement point; helpers avoid recursive policies | Policy logic lives in SQL; needs DB tests (we have them) |
| Permissions mirrored in TS and SQL, parity test | Server-side checks and RLS cannot silently diverge | Two places to edit; test fails if they differ |
| No service-role key in app code | Least privilege; a bug cannot bypass RLS | Some admin operations are SQL functions rather than app code |
| Invitations via our own hashed token, not Supabase invite emails | Roles/brand scope must bind to the invitation; works for existing users | We own email sending (Resend or manual link) |
| DB-backed rate limiting | Works across serverless instances without extra infrastructure | Extra writes; only for authenticated actions |
| Docker-free local stack for tests | Runs anywhere; real Auth + Postgres + PostgREST | Not identical to Supabase's hosted gateway |
