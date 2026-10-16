# Database

PostgreSQL via Supabase. All schema changes are SQL migrations in `supabase/migrations/` (applied in filename order). Monetary values (from Milestone 2) use `numeric` with explicit precision, never floats; timestamps are `timestamptz` in UTC. From Milestone 4, per-order fee amounts are stored as integer **ten-thousandths of a dollar** ("E4": 12500 = $1.25) so a rate with four decimals is exact; run totals are `numeric(14,4)` and projected monthly figures `numeric(14,2)`.

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

## Fee schedule tables (Milestone 4, `20261015000006_fees.sql`)

A fee schedule is the 3PL's own customer-facing list of fulfillment charges, versioned like a rate card. Every amount was typed by the 3PL; no table has a column for a buy rate or a carrier cost.

| Table | Purpose | Notes |
|---|---|---|
| `fee_schedules` | The container: `name` and `description`, **both customer-visible**; status `active` / `archived` | Unique case-insensitive name per tenant; only `name` and `description` are writable directly, archiving goes through `archive_fee_schedule` (guard trigger) |
| `fee_schedule_versions` | Versions: draft → active → archived (or discarded) with `effective_date`, `expiration_date`, `rounding` (`invoice_line` default, or `transaction`), `rule_count`, `activated_at/by` | `version_number` is assigned in SQL (highest + 1); exclusion constraint `fsv_no_overlap`: two **active** versions of one schedule never cover the same day; one draft per schedule (partial unique index); `unique (id, tenant_id)` with a composite FK to the schedule. `rounding` is editable only while the version is a draft; an active version can only change its expiration date |
| `fee_rules` | One customer-facing charge: `key` (slug, unique per version), `name`, `category`, `scope` (`order` / `monthly`), `basis`, `method`, `amount numeric(12,4)`, `percent numeric(8,4)`, `percent_base`, `tiers` jsonb, `included_quantity` + `included_per`, `minimum_charge`, `conditions` jsonb, `exclusive_group` + `priority`, `driver` jsonb, `minimum` jsonb, `resolved_rule_keys text[]`, `description`, `help_text`, `position` | Composite FK `(version_id, tenant_id)` to the version; rules can only be written while the version is a draft; `resolved_rule_keys` is set by `activate_fee_schedule_version` and is not a writable column |
| `fee_rule_sources` | **Staff-only.** Where the 3PL's number comes from (a contract clause, a pricing sheet) | Brands have no policy at all; writable only while the version is a draft |
| `fee_schedule_version_notes` | **Staff-only.** Notes on a version (why it changed, who approved it) | Same |
| `brand_fee_schedule_assignments` | Which schedule a brand is on; ended by setting `unassigned_at` | One live assignment per brand (partial unique index); composite FKs to the brand and the schedule; no write grants, written only by `assign_fee_schedule` / `unassign_fee_schedule` |

Permissions reuse the rate-card ones: `app.can_manage_fees(tenant)` delegates to `app.can_manage_pricing` (`ratecard.manage`), `app.can_view_fees(tenant)` is `ratecard.view`. The descriptions of `ratecard.view` / `ratecard.manage` now read "rate cards and fee schedules".

### Run tables added by Milestone 4

| Table / column | Purpose | Notes |
|---|---|---|
| `simulation_projects.kind`, `simulation_runs.kind` | Gain the value `forecast` (a forecast from assumptions) | A forecast project has no dataset and no synthetic order rows |
| `orders.seq` | Dense 1-based ordinal of the order within its file (by first shipment row) | Set by `finalize_order_dataset` (and back-filled by the migration); unique per dataset; drives the deterministic apportionment of per-order drivers and order content |
| `simulation_runs` (fee columns) | `fee_schedule_id` (composite FK), `monthly_fee_schedule_version_id`, `fee_rates` jsonb, `fee_engine_version`; period and volume: `forecast_from/to/days/months`, `month_profile`, `population_orders`, `period_orders`, `undated_orders`, `volume_basis` (`file` / `stated` / `none`), `monthly_orders`, `monthly_units`, `monthly_packages`, `monthly_shipments`; trusted totals: `processing_orders`, `processing_definite`, `processing_estimated`, `fee_status_counts`, `monthly_fixed`, `minimum_topup`, `minimum_status` (`exact` / `upper_bound` / `not_computed` / `none`), `projected_monthly` | The period and volume columns are written once by `start_simulation_run` and never recomputed in TypeScript. The trusted totals are written by `finish_simulation_run`; null means "fees were not modeled" (never zero) |
| `simulation_run_fee_contexts` | Which fee schedule version priced each fee date of a run (`fee_date`, `fee_schedule_version_id`, or `unavailable_reason` = `no_schedule` / `not_effective`) | One row per run and date; written by `advance_simulation_run` (and by `save_forecast_run` for a forecast's single date); select-only for users |
| `simulation_order_results` | One row per order of a bulk run: `first_row_no`, `order_month`, `fee_date`, `fee_schedule_version_id`, the order's `units`, `lines`, `distinct_skus`, `packages`, `shipments` (null = unknown), `assumed` flags, `fee_status` (`ok` / `partial` / `no_content` / `no_schedule` / `not_effective` / `date_missing` / `skipped`), `processing_definite` / `processing_estimated` (E4, bigint), `fee_lines` (`[feeDictionaryIndex, amountE4, 'd'\|'e']` against `reference_data.feeDictionary`), `unresolved`, `warning_codes`, `in_totals` | Unique `(run_id, order_id)` and `(run_id, first_row_no)`. `in_totals` is set at finish for orders that are both shipping-modeled and fee-priced (`ok` or `partial`); a per-order allocated or all-in amount is **not** a column, by design |
| `simulation_monthly_lines` | Monthly charges of a run, one row per monthly rule of the pinned version: `quantity`, `unit_amount`, `amount` (`numeric(14,4)`), `charge_class`, `status` (`priced` / `not_modeled`), `reason` | Written only by `finish_simulation_run`, from its own recomputation. Never joined to an order |

### Visibility rules for fee data

* 3PL staff with `ratecard.view` see every schedule, version (any status, drafts included), rule, source, note and assignment of their tenant; `ratecard.manage` is required for every write.
* A brand member of an **active brand** (in an active tenant) whose brand has an active assignment to the schedule sees the schedule row, its **active and archived** versions (never a draft or a discarded version), their rules and the brand's own assignment rows (`app.brand_has_fee_schedule`, `app.can_view_fee_version`). Archived versions stay readable because runs pinned to them must stay explainable. **Read this honestly:** the policy checks the status, not the dates, so an *active* version whose effective date is still in the future is readable through the Data API too, and what a brand can read includes the rules' `key` and `id` and the versions' `version_number` (identifiers, as in Milestone 3; the application's pages and exports never print them, but the database does not hide them). `fee_rule_sources` and `fee_schedule_version_notes` have no brand policy at all, so a brand reads no row of either; a sentinel string written into both is never returned to a brand (`tests/db/fees.test.ts` checks both tables, `fee_schedule_snapshot` and the `brand_fee_schedule_on` payload).
* Another brand of the same tenant, another tenant, an outsider and a platform administrator see nothing, and a brand that is moved to another schedule loses the old one at once (including the snapshot function).
* `simulation_run_fee_contexts`, `simulation_order_results` and `simulation_monthly_lines` are select-only and visible exactly when the run is (their policy is `run_id in (select id from simulation_runs)`, so the Milestone 3 rules apply: a brand sees its own brand's runs, staff-created runs only once shared). Unlike `simulation_run_contexts` (staff-only since Milestone 3), these three are readable by the brand's own members: they hold fee amounts, quantities and version ids for the brand's own models. A brand member can also read the stored `summary` and `reference_data` of its own runs, which name rules by key and id.
* `fee_schedule_snapshot(version)` (`SECURITY DEFINER`) authorises on the caller through `app.can_view_fee_version` and returns the rules in the engine's shape with `resolvedRuleKeys`, never a source or a note. `brand_fee_schedule_on(brand, date)` authorises with `app.can_model_brand` (the brand's own members with `simulation.run`, or the tenant's staff with `simulation.run`), finds the brand's active schedule (`app.brand_fee_schedule`, active schedules only) and the version in effect on the date (`app.fee_version_on`: an active or archived version whose dates cover the day, an active one first, then the highest version number) and returns `{status: "no_schedule"}`, `{status: "not_effective", scheduleId, name}` or `{status: "ok", snapshot}`.

### Rule validity (checked twice, in SQL)

`app.fee_rule_problem(rule)` is called by a `BEFORE INSERT/UPDATE` trigger on every rule write (SQLSTATE `22023`, message written for the editor) and again for every rule by `activate_fee_schedule_version`. It checks: the key is a short slug; the name is 1-120 characters; the category is one of `pick_pack`, `packaging`, `kitting`, `labeling`, `receiving`, `storage`, `returns`, `account`, `other`; scope, basis and method agree (order scope: `order`, `unit`, `line`, `sku`, `package`, `shipment`, `shipping_percent`, `order_driver`; monthly scope: `month`, `driver`, `minimum`; `percent` is the method of `shipping_percent` and only of it; `minimum` the method of `minimum` and only of it; `month`, `shipping_percent` and `minimum` cannot be tiered); `amount` is present on flat rules only, `percent` and `percent_base` on percent rules only; tiers (an object with exactly `on`, `mode`, `pricing`, `brackets`; 1-50 brackets, edges ascending, the last bracket open-ended, amounts non-negative with at most four decimals, graduated tiers priced per unit, monthly rules tier on the monthly quantity, order rules tier on the monthly quantity only on the bases `order`, `unit`, `package`, `shipment` priced per unit, no free allowance on a tiered rule); a free allowance only on `unit`, `line`, `sku`, `package`, `shipment` and `order_driver` rules; a per-occurrence minimum charge not on `month`, `minimum` or `shipping_percent` rules; conditions (order scope only, closed key set, whole numbers, `min` not above `max`, `packagingTypes` only on per-package rules, 1-50 distinct types already normalised or `"*"`); exclusive groups (order scope only, a slug, a priority exactly when there is a group); the driver object (required exactly on `driver` and `order_driver` rules, closed key set, a per-order driver is an `order_share`, a monthly driver is a `monthly_quantity` or a `returns_rate`, `billingPeriod` only on monthly quantities, `longTerm` with a mode, another rule's key and 1-3650 days); and the minimum object (closed key set, amount, boolean `includesShipping`, category and key lists).

`app.fee_version_problem(version, resolve)` runs at activation and checks what only the whole version can show: at least one rule; at most three account minimums; every key a minimum names exists; a minimum cannot count a flat monthly (`month`) charge or another minimum; the **resolved set** of each minimum (every rule except minimums and `month` rules that matches its categories, an empty category list meaning every rule, plus its included keys, minus its excluded keys) is not empty and the sets of the minimums are pairwise disjoint; each long-term rule refers to an existing standard monthly-quantity rule that has the same unit and billing period; the rules of one exclusive group share a basis and have distinct priorities; two rules that price the same packaging type (a `"*"` catch-all counts as pricing every type) must be in one exclusive group so that a priority decides; and rules that share a driver key agree on kind, unit and billing period. The resolved sets are then stored in `resolved_rule_keys`, which is what a customer sees as "fees counted toward this minimum".

### Fee guards

`app.fee_rule_guard`, `app.guard_fee_children` (sources and notes) and `app.guard_fee_version_update` keep a version immutable once it leaves draft: rules, sources and notes cannot change, identity columns (`schedule_id`, `tenant_id`, `version_number`) never change, an archived or discarded version cannot change status, and status, dates and `rule_count` change only inside the lifecycle functions (a GUC `app.fees_rpc` that only those `SECURITY DEFINER` functions set). `app.guard_fee_schedule_update` stops a direct status change of a schedule. Direct attempts to get around them are tested, including as the table owner.

### State transitions (functions only)

All `SECURITY DEFINER`, each authorising on the row it touches, none callable by `anon`:

* `create_fee_schedule(tenant, name, description, rounding)` creates an active schedule with an empty draft version 1 and returns `{scheduleId, versionId}`.
* `copy_fee_schedule_version(schedule, from_version)` starts the next draft, empty or copied from a version of the same schedule (rules keep their keys and get new ids; sources and notes are copied). One draft at a time; an archived schedule takes no new versions.
* `reorder_fee_rules(version, rule_ids)` renumbers a draft's rules; the list must name every rule exactly once.
* `activate_fee_schedule_version(version, effective, expiration)` runs the validity checks above, stores the resolved minimum sets and `rule_count`, and sets status, dates and `activated_by`. It refuses a date range that overlaps another active version of the schedule (`P0007`).
* `end_fee_schedule_version(version, expiration)` ends an active version on a date so a successor can start the next day; `archive_fee_schedule_version(version)` archives an active version or discards a draft; `archive_fee_schedule(schedule)` refuses while any customer is on it, then archives it and discards its draft.
* `assign_fee_schedule(brand, schedule)` needs a schedule of the brand's tenant that is active and has an active version (whatever its dates), ends the brand's current assignment in the same transaction and returns the new assignment id (assigning the schedule the brand is already on changes nothing); `unassign_fee_schedule(assignment)` ends one (a second call is a no-op).
* `fee_schedule_snapshot` and `brand_fee_schedule_on` (above) read; `dataset_forecast_period(dataset)` returns the period and volume figures of an orders file for the run form (same authorisation as the dataset).

Lifecycle errors use these SQLSTATEs: `42501` not allowed or not a draft, `22023` invalid parameter or rule problem, `P0001` refused by a business rule (a draft already exists, customers are still on the schedule), `P0002` / `P0003` not found (to the caller, a row it may not see does not exist), `P0004` wrong state (only a draft can be activated, only an active version ended), `P0005` the version as a whole is invalid, `P0007` the dates overlap another active version.

### Fee arithmetic in SQL

`app.fee_tier_amount(tiers, quantity)`, `app.fee_resolve_rate(tiers, quantity)`, `app.fee_line_amount(rule, quantity)` (flat or tiered, with the per-occurrence minimum charge, rounded to four decimals) and `app.fee_monthly_lines(version, answers, monthly_orders)` re-implement the monthly half of the fee engine (RULES.md B and E in `tests/fixtures/fees`): one row per monthly rule of a version, `priced` with its quantity and amount, or `not_modeled` with a reason (`no_answer`, `volume_unknown`, `replaced_rule_missing`). They are used by `start_simulation_run` (monthly-volume rates), `finish_simulation_run` and `save_forecast_run`. **Coverage, stated plainly:** the database tests check flat monthly rules, a long-term "replace" pair and a graduated monthly-volume rate (3 orders a month and 3,000) against hand-derived figures. They do not exercise, in SQL, volume or flat-bracket tiers, tiered monthly rules, weekly or daily billing periods, returns rates or per-occurrence minimum charges, and no test compares the SQL functions with the TypeScript engine directly, although the design called for one. The TypeScript side of those cases is golden-tested; a divergence in the untested SQL paths would make `finish_simulation_run` refuse the run (`PC003`) rather than store a wrong figure.

### Forecast period and volume of an orders file

Computed once, in SQL, by `app.dataset_period(dataset)` and stored on the run; TypeScript reads it and never recomputes it.

* **Population:** imported orders that are not cancelled and have at least one shipment. An order's date is its `order_date`, else its first shipment's `ship_date`. Undated orders are counted (`undated_orders`) and shown but do not set the span.
* **Period:** `from` and `to` are the 1st and 99th percentile of the dated population (`percentile_disc`, so both are real order dates), so one stray date cannot stretch the span in a file of at least 100 dated orders; below that nothing is trimmed and the span is the earliest to the latest date. `days = to - from + 1`; `period_orders` is the dated orders inside it and the rest are reported as trimmed. (No database test covers an outlier actually being trimmed; the tests use files with nothing to trim.)
* **Months:** the sum, over the calendar months the period touches, of (covered days in the month) / (days in the month), each fraction rounded to six decimals ("1.000000" for January 1-31, "2.838710" for January 3 to March 28). `month_profile` stores each month's fraction and the number of population orders dated inside it; the minimum evaluation and the allocation read it.
* **Volume:** `start_simulation_run` sets `volume_basis` to `stated` when the customer gave `fulfillment.monthlyOrders` (that number is used as it is); to `file` when the period covers at least 28 days, at least one order is inside it and none is stated (`monthly_orders = round(period_orders / months, 4)`); otherwise to `none` and `monthly_orders` stays null, so no allocated figure can be shown without a stated volume. Monthly units, packages and shipments scale the period's totals by `monthly_orders / period_orders` (units are null when any order in the period has no item count). They feed the monthly-volume tier rates.

### Runs with fees

* `start_simulation_run(project, basis, as_of, service_override, unmapped_policy, assumptions)` keeps its signature. It validates `assumptions.fulfillment` with `app.validate_fulfillment` (closed keys, answers are numbers up to four decimals, returns rates 0-100, order-share answers `{sharePct, countPerOrder}`, every answered key is a question of the pinned version, a long-term quantity never exceeds the stored one, 1-12 order-content rows whose shares add up to exactly 100.00, volume 1-5,000,000, at most 16 KB); computes the period and volume; pins the brand's active fee schedule; pins `monthly_fee_schedule_version_id` (the version in effect on the as-of date, else on the period's end; when none covers that date the latest version that started on or before it, so the monthly provenance shows its dates); and resolves the monthly-volume tier rates into `fee_rates`, a jsonb keyed by **version id** (`{versionId: {ruleKey: {rateE4, monthlyQuantity}}}`) for the monthly version and, on the ship-date basis, every active or archived version overlapping the period. A run with answers but no version in effect is refused. An identical live run is resumed; one with different settings is refused.
* `simulation_batch_input(run, limit)` returns whole orders from the cursor, each shipment row carrying the order's `orderUnits` (null = the file has none), `orderLines` and `orderSkus` (null when the dataset has no line data; see below), `orderNullSkuLines`, `orderSeq`, `orderShipments`, and per package `packagingType` and `packagingTypeNormalized` (`app.normalise_packaging`, the same normalisation the engine applies).
* **Line-derived quantities** come from one function, `app.order_line_counts`, read by both the batch input and `advance_simulation_run`: `lines` is the order's lines with units above zero and is **null when there are none**; `distinct_skus` is the number of distinct non-null SKUs and is **null when `lines` is null or any counted line has no SKU** (a per-product fee is then reported as not computed rather than undercounted).
* `advance_simulation_run(run, from, to, results, partial, contexts, order_results, fee_contexts)` (eight arguments; the old overload is dropped, and a test asserts that no function of the `public` schema has more than one overload) refuses, with `PC002` or `PC003`: a partial summary that is not version 2 (`PC002`), a window that does not start at the cursor, results that are not this run's own shipments, a partial that does not cover the window, an order-result count that is not exactly one per distinct order of the window (or names an order twice), a result whose shipments, packages or month differ from the file, units, lines or SKUs that differ from the file unless the result says the quantity was **assumed** (and an assumed quantity is accepted only where the file has none), a fee date that is not the run's as-of date (fixed-date basis) or the order's own date (ship-date basis), a fee context naming a version that is not of the run's schedule or not in effect on its date, a status that does not agree with its version, and fee lines whose definite and estimated sums differ from the two stored columns.
* `finish_simulation_run(run, summary, reference_data, engine_version, monthly_lines)` and what it recomputes are described next.

### What `finish_simulation_run` recomputes, and what stays application-computed

Recomputed in SQL from the stored rows (a disagreement raises `PC003`, and the run stays `running`):

* modeled orders, shipments and packages and the shipping totals (definite, estimated, expected), as in Milestone 3;
* that every order has a fee result, and that `reference_data.feeDictionary` names only rules (id, key, name, category, basis, scope) of versions this run pinned (fee contexts or the monthly version);
* the **processing totals** (orders, definite, estimated) over the orders that are shipping-modeled and fee-priced, which is also what marks `in_totals`, and the per-status counts stored in `fee_status_counts`;
* **every monthly line**, from the stored answers, the pinned monthly version and `monthly_orders` (`app.fee_monthly_lines`): the caller's lines must agree on status, quantity (to six decimals) and amount (E4), and their total must equal `summary.monthly.totalE4`; the rows are written to `simulation_monthly_lines` (class `definite` only for a flat `month` rule, `estimated` otherwise);
* **every minimum top-up and its status** per calendar month, from the stored order results (`app.run_minimums`): each rule's monthly sum is rounded to cents once and scaled by shipped/modeled orders when a month is not fully modeled; a month with incomplete coverage, a member of the set that is not modeled anywhere or unresolved on a processing order, or an undated processing order makes the status `upper_bound`; no month profile gives `not_computed`; the summary's per-minimum amounts, counted amounts and statuses and its folded `minimumStatus` must match, and a version with no minimum rule is `none`;
* the **projected monthly total** (`projected_monthly`): the shipping and processing of the processing orders scaled to the monthly volume when they are at least 80% of the population (else the period's own totals over its months), plus the monthly charges and an exact top-up, rounded once; `summary.allocation.monthly.total` must agree within one cent.

Not recomputed in SQL, and therefore trusted to the extent Milestone 3 already trusts the engine's output: the individual order-fee **amounts** (the function checks that they add up to the stored columns and that the quantities they were priced on are the file's, but not that amount = rate x quantity), the shipping amounts, the per-order averages, the completeness labels and the headline text. As in Milestone 3, a signed-in user with API access could post invented amounts into their **own** run; they could not touch another brand's rows.

**Forecast runs are application-computed.** `save_forecast_run(brand, rate_card, name, assumptions, summary, pins, engine_version, fee_engine_version)` creates the forecast project and a completed run in one transaction and pins the rate card version, rule versions, ZIP lists and the fee schedule version in effect on `asOfDate` (`simulation_run_contexts` and one `simulation_run_fee_contexts` row; `fee_rates` stays null, `total_shipments` is 0, `volume_basis` is `stated`). The expected shipping and processing figures, the allocation and the minimum amounts are the TypeScript forecast engine's and are **not** recomputed in SQL. The function checks only: the caller may model the brand and the rate card is assigned (`PC001`); the assumptions and answers validate (`app.validate_fulfillment` against the version in effect that day) and are at most 32 KB, the summary at most 256 KB; the identities `basis = assumptions`, `summary.monthlyOrders` equals the assumptions' volume, `weightSum` equals the volume, shipping and processing `definite` are 0, and `allIn.perOrder` is within one cent of shipping + processing + allocated per order (`PC003`); `pins.feeScheduleVersionId` is the version in effect on the date (`PC003`); and, when answers were given and fulfillment was not skipped, the monthly charges recomputed with `app.fee_monthly_lines` equal `summary.monthly.totalE4` and the minimum status says `none` exactly when the version has no minimum rule (`PC003`). Staff can save a forecast on a brand's behalf; like any staff scenario it is private until shared.

### SQLSTATE classes

Permanent failures of the run and forecast functions raise class `PC`, so callers can tell them from transient errors: **`PC001`** invalid input (bad settings or answers, a rate card that is not assigned, a date no schedule covers); **`PC002`** stale or incompatible client state (a version 1 partial summary on a running run, a summary version this release does not support); **`PC003`** does not reconcile (a window or result that does not belong to the run or the file, a summary that disagrees with the stored rows, a fee context that was not in effect, a forecast whose identities fail). `advanceRun` fails the run on any code that starts with `PC` and retries everything else.

### Audit

Triggers write `ratecard.fee_schedule_created`, `ratecard.fee_schedule_updated` (a rename or a status change), `ratecard.fee_version_active`, `ratecard.fee_version_ended`, `ratecard.fee_version_archived`, `ratecard.fee_version_discarded`, `ratecard.fee_assigned` and `ratecard.fee_unassigned` with ids, the schedule name, dates and counts (never rules, sources or notes); the `ratecard.` namespace stays trigger-only, so none can be forged through `log_audit_event()`. `modeling.run_started` / `run_completed` metadata now names the fee schedule and its monthly version, the volume basis, the processing order count, the minimum status and the engine versions; forecasts are audited as `modeling.run_started` with `kind: forecast`. The orders and monthly CSV exports log `export.run_orders` and `export.run_monthly` (the export is refused if the audit write fails).

## Planned tables (not yet created)

Added by later milestones, each with RLS from day one: adjustment records, reports, subscriptions, usage records.

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

(`ratecard.*` covers rate cards, surcharge rules and, from Milestone 4, fee schedules and their assignments; `simulation.run` covers models and forecasts; `report.view` is defined now and enforced by a later milestone's tables.)

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

Public RPC (authenticated only): `create_tenant`, `accept_invitation`, `revoke_invitation`, `log_audit_event`, `platform_set_tenant_status`, `is_platform_admin`, `check_rate_limit`, the pricing and modeling transitions/readers described above, and the fee-schedule functions (`create_fee_schedule`, `copy_fee_schedule_version`, `reorder_fee_rules`, `activate_fee_schedule_version`, `end_fee_schedule_version`, `archive_fee_schedule_version`, `archive_fee_schedule`, `assign_fee_schedule`, `unassign_fee_schedule`, `fee_schedule_snapshot`, `brand_fee_schedule_on`, `dataset_forecast_period`, `save_forecast_run`). Private fee helpers in `app`: `can_manage_fees`, `can_view_fees`, `brand_has_fee_schedule`, `can_view_fee_version`, `brand_fee_schedule`, `fee_version_on`, `normalise_packaging`, `fee_decimal_ok`, `fee_rule_problem`, `fee_version_problem`, the guard and audit triggers, `fee_tier_amount`, `fee_resolve_rate`, `fee_line_amount`, `fee_monthly_lines`, `dataset_period`, `validate_fulfillment`, `order_line_counts` and `run_minimums`.

### Lessons recorded in the schema

* `brands`' SELECT policy must not call a helper that queries `brands`: a helper cannot see a row inserted in the same statement, which breaks `INSERT … RETURNING` (and PostgREST insert-then-select). It uses `can_access_brand_row(id, tenant_id, status, …)` on the row's own columns. Found by the DB tests.
* The membership guard trigger is `SECURITY DEFINER`; otherwise its `SELECT … FOR UPDATE` is filtered by the caller's UPDATE policy and wrongly concludes no other admin exists. Found by the DB tests.

## Privileges

Default privileges for `anon`/`authenticated` on new `public` objects are revoked at the top of the first migration; every grant is explicit and, for writes, column-scoped. `service_role` keeps full access (it bypasses RLS by design). `anon` has no table grants and cannot execute any RPC. `supabase/config.toml` sets `auto_expose_new_tables = false` to match.

## Audit events recorded

`tenant.created|updated|status_changed`, `brand.created|updated|status_changed`, `membership.created|updated`, `invitation.created|accepted|revoked`. Application events via `log_audit_event` are limited to prefixes `simulation. scenario. report. export. import. billing. adjustment. session.` (never `ratecard.`, `carrier_rule.` or `modeling.`, which are trigger-only) and require tenant membership. Pricing, fee-schedule and modeling events are listed in their own sections above; the CSV exports log `export.run_results`, `export.run_orders` and `export.run_monthly`.

## Reproducing the schema from scratch

`tests/db/global-setup.ts` creates an empty database, installs the real Supabase Auth schema (GoTrue migrations), then applies every migration in order. That runs on every `npm run test:db`.
