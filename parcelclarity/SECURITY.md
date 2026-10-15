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

## Pricing data (Milestone 2)

| Threat | Control | Test |
|---|---|---|
| Brand sees another brand's pricing, an unassigned card, a draft, or a customer exception | RLS on every pricing table keyed by active assignment + active version; overrides visible only to the brand they concern | `tests/db/pricing.test.ts` |
| Brand or 3PL employee writes pricing | Every write policy requires `ratecard.manage`; status changes only via RPCs that re-check the permission | `pricing.test.ts` |
| Cross-tenant references (card ↔ version ↔ brand ↔ rule) | Composite foreign keys `(id, tenant_id)` on versions, assignments, overrides and imports | `pricing.test.ts` |
| Silent change to prices in force | Rows/terms/zones immutable once a version leaves draft; published rule versions immutable; exclusion constraints forbid overlapping active/published versions | `pricing.test.ts` |
| Forged audit records of activation/publication | Trigger-only namespaces; `log_audit_event()` rejects them | `audit.test.ts` |
| Hostile uploads | Extension + content sniffing, 5 MB cap, 50k rows / 600k cells / 20 sheets caps, strict cell parsing, files stored in the database under RLS (no public storage), never executed or rendered as HTML | `import-pipeline.test.ts` |
| Prompt injection through uploaded documents | No AI reads uploads; cell text is data only; mapping is approved by an administrator | by construction |
| Uploaded file read by the wrong person | `uploaded_files` readable only by managers of the owning tenant | `pricing.test.ts` |

Not yet done: malware scanning of uploads (files are never executed or served back, which bounds the risk), and moving large files to private object storage with signed URLs (order files are stored as bytes up to 15 MB; see Milestone 3 below).

## Modeling data (Milestone 3)

| Threat | Control | Test |
|---|---|---|
| A brand reads another brand's orders, results or product weights, or a 3PL's private what-if | RLS keyed by `app.can_model_brand` on every modeling table; staff-created datasets/scenarios hidden from the brand until shared; composite keys chain every child row to its dataset and brand | `tests/db/modeling.test.ts`, `tests/e2e/modeling.spec.ts` |
| Results or progress forged through the Data API | No write grants on orders/shipments/packages/results/runs; every lifecycle change is a `SECURITY DEFINER` function that authorises on the row and on the visibility the RLS policies grant; `advance_simulation_run` accepts only results that name this run's own shipments at their own row numbers and a partial summary that covers exactly the window; `finish_simulation_run` recomputes the headline figures from the stored rows and refuses a summary that disagrees. **Not prevented:** the amounts themselves are the caller's engine output (the app holds no credential a signed-in user lacks), so a user with API access could post invented amounts into *their own* run; they could not touch another brand's rows, and the figures they see are then their own invention, not the 3PL's. A server-held credential for the batch writer is the planned hardening (Milestone 9) | `modeling.test.ts` |
| 3PL internal notes reaching a brand through a stored run or a calculation | `pricing_rules_for_card` returns the fixed label for rule sources, ZIP-list sources and exception references whenever a brand is priced (staff on behalf included); the calculator action returns a customer-safe projection to brand callers (no keys, versions, ids, engine version or references) and the same projection is what a saved single scenario stores; engine explanations name rules and lists, never keys; bulk results store amounts, codes and rule identifiers (key, version, name, category: identifiers, never notes); pinned run contexts are readable by staff only; the customer UI and CSV render names and plain language | `pricing.test.ts`, `modeling.test.ts`, `modeling.spec.ts` |
| Staff-prepared order files read by the brand before they are shared | `uploaded_files` policy: an order file follows its dataset (uploader and staff always, the brand once a dataset on it is shared); sharing flags are not writable through the Data API, only through staff-only functions; lifecycle functions refuse datasets, scenarios and runs the caller's RLS would hide | `modeling.test.ts` |
| Discarding a file that a 3PL's private scenario still models | `discard_order_dataset` refuses while any scenario the caller cannot see, any unarchived scenario, or any run in progress uses the file | `modeling.test.ts` |
| A brand modeling on an unassigned card or service | Scenario insert policy and `start_simulation_run` require an active assignment (and an allowed service for overrides); the calculator and loaders go through the same assignment-scoped loader | `modeling.test.ts` |
| Hostile order files | 15 MB cap (database-enforced for order files; 5 MB stays for pricing files), 100k rows / 4M cells, zip inflation guard, strict cell parsing (decimal commas and out-of-range values are refused, never misread); files stored in the database under RLS; values the customer typed are formula-neutralised in the CSV export | `import-pipeline.test.ts`, `orders-import.test.ts` |
| Runaway batches and API-level abuse | Time-boxed server action (~4 s), rate limits per user in the actions (`modeling.batch` 3,000/hour) and in the database (uploads: 120/hour by trigger; materialisation chunks and files capped in SQL; batch window clamped to 500), one live run per project, idempotent window commits | `modeling.test.ts` |
| Exports of customer order data | Every CSV export writes an `export.run_results` audit event (the export is refused if the audit write fails) | — (route; covered by e2e download) |

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
4. **File security**: rate-card, zone-chart and order-file uploads are validated (extension, content sniffing, size, row/cell caps, zip inflation guard) and stored as bytes in PostgreSQL under RLS. **No malware scanning** yet, and no object storage/signed URLs; the planned design is a private bucket with `tenant_id/…` paths, storage policies calling the same `app.*` helpers, short-lived signed URLs and async scanning that quarantines files until clean.
5. **AI-assisted import mapping is not implemented**; mapping detection is deterministic heuristics that an administrator approves. If AI is added later: document text is data only, AI output is a suggestion requiring approval, and AI never touches authorization or pricing logic; processing will be optional and disclosed.
6. **Tenant deletion/export, retention controls, backup/restore drill**: not built (Milestone 9).
7. **Platform-admin "break glass" support access** (explicit, tenant-granted, audited) is not built. Today platform admins simply cannot see tenant data.
8. **No third-party penetration test or formal security review** has been done.
9. Local test credentials (`scripts/local-stack/env.sh`) are public dev values for a throwaway local stack. They must never be used in a hosted environment.

## Reporting

Report vulnerabilities privately to the repository owner; do not open public issues containing exploit details.
