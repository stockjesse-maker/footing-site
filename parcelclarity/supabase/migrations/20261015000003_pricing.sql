-- ParcelClarity Milestone 2: carriers, customer-facing rate cards, surcharge rules, ZIP lists,
-- customer pricing exceptions, brand rate-card assignments, uploaded files and imports.
--
-- Pricing data rules (see PRODUCT_SPEC.md):
--   * Only the 3PL's CUSTOMER-FACING rate card is ever stored. There is no column anywhere for a
--     carrier buy rate, and no table for carrier account credentials.
--   * Surcharge amounts come from verified published sources (platform scope, publish-only through
--     a reviewed workflow) or from the 3PL's own approved configuration (tenant scope). Each
--     version records its source, dates and verification status.
--   * Brand customers can read only rate cards assigned to their brand, only active versions,
--     and only published rules/overrides that apply to them. They can never read uploaded files.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Carriers and services (reference data; names only, no amounts)
-- ---------------------------------------------------------------------------
create table public.carriers (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null,
  website text
);

create table public.shipping_services (
  id           uuid primary key default gen_random_uuid(),
  carrier_code text not null references public.carriers (code),
  code         text not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text not null,
  -- Typical delivery characteristics used only for display/grouping; never for pricing.
  category     text not null check (category in ('ground', 'express', 'economy', 'postal')),
  is_active    boolean not null default true,
  unique (carrier_code, code)
);

insert into public.carriers (code, name, website) values
  ('ups', 'UPS', 'https://www.ups.com'),
  ('fedex', 'FedEx', 'https://www.fedex.com'),
  ('usps', 'USPS', 'https://www.usps.com'),
  ('dhl_ecommerce', 'DHL eCommerce', 'https://www.dhl.com');

insert into public.shipping_services (carrier_code, code, name, category) values
  ('ups', 'ground', 'UPS Ground', 'ground'),
  ('ups', 'ground_saver', 'UPS Ground Saver', 'economy'),
  ('ups', 'three_day_select', 'UPS 3 Day Select', 'express'),
  ('ups', 'second_day_air', 'UPS 2nd Day Air', 'express'),
  ('ups', 'next_day_air_saver', 'UPS Next Day Air Saver', 'express'),
  ('ups', 'next_day_air', 'UPS Next Day Air', 'express'),
  ('fedex', 'ground', 'FedEx Ground', 'ground'),
  ('fedex', 'home_delivery', 'FedEx Home Delivery', 'ground'),
  ('fedex', 'ground_economy', 'FedEx Ground Economy', 'economy'),
  ('fedex', 'express_saver', 'FedEx Express Saver', 'express'),
  ('fedex', 'two_day', 'FedEx 2Day', 'express'),
  ('fedex', 'standard_overnight', 'FedEx Standard Overnight', 'express'),
  ('fedex', 'priority_overnight', 'FedEx Priority Overnight', 'express'),
  ('usps', 'ground_advantage', 'USPS Ground Advantage', 'postal'),
  ('usps', 'priority_mail', 'USPS Priority Mail', 'postal'),
  ('usps', 'priority_mail_express', 'USPS Priority Mail Express', 'postal'),
  ('dhl_ecommerce', 'parcel_ground', 'DHL eCommerce Parcel Ground', 'economy'),
  ('dhl_ecommerce', 'parcel_expedited', 'DHL eCommerce Parcel Expedited', 'economy'),
  ('dhl_ecommerce', 'parcel_expedited_max', 'DHL eCommerce Parcel Expedited Max', 'economy');

-- ---------------------------------------------------------------------------
-- Uploaded files (small confidential documents, stored in the database so RLS applies)
-- ---------------------------------------------------------------------------
create table public.uploaded_files (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  brand_id    uuid,
  purpose     text not null check (purpose in ('rate_card', 'zone_chart', 'zip_list', 'order_import')),
  filename    text not null check (char_length(filename) between 1 and 255),
  mime_type   text not null check (char_length(mime_type) between 3 and 120),
  byte_size   integer not null check (byte_size > 0 and byte_size <= 5242880),
  sha256      bytea not null check (octet_length(sha256) = 32),
  content     bytea not null,
  uploaded_by uuid not null default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint uploaded_files_brand_belongs_to_tenant
    foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint uploaded_files_size_matches check (octet_length(content) = byte_size)
);
create index uploaded_files_tenant_idx on public.uploaded_files (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Rate cards
-- ---------------------------------------------------------------------------
create table public.rate_cards (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index rate_cards_tenant_name_key on public.rate_cards (tenant_id, lower(btrim(name)));
create index rate_cards_tenant_idx on public.rate_cards (tenant_id);

create table public.rate_card_versions (
  id              uuid primary key default gen_random_uuid(),
  rate_card_id    uuid not null,
  tenant_id       uuid not null,
  version_number  integer not null check (version_number > 0),
  status          text not null default 'draft' check (status in ('draft', 'active', 'archived', 'discarded')),
  effective_date  date,
  expiration_date date,
  currency        text not null default 'USD' check (currency = 'USD'),
  notes           text check (notes is null or char_length(notes) <= 2000),
  source_file_id  uuid references public.uploaded_files (id) on delete set null,
  -- The approved import structure (column mapping, format, service mapping) for reproducibility.
  import_mapping  jsonb,
  validation_summary jsonb,
  row_count       integer not null default 0 check (row_count >= 0),
  activated_at    timestamptz,
  activated_by    uuid references auth.users (id) on delete set null,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (rate_card_id, version_number),
  unique (id, tenant_id),
  constraint rate_card_versions_card_in_tenant
    foreign key (rate_card_id, tenant_id) references public.rate_cards (id, tenant_id) on delete restrict,
  constraint rate_card_versions_dates check (expiration_date is null or effective_date is null or expiration_date >= effective_date),
  constraint rate_card_versions_active_has_dates check (status <> 'active' or effective_date is not null),
  -- Two ACTIVE versions of one card can never be in force on the same day.
  constraint rate_card_versions_no_overlap exclude using gist (
    rate_card_id with =,
    daterange(effective_date, coalesce(expiration_date, 'infinity'::date), '[]') with &&
  ) where (status = 'active')
);
create index rate_card_versions_card_idx on public.rate_card_versions (rate_card_id, status);

-- Per-service terms within a version: DIM rules, minimum charge, bundled/waived surcharges.
create table public.rate_card_service_terms (
  id                      uuid primary key default gen_random_uuid(),
  version_id              uuid not null references public.rate_card_versions (id) on delete cascade,
  service_id              uuid not null references public.shipping_services (id),
  dim_divisor             numeric(8,2) check (dim_divisor is null or dim_divisor > 0),
  dim_threshold_cubic_in  numeric(10,2) check (dim_threshold_cubic_in is null or dim_threshold_cubic_in >= 0),
  dimension_rounding      text not null default 'nearest_whole' check (dimension_rounding in ('none', 'nearest_whole', 'up_whole')),
  weight_rounding         text not null default 'up_whole_lb' check (weight_rounding in ('none', 'up_whole_lb', 'up_whole_oz')),
  min_billable_lb         numeric(10,3) check (min_billable_lb is null or min_billable_lb >= 0),
  dim_exempt              boolean not null default false,
  min_charge              numeric(12,4) check (min_charge is null or min_charge >= 0),
  included_surcharge_keys text[] not null default '{}',
  excluded_surcharge_keys text[] not null default '{}',
  unique (version_id, service_id)
);

create table public.rate_card_rows (
  id            bigint generated always as identity primary key,
  version_id    uuid not null references public.rate_card_versions (id) on delete cascade,
  service_id    uuid not null references public.shipping_services (id),
  origin_prefix text check (origin_prefix is null or origin_prefix ~ '^[0-9]{3}$|^[0-9]{5}$'),
  zone          text not null check (zone ~ '^[A-Za-z0-9]{1,12}$'),
  weight_min    numeric(10,3) not null check (weight_min >= 0),
  weight_max    numeric(10,3) not null check (weight_max > weight_min),
  weight_unit   text not null check (weight_unit in ('lb', 'oz')),
  price         numeric(12,4) not null check (price >= 0),
  min_charge    numeric(12,4) check (min_charge is null or min_charge >= 0)
);
create unique index rate_card_rows_bracket_key on public.rate_card_rows (version_id, service_id, coalesce(origin_prefix, ''), zone, weight_max);
create index rate_card_rows_lookup_idx on public.rate_card_rows (version_id, service_id, zone, weight_max);

create table public.rate_card_zones (
  id               bigint generated always as identity primary key,
  version_id       uuid not null references public.rate_card_versions (id) on delete cascade,
  carrier_code     text not null references public.carriers (code),
  origin_prefix    text not null check (origin_prefix ~ '^[0-9]{3}$|^[0-9]{5}$'),
  dest_prefix_from text not null check (dest_prefix_from ~ '^[0-9]{3}$|^[0-9]{5}$'),
  dest_prefix_to   text not null check (dest_prefix_to ~ '^[0-9]{3}$|^[0-9]{5}$'),
  zone             text not null check (zone ~ '^[A-Za-z0-9]{1,12}$'),
  constraint rate_card_zones_range check (char_length(dest_prefix_from) = char_length(dest_prefix_to) and dest_prefix_from <= dest_prefix_to)
);
create index rate_card_zones_lookup_idx on public.rate_card_zones (version_id, carrier_code, origin_prefix, dest_prefix_from);

-- Which brands may use which rate cards (and optionally only some of their services).
create table public.brand_rate_card_assignments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  brand_id            uuid not null,
  rate_card_id        uuid not null,
  allowed_service_ids uuid[],
  assigned_by         uuid default auth.uid() references auth.users (id) on delete set null,
  assigned_at         timestamptz not null default now(),
  unassigned_at       timestamptz,
  unassigned_by       uuid references auth.users (id) on delete set null,
  constraint brca_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint brca_card_in_tenant foreign key (rate_card_id, tenant_id) references public.rate_cards (id, tenant_id) on delete restrict
);
create unique index brca_active_key on public.brand_rate_card_assignments (brand_id, rate_card_id) where unassigned_at is null;
create index brca_brand_idx on public.brand_rate_card_assignments (brand_id) where unassigned_at is null;

-- ---------------------------------------------------------------------------
-- ZIP lists (e.g. delivery-area-surcharge ZIP codes) and surcharge rules
-- ---------------------------------------------------------------------------
create table public.zip_lists (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid references public.tenants (id) on delete restrict, -- null = platform-published
  carrier_code        text references public.carriers (code),
  key                 text not null check (key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  name                text not null check (char_length(name) between 1 and 120),
  version             integer not null default 1 check (version > 0),
  source_reference    text not null check (char_length(source_reference) between 1 and 500),
  source_url          text,
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified', 'approved_3pl_config')),
  effective_date      date not null,
  expiration_date     date check (expiration_date is null or expiration_date >= effective_date),
  entry_count         integer not null default 0 check (entry_count >= 0),
  source_file_id      uuid references public.uploaded_files (id) on delete set null,
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now()
);
create unique index zip_lists_scope_key on public.zip_lists (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key, version);

create table public.zip_list_entries (
  list_id uuid not null references public.zip_lists (id) on delete cascade,
  entry   text not null check (entry ~ '^[0-9]{3,5}$'),
  primary key (list_id, entry)
);

create table public.surcharge_rules (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null check (scope in ('platform', 'tenant')),
  tenant_id    uuid references public.tenants (id) on delete restrict,
  carrier_code text not null references public.carriers (code),
  rule_key     text not null check (rule_key ~ '^[a-z][a-z0-9_.]{1,80}$'),
  category     text not null check (category in ('fuel', 'residential', 'das', 'das_extended', 'remote_area', 'additional_handling',
                                                 'oversize', 'peak', 'address_correction', 'signature', 'declared_value',
                                                 'saturday_delivery', 'reweight', 'remeasure', 'shipping_charge_correction', 'other')),
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  archived_at  timestamptz,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint surcharge_rules_scope_tenant check ((scope = 'platform' and tenant_id is null) or (scope = 'tenant' and tenant_id is not null)),
  unique (id, tenant_id)
);
create unique index surcharge_rules_key on public.surcharge_rules (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_key);
create index surcharge_rules_tenant_idx on public.surcharge_rules (tenant_id);

create table public.surcharge_rule_versions (
  id                      uuid primary key default gen_random_uuid(),
  rule_id                 uuid not null references public.surcharge_rules (id) on delete cascade,
  tenant_id               uuid references public.tenants (id) on delete restrict,
  version_number          integer not null check (version_number > 0),
  status                  text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  charge_class            text not null check (charge_class in ('definite', 'estimated', 'conditional')),
  applies_to_service_ids  uuid[],
  method                  text not null check (method in ('flat', 'percent', 'per_unit')),
  amount                  numeric(12,4) check (amount is null or amount >= 0),
  percent                 numeric(8,4) check (percent is null or percent >= 0),
  per_unit_basis          text check (per_unit_basis is null or per_unit_basis in ('declared_value')),
  per_unit_size           numeric(12,4) check (per_unit_size is null or per_unit_size > 0),
  per_unit_free_allowance numeric(12,4) check (per_unit_free_allowance is null or per_unit_free_allowance >= 0),
  calculation_base        jsonb not null default '{"kind":"base_rate"}'::jsonb,
  conditions              jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  exclusivity_group       text check (exclusivity_group is null or exclusivity_group ~ '^[a-z][a-z0-9_.]{1,60}$'),
  exclusivity_priority    integer not null default 0,
  excludes_rule_keys      text[] not null default '{}',
  per_package             boolean not null default true,
  effective_date          date not null,
  expiration_date         date check (expiration_date is null or expiration_date >= effective_date),
  source_reference        text not null check (char_length(source_reference) between 1 and 500),
  source_url              text,
  verification_status     text not null default 'unverified' check (verification_status in ('unverified', 'verified', 'approved_3pl_config')),
  verified_by             uuid references auth.users (id) on delete set null,
  verified_at             timestamptz,
  published_at            timestamptz,
  published_by            uuid references auth.users (id) on delete set null,
  retired_at              timestamptz,
  created_by              uuid default auth.uid() references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  unique (rule_id, version_number),
  constraint srv_rule_in_tenant foreign key (rule_id, tenant_id) references public.surcharge_rules (id, tenant_id) on delete cascade,
  constraint srv_method_fields check (
    (method = 'flat' and amount is not null and percent is null)
    or (method = 'percent' and percent is not null and amount is null)
    or (method = 'per_unit' and amount is not null and per_unit_basis is not null and per_unit_size is not null)
  ),
  -- Only one PUBLISHED version of a rule can be in force on a given date.
  constraint srv_no_overlap exclude using gist (
    rule_id with =,
    daterange(effective_date, coalesce(expiration_date, 'infinity'::date), '[]') with &&
  ) where (status = 'published')
);
create index srv_rule_idx on public.surcharge_rule_versions (rule_id, status);

-- Customer-specific exceptions: waive a surcharge for a brand, or charge it at a different rate.
create table public.customer_surcharge_overrides (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete restrict,
  brand_id        uuid not null,
  rule_id         uuid not null references public.surcharge_rules (id) on delete cascade,
  mode            text not null check (mode in ('exclude', 'override_amount', 'override_percent')),
  amount          numeric(12,4) check (amount is null or amount >= 0),
  percent         numeric(8,4) check (percent is null or percent >= 0),
  effective_date  date not null,
  expiration_date date check (expiration_date is null or expiration_date >= effective_date),
  reference       text not null check (char_length(reference) between 1 and 300),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  ended_at        timestamptz,
  constraint cso_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint cso_mode_fields check (
    (mode = 'exclude' and amount is null and percent is null)
    or (mode = 'override_amount' and amount is not null and percent is null)
    or (mode = 'override_percent' and percent is not null and amount is null)
  )
);
create index cso_brand_idx on public.customer_surcharge_overrides (brand_id) where ended_at is null;

-- ---------------------------------------------------------------------------
-- Rate-card imports (upload → mapping → validation → draft version)
-- ---------------------------------------------------------------------------
create table public.rate_card_imports (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  rate_card_id     uuid not null,
  file_id          uuid not null references public.uploaded_files (id) on delete restrict,
  status           text not null default 'uploaded' check (status in ('uploaded', 'mapped', 'validated', 'imported', 'discarded')),
  detected         jsonb not null default '{}'::jsonb,   -- sheets, headers, sample rows, suggested format/mapping
  mapping          jsonb,                                -- the mapping the administrator approved
  validation       jsonb,                                -- errors, warnings, coverage summary
  version_id       uuid references public.rate_card_versions (id) on delete set null,
  created_by       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint rci_card_in_tenant foreign key (rate_card_id, tenant_id) references public.rate_cards (id, tenant_id) on delete restrict
);
create index rci_card_idx on public.rate_card_imports (rate_card_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger rate_cards_touch before update on public.rate_cards for each row execute function app.touch_updated_at();
create trigger rate_card_versions_touch before update on public.rate_card_versions for each row execute function app.touch_updated_at();
create trigger rate_card_imports_touch before update on public.rate_card_imports for each row execute function app.touch_updated_at();

-- Rows, zones and terms are immutable once a version leaves draft.
create function app.guard_version_children() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_version uuid;
begin
  v_version := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  select status into v_status from public.rate_card_versions where id = v_version;
  if v_status is distinct from 'draft' then
    raise exception 'rate card version is not a draft; its rows cannot change' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger rate_card_rows_guard before insert or update or delete on public.rate_card_rows for each row execute function app.guard_version_children();
create trigger rate_card_zones_guard before insert or update or delete on public.rate_card_zones for each row execute function app.guard_version_children();
create trigger rate_card_terms_guard before insert or update or delete on public.rate_card_service_terms for each row execute function app.guard_version_children();

create function app.guard_rate_card_version_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.rate_card_id <> old.rate_card_id or new.tenant_id <> old.tenant_id or new.version_number <> old.version_number then
    raise exception 'version identity columns are immutable' using errcode = '42501';
  end if;
  if old.status in ('archived', 'discarded') and new.status <> old.status then
    raise exception 'an archived or discarded version cannot change status' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger rate_card_versions_guard before update on public.rate_card_versions for each row execute function app.guard_rate_card_version_update();

create function app.guard_rule_version_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'published' and (
       new.status = 'draft' or new.amount is distinct from old.amount or new.percent is distinct from old.percent
    or new.conditions is distinct from old.conditions or new.calculation_base is distinct from old.calculation_base
    or new.method is distinct from old.method or new.effective_date is distinct from old.effective_date
    or new.applies_to_service_ids is distinct from old.applies_to_service_ids
    or new.exclusivity_group is distinct from old.exclusivity_group or new.excludes_rule_keys is distinct from old.excludes_rule_keys
    or new.per_package is distinct from old.per_package or new.charge_class is distinct from old.charge_class) then
    raise exception 'a published rule version is immutable; create a new version' using errcode = '42501';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'a retired rule version cannot be reactivated' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger srv_guard before update on public.surcharge_rule_versions for each row execute function app.guard_rule_version_update();

-- Audit
create function app.audit_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'rate_cards' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, null, 'ratecard.created', 'rate_card', new.id::text, jsonb_build_object('name', new.name));
    elsif new.status is distinct from old.status or new.name is distinct from old.name then
      perform app.write_audit(new.tenant_id, null, 'ratecard.updated', 'rate_card', new.id::text,
        jsonb_build_object('name', new.name, 'status_from', old.status, 'status_to', new.status));
    end if;
  elsif tg_table_name = 'rate_card_versions' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform app.write_audit(new.tenant_id, null, 'ratecard.version_' || new.status, 'rate_card_version', new.id::text,
        jsonb_build_object('rate_card_id', new.rate_card_id, 'version', new.version_number,
                           'effective_date', new.effective_date, 'expiration_date', new.expiration_date, 'row_count', new.row_count));
    end if;
  elsif tg_table_name = 'brand_rate_card_assignments' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'ratecard.assigned', 'rate_card', new.rate_card_id::text,
        jsonb_build_object('allowed_service_ids', new.allowed_service_ids));
    elsif new.unassigned_at is not null and old.unassigned_at is null then
      perform app.write_audit(new.tenant_id, new.brand_id, 'ratecard.unassigned', 'rate_card', new.rate_card_id::text, '{}'::jsonb);
    end if;
  elsif tg_table_name = 'surcharge_rule_versions' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform app.write_audit(new.tenant_id, null, 'carrier_rule.' || new.status, 'surcharge_rule_version', new.id::text,
        jsonb_build_object('rule_id', new.rule_id, 'version', new.version_number, 'effective_date', new.effective_date));
    end if;
  elsif tg_table_name = 'customer_surcharge_overrides' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'ratecard.override_created', 'surcharge_override', new.id::text,
        jsonb_build_object('rule_id', new.rule_id, 'mode', new.mode, 'amount', new.amount, 'percent', new.percent));
    elsif new.ended_at is not null and old.ended_at is null then
      perform app.write_audit(new.tenant_id, new.brand_id, 'ratecard.override_ended', 'surcharge_override', new.id::text, '{}'::jsonb);
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger rate_cards_audit after insert or update on public.rate_cards for each row execute function app.audit_pricing();
create trigger rate_card_versions_audit after update on public.rate_card_versions for each row execute function app.audit_pricing();
create trigger brca_audit after insert or update on public.brand_rate_card_assignments for each row execute function app.audit_pricing();
create trigger srv_audit after update on public.surcharge_rule_versions for each row execute function app.audit_pricing();
create trigger cso_audit after insert or update on public.customer_surcharge_overrides for each row execute function app.audit_pricing();

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
create function app.can_manage_pricing(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'ratecard.manage');
$$;

-- Brand member of an active brand with an active assignment to this rate card.
create function app.brand_has_rate_card(p_rate_card uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.brand_rate_card_assignments a
    join public.brands b on b.id = a.brand_id and b.status = 'active'
    join public.tenants t on t.id = a.tenant_id and t.status = 'active'
    join public.memberships m on m.brand_id = a.brand_id and m.user_id = (select auth.uid()) and m.status = 'active'
    where a.rate_card_id = p_rate_card and a.unassigned_at is null
  );
$$;

-- Staff with ratecard.view see everything in their tenant; brands see only assigned cards.
create function app.can_view_rate_card(p_rate_card uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'ratecard.view') or app.brand_has_rate_card(p_rate_card);
$$;

-- Versions: staff see all statuses; brands see only active versions of assigned cards.
create function app.can_view_rate_card_version(p_rate_card uuid, p_tenant uuid, p_status text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'ratecard.view')
      or (p_status = 'active' and app.brand_has_rate_card(p_rate_card));
$$;

-- Platform-scope rules/lists are readable by every signed-in user; tenant-scope by that tenant's members.
create function app.can_view_tenant_scoped(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_tenant is null or app.is_member_of_tenant(p_tenant);
$$;

-- Overrides: staff see their tenant's; a brand member sees only their own brand's.
create function app.can_view_override(p_tenant uuid, p_brand uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'ratecard.view')
      or exists (select 1 from public.memberships m
                 join public.brands b on b.id = m.brand_id and b.status = 'active'
                 where m.user_id = (select auth.uid()) and m.brand_id = p_brand and m.status = 'active');
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.carriers enable row level security;
alter table public.shipping_services enable row level security;
alter table public.uploaded_files enable row level security;
alter table public.rate_cards enable row level security;
alter table public.rate_card_versions enable row level security;
alter table public.rate_card_service_terms enable row level security;
alter table public.rate_card_rows enable row level security;
alter table public.rate_card_zones enable row level security;
alter table public.brand_rate_card_assignments enable row level security;
alter table public.zip_lists enable row level security;
alter table public.zip_list_entries enable row level security;
alter table public.surcharge_rules enable row level security;
alter table public.surcharge_rule_versions enable row level security;
alter table public.customer_surcharge_overrides enable row level security;
alter table public.rate_card_imports enable row level security;

create policy carriers_read on public.carriers for select to authenticated using (true);
create policy services_read on public.shipping_services for select to authenticated using (true);

create policy files_read on public.uploaded_files for select to authenticated using (app.can_manage_pricing(tenant_id));
create policy files_insert on public.uploaded_files for insert to authenticated
  with check (app.can_manage_pricing(tenant_id) and uploaded_by = (select auth.uid()) and brand_id is null);

create policy rate_cards_read on public.rate_cards for select to authenticated using (app.can_view_rate_card(id, tenant_id));
create policy rate_cards_insert on public.rate_cards for insert to authenticated with check (app.can_manage_pricing(tenant_id));
create policy rate_cards_update on public.rate_cards for update to authenticated
  using (app.can_manage_pricing(tenant_id)) with check (app.can_manage_pricing(tenant_id));

create policy versions_read on public.rate_card_versions for select to authenticated
  using (app.can_view_rate_card_version(rate_card_id, tenant_id, status));
create policy versions_insert on public.rate_card_versions for insert to authenticated
  with check (app.can_manage_pricing(tenant_id) and status = 'draft');
-- Status transitions go through RPCs; direct updates may only touch notes/mapping on drafts.
create policy versions_update on public.rate_card_versions for update to authenticated
  using (app.can_manage_pricing(tenant_id) and status = 'draft')
  with check (app.can_manage_pricing(tenant_id) and status = 'draft');

-- Children are visible exactly when their version is visible (versions' own RLS applies in the subquery).
create policy terms_read on public.rate_card_service_terms for select to authenticated
  using (version_id in (select v.id from public.rate_card_versions v));
create policy terms_write on public.rate_card_service_terms for all to authenticated
  using (version_id in (select v.id from public.rate_card_versions v where v.status = 'draft' and app.can_manage_pricing(v.tenant_id)))
  with check (version_id in (select v.id from public.rate_card_versions v where v.status = 'draft' and app.can_manage_pricing(v.tenant_id)));

create policy rows_read on public.rate_card_rows for select to authenticated
  using (version_id in (select v.id from public.rate_card_versions v));
create policy rows_write on public.rate_card_rows for all to authenticated
  using (version_id in (select v.id from public.rate_card_versions v where v.status = 'draft' and app.can_manage_pricing(v.tenant_id)))
  with check (version_id in (select v.id from public.rate_card_versions v where v.status = 'draft' and app.can_manage_pricing(v.tenant_id)));

create policy zones_read on public.rate_card_zones for select to authenticated
  using (version_id in (select v.id from public.rate_card_versions v));
create policy zones_write on public.rate_card_zones for all to authenticated
  using (version_id in (select v.id from public.rate_card_versions v where v.status = 'draft' and app.can_manage_pricing(v.tenant_id)))
  with check (version_id in (select v.id from public.rate_card_versions v where v.status = 'draft' and app.can_manage_pricing(v.tenant_id)));

create policy brca_read on public.brand_rate_card_assignments for select to authenticated
  using (app.has_tenant_permission(tenant_id, 'brand.view') or app.has_brand_permission(brand_id, 'brand.view'));
create policy brca_insert on public.brand_rate_card_assignments for insert to authenticated
  with check (app.can_manage_pricing(tenant_id) and unassigned_at is null);
create policy brca_update on public.brand_rate_card_assignments for update to authenticated
  using (app.can_manage_pricing(tenant_id)) with check (app.can_manage_pricing(tenant_id));

create policy zip_lists_read on public.zip_lists for select to authenticated using (app.can_view_tenant_scoped(tenant_id));
create policy zip_lists_insert on public.zip_lists for insert to authenticated
  with check (tenant_id is not null and app.can_manage_pricing(tenant_id) and verification_status = 'approved_3pl_config');
create policy zip_entries_read on public.zip_list_entries for select to authenticated
  using (list_id in (select l.id from public.zip_lists l));
create policy zip_entries_insert on public.zip_list_entries for insert to authenticated
  with check (list_id in (select l.id from public.zip_lists l where l.tenant_id is not null and app.can_manage_pricing(l.tenant_id)));

create policy rules_read on public.surcharge_rules for select to authenticated using (app.can_view_tenant_scoped(tenant_id));
create policy rules_insert on public.surcharge_rules for insert to authenticated
  with check (scope = 'tenant' and tenant_id is not null and app.can_manage_pricing(tenant_id));
create policy rules_update on public.surcharge_rules for update to authenticated
  using (scope = 'tenant' and app.can_manage_pricing(tenant_id)) with check (scope = 'tenant' and app.can_manage_pricing(tenant_id));

-- Brands and staff read published versions; staff also read drafts/retired of their own tenant.
create policy srv_read on public.surcharge_rule_versions for select to authenticated
  using (
    (status = 'published' and app.can_view_tenant_scoped(tenant_id))
    or (tenant_id is not null and app.has_tenant_permission(tenant_id, 'ratecard.view'))
  );
create policy srv_insert on public.surcharge_rule_versions for insert to authenticated
  with check (tenant_id is not null and app.can_manage_pricing(tenant_id) and status = 'draft'
              and verification_status = 'approved_3pl_config');
create policy srv_update on public.surcharge_rule_versions for update to authenticated
  using (tenant_id is not null and app.can_manage_pricing(tenant_id) and status = 'draft')
  with check (tenant_id is not null and app.can_manage_pricing(tenant_id) and status = 'draft');

create policy cso_read on public.customer_surcharge_overrides for select to authenticated using (app.can_view_override(tenant_id, brand_id));
create policy cso_insert on public.customer_surcharge_overrides for insert to authenticated
  with check (app.can_manage_pricing(tenant_id) and ended_at is null
              and exists (select 1 from public.surcharge_rules r where r.id = rule_id and (r.tenant_id is null or r.tenant_id = customer_surcharge_overrides.tenant_id)));
create policy cso_update on public.customer_surcharge_overrides for update to authenticated
  using (app.can_manage_pricing(tenant_id)) with check (app.can_manage_pricing(tenant_id));

create policy imports_read on public.rate_card_imports for select to authenticated using (app.can_manage_pricing(tenant_id));
create policy imports_insert on public.rate_card_imports for insert to authenticated
  with check (app.can_manage_pricing(tenant_id) and created_by = (select auth.uid()));
create policy imports_update on public.rate_card_imports for update to authenticated
  using (app.can_manage_pricing(tenant_id)) with check (app.can_manage_pricing(tenant_id));

-- ---------------------------------------------------------------------------
-- Grants (explicit, minimal, column-scoped writes)
-- ---------------------------------------------------------------------------
grant select on public.carriers, public.shipping_services to authenticated;
grant select on public.uploaded_files, public.rate_cards, public.rate_card_versions, public.rate_card_service_terms,
                public.rate_card_rows, public.rate_card_zones, public.brand_rate_card_assignments, public.zip_lists,
                public.zip_list_entries, public.surcharge_rules, public.surcharge_rule_versions,
                public.customer_surcharge_overrides, public.rate_card_imports to authenticated;

grant insert (tenant_id, purpose, filename, mime_type, byte_size, sha256, content) on public.uploaded_files to authenticated;
grant insert (tenant_id, name, description) on public.rate_cards to authenticated;
grant update (name, description, status) on public.rate_cards to authenticated;
grant insert (rate_card_id, tenant_id, version_number, notes, source_file_id, import_mapping, validation_summary, row_count) on public.rate_card_versions to authenticated;
grant update (notes, import_mapping, validation_summary, row_count) on public.rate_card_versions to authenticated;
grant insert, update, delete on public.rate_card_service_terms to authenticated;
grant insert (version_id, service_id, origin_prefix, zone, weight_min, weight_max, weight_unit, price, min_charge), delete on public.rate_card_rows to authenticated;
grant insert (version_id, carrier_code, origin_prefix, dest_prefix_from, dest_prefix_to, zone), delete on public.rate_card_zones to authenticated;
grant insert (tenant_id, brand_id, rate_card_id, allowed_service_ids) on public.brand_rate_card_assignments to authenticated;
grant update (allowed_service_ids, unassigned_at, unassigned_by) on public.brand_rate_card_assignments to authenticated;
grant insert (tenant_id, carrier_code, key, name, version, source_reference, source_url, verification_status, effective_date, expiration_date, entry_count, source_file_id) on public.zip_lists to authenticated;
grant insert on public.zip_list_entries to authenticated;
grant insert (scope, tenant_id, carrier_code, rule_key, category, name) on public.surcharge_rules to authenticated;
grant update (name, archived_at) on public.surcharge_rules to authenticated;
grant insert (rule_id, tenant_id, version_number, charge_class, applies_to_service_ids, method, amount, percent, per_unit_basis, per_unit_size,
              per_unit_free_allowance, calculation_base, conditions, exclusivity_group, exclusivity_priority, excludes_rule_keys, per_package,
              effective_date, expiration_date, source_reference, source_url, verification_status) on public.surcharge_rule_versions to authenticated;
grant update (charge_class, applies_to_service_ids, method, amount, percent, per_unit_basis, per_unit_size, per_unit_free_allowance, calculation_base,
              conditions, exclusivity_group, exclusivity_priority, excludes_rule_keys, per_package, effective_date, expiration_date,
              source_reference, source_url) on public.surcharge_rule_versions to authenticated;
grant insert (tenant_id, brand_id, rule_id, mode, amount, percent, effective_date, expiration_date, reference) on public.customer_surcharge_overrides to authenticated;
grant update (expiration_date, ended_at) on public.customer_surcharge_overrides to authenticated;
grant insert (tenant_id, rate_card_id, file_id, detected) on public.rate_card_imports to authenticated;
grant update (status, detected, mapping, validation, version_id) on public.rate_card_imports to authenticated;

grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- RPC: state transitions with explicit checks and audit
-- ---------------------------------------------------------------------------
create function public.activate_rate_card_version(p_version uuid, p_effective date, p_expiration date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rate_card_versions%rowtype; v_rows integer; v_missing integer;
begin
  select * into v from public.rate_card_versions where id = p_version for update;
  if not found or not app.can_manage_pricing(v.tenant_id) then raise exception 'version not found' using errcode = 'P0003'; end if;
  if v.status <> 'draft' then raise exception 'only a draft version can be activated' using errcode = 'P0004'; end if;
  if p_effective is null then raise exception 'effective date is required' using errcode = '22023'; end if;
  if p_expiration is not null and p_expiration < p_effective then raise exception 'expiration must not precede effective date' using errcode = '22023'; end if;
  select count(*) into v_rows from public.rate_card_rows where version_id = p_version;
  if v_rows = 0 then raise exception 'a version with no rate rows cannot be activated' using errcode = 'P0005'; end if;
  select count(distinct r.service_id) into v_missing
    from public.rate_card_rows r
    where r.version_id = p_version
      and not exists (select 1 from public.rate_card_service_terms t where t.version_id = p_version and t.service_id = r.service_id);
  if v_missing > 0 then raise exception 'every service on the card needs service terms before activation' using errcode = 'P0006'; end if;
  begin
    update public.rate_card_versions
       set status = 'active', effective_date = p_effective, expiration_date = p_expiration, row_count = v_rows,
           activated_at = now(), activated_by = (select auth.uid())
     where id = p_version;
  exception when exclusion_violation then
    raise exception 'another active version of this rate card already covers those dates' using errcode = 'P0007';
  end;
end $$;

create function public.archive_rate_card_version(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rate_card_versions%rowtype;
begin
  select * into v from public.rate_card_versions where id = p_version for update;
  if not found or not app.can_manage_pricing(v.tenant_id) then raise exception 'version not found' using errcode = 'P0003'; end if;
  if v.status = 'active' then
    update public.rate_card_versions set status = 'archived' where id = p_version;
  elsif v.status = 'draft' then
    update public.rate_card_versions set status = 'discarded' where id = p_version;
  else
    raise exception 'version is already closed' using errcode = 'P0004';
  end if;
end $$;

create function public.publish_surcharge_rule_version(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.surcharge_rule_versions%rowtype;
begin
  select * into v from public.surcharge_rule_versions where id = p_version for update;
  if not found or v.tenant_id is null or not app.can_manage_pricing(v.tenant_id) then raise exception 'rule version not found' using errcode = 'P0003'; end if;
  if v.status <> 'draft' then raise exception 'only a draft can be published' using errcode = 'P0004'; end if;
  begin
    update public.surcharge_rule_versions
       set status = 'published', published_at = now(), published_by = (select auth.uid()),
           verification_status = 'approved_3pl_config', verified_by = (select auth.uid()), verified_at = now()
     where id = p_version;
  exception when exclusion_violation then
    raise exception 'another published version of this rule already covers those dates' using errcode = 'P0007';
  end;
end $$;

create function public.retire_surcharge_rule_version(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.surcharge_rule_versions%rowtype;
begin
  select * into v from public.surcharge_rule_versions where id = p_version for update;
  if not found or v.tenant_id is null or not app.can_manage_pricing(v.tenant_id) then raise exception 'rule version not found' using errcode = 'P0003'; end if;
  if v.status <> 'published' then raise exception 'only a published version can be retired' using errcode = 'P0004'; end if;
  update public.surcharge_rule_versions set status = 'retired', retired_at = now() where id = p_version;
end $$;

revoke all on function public.activate_rate_card_version(uuid, date, date), public.archive_rate_card_version(uuid),
  public.publish_surcharge_rule_version(uuid), public.retire_surcharge_rule_version(uuid) from public, anon;
grant execute on function public.activate_rate_card_version(uuid, date, date), public.archive_rate_card_version(uuid),
  public.publish_surcharge_rule_version(uuid), public.retire_surcharge_rule_version(uuid) to authenticated;

revoke all on all functions in schema app from public, anon;
grant execute on function app.can_manage_pricing(uuid), app.brand_has_rate_card(uuid), app.can_view_rate_card(uuid, uuid),
  app.can_view_rate_card_version(uuid, uuid, text), app.can_view_tenant_scoped(uuid), app.can_view_override(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Read helpers: fetch a version's rows/zones or a ZIP list in one call (bypassing the Data API's
-- 1000-row page size). SECURITY INVOKER: the caller's RLS applies to every row.
-- ---------------------------------------------------------------------------
create function public.rate_card_rows_json(p_version uuid, p_service_ids uuid[] default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'serviceId', r.service_id, 'originPrefix', r.origin_prefix, 'zone', r.zone,
           'weightMin', r.weight_min::text, 'weightMax', r.weight_max::text, 'weightUnit', r.weight_unit,
           'price', r.price::text, 'minCharge', r.min_charge::text) order by r.id), '[]'::jsonb)
  from public.rate_card_rows r
  where r.version_id = p_version and (p_service_ids is null or r.service_id = any (p_service_ids));
$$;

create function public.rate_card_zones_json(p_version uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'carrierCode', z.carrier_code, 'originPrefix', z.origin_prefix, 'destPrefixFrom', z.dest_prefix_from,
           'destPrefixTo', z.dest_prefix_to, 'zone', z.zone) order by z.id), '[]'::jsonb)
  from public.rate_card_zones z where z.version_id = p_version;
$$;

create function public.zip_list_entries_array(p_list uuid) returns text[]
language sql stable security invoker set search_path = '' as $$
  select coalesce(array_agg(e.entry order by e.entry), '{}'::text[]) from public.zip_list_entries e where e.list_id = p_list;
$$;

revoke all on function public.rate_card_rows_json(uuid, uuid[]), public.rate_card_zones_json(uuid), public.zip_list_entries_array(uuid) from public, anon;
grant execute on function public.rate_card_rows_json(uuid, uuid[]), public.rate_card_zones_json(uuid), public.zip_list_entries_array(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Audit integrity: pricing lifecycle events are written only by triggers. The user-callable
-- log_audit_event() may no longer use the 'ratecard.' or 'carrier_rule.' namespaces, so a
-- member cannot forge an activation/publication record. (Replaces the Milestone 1 definition.)
-- ---------------------------------------------------------------------------
create or replace function public.log_audit_event(p_tenant uuid, p_brand uuid, p_action text,
                                                  p_entity_type text default null, p_entity_id text default null,
                                                  p_metadata jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_action !~ '^(simulation|scenario|report|export|import|billing|adjustment|session)\.[a-z_]{2,40}$' then
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
