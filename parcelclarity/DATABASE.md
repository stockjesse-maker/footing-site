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
| `rate_card_versions` | Versions: draft → active → archived (or discarded) | Exclusion constraint: two active versions can never cover the same day; an active version can be *ended* on a date (history preserved); `validation_summary` holds only a non-confidential coverage summary |
| `rate_card_service_terms` | Per service in a version: DIM divisor/threshold/rounding, minimum charge, included/excluded surcharge keys, zone-chart key, zone independence, surcharge markup, source reference | Immutable once the version leaves draft (trigger) |
| `rate_card_rows` | Price cells: service, optional origin prefix, zone, bracket (min exclusive, max inclusive), unit, price, min charge | Exclusion constraint: brackets of one cell never overlap (compared in pounds); immutable after draft |
| `rate_card_zones` | The card's zone charts (one per chart key): carrier, origin prefix, destination prefix range → zone | Exclusion constraint: ranges never overlap within a chart/origin/prefix length; immutable after draft |
| `brand_rate_card_assignments` | Which brands may use which cards, optionally limited to some services | One active assignment per brand/card; `allowed_service_ids` is enforced by RLS on rows and terms |
| `zip_lists`, `zip_list_entries` | ZIP/prefix lists (e.g. delivery-area surcharges), platform or tenant scope: draft → published → retired, versioned with source and verification status | Entries immutable once published; exclusion constraint forbids overlapping published versions of a key; `entry_count` maintained by trigger |
| `surcharge_rules`, `surcharge_rule_versions` | Rule identity (stable key, optional brand scope) and its versions: draft → published → retired (retired keeps its dates for history); amount/percent/per-unit (+ minimum), billable-weight floor, calculation base, conditions (JSON), exclusivity, effective dates, source, verification | Published/retired versions are immutable; a published version cannot be `unverified`; exclusion constraint forbids overlapping published/retired versions |
| `customer_surcharge_overrides` | Brand-specific exceptions: waive a rule, fixed amount/percent, or published figure + markup/points | Visible to staff and that brand only; at most one live override per brand/rule on any date |
| `rate_card_imports` | Import state machine: uploaded → mapped → validated → imported (or discarded), with detected structure, approved mapping and validation report | Managers only |

### Visibility rules for pricing data

* 3PL staff with `ratecard.view` see every card, version (any status), row, zone, term, rule and override of their tenant; `ratecard.manage` is required for every write and for reading files/imports.
* Brand members see **only** rate cards actively assigned to their (active) brand, **only active versions** of those cards, and only the rows and terms of the **services allowed** by the assignment (`app.can_view_version_service`). They never read tenant-scope rules, rule versions or ZIP lists directly: `pricing_rules_for_card()` authorizes once and returns only what applies to them (tenant-wide rules plus rules scoped to their brand) together with their own live exceptions joined to rule keys, and replaces the 3PL's internal source notes on tenant rules and lists with a fixed label. They see overrides for their own brand only. They can never write pricing data or read files, imports or drafts. New versions and assignments can only be created for `active` rate cards (policy-enforced, not just hidden in the UI).
* Platform-scope rules and lists (`tenant_id is null`, not draft) are readable by all signed-in users and can only be written by the service role until Milestone 8's review workflow exists.
* Zones and ZIP entries are visible exactly when their parent version/list is visible (correlated `exists` on the parent, whose RLS decides).

### State transitions (RPC only)

`activate_rate_card_version(version, effective, expiration)` (requires rows and terms for every service; refuses overlaps), `end_rate_card_version(version, expiration)` (ends an active version on a date so a successor can follow; the version stays resolvable for history), `archive_rate_card_version`, `publish_surcharge_rule_version` (marks the version `approved_3pl_config`), `retire_surcharge_rule_version(version, last_effective)` (keeps the version for dates up to `last_effective`), `publish_zip_list`. Direct status updates are not granted.

### Bulk readers

`rate_card_rows_json(version, service_ids?)`, `rate_card_zones_json(version)`, `zip_list_entries_array(list)` return a whole set in one call (the Data API pages at 1,000 rows). They are `SECURITY INVOKER`, so the caller's RLS applies. `pricing_rules_for_card(rate_card, ship_date, brand?)` is `SECURITY DEFINER` with its own authorization (see above) and returns the rule versions, the ZIP-list versions they reference (including inside `any_of` groups) and the brand's live overrides in force on the date. `replace_rate_card_zones(version, rows)` swaps a draft's zone chart in one transaction (`SECURITY INVOKER`, so the draft-only write policy applies), so a rejected row leaves the previous chart intact. Rate-row weight brackets are `numeric(12,6)` with pound-normalised generated edges at ten decimals, enough for an ounce bracket to abut a pound bracket exactly.

### Audit

Triggers write `ratecard.created|updated|version_active|version_archived|version_discarded|version_ended|assigned|unassigned|override_created|override_ended` and `carrier_rule.published|retired|zip_list_published|zip_list_retired`. The user-callable `log_audit_event()` can no longer use the `ratecard.` or `carrier_rule.` namespaces, so these records cannot be forged by a member (`tests/db/audit.test.ts`).

## Modeling tables (Milestone 3, `20261015000005_modeling.sql`)

| Table | Purpose | Notes |
|---|---|---|
| `sku_profiles` | A brand's product weights/dimensions per SKU, for order files that carry no package weight | Unique per brand and SKU (case-insensitive); brand members and staff read/write their own brand's |
| `order_datasets` | An uploaded orders file: uploaded → mapped → validated → materialising → ready (or discarded), with the detected structure, approved mapping, validation report and computed counts | Staff-created datasets are private until `shared_with_brand`; counts and the ready/discarded states are set only by functions (guard trigger) |
| `orders`, `order_lines`, `shipments`, `packages` | The file as rows: orders (date, destination, origin, residential, cancelled, validation issue codes), lines (sku, units), shipments (dense dataset-wide `row_no`, service, ship date) and packages (weight, dimensions, derived flags) | Composite keys chain back to the dataset (and its brand); no direct write grants, only `materialise_order_rows()` |
| `simulation_projects` | Saved scenarios: a single shipment or a bulk model on a dataset, bound to a rate card actively assigned to the brand (policy-enforced) | Staff-created scenarios are private until shared |
| `simulation_runs` | One execution: pricing basis (`fixed_date` / `ship_date`), service override and unmapped policy, assumptions, durable batch cursor (`next_row_no`), running `partial_summary`, final `summary`, dictionary (`reference_data`) and **trusted totals computed in SQL** at finish | One live run per project (partial unique index); `last_progress_at` distinguishes paused from running |
| `simulation_run_contexts` | What each ship date of a run was priced with: rate-card version, rule version ids, ZIP-list ids, override ids, load issues | Pinned for reproducibility even after versions are archived |
| `simulation_results` | One row per shipment: status/reason, zone, service, billable weights, split totals, dictionary-encoded lines, warning codes | Written only by `advance_simulation_run()`; never free text |

### Visibility rules for modeling data

* `app.can_model_brand(tenant, brand)`: the brand's own members with `simulation.run`, or the tenant's staff with `simulation.run`; `app.modelable_brand_ids()` is the set form used by hoisted SELECT policies so a 20,000-row scan evaluates the permission once.
* Brand members see their own brand's datasets, rows, scenarios, runs and results, and only those `shared_with_brand`; staff see everything of their tenant; `simulation_run_contexts` (pinned version ids, load diagnostics) are staff-only. Nobody else sees anything (`tests/db/modeling.test.ts`).
* Order files (`uploaded_files.purpose = 'order_import'`) may be uploaded by brand members for their own brand and by staff on their behalf (up to 15 MB; pricing files keep 5 MB and stay manager-only). A file follows its dataset: the uploader and staff can read it, the brand once a dataset on it is shared (`app.order_file_shared`). Uploads are rate-limited in the database (120 per user per hour).
* `shared_with_brand` is not writable through the Data API on either table; only the staff-only functions change it.

### State transitions (functions only)

`materialise_order_rows(dataset, orders, lines, shipments, packages)` (whole orders per chunk, one transaction; chunk and per-file caps), `finalize_order_dataset` (computes counts incl. the file's row count, requires dense row numbers), `reset_order_dataset` (rolls an interrupted materialisation back to *validated*), `discard_order_dataset` (refused while any scenario the caller cannot see, any unarchived scenario or a run in progress uses it), `set_dataset_sharing` / `set_scenario_sharing` (staff only; sharing a bulk scenario also shares its orders file), `start_simulation_run(project, basis, as_of, service_override, unmapped_policy, assumptions)` (validates every setting incl. an *active* assigned card; attaches to the live run only when the settings match, otherwise raises), `simulation_batch_input(run, limit ≤ 500)` (whole orders from the cursor with packages nested, plus the partial summary that belongs to that cursor), `advance_simulation_run(run, from, to, results, partial, contexts)` (idempotent: a window behind the cursor is acknowledged, a gap raises; every result must name this run's own shipment at its row number; the partial must have seen exactly `to` shipments), `finish_simulation_run(run, summary, reference_data, engine_version)` (recomputes modeled orders/shipments/packages and totals from the stored rows, refuses a summary that does not reconcile, marks the rows that are in the totals), `fail_simulation_run`, `cancel_simulation_run`, `save_single_simulation` (active assigned card, size caps). All `SECURITY DEFINER`, each authorising on the row it touches and on the visibility the RLS policies grant (`app.modeling_visible`, `app.project_visible`).

### Audit

Triggers write `modeling.dataset_ready|dataset_discarded|dataset_shared|dataset_unshared|scenario_created|scenario_shared|scenario_unshared|run_started|run_completed|run_failed|run_cancelled` with ids and counts only (never a summary); the `modeling.` namespace is not available to `log_audit_event()`. Shipment-level CSV exports log `export.run_results` through `log_audit_event()`.

## Planned tables (not yet created)

Added by later milestones, each with RLS from day one: processing fee schedules / rules, adjustment records, reports, subscriptions, usage records.

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

`tenant.created|updated|status_changed`, `brand.created|updated|status_changed`, `membership.created|updated`, `invitation.created|accepted|revoked`. Application events via `log_audit_event` are limited to prefixes `simulation. scenario. report. export. import. billing. adjustment. session.` (never `ratecard.`, `carrier_rule.` or `modeling.`, which are trigger-only) and require tenant membership.

## Reproducing the schema from scratch

`tests/db/global-setup.ts` creates an empty database, installs the real Supabase Auth schema (GoTrue migrations), then applies every migration in order. That runs on every `npm run test:db`.
