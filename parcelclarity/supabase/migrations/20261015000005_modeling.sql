-- ===========================================================================
-- Milestone 3: customer shipping modeling
--   order datasets (uploaded order files → orders / lines / shipments / packages),
--   product weights (sku_profiles) for files that carry none, simulation projects
--   ("scenarios"), runs with durable batch progress, pinned pricing contexts and
--   per-shipment results, plus the tenant's default origin ZIP.
-- Every brand-readable row holds identifiers and amounts only: never a 3PL's
-- internal notes. Writes to orders/shipments/packages/results happen only
-- through SECURITY DEFINER functions that authorise once and run as one
-- transaction; the authenticated role has no direct write grant on them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Settings that bulk modeling needs
-- ---------------------------------------------------------------------------
alter table public.tenants add column default_origin_zip text check (default_origin_zip ~ '^[0-9]{5}$');
grant update (default_origin_zip) on public.tenants to authenticated;

alter table public.brand_rate_card_assignments add column default_origin_zip text check (default_origin_zip ~ '^[0-9]{5}$');
grant insert (default_origin_zip), update (default_origin_zip) on public.brand_rate_card_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
-- Who may model a brand's costs: the brand's own members with simulation.run, or the 3PL's staff with
-- simulation.run in the tenant; brand and tenant must be active.
create function app.can_model_brand(p_tenant uuid, p_brand uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.brands b join public.tenants t on t.id = b.tenant_id
                 where b.id = p_brand and b.tenant_id = p_tenant and b.status = 'active' and t.status = 'active')
     and (app.has_tenant_permission(p_tenant, 'simulation.run') or app.has_brand_permission(p_brand, 'simulation.run'));
$$;

-- Set form for hoisted SELECT policies: every brand the caller may model (evaluated once per statement).
create function app.modelable_brand_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select b.id
  from public.brands b
  join public.tenants t on t.id = b.tenant_id and t.status = 'active'
  where b.status = 'active'
    and (app.has_tenant_permission(b.tenant_id, 'simulation.run') or app.has_brand_permission(b.id, 'simulation.run'));
$$;

-- Staff of the tenant (as opposed to a member of the brand). Staff-created datasets and scenarios stay
-- private to the 3PL until shared; brand-created ones are the brand's own.
create function app.is_tenant_staff(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'simulation.run');
$$;

revoke all on function app.can_model_brand(uuid, uuid), app.modelable_brand_ids(), app.is_tenant_staff(uuid) from public, anon;
grant execute on function app.can_model_brand(uuid, uuid), app.modelable_brand_ids(), app.is_tenant_staff(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Product weights: unit weight/dimensions per SKU, for order files without package weights
-- ---------------------------------------------------------------------------
create table public.sku_profiles (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete restrict,
  brand_id       uuid not null,
  sku            text not null check (char_length(btrim(sku)) between 1 and 120),
  sku_normalized text generated always as (lower(btrim(sku))) stored,
  unit_weight    numeric(12,6) not null check (unit_weight > 0),
  weight_unit    text not null check (weight_unit in ('lb', 'oz')),
  length_in      numeric(10,4) check (length_in is null or length_in > 0),
  width_in       numeric(10,4) check (width_in is null or width_in > 0),
  height_in      numeric(10,4) check (height_in is null or height_in > 0),
  packaging_type text check (packaging_type is null or char_length(packaging_type) between 1 and 60),
  source         text not null default 'customer_entered' check (source in ('customer_entered', 'file_upload')),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint sku_profiles_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint sku_profiles_dims_all_or_none check ((length_in is null) = (width_in is null) and (width_in is null) = (height_in is null)),
  unique (brand_id, sku_normalized)
);
create index sku_profiles_brand_idx on public.sku_profiles (brand_id);
create trigger sku_profiles_touch before update on public.sku_profiles for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Order datasets and their materialised rows
-- ---------------------------------------------------------------------------
create table public.order_datasets (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  brand_id          uuid not null,
  file_id           uuid not null,
  name              text not null check (char_length(btrim(name)) between 1 and 160),
  status            text not null default 'uploaded' check (status in ('uploaded', 'mapped', 'validated', 'materialising', 'ready', 'discarded')),
  detected          jsonb not null default '{}'::jsonb,
  mapping           jsonb,
  validation        jsonb,
  -- Staff-created datasets stay private to the 3PL until shared with the brand.
  shared_with_brand boolean not null default true,
  row_count         integer not null default 0 check (row_count >= 0),
  order_count       integer not null default 0 check (order_count >= 0),
  shipment_count    integer not null default 0 check (shipment_count >= 0),
  package_count     integer not null default 0 check (package_count >= 0),
  line_count        integer not null default 0 check (line_count >= 0),
  materialised_at   timestamptz,
  created_by        uuid not null default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint order_datasets_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint order_datasets_file_in_tenant foreign key (file_id, tenant_id) references public.uploaded_files (id, tenant_id) on delete restrict,
  unique (id, tenant_id, brand_id)
);
create index order_datasets_brand_idx on public.order_datasets (tenant_id, brand_id, created_at desc);
create trigger order_datasets_touch before update on public.order_datasets for each row execute function app.touch_updated_at();

create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  dataset_id        uuid not null,
  tenant_id         uuid not null,
  brand_id          uuid not null,
  external_order_id text not null check (char_length(external_order_id) between 1 and 120),
  order_date        date,
  destination_zip   text check (destination_zip is null or destination_zip ~ '^[0-9]{5}$'),
  origin_zip        text check (origin_zip is null or origin_zip ~ '^[0-9]{5}$'),
  residential       boolean,
  units             integer check (units is null or units >= 0),
  line_count        integer not null default 0 check (line_count >= 0),
  cancelled         boolean not null default false,
  -- Validation issue codes (e.g. destination_missing, order_inconsistent); modelability is decided per run.
  issues            text[] not null default '{}',
  constraint orders_dataset foreign key (dataset_id, tenant_id, brand_id) references public.order_datasets (id, tenant_id, brand_id) on delete cascade,
  unique (dataset_id, external_order_id),
  unique (id, dataset_id)
);

create table public.order_lines (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null,
  dataset_id uuid not null,
  line_no    integer not null check (line_no >= 1),
  sku        text check (sku is null or char_length(sku) between 1 and 120),
  units      integer not null check (units >= 0),
  constraint order_lines_order foreign key (order_id, dataset_id) references public.orders (id, dataset_id) on delete cascade,
  unique (order_id, line_no)
);

create table public.shipments (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null,
  dataset_id           uuid not null,
  -- Dense, dataset-wide position (1..N): the batch cursor of a run. Orders are contiguous, in ship-date order.
  row_no               bigint not null check (row_no >= 1),
  external_shipment_id text check (external_shipment_id is null or char_length(external_shipment_id) between 1 and 120),
  service_text         text check (service_text is null or char_length(service_text) <= 160),
  service_id           uuid references public.shipping_services (id) on delete set null,
  origin_zip           text check (origin_zip is null or origin_zip ~ '^[0-9]{5}$'),
  destination_zip      text check (destination_zip is null or destination_zip ~ '^[0-9]{5}$'),
  ship_date            date,
  residential          boolean,
  issues               text[] not null default '{}',
  constraint shipments_order foreign key (order_id, dataset_id) references public.orders (id, dataset_id) on delete cascade,
  unique (dataset_id, row_no),
  unique (id, dataset_id)
);
create index shipments_order_idx on public.shipments (order_id);

create table public.packages (
  id                 uuid primary key default gen_random_uuid(),
  shipment_id        uuid not null,
  dataset_id         uuid not null,
  seq                integer not null check (seq >= 1),
  weight             numeric(12,6) check (weight is null or weight > 0),
  weight_unit        text not null default 'lb' check (weight_unit in ('lb', 'oz')),
  length_in          numeric(10,4) check (length_in is null or length_in > 0),
  width_in           numeric(10,4) check (width_in is null or width_in > 0),
  height_in          numeric(10,4) check (height_in is null or height_in > 0),
  declared_value     numeric(12,2) check (declared_value is null or declared_value >= 0),
  packaging_type     text check (packaging_type is null or char_length(packaging_type) <= 60),
  -- Derived from product weights/dimensions rather than read from the file (priced as estimates).
  weight_derived     boolean not null default false,
  dimensions_derived boolean not null default false,
  constraint packages_shipment foreign key (shipment_id, dataset_id) references public.shipments (id, dataset_id) on delete cascade,
  constraint packages_dims_all_or_none check ((length_in is null) = (width_in is null) and (width_in is null) = (height_in is null)),
  unique (shipment_id, seq)
);

-- ---------------------------------------------------------------------------
-- Simulation projects (saved scenarios), runs, pinned contexts and results
-- ---------------------------------------------------------------------------
create table public.simulation_projects (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  brand_id          uuid not null,
  kind              text not null check (kind in ('single', 'bulk')),
  name              text not null check (char_length(btrim(name)) between 1 and 160),
  description       text check (description is null or char_length(description) <= 2000),
  dataset_id        uuid,
  rate_card_id      uuid not null,
  shared_with_brand boolean not null default true,
  archived_at       timestamptz,
  created_by        uuid not null default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint sp_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint sp_card_in_tenant foreign key (rate_card_id, tenant_id) references public.rate_cards (id, tenant_id) on delete restrict,
  constraint sp_dataset_of_brand foreign key (dataset_id, tenant_id, brand_id) references public.order_datasets (id, tenant_id, brand_id) on delete restrict,
  constraint sp_bulk_has_dataset check ((kind = 'bulk') = (dataset_id is not null)),
  unique (id, tenant_id, brand_id)
);
create index simulation_projects_brand_idx on public.simulation_projects (tenant_id, brand_id, created_at desc);
create trigger simulation_projects_touch before update on public.simulation_projects for each row execute function app.touch_updated_at();

create table public.simulation_runs (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null,
  tenant_id              uuid not null,
  brand_id               uuid not null,
  kind                   text not null check (kind in ('single', 'bulk')),
  status                 text not null default 'running' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  pricing_basis          text not null default 'fixed_date' check (pricing_basis in ('ship_date', 'fixed_date')),
  as_of_date             date,
  service_override_id    uuid references public.shipping_services (id) on delete restrict,
  unmapped_policy        text not null default 'exclude' check (unmapped_policy in ('exclude', 'use_override')),
  assumptions            jsonb not null default '{}'::jsonb,
  total_shipments        integer not null default 0 check (total_shipments >= 0),
  processed_shipments    integer not null default 0 check (processed_shipments >= 0),
  next_row_no            bigint not null default 1 check (next_row_no >= 1),
  partial_summary        jsonb,
  summary                jsonb,
  reference_data         jsonb,
  engine_version         text,
  -- Trusted totals computed in SQL from simulation_results when the run finishes.
  modeled_orders         integer,
  modeled_shipments      integer,
  modeled_packages       integer,
  ok_shipments           integer,
  unavailable_shipments  integer,
  total_definite         numeric(14,2),
  total_estimated        numeric(14,2),
  total_expected         numeric(14,2),
  total_conditional      numeric(14,2),
  total_unresolved       numeric(14,2),
  single_input           jsonb,
  single_result          jsonb,
  error                  text,
  started_at             timestamptz not null default now(),
  last_progress_at       timestamptz not null default now(),
  finished_at            timestamptz,
  created_by             uuid not null default auth.uid() references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  constraint sr_project foreign key (project_id, tenant_id, brand_id) references public.simulation_projects (id, tenant_id, brand_id) on delete cascade,
  constraint sr_fixed_date_has_as_of check (pricing_basis <> 'fixed_date' or kind = 'single' or as_of_date is not null),
  unique (id, tenant_id, brand_id)
);
create index simulation_runs_project_idx on public.simulation_runs (project_id, created_at desc);
-- One live run per project: a double submit or a second tab attaches to the existing run.
create unique index simulation_runs_one_live_per_project on public.simulation_runs (project_id) where status in ('queued', 'running');

-- What a run priced each ship date with (pinned for reproducibility; archived versions stay referenced).
create table public.simulation_run_contexts (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null,
  tenant_id            uuid not null,
  brand_id             uuid not null,
  ship_date            date not null,
  rate_card_version_id uuid references public.rate_card_versions (id) on delete restrict,
  rule_version_ids     uuid[] not null default '{}',
  zip_list_ids         uuid[] not null default '{}',
  override_ids         uuid[] not null default '{}',
  load_issues          text[] not null default '{}',
  unavailable_reason   text,
  constraint src_run foreign key (run_id, tenant_id, brand_id) references public.simulation_runs (id, tenant_id, brand_id) on delete cascade,
  unique (run_id, ship_date)
);

create table public.simulation_results (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null,
  tenant_id            uuid not null,
  brand_id             uuid not null,
  shipment_id          uuid not null references public.shipments (id) on delete cascade,
  order_id             uuid not null references public.orders (id) on delete cascade,
  row_no               bigint not null,
  status               text not null check (status in ('ok', 'unavailable')),
  unavailable_reason   text,
  rate_card_version_id uuid,
  ship_date            date,
  zone                 text,
  service_id           uuid references public.shipping_services (id) on delete set null,
  billable_lb          text[],
  definite             numeric(12,2) not null default 0,
  estimated            numeric(12,2) not null default 0,
  expected             numeric(12,2) not null default 0,
  conditional_exposure numeric(12,2) not null default 0,
  unresolved           numeric(12,2) not null default 0,
  -- Dictionary-encoded lines: [ruleIndex, amountCents, status, class, packageIndex] against run.reference_data.rules.
  lines                jsonb not null default '[]'::jsonb,
  warning_codes        text[] not null default '{}',
  constraint sres_run foreign key (run_id, tenant_id, brand_id) references public.simulation_runs (id, tenant_id, brand_id) on delete cascade,
  unique (run_id, shipment_id),
  unique (run_id, row_no)
);
create index simulation_results_order_idx on public.simulation_results (run_id, order_id);

-- ---------------------------------------------------------------------------
-- Guards and audit
-- ---------------------------------------------------------------------------
-- Staff-created datasets and scenarios default to private; brand members' own default to shared.
create function app.default_sharing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.shared_with_brand := not app.is_tenant_staff(new.tenant_id);
  return new;
end $$;
create trigger order_datasets_sharing before insert on public.order_datasets for each row execute function app.default_sharing();
create trigger simulation_projects_sharing before insert on public.simulation_projects for each row execute function app.default_sharing();

-- Direct updates may only move a dataset between its editing states; the RPCs own the rest.
create function app.guard_dataset_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('app.modeling_rpc', true) = 'on' then return new; end if;
  if old.status not in ('uploaded', 'mapped', 'validated') or new.status not in ('uploaded', 'mapped', 'validated') then
    raise exception 'dataset status % cannot be changed directly', old.status using errcode = '42501';
  end if;
  if new.row_count <> old.row_count or new.order_count <> old.order_count or new.shipment_count <> old.shipment_count
     or new.package_count <> old.package_count or new.line_count <> old.line_count or new.materialised_at is distinct from old.materialised_at then
    raise exception 'dataset counts are computed, not supplied' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger order_datasets_guard before update on public.order_datasets for each row execute function app.guard_dataset_update();

create function app.audit_modeling() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'order_datasets' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('ready', 'discarded') then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.dataset_' || new.status, 'order_dataset', new.id::text,
        jsonb_build_object('name', new.name, 'orders', new.order_count, 'shipments', new.shipment_count, 'packages', new.package_count));
    end if;
  elsif tg_table_name = 'simulation_projects' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.scenario_created', 'simulation_project', new.id::text,
        jsonb_build_object('kind', new.kind, 'name', new.name, 'rate_card_id', new.rate_card_id, 'dataset_id', new.dataset_id, 'shared_with_brand', new.shared_with_brand));
    elsif new.shared_with_brand is distinct from old.shared_with_brand then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.scenario_' || case when new.shared_with_brand then 'shared' else 'unshared' end, 'simulation_project', new.id::text, '{}'::jsonb);
    end if;
  elsif tg_table_name = 'simulation_runs' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.run_started', 'simulation_run', new.id::text,
        jsonb_build_object('project_id', new.project_id, 'kind', new.kind, 'pricing_basis', new.pricing_basis, 'as_of_date', new.as_of_date,
                           'service_override_id', new.service_override_id, 'total_shipments', new.total_shipments));
    elsif new.status is distinct from old.status and new.status in ('completed', 'failed', 'cancelled') then
      -- Ids and counts only: the summary itself can exceed the audit metadata cap.
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.run_' || new.status, 'simulation_run', new.id::text,
        jsonb_build_object('project_id', new.project_id, 'processed', new.processed_shipments, 'total', new.total_shipments,
                           'ok', new.ok_shipments, 'unavailable', new.unavailable_shipments, 'modeled_orders', new.modeled_orders,
                           'engine_version', new.engine_version, 'error', left(new.error, 200)));
    end if;
  end if;
  return null;
end $$;
create trigger order_datasets_audit after update on public.order_datasets for each row execute function app.audit_modeling();
create trigger simulation_projects_audit after insert or update on public.simulation_projects for each row execute function app.audit_modeling();
create trigger simulation_runs_audit after insert or update on public.simulation_runs for each row execute function app.audit_modeling();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.sku_profiles enable row level security;
alter table public.order_datasets enable row level security;
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.shipments enable row level security;
alter table public.packages enable row level security;
alter table public.simulation_projects enable row level security;
alter table public.simulation_runs enable row level security;
alter table public.simulation_run_contexts enable row level security;
alter table public.simulation_results enable row level security;

create policy sku_profiles_read on public.sku_profiles for select to authenticated using (brand_id in (select app.modelable_brand_ids()));
create policy sku_profiles_write on public.sku_profiles for all to authenticated
  using (app.can_model_brand(tenant_id, brand_id)) with check (app.can_model_brand(tenant_id, brand_id));

-- Brand members see their own brand's datasets once shared; staff see every dataset of the tenant.
create policy order_datasets_read on public.order_datasets for select to authenticated
  using (brand_id in (select app.modelable_brand_ids()) and (shared_with_brand or app.is_tenant_staff(tenant_id)));
create policy order_datasets_insert on public.order_datasets for insert to authenticated
  with check (app.can_model_brand(tenant_id, brand_id) and created_by = (select auth.uid()) and status = 'uploaded'
              and exists (select 1 from public.uploaded_files f where f.id = file_id and f.tenant_id = order_datasets.tenant_id and f.brand_id = order_datasets.brand_id and f.purpose = 'order_import'));
create policy order_datasets_update on public.order_datasets for update to authenticated
  using (app.can_model_brand(tenant_id, brand_id) and (shared_with_brand or app.is_tenant_staff(tenant_id)))
  with check (app.can_model_brand(tenant_id, brand_id));

-- Materialised rows are visible exactly when their dataset is (the parent policy runs once per statement).
create policy orders_read on public.orders for select to authenticated using (dataset_id in (select d.id from public.order_datasets d));
create policy order_lines_read on public.order_lines for select to authenticated using (dataset_id in (select d.id from public.order_datasets d));
create policy shipments_read on public.shipments for select to authenticated using (dataset_id in (select d.id from public.order_datasets d));
create policy packages_read on public.packages for select to authenticated using (dataset_id in (select d.id from public.order_datasets d));

create policy simulation_projects_read on public.simulation_projects for select to authenticated
  using (brand_id in (select app.modelable_brand_ids()) and (shared_with_brand or app.is_tenant_staff(tenant_id)));
-- A scenario can only be built on a rate card actively assigned to the brand (and on the brand's own dataset).
create policy simulation_projects_insert on public.simulation_projects for insert to authenticated
  with check (app.can_model_brand(tenant_id, brand_id) and created_by = (select auth.uid()) and archived_at is null
              and exists (select 1 from public.brand_rate_card_assignments a
                          where a.brand_id = simulation_projects.brand_id and a.rate_card_id = simulation_projects.rate_card_id and a.unassigned_at is null)
              and (dataset_id is null or exists (select 1 from public.order_datasets d where d.id = dataset_id and d.brand_id = simulation_projects.brand_id and d.status = 'ready')));
create policy simulation_projects_update on public.simulation_projects for update to authenticated
  using (app.can_model_brand(tenant_id, brand_id) and (shared_with_brand or app.is_tenant_staff(tenant_id)))
  with check (app.can_model_brand(tenant_id, brand_id));

create policy simulation_runs_read on public.simulation_runs for select to authenticated using (project_id in (select p.id from public.simulation_projects p));
create policy simulation_run_contexts_read on public.simulation_run_contexts for select to authenticated using (run_id in (select r.id from public.simulation_runs r));
create policy simulation_results_read on public.simulation_results for select to authenticated using (run_id in (select r.id from public.simulation_runs r));

-- Brands may now upload order files for themselves; pricing files stay manager-only.
drop policy files_read on public.uploaded_files;
drop policy files_insert on public.uploaded_files;
create policy files_read on public.uploaded_files for select to authenticated
  using ((purpose <> 'order_import' and app.can_manage_pricing(tenant_id))
         or (purpose = 'order_import' and brand_id is not null and app.can_model_brand(tenant_id, brand_id)));
create policy files_insert on public.uploaded_files for insert to authenticated
  with check (uploaded_by = (select auth.uid())
              and ((purpose = 'order_import' and brand_id is not null and app.can_model_brand(tenant_id, brand_id))
                   or (purpose in ('rate_card', 'zone_chart', 'zip_list') and brand_id is null and app.can_manage_pricing(tenant_id))));
grant insert (brand_id) on public.uploaded_files to authenticated;

-- ---------------------------------------------------------------------------
-- Grants (reads everywhere; writes only where a policy allows direct editing)
-- ---------------------------------------------------------------------------
grant select on public.sku_profiles, public.order_datasets, public.orders, public.order_lines, public.shipments, public.packages,
                public.simulation_projects, public.simulation_runs, public.simulation_run_contexts, public.simulation_results to authenticated;
grant insert (tenant_id, brand_id, sku, unit_weight, weight_unit, length_in, width_in, height_in, packaging_type, source), update (sku, unit_weight, weight_unit, length_in, width_in, height_in, packaging_type, source), delete on public.sku_profiles to authenticated;
grant insert (tenant_id, brand_id, file_id, name, detected), update (name, status, mapping, validation, detected, shared_with_brand) on public.order_datasets to authenticated;
grant insert (tenant_id, brand_id, kind, name, description, dataset_id, rate_card_id), update (name, description, archived_at, shared_with_brand) on public.simulation_projects to authenticated;

-- ---------------------------------------------------------------------------
-- Dataset lifecycle functions
-- ---------------------------------------------------------------------------
-- Inserts a chunk of materialised rows for a dataset in one transaction. Orders are identified by
-- external id within the chunk; shipments by (order, seq); packages by (order, shipment seq, seq).
-- A chunk must carry whole orders. The caller assigns row_no (dense, dataset-wide, orders contiguous).
create function public.materialise_order_rows(p_dataset uuid, p_orders jsonb, p_lines jsonb, p_shipments jsonb, p_packages jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ds public.order_datasets%rowtype;
  v_orders integer; v_lines integer; v_shipments integer; v_packages integer;
begin
  select * into v_ds from public.order_datasets where id = p_dataset for update;
  if not found or not app.can_model_brand(v_ds.tenant_id, v_ds.brand_id) then raise exception 'dataset not found' using errcode = 'P0002'; end if;
  if v_ds.status not in ('validated', 'materialising') then raise exception 'dataset is not ready to be materialised (status %)', v_ds.status using errcode = 'P0001'; end if;
  if jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) > 10000 then raise exception 'orders must be an array of at most 10000' using errcode = 'P0001'; end if;
  perform set_config('app.modeling_rpc', 'on', true);
  if v_ds.status = 'validated' then update public.order_datasets set status = 'materialising' where id = p_dataset; end if;

  create temp table _o (external_order_id text, id uuid) on commit drop;
  insert into public.orders (dataset_id, tenant_id, brand_id, external_order_id, order_date, destination_zip, origin_zip, residential, units, line_count, cancelled, issues)
  select p_dataset, v_ds.tenant_id, v_ds.brand_id, o.external_order_id, o.order_date, o.destination_zip, o.origin_zip, o.residential, o.units, coalesce(o.line_count, 0), coalesce(o.cancelled, false), coalesce(o.issues, '{}'::text[])
  from jsonb_to_recordset(p_orders) as o(external_order_id text, order_date date, destination_zip text, origin_zip text, residential boolean, units integer, line_count integer, cancelled boolean, issues text[]);
  get diagnostics v_orders = row_count;
  insert into _o select o.external_order_id, o.id from public.orders o
    where o.dataset_id = p_dataset and o.external_order_id in (select x.external_order_id from jsonb_to_recordset(p_orders) as x(external_order_id text));

  insert into public.order_lines (order_id, dataset_id, line_no, sku, units)
  select _o.id, p_dataset, l.line_no, l.sku, l.units
  from jsonb_to_recordset(p_lines) as l(external_order_id text, line_no integer, sku text, units integer)
  join _o on _o.external_order_id = l.external_order_id;
  get diagnostics v_lines = row_count;

  create temp table _s (external_order_id text, seq integer, id uuid) on commit drop;
  insert into public.shipments (order_id, dataset_id, row_no, external_shipment_id, service_text, service_id, origin_zip, destination_zip, ship_date, residential, issues)
  select _o.id, p_dataset, s.row_no, s.external_shipment_id, s.service_text, s.service_id, s.origin_zip, s.destination_zip, s.ship_date, s.residential, coalesce(s.issues, '{}'::text[])
  from jsonb_to_recordset(p_shipments) as s(external_order_id text, seq integer, row_no bigint, external_shipment_id text, service_text text, service_id uuid, origin_zip text, destination_zip text, ship_date date, residential boolean, issues text[])
  join _o on _o.external_order_id = s.external_order_id;
  get diagnostics v_shipments = row_count;
  insert into _s
  select s.external_order_id, s.seq, sh.id
  from jsonb_to_recordset(p_shipments) as s(external_order_id text, seq integer, row_no bigint)
  join public.shipments sh on sh.dataset_id = p_dataset and sh.row_no = s.row_no;

  insert into public.packages (shipment_id, dataset_id, seq, weight, weight_unit, length_in, width_in, height_in, declared_value, packaging_type, weight_derived, dimensions_derived)
  select _s.id, p_dataset, p.seq, p.weight, coalesce(p.weight_unit, 'lb'), p.length_in, p.width_in, p.height_in, p.declared_value, p.packaging_type, coalesce(p.weight_derived, false), coalesce(p.dimensions_derived, false)
  from jsonb_to_recordset(p_packages) as p(external_order_id text, shipment_seq integer, seq integer, weight numeric, weight_unit text, length_in numeric, width_in numeric, height_in numeric, declared_value numeric, packaging_type text, weight_derived boolean, dimensions_derived boolean)
  join _s on _s.external_order_id = p.external_order_id and _s.seq = p.shipment_seq;
  get diagnostics v_packages = row_count;

  return jsonb_build_object('orders', v_orders, 'lines', v_lines, 'shipments', v_shipments, 'packages', v_packages);
end $$;

-- Computes the dataset's counts from its rows and marks it ready.
create function public.finalize_order_dataset(p_dataset uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ds public.order_datasets%rowtype;
  v_orders integer; v_lines integer; v_shipments integer; v_packages integer;
begin
  select * into v_ds from public.order_datasets where id = p_dataset for update;
  if not found or not app.can_model_brand(v_ds.tenant_id, v_ds.brand_id) then raise exception 'dataset not found' using errcode = 'P0002'; end if;
  if v_ds.status <> 'materialising' then raise exception 'dataset is not being materialised (status %)', v_ds.status using errcode = 'P0001'; end if;
  select count(*) into v_orders from public.orders where dataset_id = p_dataset;
  select count(*) into v_lines from public.order_lines where dataset_id = p_dataset;
  select count(*) into v_shipments from public.shipments where dataset_id = p_dataset;
  select count(*) into v_packages from public.packages where dataset_id = p_dataset;
  if v_orders = 0 or v_shipments = 0 then raise exception 'dataset has no orders' using errcode = 'P0001'; end if;
  -- row_no must be dense 1..N so the batch cursor can walk it.
  if (select max(row_no) from public.shipments where dataset_id = p_dataset) <> v_shipments then raise exception 'shipment row numbers are not dense' using errcode = 'P0001'; end if;
  perform set_config('app.modeling_rpc', 'on', true);
  update public.order_datasets
     set status = 'ready', order_count = v_orders, line_count = v_lines, shipment_count = v_shipments, package_count = v_packages, materialised_at = now()
   where id = p_dataset;
  return jsonb_build_object('orders', v_orders, 'lines', v_lines, 'shipments', v_shipments, 'packages', v_packages);
end $$;

create function public.discard_order_dataset(p_dataset uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ds public.order_datasets%rowtype;
begin
  select * into v_ds from public.order_datasets where id = p_dataset for update;
  if not found or not app.can_model_brand(v_ds.tenant_id, v_ds.brand_id) then raise exception 'dataset not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.simulation_projects p where p.dataset_id = p_dataset and p.archived_at is null) then
    raise exception 'dataset is used by a scenario' using errcode = 'P0001';
  end if;
  perform set_config('app.modeling_rpc', 'on', true);
  update public.order_datasets set status = 'discarded' where id = p_dataset;
  delete from public.orders where dataset_id = p_dataset; -- cascades to lines, shipments, packages
end $$;

-- ---------------------------------------------------------------------------
-- Run lifecycle functions
-- ---------------------------------------------------------------------------
-- Starts (or attaches to) the live run of a project. Validates every setting server-side.
create function public.start_simulation_run(p_project uuid, p_pricing_basis text, p_as_of_date date, p_service_override uuid, p_unmapped_policy text, p_assumptions jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.simulation_projects%rowtype;
  v_ds public.order_datasets%rowtype;
  v_live uuid;
  v_run uuid;
  v_total integer;
begin
  select * into v_p from public.simulation_projects where id = p_project for update;
  if not found or not app.can_model_brand(v_p.tenant_id, v_p.brand_id) or (not v_p.shared_with_brand and not app.is_tenant_staff(v_p.tenant_id)) then
    raise exception 'scenario not found' using errcode = 'P0002';
  end if;
  if v_p.kind <> 'bulk' or v_p.archived_at is not null then raise exception 'scenario cannot be run' using errcode = 'P0001'; end if;
  select * into v_ds from public.order_datasets where id = v_p.dataset_id;
  if v_ds.status <> 'ready' or v_ds.brand_id <> v_p.brand_id then raise exception 'orders file is not ready' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.brand_rate_card_assignments a where a.brand_id = v_p.brand_id and a.rate_card_id = v_p.rate_card_id and a.unassigned_at is null) then
    raise exception 'rate card is not assigned to this customer' using errcode = 'P0001';
  end if;
  if p_pricing_basis not in ('ship_date', 'fixed_date') then raise exception 'invalid pricing basis' using errcode = 'P0001'; end if;
  if p_pricing_basis = 'fixed_date' and p_as_of_date is null then raise exception 'an as-of date is required' using errcode = 'P0001'; end if;
  if p_unmapped_policy not in ('exclude', 'use_override') then raise exception 'invalid unmapped policy' using errcode = 'P0001'; end if;
  if p_unmapped_policy = 'use_override' and p_service_override is null then raise exception 'choose a service for unmapped shipments' using errcode = 'P0001'; end if;
  if p_service_override is not null and not exists (
       select 1 from public.brand_rate_card_assignments a
       join public.rate_card_versions v on v.rate_card_id = a.rate_card_id and v.status = 'active'
       join public.rate_card_service_terms t on t.version_id = v.id and t.service_id = p_service_override
       where a.brand_id = v_p.brand_id and a.rate_card_id = v_p.rate_card_id and a.unassigned_at is null
         and (a.allowed_service_ids is null or p_service_override = any (a.allowed_service_ids))) then
    raise exception 'that service is not available on the customer''s rate card' using errcode = 'P0001';
  end if;

  select id into v_live from public.simulation_runs where project_id = p_project and status in ('queued', 'running') limit 1;
  if v_live is not null then return v_live; end if;

  select count(*) into v_total from public.shipments where dataset_id = v_p.dataset_id;
  insert into public.simulation_runs (project_id, tenant_id, brand_id, kind, status, pricing_basis, as_of_date, service_override_id, unmapped_policy, assumptions, total_shipments)
  values (p_project, v_p.tenant_id, v_p.brand_id, 'bulk', 'running', p_pricing_basis, p_as_of_date, p_service_override, p_unmapped_policy, coalesce(p_assumptions, '{}'::jsonb), v_total)
  returning id into v_run;
  return v_run;
end $$;

-- The next window of whole orders from the run's cursor, with packages nested (bypasses the Data API row cap).
create function public.simulation_batch_input(p_run uuid, p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype;
  v_ds uuid;
  v_to bigint;
  v_rows jsonb;
begin
  select * into v_r from public.simulation_runs where id = p_run;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then return jsonb_build_object('status', v_r.status, 'fromRow', v_r.next_row_no, 'toRow', v_r.next_row_no - 1, 'shipments', '[]'::jsonb); end if;
  select p.dataset_id into v_ds from public.simulation_projects p where p.id = v_r.project_id;
  -- Window end: the last shipment of the order that contains row (cursor + limit - 1), so orders are never split.
  select coalesce(max(s2.row_no), v_r.next_row_no - 1) into v_to
  from public.shipments s1
  join public.shipments s2 on s2.order_id = s1.order_id
  where s1.dataset_id = v_ds and s1.row_no = least(v_r.next_row_no + greatest(p_limit, 1) - 1, v_r.total_shipments);
  if v_to < v_r.next_row_no then v_to := least(v_r.next_row_no + greatest(p_limit, 1) - 1, v_r.total_shipments); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'shipmentId', s.id, 'orderId', o.id, 'rowNo', s.row_no, 'externalOrderId', o.external_order_id, 'externalShipmentId', s.external_shipment_id,
      'orderDate', o.order_date::text, 'shipDate', s.ship_date::text, 'cancelled', o.cancelled,
      'originZip', coalesce(s.origin_zip, o.origin_zip), 'destinationZip', coalesce(s.destination_zip, o.destination_zip),
      'residential', coalesce(s.residential, o.residential), 'serviceId', s.service_id, 'serviceText', s.service_text,
      'orderIssues', to_jsonb(o.issues), 'shipmentIssues', to_jsonb(s.issues), 'orderUnits', o.units,
      'packages', (select coalesce(jsonb_agg(jsonb_build_object(
                     'seq', p.seq, 'weight', p.weight::text, 'weightUnit', p.weight_unit, 'length', p.length_in::text, 'width', p.width_in::text, 'height', p.height_in::text,
                     'declaredValue', p.declared_value::text, 'packagingType', p.packaging_type, 'weightDerived', p.weight_derived, 'dimensionsDerived', p.dimensions_derived) order by p.seq), '[]'::jsonb)
                   from public.packages p where p.shipment_id = s.id)
    ) order by s.row_no), '[]'::jsonb)
  into v_rows
  from public.shipments s join public.orders o on o.id = s.order_id
  where s.dataset_id = v_ds and s.row_no between v_r.next_row_no and v_to;
  return jsonb_build_object('status', v_r.status, 'fromRow', v_r.next_row_no, 'toRow', v_to, 'total', v_r.total_shipments, 'shipments', v_rows);
end $$;

-- Commits one priced window. Idempotent: a window already behind the cursor is acknowledged, not re-applied.
create function public.advance_simulation_run(p_run uuid, p_from_row bigint, p_to_row bigint, p_results jsonb, p_partial jsonb, p_contexts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype;
  v_n integer;
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then
    return jsonb_build_object('applied', false, 'status', v_r.status, 'nextRow', v_r.next_row_no, 'processed', v_r.processed_shipments, 'total', v_r.total_shipments);
  end if;
  if p_from_row < v_r.next_row_no then
    return jsonb_build_object('applied', false, 'status', v_r.status, 'nextRow', v_r.next_row_no, 'processed', v_r.processed_shipments, 'total', v_r.total_shipments);
  end if;
  if p_from_row <> v_r.next_row_no or p_to_row < p_from_row or p_to_row > v_r.total_shipments then
    raise exception 'window %–% does not start at the cursor %', p_from_row, p_to_row, v_r.next_row_no using errcode = 'P0001';
  end if;

  insert into public.simulation_results (run_id, tenant_id, brand_id, shipment_id, order_id, row_no, status, unavailable_reason, rate_card_version_id, ship_date, zone, service_id,
                                         billable_lb, definite, estimated, expected, conditional_exposure, unresolved, lines, warning_codes)
  select p_run, v_r.tenant_id, v_r.brand_id, x.shipment_id, x.order_id, x.row_no, x.status, x.unavailable_reason, x.rate_card_version_id, x.ship_date, x.zone, x.service_id,
         x.billable_lb, coalesce(x.definite, 0), coalesce(x.estimated, 0), coalesce(x.expected, 0), coalesce(x.conditional_exposure, 0), coalesce(x.unresolved, 0), coalesce(x.lines, '[]'::jsonb), coalesce(x.warning_codes, '{}'::text[])
  from jsonb_to_recordset(p_results) as x(shipment_id uuid, order_id uuid, row_no bigint, status text, unavailable_reason text, rate_card_version_id uuid, ship_date date, zone text, service_id uuid,
                                         billable_lb text[], definite numeric, estimated numeric, expected numeric, conditional_exposure numeric, unresolved numeric, lines jsonb, warning_codes text[])
  where x.row_no between p_from_row and p_to_row;
  get diagnostics v_n = row_count;
  if v_n <> p_to_row - p_from_row + 1 then raise exception 'window %–% needs % results, got %', p_from_row, p_to_row, p_to_row - p_from_row + 1, v_n using errcode = 'P0001'; end if;

  insert into public.simulation_run_contexts (run_id, tenant_id, brand_id, ship_date, rate_card_version_id, rule_version_ids, zip_list_ids, override_ids, load_issues, unavailable_reason)
  select p_run, v_r.tenant_id, v_r.brand_id, c.ship_date, c.rate_card_version_id, coalesce(c.rule_version_ids, '{}'::uuid[]), coalesce(c.zip_list_ids, '{}'::uuid[]), coalesce(c.override_ids, '{}'::uuid[]), coalesce(c.load_issues, '{}'::text[]), c.unavailable_reason
  from jsonb_to_recordset(coalesce(p_contexts, '[]'::jsonb)) as c(ship_date date, rate_card_version_id uuid, rule_version_ids uuid[], zip_list_ids uuid[], override_ids uuid[], load_issues text[], unavailable_reason text)
  on conflict (run_id, ship_date) do nothing;

  update public.simulation_runs
     set next_row_no = p_to_row + 1, processed_shipments = processed_shipments + v_n, partial_summary = p_partial, last_progress_at = now()
   where id = p_run;
  return jsonb_build_object('applied', true, 'status', 'running', 'nextRow', p_to_row + 1, 'processed', v_r.processed_shipments + v_n, 'total', v_r.total_shipments);
end $$;

-- Completes a run: recomputes the headline figures from the stored results (trusted), checks that the
-- caller's summary agrees with them, and stores the summary and reference dictionary.
create function public.finish_simulation_run(p_run uuid, p_summary jsonb, p_reference_data jsonb, p_engine_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype;
  v_mo integer; v_ms integer; v_mp integer; v_ok integer; v_un integer;
  v_def numeric(14,2); v_est numeric(14,2); v_exp numeric(14,2); v_cond numeric(14,2); v_unr numeric(14,2);
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then raise exception 'run is %', v_r.status using errcode = 'P0001'; end if;
  if v_r.processed_shipments <> v_r.total_shipments then raise exception 'run has % of % shipments priced', v_r.processed_shipments, v_r.total_shipments using errcode = 'P0001'; end if;

  -- A modeled order is one whose every shipment priced ok and that was not cancelled.
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
    raise exception 'summary does not reconcile with stored results (orders % / shipments % / expected %)', v_mo, v_ms, v_exp using errcode = 'P0001';
  end if;

  update public.simulation_runs
     set status = 'completed', summary = p_summary, reference_data = p_reference_data, engine_version = p_engine_version,
         modeled_orders = v_mo, modeled_shipments = v_ms, modeled_packages = v_mp, ok_shipments = v_ok, unavailable_shipments = v_un,
         total_definite = v_def, total_estimated = v_est, total_expected = v_exp, total_conditional = v_cond, total_unresolved = v_unr,
         finished_at = now(), last_progress_at = now()
   where id = p_run;
  return jsonb_build_object('modeledOrders', v_mo, 'modeledShipments', v_ms, 'modeledPackages', v_mp, 'okShipments', v_ok, 'unavailableShipments', v_un, 'expected', v_exp::text);
end $$;

create function public.fail_simulation_run(p_run uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r public.simulation_runs%rowtype;
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then return; end if;
  update public.simulation_runs set status = 'failed', error = left(coalesce(p_error, 'unknown error'), 1000), finished_at = now() where id = p_run;
end $$;

create function public.cancel_simulation_run(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r public.simulation_runs%rowtype;
begin
  select * into v_r from public.simulation_runs where id = p_run for update;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then return; end if;
  update public.simulation_runs set status = 'cancelled', finished_at = now() where id = p_run;
end $$;

-- Saves a single-shipment calculation as a scenario (project + completed run) in one transaction.
create function public.save_single_simulation(p_brand uuid, p_rate_card uuid, p_name text, p_input jsonb, p_result jsonb, p_engine_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_project uuid;
begin
  select tenant_id into v_tenant from public.brands where id = p_brand;
  if v_tenant is null or not app.can_model_brand(v_tenant, p_brand) then raise exception 'customer not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.brand_rate_card_assignments a where a.brand_id = p_brand and a.rate_card_id = p_rate_card and a.unassigned_at is null) then
    raise exception 'rate card is not assigned to this customer' using errcode = 'P0001';
  end if;
  if pg_column_size(p_result) > 262144 then raise exception 'result too large' using errcode = 'P0001'; end if;
  insert into public.simulation_projects (tenant_id, brand_id, kind, name, rate_card_id) values (v_tenant, p_brand, 'single', p_name, p_rate_card) returning id into v_project;
  insert into public.simulation_runs (project_id, tenant_id, brand_id, kind, status, pricing_basis, as_of_date, total_shipments, processed_shipments, next_row_no, single_input, single_result, engine_version, finished_at)
  values (v_project, v_tenant, p_brand, 'single', 'completed', 'fixed_date', (p_input ->> 'shipDate')::date, 1, 1, 2, p_input, p_result, p_engine_version, now());
  return v_project;
end $$;

revoke all on function public.materialise_order_rows(uuid, jsonb, jsonb, jsonb, jsonb), public.finalize_order_dataset(uuid), public.discard_order_dataset(uuid),
  public.start_simulation_run(uuid, text, date, uuid, text, jsonb), public.simulation_batch_input(uuid, integer),
  public.advance_simulation_run(uuid, bigint, bigint, jsonb, jsonb, jsonb), public.finish_simulation_run(uuid, jsonb, jsonb, text),
  public.fail_simulation_run(uuid, text), public.cancel_simulation_run(uuid), public.save_single_simulation(uuid, uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.materialise_order_rows(uuid, jsonb, jsonb, jsonb, jsonb), public.finalize_order_dataset(uuid), public.discard_order_dataset(uuid),
  public.start_simulation_run(uuid, text, date, uuid, text, jsonb), public.simulation_batch_input(uuid, integer),
  public.advance_simulation_run(uuid, bigint, bigint, jsonb, jsonb, jsonb), public.finish_simulation_run(uuid, jsonb, jsonb, text),
  public.fail_simulation_run(uuid, text), public.cancel_simulation_run(uuid), public.save_single_simulation(uuid, uuid, text, jsonb, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- pricing_rules_for_card: brand-safe labels whenever a brand is being priced (even by staff), ids for
-- pinning, and optional omission of ZIP-list entries the caller already holds (bulk runs cache them).
-- ---------------------------------------------------------------------------
drop function public.pricing_rules_for_card(uuid, date, uuid);
create function public.pricing_rules_for_card(p_rate_card uuid, p_ship_date date, p_brand uuid default null, p_known_lists uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_staff boolean;
  v_brand uuid := p_brand;
  v_brand_view boolean;
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
        'effectiveDate', o.effective_date::text, 'expirationDate', o.expiration_date::text, 'reference', o.reference
      ) order by r.rule_key, o.effective_date), '[]'::jsonb)
    into v_overrides
    from public.customer_surcharge_overrides o
    join public.surcharge_rules r on r.id = o.rule_id
    where o.brand_id = v_brand and o.tenant_id = v_tenant and o.ended_at is null
      and o.effective_date <= p_ship_date and (o.expiration_date is null or o.expiration_date >= p_ship_date);
  end if;

  return jsonb_build_object('rules', v_rules, 'zipLists', v_lists, 'overrides', v_overrides, 'brandId', v_brand);
end $$;
revoke all on function public.pricing_rules_for_card(uuid, date, uuid, uuid[]) from public, anon;
grant execute on function public.pricing_rules_for_card(uuid, date, uuid, uuid[]) to authenticated;
