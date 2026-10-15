# Security

Rate cards, order files and forecasts are confidential business data. This document states what is enforced today, how it is tested, and what is **not** done yet.

## Tenant and brand isolation

| Threat | Control | Test |
|---|---|---|
| Brand reads another brand's data (same tenant) | RLS: brand members get permissions only where `memberships.brand_id = row.brand`; staff scoped by `tenant_id` | `tests/db/isolation.test.ts` ("brand isolation") |
| Tenant reads another tenant's data | RLS on every table keyed by membership | `isolation.test.ts` ("tenant isolation"); E2E: other tenant's customer URL → 404 |
| ID manipulation in URLs / API params | Lookups run under RLS → no rows → 404; actions also filter by the active `tenant_id` | DB + E2E |
| Inserting rows into another tenant by supplying its `tenant_id` | `WITH CHECK` policies; composite FKs `(brand_id, tenant_id)` | DB |
| Privilege escalation via invitations | `can_assign_role`: staff roles need `staff.manage`; brand roles only for brands of the tenant and need `member.manage`; `invited_by` unforgeable | `privileges.test.ts` |
| Self-promotion / self-reinstatement | Membership UPDATE policy excludes your own row; only `role_key`/`status` columns writable | `privileges.test.ts` |
| Moving a membership between tenants | Identity columns not granted + trigger | DB |
| Locking a tenant out of administration | Trigger requires one active admin | DB, E2E |
| Platform operators browsing tenant data | No policies for them on brands/members/invites/audit; `platform_admins` unreadable via API | DB, E2E |
| Suspended tenant/brand/member still acting | Permission helpers require active tenant, brand and membership; checked on every query | DB, E2E |
| Anonymous access | `anon` has no table grants and no RPC execute | DB |

Isolation is verified against **real PostgreSQL with the real Supabase Auth schema**, using the same `set local role` + JWT-claims mechanism PostgREST uses.

## Authentication and sessions

* Supabase Auth, email confirmation required, PKCE flow; recovery via PKCE or token-hash (cross-device).
* `getUser()` (server-validated) is used for every authorization decision, never the unverified cookie contents.
* Cookies: HttpOnly, SameSite=Lax, Secure in production.
* Password policy: min 10, max 72 bytes (bcrypt truncates beyond that; we reject rather than silently truncate). Hosted Supabase must also be set to min 10 (config in `supabase/config.toml` for local).
* Password change revokes all other sessions.
* Sign-in and recovery responses are identical for unknown vs known accounts (no enumeration).
* Open redirects: `safeNext()` allows same-site relative paths only (unit + E2E tested).

## Invitations

Raw tokens are 256-bit random values returned once (email or the inviter's screen); only the SHA-256 is stored. Acceptance requires: signed in, **confirmed** email matching the invited address, pending, unexpired, tenant and brand active. Failures return one indistinguishable error. Single-use, revocable, 7-day default (30-day hard cap). Acceptance is an explicit POST (no side effects on GET).

## Least privilege

* No service-role key in application code today.
* Data API grants are explicit, minimal and column-scoped.
* `SECURITY DEFINER` functions pin `search_path = ''`, fully qualify objects, and check the caller explicitly.
* Helper functions live in a private schema not exposed by the Data API.

## Audit

Security-relevant changes (tenant, brand, membership, invitation) are written by database triggers with the real `auth.uid()`, cannot be forged by clients, and are append-only (UPDATE/DELETE/TRUNCATE rejected). Application events go through `log_audit_event`, which restricts action names and requires tenant membership. Audit rows deliberately have no foreign keys so they outlive deleted entities.

## Other controls

* Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`; `poweredByHeader` off; pages `noindex`.
* Zod validation on all server action inputs; React escapes output; email HTML escapes interpolations.
* Rate limiting for authenticated actions (PostgreSQL, shared across instances); fails closed.
* Service worker caches **nothing** except a static offline page: confidential data never persists on the device cache.
* Secrets only in environment variables (`.env.example` lists them); `.env*` is git-ignored.
* `npm audit` (production dependencies) clean at time of writing; `npm run audit` for CI.

## Known gaps (do not assume these exist)

1. **No Content-Security-Policy yet.** Needs nonce plumbing through Next.js. Milestone 9.
2. **Unauthenticated endpoint throttling** depends on Supabase Auth's rate limits and CAPTCHA settings in the hosted project; not configured by this repo. Configure before launch.
3. **No MFA/SSO.**
4. **File security** (private storage, signed URLs, storage-path isolation tests, upload validation, size limits, malware-scanning strategy) is not built; it arrives with uploads in Milestone 2/3. The strategy to implement: private bucket with paths `tenant_id/…`, storage policies that call the same `app.*` permission helpers, signed URLs with short expiry, server-side MIME/extension/size validation, and an async scanning step (e.g. ClamAV or a managed scanner) that quarantines files until clean.
5. **Prompt-injection boundary** for AI-assisted import mapping is a Milestone 2 deliverable: document text is data only, AI output is a suggestion requiring administrator approval, and AI never touches authorization or pricing logic. AI processing will be optional and disclosed.
6. **Tenant deletion/export, retention controls, backup/restore drill**: not built (Milestone 9).
7. **Platform-admin "break glass" support access** (explicit, tenant-granted, audited) is not built. Today platform admins simply cannot see tenant data.
8. **No third-party penetration test or formal security review** has been done.
9. Local test credentials (`scripts/local-stack/env.sh`) are public dev values for a throwaway local stack. They must never be used in a hosted environment.

## Reporting

Report vulnerabilities privately to the repository owner; do not open public issues containing exploit details.
