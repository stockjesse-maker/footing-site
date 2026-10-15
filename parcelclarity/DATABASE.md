# Database

PostgreSQL via Supabase. All schema changes are SQL migrations in `supabase/migrations/` (applied in filename order). Monetary values (from Milestone 2) use `numeric` with explicit precision, never floats; timestamps are `timestamptz` in UTC.

## Implemented tables (Milestone 1)

| Table | Purpose | Notes |
|---|---|---|
| `roles`, `permissions`, `role_permissions` | Role/permission matrix | Read-only reference data; mirrored in `src/lib/auth/permissions.ts` (parity test) |
| `profiles` | One row per auth user (email, display name) | Created by trigger on `auth.users`; email follows auth email changes |
| `platform_admins` | Platform operators | **No grants, no policies** (service role / DB owner only) |
| `tenants` | 3PLs | `status`: active, suspended, pending_deletion |
| `brands` | Brand customers of a tenant | FK `tenant_id`; unique (tenant, case-insensitive name); `status`: active, suspended, revoked (terminal) |
| `memberships` | Who belongs where, with which role | Staff rows `brand_id is null`; brand rows carry both ids; composite FK `(brand_id, tenant_id) → brands(id, tenant_id)` makes a mismatched tenant impossible |
| `invitations` | Pending/used invitations | Stores SHA-256 of the one-time token only; 30-day max window; one pending invite per (scope, email) |
| `audit_events` | Append-only audit trail | No FKs on purpose (must outlive entities); written by triggers and `log_audit_event()` |
| `rate_limit_counters` | Per-user, per-action fixed-window counters | Function-only access |

## Pricing tables (Milestone 2, `20261015000003_pricing.sql`)

| Table | Purpose | Notes |
|---|---|---|
| `carriers`, `shipping_services` | Reference data (names only) | Readable by every signed-in user; no amounts |
| `uploaded_files` | Small confidential uploads (rate cards, zone charts, ZIP lists), stored as `bytea` ≤ 5 MB so RLS applies | Managers only; brands never |
| `rate_cards` | A 3PL's customer-facing rate card (container) | Unique name per tenant |
| `rate_card_versions` | Versions: draft → active → archived (or discarded) | Exclusion constraint: two active versions can never cover the same day; `import_mapping` and `validation_summary` keep the approved structure |
| `rate_card_service_terms` | Per service in a version: DIM divisor/threshold/rounding, minimum charge, included/excluded surcharge keys | Immutable once the version leaves draft (trigger) |
| `rate_card_rows` | Price cells: service, optional origin prefix, zone, bracket (min exclusive, max inclusive), unit, price, min charge | Unique bracket per service/origin/zone; immutable after draft |
| `rate_card_zones` | The card's zone chart: carrier, origin prefix, destination prefix range → zone | Immutable after draft |
| `brand_rate_card_assignments` | Which brands may use which cards, optionally limited to some services | One active assignment per brand/card |
| `zip_lists`, `zip_list_entries` | ZIP/prefix lists (e.g. delivery-area surcharges), platform or tenant scope, versioned with source and verification status | |
| `surcharge_rules`, `surcharge_rule_versions` | Rule identity (stable key) and its versions: draft → published → retired; amount/percent/per-unit, calculation base, conditions (JSON), exclusivity, effective dates, source, verification | Published versions are immutable; exclusion constraint forbids overlapping published versions |
| `customer_surcharge_overrides` | Brand-specific exceptions: waive a rule or charge a different amount/percent | Visible to staff and that brand only |
| `rate_card_imports` | Import state machine: uploaded → mapped → validated → imported (or discarded), with detected structure, approved mapping and validation report | Managers only |

### Visibility rules for pricing data

* 3PL staff with `ratecard.view` see every card, version (any status), row, zone, term, rule and override of their tenant; `ratecard.manage` is required for every write and for reading files/imports.
* Brand members see **only** rate cards actively assigned to their (active) brand, **only active versions** of those cards and their rows/zones/terms, published rule versions (platform scope or their tenant's), ZIP lists of their tenant or the platform, and overrides for their own brand. They can never write pricing data or read files/imports/drafts.
* Platform-scope rules and lists (`tenant_id is null`) are readable by all signed-in users and can only be written by the service role until Milestone 8's review workflow exists.
* Children (rows, zones, terms, ZIP entries) are visible exactly when their parent version/list is visible: their policies are `version_id in (select id from rate_card_versions)`, so the parent's RLS decides.

### State transitions (RPC only)

`activate_rate_card_version(version, effective, expiration)` (requires rows and terms for every service; refuses overlaps), `archive_rate_card_version`, `publish_surcharge_rule_version` (marks the version `approved_3pl_config`), `retire_surcharge_rule_version`. Direct status updates are not granted.

### Bulk readers

`rate_card_rows_json(version, service_ids?)`, `rate_card_zones_json(version)`, `zip_list_entries_array(list)` return a whole set in one call (the Data API pages at 1,000 rows). They are `SECURITY INVOKER`, so the caller's RLS applies.

### Audit

Triggers write `ratecard.created|updated|version_active|version_archived|version_discarded|assigned|unassigned|override_created|override_ended` and `carrier_rule.published|retired`. The user-callable `log_audit_event()` can no longer use the `ratecard.` or `carrier_rule.` namespaces, so these records cannot be forged by a member (`tests/db/audit.test.ts`).

## Planned tables (not yet created)

Added by later milestones, each with RLS from day one: processing fee schedules / rules, order datasets, orders, order lines, shipments, packages, simulation projects / runs / results, adjustment records, saved scenarios, reports, subscriptions, usage records.

## Isolation model

* Access exists only through active rows in `memberships`.
* A suspended **tenant** removes all staff/brand permissions (members can still read their own membership and tenant row so the UI can explain).
* A suspended or revoked **brand** removes access for brand members only; 3PL staff keep visibility so they can manage it.
* Brand members get permissions only for their own brand; staff get them for every brand of their tenant.
* Platform administrators have **no policy access** to brands, memberships (other than their own), invitations, audit events or profiles; they can list tenants and call `platform_set_tenant_status`.

## Role permission matrix

| Permission | 3PL admin | 3PL employee | Brand admin | Brand employee |
|---|:-:|:-:|:-:|:-:|
| tenant.manage (rename workspace, branding later) | ✓ | | | |
| staff.manage (invite/manage 3PL staff) | ✓ | | | |
| brand.view | ✓ (all brands) | ✓ (all brands) | ✓ (own brand) | ✓ (own brand) |
| brand.create / brand.manage | ✓ | | | |
| member.view / member.manage | ✓ | | ✓ (own brand) | |
| audit.view | ✓ | | | |
| ratecard.view | ✓ | ✓ | | |
| ratecard.manage | ✓ | | | |
| simulation.run | ✓ | ✓ | ✓ | ✓ |
| report.view | ✓ | ✓ | ✓ | ✓ |

(`ratecard.*`, `simulation.run`, `report.view` are defined now and enforced by later milestones' tables.)

## RLS policies (summary)

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| roles / permissions / role_permissions | any signed-in user | none | none | none |
| profiles | self, or co-members you may view (`can_view_profile`) | trigger only | self, `full_name` only | none |
| tenants | member of tenant, or platform admin | via `create_tenant()` | `tenant.manage`, `name` only | none |
| brands | `can_access_brand_row(..., 'brand.view')` | `brand.create`; `tenant_id`, `name` only | `brand.manage`; `name`, `status` only | none |
| memberships | own rows, or scope viewable (`member.view`) | via `create_tenant()` / `accept_invitation()` only | manager of scope; `role_key`, `status` only; never your own row; role must be assignable by you | none |
| invitations | managers of scope | `can_assign_role(...)`, `invited_by = you` | via `revoke_invitation()` only | none |
| audit_events | `audit.view` in that tenant | triggers / `log_audit_event()` only | none (a trigger rejects it for every role, including the table owner) | none (trigger blocks) |
| platform_admins, rate_limit_counters | none | none | none | none |

## Functions

Private (`app` schema, not exposed by the Data API; `SECURITY DEFINER`, `search_path = ''`): `is_platform_admin`, `is_member_of_tenant`, `has_tenant_permission`, `has_brand_permission`, `can_access_brand_row`, `can_view_membership`, `can_manage_membership`, `can_assign_role`, `can_view_profile`, audit writers, guard/touch triggers.

Public RPC (authenticated only): `create_tenant`, `accept_invitation`, `revoke_invitation`, `log_audit_event`, `platform_set_tenant_status`, `is_platform_admin`, `check_rate_limit`, and the pricing transitions/readers listed below.

### Lessons recorded in the schema

* `brands`' SELECT policy must not call a helper that queries `brands`: a helper cannot see a row inserted in the same statement, which breaks `INSERT … RETURNING` (and PostgREST insert-then-select). It uses `can_access_brand_row(id, tenant_id, status, …)` on the row's own columns. Found by the DB tests.
* The membership guard trigger is `SECURITY DEFINER`; otherwise its `SELECT … FOR UPDATE` is filtered by the caller's UPDATE policy and wrongly concludes no other admin exists. Found by the DB tests.

## Privileges

Default privileges for `anon`/`authenticated` on new `public` objects are revoked at the top of the first migration; every grant is explicit and, for writes, column-scoped. `service_role` keeps full access (it bypasses RLS by design). `anon` has no table grants and cannot execute any RPC. `supabase/config.toml` sets `auto_expose_new_tables = false` to match.

## Audit events recorded

`tenant.created|updated|status_changed`, `brand.created|updated|status_changed`, `membership.created|updated`, `invitation.created|accepted|revoked`. Application events via `log_audit_event` are limited to prefixes `simulation. scenario. report. export. ratecard. import. billing. adjustment. carrier_rule. session.` and require tenant membership.

## Reproducing the schema from scratch

`tests/db/global-setup.ts` creates an empty database, installs the real Supabase Auth schema (GoTrue migrations), then applies every migration in order. That runs on every `npm run test:db`.
