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

## Fee schedules, fee-aware runs and forecasts (Milestone 4)

A fee schedule is the 3PL's own customer-facing list of fulfillment charges. It holds only amounts the 3PL typed for its customers: no table, column or form takes a carrier buy rate.

| Threat | Control | Test |
|---|---|---|
| A brand reads another brand's fee schedule, a schedule it is not on, a draft, or another tenant's | RLS on `fee_schedules`, `fee_schedule_versions`, `fee_rules` and the assignments through `app.brand_has_fee_schedule` (an active brand in an active tenant, a membership of the caller, a live assignment to the schedule) and `app.can_view_fee_version`; drafts and discarded versions have no brand policy; leaving a schedule closes it at once, the snapshot function included | `tests/db/fees.test.ts` (assigned brand, unassigned brand, other tenant, outsider, platform administrator) |
| 3PL-only text reaching a brand | The only staff-only text lives in `fee_rule_sources` and `fee_schedule_version_notes`, tables with **no brand policy**; `fee_schedule_snapshot` and `brand_fee_schedule_on` never select them; a brand reads no row of either table, and sentinel strings written into both never appear in a snapshot or a `brand_fee_schedule_on` payload | `fees.test.ts` (sentinels), `tests/unit/fees-ui.test.ts` (the customer view renders no key, id, version number, source or note) |
| A brand, or a 3PL employee, writes a fee schedule | Every write policy needs `ratecard.manage` (employees hold `ratecard.view`); status, dates and `rule_count` change only inside the lifecycle functions; the minimum sets are written by activation, not by clients | `fees.test.ts` |
| Cross-tenant references (schedule, version, rule, assignment, run, fee context) | Composite foreign keys on `(id, tenant_id)` throughout; `assign_fee_schedule` checks the brand and the schedule belong to the same tenant (a manager of another tenant gets "not found") | `fees.test.ts` |
| Silent change to fees in force | Rules, sources and notes of a version are immutable once it leaves draft (row triggers, effective for the table owner too); an exclusion constraint stops two active versions covering one day; archived and discarded versions cannot change status; activation validates the version as a whole | `fees.test.ts` |
| Forged assignment or lifecycle records | No write grant on assignments (only the functions write them); the audit events `ratecard.fee_*` are trigger-written with the real actor and the namespace is closed to `log_audit_event()` | `fees.test.ts` |
| Order results, monthly lines or minimum figures forged through `advance_simulation_run` / `finish_simulation_run` | The database checks every order result against the file (shipments, packages, month, units, lines and SKUs unless the result says they were assumed, and an assumed quantity is accepted only where the file has none), the fee date and the pinned version, that fee lines add up to the stored columns, and exactly one result per order; at finish it recomputes the processing totals, **every monthly line** and **every minimum top-up and status** from stored rows and refuses a summary that disagrees (`PC003`). **Not prevented:** the individual order-fee amounts are the engine's output (the database cannot re-derive rate x quantity without a second fee engine in SQL), so a user with API access could post invented fee amounts into their **own** run; they could not touch another brand's rows, and the figures they then read are their own invention, not the 3PL's | `fees.test.ts` |
| A forecast saved with forged figures | `save_forecast_run` checks the identities (weights sum to the volume, nothing definite, all-in equals its parts), that the pinned fee version is the one in effect on the date, that the monthly charges equal the recomputed ones and that the minimum status fits the version. **Not prevented:** the expected shipping and processing amounts, the allocation and the minimum amounts of a forecast are application-computed and not recomputed in SQL; the same own-brand limit as above applies | `fees.test.ts` |
| Estimates presented as invoices, unknowns presented as $0 | Every figure the customer sees is labelled (definite, based on assumptions, not computed); a quantity that is unknown and not assumed is "not computed" and the headline says "At least" and names what is left out; forecasts say they are expected values, not a prediction and not an invoice | `tests/unit/modeling-headline.test.ts`, `modeling-results.test.ts`, `forecast-ui.test.ts` |
| Confidential identifiers in what a brand's browser or files receive | Engine explanations and the customer's views name rules and rates, never keys; the brand's fee schedule, run, calculator and forecast screens render no rule key, id, version number, source or note; the forecast preview and saved-forecast payloads are scrubbed for a brand viewer (cells dropped; keys, service ids, hashes, engine versions and engine messages blanked); the calculator returns a customer-safe projection; exports have customer-facing columns only; **no React key is an identifier** (keys travel in the serialised page even though nothing prints them, so the run and fee-schedule screens key rows by position and name, never by a rule key, rule id or service id) | `fees-ui.test.ts`, `modeling-results.test.ts` ("shows no rule key, id, version or note to the customer"), `modeling-lean-lists.test.ts` (walks the rendered tree of the run page's tables and pins that no key is a rule key or id), `forecast-ui.test.ts`, `forecast-actions.test.ts`, `calculator-fees.test.ts`; browser: `fees.spec.ts` asserts the 3PL's keys, group names, notes and sources are absent from the page source of every customer page and from every export |
| Allocated monthly charges passed off as per-order fees | `orders.csv` has no per-order column for monthly charges or an all-in figure; they are in `monthly.csv` with their period and volume; `simulation_monthly_lines` rows are never attached to an order | `modeling-headline.test.ts` |
| Exports of customer order data | `orders.csv` and `monthly.csv` log `export.run_orders` / `export.run_monthly` before streaming (the export is refused if the audit write fails), read under RLS, and neutralise text from the customer's own file against spreadsheet formulas | `modeling-results.test.ts` calls both route handlers against a fake client (signed-out, other customer, other 3PL, forecast, unfinished run and bad id are 404; a failed audit write refuses the export; paging); not exercised in a browser or against PostgreSQL |
| Oversized or abusive input | `assumptions.fulfillment` is validated in SQL (closed keys, ranges, at most 16 KB); forecast assumptions are capped (32 KB stored, 40,000 characters accepted, 1,500 grid cells, 14 parcels, 30 zones, 10 services, 12 content rows) and rate-limited per user (`forecast.preview` 240/h, `forecast.save` 120/h, `forecast.context` 600/h, `calc.box` 1,200/h, `modeling.setup` 600/h) | `fees.test.ts`, `forecast-actions.test.ts` |

### What a brand never sees

Through the application: the 3PL's staff-only source references and version notes; draft and not-yet-saved fee schedules; rule keys, rule ids, schedule and version ids, version numbers and pinned version ids; engine and fee-engine versions and hashes; the 3PL's other customers' schedules, assignments and runs; anything about a staff-created scenario until the 3PL shares it. A brand sees its fee schedule's names, rates, descriptions, help text, effective dates, rounding rule and the members of each account minimum, as the version in effect today reads.

### Known limits of that promise

The database enforces that notes and sources never reach a brand. It does **not** hide *identifiers*. A brand member of the assigned brand can read, through the Data API or the snapshot function, the `key` and `id` of the rules of every active or archived version of its schedule (including an active version whose effective date is still in the future), those versions' `version_number`, the `fee_schedule_version_id`, `fee_lines` and rule keys stored in the order results and fee contexts of its own runs, and the stored `summary` and `reference_data` of its own runs, which name rules by key and id. This follows the Milestone 3 decision that identifiers are not notes; the pages and files the application builds never print them. A brand user who calls the API by hand can see them. Two related facts: the summaries stored before the engine named a vanished account-minimum member neutrally carry that rule's key as its name (screens and the brand copy of a forecast replace it); and the keys of the fee schedule's *questions* (driver keys) reach the customer's browser, because answers are posted by key (the run setup and forecast forms and the response of `loadFulfillmentSetup`), though nothing prints them. Closing this would mean separate brand-facing views of the version and result tables without those columns; it is not built.

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
10. **Identifiers readable by a brand through the API** (rule keys and ids, version numbers, pinned version ids, rule names in stored summaries): see "Known limits of that promise" above. Notes and sources are not readable.
11. **Fee amounts are application-computed.** The database recomputes processing totals, monthly lines, minimum top-ups and the projected monthly total for file runs, but not the individual order-fee amounts, and recomputes only the identities and the monthly charges of a forecast. A user with API access could post invented fee amounts into their own run or forecast. The server-held credential for the batch writer planned for Milestone 9 would close this together with the Milestone 3 equivalent.
12. **Browser-level access-control tests use fictional data on desktop Chromium and an emulated phone.** `fees.spec.ts` drives another customer's and another 3PL's fee-schedule, run and forecast URLs (all refused) and checks the 3PL's keys, notes and sources are absent from every customer page's source and every export; there is no real iOS Safari check and no test against a hosted Supabase project.

## Reporting

Report vulnerabilities privately to the repository owner; do not open public issues containing exploit details.
