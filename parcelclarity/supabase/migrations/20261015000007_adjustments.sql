-- ===========================================================================
-- Milestone 5: adjustment risk.
--
-- What this file adds
--   * SECTION 0: shared objects and leak fixes that earlier milestones got wrong or that M5 must
--     narrow (log_audit_event, uploaded_files, nullable actor columns, staff-only copies of the two
--     free-text fields brand members could read, load-issue text and run error text).
--   * Seven STAFF-ONLY tables (policies, imports, history records, baselines, saved scenarios, saved
--     risk estimates, published examples). Brands have no policy, no grant and no view on any of
--     them. The only thing a brand ever receives is public.brand_adjustment_examples(brand), which
--     returns an explicit projection of a payload built IN SQL from the stored staff scenario and
--     checked by a closed allow-list guard (app.customer_json_ok).
--   * Every write goes through a SECURITY DEFINER function guarded by BEFORE INSERT/UPDATE/DELETE triggers
--     keyed on the transaction-local setting app.adjustment_rpc. No table has an INSERT, UPDATE or
--     DELETE grant for the Data API roles and no write policy.
--   * Audit rows (adjustment.*) are written by AFTER triggers only; log_audit_event() no longer
--     accepts the namespace from clients.
--
-- Hard rules this schema enforces
--   * No carrier buy rate is ever stored: every amount column is a customer-facing amount, the
--     import functions re-run the forbidden-header test, and an attestation is stored and audited.
--   * Unknown is NULL, never 0 (blank money stays NULL; a record without amounts counts for
--     incidence only).
--   * No application or API path lets a platform administrator read M5 data: no M5 policy or
--     function references is_platform_admin(). Operators with database or service credentials can
--     read it (SECURITY.md says so).
--   * Error text never contains row values. Business refusals use SQLSTATE class P0 (P0001
--     refusal, P0002 not found, P0004 wrong state, P0007 overlap), bad input and reconciliation
--     use PC001 / PC002 / PC003 as in M4; 42501 means "no permission" for tenant-scoped calls.
--
-- Shared objects this migration changes (the "sweep"; each has a DB test, and nothing else in M1-M4 was touched):
--   * log_audit_event (same signature; the adjustment namespace removed from the client allow-list).
--   * uploaded_files: purpose check (+adjustment_import), the files_read / files_insert policies (named purposes only), a BEFORE
--     INSERT guard trigger for adjustment files, and four actor columns made nullable (so deleting a user works).
--   * rate_card_service_terms.source_reference and customer_surcharge_overrides.reference are DROPPED (copied to staff-only tables).
--   * simulation_runs: summary / reference_data / partial_summary / error stop carrying staff diagnostics (backfilled for EVERY
--     status, a running run included); finish_simulation_run, fail_simulation_run, cancel_simulation_run, advance_simulation_run
--     (same 8 arguments) and save_forecast_run are redefined to strip load-issue text; simulation_run_failures is new.
--   * surcharge_rule_versions: a reweigh, remeasure or correction fee is a conditional charge (insert, class change AND publish are
--     refused otherwise; draft versions were backfilled to conditional).
--   * pricing_rules_for_card gains a fifth argument and the D8 filter (the old four-argument function is dropped).
--   * rate_card_service_term_sources has a guard that lets a cascade from a deleted DRAFT term through.
--   * the supabase_realtime publication, when one exists, is emptied of public tables (app.sweep_realtime_publication).
--   * EXECUTE: the final "revoke all on all functions in schema app from public, anon" removes the implicit PUBLIC (and so
--     authenticated) EXECUTE from these 21 functions that existed before M5: audit_fees, audit_modeling, dataset_period,
--     default_sharing, fee_decimal_ok, fee_line_amount, fee_monthly_lines, fee_resolve_rate, fee_rule_guard, fee_rule_problem,
--     fee_tier_amount, fee_version_problem, guard_dataset_update, guard_fee_children, guard_fee_schedule_update,
--     guard_fee_version_update, limit_file_inserts, normalise_packaging, order_line_counts, run_minimums, validate_fulfillment.
--     Nothing needs them: trigger functions are not EXECUTE-checked when a trigger fires, the others are called only from
--     SECURITY DEFINER functions (which run as their owner), and a catalog scan finds no policy, CHECK constraint, column default,
--     generated column, index expression or SECURITY INVOKER function that calls one (tests/db/adjustments-confidentiality.test.ts
--     repeats the scan, so a later CHECK or DEFAULT that needs one fails the build and EXECUTE is restored only for that function).
--
-- Write guard (BEFORE INSERT/UPDATE/DELETE triggers): a change passes only inside an M5 function. The signal is the transaction-local
-- setting app.adjustment_rpc, which ANY session can set, so it is not trusted alone: the guard ALSO refuses every statement whose
-- current_user is a Data API role (anon, authenticated, authenticator). Inside a SECURITY DEFINER function current_user is the
-- function's owner, and a foreign-key action runs as the table owner, so neither is affected. The Data API roles also hold SELECT
-- only on these tables and no write policy exists (tests assert all three layers; a later grant alone cannot open a write path).
--
-- Raw history files: an uploaded history file is bounded without an expiry job. The BEFORE INSERT trigger refuses a file whose
-- first 50 lines hold a cost-like header (reason forbidden_header), a UTF-16 / NUL file (unsupported_encoding), and a sixth
-- UNATTACHED file for the account (too_many_unattached_files); create_adjustment_import allows at most 5 in-progress imports. So an
-- account holds at most 5 unattached plus 5 attached raw files (10 x 5 MB = 50 MB) at any moment; an attached file is deleted when
-- its import commits, is discarded or is withdrawn; an unattached one only through discard_unattached_adjustment_file (or the
-- offboarding purge). An expiry job for abandoned uploads is an M9 item.
--
-- JSON contracts the TypeScript layer must honour (the documentation pass copies them into DATABASE.md):
--   adjustment_scenarios.input   {"v":1,"serviceId":uuid,"residential":bool,"zone":int|null,
--                                 "declaredSource":"entered"|"wms_fallback",
--                                 "declared":{"packages":[{"weightLb":"3","lengthIn"?:"10","widthIn"?:"8","heightIn"?:"6"}]},
--                                 "corrected":{"packages":[ ... same count ... ]}, ...staff-only extras}
--   adjustment_scenarios.result  {"v":1,"status":ok|no_adjustment|declared_unavailable|corrected_unavailable|both_unavailable|invalid_input,
--                                 "adjustmentType":reweight|remeasure|combined,"direction":increase|decrease|none,
--                                 "basis":exact|estimate,
--                                 "components":[{"kind":postage_difference|separate_fee,
--                                                "state":conditional|waived_for_customer|included_in_rate|undecided|not_configured|not_triggered,
--                                                "amount":"5.30"|null,"declaredTotal"?:"17.83","correctedTotal"?:"23.13",
--                                                "handling"?:absorbed|pass_through|manual_approval|unconfigured,
--                                                "engineHandling"?:absorbed|pass_through|manual_approval|unconfigured|mixed,
--                                                "lines"?:[{"ruleKey":text,"amount"?:money,"handling":absorbed|pass_through|manual_approval|unconfigured,...}]}],
--                                 ...staff-only extras}
--                                (build_customer_example refuses an example, problem mixed_handling, when a component's engineHandling is
--                                 "mixed" or when its engineHandling or any line's handling differs from the handling resolved TODAY for that
--                                 line's policy row: shipping_charge_correction lines via the 'correction' separate_fee row, reweigh and
--                                 remeasure fee lines via the scenario type's separate_fee row, postage via the type's postage_difference row)
--   save_adjustment_scenario p_pins {"rateCardVersionId":uuid,"ruleVersionIds":[uuid],"overrideIds":[uuid],"pricedOn":date,
--                                 "ruleKeysInForce"?:[text] (the `key` of every rule pricing_rules_for_card(card, pricedOn, brand, null, true) returned),
--                                 "zipListVersionIds"?:[uuid] (the `id` of every zipLists entry of that same call)}.
--                                When the two optional arrays are absent the database computes them itself, at save time, from the same
--                                query; either way they are stored in adjustment_scenarios.pricing_context and compared again at preview,
--                                publish and read time: a different set of rule keys in force, or a ZIP list version that is no longer the
--                                one in force, makes an example "under review" (cause rule_changed / zip_list_changed) and makes
--                                preview and publish refuse it (problem context_changed).
--   risk_estimates.inputs        {"adjustmentType"?:..., "importIds"?:[uuid...] (imports it was derived from), ...} (k, N, window and filters BY VALUE)
--   risk_estimates.result        {"v":1,"buckets":{"customerPays":E4,"decidedCaseByCase":E4,"notBilledToCustomer":E4,"notDecided":E4},
--                                 "countedE4":E4, "handling"?:{postage_difference|separate_fee: handling}, ...}
--                                (when "buckets" is present the four add up to "countedE4"; "handling" must equal today's resolution)
--   published payload and brand_adjustment_examples(): see app.shape_published_payload() and app.shape_brand_example().
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SECTION 0.1: permissions and authorization helpers
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('adjustment.view',   'View adjustment policies, history, examples and risk estimates (Milestone 5).'),
  ('adjustment.manage', 'Set adjustment policies, import adjustment history, build and share adjustment examples (Milestone 5).');
insert into public.role_permissions (role_key, permission_key) values
  ('tenant_admin', 'adjustment.view'), ('tenant_admin', 'adjustment.manage');

-- Helpers read memberships through has_tenant_permission, which requires an ACTIVE tenant and a
-- tenant-level (brand_id is null) membership: brand members and non-members can never match.
create function app.can_view_adjustments(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'adjustment.view') or app.has_tenant_permission(p_tenant, 'adjustment.manage');
$$;

create function app.can_manage_adjustments(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'adjustment.manage');
$$;

-- Hoisted set form for the SELECT policies: the permission is evaluated once per statement, not per row.
create function app.adjustment_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id and t.status = 'active'
  join public.role_permissions rp on rp.role_key = m.role_key and rp.permission_key in ('adjustment.view', 'adjustment.manage')
  where m.user_id = (select auth.uid()) and m.brand_id is null and m.status = 'active';
$$;

revoke all on function app.can_view_adjustments(uuid), app.can_manage_adjustments(uuid), app.adjustment_tenant_ids() from public, anon;
grant execute on function app.can_view_adjustments(uuid), app.can_manage_adjustments(uuid), app.adjustment_tenant_ids() to authenticated, service_role;

-- Today as a calendar date in UTC. current_date follows the session time zone, which a Data API client controls (PostgREST honours
-- "Prefer: timezone=..."), so no M5 function uses it: expiry edges and "starts today" must not move with the caller.
create function app.utc_today() returns date
language sql stable parallel safe set search_path = '' as $$
  select (now() at time zone 'UTC')::date;
$$;

-- The canonical form of a package reference (carrier tracking number or equivalent), used for the unique index and every duplicate
-- check: Unicode compatibility normalisation (NFKC: fullwidth letters and digits, ligatures, roman numerals), then ALL whitespace and
-- invisible format characters removed (zero-width space and joiners, soft hyphen, bidi marks, byte order mark, tag characters), then
-- ASCII letters upper-cased (other letters are kept as they are: SQL and TypeScript then agree on every input whatever the server
-- locale). NULL when the input is NULL, holds the replacement character U+FFFD (bytes that were not valid text), or has nothing left.
-- The TypeScript library implements the identical function; tests/fixtures/adjustments/package-refs.json is the shared list.
create function app.canon_package_ref(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p is null or position(chr(65533) in p) > 0 then null
    else nullif(translate(
           regexp_replace(normalize(p, nfkc),
             '[ \t\n\r\f\v\u0085\u1680\u2028\u2029\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]',
             '', 'g'),
           'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '')
  end;
$$;

-- ---------------------------------------------------------------------------
-- SECTION 0.2: log_audit_event no longer accepts the adjustment namespace
-- (identical signature, so no second overload is created; copied from the M2 definition)
-- ---------------------------------------------------------------------------
create or replace function public.log_audit_event(p_tenant uuid, p_brand uuid, p_action text,
                                                  p_entity_type text default null, p_entity_id text default null,
                                                  p_metadata jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_action !~ '^(simulation|scenario|report|export|import|billing|session)\.[a-z_]{2,40}$' then
    raise exception 'audit action not permitted' using errcode = '42501';
  end if;
  if not app.is_member_of_tenant(p_tenant) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;
  if p_brand is not null and not app.has_brand_permission(p_brand, 'brand.view') then
    raise exception 'no access to brand' using errcode = '42501';
  end if;
  if p_brand is not null and not exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = p_tenant) then
    raise exception 'brand does not belong to tenant' using errcode = '42501';
  end if;
  perform app.write_audit(p_tenant, p_brand, p_action, p_entity_type, left(p_entity_id, 200), p_metadata);
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 0.3: uploaded_files (a third purpose, and the policies narrowed to named purposes)
-- ---------------------------------------------------------------------------
alter table public.uploaded_files drop constraint uploaded_files_purpose_check;
alter table public.uploaded_files add constraint uploaded_files_purpose_check
  check (purpose in ('rate_card', 'zone_chart', 'zip_list', 'order_import', 'adjustment_import'));
-- The byte-size check is unchanged: 15 MB for order files, 5 MB for everything else (a 20,000-row history file is about 3 MB).

drop policy files_read on public.uploaded_files;
drop policy files_insert on public.uploaded_files;
-- Pricing documents: pricing managers only (no longer "every purpose that is not an order file").
-- Order files follow their dataset (unchanged). Adjustment history files: adjustment managers only, never brand-scoped.
create policy files_read on public.uploaded_files for select to authenticated
  using ((purpose in ('rate_card', 'zone_chart', 'zip_list') and app.can_manage_pricing(tenant_id))
         or (purpose = 'order_import' and brand_id is not null and app.can_model_brand(tenant_id, brand_id)
             and (app.is_tenant_staff(tenant_id) or uploaded_by = (select auth.uid()) or app.order_file_shared(id)))
         or (purpose = 'adjustment_import' and brand_id is null and app.can_manage_adjustments(tenant_id)));
create policy files_insert on public.uploaded_files for insert to authenticated
  with check (uploaded_by = (select auth.uid())
              and ((purpose = 'order_import' and brand_id is not null and app.can_model_brand(tenant_id, brand_id))
                   or (purpose in ('rate_card', 'zone_chart', 'zip_list') and brand_id is null and app.can_manage_pricing(tenant_id))
                   or (purpose = 'adjustment_import' and brand_id is null and app.can_manage_adjustments(tenant_id))));

-- ---------------------------------------------------------------------------
-- SECTION 0.4: actor columns that blocked deleting a user (NOT NULL combined with ON DELETE SET NULL)
-- ---------------------------------------------------------------------------
alter table public.uploaded_files alter column uploaded_by drop not null;
alter table public.order_datasets alter column created_by drop not null;
alter table public.simulation_projects alter column created_by drop not null;
alter table public.simulation_runs alter column created_by drop not null;

-- ---------------------------------------------------------------------------
-- SECTION 0.5: staff-only copies of the two free-text fields brand members could read
--   rate_card_service_terms.source_reference  -> rate_card_service_term_sources (staff only)
--   customer_surcharge_overrides.reference    -> customer_surcharge_override_notes (staff only)
-- The brand-readable columns are DROPPED (not blanked), so a column snapshot proves they are gone.
-- ---------------------------------------------------------------------------
create table public.rate_card_service_term_sources (
  term_id          uuid primary key references public.rate_card_service_terms (id) on delete cascade,
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  source_reference text not null check (char_length(source_reference) between 1 and 500),
  updated_by       uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now()
);

create table public.customer_surcharge_override_notes (
  override_id uuid primary key references public.customer_surcharge_overrides (id) on delete cascade,
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  reference   text not null check (char_length(reference) between 1 and 300),
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

insert into public.rate_card_service_term_sources (term_id, tenant_id, source_reference, updated_by)
select t.id, v.tenant_id, t.source_reference, null
from public.rate_card_service_terms t join public.rate_card_versions v on v.id = t.version_id;
insert into public.customer_surcharge_override_notes (override_id, tenant_id, reference, updated_by)
select o.id, o.tenant_id, o.reference, null from public.customer_surcharge_overrides o;

alter table public.rate_card_service_terms drop column source_reference;
alter table public.customer_surcharge_overrides drop column reference;

-- A term's source follows the term: editable only while its version is a draft.
create function app.guard_term_sources() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_term uuid;
begin
  v_term := case when tg_op = 'DELETE' then old.term_id else new.term_id end;
  select v.status into v_status
    from public.rate_card_service_terms t join public.rate_card_versions v on v.id = t.version_id
   where t.id = v_term for key share of v;
  -- A cascade from a deleted DRAFT term reaches this trigger after the term (and so its version lookup) is gone: that is the
  -- only way a delete finds no term, because the foreign key forbids a source without one. Let it through.
  if tg_op = 'DELETE' and not found then return old; end if;
  if v_status is distinct from 'draft' then
    raise exception 'rate card version is not a draft; its term sources cannot change' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' then
    new.updated_by := (select auth.uid()); new.updated_at := now();
    if tg_op = 'UPDATE' and (new.term_id <> old.term_id or new.tenant_id <> old.tenant_id) then
      raise exception 'term source identity columns are immutable' using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger term_sources_guard before insert or update or delete on public.rate_card_service_term_sources
  for each row execute function app.guard_term_sources();

create function app.guard_override_notes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    new.updated_by := (select auth.uid()); new.updated_at := now();
    if tg_op = 'UPDATE' and (new.override_id <> old.override_id or new.tenant_id <> old.tenant_id) then
      raise exception 'override note identity columns are immutable' using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger override_notes_guard before insert or update or delete on public.customer_surcharge_override_notes
  for each row execute function app.guard_override_notes();

alter table public.rate_card_service_term_sources enable row level security;
alter table public.customer_surcharge_override_notes enable row level security;
-- Staff only (ratecard.view reads, ratecard.manage writes); brands have no policy at all.
create policy term_sources_read on public.rate_card_service_term_sources for select to authenticated
  using (app.has_tenant_permission(tenant_id, 'ratecard.view'));
create policy term_sources_write on public.rate_card_service_term_sources for all to authenticated
  using (app.can_manage_pricing(tenant_id))
  with check (app.can_manage_pricing(tenant_id)
              and exists (select 1 from public.rate_card_service_terms t join public.rate_card_versions v on v.id = t.version_id
                          where t.id = term_id and v.tenant_id = rate_card_service_term_sources.tenant_id));
create policy override_notes_read on public.customer_surcharge_override_notes for select to authenticated
  using (app.has_tenant_permission(tenant_id, 'ratecard.view'));
create policy override_notes_write on public.customer_surcharge_override_notes for all to authenticated
  using (app.can_manage_pricing(tenant_id))
  with check (app.can_manage_pricing(tenant_id)
              and exists (select 1 from public.customer_surcharge_overrides o where o.id = override_id and o.tenant_id = customer_surcharge_override_notes.tenant_id));
grant select on public.rate_card_service_term_sources, public.customer_surcharge_override_notes to authenticated;
grant insert (term_id, tenant_id, source_reference), update (source_reference), delete on public.rate_card_service_term_sources to authenticated;
grant insert (override_id, tenant_id, reference), update (reference), delete on public.customer_surcharge_override_notes to authenticated;
grant all on public.rate_card_service_term_sources, public.customer_surcharge_override_notes to service_role;

-- ---------------------------------------------------------------------------
-- SECTION 0.6: run summaries and run errors stop carrying staff diagnostics
--   * summary.loadIssues (strings naming the 3PL's rules) -> summary.loadIssueCount; the text stays in
--     simulation_run_contexts.load_issues, which only staff can read.
--   * simulation_runs.error (server exception text) -> a code; the detail moves to a staff-only table.
-- ---------------------------------------------------------------------------
create function app.summary_without_load_issues(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' or not (p ? 'loadIssues') then p
    else (p - 'loadIssues') || jsonb_build_object('loadIssueCount',
           case when jsonb_typeof(p -> 'loadIssues') = 'array' then jsonb_array_length(p -> 'loadIssues') else 0 end)
  end;
$$;
revoke all on function app.summary_without_load_issues(jsonb) from public, anon, authenticated;
grant execute on function app.summary_without_load_issues(jsonb) to service_role;

create table public.simulation_run_failures (
  run_id    uuid primary key references public.simulation_runs (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  detail    text not null check (char_length(detail) between 1 and 1000),
  created_at timestamptz not null default now()
);
alter table public.simulation_run_failures enable row level security;
create policy simulation_run_failures_read on public.simulation_run_failures for select to authenticated
  using (app.is_tenant_staff(tenant_id) and run_id in (select r.id from public.simulation_runs r));
grant select on public.simulation_run_failures to authenticated;
grant all on public.simulation_run_failures to service_role;

-- Backfill: summaries of finished runs, and the in-flight state of EVERY run (a run that is still running when this migration is
-- applied keeps no load-issue text either; the functions below strip what a later window, a cancel or a failure would store).
update public.simulation_runs
   set summary = app.summary_without_load_issues(summary)
 where summary ? 'loadIssues';
update public.simulation_runs
   set partial_summary = app.summary_without_load_issues(partial_summary)
 where partial_summary ? 'loadIssues';
-- Forecast runs keep their pins in reference_data.
update public.simulation_runs
   set reference_data = app.summary_without_load_issues(reference_data)
 where reference_data ? 'loadIssues';

insert into public.simulation_run_failures (run_id, tenant_id, detail)
select r.id, r.tenant_id, left(r.error, 1000) from public.simulation_runs r where r.error is not null and btrim(r.error) <> '';
-- (A blank error was never a diagnostic: it becomes "no error", not a failure code.)
update public.simulation_runs set error = case when btrim(error) = '' then null else 'run_failed' end where error is not null;
alter table public.simulation_runs add constraint simulation_runs_error_is_code
  check (error is null or error ~ '^[a-z][a-z0-9_]{1,39}$');

-- The detail is kept for staff; callers still pass the exception text (the signature is unchanged).
create or replace function public.fail_simulation_run(p_run uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r public.simulation_runs%rowtype;
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) or not app.project_visible(v_r.project_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then return; end if;
  update public.simulation_runs set status = 'failed',
         -- A caller-supplied slug is kept as the code; anything else (free text) becomes 'run_failed'.
         error = case when p_error ~ '^[a-z][a-z0-9_]{1,39}$' then p_error else 'run_failed' end,
         -- Whatever an earlier window stored (a run that was in flight when this migration ran) loses its load-issue text now.
         partial_summary = app.summary_without_load_issues(partial_summary),
         finished_at = now()
   where id = p_run;
  insert into public.simulation_run_failures (run_id, tenant_id, detail)
  values (p_run, v_r.tenant_id, left(coalesce(nullif(btrim(p_error), ''), 'unknown error'), 1000))
  on conflict (run_id) do nothing;
end $$;


-- ---------------------------------------------------------------------------
-- SECTION 0.7: a reweigh, remeasure or correction fee is a conditional charge (never counted in a total)
-- Equivalent to a NOT VALID check: enforced for every new version and every change of charge class, existing rows are left alone.
-- (A CHECK cannot reach the rule's category, which lives on surcharge_rules, so this is a trigger.)
-- ---------------------------------------------------------------------------
create function app.guard_adjustment_fee_class() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_category text;
begin
  if tg_op = 'UPDATE' and new.charge_class is not distinct from old.charge_class then return new; end if;
  select r.category into v_category from public.surcharge_rules r where r.id = new.rule_id;
  if v_category in ('reweight', 'remeasure', 'shipping_charge_correction') and new.charge_class <> 'conditional' then
    raise exception 'a reweigh, remeasure or correction fee is a conditional charge' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger srv_adjustment_fee_class before insert or update of charge_class on public.surcharge_rule_versions
  for each row execute function app.guard_adjustment_fee_class();

-- Versions that existed before this migration are not touched by the trigger above (it fires on a change of charge class), so:
--   1. every DRAFT version of such a rule is made conditional now (a draft carries no price anyone has seen), and
--   2. a version can no longer BECOME published (publish_surcharge_rule_version, or any other path that sets the status) unless it
--      is conditional. A legacy PUBLISHED version of another class is left alone, because changing it would rewrite what customers
--      were shown: public.adjustment_legacy_fee_rules(tenant) lists them so the 3PL can retire and republish them as conditional.
update public.surcharge_rule_versions v set charge_class = 'conditional'
  from public.surcharge_rules r
 where r.id = v.rule_id and r.category in ('reweight', 'remeasure', 'shipping_charge_correction') and v.status = 'draft' and v.charge_class <> 'conditional';

create function app.guard_adjustment_fee_class_publish() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_category text;
begin
  select r.category into v_category from public.surcharge_rules r where r.id = new.rule_id;
  if v_category in ('reweight', 'remeasure', 'shipping_charge_correction') and new.charge_class <> 'conditional' then
    raise exception 'a reweigh, remeasure or correction fee is a conditional charge; make this version conditional before it is published' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger srv_adjustment_fee_class_publish before update of status on public.surcharge_rule_versions
  for each row when (new.status = 'published' and old.status is distinct from 'published') execute function app.guard_adjustment_fee_class_publish();

-- ---------------------------------------------------------------------------
-- SECTION 1: the seven staff-only tables
-- ---------------------------------------------------------------------------
-- 1.1 Who pays for a correction (one decision per type and component; the brand's own row beats the tenant default).
create table public.adjustment_policies (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete restrict,
  brand_id        uuid,
  adjustment_type text not null check (adjustment_type in ('reweight', 'remeasure', 'combined', 'correction')),
  component       text not null check (component in ('postage_difference', 'separate_fee')),
  handling        text not null check (handling in ('absorbed', 'pass_through', 'manual_approval')),
  valid_from      date not null,
  valid_to        date,
  internal_note   text check (internal_note is null or char_length(internal_note) <= 1000),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (id, tenant_id),
  constraint adjustment_policies_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  -- Seven valid pairs: reweight, remeasure and combined x both components, and a correction fee has only the separate fee.
  constraint adjustment_policies_valid_pair check (adjustment_type <> 'correction' or component = 'separate_fee'),
  constraint adjustment_policies_dates check (valid_to is null or valid_to >= valid_from),
  -- NULL brand_id (the tenant default) must still collide with itself, hence the zero uuid.
  constraint adjustment_policies_no_overlap exclude using gist (
    tenant_id with =,
    coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    adjustment_type with =, component with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  )
);
create index adjustment_policies_tenant_idx on public.adjustment_policies (tenant_id, adjustment_type, component);

-- 1.2 Imported history (one row per file). The raw file is deleted when the import is committed, discarded or withdrawn.
create table public.adjustment_imports (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete restrict,
  file_id            uuid,
  name               text not null check (char_length(btrim(name)) between 1 and 160),
  status             text not null default 'uploaded' check (status in ('uploaded', 'mapped', 'validated', 'committing', 'committed', 'discarded', 'withdrawn')),
  -- Header names and at most 20 sample rows of MAPPED columns; never stored for a refused file.
  detected           jsonb not null default '{}'::jsonb check (jsonb_typeof(detected) = 'object' and pg_column_size(detected) <= 65536),
  mapping            jsonb check (mapping is null or (jsonb_typeof(mapping) = 'object' and pg_column_size(mapping) <= 8192)),
  validation         jsonb check (validation is null or (jsonb_typeof(validation) = 'object' and pg_column_size(validation) <= 32768)),
  duplicate_handling text not null default 'refuse' check (duplicate_handling in ('refuse', 'sum', 'first')),
  -- row_count: rows in the file; accepted_count: rows the caller will send; committed_count: stored; skipped_count: already imported.
  row_count          integer not null default 0 check (row_count >= 0),
  accepted_count     integer not null default 0 check (accepted_count >= 0),
  committed_count    integer not null default 0 check (committed_count >= 0),
  skipped_count      integer not null default 0 check (skipped_count >= 0),
  attested_by        uuid references auth.users (id) on delete set null,
  attested_at        timestamptz,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  committed_at       timestamptz,
  unique (id, tenant_id),
  -- Plain SET NULL would also null tenant_id (NOT NULL); only the file column is cleared.
  constraint adjustment_imports_file_in_tenant foreign key (file_id, tenant_id) references public.uploaded_files (id, tenant_id) on delete set null (file_id),
  constraint adjustment_imports_cursor check (committed_count + skipped_count <= accepted_count or status in ('uploaded', 'mapped', 'discarded', 'withdrawn')),
  -- (attested_by may become NULL later, when that user is deleted; the moment of the attestation stays.)
  constraint adjustment_imports_committed_attested check (status <> 'committed' or attested_at is not null)
);
create unique index adjustment_imports_file_key on public.adjustment_imports (file_id) where file_id is not null;
create index adjustment_imports_tenant_idx on public.adjustment_imports (tenant_id, created_at desc);

-- 1.3 One row per corrected package (carrier adjustment). Every amount is a CUSTOMER-FACING charge; blank stays NULL, never 0.
create table public.adjustment_records (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  import_id             uuid not null,
  row_no                integer not null check (row_no >= 1),
  brand_id              uuid,
  ship_date             date not null check (ship_date >= date '2015-01-01' and ship_date <= date '2100-01-01'),
  adjusted_on           date check (adjusted_on is null or (adjusted_on >= ship_date and adjusted_on <= date '2100-01-01')),
  carrier_code          text not null references public.carriers (code),
  service_id            uuid references public.shipping_services (id) on delete set null,
  service_text          text check (service_text is null or char_length(service_text) <= 160),
  adjustment_type       text not null check (adjustment_type in ('reweight', 'remeasure', 'combined', 'correction')),
  cause                 text not null check (cause in ('wms_no_weight', 'scale_error', 'carrier_reweigh', 'carrier_remeasure', 'packaging_change', 'other')),
  reason_text           text check (reason_text is null or char_length(reason_text) <= 120),
  -- A carrier tracking number (or equivalent), unique per carrier; an order number alone is not a package reference. Always stored in
  -- its canonical form (app.canon_package_ref: NFKC, no whitespace or invisible characters, ASCII upper case) so 'x', 'X' and ' X' are
  -- one package for the unique index, the duplicate checks and the "already imported" count.
  package_ref           text check (package_ref is null or char_length(package_ref) between 1 and 120),
  declared_weight_lb    numeric(12,6) check (declared_weight_lb is null or declared_weight_lb > 0),
  declared_weight_basis text not null default 'measured' check (declared_weight_basis in ('measured', 'fallback', 'missing')),
  actual_weight_lb      numeric(12,6) check (actual_weight_lb is null or actual_weight_lb > 0),
  orig_length_in        numeric(10,4) check (orig_length_in is null or orig_length_in > 0),
  orig_width_in         numeric(10,4) check (orig_width_in is null or orig_width_in > 0),
  orig_height_in        numeric(10,4) check (orig_height_in is null or orig_height_in > 0),
  corr_length_in        numeric(10,4) check (corr_length_in is null or corr_length_in > 0),
  corr_width_in         numeric(10,4) check (corr_width_in is null or corr_width_in > 0),
  corr_height_in        numeric(10,4) check (corr_height_in is null or corr_height_in > 0),
  original_charge       numeric(12,2) check (original_charge is null or original_charge >= 0),
  corrected_charge      numeric(12,2) check (corrected_charge is null or corrected_charge >= 0),
  separate_fee          numeric(12,2) check (separate_fee is null or separate_fee >= 0),
  -- Informational only (what the file said happened); forecasts always use the policy.
  handling_recorded     text check (handling_recorded is null or handling_recorded in ('absorbed', 'pass_through', 'manual_approval')),
  postage_difference    numeric(12,2) generated always as (case when corrected_charge is not null and original_charge is not null then corrected_charge - original_charge end) stored,
  unique (import_id, row_no),
  constraint adjustment_records_import_in_tenant foreign key (import_id, tenant_id) references public.adjustment_imports (id, tenant_id) on delete cascade,
  constraint adjustment_records_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint adjustment_records_orig_dims_all_or_none check ((orig_length_in is null) = (orig_width_in is null) and (orig_width_in is null) = (orig_height_in is null)),
  constraint adjustment_records_corr_dims_all_or_none check ((corr_length_in is null) = (corr_width_in is null) and (corr_width_in is null) = (corr_height_in is null)),
  constraint adjustment_records_weight_basis check ((declared_weight_basis = 'missing') = (declared_weight_lb is null)),
  constraint adjustment_records_package_ref_canonical check (package_ref is null or package_ref = app.canon_package_ref(package_ref))
);
create unique index adjustment_records_package_key on public.adjustment_records
  (tenant_id, coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), carrier_code, package_ref, adjustment_type)
  where package_ref is not null;
create index adjustment_records_ship_idx on public.adjustment_records (tenant_id, ship_date);
create index adjustment_records_brand_ship_idx on public.adjustment_records (tenant_id, brand_id, ship_date);

-- 1.4 Denominators: how many packages shipped in a window (typed by staff). Never summed across scopes.
create table public.adjustment_baselines (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  brand_id              uuid,
  carrier_code          text references public.carriers (code),
  service_id            uuid references public.shipping_services (id) on delete restrict,
  period_start          date not null check (period_start >= date '2015-01-01'),
  period_end            date not null check (period_end <= date '2100-01-01'),
  packages_total        integer not null check (packages_total > 0),
  labels_missing_weight integer check (labels_missing_weight is null or labels_missing_weight >= 0),
  note                  text check (note is null or char_length(note) <= 1000),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  unique (id, tenant_id),
  constraint adjustment_baselines_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint adjustment_baselines_period check (period_end >= period_start),
  constraint adjustment_baselines_missing check (labels_missing_weight is null or labels_missing_weight <= packages_total),
  -- Two baselines of one scope never overlap in time, so a denominator is never double counted.
  constraint adjustment_baselines_no_overlap exclude using gist (
    tenant_id with =,
    coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    coalesce(carrier_code, '') with =,
    coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    daterange(period_start, period_end, '[]') with &&
  )
);

-- 1.5 Saved staff scenarios (what a package would cost if its weight or size is corrected). brand_id null = staff-only exploration, never publishable.
create table public.adjustment_scenarios (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete restrict,
  brand_id             uuid,
  name                 text not null check (char_length(btrim(name)) between 1 and 160),
  adjustment_type      text not null check (adjustment_type in ('reweight', 'remeasure', 'combined')),
  input                jsonb not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 16384),
  result               jsonb not null check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536),
  engine_version       text not null check (char_length(engine_version) between 1 and 40),
  rate_card_version_id uuid,
  rule_version_ids     uuid[] not null default '{}',
  override_ids         uuid[] not null default '{}',
  policy_snapshot      jsonb not null default '{}'::jsonb check (jsonb_typeof(policy_snapshot) = 'object'),
  -- The pricing context the example was priced in, beyond the pinned versions: {"ruleKeysInForce":[text],"zipListVersionIds":[uuid],
  -- "source":"client"|"server"} (see the p_pins contract in the header). Compared again at preview, publish and read time.
  pricing_context      jsonb not null default '{}'::jsonb check (jsonb_typeof(pricing_context) = 'object' and pg_column_size(pricing_context) <= 32768),
  priced_on            date not null,
  archived_at          timestamptz,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (id, tenant_id),
  constraint adjustment_scenarios_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint adjustment_scenarios_version_in_tenant foreign key (rate_card_version_id, tenant_id) references public.rate_card_versions (id, tenant_id) on delete restrict
);
create index adjustment_scenarios_tenant_idx on public.adjustment_scenarios (tenant_id, created_at desc);

-- 1.6 Saved risk estimates. `inputs` snapshots k, N, window and filters BY VALUE so later edits cannot change a saved estimate.
create table public.risk_estimates (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete restrict,
  brand_id       uuid,
  name           text not null check (char_length(btrim(name)) between 1 and 160),
  inputs         jsonb not null check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 16384),
  result         jsonb not null check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536),
  engine_version text not null check (char_length(engine_version) between 1 and 40),
  archived_at    timestamptz,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (id, tenant_id),
  constraint risk_estimates_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict
);
create index risk_estimates_tenant_idx on public.risk_estimates (tenant_id, created_at desc);

-- Plain text a customer may read (title, note): length-capped, no control, bidi or zero-width characters, no angle brackets.
create function app.plain_text_ok(p text, p_max integer) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select p is not null and btrim(p) <> '' and char_length(p) <= p_max
     and p !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F  ​-‏‪-‮⁦-⁩﻿<>]';
$$;

-- 1.7 What customers may see. The payload is built in SQL from the stored scenario and guarded by a closed allow-list
-- (app.customer_json_ok, defined below). Rows are immutable except for retirement.
create table public.published_adjustment_examples (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  brand_id            uuid not null,
  source_scenario_id  uuid not null,
  title               text not null check (coalesce(app.plain_text_ok(title, 120), false)),
  note_to_customer    text check (note_to_customer is null or coalesce(app.plain_text_ok(note_to_customer, 300), false)),
  payload             jsonb not null check (octet_length(payload::text) <= 8192),
  payload_sha256      bytea not null check (octet_length(payload_sha256) = 32),
  priced_on           date not null,
  rates_effective_from date not null,
  valid_through       date not null,
  pins                jsonb not null default '{}'::jsonb check (jsonb_typeof(pins) = 'object' and pg_column_size(pins) <= 16384),
  internal_note       text check (internal_note is null or char_length(internal_note) <= 1000),
  published_by        uuid references auth.users (id) on delete set null,
  published_at        timestamptz not null default now(),
  retired_at          timestamptz,
  retired_by          uuid references auth.users (id) on delete set null,
  unique (id, tenant_id),
  constraint published_examples_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint published_examples_source_in_tenant foreign key (source_scenario_id, tenant_id) references public.adjustment_scenarios (id, tenant_id) on delete restrict
);
-- One live copy per customer and source; republishing retires the old copy in the same transaction.
create unique index published_examples_live_key on public.published_adjustment_examples (brand_id, source_scenario_id) where retired_at is null;
create index published_examples_brand_idx on public.published_adjustment_examples (brand_id) where retired_at is null;

-- ---------------------------------------------------------------------------
-- SECTION 2: policy resolution, the closed allow-list guard and its shapes
-- ---------------------------------------------------------------------------
-- The policy row in effect on a date: the brand's own row beats the tenant default (brand_id null); none = no row.
create function app.adjustment_policy_at(p_tenant uuid, p_brand uuid, p_type text, p_component text, p_on date)
returns table (handling text, valid_to date)
language sql stable security definer set search_path = '' as $$
  select p.handling, p.valid_to
  from public.adjustment_policies p
  where p.tenant_id = p_tenant and p.adjustment_type = p_type and p.component = p_component
    and p.valid_from <= p_on and (p.valid_to is null or p.valid_to >= p_on)
    and (p.brand_id is not distinct from p_brand or p.brand_id is null)
  order by (p.brand_id is not null) desc
  limit 1;
$$;

-- absorbed | pass_through | manual_approval | unconfigured. Mirrors resolveHandling() in TypeScript (a DB test runs both on one fixture).
create function app.adjustment_handling(p_tenant uuid, p_brand uuid, p_type text, p_component text, p_on date) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.handling from app.adjustment_policy_at(p_tenant, p_brand, p_type, p_component, p_on) a), 'unconfigured');
$$;

-- The guard: true only when the document matches the shape exactly. Never returns NULL. Closed key lists (exact,
-- case-sensitive), every declared type checked, depth and key count bounded. The constraints that use it are
-- written `coalesce(app.customer_json_ok(...), false)` so a NULL could never pass as "no violation".
--   shape types: obj{req,keys} arr{min,max,items} enum{values} money bool dec int{min,max} date ts uuid text{min,max}
--   any shape may carry "nullable":true (a JSON null is then accepted); a SQL NULL never is.
create function app.customer_json_ok(p_doc jsonb, p_shape jsonb, p_depth integer default 0) returns boolean
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_type text := jsonb_typeof(p_doc);
  v_st text := p_shape ->> 't';
  v_k text; v_v jsonb; v_s text; v_n integer; v_d date;
begin
  if p_doc is null or p_shape is null then return false; end if;
  if p_depth > 8 then return false; end if;
  if v_type = 'null' then return coalesce((p_shape ->> 'nullable') = 'true', false); end if;
  if v_st = 'obj' then
    if v_type is distinct from 'object' then return false; end if;
    select count(*) into v_n from jsonb_object_keys(p_doc);
    if v_n > 24 then return false; end if;
    for v_k, v_v in select e.key, e.value from jsonb_each(p_doc) e loop
      if not ((coalesce(p_shape -> 'keys', '{}'::jsonb)) ? v_k) then return false; end if;
      if not app.customer_json_ok(v_v, p_shape -> 'keys' -> v_k, p_depth + 1) then return false; end if;
    end loop;
    if exists (select 1 from jsonb_array_elements_text(coalesce(p_shape -> 'req', '[]'::jsonb)) r(x) where not (p_doc ? r.x)) then return false; end if;
    return true;
  elsif v_st = 'arr' then
    if v_type is distinct from 'array' then return false; end if;
    v_n := jsonb_array_length(p_doc);
    if v_n > coalesce((p_shape ->> 'max')::integer, 10) or v_n < coalesce((p_shape ->> 'min')::integer, 0) then return false; end if;
    for v_v in select e.value from jsonb_array_elements(p_doc) e loop
      if not app.customer_json_ok(v_v, p_shape -> 'items', p_depth + 1) then return false; end if;
    end loop;
    return true;
  elsif v_st = 'enum' then
    if v_type is distinct from 'string' then return false; end if;
    v_s := p_doc #>> '{}';
    return exists (select 1 from jsonb_array_elements_text(coalesce(p_shape -> 'values', '[]'::jsonb)) x where x = v_s);
  elsif v_st = 'bool' then
    return v_type = 'boolean';
  elsif v_st = 'money' then
    return v_type = 'string' and (p_doc #>> '{}') ~ '^[0-9]{1,7}\.[0-9]{2}$';
  elsif v_st = 'dec' then
    return v_type = 'string' and (p_doc #>> '{}') ~ '^[0-9]{1,6}(\.[0-9]{1,6})?$';
  elsif v_st = 'int' then
    if v_type is distinct from 'number' or (p_doc #>> '{}') !~ '^[0-9]{1,6}$' then return false; end if;
    return (p_doc #>> '{}')::integer between coalesce((p_shape ->> 'min')::integer, 0) and coalesce((p_shape ->> 'max')::integer, 999999);
  elsif v_st = 'date' then
    if v_type is distinct from 'string' or (p_doc #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
    begin
      v_d := (p_doc #>> '{}')::date;
    exception when others then
      return false;
    end;
    return v_d between date '2000-01-01' and date '2100-01-01';
  elsif v_st = 'ts' then
    return v_type = 'string' and (p_doc #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:[0-9]{2})?)$';
  elsif v_st = 'uuid' then
    return v_type = 'string' and (p_doc #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  elsif v_st = 'text' then
    if v_type is distinct from 'string' then return false; end if;
    v_s := p_doc #>> '{}';
    return char_length(v_s) between coalesce((p_shape ->> 'min')::integer, 0) and coalesce((p_shape ->> 'max')::integer, 200)
       and v_s !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F  ​-‏‪-‮⁦-⁩﻿<>]';
  end if;
  return false;
end $$;

-- The published payload (frozen). Carrier and service are the 3PL's catalog display names; nothing here is an id,
-- a rule key, a version number, an incidence, a count or an absorbed amount.
create function app.shape_published_payload() returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_object(
    't', 'obj',
    'req', jsonb_build_array('v', 'adjustmentType', 'input', 'components', 'pricedOn'),
    'keys', jsonb_build_object(
      'v', jsonb_build_object('t', 'int', 'min', 1, 'max', 1),
      'adjustmentType', jsonb_build_object('t', 'enum', 'values', jsonb_build_array('reweight', 'remeasure', 'combined')),
      'pricedOn', jsonb_build_object('t', 'date'),
      'input', jsonb_build_object(
        't', 'obj',
        'req', jsonb_build_array('service', 'direction', 'declared', 'corrected', 'residential', 'zone'),
        'keys', jsonb_build_object(
          'service', jsonb_build_object('t', 'obj', 'req', jsonb_build_array('carrier', 'service'),
                       'keys', jsonb_build_object('carrier', jsonb_build_object('t', 'text', 'min', 1, 'max', 60), 'service', jsonb_build_object('t', 'text', 'min', 1, 'max', 60))),
          'direction', jsonb_build_object('t', 'enum', 'values', jsonb_build_array('increase')),
          'residential', jsonb_build_object('t', 'bool'),
          'zone', jsonb_build_object('t', 'int', 'nullable', true),
          'declared', jsonb_build_object('t', 'obj', 'req', jsonb_build_array('packages'), 'keys', jsonb_build_object('packages', jsonb_build_object(
                        't', 'arr', 'min', 1, 'max', 20, 'items', jsonb_build_object('t', 'obj', 'req', jsonb_build_array('weightLb'),
                          'keys', jsonb_build_object('weightLb', jsonb_build_object('t', 'dec'), 'lengthIn', jsonb_build_object('t', 'dec'),
                                                     'widthIn', jsonb_build_object('t', 'dec'), 'heightIn', jsonb_build_object('t', 'dec')))))),
          'corrected', jsonb_build_object('t', 'obj', 'req', jsonb_build_array('packages'), 'keys', jsonb_build_object('packages', jsonb_build_object(
                         't', 'arr', 'min', 1, 'max', 20, 'items', jsonb_build_object('t', 'obj', 'req', jsonb_build_array('weightLb'),
                           'keys', jsonb_build_object('weightLb', jsonb_build_object('t', 'dec'), 'lengthIn', jsonb_build_object('t', 'dec'),
                                                      'widthIn', jsonb_build_object('t', 'dec'), 'heightIn', jsonb_build_object('t', 'dec'))))))
        )),
      'components', jsonb_build_object('t', 'arr', 'min', 1, 'max', 2, 'items', jsonb_build_object(
          't', 'obj', 'req', jsonb_build_array('kind', 'handling', 'amount'),
          'keys', jsonb_build_object(
            'kind', jsonb_build_object('t', 'enum', 'values', jsonb_build_array('postage_difference', 'separate_fee')),
            'handling', jsonb_build_object('t', 'enum', 'values', jsonb_build_array('pass_through', 'manual_approval')),
            'amount', jsonb_build_object('t', 'money'),
            'declaredTotal', jsonb_build_object('t', 'money'),
            'correctedTotal', jsonb_build_object('t', 'money'))))
    )
  );
$$;

-- One element of what brand_adjustment_examples returns (payload is null while an example is under review or expired).
create function app.shape_brand_example() returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_object(
    't', 'obj',
    'req', jsonb_build_array('id', 'title', 'note', 'payload', 'pricedOn', 'ratesEffectiveFrom', 'validThrough', 'publishedAt', 'state'),
    'keys', jsonb_build_object(
      'id', jsonb_build_object('t', 'uuid'),
      'title', jsonb_build_object('t', 'text', 'min', 1, 'max', 120),
      'note', jsonb_build_object('t', 'text', 'min', 1, 'max', 300, 'nullable', true),
      'payload', app.shape_published_payload() || jsonb_build_object('nullable', true),
      'pricedOn', jsonb_build_object('t', 'date'),
      'ratesEffectiveFrom', jsonb_build_object('t', 'date'),
      'validThrough', jsonb_build_object('t', 'date'),
      'publishedAt', jsonb_build_object('t', 'ts'),
      'state', jsonb_build_object('t', 'enum', 'values', jsonb_build_array('current', 'under_review', 'expired'))
    )
  );
$$;

alter table public.published_adjustment_examples add constraint published_examples_payload_guard
  check (coalesce(app.customer_json_ok(payload, app.shape_published_payload()), false));

-- ---------------------------------------------------------------------------
-- The forbidden-header test: a best-effort backstop to the TypeScript guard (no test can prove a number is customer-facing)
-- ---------------------------------------------------------------------------
-- Step 1 (fold): Unicode compatibility decomposition (NFKD: fullwidth and styled letters become plain ones, accented letters split
-- from their accent), then every invisible format character (zero-width space and joiners, soft hyphen, bidi marks, byte order mark,
-- word joiner, tag characters, variation selectors, fillers) and every combining mark is removed, then common Cyrillic, Greek and
-- Latin small-capital look-alikes are mapped to the Latin letter they imitate. Case and punctuation are kept.
create function app.adjustment_header_fold(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select translate(
    regexp_replace(
      regexp_replace(normalize(p, nfkd),
        '[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f\U000e0100-\U000e01ef]',
        '', 'g'),
      '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]', '', 'g'),
    U&'\0410\0412\0415\041A\041C\041D\041E\0420\0421\0422\0425\0423\0406\0408\0405\0430\0432\0435\043A\043C\043D\043E\0440\0441\0442\0445\0443\0456\0458\0455\04BB\0501\051B\051D\04CF\0391\0392\0395\0396\0397\0399\039A\039C\039D\039F\03A1\03A4\03A5\03A7\03B1\03B5\03B9\03BA\03BD\03BF\03C1\03C4\03C5\03C7\03B3\03C9\03BC\03B7\0131\0251\0261\1D00\1D04\1D07\1D0F\1D1B\A731\0262\0299\1D18\0280\026A\0274\1D0D\029F\1D1C\1D20\1D21\1D22\1D05\029C\1D0A\1D0B',
    'ABEKMHOPCTXYIJSabekmhopctxyijshdqwlABEZHIKMNOPTYXaeikvoptuxywuniagaceotsgbprinmluvwzdhjk');
$$;

-- Step 2 (norm): split camelCase ("CarrierCost", "UPSCost"), lower-case ASCII, every run of other characters becomes one space.
-- The result holds only a-z, 0-9 and single spaces ('' when the header has no letter or digit we can read).
create function app.adjustment_header_norm(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select btrim(regexp_replace(
    translate(
      regexp_replace(regexp_replace(app.adjustment_header_fold(left(coalesce(p, ''), 400)), '([a-z0-9])([A-Z])', '\1 \2', 'g'), '([A-Z]+)([A-Z][a-z])', '\1 \2', 'g'),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
    '[^a-z0-9]+', ' ', 'g'));
$$;

-- The rule, in the order it is applied (it mirrors guardHeader in src/lib/adjustments/header-guard.ts; the shared table of outcomes
-- is tests/fixtures/adjustments/header-guard.json). NULL or blank passes; a header longer than 200 characters is refused; an exact
-- template header (after normalisation) always passes; a header that still holds a letter outside ASCII after the fold (mixed
-- scripts, or letters that look like nothing we know) or that normalises to nothing is refused; then a word of the strict list
-- (cost, rate, postage, label, net, wholesale, negotiated, paid, invoice, buy, optional plural, "invoiced"; a number on either end of
-- a word does not make it another word) or a long stem inside a longer word (wholesale, negotiated, postage, invoice) refuses it;
-- finally "carrier", or a carrier brand (ups, usps, fedex, dhl, ontrac, lasership), beside a money word refuses it unless the
-- header says it is the customer's ("customer", "charged to", "billed to"). A bare "Carrier Name" passes here (the TypeScript guard
-- refuses it and asks the 3PL to rename the column; the backstop only has to catch what the TypeScript guard would have caught).
create function app.adjustment_template_headers() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['ship date', 'adjusted on', 'carrier', 'service', 'brand', 'adjustment type', 'cause', 'reason', 'package ref',
    'declared weight', 'actual weight', 'weight unit', 'original length', 'original width', 'original height', 'corrected length', 'corrected width',
    'corrected height', 'dimension unit', 'customer charge original', 'customer charge corrected', 'customer adjustment fee', 'handling'];
$$;

-- The word rules alone, on an already normalised header: an exact template header passes; a word of the strict list, a long stem, or
-- "carrier" / a carrier brand beside a money word (without the customer's own wording) refuses it.
create function app.adjustment_header_words_forbidden(p_norm text) returns boolean
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_tok text; v_word text; v_carrier boolean := false; v_carrier_money boolean := false; v_brand boolean := false; v_brand_money boolean := false;
begin
  if p_norm is null or p_norm = '' or p_norm = any (app.adjustment_template_headers()) then return false; end if;
  -- A carrier brand, in any spelling (camelCase splitting turns FedEx into 'fed ex', OnTrac into 'on trac', LaserShip into 'laser ship').
  v_brand := p_norm ~ '\m(ups|usps|dhl|fedex|fed ex|ontrac|on trac|lasership|laser ship)[0-9]*\M';
  for v_tok in select t from unnest(string_to_array(p_norm, ' ')) t loop
    v_word := regexp_replace(v_tok, '^[0-9]+|[0-9]+$', '', 'g');
    if v_word ~ '^(cost|rate|postage|label|net|wholesale|negotiated|paid|invoice|buy)s?$' or v_word = 'invoiced' then return true; end if;
    if v_tok ~ '(wholesale|negotiated|postage|invoice)' then return true; end if;
    if v_word ~ '^carriers?$' then v_carrier := true; end if;
    if v_word ~ '^(charge|bill|billed|billing|fee|adjustment|amount|price|total|paid)s?$' then v_carrier_money := true; end if;
    if v_word ~ '^(charge|fee|amount|price|total|billed)s?$' then v_brand_money := true; end if;
  end loop;
  if (v_carrier and v_carrier_money) or (v_brand and v_brand_money) then
    if not (p_norm ~ '\mcustomer\M' or p_norm ~ '\mcharged to\M' or p_norm ~ '\mbilled to\M') then return true; end if;
  end if;
  return false;
end $$;

create function app.adjustment_header_forbidden(p text) returns boolean
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_raw text := coalesce(p, '');
  v_norm text;
begin
  if btrim(v_raw, E' \t\r\n') = '' then return false; end if;
  if char_length(v_raw) > 200 then return true; end if;
  v_norm := app.adjustment_header_norm(v_raw);
  if v_norm = any (app.adjustment_template_headers()) then return false; end if;
  if app.adjustment_header_fold(v_raw) ~ '[^\x00-\x7f\u0080-\u00bf\u2000-\u2bff\u3000-\u303f]' then return true; end if;
  if v_norm = '' then return true; end if;
  return app.adjustment_header_words_forbidden(v_norm);
end $$;

-- The first fifty non-blank lines of a stored CSV or text file, read as the database sees the bytes. A line that can be a header is
-- tested cell by cell: the first line always, and any later line with at least three filled cells and NOT ONE number or date (a title
-- row, or a header below a title block). A record always carries a ship date, so a line with a date or a number is data and is not
-- tested: a service named "USPS Priority Mail Flat Rate" or a reason reading "Postage correction note" in a data cell never refuses a
-- file. This matches the TypeScript guard's rule for rows under the header row (src/lib/adjustments/sheet.ts headerCandidateRows). UTF-16 and NUL-bearing text cannot be read here at all, so it is refused with its own
-- reason (a LATIN1 fallback on such bytes would raise instead). Returns {ok:true}, {ok:false, reason:'unsupported_encoding'} or
-- {ok:false, reason:'forbidden_header', header}. XLSX and other binary files are not read here (the declared headers are tested).
create function app.adjustment_scan_file(p_content bytea, p_mime text, p_filename text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_head bytea; v_text text; v_lines text[]; v_line text; v_cells text[]; v_cell text; v_n integer := 0; v_filled integer; v_numeric integer; v_k integer;
begin
  if p_content is null then return jsonb_build_object('ok', true); end if;
  if not (coalesce(p_mime, '') ~* '(csv|text/plain)' or coalesce(p_filename, '') ~* '\.(csv|txt)$') then return jsonb_build_object('ok', true); end if;
  v_head := substring(p_content from 1 for 65536);
  if position('\x00'::bytea in v_head) > 0 or substring(v_head from 1 for 2) in ('\xfffe'::bytea, '\xfeff'::bytea) then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_encoding');
  end if;
  -- UTF-8 first (a multi-byte character cut by the 64 KB limit costs at most three bytes), else LATIN1, which cannot fail without NUL.
  for v_k in 0..3 loop
    begin
      v_text := convert_from(substring(v_head from 1 for octet_length(v_head) - v_k), 'UTF8');
      exit;
    exception when others then
      v_text := null;
    end;
  end loop;
  if v_text is null then v_text := convert_from(v_head, 'LATIN1'); end if;
  v_lines := regexp_split_to_array(replace(replace(replace(v_text, E'\r\n', E'\n'), E'\r', E'\n'), E'\ufeff', ''), E'\n');
  foreach v_line in array v_lines loop
    if btrim(v_line, E' \t') = '' then continue; end if;
    v_n := v_n + 1;
    exit when v_n > 50;
    v_cells := regexp_split_to_array(v_line, E'[,;\t|]');
    v_filled := 0; v_numeric := 0;
    foreach v_cell in array v_cells loop
      v_cell := btrim(v_cell, E' \t"''');
      if v_cell = '' then continue; end if;
      v_filled := v_filled + 1;
      if v_cell ~* '^[^0-9a-z]*[0-9][0-9,. ]*[^0-9a-z]*(usd)?$' or v_cell ~ '^[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}' then v_numeric := v_numeric + 1; end if;
    end loop;
    if v_n > 1 and (v_filled < 3 or v_numeric > 0) then continue; end if;
    foreach v_cell in array v_cells loop
      v_cell := btrim(v_cell, E' \t"''');
      if v_cell = '' then continue; end if;
      if (v_n = 1 and app.adjustment_header_forbidden(v_cell)) or (v_n > 1 and app.adjustment_header_words_forbidden(app.adjustment_header_norm(v_cell))) then
        return jsonb_build_object('ok', false, 'reason', 'forbidden_header', 'header', left(v_cell, 120));
      end if;
    end loop;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- Raw history files: refused before they are stored (a flagged header, an unreadable encoding) and bounded per account (at most five
-- unattached files; see the header of this file for the bound). The policy files_insert already demands the uploader, a null brand and
-- adjustment.manage; this trigger adds what a policy cannot read: the bytes.
create function app.guard_adjustment_file_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_scan jsonb;
begin
  if new.purpose is distinct from 'adjustment_import' then return new; end if;
  v_scan := app.adjustment_scan_file(new.content, new.mime_type, new.filename);
  if not (v_scan ->> 'ok')::boolean then
    raise exception 'this file was not saved' using errcode = 'P0001', hint = v_scan ->> 'reason', detail = coalesce(left(v_scan ->> 'header', 120), '');
  end if;
  perform app.adjustment_lock(new.tenant_id);
  if (select count(*) from public.uploaded_files f
       where f.tenant_id = new.tenant_id and f.purpose = 'adjustment_import'
         and not exists (select 1 from public.adjustment_imports i where i.file_id = f.id)) >= 5 then
    raise exception 'too many uploaded files are waiting for an import; finish or discard one first' using errcode = 'P0001', hint = 'too_many_unattached_files';
  end if;
  return new;
end $$;
create trigger uploaded_files_adjustment_guard before insert on public.uploaded_files
  for each row execute function app.guard_adjustment_file_insert();

-- ---------------------------------------------------------------------------
-- SECTION 3: write protection, row level security, grants
-- ---------------------------------------------------------------------------
-- Every write comes from an RPC that sets app.adjustment_rpc = 'on' for its own transaction. Even then, saved
-- scenarios, estimates and published examples only ever change the columns named here; history records never change.
create function app.guard_adjustment_write() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_n jsonb; v_o jsonb; v_unstarted boolean := false;
  -- Columns that a foreign key action (deleting a user, a service or an uploaded file) may clear without an RPC.
  v_actors text[] := array['created_by', 'attested_by', 'published_by', 'retired_by', 'file_id', 'service_id'];
begin
  -- A Data API role never passes, whatever it set: the signal below is an ordinary setting that any session can switch on, so it is
  -- only trusted from a function's owner (inside a SECURITY DEFINER function, or a foreign-key action, current_user is the owner).
  if current_user in ('anon', 'authenticated', 'authenticator') then
    raise exception 'adjustment data changes only through its functions' using errcode = '42501';
  end if;
  -- An insert needs no signal (the functions and the owner insert freely; the Data API roles were refused above and hold no INSERT grant).
  if tg_op = 'INSERT' then return new; end if;
  if current_setting('app.adjustment_rpc', true) is distinct from 'on' then
    if tg_op = 'UPDATE' then
      v_n := to_jsonb(new); v_o := to_jsonb(old);
      if (v_n - v_actors) = (v_o - v_actors)
         and not exists (select 1 from unnest(v_actors) k where (v_n -> k) is distinct from (v_o -> k) and (v_n -> k) <> 'null'::jsonb) then
        return new;
      end if;
    end if;
    raise exception 'adjustment data changes only through its functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    -- Records and baselines are removed by the import and baseline functions; a decision that has not started yet (it never governed
    -- anything) by end_adjustment_policy; everything else only by the offboarding functions.
    if tg_table_name = 'adjustment_policies' then v_unstarted := old.valid_from > app.utc_today(); end if;
    if tg_table_name not in ('adjustment_records', 'adjustment_baselines') and not v_unstarted
       and current_setting('app.adjustment_purge', true) is distinct from 'on' then
      raise exception 'this data is removed only by the offboarding functions' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_table_name = 'adjustment_records' then
    raise exception 'adjustment records are never edited' using errcode = '42501';
  elsif tg_table_name in ('adjustment_scenarios', 'risk_estimates') then
    if (to_jsonb(new) - 'archived_at') is distinct from (to_jsonb(old) - 'archived_at') then
      raise exception 'only archiving changes a saved row' using errcode = '42501';
    end if;
  elsif tg_table_name = 'published_adjustment_examples' then
    if (to_jsonb(new) - 'retired_at' - 'retired_by') is distinct from (to_jsonb(old) - 'retired_at' - 'retired_by') then
      raise exception 'a shared example is immutable; only stopping it changes the row' using errcode = '42501';
    end if;
    if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
      raise exception 'a stopped example cannot be restarted' using errcode = '42501';
    end if;
  elsif tg_table_name = 'adjustment_policies' then
    if (to_jsonb(new) - 'valid_to' - 'handling' - 'internal_note') is distinct from (to_jsonb(old) - 'valid_to' - 'handling' - 'internal_note') then
      raise exception 'a policy row keeps its identity; end it and set a new one' using errcode = '42501';
    end if;
  elsif tg_table_name = 'adjustment_imports' then
    if new.tenant_id <> old.tenant_id or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
      raise exception 'import identity columns are immutable' using errcode = '42501';
    end if;
    if old.status in ('discarded', 'withdrawn') and (new.status <> old.status) then
      raise exception 'a closed import cannot change status' using errcode = '42501';
    end if;
  elsif tg_table_name = 'adjustment_baselines' then
    if new.tenant_id <> old.tenant_id then
      raise exception 'baseline identity columns are immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger adjustment_policies_guard before insert or update or delete on public.adjustment_policies for each row execute function app.guard_adjustment_write();
create trigger adjustment_imports_guard before insert or update or delete on public.adjustment_imports for each row execute function app.guard_adjustment_write();
create trigger adjustment_records_guard before insert or update or delete on public.adjustment_records for each row execute function app.guard_adjustment_write();
create trigger adjustment_baselines_guard before insert or update or delete on public.adjustment_baselines for each row execute function app.guard_adjustment_write();
create trigger adjustment_scenarios_guard before insert or update or delete on public.adjustment_scenarios for each row execute function app.guard_adjustment_write();
create trigger risk_estimates_guard before insert or update or delete on public.risk_estimates for each row execute function app.guard_adjustment_write();
create trigger published_examples_guard before insert or update or delete on public.published_adjustment_examples for each row execute function app.guard_adjustment_write();

-- Two policies per table and nothing else: a permissive staff read, and a restrictive "staff only, never writable"
-- policy so that a permissive policy added later cannot widen access. No INSERT/UPDATE/DELETE grant exists.
alter table public.adjustment_policies enable row level security;
alter table public.adjustment_imports enable row level security;
alter table public.adjustment_records enable row level security;
alter table public.adjustment_baselines enable row level security;
alter table public.adjustment_scenarios enable row level security;
alter table public.risk_estimates enable row level security;
alter table public.published_adjustment_examples enable row level security;

create policy adjustment_policies_staff_read on public.adjustment_policies for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy adjustment_policies_staff_only on public.adjustment_policies as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);
create policy adjustment_imports_staff_read on public.adjustment_imports for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy adjustment_imports_staff_only on public.adjustment_imports as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);
create policy adjustment_records_staff_read on public.adjustment_records for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy adjustment_records_staff_only on public.adjustment_records as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);
create policy adjustment_baselines_staff_read on public.adjustment_baselines for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy adjustment_baselines_staff_only on public.adjustment_baselines as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);
create policy adjustment_scenarios_staff_read on public.adjustment_scenarios for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy adjustment_scenarios_staff_only on public.adjustment_scenarios as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);
create policy risk_estimates_staff_read on public.risk_estimates for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy risk_estimates_staff_only on public.risk_estimates as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);
create policy published_adjustment_examples_staff_read on public.published_adjustment_examples for select to authenticated using (tenant_id in (select app.adjustment_tenant_ids()));
create policy published_adjustment_examples_staff_only on public.published_adjustment_examples as restrictive for all to authenticated using (tenant_id in (select app.adjustment_tenant_ids())) with check (false);

grant select on public.adjustment_policies, public.adjustment_imports, public.adjustment_records, public.adjustment_baselines,
                public.adjustment_scenarios, public.risk_estimates, public.published_adjustment_examples to authenticated;
grant all on public.adjustment_policies, public.adjustment_imports, public.adjustment_records, public.adjustment_baselines,
             public.adjustment_scenarios, public.risk_estimates, public.published_adjustment_examples to service_role;

-- ---------------------------------------------------------------------------
-- SECTION 4: audit (AFTER triggers only; ids, names, counts and a payload hash, never figures or free text)
-- ---------------------------------------------------------------------------
create function app.audit_adjustments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'adjustment_policies' then
    if tg_op = 'DELETE' then
      -- Only a decision that never started can be deleted outside a purge (end_adjustment_policy voids it); a purge writes one
      -- adjustment.data_purged row instead of one row per policy.
      if current_setting('app.adjustment_purge', true) is distinct from 'on' then
        perform app.write_audit(old.tenant_id, old.brand_id, 'adjustment.policy_ended', 'adjustment_policy', old.id::text,
          jsonb_build_object('adjustment_type', old.adjustment_type, 'component', old.component, 'valid_from', old.valid_from, 'voided', true));
      end if;
      return old;
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and (new.handling is distinct from old.handling or new.internal_note is distinct from old.internal_note
                                                  or (new.valid_to is null and old.valid_to is not null))) then
      perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.policy_set', 'adjustment_policy', new.id::text,
        jsonb_build_object('adjustment_type', new.adjustment_type, 'component', new.component, 'handling', new.handling, 'valid_from', new.valid_from));
    end if;
    if tg_op = 'UPDATE' and new.valid_to is not null and new.valid_to is distinct from old.valid_to then
      perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.policy_ended', 'adjustment_policy', new.id::text,
        jsonb_build_object('adjustment_type', new.adjustment_type, 'component', new.component, 'valid_to', new.valid_to));
    end if;
  elsif tg_table_name = 'adjustment_imports' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('committed', 'discarded', 'withdrawn') then
      perform app.write_audit(new.tenant_id, null, 'adjustment.import_' || new.status, 'adjustment_import', new.id::text,
        jsonb_build_object('name', new.name, 'committed', new.committed_count, 'skipped', new.skipped_count, 'accepted', new.accepted_count,
                           'attested', new.attested_at is not null));
    end if;
  elsif tg_table_name = 'adjustment_baselines' then
    if tg_op = 'DELETE' then
      -- A purge writes one adjustment.data_purged row instead of one row per baseline.
      if current_setting('app.adjustment_purge', true) is distinct from 'on' then
        perform app.write_audit(old.tenant_id, old.brand_id, 'adjustment.baseline_deleted', 'adjustment_baseline', old.id::text, '{}'::jsonb);
      end if;
      return old;
    end if;
    perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.baseline_saved', 'adjustment_baseline', new.id::text,
      jsonb_build_object('carrier_code', new.carrier_code, 'service_id', new.service_id, 'period_start', new.period_start, 'period_end', new.period_end, 'packages', new.packages_total));
  elsif tg_table_name = 'adjustment_scenarios' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.scenario_saved', 'adjustment_scenario', new.id::text,
        jsonb_build_object('name', new.name, 'adjustment_type', new.adjustment_type, 'engine_version', new.engine_version));
    end if;
  elsif tg_table_name = 'risk_estimates' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.estimate_saved', 'risk_estimate', new.id::text,
        jsonb_build_object('name', new.name, 'engine_version', new.engine_version));
    end if;
  elsif tg_table_name = 'published_adjustment_examples' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.scenario_published', 'published_adjustment_example', new.id::text,
        jsonb_build_object('title', new.title, 'source_scenario_id', new.source_scenario_id, 'valid_through', new.valid_through,
                           'payload_sha256', encode(new.payload_sha256, 'hex')));
    elsif tg_op = 'UPDATE' and new.retired_at is not null and old.retired_at is null then
      perform app.write_audit(new.tenant_id, new.brand_id, 'adjustment.scenario_retired', 'published_adjustment_example', new.id::text,
        jsonb_build_object('source_scenario_id', new.source_scenario_id));
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger adjustment_policies_audit after insert or update or delete on public.adjustment_policies for each row execute function app.audit_adjustments();
create trigger adjustment_imports_audit after update on public.adjustment_imports for each row execute function app.audit_adjustments();
create trigger adjustment_baselines_audit after insert or update or delete on public.adjustment_baselines for each row execute function app.audit_adjustments();
create trigger adjustment_scenarios_audit after insert on public.adjustment_scenarios for each row execute function app.audit_adjustments();
create trigger risk_estimates_audit after insert on public.risk_estimates for each row execute function app.audit_adjustments();
create trigger published_examples_audit after insert or update on public.published_adjustment_examples for each row execute function app.audit_adjustments();

-- ---------------------------------------------------------------------------
-- SECTION 5: small helpers used by the functions below (never executable by Data API roles)
-- ---------------------------------------------------------------------------
-- All writers take one advisory lock per tenant first, then row locks, so there is a single lock order.
create function app.adjustment_lock(p_tenant uuid) returns void
language sql security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('adj:' || p_tenant::text, 0));
$$;

create function app.try_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end $$;

create function app.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return null; end if;
  return p::uuid;
exception when others then
  return null;
end $$;

-- A non-negative decimal with at most p_int integer digits and p_scale decimals, else NULL (never raises, never echoes the text).
create function app.try_dec(p text, p_int integer, p_scale integer) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ ('^[0-9]{1,' || p_int || '}(\.[0-9]{1,' || p_scale || '})?$') then return null; end if;
  return p::numeric;
end $$;

-- The validation report is built from the file, so a column header or a customer name in it can be as long as the file allows.
-- What is stored keeps the numbers and the codes whole and cuts that text down: at most 50 ignored columns and 50 customers, each
-- name at most 80 and 120 characters. (A NUL character cannot reach this function: jsonb has no representation for it, so it is
-- refused as SQLSTATE 22P05 when the argument is converted, before any function body runs; the TypeScript layer strips it first.)
create function app.clean_import_validation(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) is distinct from 'object' then p else p
    || case when jsonb_typeof(p -> 'ignoredColumns') = 'array' then jsonb_build_object('ignoredColumns', coalesce((
         select jsonb_agg(case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'header') = 'string'
                               then e.value || jsonb_build_object('header', left(e.value ->> 'header', 80)) else e.value end order by e.ord)
         from jsonb_array_elements(p -> 'ignoredColumns') with ordinality as e(value, ord) where e.ord <= 50), '[]'::jsonb)) else '{}'::jsonb end
    || case when jsonb_typeof(p -> 'customers') = 'array' then jsonb_build_object('customers', coalesce((
         select jsonb_agg(case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'text') = 'string'
                               then e.value || jsonb_build_object('text', left(e.value ->> 'text', 120)) else e.value end order by e.ord)
         from jsonb_array_elements(p -> 'customers') with ordinality as e(value, ord) where e.ord <= 50), '[]'::jsonb)) else '{}'::jsonb end
  end;
$$;

create function app.add_problem(p_list jsonb, p_code text, p_message text) returns jsonb
language sql immutable set search_path = '' as $$
  select p_list || jsonb_build_array(jsonb_build_object('code', p_code, 'message', p_message));
$$;

-- ---------------------------------------------------------------------------
-- SECTION 6: policies
-- ---------------------------------------------------------------------------
-- Sets who pays for one component of one adjustment type, for the whole account (p_brand null) or one customer, from
-- today (or a later date). The row in force is closed the day before; setting the same decision again changes nothing.
create function public.set_adjustment_policy(p_tenant uuid, p_brand uuid, p_type text, p_component text, p_handling text,
                                             p_valid_from date default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_from date := coalesce(p_valid_from, app.utc_today());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_open public.adjustment_policies%rowtype;
  v_id uuid;
begin
  if p_tenant is null or not app.can_manage_adjustments(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_brand is not null and not exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = p_tenant) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_type is null or p_component is null or p_handling is null
     or p_type not in ('reweight', 'remeasure', 'combined', 'correction') or p_component not in ('postage_difference', 'separate_fee')
     or p_handling not in ('absorbed', 'pass_through', 'manual_approval') or (p_type = 'correction' and p_component <> 'separate_fee') then
    raise exception 'invalid policy' using errcode = 'PC001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then raise exception 'the private note is limited to 1000 characters' using errcode = 'PC001'; end if;
  -- Today (UTC) or a date up to a year ahead: a date far in the future (or 'infinity') would block every later decision for the cell.
  if v_from < app.utc_today() or v_from > app.utc_today() + 366 then raise exception 'a decision takes effect from today up to a year ahead' using errcode = 'PC001'; end if;
  perform app.adjustment_lock(p_tenant);
  perform set_config('app.adjustment_rpc', 'on', true);
  select * into v_open from public.adjustment_policies p
   where p.tenant_id = p_tenant and p.brand_id is not distinct from p_brand and p.adjustment_type = p_type and p.component = p_component
     and p.valid_from <= v_from and (p.valid_to is null or p.valid_to >= v_from)
   for update;
  if found then
    -- The same decision, still open: nothing to do.
    if v_open.valid_to is null and v_open.handling = p_handling and v_open.internal_note is not distinct from v_note then
      perform set_config('app.adjustment_rpc', 'off', true);
      return v_open.id;
    end if;
    -- A row that started on the same day is edited in place (and reopened if it had been ended).
    if v_open.valid_from = v_from then
      begin
        update public.adjustment_policies set handling = p_handling, internal_note = v_note, valid_to = null where id = v_open.id;
      exception when exclusion_violation then
        raise exception 'this overlaps another decision for the same adjustment' using errcode = 'P0007';
      end;
      perform set_config('app.adjustment_rpc', 'off', true);
      return v_open.id;
    end if;
    update public.adjustment_policies set valid_to = v_from - 1 where id = v_open.id;
  end if;
  begin
    insert into public.adjustment_policies (tenant_id, brand_id, adjustment_type, component, handling, valid_from, internal_note, created_by)
    values (p_tenant, p_brand, p_type, p_component, p_handling, v_from, v_note, (select auth.uid()))
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'this overlaps another decision for the same adjustment' using errcode = 'P0007';
  end;
  perform set_config('app.adjustment_rpc', 'off', true);
  return v_id;
end $$;

-- Ends a decision (it reads "Not decided" afterwards). The last day defaults to yesterday, or the first day when it started today.
-- A decision that has not started yet and is ended before its first day is VOIDED: the row is deleted (it never governed anything) and
-- the decision it was due to replace carries on as if the change had never been scheduled.
create function public.end_adjustment_policy(p_policy uuid, p_last_day date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid; v public.adjustment_policies%rowtype; v_last date; v_today date := app.utc_today();
begin
  select tenant_id into v_t from public.adjustment_policies where id = p_policy;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into v from public.adjustment_policies where id = p_policy for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v.valid_from > v_today and (p_last_day is null or p_last_day < v.valid_from) then
    perform set_config('app.adjustment_rpc', 'on', true);
    delete from public.adjustment_policies where id = p_policy;
    -- (The decision scheduled to replace it ended the day before the voided one began: it runs on again, up to the next decision that
    -- is scheduled after it, or without an end.)
    update public.adjustment_policies p
       set valid_to = (select min(n.valid_from) - 1 from public.adjustment_policies n
                        where n.tenant_id = v.tenant_id and n.brand_id is not distinct from v.brand_id and n.adjustment_type = v.adjustment_type
                          and n.component = v.component and n.valid_from > v.valid_from)
     where p.tenant_id = v.tenant_id and p.brand_id is not distinct from v.brand_id and p.adjustment_type = v.adjustment_type
       and p.component = v.component and p.valid_to = v.valid_from - 1;
    perform set_config('app.adjustment_rpc', 'off', true);
    return;
  end if;
  v_last := coalesce(p_last_day, greatest(v.valid_from, v_today - 1));
  if v_last < v.valid_from then raise exception 'the last day precedes the first day' using errcode = 'PC001'; end if;
  if v.valid_to is not null and v.valid_to <= v_last then return; end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  update public.adjustment_policies set valid_to = v_last where id = p_policy;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 7: history imports (upload -> mapping -> validation -> chunked commit -> finalize)
-- ---------------------------------------------------------------------------
-- Registers an uploaded file as an import. Returns {ok:true, importId} or, when a header looks like carrier cost data,
-- {ok:false, reason:'forbidden_header', header} after deleting the uploaded file (nothing from it is kept).
create function public.create_adjustment_import(p_file uuid, p_name text, p_detected jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.uploaded_files%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_bad text; v_scan jsonb; v_id uuid;
begin
  select * into f from public.uploaded_files where id = p_file;
  if not found or f.purpose <> 'adjustment_import' or f.brand_id is not null or f.uploaded_by is distinct from (select auth.uid())
     or not app.can_manage_adjustments(f.tenant_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform app.adjustment_lock(f.tenant_id);
  -- Read again under the lock: discard_unattached_adjustment_file may have removed the file while this call waited.
  select * into f from public.uploaded_files where id = p_file for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(v_name) not between 1 and 160 then raise exception 'the name must be 1 to 160 characters' using errcode = 'PC001'; end if;
  if p_detected is null or jsonb_typeof(p_detected) <> 'object' or pg_column_size(p_detected) > 65536
     or jsonb_typeof(coalesce(p_detected -> 'headers', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_detected -> 'headers', '[]'::jsonb)) > 200
     or jsonb_typeof(coalesce(p_detected -> 'sampleRows', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_detected -> 'sampleRows', '[]'::jsonb)) > 20 then
    raise exception 'invalid file details' using errcode = 'PC001';
  end if;

  -- Forbidden headers: the declared headers, the keys of the sample rows and the stored bytes themselves (the first fifty lines of a
  -- CSV or text file, wherever the header sits; UTF-16 and NUL-bearing text is refused as unreadable, never raised on).
  select q.h into v_bad from (
    select x.h from jsonb_array_elements_text(coalesce(p_detected -> 'headers', '[]'::jsonb)) x(h)
    union all
    select k from jsonb_array_elements(coalesce(p_detected -> 'sampleRows', '[]'::jsonb)) r(obj)
      cross join lateral jsonb_object_keys(case when jsonb_typeof(r.obj) = 'object' then r.obj else '{}'::jsonb end) k
  ) q where app.adjustment_header_forbidden(q.h) limit 1;
  if v_bad is not null then
    delete from public.uploaded_files where id = p_file;
    return jsonb_build_object('ok', false, 'reason', 'forbidden_header', 'header', left(v_bad, 120));
  end if;
  v_scan := app.adjustment_scan_file(f.content, f.mime_type, f.filename);
  if not (v_scan ->> 'ok')::boolean then
    delete from public.uploaded_files where id = p_file;
    return jsonb_build_object('ok', false) || (v_scan - 'ok');
  end if;

  if not public.check_rate_limit('adjustment.import', 30, 3600) then raise exception 'too many imports; try again later' using errcode = '53400'; end if;
  if (select count(*) from public.adjustment_imports i where i.tenant_id = f.tenant_id and i.status in ('uploaded', 'mapped', 'validated', 'committing')) >= 5 then
    raise exception 'too many imports are in progress; finish or discard one first' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.adjustment_imports i where i.file_id = p_file) then
    raise exception 'this file already has an import' using errcode = 'P0001';
  end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  insert into public.adjustment_imports (tenant_id, file_id, name, detected, created_by)
  values (f.tenant_id, p_file, v_name, p_detected, (select auth.uid())) returning id into v_id;
  perform set_config('app.adjustment_rpc', 'off', true);
  return jsonb_build_object('ok', true, 'importId', v_id);
end $$;

-- Deletes an uploaded history file that no import refers to: what the server action calls when anything after the upload fails (a
-- refused name, a rate limit, a crash), so an upload never stays behind. It is the ONLY way a caller removes a raw file: the Data
-- API roles hold no DELETE on uploaded_files. Anything else (no such file, another purpose, another account, no permission, a file an
-- import already holds) is the same "not found".
create function public.discard_unattached_adjustment_file(p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.uploaded_files%rowtype;
begin
  select * into f from public.uploaded_files where id = p_file;
  if not found or f.purpose <> 'adjustment_import' or not app.can_manage_adjustments(f.tenant_id)
     or exists (select 1 from public.adjustment_imports i where i.file_id = p_file) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform app.adjustment_lock(f.tenant_id);
  -- Under the lock an import may have taken the file in the meantime.
  if exists (select 1 from public.adjustment_imports i where i.file_id = p_file) then raise exception 'not found' using errcode = 'P0002'; end if;
  delete from public.uploaded_files where id = p_file;
end $$;

-- Saves the mapping and, with a validation report and the attestation, marks the import validated. Returns the new status.
-- mapping.fields maps each target field to the header it reads; a flagged header can never be mapped.
create function public.set_adjustment_import_mapping(p_import uuid, p_mapping jsonb, p_validation jsonb default null,
                                                     p_duplicate_handling text default 'refuse', p_attested boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_t uuid; i public.adjustment_imports%rowtype; v_bad text; v_rows integer; v_acc integer; v_status text; v_val jsonb;
begin
  select tenant_id into v_t from public.adjustment_imports where id = p_import;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into i from public.adjustment_imports where id = p_import for update;
  if i.status not in ('uploaded', 'mapped', 'validated') then raise exception 'this import is no longer being edited' using errcode = 'P0004'; end if;
  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' or pg_column_size(p_mapping) > 8192
     or jsonb_typeof(coalesce(p_mapping -> 'fields', '{}'::jsonb)) <> 'object'
     or p_duplicate_handling is null or p_duplicate_handling not in ('refuse', 'sum', 'first') then
    raise exception 'invalid mapping' using errcode = 'PC001';
  end if;
  -- The report is cut down BEFORE its size is judged (see app.clean_import_validation): long header text must not make a good file
  -- impossible to validate. What remains must fit the 32 KB the table allows.
  if p_validation is not null then
    if jsonb_typeof(p_validation) <> 'object' or pg_column_size(p_validation) > 1048576 then raise exception 'the validation report is too large' using errcode = 'PC001'; end if;
    v_val := app.clean_import_validation(p_validation);
    if pg_column_size(v_val) > 32768 then raise exception 'the validation report is too large' using errcode = 'PC001'; end if;
  end if;
  select e.value into v_bad from jsonb_each_text(coalesce(p_mapping -> 'fields', '{}'::jsonb)) e where app.adjustment_header_forbidden(e.value) limit 1;
  if v_bad is not null then
    raise exception 'a column that looks like carrier cost data cannot be mapped' using errcode = 'P0001', detail = left(v_bad, 120);
  end if;
  if v_val is null then
    v_status := 'mapped';
    perform set_config('app.adjustment_rpc', 'on', true);
    update public.adjustment_imports set status = 'mapped', mapping = p_mapping, validation = null, duplicate_handling = p_duplicate_handling,
           accepted_count = 0, row_count = 0, attested_by = null, attested_at = null where id = p_import;
    perform set_config('app.adjustment_rpc', 'off', true);
  else
    if (v_val #>> '{counts,accepted}') is null or (v_val #>> '{counts,accepted}') !~ '^[0-9]{1,7}$'
       or (v_val #>> '{counts,rows}') is null or (v_val #>> '{counts,rows}') !~ '^[0-9]{1,7}$' then
      raise exception 'the validation report must carry counts.rows and counts.accepted' using errcode = 'PC001';
    end if;
    v_rows := (v_val #>> '{counts,rows}')::integer; v_acc := (v_val #>> '{counts,accepted}')::integer;
    if v_acc < 1 or v_acc > 100000 or v_rows < v_acc then raise exception 'nothing to import, or too many rows' using errcode = 'PC001'; end if;
    if p_attested is distinct from true then raise exception 'confirm that the amounts are what your customers were charged' using errcode = 'P0001'; end if;
    v_status := 'validated';
    perform set_config('app.adjustment_rpc', 'on', true);
    update public.adjustment_imports set status = 'validated', mapping = p_mapping, validation = v_val, duplicate_handling = p_duplicate_handling,
           accepted_count = v_acc, row_count = v_rows, attested_by = (select auth.uid()), attested_at = now() where id = p_import;
    perform set_config('app.adjustment_rpc', 'off', true);
    return v_status;
  end if;
  return v_status;
end $$;

-- The first problem found in a chunk of rows ("row 17: invalid_weight"), never the value that caused it; null when every row is valid.
create function app.adjustment_rows_problem(p_tenant uuid, p_import uuid, p_rows jsonb, p_from integer) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_problem text;
begin
  with parsed as (
    select e.rn, r.*, coalesce(r.declared_weight_basis, case when r.declared_weight_lb is null then 'missing' else 'measured' end) as basis
      from jsonb_array_elements(p_rows) with ordinality as e(obj, rn)
      cross join lateral jsonb_to_record(e.obj) as r(ship_date text, adjusted_on text, carrier_code text, service_id text, service_text text, brand_id text,
        adjustment_type text, cause text, reason_text text, package_ref text, declared_weight_lb text, declared_weight_basis text, actual_weight_lb text,
        orig_length_in text, orig_width_in text, orig_height_in text, corr_length_in text, corr_width_in text, corr_height_in text,
        original_charge text, corrected_charge text, separate_fee text, handling_recorded text)
  ), checked as (
    select p.rn, case
      when app.try_date(p.ship_date) is null or app.try_date(p.ship_date) not between date '2015-01-01' and app.utc_today() + 1 then 'invalid_ship_date'
      when p.adjusted_on is not null and (app.try_date(p.adjusted_on) is null or app.try_date(p.adjusted_on) < app.try_date(p.ship_date) or app.try_date(p.adjusted_on) > app.utc_today() + 1) then 'invalid_adjusted_on'
      when p.carrier_code is null or not exists (select 1 from public.carriers c where c.code = p.carrier_code) then 'unknown_carrier'
      when p.service_id is not null and (app.try_uuid(p.service_id) is null or not exists (select 1 from public.shipping_services s where s.id = app.try_uuid(p.service_id) and s.carrier_code = p.carrier_code)) then 'unknown_service'
      when p.brand_id is not null and (app.try_uuid(p.brand_id) is null or not exists (select 1 from public.brands b where b.id = app.try_uuid(p.brand_id) and b.tenant_id = p_tenant)) then 'unknown_customer'
      when p.adjustment_type is null or p.adjustment_type not in ('reweight', 'remeasure', 'combined', 'correction') then 'invalid_type'
      when p.cause is null or p.cause not in ('wms_no_weight', 'scale_error', 'carrier_reweigh', 'carrier_remeasure', 'packaging_change', 'other') then 'invalid_cause'
      when p.service_text is not null and char_length(p.service_text) > 160 then 'text_too_long'
      when p.reason_text is not null and char_length(p.reason_text) > 120 then 'text_too_long'
      -- A reference is valid when its canonical form exists (no replacement character, something left after whitespace and invisible
      -- characters are removed) and fits the column.
      when p.package_ref is not null and (char_length(p.package_ref) not between 1 and 120 or app.canon_package_ref(p.package_ref) is null
                                          or char_length(app.canon_package_ref(p.package_ref)) > 120) then 'invalid_package_ref'
      when p.basis not in ('measured', 'fallback', 'missing') then 'invalid_weight_basis'
      when (p.basis = 'missing') <> (p.declared_weight_lb is null) then 'weight_basis_mismatch'
      when p.declared_weight_lb is not null and coalesce(app.try_dec(p.declared_weight_lb, 6, 6), 0) <= 0 then 'invalid_weight'
      when p.actual_weight_lb is not null and coalesce(app.try_dec(p.actual_weight_lb, 6, 6), 0) <= 0 then 'invalid_weight'
      when (p.orig_length_in is null) <> (p.orig_width_in is null) or (p.orig_width_in is null) <> (p.orig_height_in is null)
        or (p.corr_length_in is null) <> (p.corr_width_in is null) or (p.corr_width_in is null) <> (p.corr_height_in is null) then 'partial_dimensions'
      when (p.orig_length_in is not null and (coalesce(app.try_dec(p.orig_length_in, 6, 4), 0) <= 0 or coalesce(app.try_dec(p.orig_width_in, 6, 4), 0) <= 0 or coalesce(app.try_dec(p.orig_height_in, 6, 4), 0) <= 0))
        or (p.corr_length_in is not null and (coalesce(app.try_dec(p.corr_length_in, 6, 4), 0) <= 0 or coalesce(app.try_dec(p.corr_width_in, 6, 4), 0) <= 0 or coalesce(app.try_dec(p.corr_height_in, 6, 4), 0) <= 0)) then 'invalid_dimensions'
      when p.original_charge ~ '^-' or p.corrected_charge ~ '^-' or p.separate_fee ~ '^-' then 'negative_amount'
      when (p.original_charge is not null and app.try_dec(p.original_charge, 10, 2) is null) or (p.corrected_charge is not null and app.try_dec(p.corrected_charge, 10, 2) is null)
        or (p.separate_fee is not null and app.try_dec(p.separate_fee, 10, 2) is null) then 'invalid_amount'
      when p.handling_recorded is not null and p.handling_recorded not in ('absorbed', 'pass_through', 'manual_approval') then 'invalid_handling'
    end as reason
    from parsed p
  ), dup as (
    -- Duplicates are judged on the CANONICAL reference: 'x', 'X' and ' X' are one package.
    select p.rn, 'duplicate_package' as reason
    from (select q.rn, app.canon_package_ref(q.package_ref) as cref, q.carrier_code, q.adjustment_type, q.brand_id,
                 row_number() over (partition by coalesce(app.try_uuid(q.brand_id), '00000000-0000-0000-0000-000000000000'::uuid), q.carrier_code, app.canon_package_ref(q.package_ref), q.adjustment_type order by q.rn) as k
          from parsed q where app.canon_package_ref(q.package_ref) is not null) p
    where p.k > 1
       or exists (select 1 from public.adjustment_records ar
                  where ar.tenant_id = p_tenant and ar.package_ref = p.cref and ar.carrier_code = p.carrier_code and ar.adjustment_type = p.adjustment_type
                    and coalesce(ar.brand_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(app.try_uuid(p.brand_id), '00000000-0000-0000-0000-000000000000'::uuid)
                    and ar.import_id = p_import)
  )
  select 'row ' || (p_from + u.rn - 1) || ': ' || u.reason into v_problem
  from (select c.rn, c.reason from checked c where c.reason is not null union all select d.rn, d.reason from dup d) u
  order by u.rn limit 1;
  return v_problem;
end $$;

-- Appends the next chunk (<= 2,000 rows) of a validated import. Rows are numbered from the cursor (rows already stored or
-- skipped as "already imported"), so a retried chunk is acknowledged, not repeated.
create function public.append_adjustment_records(p_import uuid, p_from_row integer, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_t uuid; i public.adjustment_imports%rowtype; v_n integer; v_cursor integer; v_ins integer; v_skip integer; v_problem text;
begin
  select tenant_id into v_t from public.adjustment_imports where id = p_import;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into i from public.adjustment_imports where id = p_import for update;
  if i.status not in ('validated', 'committing') then raise exception 'this import is not accepting rows' using errcode = 'P0004'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or p_from_row is null or p_from_row < 1 then raise exception 'invalid chunk' using errcode = 'PC001'; end if;
  v_n := jsonb_array_length(p_rows);
  if v_n < 1 or v_n > 2000 then raise exception 'send between 1 and 2000 rows per call' using errcode = 'PC001'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e.value) <> 'object')
     or exists (select 1 from jsonb_array_elements(p_rows) e cross join lateral jsonb_object_keys(e.value) k
                where k <> all (array['ship_date', 'adjusted_on', 'carrier_code', 'service_id', 'service_text', 'brand_id', 'adjustment_type', 'cause', 'reason_text',
                                      'package_ref', 'declared_weight_lb', 'declared_weight_basis', 'actual_weight_lb', 'orig_length_in', 'orig_width_in', 'orig_height_in',
                                      'corr_length_in', 'corr_width_in', 'corr_height_in', 'original_charge', 'corrected_charge', 'separate_fee', 'handling_recorded'])) then
    raise exception 'a row carries a field this import does not know' using errcode = 'PC001';
  end if;
  v_cursor := i.committed_count + i.skipped_count;
  if p_from_row + v_n - 1 <= v_cursor then
    return jsonb_build_object('applied', false, 'nextRow', v_cursor + 1, 'committed', i.committed_count, 'skipped', i.skipped_count);
  end if;
  if p_from_row <> v_cursor + 1 then raise exception 'the chunk does not start at the cursor' using errcode = 'PC002'; end if;
  if v_cursor + v_n > i.accepted_count then raise exception 'more rows than the validated count' using errcode = 'PC003'; end if;
  if not public.check_rate_limit('adjustment.append', 200, 3600) then raise exception 'too many uploads; try again later' using errcode = '53400'; end if;
  if (select count(*) from public.adjustment_records r where r.tenant_id = v_t) + v_n > 200000 then
    raise exception 'the history limit of 200,000 records per account is reached' using errcode = 'P0001';
  end if;
  v_problem := app.adjustment_rows_problem(v_t, p_import, p_rows, p_from_row);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'PC001'; end if;

  perform set_config('app.adjustment_rpc', 'on', true);
  insert into public.adjustment_records (tenant_id, import_id, row_no, brand_id, ship_date, adjusted_on, carrier_code, service_id, service_text, adjustment_type, cause, reason_text,
         package_ref, declared_weight_lb, declared_weight_basis, actual_weight_lb, orig_length_in, orig_width_in, orig_height_in, corr_length_in, corr_width_in, corr_height_in,
         original_charge, corrected_charge, separate_fee, handling_recorded)
  select v_t, p_import, p_from_row + e.rn - 1, r.brand_id::uuid, r.ship_date::date, r.adjusted_on::date, r.carrier_code, r.service_id::uuid, r.service_text, r.adjustment_type, r.cause, r.reason_text,
         app.canon_package_ref(r.package_ref), r.declared_weight_lb::numeric, coalesce(r.declared_weight_basis, case when r.declared_weight_lb is null then 'missing' else 'measured' end), r.actual_weight_lb::numeric, r.orig_length_in::numeric, r.orig_width_in::numeric, r.orig_height_in::numeric,
         r.corr_length_in::numeric, r.corr_width_in::numeric, r.corr_height_in::numeric, r.original_charge::numeric, r.corrected_charge::numeric, r.separate_fee::numeric, r.handling_recorded
  from jsonb_array_elements(p_rows) with ordinality as e(obj, rn)
    cross join lateral jsonb_to_record(e.obj) as r(ship_date text, adjusted_on text, carrier_code text, service_id text, service_text text, brand_id text,
        adjustment_type text, cause text, reason_text text, package_ref text, declared_weight_lb text, declared_weight_basis text, actual_weight_lb text,
        orig_length_in text, orig_width_in text, orig_height_in text, corr_length_in text, corr_width_in text, corr_height_in text,
        original_charge text, corrected_charge text, separate_fee text, handling_recorded text)
  on conflict do nothing;
  get diagnostics v_ins = row_count;
  v_skip := v_n - v_ins;
  update public.adjustment_imports set status = 'committing', committed_count = committed_count + v_ins, skipped_count = skipped_count + v_skip where id = p_import;
  perform set_config('app.adjustment_rpc', 'off', true);
  return jsonb_build_object('applied', true, 'inserted', v_ins, 'skipped', v_skip, 'nextRow', v_cursor + v_n + 1, 'committed', i.committed_count + v_ins, 'skippedTotal', i.skipped_count + v_skip);
end $$;

-- Completes an import: every validated row was sent, the stored count matches, the attestation exists. The raw file is deleted.
create function public.finalize_adjustment_import(p_import uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_t uuid; i public.adjustment_imports%rowtype; v_stored integer;
begin
  select tenant_id into v_t from public.adjustment_imports where id = p_import;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into i from public.adjustment_imports where id = p_import for update;
  if i.status <> 'committing' then raise exception 'this import is not being committed' using errcode = 'P0004'; end if;
  if i.attested_at is null or i.attested_by is null then raise exception 'the attestation is missing' using errcode = 'P0001'; end if;
  select count(*) into v_stored from public.adjustment_records r where r.import_id = p_import;
  if i.committed_count + i.skipped_count <> i.accepted_count or v_stored <> i.committed_count
     or coalesce((select max(r.row_no) from public.adjustment_records r where r.import_id = p_import), 0) > i.accepted_count then
    raise exception 'the stored rows do not match the validated count' using errcode = 'PC003';
  end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  update public.adjustment_imports set status = 'committed', committed_at = now(), detected = detected - 'sampleRows' where id = p_import;
  if i.file_id is not null then delete from public.uploaded_files where id = i.file_id; end if;
  perform set_config('app.adjustment_rpc', 'off', true);
  return jsonb_build_object('importId', p_import, 'committed', i.committed_count, 'skipped', i.skipped_count);
end $$;

-- Throws away an import that is not committed: partial records and the raw file go; it can never be reopened.
create function public.discard_adjustment_import(p_import uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid; i public.adjustment_imports%rowtype;
begin
  select tenant_id into v_t from public.adjustment_imports where id = p_import;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into i from public.adjustment_imports where id = p_import for update;
  if i.status = 'discarded' then return; end if;
  if i.status not in ('uploaded', 'mapped', 'validated', 'committing') then raise exception 'a committed import is withdrawn, not discarded' using errcode = 'P0004'; end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  delete from public.adjustment_records where import_id = p_import;
  -- What the file showed (sample rows, the examples and customer names of the validation report) goes with it; the counts stay.
  update public.adjustment_imports set status = 'discarded', committed_count = 0, skipped_count = 0, detected = detected - 'sampleRows',
         validation = case when validation is null then null else validation - 'issues' - 'customers' - 'rowNumbers' end where id = p_import;
  if i.file_id is not null then delete from public.uploaded_files where id = i.file_id; end if;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

-- Takes a committed import back: its records are deleted. Refused while a saved risk estimate still cites it.
create function public.withdraw_adjustment_import(p_import uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_t uuid; i public.adjustment_imports%rowtype; v_deleted integer;
begin
  select tenant_id into v_t from public.adjustment_imports where id = p_import;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into i from public.adjustment_imports where id = p_import for update;
  if i.status = 'withdrawn' then return jsonb_build_object('importId', p_import, 'deleted', 0); end if;
  if i.status <> 'committed' then raise exception 'only a committed import can be withdrawn' using errcode = 'P0004'; end if;
  -- (importIds are stored as lower-case uuids, and compared lower-cased here too, so no spelling of an id hides a dependent estimate.)
  if exists (select 1 from public.risk_estimates e where e.tenant_id = v_t and e.archived_at is null and jsonb_typeof(e.inputs -> 'importIds') = 'array'
             and exists (select 1 from jsonb_array_elements_text(e.inputs -> 'importIds') x where lower(x) = lower(p_import::text))) then
    raise exception 'saved risk estimates are based on this import; archive them first' using errcode = 'P0001';
  end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  delete from public.adjustment_records where import_id = p_import;
  get diagnostics v_deleted = row_count;
  update public.adjustment_imports set status = 'withdrawn', detected = detected - 'sampleRows',
         validation = case when validation is null then null else validation - 'issues' - 'customers' - 'rowNumbers' end where id = p_import;
  perform set_config('app.adjustment_rpc', 'off', true);
  return jsonb_build_object('importId', p_import, 'deleted', v_deleted);
end $$;

-- Rolls an interrupted commit back to "validated" so it can be sent again from the start.
create function public.reset_adjustment_import(p_import uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid; i public.adjustment_imports%rowtype;
begin
  select tenant_id into v_t from public.adjustment_imports where id = p_import;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  select * into i from public.adjustment_imports where id = p_import for update;
  if i.status <> 'committing' then raise exception 'this import is not being committed' using errcode = 'P0004'; end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  delete from public.adjustment_records where import_id = p_import;
  update public.adjustment_imports set status = 'validated', committed_count = 0, skipped_count = 0 where id = p_import;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

-- Staff read of an import's records, past the Data API's 1,000-row page. SECURITY INVOKER: row level security decides.
create function public.adjustment_records_json(p_import uuid, p_from integer default 1, p_limit integer default 1000) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'rowNo', r.row_no, 'brandId', r.brand_id, 'shipDate', r.ship_date, 'adjustedOn', r.adjusted_on, 'carrierCode', r.carrier_code,
      'serviceId', r.service_id, 'serviceText', r.service_text, 'adjustmentType', r.adjustment_type, 'cause', r.cause, 'reasonText', r.reason_text,
      'packageRef', r.package_ref, 'declaredWeightLb', r.declared_weight_lb::text, 'declaredWeightBasis', r.declared_weight_basis,
      'actualWeightLb', r.actual_weight_lb::text, 'origLengthIn', r.orig_length_in::text, 'origWidthIn', r.orig_width_in::text, 'origHeightIn', r.orig_height_in::text,
      'corrLengthIn', r.corr_length_in::text, 'corrWidthIn', r.corr_width_in::text, 'corrHeightIn', r.corr_height_in::text,
      'originalCharge', r.original_charge::text, 'correctedCharge', r.corrected_charge::text, 'separateFee', r.separate_fee::text,
      'postageDifference', r.postage_difference::text, 'handlingRecorded', r.handling_recorded) order by r.row_no), '[]'::jsonb)
  from (select * from public.adjustment_records x where x.import_id = p_import and x.row_no >= coalesce(p_from, 1)
        order by x.row_no limit least(greatest(coalesce(p_limit, 1000), 1), 1000)) r;
$$;

-- ---------------------------------------------------------------------------
-- SECTION 8: baselines
-- ---------------------------------------------------------------------------
-- Creates a baseline (p_id null) or edits one: how many packages shipped in a window, for the account (p_brand null) or one customer.
create function public.save_adjustment_baseline(p_tenant uuid, p_brand uuid, p_carrier text, p_service uuid, p_start date, p_end date,
                                                p_packages integer, p_missing integer default null, p_note text default null, p_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid;
begin
  if p_tenant is null or not app.can_manage_adjustments(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_brand is not null and not exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = p_tenant) then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_id is not null and not exists (select 1 from public.adjustment_baselines x where x.id = p_id and x.tenant_id = p_tenant) then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_carrier is not null and not exists (select 1 from public.carriers c where c.code = p_carrier) then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_service is not null and not exists (select 1 from public.shipping_services s where s.id = p_service and (p_carrier is null or s.carrier_code = p_carrier)) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_start is null or p_end is null or p_end < p_start or p_start < date '2015-01-01' or p_end > date '2100-01-01' then raise exception 'invalid period' using errcode = 'PC001'; end if;
  if p_packages is null or p_packages < 1 then raise exception 'packages must be at least 1' using errcode = 'PC001'; end if;
  if p_missing is not null and (p_missing < 0 or p_missing > p_packages) then raise exception 'labels without a weight cannot exceed the packages shipped' using errcode = 'PC001'; end if;
  if v_note is not null and char_length(v_note) > 1000 then raise exception 'the note is limited to 1000 characters' using errcode = 'PC001'; end if;
  perform app.adjustment_lock(p_tenant);
  if p_id is null and (select count(*) from public.adjustment_baselines x where x.tenant_id = p_tenant) >= 500 then raise exception 'the limit of 500 baselines is reached' using errcode = 'P0001'; end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  begin
    if p_id is null then
      insert into public.adjustment_baselines (tenant_id, brand_id, carrier_code, service_id, period_start, period_end, packages_total, labels_missing_weight, note, created_by)
      values (p_tenant, p_brand, p_carrier, p_service, p_start, p_end, p_packages, p_missing, v_note, (select auth.uid())) returning id into v_id;
    else
      update public.adjustment_baselines set brand_id = p_brand, carrier_code = p_carrier, service_id = p_service, period_start = p_start, period_end = p_end,
             packages_total = p_packages, labels_missing_weight = p_missing, note = v_note where id = p_id and tenant_id = p_tenant returning id into v_id;
    end if;
  exception when exclusion_violation then
    raise exception 'this overlaps another baseline for the same customer, carrier and service' using errcode = 'P0007';
  end;
  perform set_config('app.adjustment_rpc', 'off', true);
  return v_id;
end $$;

create function public.delete_adjustment_baseline(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid;
begin
  select tenant_id into v_t from public.adjustment_baselines where id = p_id;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  perform set_config('app.adjustment_rpc', 'on', true);
  delete from public.adjustment_baselines where id = p_id;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 9: saved scenarios and risk estimates (the staff's own statements; amounts are application-computed)
-- ---------------------------------------------------------------------------
create function app.scenario_result_problem(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_c jsonb; v_l jsonb; v_kinds text[] := '{}'; v_kind text; v_state text; v_a jsonb; k text;
begin
  if p ->> 'status' is null or (p ->> 'status') not in ('ok', 'no_adjustment', 'declared_unavailable', 'corrected_unavailable', 'both_unavailable', 'invalid_input') then return 'status'; end if;
  if p ->> 'direction' is null or (p ->> 'direction') not in ('increase', 'decrease', 'none') then return 'direction'; end if;
  if p ->> 'basis' is null or (p ->> 'basis') not in ('exact', 'estimate') then return 'basis'; end if;
  if p ? 'components' then
    if jsonb_typeof(p -> 'components') <> 'array' or jsonb_array_length(p -> 'components') > 2 then return 'components'; end if;
    for v_c in select e.value from jsonb_array_elements(p -> 'components') e loop
      if jsonb_typeof(v_c) <> 'object' then return 'components'; end if;
      v_kind := v_c ->> 'kind'; v_state := v_c ->> 'state';
      if v_kind is null or v_kind not in ('postage_difference', 'separate_fee') or v_kind = any (v_kinds) then return 'component_kind'; end if;
      v_kinds := array_append(v_kinds, v_kind);
      if v_state is null or v_state not in ('conditional', 'waived_for_customer', 'included_in_rate', 'undecided', 'not_configured', 'not_triggered') then return 'component_state'; end if;
      foreach k in array array['amount', 'declaredTotal', 'correctedTotal'] loop
        v_a := v_c -> k;
        if v_a is not null and jsonb_typeof(v_a) <> 'null' and (jsonb_typeof(v_a) <> 'string' or (v_a #>> '{}') !~ '^[0-9]{1,7}\.[0-9]{2}$') then return 'component_amount'; end if;
      end loop;
      if v_c ? 'handling' and (v_c ->> 'handling') not in ('absorbed', 'pass_through', 'manual_approval', 'unconfigured') then return 'component_handling'; end if;
      -- What the engine resolved for the component and for each fee line (the shape is the engine's; the values are only compared
      -- with today's decisions when an example is built, never trusted).
      if v_c ? 'engineHandling' and (jsonb_typeof(v_c -> 'engineHandling') <> 'string'
         or (v_c ->> 'engineHandling') not in ('absorbed', 'pass_through', 'manual_approval', 'unconfigured', 'mixed')) then return 'component_handling'; end if;
      if v_c ? 'lines' then
        if jsonb_typeof(v_c -> 'lines') <> 'array' or jsonb_array_length(v_c -> 'lines') > 40 then return 'component_lines'; end if;
        for v_l in select e.value from jsonb_array_elements(v_c -> 'lines') e loop
          if jsonb_typeof(v_l) <> 'object' or jsonb_typeof(v_l -> 'ruleKey') is distinct from 'string' or char_length(v_l ->> 'ruleKey') not between 1 and 120
             or jsonb_typeof(v_l -> 'handling') is distinct from 'string'
             or (v_l ->> 'handling') not in ('absorbed', 'pass_through', 'manual_approval', 'unconfigured') then return 'component_lines'; end if;
        end loop;
      end if;
    end loop;
  end if;
  return null;
end $$;

-- Saves what a package would cost if it is corrected. The caller sends the engine's input and result and the ids it priced with
-- (p_pins = {rateCardVersionId, ruleVersionIds, overrideIds, pricedOn}); the handling per component is resolved HERE, never trusted.
create function public.save_adjustment_scenario(p_tenant uuid, p_brand uuid, p_name text, p_type text, p_input jsonb, p_result jsonb, p_pins jsonb, p_engine_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, '')); v_problem text; v_priced date; v_version uuid; v_rules uuid[]; v_overrides uuid[];
  v_snap jsonb; v_id uuid; c jsonb; v_h text; v_today date := app.utc_today();
  v_card uuid; v_keys text[]; v_zips uuid[]; v_ctx jsonb; v_context jsonb;
begin
  if p_tenant is null or not app.can_manage_adjustments(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_brand is not null and not exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = p_tenant) then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(v_name) not between 1 and 160 or p_type is null or p_type not in ('reweight', 'remeasure', 'combined')
     or p_engine_version is null or char_length(p_engine_version) not between 1 and 40 then
    raise exception 'invalid scenario' using errcode = 'PC001';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or pg_column_size(p_input) > 16384 or p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 65536
     or p_pins is null or jsonb_typeof(p_pins) <> 'object' then
    raise exception 'the scenario input, result or pins are missing or too large' using errcode = 'PC001';
  end if;
  v_problem := app.scenario_result_problem(p_result);
  if v_problem is not null then raise exception 'the result is not valid (%)', v_problem using errcode = 'PC001'; end if;
  if p_result ? 'adjustmentType' and (p_result ->> 'adjustmentType') is distinct from p_type then raise exception 'the result is for another adjustment type' using errcode = 'PC001'; end if;

  v_priced := app.try_date(p_pins ->> 'pricedOn');
  if v_priced is null then raise exception 'a priced-on date is required' using errcode = 'PC001'; end if;
  if jsonb_typeof(coalesce(p_pins -> 'ruleVersionIds', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_pins -> 'overrideIds', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_pins -> 'ruleVersionIds', '[]'::jsonb)) > 200 or jsonb_array_length(coalesce(p_pins -> 'overrideIds', '[]'::jsonb)) > 200
     or (p_pins ? 'rateCardVersionId' and jsonb_typeof(p_pins -> 'rateCardVersionId') not in ('string', 'null'))
     or (p_pins ? 'ruleKeysInForce' and (jsonb_typeof(p_pins -> 'ruleKeysInForce') <> 'array' or jsonb_array_length(p_pins -> 'ruleKeysInForce') > 500))
     or (p_pins ? 'zipListVersionIds' and (jsonb_typeof(p_pins -> 'zipListVersionIds') <> 'array' or jsonb_array_length(p_pins -> 'zipListVersionIds') > 200)) then
    raise exception 'invalid pins' using errcode = 'PC001';
  end if;
  v_version := app.try_uuid(p_pins ->> 'rateCardVersionId');
  if (p_pins ->> 'rateCardVersionId') is not null and v_version is null then raise exception 'invalid pins' using errcode = 'PC001'; end if;
  v_rules := coalesce((select array_agg(distinct app.try_uuid(x.id)) from jsonb_array_elements_text(coalesce(p_pins -> 'ruleVersionIds', '[]'::jsonb)) x(id)), '{}'::uuid[]);
  v_overrides := coalesce((select array_agg(distinct app.try_uuid(x.id)) from jsonb_array_elements_text(coalesce(p_pins -> 'overrideIds', '[]'::jsonb)) x(id)), '{}'::uuid[]);
  if exists (select 1 from unnest(v_rules) u where u is null) or exists (select 1 from unnest(v_overrides) u where u is null) then raise exception 'invalid pins' using errcode = 'PC001'; end if;
  -- The optional context arrays: rule keys are short text, ZIP list versions are uuids (and must exist, in this account or at platform scope).
  if p_pins ? 'ruleKeysInForce' then
    if exists (select 1 from jsonb_array_elements(p_pins -> 'ruleKeysInForce') x where jsonb_typeof(x.value) <> 'string' or char_length(x.value #>> '{}') not between 1 and 120) then
      raise exception 'invalid pins' using errcode = 'PC001';
    end if;
    v_keys := coalesce((select array_agg(distinct x.k order by x.k) from jsonb_array_elements_text(p_pins -> 'ruleKeysInForce') x(k)), '{}'::text[]);
  end if;
  if p_pins ? 'zipListVersionIds' then
    if exists (select 1 from jsonb_array_elements(p_pins -> 'zipListVersionIds') x where jsonb_typeof(x.value) <> 'string' or app.try_uuid(x.value #>> '{}') is null) then
      raise exception 'invalid pins' using errcode = 'PC001';
    end if;
    v_zips := coalesce((select array_agg(distinct app.try_uuid(x.k) order by app.try_uuid(x.k)) from jsonb_array_elements_text(p_pins -> 'zipListVersionIds') x(k)), '{}'::uuid[]);
    if (select count(*) from public.zip_lists l where l.id = any (v_zips) and (l.tenant_id is null or l.tenant_id = p_tenant)) <> coalesce(array_length(v_zips, 1), 0) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;

  -- Every pin must exist in this account (or be platform scope) and, for a customer's scenario, belong to that customer.
  if v_version is not null then
    if not exists (select 1 from public.rate_card_versions v where v.id = v_version and v.tenant_id = p_tenant) then raise exception 'not found' using errcode = 'P0002'; end if;
    if p_brand is not null and not exists (select 1 from public.rate_card_versions v join public.brand_rate_card_assignments a on a.rate_card_id = v.rate_card_id
                                           where v.id = v_version and a.brand_id = p_brand and a.unassigned_at is null) then
      raise exception 'the rate card is not assigned to this customer' using errcode = 'P0001';
    end if;
  end if;
  if (select count(*) from public.surcharge_rule_versions v where v.id = any (v_rules) and (v.tenant_id is null or v.tenant_id = p_tenant)) <> coalesce(array_length(v_rules, 1), 0) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_brand is null and coalesce(array_length(v_overrides, 1), 0) > 0 then raise exception 'a scenario without a customer carries no customer exceptions' using errcode = 'PC001'; end if;
  if (select count(*) from public.customer_surcharge_overrides o where o.id = any (v_overrides) and o.tenant_id = p_tenant and o.brand_id = p_brand) <> coalesce(array_length(v_overrides, 1), 0) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  v_snap := jsonb_build_object('postage_difference', app.adjustment_handling(p_tenant, p_brand, p_type, 'postage_difference', v_today),
                               'separate_fee', app.adjustment_handling(p_tenant, p_brand, p_type, 'separate_fee', v_today));
  for c in select e.value from jsonb_array_elements(coalesce(p_result -> 'components', '[]'::jsonb)) e loop
    v_h := c ->> 'handling';
    if v_h is not null and v_h is distinct from (v_snap ->> (c ->> 'kind')) then raise exception 'the policy changed while the example was being built; price it again' using errcode = 'PC003'; end if;
  end loop;

  -- The pricing context beyond the pinned versions: what the caller says it priced with, else what the database finds in force for
  -- the card's carriers on the priced-on date (the same query pricing_rules_for_card runs, without the absorbed-fee filter).
  if v_keys is null or v_zips is null then
    select rv.rate_card_id into v_card from public.rate_card_versions rv where rv.id = v_version;
    v_ctx := case when v_card is null then jsonb_build_object('ruleKeys', '[]'::jsonb, 'zipListIds', '[]'::jsonb)
                  else app.pricing_context_keys(p_tenant, p_brand, v_card, v_priced) end;
  end if;
  v_context := jsonb_build_object('ruleKeysInForce', coalesce(to_jsonb(v_keys), v_ctx -> 'ruleKeys'),
                                  'zipListVersionIds', coalesce(to_jsonb(v_zips), v_ctx -> 'zipListIds'),
                                  'source', case when v_keys is not null and v_zips is not null then 'client' when v_keys is null and v_zips is null then 'server' else 'mixed' end);

  perform app.adjustment_lock(p_tenant);
  if (select count(*) from public.adjustment_scenarios s where s.tenant_id = p_tenant and s.archived_at is null) >= 200 then
    raise exception 'the limit of 200 saved examples is reached; archive some first' using errcode = 'P0001';
  end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  insert into public.adjustment_scenarios (tenant_id, brand_id, name, adjustment_type, input, result, engine_version, rate_card_version_id, rule_version_ids, override_ids, policy_snapshot, pricing_context, priced_on, created_by)
  values (p_tenant, p_brand, v_name, p_type, p_input, p_result, p_engine_version, v_version, v_rules, v_overrides, v_snap, v_context, v_priced, (select auth.uid()))
  returning id into v_id;
  perform set_config('app.adjustment_rpc', 'off', true);
  return v_id;
end $$;

-- Saves a risk estimate. inputs.importIds (optional) names the imports it was derived from; result.buckets, when present, must add up to result.countedE4.
create function public.save_risk_estimate(p_tenant uuid, p_brand uuid, p_name text, p_inputs jsonb, p_result jsonb, p_engine_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, '')); v_id uuid; v_sum numeric; k text; v_type text; v_comp text; v_h text;
begin
  if p_tenant is null or not app.can_manage_adjustments(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_brand is not null and not exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = p_tenant) then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(v_name) not between 1 and 160 or p_engine_version is null or char_length(p_engine_version) not between 1 and 40 then raise exception 'invalid estimate' using errcode = 'PC001'; end if;
  if p_inputs is null or jsonb_typeof(p_inputs) <> 'object' or pg_column_size(p_inputs) > 16384 or p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 65536 then
    raise exception 'the estimate inputs or result are missing or too large' using errcode = 'PC001';
  end if;
  if p_inputs ? 'importIds' then
    if jsonb_typeof(p_inputs -> 'importIds') <> 'array' or jsonb_array_length(p_inputs -> 'importIds') > 50
       or exists (select 1 from jsonb_array_elements(p_inputs -> 'importIds') x where jsonb_typeof(x.value) <> 'string' or app.try_uuid(x.value #>> '{}') is null) then
      raise exception 'invalid import list' using errcode = 'PC001';
    end if;
    if (select count(*) from public.adjustment_imports i where i.tenant_id = p_tenant and i.id in (select app.try_uuid(x.value #>> '{}') from jsonb_array_elements(p_inputs -> 'importIds') x))
       <> (select count(distinct lower(x.value #>> '{}')) from jsonb_array_elements(p_inputs -> 'importIds') x) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    -- Stored as sorted, distinct, lower-case uuid text, so the estimate and withdraw_adjustment_import always agree on the id.
    p_inputs := jsonb_set(p_inputs, '{importIds}', coalesce((select jsonb_agg(x.id order by x.id) from (select distinct lower(y.value #>> '{}') as id from jsonb_array_elements(p_inputs -> 'importIds') y) x), '[]'::jsonb));
  end if;
  if p_result ? 'buckets' then
    v_sum := 0;
    foreach k in array array['customerPays', 'decidedCaseByCase', 'notBilledToCustomer', 'notDecided'] loop
      if jsonb_typeof(p_result -> 'buckets' -> k) is distinct from 'number' or (p_result #>> array['buckets', k]) !~ '^[0-9]{1,15}$' then
        raise exception 'every bucket must be a whole number of ten-thousandths of a dollar' using errcode = 'PC001';
      end if;
      v_sum := v_sum + (p_result #>> array['buckets', k])::numeric;
    end loop;
    if jsonb_typeof(p_result -> 'countedE4') is distinct from 'number' or (p_result ->> 'countedE4') !~ '^[0-9]{1,15}$' or (p_result ->> 'countedE4')::numeric <> v_sum then
      raise exception 'the buckets do not add up to the counted total' using errcode = 'PC003';
    end if;
  end if;
  -- Handling the engine reports per component must be what the policy resolves to today.
  v_type := p_inputs ->> 'adjustmentType';
  if v_type is not null and p_result ? 'handling' and jsonb_typeof(p_result -> 'handling') = 'object' then
    if v_type not in ('reweight', 'remeasure', 'combined', 'correction') then raise exception 'invalid adjustment type' using errcode = 'PC001'; end if;
    for v_comp, v_h in select t.k, t.v from jsonb_each_text(p_result -> 'handling') t(k, v) loop
      if v_comp not in ('postage_difference', 'separate_fee') or v_h is distinct from app.adjustment_handling(p_tenant, p_brand, v_type, v_comp, app.utc_today()) then
        raise exception 'the policy changed while the estimate was being made; calculate it again' using errcode = 'PC003';
      end if;
    end loop;
  end if;
  perform app.adjustment_lock(p_tenant);
  if (select count(*) from public.risk_estimates e where e.tenant_id = p_tenant and e.archived_at is null) >= 200 then
    raise exception 'the limit of 200 saved estimates is reached; archive some first' using errcode = 'P0001';
  end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  insert into public.risk_estimates (tenant_id, brand_id, name, inputs, result, engine_version, created_by)
  values (p_tenant, p_brand, v_name, p_inputs, p_result, p_engine_version, (select auth.uid())) returning id into v_id;
  perform set_config('app.adjustment_rpc', 'off', true);
  return v_id;
end $$;

create function public.archive_adjustment_scenario(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid;
begin
  select tenant_id into v_t from public.adjustment_scenarios where id = p_id;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  perform set_config('app.adjustment_rpc', 'on', true);
  update public.adjustment_scenarios set archived_at = now() where id = p_id and archived_at is null;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

create function public.archive_risk_estimate(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid;
begin
  select tenant_id into v_t from public.risk_estimates where id = p_id;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  perform set_config('app.adjustment_rpc', 'on', true);
  update public.risk_estimates set archived_at = now() where id = p_id and archived_at is null;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 10: the customer-facing example. The payload is BUILT HERE from the stored staff scenario (the client sends only text).
-- ---------------------------------------------------------------------------
-- Normalises a package list from the stored input: weights as decimal strings (> 0), dimensions all or none. NULL when invalid.
create function app.example_packages(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_e jsonb; v_out jsonb := '[]'::jsonb; v_w text; v_l text; v_wd text; v_h text;
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) not between 1 and 20 then return null; end if;
  for v_e in select e.value from jsonb_array_elements(p) with ordinality as e(value, ord) order by e.ord loop
    if jsonb_typeof(v_e) <> 'object' then return null; end if;
    v_w := v_e ->> 'weightLb'; v_l := v_e ->> 'lengthIn'; v_wd := v_e ->> 'widthIn'; v_h := v_e ->> 'heightIn';
    if coalesce(app.try_dec(v_w, 6, 6), 0) <= 0 then return null; end if;
    if (v_l is null) <> (v_wd is null) or (v_wd is null) <> (v_h is null) then return null; end if;
    if v_l is not null and (coalesce(app.try_dec(v_l, 6, 6), 0) <= 0 or coalesce(app.try_dec(v_wd, 6, 6), 0) <= 0 or coalesce(app.try_dec(v_h, 6, 6), 0) <= 0) then return null; end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('weightLb', v_w, 'lengthIn', v_l, 'widthIn', v_wd, 'heightIn', v_h)));
  end loop;
  return v_out;
end $$;

-- The rule keys and ZIP list versions in force for the carriers of a rate card on a date, for a customer (or none): the same query
-- pricing_rules_for_card runs for its context, without the filter that hides absorbed fee rules, so the answer does not move when only
-- a decision on who pays changes (that has its own cause). {"ruleKeys":[sorted text],"zipListIds":[sorted uuid]}.
create function app.pricing_context_keys(p_tenant uuid, p_brand uuid, p_card uuid, p_on date) returns jsonb
language sql stable security definer set search_path = '' as $$
  with rules as (
    select r.rule_key, v.conditions
    from public.surcharge_rule_versions v
    join public.surcharge_rules r on r.id = v.rule_id
    where v.status in ('published', 'retired')
      and v.effective_date <= p_on and (v.expiration_date is null or v.expiration_date >= p_on)
      and r.archived_at is null
      and (r.tenant_id is null or r.tenant_id = p_tenant)
      and (r.brand_id is null or (p_brand is not null and r.brand_id = p_brand))
      and r.carrier_code in (select s.carrier_code from public.rate_card_service_terms t
                              join public.rate_card_versions rv on rv.id = t.version_id and rv.rate_card_id = p_card
                              join public.shipping_services s on s.id = t.service_id)
  )
  select jsonb_build_object(
    'ruleKeys', coalesce((select jsonb_agg(q.k order by q.k) from (select distinct x.rule_key as k from rules x) q), '[]'::jsonb),
    'zipListIds', coalesce((select jsonb_agg(l.id order by l.id)
                            from public.zip_lists l
                            where l.status in ('published', 'retired') and l.effective_date <= p_on and (l.expiration_date is null or l.expiration_date >= p_on)
                              and (l.tenant_id is null or l.tenant_id = p_tenant)
                              and l.key in (select distinct k #>> '{}' from rules x, jsonb_path_query(x.conditions, 'strict $.**.listKey') k)), '[]'::jsonb));
$$;

-- Why what an example was priced with is no longer what is in force on p_now. ONE comparison for preview, publish and the read-time
-- state, so they cannot drift: the rate card version in force is the pinned one (rate_card_changed); the customer is still assigned
-- the card with the service allowed (assignment_changed); every pinned rule version is still the one in force and the set of rule keys
-- in force is the one priced with (rule_changed); the customer's exceptions on the pinned rules are the ones priced with
-- (exception_changed); every ZIP list version priced with is still the one in force (zip_list_changed).
create function app.context_causes(p_tenant uuid, p_brand uuid, p_card uuid, p_version uuid, p_service uuid, p_rules uuid[], p_overrides uuid[], p_pinned jsonb, p_now date) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_causes text[] := '{}'; v_rule_ids uuid[]; v_ctx jsonb;
begin
  -- The version the example was priced on must still be the one in force.
  if p_version is distinct from (select v.id from public.rate_card_versions v where v.rate_card_id = p_card and v.status = 'active'
                                   and v.effective_date <= p_now and (v.expiration_date is null or v.expiration_date >= p_now) limit 1) then
    v_causes := array_append(v_causes, 'rate_card_changed');
  end if;
  -- The customer must still be assigned that card with the service allowed.
  if not exists (select 1 from public.brand_rate_card_assignments a join public.rate_cards c on c.id = a.rate_card_id and c.status = 'active'
                 where a.brand_id = p_brand and a.rate_card_id = p_card and a.unassigned_at is null
                   and (a.allowed_service_ids is null or p_service = any (a.allowed_service_ids))) then
    v_causes := array_append(v_causes, 'assignment_changed');
  end if;
  -- Every pinned rule version must still be the version of that rule in force.
  if exists (select 1 from unnest(coalesce(p_rules, '{}'::uuid[])) pid
             left join public.surcharge_rule_versions pv on pv.id = pid
             left join public.surcharge_rules r on r.id = pv.rule_id
             where pv.id is null or r.archived_at is not null
                or pv.id is distinct from (select cv.id from public.surcharge_rule_versions cv where cv.rule_id = pv.rule_id and cv.status in ('published', 'retired')
                                             and cv.effective_date <= p_now and (cv.expiration_date is null or cv.expiration_date >= p_now) limit 1)) then
    v_causes := array_append(v_causes, 'rule_changed');
  end if;
  -- ... and no rule may have appeared or gone: the keys in force are the keys priced with.
  if p_pinned ? 'ruleKeysInForce' or p_pinned ? 'zipListVersionIds' then
    v_ctx := app.pricing_context_keys(p_tenant, p_brand, p_card, p_now);
    if p_pinned ? 'ruleKeysInForce' and array_position(v_causes, 'rule_changed') is null
       and coalesce((select array_agg(x.k order by x.k) from jsonb_array_elements_text(case when jsonb_typeof(p_pinned -> 'ruleKeysInForce') = 'array' then p_pinned -> 'ruleKeysInForce' else '[]'::jsonb end) x(k)), '{}'::text[])
           is distinct from coalesce((select array_agg(x.k order by x.k) from jsonb_array_elements_text(v_ctx -> 'ruleKeys') x(k)), '{}'::text[]) then
      v_causes := array_append(v_causes, 'rule_changed');
    end if;
  end if;
  -- The customer's exceptions on those rules must be the ones the example was priced with.
  v_rule_ids := coalesce((select array_agg(pv.rule_id) from public.surcharge_rule_versions pv where pv.id = any (coalesce(p_rules, '{}'::uuid[]))), '{}'::uuid[]);
  if coalesce((select array_agg(o.id order by o.id) from public.customer_surcharge_overrides o where o.id = any (coalesce(p_overrides, '{}'::uuid[])) and o.rule_id = any (v_rule_ids)), '{}'::uuid[])
     is distinct from coalesce((select array_agg(o.id order by o.id) from public.customer_surcharge_overrides o
                                where o.brand_id = p_brand and o.tenant_id = p_tenant and o.ended_at is null and o.rule_id = any (v_rule_ids)
                                  and o.effective_date <= p_now and (o.expiration_date is null or o.expiration_date >= p_now)), '{}'::uuid[]) then
    v_causes := array_append(v_causes, 'exception_changed');
  end if;
  -- Every ZIP list version priced with must still be the one in force.
  if p_pinned ? 'zipListVersionIds'
     and coalesce((select array_agg(x.k order by x.k) from jsonb_array_elements_text(case when jsonb_typeof(p_pinned -> 'zipListVersionIds') = 'array' then p_pinned -> 'zipListVersionIds' else '[]'::jsonb end) x(k)), '{}'::text[])
         is distinct from coalesce((select array_agg(x.k order by x.k) from jsonb_array_elements_text(v_ctx -> 'zipListIds') x(k)), '{}'::text[]) then
    v_causes := array_append(v_causes, 'zip_list_changed');
  end if;
  return v_causes;
end $$;

-- Builds (and checks) what a customer would see. Returns {ok, problems[{code,message}], payload, hidden[], warnings[], pricedOn,
-- ratesEffectiveFrom, validThrough, pins}. Reads only; callers authorize first. A problem is a refusal to publish, never a partial payload.
create function app.build_customer_example(p_source uuid, p_brand uuid, p_valid_through date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.adjustment_scenarios%rowtype;
  rv public.rate_card_versions%rowtype;
  v_today date := app.utc_today();
  v_problems jsonb := '[]'::jsonb; v_hidden jsonb := '[]'::jsonb; v_warnings jsonb := '[]'::jsonb; v_components jsonb := '[]'::jsonb;
  v_comp jsonb; v_line jsonb; v_kind text; v_state text; v_amount text; v_resolved text; v_kinds text[] := '{}'; v_label text;
  v_eh text; v_line_category text; v_line_h text; v_mixed boolean; v_bad_line boolean;
  v_svc uuid; v_carrier text; v_service text; v_decl jsonb; v_corr jsonb; v_residential jsonb; v_zone integer;
  v_end date; v_policy_end date; v_valid date; v_payload jsonb; v_pins jsonb; v_handling jsonb := '{}'::jsonb; v_shown integer := 0;
  v_fail boolean := false; v_causes text[];
begin
  select * into s from public.adjustment_scenarios where id = p_source;
  if not found then
    return jsonb_build_object('ok', false, 'problems', app.add_problem('[]'::jsonb, 'not_found', 'This example could not be found.'));
  end if;
  if s.archived_at is not null then v_problems := app.add_problem(v_problems, 'archived', 'This example is archived.'); end if;
  if s.brand_id is null then
    v_problems := app.add_problem(v_problems, 'no_customer', 'This example was priced without a customer. Price it for the customer you want to share it with.');
  elsif s.brand_id is distinct from p_brand then
    v_problems := app.add_problem(v_problems, 'wrong_customer', 'This example was priced for a different customer.');
  end if;
  if not exists (select 1 from public.brands b join public.tenants t on t.id = b.tenant_id where b.id = p_brand and b.tenant_id = s.tenant_id and b.status = 'active' and t.status = 'active') then
    v_problems := app.add_problem(v_problems, 'customer_inactive', 'This customer is not active.');
  end if;
  if s.result ->> 'status' = 'no_adjustment' then
    v_problems := app.add_problem(v_problems, 'no_adjustment', 'Nothing changes in this example, so there is nothing to share.');
  elsif s.result ->> 'status' is distinct from 'ok' then
    v_problems := app.add_problem(v_problems, 'not_priced', 'This example could not be priced, so it cannot be shared.');
  end if;
  if s.result ->> 'basis' is distinct from 'exact' then v_problems := app.add_problem(v_problems, 'estimate_basis', 'An example built from estimated amounts cannot be shared.'); end if;
  if s.result ->> 'direction' is distinct from 'increase' then v_problems := app.add_problem(v_problems, 'not_an_increase', 'The corrected charge is not higher. This is a credit, not an adjustment charge.'); end if;

  -- The rate card the example was priced on must be this customer's, active and in force, and the service allowed.
  select * into rv from public.rate_card_versions v where v.id = s.rate_card_version_id;
  v_svc := app.try_uuid(s.input ->> 'serviceId');
  if not found or rv.status <> 'active' or v_svc is null
     or not exists (select 1 from public.brand_rate_card_assignments a join public.rate_cards c on c.id = a.rate_card_id and c.status = 'active'
                    where a.brand_id = p_brand and a.rate_card_id = rv.rate_card_id and a.unassigned_at is null
                      and (a.allowed_service_ids is null or v_svc = any (a.allowed_service_ids)))
     or not exists (select 1 from public.rate_card_service_terms t where t.version_id = rv.id and t.service_id = v_svc) then
    v_problems := app.add_problem(v_problems, 'rate_card_not_assigned', 'The rate card or service this example was priced on is not available to this customer.');
  elsif rv.effective_date > v_today or (rv.expiration_date is not null and rv.expiration_date < v_today) then
    v_problems := app.add_problem(v_problems, 'rate_card_not_in_effect', 'The rate card this example was priced on is not in effect today. Price it again.');
  end if;

  -- Nothing it was priced with may have changed since: the very comparison that decides whether a shared example is "under review"
  -- (a rule that appeared, a ZIP list that was republished, a new customer exception, ...). Otherwise the example would be born under review.
  if rv.id is not null and v_svc is not null then
    v_causes := app.context_causes(s.tenant_id, p_brand, rv.rate_card_id, s.rate_card_version_id, v_svc, s.rule_version_ids, s.override_ids, s.pricing_context, v_today);
    if cardinality(v_causes) > 0 then
      v_problems := app.add_problem(v_problems, 'context_changed', 'Something this example was priced with has changed since it was priced. Price it again.');
    end if;
  end if;

  -- Policy: what was pinned at save time must still be what the policy resolves to, and nothing the customer would read may be undecided.
  foreach v_kind in array array['postage_difference', 'separate_fee'] loop
    v_resolved := app.adjustment_handling(s.tenant_id, p_brand, s.adjustment_type, v_kind, v_today);
    v_handling := v_handling || jsonb_build_object(v_kind, v_resolved);
    if s.policy_snapshot ->> v_kind is distinct from v_resolved then v_fail := true; end if;
  end loop;
  if v_fail then v_problems := app.add_problem(v_problems, 'policy_changed', 'The decision on who pays changed since this example was saved. Price it again.'); end if;

  for v_comp in select e.value from jsonb_array_elements(coalesce(s.result -> 'components', '[]'::jsonb)) e loop
    v_kind := v_comp ->> 'kind'; v_state := v_comp ->> 'state'; v_amount := v_comp ->> 'amount';
    v_label := case v_kind when 'separate_fee' then 'Separate adjustment fee' else 'Shipping charge difference' end;
    if v_kind = any (v_kinds) then v_problems := app.add_problem(v_problems, 'invalid_result', 'The saved result is not valid. Price it again.'); end if;
    v_kinds := array_append(v_kinds, v_kind);
    v_resolved := v_handling ->> v_kind;
    -- One amount carries ONE label. When what the engine resolved for the component (engineHandling, "mixed" when its fee lines differ)
    -- or for any of its fee lines is not what today's decisions give the component, no single label would be true: refuse, never
    -- publish the amount under the type's label (an absorbed line must never reach a customer) and never hide a charged one silently.
    v_mixed := false; v_bad_line := false;
    if v_state = 'conditional' then
      v_eh := v_comp ->> 'engineHandling';
      if v_eh is not null and v_eh is distinct from v_resolved then v_mixed := true; end if;
      if jsonb_typeof(v_comp -> 'lines') = 'array' then
        for v_line in select e.value from jsonb_array_elements(v_comp -> 'lines') e loop
          -- The line's own decision: a correction fee follows the 'correction' row, a reweigh or remeasure fee the scenario type's row.
          select r.category into v_line_category
            from public.surcharge_rule_versions pv join public.surcharge_rules r on r.id = pv.rule_id
           where pv.id = any (s.rule_version_ids) and r.rule_key = v_line ->> 'ruleKey' limit 1;
          if v_kind <> 'separate_fee' or v_line_category is null or v_line_category not in ('reweight', 'remeasure', 'shipping_charge_correction') then
            v_bad_line := true;
          else
            v_line_h := app.adjustment_handling(s.tenant_id, p_brand, case v_line_category when 'shipping_charge_correction' then 'correction' else s.adjustment_type end, 'separate_fee', v_today);
            if v_line ->> 'handling' is distinct from v_line_h or v_line_h is distinct from v_resolved then v_mixed := true; end if;
          end if;
        end loop;
      end if;
    end if;
    if v_bad_line then
      v_problems := app.add_problem(v_problems, 'invalid_result', 'The saved result is not valid. Price it again.');
    elsif v_mixed then
      v_problems := app.add_problem(v_problems, 'mixed_handling', 'The parts of the ' || lower(v_label) || ' are handled differently, or a decision changed, so it cannot be shared as one amount. Price it again.');
    elsif v_state = 'conditional' then
      if v_resolved = 'unconfigured' then
        v_problems := app.add_problem(v_problems, 'undecided_policy', 'Decide how the ' || lower(v_label) || ' is handled for this customer first.');
      elsif v_resolved = 'absorbed' then
        v_hidden := v_hidden || jsonb_build_array(jsonb_build_object('kind', v_kind, 'reason', 'absorbed'));
      elsif v_amount is null or v_amount !~ '^[0-9]{1,7}\.[0-9]{2}$' or v_amount::numeric < 0.01 then
        v_problems := app.add_problem(v_problems, 'component_below_minimum', 'The ' || lower(v_label) || ' must be at least $0.01 to be shared.');
      else
        v_shown := v_shown + 1;
        v_components := v_components || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('kind', v_kind, 'handling', v_resolved, 'amount', v_amount,
          'declaredTotal', case when v_kind = 'postage_difference' then v_comp ->> 'declaredTotal' end,
          'correctedTotal', case when v_kind = 'postage_difference' then v_comp ->> 'correctedTotal' end)));
        select a.valid_to into v_policy_end from app.adjustment_policy_at(s.tenant_id, p_brand, s.adjustment_type, v_kind, v_today) a;
        if v_policy_end is not null then v_end := least(coalesce(v_end, v_policy_end), v_policy_end); end if;
      end if;
    elsif v_state = 'not_configured' then
      v_hidden := v_hidden || jsonb_build_array(jsonb_build_object('kind', v_kind, 'reason', 'not_configured'));
      if v_kind = 'separate_fee' then v_warnings := v_warnings || jsonb_build_array('separate_fee_not_configured'); end if;
    elsif v_state in ('waived_for_customer', 'included_in_rate', 'not_triggered') then
      v_hidden := v_hidden || jsonb_build_array(jsonb_build_object('kind', v_kind, 'reason', v_state));
    else
      v_problems := app.add_problem(v_problems, 'component_undecided', 'The ' || lower(v_label) || ' could not be decided, so it cannot be shared.');
    end if;
  end loop;
  if v_shown = 0 and jsonb_array_length(v_problems) = 0 then
    v_problems := app.add_problem(v_problems, 'no_customer_visible_component', 'Nothing in this example is charged or decided case by case, so there is nothing to share.');
  end if;

  -- The example package, from the stored input (catalog display names, never ids).
  v_decl := app.example_packages(s.input #> '{declared,packages}'); v_corr := app.example_packages(s.input #> '{corrected,packages}');
  v_residential := s.input -> 'residential';
  v_zone := case when jsonb_typeof(s.input -> 'zone') = 'number' and (s.input ->> 'zone') ~ '^[0-9]{1,6}$' then (s.input ->> 'zone')::integer end;
  select c.name, sv.name into v_carrier, v_service from public.shipping_services sv join public.carriers c on c.code = sv.carrier_code where sv.id = v_svc;
  if v_decl is null or v_corr is null or jsonb_array_length(v_decl) <> jsonb_array_length(v_corr) or jsonb_typeof(v_residential) is distinct from 'boolean'
     or v_carrier is null or v_service is null then
    v_problems := app.add_problem(v_problems, 'input_incomplete', 'The saved package details are incomplete. Price it again.');
  end if;

  -- Valid through: the shortest of the requested date (never beyond 90 days) and every end date this example depends on.
  v_end := (select min(d) from (
              select rv.expiration_date as d
              union all select cv.expiration_date from public.surcharge_rule_versions cv where cv.id = any (s.rule_version_ids)
              union all select o.expiration_date from public.customer_surcharge_overrides o where o.id = any (s.override_ids)
              union all select v_end) x where d is not null);
  v_valid := least(coalesce(p_valid_through, v_today + 90), v_today + 90, coalesce(v_end, 'infinity'::date));
  if v_valid < v_today then v_problems := app.add_problem(v_problems, 'ended', 'A rate, rule or decision this example depends on has already ended.'); end if;

  if jsonb_array_length(v_problems) = 0 then
    v_payload := jsonb_build_object('v', 1, 'adjustmentType', s.adjustment_type, 'pricedOn', s.priced_on,
      'input', jsonb_build_object('service', jsonb_build_object('carrier', v_carrier, 'service', v_service), 'direction', 'increase',
                                  'declared', jsonb_build_object('packages', v_decl), 'corrected', jsonb_build_object('packages', v_corr),
                                  'residential', v_residential, 'zone', v_zone),
      'components', v_components);
    if not coalesce(app.customer_json_ok(v_payload, app.shape_published_payload()), false) then
      v_problems := app.add_problem(v_problems, 'payload_invalid', 'This example cannot be shown to a customer in its present form.');
    end if;
  end if;
  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'problems', v_problems, 'hidden', v_hidden, 'warnings', v_warnings);
  end if;
  v_pins := jsonb_build_object('rateCardId', rv.rate_card_id, 'rateCardVersionId', rv.id, 'serviceId', v_svc, 'adjustmentType', s.adjustment_type,
                               'ruleVersionIds', to_jsonb(s.rule_version_ids), 'overrideIds', to_jsonb(s.override_ids), 'handling', v_handling,
                               'ruleKeysInForce', coalesce(s.pricing_context -> 'ruleKeysInForce', '[]'::jsonb),
                               'zipListVersionIds', coalesce(s.pricing_context -> 'zipListVersionIds', '[]'::jsonb));
  return jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'payload', v_payload, 'hidden', v_hidden, 'warnings', v_warnings, 'pricedOn', s.priced_on,
                            'ratesEffectiveFrom', rv.effective_date, 'validThrough', v_valid, 'pins', v_pins);
end $$;

-- Staff preview: exactly what a customer would read (same builder as the publish), plus what is withheld. Never raises for a business refusal.
create function public.preview_customer_example(p_source uuid, p_brand uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_t uuid;
begin
  select tenant_id into v_t from public.adjustment_scenarios where id = p_source;
  if v_t is null or not app.can_view_adjustments(v_t) or p_brand is null or not exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = v_t) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return app.build_customer_example(p_source, p_brand, null) - 'pins';
end $$;

-- Shares an example with one customer. Only text comes from the caller: title, an optional note the customer will read, an optional
-- private note, and a shorter "shown until" date. Republishing the same source stops the previous copy in the same transaction.
create function public.publish_customer_example(p_source uuid, p_brand uuid, p_title text, p_note text default null, p_valid_through date default null,
                                                p_internal_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_t uuid; s public.adjustment_scenarios%rowtype; b jsonb; v_id uuid;
  v_title text := btrim(coalesce(p_title, '')); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_internal text := nullif(btrim(coalesce(p_internal_note, '')), '');
begin
  select tenant_id into v_t from public.adjustment_scenarios where id = p_source;
  if v_t is null or not app.can_manage_adjustments(v_t) or p_brand is null or not exists (select 1 from public.brands x where x.id = p_brand and x.tenant_id = v_t) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not app.plain_text_ok(v_title, 120) then raise exception 'the title must be 1 to 120 characters of plain text' using errcode = 'PC001'; end if;
  if v_note is not null and not app.plain_text_ok(v_note, 300) then raise exception 'the note to the customer must be up to 300 characters of plain text' using errcode = 'PC001'; end if;
  if v_internal is not null and char_length(v_internal) > 1000 then raise exception 'the private note is limited to 1000 characters' using errcode = 'PC001'; end if;
  perform app.adjustment_lock(v_t);
  select * into s from public.adjustment_scenarios where id = p_source for update;
  b := app.build_customer_example(p_source, p_brand, p_valid_through);
  if not (b ->> 'ok')::boolean then
    raise exception '%', b #>> '{problems,0,message}' using errcode = 'P0001', hint = b #>> '{problems,0,code}';
  end if;
  if (select count(*) from public.published_adjustment_examples e where e.brand_id = p_brand and e.retired_at is null and e.source_scenario_id <> p_source) >= 25 then
    raise exception 'the limit of 25 shared examples per customer is reached' using errcode = 'P0001';
  end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  update public.published_adjustment_examples set retired_at = now(), retired_by = (select auth.uid())
   where brand_id = p_brand and source_scenario_id = p_source and retired_at is null;
  insert into public.published_adjustment_examples (tenant_id, brand_id, source_scenario_id, title, note_to_customer, payload, payload_sha256, priced_on, rates_effective_from,
                                                   valid_through, pins, internal_note, published_by)
  values (v_t, p_brand, p_source, v_title, v_note, b -> 'payload', sha256(convert_to((b -> 'payload')::text, 'UTF8')), (b ->> 'pricedOn')::date, (b ->> 'ratesEffectiveFrom')::date,
          (b ->> 'validThrough')::date, b -> 'pins', v_internal, (select auth.uid()))
  returning id into v_id;
  perform set_config('app.adjustment_rpc', 'off', true);
  return v_id;
end $$;

-- Stops sharing. Idempotent; the row stays so staff can reproduce what a customer saw on a given date.
create function public.retire_customer_example(p_example uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_t uuid;
begin
  select tenant_id into v_t from public.published_adjustment_examples where id = p_example;
  if v_t is null or not app.can_manage_adjustments(v_t) then raise exception 'not found' using errcode = 'P0002'; end if;
  perform app.adjustment_lock(v_t);
  perform set_config('app.adjustment_rpc', 'on', true);
  update public.published_adjustment_examples set retired_at = now(), retired_by = (select auth.uid()) where id = p_example and retired_at is null;
  perform set_config('app.adjustment_rpc', 'off', true);
end $$;

-- Read-time staleness (never by trigger, so it is always current). state: current | under_review | expired | retired, plus the causes.
create function app.example_state(e public.published_adjustment_examples) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_causes text[] := '{}'; v_now date := app.utc_today();
  v_card uuid := app.try_uuid(e.pins ->> 'rateCardId');
  v_version uuid := app.try_uuid(e.pins ->> 'rateCardVersionId');
  v_service uuid := app.try_uuid(e.pins ->> 'serviceId');
  v_type text := e.pins ->> 'adjustmentType';
  v_rules uuid[]; v_overrides uuid[]; v_comp text; v_pinned text;
begin
  if e.retired_at is not null then return jsonb_build_object('state', 'retired', 'causes', '[]'::jsonb); end if;
  if e.valid_through < v_now then return jsonb_build_object('state', 'expired', 'causes', jsonb_build_array('valid_through_passed')); end if;
  if not exists (select 1 from public.brands b join public.tenants t on t.id = b.tenant_id where b.id = e.brand_id and b.status = 'active' and t.status = 'active') then
    v_causes := array_append(v_causes, 'brand_inactive');
  end if;
  -- Everything it was priced with (card version, assignment, rule versions and the rules in force, exceptions, ZIP lists).
  v_rules := coalesce((select array_agg(app.try_uuid(x.id)) from jsonb_array_elements_text(coalesce(e.pins -> 'ruleVersionIds', '[]'::jsonb)) x(id)), '{}'::uuid[]);
  v_overrides := coalesce((select array_agg(app.try_uuid(x.id)) from jsonb_array_elements_text(coalesce(e.pins -> 'overrideIds', '[]'::jsonb)) x(id)), '{}'::uuid[]);
  v_causes := v_causes || app.context_causes(e.tenant_id, e.brand_id, v_card, v_version, v_service, v_rules, v_overrides, e.pins, v_now);
  -- The resolved handling of each component (compare what it resolves to, not which row) must be what was pinned.
  for v_comp, v_pinned in select t.k, t.v from jsonb_each_text(coalesce(e.pins -> 'handling', '{}'::jsonb)) t(k, v) loop
    if app.adjustment_handling(e.tenant_id, e.brand_id, v_type, v_comp, v_now) is distinct from v_pinned then
      v_causes := array_append(v_causes, 'policy_changed');
      exit;
    end if;
  end loop;
  return jsonb_build_object('state', case when cardinality(v_causes) = 0 then 'current' else 'under_review' end, 'causes', to_jsonb(v_causes));
end $$;

create function public.adjustment_example_state(p_example uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e public.published_adjustment_examples%rowtype;
begin
  select * into e from public.published_adjustment_examples x where x.id = p_example;
  if not found or not app.can_view_adjustments(e.tenant_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  return app.example_state(e);
end $$;

-- The "needs review" list in one call: every live example of the account with its computed state and causes.
create function public.adjustment_example_states(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_tenant is null or not app.can_view_adjustments(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'brandId', e.brand_id) || app.example_state(e) order by e.published_at desc, e.id)
                   from public.published_adjustment_examples e where e.tenant_id = p_tenant and e.retired_at is null), '[]'::jsonb);
end $$;

-- What a customer's members may read: an explicit projection of live, non-retired examples of THEIR brand. The payload is hidden
-- (null) unless the example is current, and so are the 3PL's note and title (a neutral title is returned instead): both are staff-typed text that
-- may restate an amount. The customer sees one neutral state whatever the cause. Anyone else gets an empty list.
create function public.brand_adjustment_examples(p_brand uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if p_brand is null or not app.has_brand_permission(p_brand, 'brand.view')
     or not exists (select 1 from public.brands b join public.tenants t on t.id = b.tenant_id where b.id = p_brand and b.status = 'active' and t.status = 'active') then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(x.el order by x.published_at desc, x.id), '[]'::jsonb) into v_out from (
    select e.id, e.published_at, jsonb_build_object(
      'id', e.id, 'title', case when st.state = 'current' then e.title else 'Example' end,
      'note', case when st.state = 'current' then e.note_to_customer end,
      'payload', case when st.state = 'current' then e.payload else 'null'::jsonb end,
      'pricedOn', e.priced_on, 'ratesEffectiveFrom', e.rates_effective_from, 'validThrough', e.valid_through, 'publishedAt', e.published_at,
      'state', st.state) as el
    from public.published_adjustment_examples e
    cross join lateral (select app.example_state(e) ->> 'state' as state) st
    where e.brand_id = p_brand and e.retired_at is null
  ) x;
  if not coalesce(app.customer_json_ok(v_out, jsonb_build_object('t', 'arr', 'max', 25, 'items', app.shape_brand_example())), false) then
    raise exception 'examples are not available' using errcode = 'P0001';
  end if;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 11: offboarding (service role only: no application path calls these)
-- ---------------------------------------------------------------------------
create function app.purge_tenant_adjustment_data(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := '{}'::jsonb; n integer;
begin
  perform set_config('app.adjustment_rpc', 'on', true);
  perform set_config('app.adjustment_purge', 'on', true);
  perform app.write_audit(p_tenant, null, 'adjustment.data_purged', 'tenant', p_tenant::text, jsonb_build_object('scope', 'tenant'));
  delete from public.published_adjustment_examples where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('published', n);
  delete from public.risk_estimates where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('estimates', n);
  delete from public.adjustment_scenarios where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('scenarios', n);
  delete from public.adjustment_baselines where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('baselines', n);
  delete from public.adjustment_records where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('records', n);
  delete from public.adjustment_imports where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('imports', n);
  delete from public.uploaded_files where tenant_id = p_tenant and purpose = 'adjustment_import'; get diagnostics n = row_count; v := v || jsonb_build_object('files', n);
  delete from public.adjustment_policies where tenant_id = p_tenant; get diagnostics n = row_count; v := v || jsonb_build_object('policies', n);
  perform set_config('app.adjustment_rpc', 'off', true);
  perform set_config('app.adjustment_purge', 'off', true);
  return v;
end $$;

create function app.purge_brand_adjustment_data(p_brand uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := '{}'::jsonb; n integer; v_t uuid;
begin
  select tenant_id into v_t from public.brands where id = p_brand;
  if v_t is null then return v; end if;
  perform set_config('app.adjustment_rpc', 'on', true);
  perform set_config('app.adjustment_purge', 'on', true);
  perform app.write_audit(v_t, p_brand, 'adjustment.data_purged', 'brand', p_brand::text, jsonb_build_object('scope', 'brand'));
  delete from public.published_adjustment_examples where brand_id = p_brand; get diagnostics n = row_count; v := v || jsonb_build_object('published', n);
  delete from public.risk_estimates where brand_id = p_brand; get diagnostics n = row_count; v := v || jsonb_build_object('estimates', n);
  delete from public.adjustment_scenarios where brand_id = p_brand; get diagnostics n = row_count; v := v || jsonb_build_object('scenarios', n);
  delete from public.adjustment_baselines where brand_id = p_brand; get diagnostics n = row_count; v := v || jsonb_build_object('baselines', n);
  delete from public.adjustment_records where brand_id = p_brand; get diagnostics n = row_count; v := v || jsonb_build_object('records', n);
  delete from public.adjustment_policies where brand_id = p_brand; get diagnostics n = row_count; v := v || jsonb_build_object('policies', n);
  perform set_config('app.adjustment_rpc', 'off', true);
  perform set_config('app.adjustment_purge', 'off', true);
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 12: shared functions redefined (copied from their latest definitions, then changed; each change is commented)
-- ---------------------------------------------------------------------------
-- finish_simulation_run (M4): stores the summary and the in-flight state without the load-issue text.
create or replace function public.finish_simulation_run(p_run uuid, p_summary jsonb, p_reference_data jsonb, p_engine_version text, p_monthly_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype;
  v_mo integer; v_ms integer; v_mp integer; v_ok integer; v_un integer;
  v_def numeric(14,2); v_est numeric(14,2); v_exp numeric(14,2); v_cond numeric(14,2); v_unr numeric(14,2);
  v_po integer; v_pdef numeric(14,4); v_pest numeric(14,4); v_counts jsonb; v_fixed numeric(14,4); v_topup numeric(14,4); v_mstatus text; v_n integer; m record; v_line record;
  v_ship numeric; v_projected numeric(14,2);
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) or not app.project_visible(v_r.project_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then raise exception 'run is %', v_r.status using errcode = 'P0001'; end if;
  if v_r.processed_shipments <> v_r.total_shipments then raise exception 'run has % of % shipments priced', v_r.processed_shipments, v_r.total_shipments using errcode = 'PC003'; end if;
  if (p_summary ->> 'version')::integer is distinct from 2 then raise exception 'summary version is not supported by this release' using errcode = 'PC002'; end if;

  -- Shipping: a modeled order is one whose every shipment priced ok and that was not cancelled.
  create temp table _mo on commit drop as
    select r.order_id
    from public.simulation_results r join public.orders o on o.id = r.order_id
    where r.run_id = p_run and not o.cancelled
    group by r.order_id
    having bool_and(r.status = 'ok');
  select count(*) into v_mo from _mo;
  select count(*), coalesce(sum(r.definite), 0), coalesce(sum(r.estimated), 0), coalesce(sum(r.expected), 0), coalesce(sum(r.conditional_exposure), 0), coalesce(sum(r.unresolved), 0)
    into v_ms, v_def, v_est, v_exp, v_cond, v_unr
    from public.simulation_results r where r.run_id = p_run and r.order_id in (select order_id from _mo);
  select coalesce(sum(coalesce(array_length(r.billable_lb, 1), 0)), 0) into v_mp from public.simulation_results r where r.run_id = p_run and r.order_id in (select order_id from _mo);
  select count(*) filter (where status = 'ok'), count(*) filter (where status = 'unavailable') into v_ok, v_un from public.simulation_results where run_id = p_run;
  if p_summary is null
     or (p_summary #>> '{modeled,orders}')::integer is distinct from v_mo
     or (p_summary #>> '{modeled,shipments}')::integer is distinct from v_ms
     or (p_summary #>> '{totals,expected}')::numeric is distinct from v_exp
     or (p_summary #>> '{totals,definite}')::numeric is distinct from v_def
     or (p_summary #>> '{totals,estimated}')::numeric is distinct from v_est then
    raise exception 'summary does not reconcile with stored results (orders % / shipments % / expected %)', v_mo, v_ms, v_exp using errcode = 'PC003';
  end if;
  update public.simulation_results r set in_totals = true where r.run_id = p_run and r.order_id in (select order_id from _mo);

  -- Fees: every order has a result; the dictionary names rules of versions this run pinned.
  select count(*) into v_n from public.simulation_order_results x where x.run_id = p_run;
  if v_n <> (select count(distinct order_id) from public.simulation_results where run_id = p_run) then raise exception 'every order needs a fee result' using errcode = 'PC003'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_reference_data -> 'feeDictionary', '[]'::jsonb)) d
             left join public.fee_rules fr on fr.id = (d ->> 'ruleId')::uuid
             where fr.id is null or fr.key <> d ->> 'key' or fr.category <> d ->> 'category' or fr.basis <> d ->> 'basis' or fr.scope <> d ->> 'scope' or fr.name <> d ->> 'name'
                or not exists (select 1 from public.simulation_run_fee_contexts c where c.run_id = p_run and c.fee_schedule_version_id = fr.version_id)
                   and fr.version_id is distinct from v_r.monthly_fee_schedule_version_id) then
    raise exception 'the fee dictionary names a rule this run did not price with' using errcode = 'PC003';
  end if;
  update public.simulation_order_results x set in_totals = true where x.run_id = p_run and x.fee_status in ('ok', 'partial') and x.order_id in (select order_id from _mo);
  select count(*), coalesce(sum(x.processing_definite), 0) / 10000.0, coalesce(sum(x.processing_estimated), 0) / 10000.0 into v_po, v_pdef, v_pest
    from public.simulation_order_results x where x.run_id = p_run and x.in_totals;
  select coalesce(jsonb_object_agg(s.fee_status, s.n), '{}'::jsonb) into v_counts
    from (select x.fee_status, count(*) as n from public.simulation_order_results x where x.run_id = p_run and x.order_id in (select order_id from _mo) group by x.fee_status) s;
  if (p_summary #>> '{processing,orders}')::integer is distinct from v_po
     or (p_summary #>> '{processing,definite}')::numeric is distinct from v_pdef
     or (p_summary #>> '{processing,estimated}')::numeric is distinct from v_pest then
    raise exception 'processing totals do not reconcile with stored order results (orders % / definite % / estimated %)', v_po, v_pdef, v_pest using errcode = 'PC003';
  end if;

  -- Monthly lines: recomputed from the stored answers and the pinned version; the caller's lines must agree exactly.
  if v_r.monthly_fee_schedule_version_id is not null and coalesce(v_r.assumptions #>> '{fulfillment,skip}', 'false') <> 'true' then
    create temp table _ml on commit drop as select * from app.fee_monthly_lines(v_r.monthly_fee_schedule_version_id, coalesce(v_r.assumptions -> 'fulfillment', '{}'::jsonb), v_r.monthly_orders);
    if (select count(*) from _ml) <> jsonb_array_length(coalesce(p_monthly_lines, '[]'::jsonb))
       or exists (select 1 from _ml l
                  left join jsonb_to_recordset(coalesce(p_monthly_lines, '[]'::jsonb)) as c(rule_id uuid, quantity numeric, amount_e4 bigint, status text) on c.rule_id = l.rule_id
                  where c.rule_id is null or c.status is distinct from l.status
                     or (l.status = 'priced' and (round(c.quantity, 6) is distinct from round(l.quantity, 6) or c.amount_e4 is distinct from round(l.amount * 10000)::bigint))) then
      raise exception 'monthly lines do not reconcile with the fee schedule and the stored answers' using errcode = 'PC003';
    end if;
    insert into public.simulation_monthly_lines (run_id, tenant_id, brand_id, rule_id, driver_key, quantity, unit_amount, amount, charge_class, status, reason)
    select p_run, v_r.tenant_id, v_r.brand_id, l.rule_id, l.driver_key, round(l.quantity, 6), case when fr.method = 'flat' then fr.amount end, l.amount,
           case when l.status = 'priced' then case when fr.basis = 'month' then 'definite' else 'estimated' end end, l.status, l.reason
    from _ml l join public.fee_rules fr on fr.id = l.rule_id;
    select coalesce(sum(amount), 0) into v_fixed from _ml where status = 'priced';
    if (p_summary #>> '{monthly,totalE4}')::bigint is distinct from round(v_fixed * 10000)::bigint then
      raise exception 'monthly total does not reconcile (%)', v_fixed using errcode = 'PC003';
    end if;
    -- Minimum top-ups per calendar month, from stored order results.
    v_topup := 0; v_mstatus := 'none';
    for m in select * from app.run_minimums(p_run, p_reference_data -> 'feeDictionary') loop
      if not exists (select 1 from jsonb_array_elements(coalesce(p_summary -> 'minimums', '[]'::jsonb)) e
                     where e ->> 'ruleKey' = m.rule_key and (e ->> 'topUpE4')::bigint = m.topup_e4 and e ->> 'status' = m.status and (e ->> 'minimumE4')::bigint = m.minimum_e4 and (e ->> 'countedE4')::bigint = m.counted_e4) then
        raise exception 'minimum top-up for "%" does not reconcile (sql: % %, counted %)', m.rule_key, m.status, m.topup_e4, m.counted_e4 using errcode = 'PC003';
      end if;
      v_topup := v_topup + m.topup_e4 / 10000.0;
      v_mstatus := case when m.status = 'not_computed' or v_mstatus = 'not_computed' then 'not_computed'
                        when m.status = 'upper_bound' or v_mstatus = 'upper_bound' then 'upper_bound' else 'exact' end;
    end loop;
    if (p_summary #>> '{minimumStatus}') is distinct from v_mstatus then raise exception 'minimum status does not reconcile (%)', v_mstatus using errcode = 'PC003'; end if;

    -- Projected monthly total (design §2 allocate, D3–D5): shipping and processing extrapolated from the processing
    -- orders at ≥ 80 % coverage (else the period average), plus monthly fixed charges and an exact top-up. One rounding.
    if v_r.monthly_orders is not null and v_po > 0 then
      select coalesce(sum(sr.expected), 0) into v_ship from public.simulation_results sr
       where sr.run_id = p_run and sr.in_totals and sr.order_id in (select x.order_id from public.simulation_order_results x where x.run_id = p_run and x.in_totals);
      if v_r.population_orders > 0 and v_po::numeric * 100 / v_r.population_orders >= 80 then
        v_projected := v_ship * v_r.monthly_orders / v_po + (v_pdef + v_pest) * v_r.monthly_orders / v_po;
      else
        v_projected := (v_ship + v_pdef + v_pest) / coalesce(nullif(v_r.forecast_months, 0), 1);
      end if;
      v_projected := round(v_projected + v_fixed + case when v_mstatus = 'exact' then v_topup / coalesce(nullif(v_r.forecast_months, 0), 1) else 0 end, 2);
      if p_summary #>> '{allocation,monthly,total}' is null or abs((p_summary #>> '{allocation,monthly,total}')::numeric - v_projected) > 0.01 then
        raise exception 'projected monthly total does not reconcile (sql %)', v_projected using errcode = 'PC003';
      end if;
    end if;
  else
    if jsonb_array_length(coalesce(p_monthly_lines, '[]'::jsonb)) <> 0 then raise exception 'this run has no monthly fees' using errcode = 'PC003'; end if;
  end if;

  update public.simulation_runs
     set status = 'completed', summary = app.summary_without_load_issues(p_summary), reference_data = app.summary_without_load_issues(p_reference_data), partial_summary = app.summary_without_load_issues(partial_summary),
         engine_version = p_engine_version, fee_engine_version = p_summary ->> 'feeEngineVersion',
         modeled_orders = v_mo, modeled_shipments = v_ms, modeled_packages = v_mp, ok_shipments = v_ok, unavailable_shipments = v_un,
         total_definite = v_def, total_estimated = v_est, total_expected = v_exp, total_conditional = v_cond, total_unresolved = v_unr,
         processing_orders = v_po, processing_definite = v_pdef, processing_estimated = v_pest, fee_status_counts = v_counts,
         monthly_fixed = v_fixed, minimum_topup = v_topup, minimum_status = v_mstatus, projected_monthly = v_projected,
         finished_at = now(), last_progress_at = now()
   where id = p_run;
  return jsonb_build_object('modeledOrders', v_mo, 'modeledShipments', v_ms, 'modeledPackages', v_mp, 'okShipments', v_ok, 'unavailableShipments', v_un, 'expected', v_exp::text,
                            'processingOrders', v_po, 'processingDefinite', v_pdef::text, 'processingEstimated', v_pest::text, 'monthlyFixed', v_fixed::text, 'minimumTopUp', v_topup::text, 'minimumStatus', v_mstatus,
                            'projectedMonthly', v_projected::text);
end $$;

-- advance_simulation_run (M4, same eight arguments): the in-flight state a window stores carries no load-issue text (the text stays in
-- simulation_run_contexts.load_issues, which only staff can read). The only change from the M4 definition is the stored partial_summary.
create or replace function public.advance_simulation_run(p_run uuid, p_from_row bigint, p_to_row bigint, p_results jsonb, p_partial jsonb, p_contexts jsonb, p_order_results jsonb, p_fee_contexts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype;
  v_ds uuid; v_has_lines boolean; v_n integer; v_orders integer;
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) or not app.project_visible(v_r.project_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then
    return jsonb_build_object('applied', false, 'status', v_r.status, 'nextRow', v_r.next_row_no, 'processed', v_r.processed_shipments, 'total', v_r.total_shipments);
  end if;
  if p_from_row < v_r.next_row_no then
    return jsonb_build_object('applied', false, 'status', v_r.status, 'nextRow', v_r.next_row_no, 'processed', v_r.processed_shipments, 'total', v_r.total_shipments);
  end if;
  if p_from_row <> v_r.next_row_no or p_to_row < p_from_row or p_to_row > v_r.total_shipments then
    raise exception 'window %–% does not start at the cursor %', p_from_row, p_to_row, v_r.next_row_no using errcode = 'PC003';
  end if;
  if (p_partial ->> 'version')::integer is distinct from 2 then
    raise exception 'this run was started by an older release of the modeling engine; start it again' using errcode = 'PC002';
  end if;
  select p.dataset_id, d.line_count > 0 into v_ds, v_has_lines from public.simulation_projects p join public.order_datasets d on d.id = p.dataset_id where p.id = v_r.project_id;
  if exists (select 1 from jsonb_to_recordset(p_results) as x(shipment_id uuid, order_id uuid, row_no bigint)
             left join public.shipments s on s.id = x.shipment_id and s.order_id = x.order_id and s.row_no = x.row_no and s.dataset_id = v_ds
             where x.row_no between p_from_row and p_to_row and s.id is null) then
    raise exception 'a result does not belong to this run' using errcode = 'PC003';
  end if;
  if (p_partial #>> '{shipments,seen}')::bigint is distinct from p_to_row then
    raise exception 'partial summary does not cover the window (seen %, window ends at %)', p_partial #>> '{shipments,seen}', p_to_row using errcode = 'PC003';
  end if;

  insert into public.simulation_results (run_id, tenant_id, brand_id, shipment_id, order_id, row_no, status, unavailable_reason, rate_card_version_id, ship_date, zone, service_id,
                                         billable_lb, definite, estimated, expected, conditional_exposure, unresolved, lines, warning_codes)
  select p_run, v_r.tenant_id, v_r.brand_id, x.shipment_id, x.order_id, x.row_no, x.status, x.unavailable_reason, x.rate_card_version_id, x.ship_date, x.zone, x.service_id,
         x.billable_lb, coalesce(x.definite, 0), coalesce(x.estimated, 0), coalesce(x.expected, 0), coalesce(x.conditional_exposure, 0), coalesce(x.unresolved, 0), coalesce(x.lines, '[]'::jsonb), coalesce(x.warning_codes, '{}'::text[])
  from jsonb_to_recordset(p_results) as x(shipment_id uuid, order_id uuid, row_no bigint, status text, unavailable_reason text, rate_card_version_id uuid, ship_date date, zone text, service_id uuid,
                                         billable_lb text[], definite numeric, estimated numeric, expected numeric, conditional_exposure numeric, unresolved numeric, lines jsonb, warning_codes text[])
  where x.row_no between p_from_row and p_to_row;
  get diagnostics v_n = row_count;
  if v_n <> p_to_row - p_from_row + 1 then raise exception 'window %–% needs % results, got %', p_from_row, p_to_row, p_to_row - p_from_row + 1, v_n using errcode = 'PC003'; end if;

  insert into public.simulation_run_contexts (run_id, tenant_id, brand_id, ship_date, rate_card_version_id, rule_version_ids, zip_list_ids, override_ids, load_issues, unavailable_reason)
  select p_run, v_r.tenant_id, v_r.brand_id, c.ship_date, c.rate_card_version_id, coalesce(c.rule_version_ids, '{}'::uuid[]), coalesce(c.zip_list_ids, '{}'::uuid[]), coalesce(c.override_ids, '{}'::uuid[]), coalesce(c.load_issues, '{}'::text[]), c.unavailable_reason
  from jsonb_to_recordset(coalesce(p_contexts, '[]'::jsonb)) as c(ship_date date, rate_card_version_id uuid, rule_version_ids uuid[], zip_list_ids uuid[], override_ids uuid[], load_issues text[], unavailable_reason text)
  on conflict (run_id, ship_date) do nothing;

  -- Fee contexts: every pinned version belongs to the run's schedule and was in effect on that date.
  if exists (select 1 from jsonb_to_recordset(coalesce(p_fee_contexts, '[]'::jsonb)) as c(fee_date date, fee_schedule_version_id uuid, unavailable_reason text)
             left join public.fee_schedule_versions v on v.id = c.fee_schedule_version_id
             where c.fee_schedule_version_id is not null
               and (v.id is null or v.schedule_id is distinct from v_r.fee_schedule_id or v.status not in ('active', 'archived')
                    or v.effective_date > c.fee_date or (v.expiration_date is not null and v.expiration_date < c.fee_date))) then
    raise exception 'a fee context names a version that was not in effect on its date' using errcode = 'PC003';
  end if;
  insert into public.simulation_run_fee_contexts (run_id, tenant_id, brand_id, fee_date, fee_schedule_version_id, unavailable_reason)
  select p_run, v_r.tenant_id, v_r.brand_id, c.fee_date, c.fee_schedule_version_id, c.unavailable_reason
  from jsonb_to_recordset(coalesce(p_fee_contexts, '[]'::jsonb)) as c(fee_date date, fee_schedule_version_id uuid, unavailable_reason text)
  on conflict (run_id, fee_date) do nothing;

  -- Order results: exactly one per order of the window, owning that order's first row, with quantities the file agrees with.
  select count(distinct s.order_id) into v_orders from public.shipments s where s.dataset_id = v_ds and s.row_no between p_from_row and p_to_row;
  if jsonb_typeof(coalesce(p_order_results, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_order_results) <> v_orders then
    raise exception 'window %–% covers % orders, got % order results', p_from_row, p_to_row, v_orders, jsonb_array_length(coalesce(p_order_results, '[]'::jsonb)) using errcode = 'PC003';
  end if;
  if (select count(distinct x.order_id) from jsonb_to_recordset(p_order_results) as x(order_id uuid)) <> v_orders then
    raise exception 'order results name the same order twice' using errcode = 'PC003';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_order_results) as x(order_id uuid, first_row_no bigint, order_month text, units integer, lines integer, distinct_skus integer, packages integer, shipments integer, assumed jsonb, fee_status text, fee_date date, fee_schedule_version_id uuid, processing_definite bigint, processing_estimated bigint, fee_lines jsonb)
    left join public.orders o on o.id = x.order_id and o.dataset_id = v_ds
    left join lateral (
      select min(s.row_no) as first_row, count(*) as n, min(s.ship_date) as first_ship,
             (select count(*) from public.packages p join public.shipments y on y.id = p.shipment_id where y.order_id = o.id) as npkg
      from public.shipments s where s.order_id = o.id
    ) s on true
    left join lateral (select * from app.order_line_counts(o.id)) l on true
    where o.id is null or s.first_row is distinct from x.first_row_no or s.first_row < p_from_row or s.first_row > p_to_row
       or x.shipments is distinct from s.n or x.packages is distinct from s.npkg
       or x.order_month is distinct from to_char(coalesce(o.order_date, s.first_ship), 'YYYY-MM')
       -- A quantity may be assumed only when the file does not carry it; otherwise it must echo the file.
       or (coalesce(x.assumed ->> 'units', 'false') <> 'true' and x.units is distinct from o.units)
       or (coalesce(x.assumed ->> 'units', 'false') = 'true' and o.units is not null)
       or (coalesce(x.assumed ->> 'lines', 'false') <> 'true' and x.lines is distinct from case when v_has_lines then l.lines end)
       or (coalesce(x.assumed ->> 'lines', 'false') = 'true' and v_has_lines and l.lines is not null)
       or (coalesce(x.assumed ->> 'skus', 'false') <> 'true' and x.distinct_skus is distinct from case when v_has_lines then l.skus end)
       or (coalesce(x.assumed ->> 'skus', 'false') = 'true' and v_has_lines and l.skus is not null)
       or x.fee_status not in ('ok', 'partial', 'no_content', 'no_schedule', 'not_effective', 'date_missing', 'skipped')
       -- The fee date is the run's as-of date, or the order's own date under the ship-date basis.
       or (x.fee_status not in ('skipped', 'date_missing') and x.fee_date is distinct from case when v_r.pricing_basis = 'fixed_date' then v_r.as_of_date else coalesce(o.order_date, s.first_ship) end)
       or (x.fee_status = 'date_missing' and (v_r.pricing_basis = 'fixed_date' or coalesce(o.order_date, s.first_ship) is not null))
       or (x.fee_status in ('ok', 'partial', 'no_content') and (x.fee_date is null or x.fee_schedule_version_id is null))
       or (x.fee_status not in ('ok', 'partial', 'no_content') and (x.fee_schedule_version_id is not null or x.processing_definite <> 0 or x.processing_estimated <> 0 or x.fee_lines <> '[]'::jsonb))
       or (x.fee_date is not null and not exists (select 1 from public.simulation_run_fee_contexts c where c.run_id = p_run and c.fee_date = x.fee_date and c.fee_schedule_version_id is not distinct from x.fee_schedule_version_id))
       or coalesce(x.processing_definite, 0) <> (select coalesce(sum((e ->> 1)::bigint), 0) from jsonb_array_elements(coalesce(x.fee_lines, '[]'::jsonb)) e where e ->> 2 = 'd')
       or coalesce(x.processing_estimated, 0) <> (select coalesce(sum((e ->> 1)::bigint), 0) from jsonb_array_elements(coalesce(x.fee_lines, '[]'::jsonb)) e where e ->> 2 = 'e')) then
    raise exception 'an order result does not agree with the orders file or its fee context' using errcode = 'PC003';
  end if;

  insert into public.simulation_order_results (run_id, tenant_id, brand_id, order_id, first_row_no, order_month, fee_date, fee_schedule_version_id, units, lines, distinct_skus, packages, shipments, assumed,
                                               fee_status, processing_definite, processing_estimated, fee_lines, unresolved, warning_codes)
  select p_run, v_r.tenant_id, v_r.brand_id, x.order_id, x.first_row_no, x.order_month, x.fee_date, x.fee_schedule_version_id, x.units, x.lines, x.distinct_skus, x.packages, x.shipments, coalesce(x.assumed, '{}'::jsonb),
         x.fee_status, coalesce(x.processing_definite, 0), coalesce(x.processing_estimated, 0), coalesce(x.fee_lines, '[]'::jsonb), coalesce(x.unresolved, '[]'::jsonb), coalesce(x.warning_codes, '{}'::text[])
  from jsonb_to_recordset(p_order_results) as x(order_id uuid, first_row_no bigint, order_month text, fee_date date, fee_schedule_version_id uuid, units integer, lines integer, distinct_skus integer, packages integer, shipments integer, assumed jsonb,
                                                fee_status text, processing_definite bigint, processing_estimated bigint, fee_lines jsonb, unresolved jsonb, warning_codes text[]);

  update public.simulation_runs
     set next_row_no = p_to_row + 1, processed_shipments = processed_shipments + v_n, partial_summary = app.summary_without_load_issues(p_partial), last_progress_at = now()
   where id = p_run;
  return jsonb_build_object('applied', true, 'status', 'running', 'nextRow', p_to_row + 1, 'processed', v_r.processed_shipments + v_n, 'total', v_r.total_shipments);
end $$;

-- cancel_simulation_run (M3): as above, for the in-flight state a cancelled run keeps.
create or replace function public.cancel_simulation_run(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r public.simulation_runs%rowtype;
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) or not app.project_visible(v_r.project_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then return; end if;
  -- Whatever an earlier window stored (a run that was in flight when the migration ran) loses its load-issue text now.
  update public.simulation_runs set status = 'cancelled', partial_summary = app.summary_without_load_issues(partial_summary), finished_at = now() where id = p_run;
end $$;

-- save_forecast_run (M4): the summary and the pins stored for the customer carry loadIssueCount, not the strings (the strings
-- still go to simulation_run_contexts.load_issues, which only staff can read).
create or replace function public.save_forecast_run(p_brand uuid, p_rate_card uuid, p_name text, p_assumptions jsonb, p_summary jsonb, p_pins jsonb, p_engine_version text, p_fee_engine_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_project uuid; v_run uuid; v_as_of date; v_schedule uuid; v_version uuid; v_orders numeric; v_parts numeric; v_allin numeric; v_monthly_e4 bigint;
begin
  select tenant_id into v_tenant from public.brands where id = p_brand;
  if v_tenant is null or not app.can_model_brand(v_tenant, p_brand) then raise exception 'customer not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.brand_rate_card_assignments a join public.rate_cards c on c.id = a.rate_card_id and c.status = 'active'
                 where a.brand_id = p_brand and a.rate_card_id = p_rate_card and a.unassigned_at is null) then
    raise exception 'rate card is not assigned to this customer' using errcode = 'PC001';
  end if;
  if p_assumptions is null or jsonb_typeof(p_assumptions) <> 'object' or pg_column_size(p_assumptions) > 32768 then raise exception 'invalid assumptions' using errcode = 'PC001'; end if;
  if p_summary is null or jsonb_typeof(p_summary) <> 'object' or pg_column_size(p_summary) > 262144 then raise exception 'summary too large' using errcode = 'PC001'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 160 then raise exception 'name must be 1–160 characters' using errcode = 'PC001'; end if;
  v_as_of := (p_assumptions ->> 'asOfDate')::date;
  if v_as_of is null then raise exception 'an as-of date is required' using errcode = 'PC001'; end if;
  if not app.fee_decimal_ok(p_assumptions ->> 'monthlyOrders', 2) or (p_assumptions ->> 'monthlyOrders')::numeric not between 1 and 5000000 then
    raise exception 'monthly orders must be between 1 and 5,000,000' using errcode = 'PC001';
  end if;
  v_orders := (p_assumptions ->> 'monthlyOrders')::numeric;
  -- Identities the engine must satisfy: weights sum to the volume, nothing is definite, all-in is the sum of its parts.
  if p_summary ->> 'basis' is distinct from 'assumptions' or (p_summary ->> 'monthlyOrders')::numeric is distinct from v_orders
     or (p_summary ->> 'weightSum')::numeric is distinct from v_orders
     or coalesce((p_summary #>> '{shipping,definite}')::numeric, 0) <> 0 or coalesce((p_summary #>> '{processing,definite}')::numeric, 0) <> 0 then
    raise exception 'forecast summary does not satisfy its identities' using errcode = 'PC003';
  end if;
  if p_summary #>> '{allIn,perOrder}' is not null then
    v_parts := coalesce((p_summary #>> '{shipping,perOrder}')::numeric, 0) + coalesce((p_summary #>> '{processing,perOrder}')::numeric, 0) + coalesce((p_summary #>> '{allocated,perOrder}')::numeric, 0);
    v_allin := (p_summary #>> '{allIn,perOrder}')::numeric;
    if abs(v_allin - v_parts) > 0.01 then raise exception 'all-in per order is not the sum of its parts' using errcode = 'PC003'; end if;
  end if;
  v_schedule := app.brand_fee_schedule(p_brand);
  if v_schedule is not null then v_version := app.fee_version_on(v_schedule, v_as_of); end if;
  if p_assumptions -> 'fulfillment' is not null and jsonb_typeof(p_assumptions -> 'fulfillment') <> 'null' then
    if v_version is null and (p_assumptions #> '{fulfillment,drivers}' <> '{}'::jsonb or p_assumptions #> '{fulfillment,orderShares}' <> '{}'::jsonb) then
      raise exception 'no fee schedule is in effect for this customer on that date' using errcode = 'PC001';
    end if;
    perform app.validate_fulfillment(p_assumptions -> 'fulfillment', v_version);
  end if;
  if (p_pins ->> 'feeScheduleVersionId')::uuid is distinct from v_version then raise exception 'the forecast was priced with a fee schedule version that is not in effect on its date' using errcode = 'PC003'; end if;
  -- The monthly charges of a forecast are recomputed here from the answers and must agree with the summary.
  if v_version is not null and p_assumptions -> 'fulfillment' is not null and jsonb_typeof(p_assumptions -> 'fulfillment') <> 'null' and coalesce(p_assumptions #>> '{fulfillment,skip}', 'false') <> 'true' then
    select coalesce(sum(round(l.amount * 10000)), 0)::bigint into v_monthly_e4 from app.fee_monthly_lines(v_version, p_assumptions -> 'fulfillment', v_orders) l where l.status = 'priced';
    if (p_summary #>> '{monthly,totalE4}')::bigint is distinct from v_monthly_e4 then raise exception 'forecast monthly charges do not reconcile (sql %)', v_monthly_e4 using errcode = 'PC003'; end if;
    -- "none" means the version has no account minimum; anything else means it has one (the amounts are application-computed).
    if (coalesce(p_summary ->> 'minimumStatus', 'none') = 'none') <> not exists (select 1 from public.fee_rules r where r.version_id = v_version and r.basis = 'minimum') then
      raise exception 'forecast minimum status does not match the fee schedule' using errcode = 'PC003';
    end if;
  end if;

  insert into public.simulation_projects (tenant_id, brand_id, kind, name, rate_card_id) values (v_tenant, p_brand, 'forecast', btrim(p_name), p_rate_card) returning id into v_project;
  insert into public.simulation_runs (project_id, tenant_id, brand_id, kind, status, pricing_basis, as_of_date, assumptions, total_shipments, processed_shipments, next_row_no, summary, reference_data, engine_version, fee_engine_version,
                                      fee_schedule_id, monthly_fee_schedule_version_id, forecast_months, volume_basis, monthly_orders,
                                      processing_orders, processing_definite, processing_estimated, monthly_fixed, minimum_topup, minimum_status, finished_at)
  values (v_project, v_tenant, p_brand, 'forecast', 'completed', 'fixed_date', v_as_of, p_assumptions, 0, 0, 1, app.summary_without_load_issues(p_summary), app.summary_without_load_issues(p_pins), p_engine_version, p_fee_engine_version,
          v_schedule, v_version, 1, 'stated', v_orders,
          null, (p_summary #>> '{processing,definite}')::numeric, (p_summary #>> '{processing,estimated}')::numeric, (p_summary #>> '{monthly,total}')::numeric, (p_summary #>> '{minimum,topUp}')::numeric, coalesce(p_summary ->> 'minimumStatus', 'none'), now())
  returning id into v_run;
  insert into public.simulation_run_contexts (run_id, tenant_id, brand_id, ship_date, rate_card_version_id, rule_version_ids, zip_list_ids, override_ids, load_issues, unavailable_reason)
  values (v_run, v_tenant, p_brand, v_as_of, (p_pins ->> 'rateCardVersionId')::uuid,
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_pins -> 'ruleVersionIds', '[]'::jsonb)) x), '{}'::uuid[]),
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_pins -> 'zipListIds', '[]'::jsonb)) x), '{}'::uuid[]),
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_pins -> 'overrideIds', '[]'::jsonb)) x), '{}'::uuid[]),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_pins -> 'loadIssues', '[]'::jsonb)) x), '{}'::text[]), null);
  insert into public.simulation_run_fee_contexts (run_id, tenant_id, brand_id, fee_date, fee_schedule_version_id, unavailable_reason)
  values (v_run, v_tenant, p_brand, v_as_of, v_version, case when v_version is null then case when v_schedule is null then 'no_schedule' else 'not_effective' end end);
  return v_project;
end $$;

-- pricing_rules_for_card (M3/M4): the D8 filter, a constant label for customer exceptions (their notes moved to a staff-only table),
-- and an optional staff flag that returns the unfiltered context. A new trailing parameter with a default keeps every existing caller
-- working; the old four-argument function is dropped so there is still exactly one overload.
drop function public.pricing_rules_for_card(uuid, date, uuid, uuid[]);
create function public.pricing_rules_for_card(p_rate_card uuid, p_ship_date date, p_brand uuid default null, p_known_lists uuid[] default null, p_adjustment_view boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_staff boolean;
  v_brand uuid := p_brand;
  v_brand_view boolean;
  v_adjustment_view boolean := false;
  v_rules jsonb;
  v_lists jsonb;
  v_overrides jsonb := '[]'::jsonb;
begin
  select tenant_id into v_tenant from public.rate_cards where id = p_rate_card;
  if v_tenant is null then raise exception 'rate card not found' using errcode = 'P0003'; end if;
  v_staff := app.has_tenant_permission(v_tenant, 'ratecard.view');
  if not v_staff then
    select a.brand_id into v_brand
      from public.brand_rate_card_assignments a
      join public.brands b on b.id = a.brand_id and b.status = 'active'
      join public.tenants t on t.id = a.tenant_id and t.status = 'active'
      join public.memberships m on m.brand_id = a.brand_id and m.user_id = (select auth.uid()) and m.status = 'active'
     where a.rate_card_id = p_rate_card and a.unassigned_at is null and (p_brand is null or a.brand_id = p_brand)
     limit 1;
    if v_brand is null then raise exception 'rate card not found' using errcode = 'P0003'; end if;
  elsif v_brand is not null and not exists (select 1 from public.brands b where b.id = v_brand and b.tenant_id = v_tenant) then
    raise exception 'brand not found' using errcode = 'P0003';
  end if;
  -- Anything priced for a brand is brand-visible later (saved scenarios, runs): internal notes never enter it.
  v_brand_view := (not v_staff) or v_brand is not null;
  -- Staff who may see adjustment data can ask for the unfiltered context (to price an absorbed fee); everyone else never gets it.
  v_adjustment_view := coalesce(p_adjustment_view, false) and v_staff and app.can_view_adjustments(v_tenant);

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', r.rule_key, 'ruleId', r.id, 'versionId', v.id, 'version', v.version_number, 'scope', r.scope,
      'brandId', r.brand_id, 'carrierCode', r.carrier_code, 'category', r.category, 'name', r.name,
      'chargeClass', v.charge_class, 'method', v.method, 'amount', v.amount::text, 'percent', v.percent::text,
      'perUnit', case when v.method = 'per_unit' then jsonb_build_object('basis', v.per_unit_basis, 'unitSize', v.per_unit_size::text,
                       'freeAllowance', coalesce(v.per_unit_free_allowance, 0)::text, 'minimumCharge', v.per_unit_minimum_charge::text) else null end,
      'billableWeightFloorLb', v.billable_weight_floor_lb::text,
      'base', v.calculation_base, 'conditions', v.conditions,
      'appliesToServiceIds', to_jsonb(v.applies_to_service_ids),
      'exclusivityGroup', v.exclusivity_group, 'exclusivityPriority', v.exclusivity_priority,
      'excludesRuleKeys', to_jsonb(v.excludes_rule_keys), 'perPackage', v.per_package,
      'effectiveDate', v.effective_date::text, 'expirationDate', v.expiration_date::text,
      'sourceReference', case when not v_brand_view or r.scope = 'platform' then v.source_reference else 'Your 3PL''s approved pricing configuration' end,
      'sourceUrl', case when not v_brand_view or r.scope = 'platform' then v.source_url else null end,
      'verificationStatus', v.verification_status
    ) order by r.rule_key, v.version_number), '[]'::jsonb)
  into v_rules
  from public.surcharge_rule_versions v
  join public.surcharge_rules r on r.id = v.rule_id
  where v.status in ('published', 'retired')
    and v.effective_date <= p_ship_date and (v.expiration_date is null or v.expiration_date >= p_ship_date)
    and r.archived_at is null
    and (r.tenant_id is null or r.tenant_id = v_tenant)
    and (r.brand_id is null or (v_brand is not null and r.brand_id = v_brand))
    -- D8: a reweigh, remeasure or correction fee rule leaves a customer's pricing context only when the decision for that
    -- customer says the fee is absorbed. Passed through, decided case by case and not yet decided keep the rule in the customer's schedule.
    and (v_adjustment_view or v_brand is null or r.category not in ('reweight', 'remeasure', 'shipping_charge_correction')
         or app.adjustment_handling(v_tenant, v_brand, case r.category when 'reweight' then 'reweight' when 'remeasure' then 'remeasure' else 'correction' end, 'separate_fee', app.utc_today()) <> 'absorbed')
    and r.carrier_code in (select s.carrier_code from public.rate_card_service_terms t
                            join public.rate_card_versions rv on rv.id = t.version_id and rv.rate_card_id = p_rate_card
                            join public.shipping_services s on s.id = t.service_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'key', l.key, 'version', l.version,
      'sourceReference', case when not v_brand_view or l.tenant_id is null then l.source_reference else 'Your 3PL''s approved pricing configuration' end,
      'effectiveDate', l.effective_date::text, 'expirationDate', l.expiration_date::text,
      'entries', case when p_known_lists is not null and l.id = any (p_known_lists) then null
                      else (select coalesce(jsonb_agg(e.entry order by e.entry), '[]'::jsonb) from public.zip_list_entries e where e.list_id = l.id) end
    )), '[]'::jsonb)
  into v_lists
  from public.zip_lists l
  where l.status in ('published', 'retired')
    and l.effective_date <= p_ship_date and (l.expiration_date is null or l.expiration_date >= p_ship_date)
    and (l.tenant_id is null or l.tenant_id = v_tenant)
    and l.key in (select distinct k #>> '{}'
                  from jsonb_array_elements(v_rules) rule,
                       jsonb_path_query(rule -> 'conditions', 'strict $.**.listKey') k);

  if v_brand is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'ruleKey', r.rule_key, 'mode', o.mode, 'amount', o.amount::text, 'percent', o.percent::text,
        'effectiveDate', o.effective_date::text, 'expirationDate', o.expiration_date::text,
        'reference', 'Your 3PL''s approved pricing configuration'
      ) order by r.rule_key, o.effective_date), '[]'::jsonb)
    into v_overrides
    from public.customer_surcharge_overrides o
    join public.surcharge_rules r on r.id = o.rule_id
    where o.brand_id = v_brand and o.tenant_id = v_tenant and o.ended_at is null
      and o.effective_date <= p_ship_date and (o.expiration_date is null or o.expiration_date >= p_ship_date);
  end if;

  return jsonb_build_object('rules', v_rules, 'zipLists', v_lists, 'overrides', v_overrides, 'brandId', v_brand);
end $$;

-- ---------------------------------------------------------------------------
-- SECTION 12b: legacy fee rules, realtime
-- ---------------------------------------------------------------------------
-- The published versions of reweigh, remeasure and correction fee rules that are not conditional charges: they predate the rule that
-- makes these fees conditional, so they still count in calculator, run and forecast totals. The Overview checklist lists them so the 3PL
-- can retire each and publish it again as a conditional charge. [{"ruleName": text, "versionNumber": integer}], oldest rule name first;
-- empty when there are none. Staff of the account only (adjustment.view or adjustment.manage).
create function public.adjustment_legacy_fee_rules(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_tenant is null or not app.can_view_adjustments(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('ruleName', x.name, 'versionNumber', x.version_number) order by x.name, x.version_number)
                   from (select r.name, v.version_number
                           from public.surcharge_rule_versions v join public.surcharge_rules r on r.id = v.rule_id
                          where r.tenant_id = p_tenant and r.archived_at is null and r.category in ('reweight', 'remeasure', 'shipping_charge_correction')
                            and v.status = 'published' and v.charge_class <> 'conditional'
                            and (v.expiration_date is null or v.expiration_date >= app.utc_today())) x), '[]'::jsonb);
end $$;

-- The supabase_realtime publication, where the platform has one, must hold no table of the public schema: realtime would otherwise
-- stream row changes (policies still apply, but staff-only data has no business in a stream). Run once by this migration; a test
-- creates a publication inside a rolled-back transaction and calls it. A publication defined FOR ALL TABLES cannot be emptied table by
-- table: that case only warns (change it to an explicit list in the dashboard).
create function app.sweep_realtime_publication() returns integer
language plpgsql security definer set search_path = '' as $$
declare t record; n integer := 0;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then return 0; end if;
  if (select p.puballtables from pg_catalog.pg_publication p where p.pubname = 'supabase_realtime') then
    raise warning 'the supabase_realtime publication is FOR ALL TABLES; change it to an explicit list that holds no table of the public schema';
    return -1;
  end if;
  for t in select pt.schemaname, pt.tablename from pg_catalog.pg_publication_tables pt where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' loop
    execute format('alter publication supabase_realtime drop table %I.%I', t.schemaname, t.tablename);
    n := n + 1;
  end loop;
  return n;
end $$;
do $$ begin perform app.sweep_realtime_publication(); end $$;

-- ---------------------------------------------------------------------------
-- SECTION 13: privileges
-- ---------------------------------------------------------------------------
revoke all on function public.set_adjustment_policy(uuid, uuid, text, text, text, date, text), public.end_adjustment_policy(uuid, date),
  public.create_adjustment_import(uuid, text, jsonb), public.set_adjustment_import_mapping(uuid, jsonb, jsonb, text, boolean),
  public.append_adjustment_records(uuid, integer, jsonb), public.finalize_adjustment_import(uuid), public.discard_adjustment_import(uuid),
  public.withdraw_adjustment_import(uuid), public.reset_adjustment_import(uuid), public.adjustment_records_json(uuid, integer, integer),
  public.save_adjustment_baseline(uuid, uuid, text, uuid, date, date, integer, integer, text, uuid), public.delete_adjustment_baseline(uuid),
  public.save_adjustment_scenario(uuid, uuid, text, text, jsonb, jsonb, jsonb, text), public.save_risk_estimate(uuid, uuid, text, jsonb, jsonb, text),
  public.archive_adjustment_scenario(uuid), public.archive_risk_estimate(uuid),
  public.preview_customer_example(uuid, uuid), public.publish_customer_example(uuid, uuid, text, text, date, text), public.retire_customer_example(uuid),
  public.adjustment_example_state(uuid), public.adjustment_example_states(uuid), public.brand_adjustment_examples(uuid),
  public.pricing_rules_for_card(uuid, date, uuid, uuid[], boolean), public.discard_unattached_adjustment_file(uuid), public.adjustment_legacy_fee_rules(uuid)
  from public, anon;
grant execute on function public.set_adjustment_policy(uuid, uuid, text, text, text, date, text), public.end_adjustment_policy(uuid, date),
  public.create_adjustment_import(uuid, text, jsonb), public.set_adjustment_import_mapping(uuid, jsonb, jsonb, text, boolean),
  public.append_adjustment_records(uuid, integer, jsonb), public.finalize_adjustment_import(uuid), public.discard_adjustment_import(uuid),
  public.withdraw_adjustment_import(uuid), public.reset_adjustment_import(uuid), public.adjustment_records_json(uuid, integer, integer),
  public.save_adjustment_baseline(uuid, uuid, text, uuid, date, date, integer, integer, text, uuid), public.delete_adjustment_baseline(uuid),
  public.save_adjustment_scenario(uuid, uuid, text, text, jsonb, jsonb, jsonb, text), public.save_risk_estimate(uuid, uuid, text, jsonb, jsonb, text),
  public.archive_adjustment_scenario(uuid), public.archive_risk_estimate(uuid),
  public.preview_customer_example(uuid, uuid), public.publish_customer_example(uuid, uuid, text, text, date, text), public.retire_customer_example(uuid),
  public.adjustment_example_state(uuid), public.adjustment_example_states(uuid), public.brand_adjustment_examples(uuid),
  public.pricing_rules_for_card(uuid, date, uuid, uuid[], boolean), public.discard_unattached_adjustment_file(uuid), public.adjustment_legacy_fee_rules(uuid)
  to authenticated;
-- finish_simulation_run, save_forecast_run and fail_simulation_run keep the grants they already had (same signatures).

-- Internal helpers: only the policy helpers above are callable by signed-in users (RLS and the helpers' callers need them).
-- Everything else is reached only from SECURITY DEFINER functions, which run as their owner.
revoke all on all functions in schema app from public, anon;
revoke execute on function app.adjustment_policy_at(uuid, uuid, text, text, date), app.adjustment_handling(uuid, uuid, text, text, date),
  app.adjustment_lock(uuid), app.adjustment_rows_problem(uuid, uuid, jsonb, integer), app.build_customer_example(uuid, uuid, date),
  app.example_state(public.published_adjustment_examples), app.scenario_result_problem(jsonb), app.example_packages(jsonb),
  app.purge_tenant_adjustment_data(uuid), app.purge_brand_adjustment_data(uuid), app.guard_adjustment_write(), app.audit_adjustments(),
  app.guard_term_sources(), app.guard_override_notes(), app.guard_adjustment_fee_class(), app.guard_adjustment_fee_class_publish(),
  app.guard_adjustment_file_insert(), app.adjustment_scan_file(bytea, text, text), app.pricing_context_keys(uuid, uuid, uuid, date),
  app.context_causes(uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], jsonb, date), app.sweep_realtime_publication()
  from authenticated;
grant execute on function app.customer_json_ok(jsonb, jsonb, integer), app.shape_published_payload(), app.shape_brand_example(), app.plain_text_ok(text, integer),
  app.adjustment_header_forbidden(text), app.adjustment_header_words_forbidden(text), app.adjustment_template_headers(), app.adjustment_header_fold(text), app.adjustment_header_norm(text), app.canon_package_ref(text), app.utc_today(),
  app.try_date(text), app.try_uuid(text), app.try_dec(text, integer, integer), app.add_problem(jsonb, text, text), app.clean_import_validation(jsonb),
  app.summary_without_load_issues(jsonb) to service_role;
grant execute on function app.adjustment_policy_at(uuid, uuid, text, text, date), app.adjustment_handling(uuid, uuid, text, text, date), app.adjustment_lock(uuid),
  app.adjustment_rows_problem(uuid, uuid, jsonb, integer), app.build_customer_example(uuid, uuid, date), app.example_state(public.published_adjustment_examples),
  app.scenario_result_problem(jsonb), app.example_packages(jsonb), app.adjustment_scan_file(bytea, text, text), app.pricing_context_keys(uuid, uuid, uuid, date),
  app.context_causes(uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], jsonb, date) to service_role;
grant execute on function app.purge_tenant_adjustment_data(uuid), app.purge_brand_adjustment_data(uuid), app.sweep_realtime_publication() to service_role;
