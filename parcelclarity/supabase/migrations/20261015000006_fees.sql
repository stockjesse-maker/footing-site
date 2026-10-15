-- ---------------------------------------------------------------------------
-- Milestone 4: fee schedules (customer-facing fulfillment processing fees), fees in bulk runs,
-- forecast period and volume, forecasts from assumptions.
--
-- A fee schedule is the 3PL's own list of charges, versioned like a rate card: every amount here was
-- typed by the 3PL, never derived from a carrier buy rate or fabricated. Rules are customer-visible;
-- the only staff-only text lives in fee_rule_sources and fee_schedule_version_notes, which brands
-- have no policy for. Runs pin the version in effect per fee date, store one fee result per order,
-- and the finishing function recomputes the processing totals, every monthly line and every
-- minimum top-up in SQL before trusting the caller's summary.
--
-- Permanent failures (bad inputs, stale partial summaries, summaries that do not reconcile) raise
-- SQLSTATE class 'PC' so callers can tell them from transient errors: PC001 invalid input,
-- PC002 stale/incompatible client state, PC003 does not reconcile.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.fee_schedules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  -- Customers see the name and the description (staff-only text lives in fee_schedule_version_notes).
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index fee_schedules_tenant_name_key on public.fee_schedules (tenant_id, lower(btrim(name)));
create index fee_schedules_tenant_idx on public.fee_schedules (tenant_id);
create trigger fee_schedules_touch before update on public.fee_schedules for each row execute function app.touch_updated_at();

create table public.fee_schedule_versions (
  id              uuid primary key default gen_random_uuid(),
  schedule_id     uuid not null,
  tenant_id       uuid not null,
  version_number  integer not null check (version_number > 0),
  status          text not null default 'draft' check (status in ('draft', 'active', 'archived', 'discarded')),
  effective_date  date,
  expiration_date date,
  -- invoice_line: order lines carried exactly and rounded at monthly aggregates; transaction: every order line rounded to cents.
  rounding        text not null default 'invoice_line' check (rounding in ('invoice_line', 'transaction')),
  rule_count      integer not null default 0 check (rule_count >= 0),
  activated_at    timestamptz,
  activated_by    uuid references auth.users (id) on delete set null,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (schedule_id, version_number),
  unique (id, tenant_id),
  constraint fsv_schedule_in_tenant foreign key (schedule_id, tenant_id) references public.fee_schedules (id, tenant_id) on delete restrict,
  constraint fsv_dates check (expiration_date is null or effective_date is null or expiration_date >= effective_date),
  constraint fsv_active_has_dates check (status <> 'active' or effective_date is not null),
  -- Two ACTIVE versions of one schedule can never be in force on the same day.
  constraint fsv_no_overlap exclude using gist (
    schedule_id with =,
    daterange(effective_date, coalesce(expiration_date, 'infinity'::date), '[]') with &&
  ) where (status = 'active')
);
create index fsv_schedule_idx on public.fee_schedule_versions (schedule_id, status);
-- One draft at a time keeps "the draft" unambiguous in the editor.
create unique index fsv_one_draft on public.fee_schedule_versions (schedule_id) where status = 'draft';
create trigger fsv_touch before update on public.fee_schedule_versions for each row execute function app.touch_updated_at();

create table public.fee_rules (
  id                uuid primary key default gen_random_uuid(),
  version_id        uuid not null,
  tenant_id         uuid not null,
  position          integer not null default 0 check (position >= 0),
  key               text not null,
  name              text not null,
  category          text not null,
  scope             text not null,
  basis             text not null,
  method            text not null,
  amount            numeric(12,4) check (amount is null or amount >= 0),
  percent           numeric(8,4) check (percent is null or (percent >= 0 and percent <= 1000)),
  percent_base      text check (percent_base is null or percent_base in ('shipping_total', 'base_freight')),
  tiers             jsonb,
  included_quantity numeric(12,4) check (included_quantity is null or included_quantity >= 0),
  included_per      text check (included_per is null or included_per in ('order', 'line', 'sku', 'shipment')),
  minimum_charge    numeric(12,4) check (minimum_charge is null or minimum_charge >= 0),
  conditions        jsonb,
  exclusive_group   text,
  priority          integer,
  driver            jsonb,
  minimum           jsonb,
  -- Set at activation from minimum.appliesTo; shown to customers as "what counts toward the minimum".
  resolved_rule_keys text[],
  description       text check (description is null or char_length(description) <= 2000),
  help_text         text check (help_text is null or char_length(help_text) <= 1000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint fee_rules_version_in_tenant foreign key (version_id, tenant_id) references public.fee_schedule_versions (id, tenant_id) on delete cascade,
  unique (version_id, key),
  unique (id, version_id)
);
create index fee_rules_version_idx on public.fee_rules (version_id, position);
create trigger fee_rules_touch before update on public.fee_rules for each row execute function app.touch_updated_at();

-- Staff-only: where the 3PL's own number comes from (a contract clause, a pricing sheet). Never shown to brands.
create table public.fee_rule_sources (
  rule_id          uuid primary key references public.fee_rules (id) on delete cascade,
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  source_reference text not null check (char_length(source_reference) between 1 and 1000),
  updated_by       uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now()
);

-- Staff-only notes on a version (why it changed, who approved it). Never shown to brands.
create table public.fee_schedule_version_notes (
  version_id uuid primary key references public.fee_schedule_versions (id) on delete cascade,
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  notes      text not null check (char_length(notes) between 1 and 4000),
  updated_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Which fee schedule a brand is on (at most one at a time). Written only by the assignment functions.
create table public.brand_fee_schedule_assignments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete restrict,
  brand_id      uuid not null,
  schedule_id   uuid not null,
  assigned_by   uuid default auth.uid() references auth.users (id) on delete set null,
  assigned_at   timestamptz not null default now(),
  unassigned_at timestamptz,
  unassigned_by uuid references auth.users (id) on delete set null,
  constraint bfsa_brand_in_tenant foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint bfsa_schedule_in_tenant foreign key (schedule_id, tenant_id) references public.fee_schedules (id, tenant_id) on delete restrict
);
create unique index bfsa_one_active_per_brand on public.brand_fee_schedule_assignments (brand_id) where unassigned_at is null;
create index bfsa_schedule_idx on public.brand_fee_schedule_assignments (schedule_id) where unassigned_at is null;

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
create function app.can_manage_fees(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can_manage_pricing(p_tenant);
$$;

create function app.can_view_fees(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_tenant_permission(p_tenant, 'ratecard.view');
$$;

-- Brand member of an active brand currently assigned to this schedule.
create function app.brand_has_fee_schedule(p_schedule uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.brand_fee_schedule_assignments a
    join public.brands b on b.id = a.brand_id and b.status = 'active'
    join public.tenants t on t.id = a.tenant_id and t.status = 'active'
    join public.memberships m on m.brand_id = a.brand_id and m.user_id = (select auth.uid()) and m.status = 'active'
    where a.schedule_id = p_schedule and a.unassigned_at is null
  );
$$;

-- Staff see every version; a brand sees active and archived versions of its assigned schedule (never drafts).
create function app.can_view_fee_version(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.fee_schedule_versions v
    where v.id = p_version
      and (app.can_view_fees(v.tenant_id) or (v.status in ('active', 'archived') and app.brand_has_fee_schedule(v.schedule_id)))
  );
$$;

-- The brand's active fee schedule (null when none is assigned).
create function app.brand_fee_schedule(p_brand uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.schedule_id from public.brand_fee_schedule_assignments a
  join public.fee_schedules s on s.id = a.schedule_id and s.status = 'active'
  where a.brand_id = p_brand and a.unassigned_at is null limit 1;
$$;

-- The version of a schedule in effect on a date (active or archived versions keep resolving for history).
create function app.fee_version_on(p_schedule uuid, p_date date) returns uuid
language sql stable security definer set search_path = '' as $$
  select v.id from public.fee_schedule_versions v
  where v.schedule_id = p_schedule and v.status in ('active', 'archived') and v.effective_date <= p_date
    and (v.expiration_date is null or v.expiration_date >= p_date)
  order by (v.status = 'active') desc, v.version_number desc limit 1;
$$;

revoke all on function app.can_manage_fees(uuid), app.can_view_fees(uuid), app.brand_has_fee_schedule(uuid), app.can_view_fee_version(uuid),
  app.brand_fee_schedule(uuid), app.fee_version_on(uuid, date) from public, anon;
grant execute on function app.can_manage_fees(uuid), app.can_view_fees(uuid), app.brand_has_fee_schedule(uuid), app.can_view_fee_version(uuid),
  app.brand_fee_schedule(uuid), app.fee_version_on(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rule validity (one row) and version validity (across rules)
-- ---------------------------------------------------------------------------
-- The same normalisation the engine applies to packaging types: trim, lower case, runs of whitespace/underscores/hyphens → one space.
create function app.normalise_packaging(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(regexp_replace(coalesce(p, ''), '^\s+|\s+$', '', 'g'), '[\s_-]+', ' ', 'g'));
$$;

create function app.fee_decimal_ok(p text, p_scale integer) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and p ~ ('^[0-9]{1,12}(\.[0-9]{1,' || p_scale || '})?$');
$$;

-- Returns the first problem with a rule, or null when it is valid. Pure: cross-rule checks live in app.fee_version_problem.
create function app.fee_rule_problem(r public.fee_rules) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_b jsonb; v_i integer; v_n integer; v_prev numeric; v_up numeric; v_c jsonb; v_d jsonb; v_m jsonb; v_lt jsonb; v_t text; v_min integer; v_max integer;
  v_cats text[] := array['pick_pack', 'packaging', 'kitting', 'labeling', 'receiving', 'storage', 'returns', 'account', 'other'];
begin
  if r.key !~ '^[a-z][a-z0-9_]{0,60}$' then return 'key must be a short slug (letters, digits, underscores)'; end if;
  if char_length(btrim(r.name)) not between 1 and 120 then return 'name must be 1–120 characters'; end if;
  if not (r.category = any (v_cats)) then return 'unknown category'; end if;
  if r.scope = 'order' then
    if r.basis not in ('order', 'unit', 'line', 'sku', 'package', 'shipment', 'shipping_percent', 'order_driver') then return 'basis does not match an order-scope rule'; end if;
  elsif r.scope = 'monthly' then
    if r.basis not in ('month', 'driver', 'minimum') then return 'basis does not match a monthly rule'; end if;
  else
    return 'unknown scope';
  end if;
  if r.method not in ('flat', 'tiered', 'percent', 'minimum') then return 'unknown method'; end if;
  if (r.basis = 'shipping_percent') <> (r.method = 'percent') then return 'the percent method is for percent-of-shipping rules only, and they always use it'; end if;
  if (r.basis = 'minimum') <> (r.method = 'minimum') then return 'the minimum method is for account minimums only, and they always use it'; end if;
  if r.method = 'tiered' and r.basis in ('month', 'shipping_percent', 'minimum') then return 'this basis cannot be tiered'; end if;

  if r.method = 'flat' and r.amount is null then return 'amount is required'; end if;
  if r.method <> 'flat' and r.amount is not null then return 'amount applies to flat rules only'; end if;
  if r.method = 'percent' and r.percent is null then return 'percent is required'; end if;
  if r.method <> 'percent' and r.percent is not null then return 'percent applies to percent-of-shipping rules only'; end if;
  if r.method = 'percent' and r.percent_base is null then return 'choose what the percent is taken of'; end if;
  if r.method <> 'percent' and r.percent_base is not null then return 'percent base applies to percent-of-shipping rules only'; end if;

  if (r.method = 'tiered') <> (r.tiers is not null) then return 'tiers are required for tiered rules and not allowed otherwise'; end if;
  if r.tiers is not null then
    if jsonb_typeof(r.tiers) <> 'object' then return 'tiers must be an object'; end if;
    if exists (select 1 from jsonb_object_keys(r.tiers) k where k not in ('on', 'mode', 'pricing', 'brackets')) then return 'tiers has an unknown field'; end if;
    if coalesce(r.tiers ->> 'on', '') not in ('order_quantity', 'monthly_quantity') then return 'tiers.on must be order_quantity or monthly_quantity'; end if;
    if coalesce(r.tiers ->> 'mode', '') not in ('graduated', 'volume') then return 'tiers.mode must be graduated or volume'; end if;
    if coalesce(r.tiers ->> 'pricing', '') not in ('rate', 'flat') then return 'tiers.pricing must be rate or flat'; end if;
    if r.tiers ->> 'mode' = 'graduated' and r.tiers ->> 'pricing' = 'flat' then return 'graduated tiers are priced per unit'; end if;
    if r.scope = 'monthly' and r.tiers ->> 'on' <> 'monthly_quantity' then return 'monthly rules tier on the monthly quantity'; end if;
    if r.scope = 'order' and r.tiers ->> 'on' = 'monthly_quantity' and (r.basis not in ('order', 'unit', 'package', 'shipment') or r.tiers ->> 'pricing' <> 'rate') then
      return 'monthly-volume tiers apply to per-order, per-item, per-package or per-shipment rules priced per unit';
    end if;
    if jsonb_typeof(r.tiers -> 'brackets') is distinct from 'array' or jsonb_array_length(r.tiers -> 'brackets') not between 1 and 50 then return 'tiers need 1–50 brackets'; end if;
    v_n := jsonb_array_length(r.tiers -> 'brackets'); v_prev := 0;
    for v_i in 0 .. v_n - 1 loop
      v_b := r.tiers -> 'brackets' -> v_i;
      if jsonb_typeof(v_b) <> 'object' or exists (select 1 from jsonb_object_keys(v_b) k where k not in ('upTo', 'amount')) then return 'a bracket has an unknown field'; end if;
      if not app.fee_decimal_ok(v_b ->> 'amount', 4) then return 'bracket amounts must be numbers with up to 4 decimals'; end if;
      if v_i = v_n - 1 then
        if jsonb_typeof(v_b -> 'upTo') is distinct from 'null' then return 'the last bracket must be open-ended (upTo null)'; end if;
      else
        if not app.fee_decimal_ok(v_b ->> 'upTo', 4) then return 'bracket edges must be numbers'; end if;
        v_up := (v_b ->> 'upTo')::numeric;
        if v_up <= v_prev then return 'bracket edges must ascend'; end if;
        v_prev := v_up;
      end if;
    end loop;
    if r.included_quantity is not null then return 'a tiered rule has no free allowance (use a first bracket at 0 instead)'; end if;
  end if;

  if r.included_quantity is not null and (r.scope <> 'order' or r.basis not in ('unit', 'line', 'sku', 'package', 'shipment', 'order_driver')) then
    return 'a free allowance applies to per-item, per-line, per-product, per-package, per-shipment and per-insert rules';
  end if;
  if r.included_per is not null and r.included_quantity is null then return 'includedPer needs an included quantity'; end if;
  if r.minimum_charge is not null and r.basis in ('month', 'minimum', 'shipping_percent') then return 'a minimum charge applies to per-quantity rules only'; end if;

  if r.conditions is not null then
    if r.scope <> 'order' then return 'conditions apply to order rules only'; end if;
    if jsonb_typeof(r.conditions) <> 'object' then return 'conditions must be an object'; end if;
    if exists (select 1 from jsonb_object_keys(r.conditions) k where k not in ('minUnits', 'maxUnits', 'minLines', 'maxLines', 'minPackages', 'maxPackages', 'packagingTypes')) then return 'conditions has an unknown field'; end if;
    foreach v_t in array array['Units', 'Lines', 'Packages'] loop
      if r.conditions ? ('min' || v_t) and (jsonb_typeof(r.conditions -> ('min' || v_t)) <> 'number' or (r.conditions ->> ('min' || v_t)) !~ '^[0-9]{1,9}$') then return 'min' || v_t || ' must be a whole number'; end if;
      if r.conditions ? ('max' || v_t) and (jsonb_typeof(r.conditions -> ('max' || v_t)) <> 'number' or (r.conditions ->> ('max' || v_t)) !~ '^[0-9]{1,9}$') then return 'max' || v_t || ' must be a whole number'; end if;
      if r.conditions ? ('min' || v_t) and r.conditions ? ('max' || v_t) then
        v_min := (r.conditions ->> ('min' || v_t))::integer; v_max := (r.conditions ->> ('max' || v_t))::integer;
        if v_min > v_max then return 'min' || v_t || ' exceeds max' || v_t; end if;
      end if;
    end loop;
    if r.conditions ? 'packagingTypes' then
      if r.basis <> 'package' then return 'packaging types condition applies to per-package rules only'; end if;
      v_c := r.conditions -> 'packagingTypes';
      if jsonb_typeof(v_c) <> 'array' or jsonb_array_length(v_c) not between 1 and 50 then return 'packagingTypes must list 1–50 types'; end if;
      if exists (select 1 from jsonb_array_elements(v_c) e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 60 or (e #>> '{}') <> '*' and app.normalise_packaging(e #>> '{}') <> (e #>> '{}')) then
        return 'packaging types must be normalised (lower case, trimmed, single spaces) or "*"';
      end if;
      if (select count(*) from jsonb_array_elements_text(v_c) e) <> (select count(distinct e) from jsonb_array_elements_text(v_c) e) then return 'packaging types repeat'; end if;
    end if;
  end if;

  if r.exclusive_group is not null then
    if r.scope <> 'order' then return 'exclusive groups apply to order rules only'; end if;
    if r.exclusive_group !~ '^[a-z][a-z0-9_]{0,40}$' then return 'exclusive group must be a short slug'; end if;
    if r.priority is null then return 'a rule in an exclusive group needs a priority'; end if;
  elsif r.priority is not null then
    return 'priority applies to rules in an exclusive group only';
  end if;

  if (r.basis in ('driver', 'order_driver')) <> (r.driver is not null) then return 'driver is required for driver rules and not allowed otherwise'; end if;
  if r.driver is not null then
    v_d := r.driver;
    if jsonb_typeof(v_d) <> 'object' then return 'driver must be an object'; end if;
    if exists (select 1 from jsonb_object_keys(v_d) k where k not in ('key', 'label', 'unit', 'kind', 'billingPeriod', 'longTerm')) then return 'driver has an unknown field'; end if;
    if coalesce(v_d ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,60}$' then return 'driver.key must be a short slug'; end if;
    if char_length(btrim(coalesce(v_d ->> 'label', ''))) not between 1 and 200 then return 'driver.label must be 1–200 characters'; end if;
    if char_length(btrim(coalesce(v_d ->> 'unit', ''))) not between 1 and 40 then return 'driver.unit must be 1–40 characters'; end if;
    if r.basis = 'order_driver' and v_d ->> 'kind' is distinct from 'order_share' then return 'a per-order driver is answered as a share of orders'; end if;
    if r.basis = 'driver' and coalesce(v_d ->> 'kind', '') not in ('monthly_quantity', 'returns_rate') then return 'a monthly driver is a monthly quantity or a returns rate'; end if;
    if v_d ? 'billingPeriod' and (v_d ->> 'kind' <> 'monthly_quantity' or coalesce(v_d ->> 'billingPeriod', '') not in ('month', 'week', 'day')) then return 'billingPeriod must be month, week or day on a monthly quantity'; end if;
    if v_d ? 'longTerm' then
      v_lt := v_d -> 'longTerm';
      if v_d ->> 'kind' <> 'monthly_quantity' or jsonb_typeof(v_lt) <> 'object' then return 'longTerm applies to monthly quantities'; end if;
      if exists (select 1 from jsonb_object_keys(v_lt) k where k not in ('mode', 'replacesRuleKey', 'thresholdDays')) then return 'longTerm has an unknown field'; end if;
      if coalesce(v_lt ->> 'mode', '') not in ('replace', 'surcharge') then return 'longTerm.mode must be replace or surcharge'; end if;
      if coalesce(v_lt ->> 'replacesRuleKey', '') !~ '^[a-z][a-z0-9_]{0,60}$' or v_lt ->> 'replacesRuleKey' = r.key then return 'longTerm.replacesRuleKey must name another rule'; end if;
      if jsonb_typeof(v_lt -> 'thresholdDays') is distinct from 'number' or (v_lt ->> 'thresholdDays') !~ '^[0-9]{1,4}$' or (v_lt ->> 'thresholdDays')::integer not between 1 and 3650 then return 'longTerm.thresholdDays must be 1–3650'; end if;
    end if;
  end if;

  if (r.basis = 'minimum') <> (r.minimum is not null) then return 'minimum is required for account minimums and not allowed otherwise'; end if;
  if r.minimum is not null then
    v_m := r.minimum;
    if jsonb_typeof(v_m) <> 'object' then return 'minimum must be an object'; end if;
    if exists (select 1 from jsonb_object_keys(v_m) k where k not in ('amount', 'appliesTo', 'includesShipping')) then return 'minimum has an unknown field'; end if;
    if not app.fee_decimal_ok(v_m ->> 'amount', 4) then return 'minimum.amount must be a number with up to 4 decimals'; end if;
    if jsonb_typeof(v_m -> 'includesShipping') is distinct from 'boolean' then return 'minimum.includesShipping must be true or false'; end if;
    if jsonb_typeof(v_m -> 'appliesTo') is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_m -> 'appliesTo') k where k not in ('categories', 'includeRuleKeys', 'excludeRuleKeys')) then return 'minimum.appliesTo must list categories, includeRuleKeys and excludeRuleKeys'; end if;
    foreach v_t in array array['categories', 'includeRuleKeys', 'excludeRuleKeys'] loop
      if jsonb_typeof(v_m -> 'appliesTo' -> v_t) is distinct from 'array' then return 'minimum.appliesTo.' || v_t || ' must be a list'; end if;
    end loop;
    if exists (select 1 from jsonb_array_elements_text(v_m -> 'appliesTo' -> 'categories') c where not (c = any (v_cats))) then return 'minimum.appliesTo.categories has an unknown category'; end if;
    if exists (select 1 from jsonb_array_elements_text(v_m -> 'appliesTo' -> 'includeRuleKeys') k where k !~ '^[a-z][a-z0-9_]{0,60}$')
       or exists (select 1 from jsonb_array_elements_text(v_m -> 'appliesTo' -> 'excludeRuleKeys') k where k !~ '^[a-z][a-z0-9_]{0,60}$') then return 'minimum rule keys must be slugs'; end if;
  end if;
  return null;
end $$;

create function app.fee_rule_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_problem text;
begin
  select status into v_status from public.fee_schedule_versions where id = coalesce(new.version_id, old.version_id) for key share;
  if current_setting('app.fees_rpc', true) is distinct from 'on' and v_status is distinct from 'draft' then
    raise exception 'fee schedule version is not a draft; its rules cannot change' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and (new.version_id <> old.version_id or new.tenant_id <> old.tenant_id) then
    raise exception 'a rule cannot move to another version' using errcode = '42501';
  end if;
  if current_setting('app.fees_rpc', true) is distinct from 'on' then new.resolved_rule_keys := null; end if;
  v_problem := app.fee_rule_problem(new);
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
  return new;
end $$;
create trigger fee_rules_guard before insert or update or delete on public.fee_rules for each row execute function app.fee_rule_guard();

create function app.guard_fee_children() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_version uuid;
begin
  if tg_table_name = 'fee_rule_sources' then
    select r.version_id into v_version from public.fee_rules r where r.id = coalesce(new.rule_id, old.rule_id);
  else
    v_version := coalesce(new.version_id, old.version_id);
  end if;
  select status into v_status from public.fee_schedule_versions where id = v_version for key share;
  if current_setting('app.fees_rpc', true) is distinct from 'on' and v_status is distinct from 'draft' then
    raise exception 'fee schedule version is not a draft; its notes and sources cannot change' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' then new.updated_by := (select auth.uid()); new.updated_at := now(); end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger fee_rule_sources_guard before insert or update or delete on public.fee_rule_sources for each row execute function app.guard_fee_children();
create trigger fsv_notes_guard before insert or update or delete on public.fee_schedule_version_notes for each row execute function app.guard_fee_children();

create function app.guard_fee_version_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.schedule_id <> old.schedule_id or new.tenant_id <> old.tenant_id or new.version_number <> old.version_number then
    raise exception 'version identity columns are immutable' using errcode = '42501';
  end if;
  if old.status in ('archived', 'discarded') and new.status <> old.status then
    raise exception 'an archived or discarded version cannot change status' using errcode = '42501';
  end if;
  if current_setting('app.fees_rpc', true) is distinct from 'on' then
    if old.status <> 'draft' or new.status <> 'draft' then raise exception 'use the lifecycle functions to activate, end or archive a version' using errcode = '42501'; end if;
    if new.effective_date is distinct from old.effective_date or new.expiration_date is distinct from old.expiration_date or new.rule_count <> old.rule_count
       or new.activated_at is distinct from old.activated_at or new.activated_by is distinct from old.activated_by then
      raise exception 'only the rounding of a draft can be edited directly' using errcode = '42501';
    end if;
  end if;
  if old.status = 'active' and new.status = 'active' and (new.rounding <> old.rounding or new.effective_date <> old.effective_date) then
    raise exception 'an active version only changes its expiration date' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fsv_guard before update on public.fee_schedule_versions for each row execute function app.guard_fee_version_update();

create function app.guard_fee_schedule_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id <> old.tenant_id then raise exception 'a fee schedule cannot move between tenants' using errcode = '42501'; end if;
  if new.status <> old.status and current_setting('app.fees_rpc', true) is distinct from 'on' then
    raise exception 'use archive_fee_schedule to archive a schedule' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fee_schedules_guard before update on public.fee_schedules for each row execute function app.guard_fee_schedule_update();

-- Cross-rule validity of a version; also resolves every minimum's rule set. Returns the first problem or null.
create function app.fee_version_problem(p_version uuid, p_resolve boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer; v_min integer; r record; v_keys text[]; v_set text[]; v_seen text[] := '{}'; v_rep record; v_prob text; v_fr public.fee_rules%rowtype;
begin
  select count(*) into v_count from public.fee_rules where version_id = p_version;
  if v_count = 0 then return 'a version needs at least one rule'; end if;
  select array_agg(key) into v_keys from public.fee_rules where version_id = p_version;

  -- Minimums: at most three, every referenced key exists, resolved sets pairwise disjoint.
  select count(*) into v_min from public.fee_rules where version_id = p_version and basis = 'minimum';
  if v_min > 3 then return 'a version may carry at most three account minimums'; end if;
  for r in select * from public.fee_rules where version_id = p_version and basis = 'minimum' order by position, key loop
    if exists (select 1 from jsonb_array_elements_text(r.minimum -> 'appliesTo' -> 'includeRuleKeys') k where not (k = any (v_keys)))
       or exists (select 1 from jsonb_array_elements_text(r.minimum -> 'appliesTo' -> 'excludeRuleKeys') k where not (k = any (v_keys))) then
      return 'minimum "' || r.name || '" names a rule that is not in this version';
    end if;
    select coalesce(array_agg(x.key order by x.position, x.key), '{}') into v_set
    from public.fee_rules x
    where x.version_id = p_version and x.basis not in ('minimum', 'month')
      and (jsonb_array_length(r.minimum -> 'appliesTo' -> 'categories') = 0 or x.category in (select c from jsonb_array_elements_text(r.minimum -> 'appliesTo' -> 'categories') c)
           or x.key in (select k from jsonb_array_elements_text(r.minimum -> 'appliesTo' -> 'includeRuleKeys') k))
      and x.key not in (select k from jsonb_array_elements_text(r.minimum -> 'appliesTo' -> 'excludeRuleKeys') k);
    if exists (select 1 from public.fee_rules x where x.version_id = p_version and x.basis in ('minimum', 'month')
               and x.key in (select k from jsonb_array_elements_text(r.minimum -> 'appliesTo' -> 'includeRuleKeys') k)) then
      return 'minimum "' || r.name || '" cannot count a flat monthly charge or another minimum';
    end if;
    if coalesce(array_length(v_set, 1), 0) = 0 then return 'minimum "' || r.name || '" counts no rule'; end if;
    if exists (select 1 from unnest(v_set) k where k = any (v_seen)) then return 'two account minimums count the same rule (' || r.name || ')'; end if;
    v_seen := v_seen || v_set;
    if p_resolve then update public.fee_rules set resolved_rule_keys = v_set where id = r.id; end if;
  end loop;

  -- Long-term storage references a standard monthly-quantity rule with the same unit.
  for r in select * from public.fee_rules where version_id = p_version and driver ? 'longTerm' loop
    select * into v_rep from public.fee_rules x where x.version_id = p_version and x.key = r.driver #>> '{longTerm,replacesRuleKey}';
    if not found then return 'long-term rule "' || r.name || '" refers to a rule that is not in this version'; end if;
    if v_rep.basis <> 'driver' or v_rep.driver ->> 'kind' <> 'monthly_quantity' or v_rep.driver ? 'longTerm' then return 'long-term rule "' || r.name || '" must refer to a standard monthly-quantity rule'; end if;
    if v_rep.driver ->> 'unit' is distinct from r.driver ->> 'unit' or v_rep.driver ->> 'billingPeriod' is distinct from r.driver ->> 'billingPeriod' then
      return 'long-term rule "' || r.name || '" must use the unit and billing period of the rule it refers to';
    end if;
  end loop;

  -- Exclusive groups: one basis per group, distinct priorities.
  if exists (select 1 from public.fee_rules where version_id = p_version and exclusive_group is not null group by exclusive_group having count(distinct basis) > 1) then
    return 'rules in one exclusive group must share a basis';
  end if;
  if exists (select 1 from public.fee_rules where version_id = p_version and exclusive_group is not null group by exclusive_group, priority having count(*) > 1) then
    return 'rules in one exclusive group need distinct priorities';
  end if;

  -- Packaging types: a type priced by two rules must be in one exclusive group (priority decides), never ambiguous.
  if exists (
    select 1
    from public.fee_rules a join public.fee_rules b on b.version_id = a.version_id and b.id > a.id
    where a.version_id = p_version and a.conditions ? 'packagingTypes' and b.conditions ? 'packagingTypes'
      and (a.exclusive_group is null or a.exclusive_group is distinct from b.exclusive_group)
      and exists (select 1 from jsonb_array_elements_text(a.conditions -> 'packagingTypes') t where t in (select u from jsonb_array_elements_text(b.conditions -> 'packagingTypes') u))) then
    return 'two packaging rules price the same packaging type; put them in one exclusive group';
  end if;

  -- One question per driver key: rules sharing a key ask it the same way.
  if exists (select 1 from public.fee_rules where version_id = p_version and driver is not null
             group by driver ->> 'key' having count(distinct driver ->> 'kind') > 1 or count(distinct coalesce(driver ->> 'billingPeriod', 'month')) > 1 or count(distinct driver ->> 'unit') > 1) then
    return 'rules that share a driver key must ask the same question (kind, unit, billing period)';
  end if;
  -- Every rule is individually valid (belt and braces: the row trigger already checked).
  for v_fr in select * from public.fee_rules where version_id = p_version loop
    v_prob := app.fee_rule_problem(v_fr);
    if v_prob is not null then return '"' || v_fr.name || '": ' || v_prob; end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Audit (trigger-only 'ratecard.' namespace: rate cards and fee schedules)
-- ---------------------------------------------------------------------------
create function app.audit_fees() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'fee_schedules' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, null, 'ratecard.fee_schedule_created', 'fee_schedule', new.id::text, jsonb_build_object('name', new.name));
    elsif new.status is distinct from old.status or new.name is distinct from old.name then
      perform app.write_audit(new.tenant_id, null, 'ratecard.fee_schedule_updated', 'fee_schedule', new.id::text,
        jsonb_build_object('name', new.name, 'status_from', old.status, 'status_to', new.status));
    end if;
  elsif tg_table_name = 'fee_schedule_versions' then
    if tg_op = 'UPDATE' and new.status = old.status and new.expiration_date is distinct from old.expiration_date then
      perform app.write_audit(new.tenant_id, null, 'ratecard.fee_version_ended', 'fee_schedule_version', new.id::text,
        jsonb_build_object('schedule_id', new.schedule_id, 'version', new.version_number, 'expiration_date', new.expiration_date));
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform app.write_audit(new.tenant_id, null, 'ratecard.fee_version_' || new.status, 'fee_schedule_version', new.id::text,
        jsonb_build_object('schedule_id', new.schedule_id, 'version', new.version_number, 'effective_date', new.effective_date, 'expiration_date', new.expiration_date, 'rule_count', new.rule_count));
    end if;
  elsif tg_table_name = 'brand_fee_schedule_assignments' then
    if tg_op = 'INSERT' then
      perform app.write_audit(new.tenant_id, new.brand_id, 'ratecard.fee_assigned', 'fee_schedule', new.schedule_id::text, '{}'::jsonb);
    elsif new.unassigned_at is not null and old.unassigned_at is null then
      perform app.write_audit(new.tenant_id, new.brand_id, 'ratecard.fee_unassigned', 'fee_schedule', new.schedule_id::text, '{}'::jsonb);
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger fee_schedules_audit after insert or update on public.fee_schedules for each row execute function app.audit_fees();
create trigger fsv_audit after update on public.fee_schedule_versions for each row execute function app.audit_fees();
create trigger bfsa_audit after insert or update on public.brand_fee_schedule_assignments for each row execute function app.audit_fees();

update public.permissions set description = 'View rate cards and fee schedules.' where key = 'ratecard.view';
update public.permissions set description = 'Upload, author, activate and assign rate cards and fee schedules.' where key = 'ratecard.manage';

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.fee_schedules enable row level security;
alter table public.fee_schedule_versions enable row level security;
alter table public.fee_rules enable row level security;
alter table public.fee_rule_sources enable row level security;
alter table public.fee_schedule_version_notes enable row level security;
alter table public.brand_fee_schedule_assignments enable row level security;

create policy fee_schedules_read on public.fee_schedules for select to authenticated
  using (app.can_view_fees(tenant_id) or app.brand_has_fee_schedule(id));
create policy fee_schedules_update on public.fee_schedules for update to authenticated
  using (app.can_manage_fees(tenant_id)) with check (app.can_manage_fees(tenant_id));

create policy fsv_read on public.fee_schedule_versions for select to authenticated
  using (app.can_view_fees(tenant_id) or (status in ('active', 'archived') and app.brand_has_fee_schedule(schedule_id)));
create policy fsv_update on public.fee_schedule_versions for update to authenticated
  using (app.can_manage_fees(tenant_id) and status = 'draft') with check (app.can_manage_fees(tenant_id));

create policy fee_rules_read on public.fee_rules for select to authenticated
  using (app.can_view_fees(tenant_id) or app.can_view_fee_version(version_id));
create policy fee_rules_write on public.fee_rules for all to authenticated
  using (app.can_manage_fees(tenant_id)) with check (app.can_manage_fees(tenant_id));

-- Staff only: brands have no policy on sources or notes at all.
create policy fee_rule_sources_read on public.fee_rule_sources for select to authenticated using (app.can_view_fees(tenant_id));
create policy fee_rule_sources_write on public.fee_rule_sources for all to authenticated
  using (app.can_manage_fees(tenant_id)) with check (app.can_manage_fees(tenant_id) and exists (select 1 from public.fee_rules r where r.id = rule_id and r.tenant_id = fee_rule_sources.tenant_id));
create policy fsv_notes_read on public.fee_schedule_version_notes for select to authenticated using (app.can_view_fees(tenant_id));
create policy fsv_notes_write on public.fee_schedule_version_notes for all to authenticated
  using (app.can_manage_fees(tenant_id)) with check (app.can_manage_fees(tenant_id) and exists (select 1 from public.fee_schedule_versions v where v.id = version_id and v.tenant_id = fee_schedule_version_notes.tenant_id));

create policy bfsa_read on public.brand_fee_schedule_assignments for select to authenticated
  using (app.can_view_fees(tenant_id) or app.has_brand_permission(brand_id, 'brand.view'));

grant select on public.fee_schedules, public.fee_schedule_versions, public.fee_rules, public.fee_rule_sources, public.fee_schedule_version_notes, public.brand_fee_schedule_assignments to authenticated;
grant update (name, description) on public.fee_schedules to authenticated;
grant update (rounding) on public.fee_schedule_versions to authenticated;
grant insert (version_id, tenant_id, position, key, name, category, scope, basis, method, amount, percent, percent_base, tiers, included_quantity, included_per, minimum_charge, conditions, exclusive_group, priority, driver, minimum, description, help_text),
      update (position, key, name, category, scope, basis, method, amount, percent, percent_base, tiers, included_quantity, included_per, minimum_charge, conditions, exclusive_group, priority, driver, minimum, description, help_text),
      delete on public.fee_rules to authenticated;
grant insert (rule_id, tenant_id, source_reference), update (source_reference), delete on public.fee_rule_sources to authenticated;
grant insert (version_id, tenant_id, notes), update (notes), delete on public.fee_schedule_version_notes to authenticated;
grant all on public.fee_schedules, public.fee_schedule_versions, public.fee_rules, public.fee_rule_sources, public.fee_schedule_version_notes, public.brand_fee_schedule_assignments to service_role;

-- ---------------------------------------------------------------------------
-- Fee schedule lifecycle functions
-- ---------------------------------------------------------------------------
-- Creates a schedule with an empty draft version 1. Returns {scheduleId, versionId}.
create function public.create_fee_schedule(p_tenant uuid, p_name text, p_description text default null, p_rounding text default 'invoice_line') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_s uuid; v_v uuid;
begin
  if not app.can_manage_fees(p_tenant) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_rounding not in ('invoice_line', 'transaction') then raise exception 'rounding must be invoice_line or transaction' using errcode = '22023'; end if;
  insert into public.fee_schedules (tenant_id, name, description) values (p_tenant, btrim(p_name), nullif(btrim(coalesce(p_description, '')), '')) returning id into v_s;
  insert into public.fee_schedule_versions (schedule_id, tenant_id, version_number, rounding) values (v_s, p_tenant, 1, p_rounding) returning id into v_v;
  return jsonb_build_object('scheduleId', v_s, 'versionId', v_v);
end $$;

-- A new draft of a schedule, empty or copied from an existing version (rules keep their keys, get new ids; sources and notes copied).
create function public.copy_fee_schedule_version(p_schedule uuid, p_from_version uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_s public.fee_schedules%rowtype; v_from public.fee_schedule_versions%rowtype; v_n integer; v_v uuid; v_rounding text := 'invoice_line';
begin
  select * into v_s from public.fee_schedules where id = p_schedule for update;
  if not found or not app.can_manage_fees(v_s.tenant_id) then raise exception 'fee schedule not found' using errcode = 'P0002'; end if;
  if v_s.status <> 'active' then raise exception 'an archived schedule cannot get new versions' using errcode = 'P0001'; end if;
  if exists (select 1 from public.fee_schedule_versions where schedule_id = p_schedule and status = 'draft') then raise exception 'this schedule already has a draft' using errcode = 'P0001'; end if;
  if p_from_version is not null then
    select * into v_from from public.fee_schedule_versions where id = p_from_version and schedule_id = p_schedule;
    if not found then raise exception 'version not found' using errcode = 'P0002'; end if;
    v_rounding := v_from.rounding;
  end if;
  select coalesce(max(version_number), 0) + 1 into v_n from public.fee_schedule_versions where schedule_id = p_schedule;
  insert into public.fee_schedule_versions (schedule_id, tenant_id, version_number, rounding) values (p_schedule, v_s.tenant_id, v_n, v_rounding) returning id into v_v;
  if p_from_version is not null then
    perform set_config('app.fees_rpc', 'on', true);
    insert into public.fee_rules (version_id, tenant_id, position, key, name, category, scope, basis, method, amount, percent, percent_base, tiers, included_quantity, included_per, minimum_charge, conditions, exclusive_group, priority, driver, minimum, description, help_text)
    select v_v, tenant_id, position, key, name, category, scope, basis, method, amount, percent, percent_base, tiers, included_quantity, included_per, minimum_charge, conditions, exclusive_group, priority, driver, minimum, description, help_text
    from public.fee_rules where version_id = p_from_version;
    insert into public.fee_rule_sources (rule_id, tenant_id, source_reference)
    select n.id, s.tenant_id, s.source_reference
    from public.fee_rule_sources s join public.fee_rules o on o.id = s.rule_id and o.version_id = p_from_version
    join public.fee_rules n on n.version_id = v_v and n.key = o.key;
    insert into public.fee_schedule_version_notes (version_id, tenant_id, notes)
    select v_v, tenant_id, notes from public.fee_schedule_version_notes where version_id = p_from_version;
    perform set_config('app.fees_rpc', 'off', true);
  end if;
  return v_v;
end $$;

-- Reorders the rules of a draft: p_rule_ids lists every rule of the version in the new order.
create function public.reorder_fee_rules(p_version uuid, p_rule_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.fee_schedule_versions%rowtype; v_n integer;
begin
  select * into v from public.fee_schedule_versions where id = p_version for update;
  if not found or not app.can_manage_fees(v.tenant_id) then raise exception 'version not found' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'only a draft can be reordered' using errcode = 'P0001'; end if;
  select count(*) into v_n from public.fee_rules where version_id = p_version;
  if v_n <> coalesce(array_length(p_rule_ids, 1), 0) or (select count(distinct x) from unnest(p_rule_ids) x) <> v_n
     or exists (select 1 from unnest(p_rule_ids) x where not exists (select 1 from public.fee_rules r where r.id = x and r.version_id = p_version)) then
    raise exception 'the list must name every rule of the version exactly once' using errcode = '22023';
  end if;
  update public.fee_rules r set position = x.ord - 1 from unnest(p_rule_ids) with ordinality as x(id, ord) where r.id = x.id;
end $$;

create function public.activate_fee_schedule_version(p_version uuid, p_effective date, p_expiration date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.fee_schedule_versions%rowtype; v_rows integer; v_problem text;
begin
  select * into v from public.fee_schedule_versions where id = p_version for update;
  if not found or not app.can_manage_fees(v.tenant_id) then raise exception 'version not found' using errcode = 'P0003'; end if;
  if v.status <> 'draft' then raise exception 'only a draft version can be activated' using errcode = 'P0004'; end if;
  if p_effective is null then raise exception 'effective date is required' using errcode = '22023'; end if;
  if p_expiration is not null and p_expiration < p_effective then raise exception 'expiration must not precede effective date' using errcode = '22023'; end if;
  perform set_config('app.fees_rpc', 'on', true);
  v_problem := app.fee_version_problem(p_version, true);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0005'; end if;
  select count(*) into v_rows from public.fee_rules where version_id = p_version;
  begin
    update public.fee_schedule_versions
       set status = 'active', effective_date = p_effective, expiration_date = p_expiration, rule_count = v_rows, activated_at = now(), activated_by = (select auth.uid())
     where id = p_version;
  exception when exclusion_violation then
    raise exception 'another active version of this fee schedule already covers those dates' using errcode = 'P0007';
  end;
  perform set_config('app.fees_rpc', 'off', true);
end $$;

create function public.end_fee_schedule_version(p_version uuid, p_expiration date) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.fee_schedule_versions%rowtype;
begin
  select * into v from public.fee_schedule_versions where id = p_version for update;
  if not found or not app.can_manage_fees(v.tenant_id) then raise exception 'version not found' using errcode = 'P0003'; end if;
  if v.status <> 'active' then raise exception 'only an active version can be ended' using errcode = 'P0004'; end if;
  if p_expiration is null or p_expiration < v.effective_date then raise exception 'expiration must not precede effective date' using errcode = '22023'; end if;
  perform set_config('app.fees_rpc', 'on', true);
  update public.fee_schedule_versions set expiration_date = p_expiration where id = p_version;
  perform set_config('app.fees_rpc', 'off', true);
end $$;

create function public.archive_fee_schedule_version(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.fee_schedule_versions%rowtype;
begin
  select * into v from public.fee_schedule_versions where id = p_version for update;
  if not found or not app.can_manage_fees(v.tenant_id) then raise exception 'version not found' using errcode = 'P0003'; end if;
  perform set_config('app.fees_rpc', 'on', true);
  if v.status = 'active' then
    update public.fee_schedule_versions set status = 'archived' where id = p_version;
  elsif v.status = 'draft' then
    update public.fee_schedule_versions set status = 'discarded' where id = p_version;
  else
    raise exception 'version is already closed' using errcode = 'P0004';
  end if;
  perform set_config('app.fees_rpc', 'off', true);
end $$;

-- Archives a schedule nobody is on any more; its versions stay readable for history.
create function public.archive_fee_schedule(p_schedule uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.fee_schedules%rowtype;
begin
  select * into v_s from public.fee_schedules where id = p_schedule for update;
  if not found or not app.can_manage_fees(v_s.tenant_id) then raise exception 'fee schedule not found' using errcode = 'P0002'; end if;
  if v_s.status = 'archived' then return; end if;
  if exists (select 1 from public.brand_fee_schedule_assignments a where a.schedule_id = p_schedule and a.unassigned_at is null) then
    raise exception 'customers are still on this fee schedule; move them first' using errcode = 'P0001';
  end if;
  perform set_config('app.fees_rpc', 'on', true);
  update public.fee_schedules set status = 'archived' where id = p_schedule;
  update public.fee_schedule_versions set status = 'discarded' where schedule_id = p_schedule and status = 'draft';
  perform set_config('app.fees_rpc', 'off', true);
end $$;

-- Puts a brand on a schedule (ending its current one in the same transaction). Returns the assignment id.
create function public.assign_fee_schedule(p_brand uuid, p_schedule uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_s public.fee_schedules%rowtype; v_existing public.brand_fee_schedule_assignments%rowtype; v_id uuid;
begin
  select tenant_id into v_tenant from public.brands where id = p_brand;
  if v_tenant is null or not app.can_manage_fees(v_tenant) then raise exception 'customer not found' using errcode = 'P0002'; end if;
  select * into v_s from public.fee_schedules where id = p_schedule;
  if not found or v_s.tenant_id <> v_tenant then raise exception 'fee schedule not found' using errcode = 'P0002'; end if;
  if v_s.status <> 'active' then raise exception 'an archived schedule cannot be assigned' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.fee_schedule_versions v where v.schedule_id = p_schedule and v.status = 'active') then
    raise exception 'activate a version of this schedule before assigning it' using errcode = 'P0001';
  end if;
  select * into v_existing from public.brand_fee_schedule_assignments where brand_id = p_brand and unassigned_at is null for update;
  if found then
    if v_existing.schedule_id = p_schedule then return v_existing.id; end if;
    update public.brand_fee_schedule_assignments set unassigned_at = now(), unassigned_by = (select auth.uid()) where id = v_existing.id;
  end if;
  insert into public.brand_fee_schedule_assignments (tenant_id, brand_id, schedule_id) values (v_tenant, p_brand, p_schedule) returning id into v_id;
  return v_id;
end $$;

create function public.unassign_fee_schedule(p_assignment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.brand_fee_schedule_assignments%rowtype;
begin
  select * into a from public.brand_fee_schedule_assignments where id = p_assignment for update;
  if not found or not app.can_manage_fees(a.tenant_id) then raise exception 'assignment not found' using errcode = 'P0002'; end if;
  if a.unassigned_at is not null then return; end if;
  update public.brand_fee_schedule_assignments set unassigned_at = now(), unassigned_by = (select auth.uid()) where id = p_assignment;
end $$;

-- The engine's FeeScheduleSnapshot for a version. Customer-safe by construction: never carries sources or notes.
create function public.fee_schedule_snapshot(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.fee_schedule_versions%rowtype; v_name text; v_rules jsonb;
begin
  select * into v from public.fee_schedule_versions where id = p_version;
  if not found or not app.can_view_fee_version(p_version) then raise exception 'fee schedule version not found' using errcode = 'P0002'; end if;
  select name into v_name from public.fee_schedules where id = v.schedule_id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', r.id, 'key', r.key, 'name', r.name, 'category', r.category, 'scope', r.scope, 'basis', r.basis, 'method', r.method,
      'amount', r.amount::text, 'percent', r.percent::text, 'percentBase', r.percent_base, 'tiers', r.tiers,
      'includedQuantity', r.included_quantity::text, 'includedPer', r.included_per, 'minimumCharge', r.minimum_charge::text,
      'conditions', r.conditions, 'exclusiveGroup', r.exclusive_group, 'priority', r.priority, 'driver', r.driver, 'minimum', r.minimum,
      'resolvedRuleKeys', to_jsonb(r.resolved_rule_keys), 'description', r.description, 'helpText', r.help_text, 'position', r.position
    )) order by r.position, r.key), '[]'::jsonb)
  into v_rules from public.fee_rules r where r.version_id = p_version;
  return jsonb_build_object('scheduleId', v.schedule_id, 'name', v_name, 'versionId', v.id, 'versionNumber', v.version_number,
                            'effectiveDate', v.effective_date, 'expirationDate', v.expiration_date, 'rounding', v.rounding, 'rules', v_rules);
end $$;

-- The version of the brand's schedule in effect on a date, as a snapshot (null when none). Authorised like the snapshot.
create function public.brand_fee_schedule_on(p_brand uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tenant uuid; v_schedule uuid; v_version uuid;
begin
  select tenant_id into v_tenant from public.brands where id = p_brand;
  if v_tenant is null or not app.can_model_brand(v_tenant, p_brand) then raise exception 'customer not found' using errcode = 'P0002'; end if;
  v_schedule := app.brand_fee_schedule(p_brand);
  if v_schedule is null then return jsonb_build_object('status', 'no_schedule'); end if;
  v_version := app.fee_version_on(v_schedule, p_date);
  if v_version is null then
    return jsonb_build_object('status', 'not_effective', 'scheduleId', v_schedule, 'name', (select name from public.fee_schedules where id = v_schedule));
  end if;
  return jsonb_build_object('status', 'ok', 'snapshot', public.fee_schedule_snapshot(v_version));
end $$;

revoke all on function public.create_fee_schedule(uuid, text, text, text), public.copy_fee_schedule_version(uuid, uuid), public.reorder_fee_rules(uuid, uuid[]),
  public.activate_fee_schedule_version(uuid, date, date), public.end_fee_schedule_version(uuid, date), public.archive_fee_schedule_version(uuid),
  public.archive_fee_schedule(uuid), public.assign_fee_schedule(uuid, uuid), public.unassign_fee_schedule(uuid),
  public.fee_schedule_snapshot(uuid), public.brand_fee_schedule_on(uuid, date) from public, anon;
grant execute on function public.create_fee_schedule(uuid, text, text, text), public.copy_fee_schedule_version(uuid, uuid), public.reorder_fee_rules(uuid, uuid[]),
  public.activate_fee_schedule_version(uuid, date, date), public.end_fee_schedule_version(uuid, date), public.archive_fee_schedule_version(uuid),
  public.archive_fee_schedule(uuid), public.assign_fee_schedule(uuid, uuid), public.unassign_fee_schedule(uuid),
  public.fee_schedule_snapshot(uuid), public.brand_fee_schedule_on(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Fee arithmetic in SQL (mirrors src/engine/fees; golden-tested against it)
-- ---------------------------------------------------------------------------
-- Tier amount in dollars for a quantity (RULES.md A4): graduated sums each bracket; volume prices the whole quantity in its bracket.
create function app.fee_tier_amount(p_tiers jsonb, p_quantity numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v_total numeric := 0; v_lower numeric := 0; v_upper numeric; v_b jsonb; v_i integer; v_n integer;
begin
  if p_quantity is null or p_quantity <= 0 then return 0; end if;
  v_n := jsonb_array_length(p_tiers -> 'brackets');
  if p_tiers ->> 'mode' = 'graduated' then
    for v_i in 0 .. v_n - 1 loop
      v_b := p_tiers -> 'brackets' -> v_i;
      v_upper := case when jsonb_typeof(v_b -> 'upTo') = 'null' then p_quantity else (v_b ->> 'upTo')::numeric end;
      if least(p_quantity, v_upper) - v_lower > 0 then v_total := v_total + (least(p_quantity, v_upper) - v_lower) * (v_b ->> 'amount')::numeric; end if;
      exit when jsonb_typeof(v_b -> 'upTo') = 'null' or p_quantity <= v_upper;
      v_lower := v_upper;
    end loop;
    return v_total;
  end if;
  for v_i in 0 .. v_n - 1 loop
    v_b := p_tiers -> 'brackets' -> v_i;
    if jsonb_typeof(v_b -> 'upTo') = 'null' or p_quantity <= (v_b ->> 'upTo')::numeric then
      return case when p_tiers ->> 'pricing' = 'flat' then (v_b ->> 'amount')::numeric else p_quantity * (v_b ->> 'amount')::numeric end;
    end if;
  end loop;
  v_b := p_tiers -> 'brackets' -> (v_n - 1);
  return case when p_tiers ->> 'pricing' = 'flat' then (v_b ->> 'amount')::numeric else p_quantity * (v_b ->> 'amount')::numeric end;
end $$;

-- Effective per-unit rate of a monthly-quantity tier at a month's quantity (RULES.md E), 4 dp; null when the quantity is unknown or 0.
create function app.fee_resolve_rate(p_tiers jsonb, p_quantity numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v_b jsonb; v_i integer;
begin
  if p_quantity is null or p_quantity <= 0 then return null; end if;
  if p_tiers ->> 'mode' = 'graduated' then return round(app.fee_tier_amount(p_tiers, p_quantity) / p_quantity, 4); end if;
  for v_i in 0 .. jsonb_array_length(p_tiers -> 'brackets') - 1 loop
    v_b := p_tiers -> 'brackets' -> v_i;
    if jsonb_typeof(v_b -> 'upTo') = 'null' or p_quantity <= (v_b ->> 'upTo')::numeric then return (v_b ->> 'amount')::numeric; end if;
  end loop;
  return (p_tiers -> 'brackets' -> (jsonb_array_length(p_tiers -> 'brackets') - 1) ->> 'amount')::numeric;
end $$;

-- Amount of a flat/tiered rule for a chargeable quantity, with the per-occurrence minimum charge, 4 dp.
create function app.fee_line_amount(r public.fee_rules, p_quantity numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if r.method = 'tiered' then v := app.fee_tier_amount(r.tiers, p_quantity); else v := p_quantity * coalesce(r.amount, 0); end if;
  if r.minimum_charge is not null and p_quantity > 0 and v < r.minimum_charge then v := r.minimum_charge; end if;
  return round(v, 4);
end $$;

-- The monthly lines of a version from the customer's answers (RULES.md B): one row per monthly rule, priced or not modeled.
create function app.fee_monthly_lines(p_version uuid, p_answers jsonb, p_monthly_orders numeric)
returns table (rule_id uuid, rule_key text, driver_key text, quantity numeric, amount numeric, status text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare r public.fee_rules%rowtype; v_answer text; v_q numeric; v_sub numeric; v_rep record;
begin
  for r in select * from public.fee_rules x where x.version_id = p_version and x.scope = 'monthly' and x.basis <> 'minimum' order by x.position, x.key loop
    if r.basis = 'month' then
      rule_id := r.id; rule_key := r.key; driver_key := null; quantity := 1; amount := round(coalesce(r.amount, 0), 4); status := 'priced'; reason := null;
      return next; continue;
    end if;
    rule_id := r.id; rule_key := r.key; driver_key := r.driver ->> 'key'; quantity := null; amount := null; status := 'not_modeled'; reason := null;
    v_answer := p_answers #>> array['drivers', r.driver ->> 'key'];
    if v_answer is null then reason := 'no_answer'; return next; continue; end if;
    if r.driver ->> 'kind' = 'returns_rate' then
      if p_monthly_orders is null then reason := 'volume_unknown'; return next; continue; end if;
      v_q := p_monthly_orders * v_answer::numeric / 100;
    else
      v_q := v_answer::numeric;
      if r.driver ? 'longTerm' then
        select * into v_rep from public.fee_rules x where x.version_id = p_version and x.key = r.driver #>> '{longTerm,replacesRuleKey}';
        if not found then reason := 'replaced_rule_missing'; return next; continue; end if;
      end if;
      -- Long-term "replace" rules take their quantity out of the standard rule they refer to.
      select coalesce(sum((p_answers #>> array['drivers', x.driver ->> 'key'])::numeric), 0) into v_sub
      from public.fee_rules x where x.version_id = p_version and x.driver #>> '{longTerm,mode}' = 'replace' and x.driver #>> '{longTerm,replacesRuleKey}' = r.key
        and p_answers #>> array['drivers', x.driver ->> 'key'] is not null;
      v_q := greatest(0, v_q - v_sub);
      if r.driver ->> 'billingPeriod' = 'week' then v_q := v_q * 30.4375 / 7;
      elsif r.driver ->> 'billingPeriod' = 'day' then v_q := v_q * 30.4375; end if;
    end if;
    quantity := v_q; amount := app.fee_line_amount(r, v_q); status := 'priced';
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Forecast period and volume of an orders file (design §5), computed once here and stored on the run.
-- ---------------------------------------------------------------------------
-- Population = non-cancelled orders with ≥ 1 shipment; date = order date, else first ship date. Period = 1st–99th
-- percentile of dates; months = Σ over calendar months touched of covered days / days in month (6 dp).
create function app.dataset_period(p_dataset uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with pop as (
    select o.id, o.units, coalesce(o.order_date, s.first_ship) as d, s.n as nship, s.npkg
    from public.orders o
    join lateral (
      select min(x.ship_date) as first_ship, count(*) as n,
             (select count(*) from public.packages p join public.shipments y on y.id = p.shipment_id where y.order_id = o.id) as npkg
      from public.shipments x where x.order_id = o.id
    ) s on s.n > 0
    where o.dataset_id = p_dataset and not o.cancelled
  ),
  bounds as (
    select count(*) as population, count(d) as dated,
           percentile_disc(0.01) within group (order by d) filter (where d is not null) as dfrom,
           percentile_disc(0.99) within group (order by d) filter (where d is not null) as dto
    from pop
  ),
  inp as (
    select count(*) as in_period, sum(p.units) as units, count(*) filter (where p.units is null) as units_null, coalesce(sum(p.npkg), 0) as pkgs, coalesce(sum(p.nship), 0) as ships
    from pop p, bounds b where p.d between b.dfrom and b.dto
  ),
  months as (
    select m::date as mstart, (m + interval '1 month - 1 day')::date as mend
    from bounds b, generate_series(date_trunc('month', b.dfrom), date_trunc('month', b.dto), interval '1 month') m
    where b.dfrom is not null
  ),
  prof as (
    select mstart,
           round((least(b.dto, mend) - greatest(b.dfrom, mstart) + 1)::numeric / extract(day from mend)::numeric, 6) as fraction,
           (select count(*) from pop p where p.d between greatest(b.dfrom, mstart) and least(b.dto, mend)) as orders
    from months, bounds b
  ),
  agg as (
    select coalesce(sum(fraction), 0) as months,
           coalesce(jsonb_agg(jsonb_build_object('month', to_char(mstart, 'YYYY-MM'), 'fraction', fraction::text, 'orders', orders) order by mstart), '[]'::jsonb) as profile
    from prof
  )
  select jsonb_build_object(
    'population', b.population, 'dated', b.dated, 'undated', b.population - b.dated, 'from', b.dfrom, 'to', b.dto,
    'days', case when b.dfrom is null then null else b.dto - b.dfrom + 1 end,
    'months', case when b.dfrom is null then null else a.months end,
    'inPeriod', i.in_period, 'trimmed', b.dated - i.in_period,
    'units', case when i.units_null > 0 then null else coalesce(i.units, 0) end,
    'packages', i.pkgs, 'shipments', i.ships, 'monthProfile', a.profile)
  from bounds b, inp i, agg a;
$$;

-- Same figures for the run form (shown before the run starts, so the customer can confirm or state a volume).
create function public.dataset_forecast_period(p_dataset uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_ds public.order_datasets%rowtype;
begin
  select * into v_ds from public.order_datasets where id = p_dataset;
  if not found or not app.can_model_brand(v_ds.tenant_id, v_ds.brand_id) or not app.modeling_visible(v_ds.tenant_id, v_ds.shared_with_brand) then raise exception 'dataset not found' using errcode = 'P0002'; end if;
  return app.dataset_period(p_dataset);
end $$;
revoke all on function public.dataset_forecast_period(uuid) from public, anon;
grant execute on function public.dataset_forecast_period(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Runs: schema changes
-- ---------------------------------------------------------------------------
alter table public.simulation_projects drop constraint simulation_projects_kind_check;
alter table public.simulation_projects add constraint simulation_projects_kind_check check (kind in ('single', 'bulk', 'forecast'));
alter table public.simulation_runs drop constraint simulation_runs_kind_check;
alter table public.simulation_runs add constraint simulation_runs_kind_check check (kind in ('single', 'bulk', 'forecast'));

-- Dense 1-based ordinal of the order within its file (by first shipment row): drives the deterministic apportionment of order-share drivers.
alter table public.orders add column seq integer check (seq is null or seq >= 1);
create unique index orders_dataset_seq_key on public.orders (dataset_id, seq);
update public.orders o set seq = x.rn
from (select s.order_id, row_number() over (partition by s.dataset_id order by min(s.row_no)) as rn from public.shipments s group by s.dataset_id, s.order_id) x
where x.order_id = o.id;

alter table public.simulation_runs
  add column fee_schedule_id uuid,
  add column monthly_fee_schedule_version_id uuid references public.fee_schedule_versions (id) on delete restrict,
  add column fee_rates jsonb,
  add column fee_engine_version text,
  add column forecast_from date,
  add column forecast_to date,
  add column forecast_days integer,
  add column forecast_months numeric(12,6),
  add column month_profile jsonb,
  add column population_orders integer,
  add column period_orders integer,
  add column undated_orders integer,
  add column volume_basis text check (volume_basis is null or volume_basis in ('file', 'stated', 'none')),
  add column monthly_orders numeric(14,4),
  add column monthly_units numeric(14,4),
  add column monthly_packages numeric(14,4),
  add column monthly_shipments numeric(14,4),
  -- Trusted totals recomputed in SQL at finish (null = fees not modeled in this run).
  add column processing_orders integer,
  add column processing_definite numeric(14,4),
  add column processing_estimated numeric(14,4),
  add column fee_status_counts jsonb,
  add column monthly_fixed numeric(14,4),
  add column minimum_topup numeric(14,4),
  add column minimum_status text check (minimum_status is null or minimum_status in ('exact', 'upper_bound', 'not_computed', 'none')),
  add column projected_monthly numeric(14,2),
  add constraint sr_fee_schedule_in_tenant foreign key (fee_schedule_id, tenant_id) references public.fee_schedules (id, tenant_id) on delete restrict,
  add constraint sr_monthly_version_in_tenant foreign key (monthly_fee_schedule_version_id, tenant_id) references public.fee_schedule_versions (id, tenant_id) on delete restrict;

-- Which fee schedule version each fee date was priced with.
create table public.simulation_run_fee_contexts (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null,
  tenant_id               uuid not null,
  brand_id                uuid not null,
  fee_date                date not null,
  fee_schedule_version_id uuid references public.fee_schedule_versions (id) on delete restrict,
  unavailable_reason      text check (unavailable_reason is null or unavailable_reason in ('no_schedule', 'not_effective')),
  constraint srfc_run foreign key (run_id, tenant_id, brand_id) references public.simulation_runs (id, tenant_id, brand_id) on delete cascade,
  constraint srfc_version_in_tenant foreign key (fee_schedule_version_id, tenant_id) references public.fee_schedule_versions (id, tenant_id) on delete restrict,
  constraint srfc_one_of check ((fee_schedule_version_id is null) <> (unavailable_reason is null)),
  unique (run_id, fee_date)
);

-- One fee result per order of a bulk run. Amounts in E4 (integer ten-thousandths of a dollar).
create table public.simulation_order_results (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null,
  tenant_id               uuid not null,
  brand_id                uuid not null,
  order_id                uuid not null references public.orders (id) on delete cascade,
  first_row_no            bigint not null,
  order_month             text check (order_month is null or order_month ~ '^[0-9]{4}-[0-9]{2}$'),
  fee_date                date,
  fee_schedule_version_id uuid references public.fee_schedule_versions (id) on delete restrict,
  units                   integer check (units is null or units >= 0),
  lines                   integer check (lines is null or lines >= 0),
  distinct_skus           integer check (distinct_skus is null or distinct_skus >= 0),
  packages                integer not null check (packages >= 0),
  shipments               integer not null check (shipments >= 0),
  assumed                 jsonb not null default '{}'::jsonb,
  fee_status              text not null check (fee_status in ('ok', 'partial', 'no_content', 'no_schedule', 'not_effective', 'date_missing', 'skipped')),
  processing_definite     bigint not null default 0 check (processing_definite >= 0),
  processing_estimated    bigint not null default 0 check (processing_estimated >= 0),
  -- Dictionary-encoded lines: [feeDictIndex, amountE4, class('d'|'e')] against run.reference_data.feeDictionary.
  fee_lines               jsonb not null default '[]'::jsonb,
  -- [{ruleKey, reason, replacedBy?}]
  unresolved              jsonb not null default '[]'::jsonb,
  warning_codes           text[] not null default '{}',
  -- Set at finish: the order is shipping-modeled and its fees priced (ok or partial), so it counts in the processing totals.
  in_totals               boolean not null default false,
  constraint sor_run foreign key (run_id, tenant_id, brand_id) references public.simulation_runs (id, tenant_id, brand_id) on delete cascade,
  unique (run_id, order_id),
  unique (run_id, first_row_no)
);

-- Monthly charges of a run (one row per monthly rule of the pinned version), recomputed in SQL at finish.
create table public.simulation_monthly_lines (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null,
  tenant_id    uuid not null,
  brand_id     uuid not null,
  rule_id      uuid not null references public.fee_rules (id) on delete restrict,
  driver_key   text,
  quantity     numeric(18,6),
  unit_amount  numeric(12,4),
  amount       numeric(14,4),
  charge_class text check (charge_class is null or charge_class in ('definite', 'estimated')),
  status       text not null check (status in ('priced', 'not_modeled')),
  reason       text,
  constraint sml_run foreign key (run_id, tenant_id, brand_id) references public.simulation_runs (id, tenant_id, brand_id) on delete cascade,
  unique (run_id, rule_id)
);

alter table public.simulation_run_fee_contexts enable row level security;
alter table public.simulation_order_results enable row level security;
alter table public.simulation_monthly_lines enable row level security;
create policy srfc_read on public.simulation_run_fee_contexts for select to authenticated using (run_id in (select r.id from public.simulation_runs r));
create policy sor_read on public.simulation_order_results for select to authenticated using (run_id in (select r.id from public.simulation_runs r));
create policy sml_read on public.simulation_monthly_lines for select to authenticated using (run_id in (select r.id from public.simulation_runs r));
grant select on public.simulation_run_fee_contexts, public.simulation_order_results, public.simulation_monthly_lines to authenticated;
grant all on public.simulation_run_fee_contexts, public.simulation_order_results, public.simulation_monthly_lines to service_role;
create index sor_run_month_idx on public.simulation_order_results (run_id, order_month);

-- finalize_order_dataset now also assigns orders.seq.
create or replace function public.finalize_order_dataset(p_dataset uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ds public.order_datasets%rowtype;
  v_orders integer; v_lines integer; v_shipments integer; v_packages integer;
begin
  select * into v_ds from public.order_datasets where id = p_dataset for update;
  if not found or not app.can_model_brand(v_ds.tenant_id, v_ds.brand_id) or not app.modeling_visible(v_ds.tenant_id, v_ds.shared_with_brand) then raise exception 'dataset not found' using errcode = 'P0002'; end if;
  if v_ds.status <> 'materialising' then raise exception 'dataset is not being materialised (status %)', v_ds.status using errcode = 'P0001'; end if;
  select count(*) into v_orders from public.orders where dataset_id = p_dataset;
  select count(*) into v_lines from public.order_lines where dataset_id = p_dataset;
  select count(*) into v_shipments from public.shipments where dataset_id = p_dataset;
  select count(*) into v_packages from public.packages where dataset_id = p_dataset;
  if v_orders = 0 or v_shipments = 0 then raise exception 'dataset has no orders' using errcode = 'P0001'; end if;
  if (select max(row_no) from public.shipments where dataset_id = p_dataset) <> v_shipments then raise exception 'shipment row numbers are not dense' using errcode = 'P0001'; end if;
  update public.orders o set seq = x.rn
    from (select s.order_id, row_number() over (order by min(s.row_no)) as rn from public.shipments s where s.dataset_id = p_dataset group by s.order_id) x
   where x.order_id = o.id;
  perform set_config('app.modeling_rpc', 'on', true);
  update public.order_datasets
     set status = 'ready', order_count = v_orders, line_count = v_lines, shipment_count = v_shipments, package_count = v_packages, materialised_at = now(),
         row_count = coalesce((v_ds.validation #>> '{counts,rows}')::integer, 0)
   where id = p_dataset;
  return jsonb_build_object('orders', v_orders, 'lines', v_lines, 'shipments', v_shipments, 'packages', v_packages);
end $$;

-- ---------------------------------------------------------------------------
-- Fulfillment assumptions validation (closed keys, ranges, drivers of the pinned version)
-- ---------------------------------------------------------------------------
create function app.validate_fulfillment(p_f jsonb, p_version uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_k text; v_v jsonb; v_r record; v_rows jsonb; v_row jsonb; v_sum numeric := 0; v_stored text;
begin
  if p_f is null then return; end if;
  if jsonb_typeof(p_f) <> 'object' then raise exception 'fulfillment assumptions must be an object' using errcode = 'PC001'; end if;
  if pg_column_size(p_f) > 16384 then raise exception 'fulfillment assumptions are too large' using errcode = 'PC001'; end if;
  if exists (select 1 from jsonb_object_keys(p_f) k where k not in ('skip', 'monthlyOrders', 'drivers', 'orderShares', 'packagingDefault', 'orderContent')) then
    raise exception 'fulfillment assumptions carry an unknown field' using errcode = 'PC001';
  end if;
  if p_f ? 'skip' and jsonb_typeof(p_f -> 'skip') <> 'boolean' then raise exception 'skip must be true or false' using errcode = 'PC001'; end if;
  if p_f ? 'monthlyOrders' and jsonb_typeof(p_f -> 'monthlyOrders') <> 'null' then
    if not app.fee_decimal_ok(p_f ->> 'monthlyOrders', 2) or (p_f ->> 'monthlyOrders')::numeric not between 1 and 5000000 then
      raise exception 'monthly orders must be between 1 and 5,000,000' using errcode = 'PC001';
    end if;
  end if;
  if p_f ? 'packagingDefault' and jsonb_typeof(p_f -> 'packagingDefault') <> 'null' and (jsonb_typeof(p_f -> 'packagingDefault') <> 'string' or char_length(p_f ->> 'packagingDefault') not between 1 and 60) then
    raise exception 'packaging default must be up to 60 characters' using errcode = 'PC001';
  end if;
  if p_f ? 'drivers' and jsonb_typeof(p_f -> 'drivers') <> 'null' then
    if jsonb_typeof(p_f -> 'drivers') <> 'object' then raise exception 'drivers must be an object' using errcode = 'PC001'; end if;
    for v_k, v_v in select * from jsonb_each(p_f -> 'drivers') loop
      select * into v_r from public.fee_rules r where r.version_id = p_version and r.basis = 'driver' and r.driver ->> 'key' = v_k limit 1;
      if not found then raise exception 'driver % is not a question of this fee schedule', v_k using errcode = 'PC001'; end if;
      if jsonb_typeof(v_v) = 'null' then continue; end if;
      if jsonb_typeof(v_v) <> 'string' or not app.fee_decimal_ok(v_v #>> '{}', 4) then raise exception 'answer for % must be a number', v_k using errcode = 'PC001'; end if;
      if v_r.driver ->> 'kind' = 'returns_rate' and (v_v #>> '{}')::numeric > 100 then raise exception 'a returns rate is a percent of orders (0–100)' using errcode = 'PC001'; end if;
      if (v_v #>> '{}')::numeric > 1000000000 then raise exception 'answer for % is out of range', v_k using errcode = 'PC001'; end if;
    end loop;
    -- A long-term quantity cannot exceed the stored quantity it is part of.
    for v_r in select r.* from public.fee_rules r where r.version_id = p_version and r.driver #>> '{longTerm,mode}' = 'replace' loop
      select x.driver ->> 'key' into v_stored from public.fee_rules x where x.version_id = p_version and x.key = v_r.driver #>> '{longTerm,replacesRuleKey}';
      if p_f #>> array['drivers', v_r.driver ->> 'key'] is not null and p_f #>> array['drivers', v_stored] is not null
         and (p_f #>> array['drivers', v_r.driver ->> 'key'])::numeric > (p_f #>> array['drivers', v_stored])::numeric then
        raise exception 'long-term quantity for "%" exceeds the total stored', v_r.name using errcode = 'PC001';
      end if;
    end loop;
  end if;
  if p_f ? 'orderShares' and jsonb_typeof(p_f -> 'orderShares') <> 'null' then
    if jsonb_typeof(p_f -> 'orderShares') <> 'object' then raise exception 'orderShares must be an object' using errcode = 'PC001'; end if;
    for v_k, v_v in select * from jsonb_each(p_f -> 'orderShares') loop
      if not exists (select 1 from public.fee_rules r where r.version_id = p_version and r.basis = 'order_driver' and r.driver ->> 'key' = v_k) then
        raise exception 'order driver % is not a question of this fee schedule', v_k using errcode = 'PC001';
      end if;
      if jsonb_typeof(v_v) = 'null' then continue; end if;
      if jsonb_typeof(v_v) <> 'object' or exists (select 1 from jsonb_object_keys(v_v) k where k not in ('sharePct', 'countPerOrder'))
         or not app.fee_decimal_ok(v_v ->> 'sharePct', 2) or (v_v ->> 'sharePct')::numeric > 100
         or jsonb_typeof(v_v -> 'countPerOrder') is distinct from 'number' or (v_v ->> 'countPerOrder') !~ '^[0-9]{1,4}$' or (v_v ->> 'countPerOrder')::integer not between 1 and 1000 then
        raise exception 'answer for % needs a share of orders (0–100) and a whole count per order (1–1000)', v_k using errcode = 'PC001';
      end if;
    end loop;
  end if;
  if p_f ? 'orderContent' and jsonb_typeof(p_f -> 'orderContent') <> 'null' then
    v_rows := p_f #> '{orderContent,rows}';
    if jsonb_typeof(p_f -> 'orderContent') <> 'object' or exists (select 1 from jsonb_object_keys(p_f -> 'orderContent') k where k <> 'rows')
       or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) not between 1 and 12 then
      raise exception 'order content must list 1–12 rows' using errcode = 'PC001';
    end if;
    for v_row in select * from jsonb_array_elements(v_rows) loop
      if jsonb_typeof(v_row) <> 'object' or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('units', 'lines', 'sharePct'))
         or jsonb_typeof(v_row -> 'units') is distinct from 'number' or (v_row ->> 'units') !~ '^[0-9]{1,5}$'
         or jsonb_typeof(v_row -> 'lines') is distinct from 'number' or (v_row ->> 'lines') !~ '^[0-9]{1,5}$'
         or (v_row ->> 'lines')::integer > (v_row ->> 'units')::integer or ((v_row ->> 'units')::integer > 0 and (v_row ->> 'lines')::integer = 0)
         or not app.fee_decimal_ok(v_row ->> 'sharePct', 2) then
        raise exception 'each order content row needs whole units, lines (1 to units) and a share of orders' using errcode = 'PC001';
      end if;
      v_sum := v_sum + (v_row ->> 'sharePct')::numeric;
    end loop;
    if v_sum <> 100 then raise exception 'order content shares must add up to exactly 100.00' using errcode = 'PC001'; end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- start_simulation_run: pins the fee schedule, computes the period and volume, resolves monthly-volume rates.
-- ---------------------------------------------------------------------------
create or replace function public.start_simulation_run(p_project uuid, p_pricing_basis text, p_as_of_date date, p_service_override uuid, p_unmapped_policy text, p_assumptions jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.simulation_projects%rowtype;
  v_ds public.order_datasets%rowtype;
  v_live uuid; v_run uuid; v_total integer;
  v_f jsonb; v_schedule uuid; v_mversion uuid; v_period jsonb; v_months numeric(12,6); v_basis text := 'none';
  v_orders numeric(14,4); v_units numeric(14,4); v_pkgs numeric(14,4); v_ships numeric(14,4); v_in integer; v_rates jsonb := '{}'::jsonb; v_ver record; v_rule record; v_q numeric; v_rate numeric; v_vr jsonb;
  v_from date; v_to date;
begin
  select * into v_p from public.simulation_projects where id = p_project for update;
  if not found or not app.can_model_brand(v_p.tenant_id, v_p.brand_id) or (not v_p.shared_with_brand and not app.is_tenant_staff(v_p.tenant_id)) then
    raise exception 'scenario not found' using errcode = 'P0002';
  end if;
  if v_p.kind <> 'bulk' or v_p.archived_at is not null then raise exception 'scenario cannot be run' using errcode = 'PC001'; end if;
  select * into v_ds from public.order_datasets where id = v_p.dataset_id;
  if not found or not app.modeling_visible(v_ds.tenant_id, v_ds.shared_with_brand) then raise exception 'scenario not found' using errcode = 'P0002'; end if;
  if v_ds.status <> 'ready' or v_ds.brand_id <> v_p.brand_id then raise exception 'orders file is not ready' using errcode = 'PC001'; end if;
  if not exists (select 1 from public.brand_rate_card_assignments a join public.rate_cards c on c.id = a.rate_card_id and c.status = 'active'
                 where a.brand_id = v_p.brand_id and a.rate_card_id = v_p.rate_card_id and a.unassigned_at is null) then
    raise exception 'rate card is not assigned to this customer' using errcode = 'PC001';
  end if;
  if p_pricing_basis not in ('ship_date', 'fixed_date') then raise exception 'invalid pricing basis' using errcode = 'PC001'; end if;
  if p_pricing_basis = 'fixed_date' and p_as_of_date is null then raise exception 'an as-of date is required' using errcode = 'PC001'; end if;
  if p_unmapped_policy not in ('exclude', 'use_override') then raise exception 'invalid unmapped policy' using errcode = 'PC001'; end if;
  if p_unmapped_policy = 'use_override' and p_service_override is null then raise exception 'choose a service for unmapped shipments' using errcode = 'PC001'; end if;
  if p_service_override is not null and not exists (
       select 1 from public.brand_rate_card_assignments a
       join public.rate_card_versions v on v.rate_card_id = a.rate_card_id and v.status = 'active'
       join public.rate_card_service_terms t on t.version_id = v.id and t.service_id = p_service_override
       where a.brand_id = v_p.brand_id and a.rate_card_id = v_p.rate_card_id and a.unassigned_at is null
         and (a.allowed_service_ids is null or p_service_override = any (a.allowed_service_ids))) then
    raise exception 'that service is not available on the customer''s rate card' using errcode = 'PC001';
  end if;
  if p_assumptions is not null and (jsonb_typeof(p_assumptions) <> 'object' or pg_column_size(p_assumptions) > 32768) then raise exception 'invalid assumptions' using errcode = 'PC001'; end if;

  -- A live run is resumed only when it was started with these settings; different settings never silently attach.
  select id into v_live from public.simulation_runs
   where project_id = p_project and status in ('queued', 'running')
     and pricing_basis = p_pricing_basis and as_of_date is not distinct from p_as_of_date
     and service_override_id is not distinct from p_service_override and unmapped_policy = p_unmapped_policy
     and assumptions = coalesce(p_assumptions, '{}'::jsonb)
   limit 1;
  if v_live is not null then return v_live; end if;
  if exists (select 1 from public.simulation_runs where project_id = p_project and status in ('queued', 'running')) then
    raise exception 'a run with different settings is already in progress' using errcode = 'PC001';
  end if;

  -- Period and volume (design §5).
  v_period := app.dataset_period(v_p.dataset_id);
  v_from := (v_period ->> 'from')::date; v_to := (v_period ->> 'to')::date;
  v_months := (v_period ->> 'months')::numeric;
  v_in := (v_period ->> 'inPeriod')::integer;
  v_f := p_assumptions -> 'fulfillment';
  if v_f is not null and jsonb_typeof(v_f) = 'null' then v_f := null; end if;
  if v_f ->> 'monthlyOrders' is not null then
    v_basis := 'stated'; v_orders := (v_f ->> 'monthlyOrders')::numeric;
  elsif v_months is not null and v_months > 0 and (v_period ->> 'days')::integer >= 28 and v_in > 0 then
    v_basis := 'file'; v_orders := round(v_in / v_months, 4);
  end if;
  if v_orders is not null and v_in > 0 then
    v_units := case when v_period ->> 'units' is null then null else round((v_period ->> 'units')::numeric / v_in * v_orders, 4) end;
    v_pkgs := round((v_period ->> 'packages')::numeric / v_in * v_orders, 4);
    v_ships := round((v_period ->> 'shipments')::numeric / v_in * v_orders, 4);
  end if;

  -- Fee schedule: the brand's active assignment; monthly components use the version in effect on the as-of date (or the period end).
  v_schedule := app.brand_fee_schedule(v_p.brand_id);
  if v_schedule is not null then
    v_mversion := app.fee_version_on(v_schedule, coalesce(case when p_pricing_basis = 'fixed_date' then p_as_of_date end, v_to, current_date));
  end if;
  if v_f is not null and coalesce(v_f ->> 'skip', 'false') <> 'true' then
    if v_mversion is null and (jsonb_typeof(v_f -> 'drivers') = 'object' and v_f -> 'drivers' <> '{}'::jsonb or jsonb_typeof(v_f -> 'orderShares') = 'object' and v_f -> 'orderShares' <> '{}'::jsonb) then
      raise exception 'no fee schedule is in effect for this customer on that date' using errcode = 'PC001';
    end if;
    perform app.validate_fulfillment(v_f, v_mversion);
  elsif v_f is not null then
    perform app.validate_fulfillment(v_f, v_mversion);
  end if;

  -- Monthly-volume tier rates, per version the run may price with (fixed date: one; ship date: every version overlapping the period).
  if v_schedule is not null then
    for v_ver in select v.* from public.fee_schedule_versions v
                 where v.schedule_id = v_schedule and v.status in ('active', 'archived')
                   and (v.id = v_mversion
                        or (p_pricing_basis = 'ship_date' and v_from is not null and v.effective_date <= v_to and (v.expiration_date is null or v.expiration_date >= v_from))) loop
      v_vr := '{}'::jsonb;
      for v_rule in select r.* from public.fee_rules r where r.version_id = v_ver.id and r.scope = 'order' and r.method = 'tiered' and r.tiers ->> 'on' = 'monthly_quantity' loop
        v_q := case v_rule.basis when 'order' then v_orders when 'unit' then v_units when 'package' then v_pkgs when 'shipment' then v_ships end;
        v_rate := app.fee_resolve_rate(v_rule.tiers, v_q);
        if v_rate is not null then v_vr := v_vr || jsonb_build_object(v_rule.key, jsonb_build_object('rateE4', round(v_rate * 10000)::bigint, 'monthlyQuantity', v_q::text)); end if;
      end loop;
      v_rates := v_rates || jsonb_build_object(v_ver.id::text, v_vr);
    end loop;
  end if;

  select count(*) into v_total from public.shipments where dataset_id = v_p.dataset_id;
  insert into public.simulation_runs (project_id, tenant_id, brand_id, kind, status, pricing_basis, as_of_date, service_override_id, unmapped_policy, assumptions, total_shipments,
                                      fee_schedule_id, monthly_fee_schedule_version_id, fee_rates,
                                      forecast_from, forecast_to, forecast_days, forecast_months, month_profile, population_orders, period_orders, undated_orders,
                                      volume_basis, monthly_orders, monthly_units, monthly_packages, monthly_shipments)
  values (p_project, v_p.tenant_id, v_p.brand_id, 'bulk', 'running', p_pricing_basis, p_as_of_date, p_service_override, p_unmapped_policy, coalesce(p_assumptions, '{}'::jsonb), v_total,
          v_schedule, v_mversion, v_rates,
          v_from, v_to, (v_period ->> 'days')::integer, v_months, v_period -> 'monthProfile', (v_period ->> 'population')::integer, v_in, (v_period ->> 'undated')::integer,
          v_basis, v_orders, v_units, v_pkgs, v_ships)
  returning id into v_run;
  return v_run;
end $$;

-- ---------------------------------------------------------------------------
-- simulation_batch_input: adds the order's content and ordinal for the fee engine.
-- ---------------------------------------------------------------------------
-- Line-derived quantities of an order with "unknown" made explicit (RULES.md A2): lines is null when the
-- order has no counted line (units > 0); distinct SKUs is null when lines is null or any counted line has
-- no SKU (a per-product fee is then reported as not computed rather than undercounted). The batch input
-- and advance_simulation_run read the same function, so an echoed quantity can never disagree by construction.
create function app.order_line_counts(p_order uuid) returns table (lines integer, skus integer, null_sku_lines integer)
language sql stable set search_path = '' as $$
  select nullif(count(*) filter (where x.units > 0), 0)::integer as lines,
         case when count(*) filter (where x.units > 0) = 0 or count(*) filter (where x.units > 0 and x.sku is null) > 0 then null
              else count(distinct x.sku) filter (where x.units > 0 and x.sku is not null) end::integer as skus,
         (count(*) filter (where x.units > 0 and x.sku is null))::integer as null_sku_lines
  from public.order_lines x where x.order_id = p_order;
$$;
create or replace function public.simulation_batch_input(p_run uuid, p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype;
  v_ds uuid; v_has_lines boolean;
  v_to bigint; v_limit integer; v_rows jsonb;
begin
  select * into v_r from public.simulation_runs where id = p_run;
  if not found or not app.can_model_brand(v_r.tenant_id, v_r.brand_id) or not app.project_visible(v_r.project_id) then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then return jsonb_build_object('status', v_r.status, 'fromRow', v_r.next_row_no, 'toRow', v_r.next_row_no - 1, 'shipments', '[]'::jsonb); end if;
  select p.dataset_id, d.line_count > 0 into v_ds, v_has_lines from public.simulation_projects p join public.order_datasets d on d.id = p.dataset_id where p.id = v_r.project_id;
  v_limit := least(greatest(coalesce(p_limit, 1), 1), 500);
  select coalesce(max(s2.row_no), v_r.next_row_no - 1) into v_to
  from public.shipments s1
  join public.shipments s2 on s2.order_id = s1.order_id
  where s1.dataset_id = v_ds and s1.row_no = least(v_r.next_row_no + v_limit - 1, v_r.total_shipments);
  if v_to < v_r.next_row_no then v_to := least(v_r.next_row_no + v_limit - 1, v_r.total_shipments); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'shipmentId', s.id, 'orderId', o.id, 'rowNo', s.row_no, 'externalOrderId', o.external_order_id, 'externalShipmentId', s.external_shipment_id,
      'orderDate', o.order_date::text, 'shipDate', s.ship_date::text, 'cancelled', o.cancelled,
      'originZip', coalesce(s.origin_zip, o.origin_zip), 'destinationZip', coalesce(s.destination_zip, o.destination_zip),
      'residential', coalesce(s.residential, o.residential), 'serviceId', s.service_id, 'serviceText', s.service_text,
      'orderIssues', to_jsonb(o.issues), 'shipmentIssues', to_jsonb(s.issues), 'orderUnits', o.units, 'orderSeq', o.seq,
      'orderLines', case when v_has_lines then l.lines else null end, 'orderSkus', case when v_has_lines then l.skus else null end,
      'orderNullSkuLines', case when v_has_lines then l.null_sku_lines else null end,
      'orderShipments', (select count(*) from public.shipments z where z.order_id = o.id),
      'packages', (select coalesce(jsonb_agg(jsonb_build_object(
                     'seq', p.seq, 'weight', p.weight::text, 'weightUnit', p.weight_unit, 'length', p.length_in::text, 'width', p.width_in::text, 'height', p.height_in::text,
                     'declaredValue', p.declared_value::text, 'packagingType', p.packaging_type, 'packagingTypeNormalized', case when p.packaging_type is null then null else app.normalise_packaging(p.packaging_type) end,
                     'weightDerived', p.weight_derived, 'dimensionsDerived', p.dimensions_derived) order by p.seq), '[]'::jsonb)
                   from public.packages p where p.shipment_id = s.id)
    ) order by s.row_no), '[]'::jsonb)
  into v_rows
  from public.shipments s
  join public.orders o on o.id = s.order_id
  left join lateral (select * from app.order_line_counts(o.id)) l on true
  where s.dataset_id = v_ds and s.row_no between v_r.next_row_no and v_to;
  return jsonb_build_object('status', v_r.status, 'fromRow', v_r.next_row_no, 'toRow', v_to, 'total', v_r.total_shipments, 'shipments', v_rows, 'partialSummary', v_r.partial_summary);
end $$;

-- ---------------------------------------------------------------------------
-- advance_simulation_run: now also commits one fee result per order and the fee contexts.
-- ---------------------------------------------------------------------------
drop function public.advance_simulation_run(uuid, bigint, bigint, jsonb, jsonb, jsonb);
create function public.advance_simulation_run(p_run uuid, p_from_row bigint, p_to_row bigint, p_results jsonb, p_partial jsonb, p_contexts jsonb, p_order_results jsonb, p_fee_contexts jsonb) returns jsonb
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
     set next_row_no = p_to_row + 1, processed_shipments = processed_shipments + v_n, partial_summary = p_partial, last_progress_at = now()
   where id = p_run;
  return jsonb_build_object('applied', true, 'status', 'running', 'nextRow', p_to_row + 1, 'processed', v_r.processed_shipments + v_n, 'total', v_r.total_shipments);
end $$;

-- ---------------------------------------------------------------------------
-- Minimum top-up recomputation from stored order results (design §4), used by finish.
-- Returns one row per minimum rule of the monthly version with the figures the engine must agree with.
-- ---------------------------------------------------------------------------
create function app.run_minimums(p_run uuid, p_dict jsonb)
returns table (rule_id uuid, rule_key text, minimum_e4 bigint, counted_e4 bigint, topup_e4 bigint, status text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_r public.simulation_runs%rowtype; v_dict jsonb; r record; b record; k text; v_f numeric; v_counted bigint; v_min bigint; v_tot_min bigint; v_tot_counted bigint; v_tot_top bigint;
  v_upper boolean; v_modeled integer; v_shipped integer; v_sum bigint; v_amount numeric; v_line record; v_undated integer;
begin
  select * into v_r from public.simulation_runs where id = p_run;
  -- The fee dictionary is passed in: finish validates it before calling and only stores it afterwards.
  v_dict := coalesce(p_dict, '[]'::jsonb);
  if v_r.monthly_fee_schedule_version_id is null then return; end if;
  select count(*) into v_undated from public.simulation_order_results x where x.run_id = p_run and x.in_totals and x.order_month is null;
  for r in select * from public.fee_rules x where x.version_id = v_r.monthly_fee_schedule_version_id and x.basis = 'minimum' order by x.position, x.key loop
    rule_id := r.id; rule_key := r.key;
    v_tot_min := 0; v_tot_counted := 0; v_tot_top := 0; v_upper := v_undated > 0;
    -- A member not modeled anywhere makes the top-up an upper bound.
    if exists (select 1 from unnest(r.resolved_rule_keys) m
               where exists (select 1 from public.simulation_monthly_lines ml join public.fee_rules mr on mr.id = ml.rule_id where ml.run_id = p_run and mr.key = m and ml.status = 'not_modeled')
                  or exists (select 1 from public.simulation_order_results x, jsonb_array_elements(x.unresolved) u where x.run_id = p_run and x.in_totals and u ->> 'ruleKey' = m and u ->> 'reason' <> 'replaced')) then
      v_upper := true;
    end if;
    if v_r.month_profile is null or jsonb_array_length(v_r.month_profile) = 0 then
      minimum_e4 := 0; counted_e4 := 0; topup_e4 := 0; status := 'not_computed'; return next; continue;
    end if;
    for b in select (e ->> 'month') as month, (e ->> 'fraction')::numeric as fraction, (e ->> 'orders')::integer as shipped from jsonb_array_elements(v_r.month_profile) e loop
      v_f := b.fraction; v_counted := 0;
      select count(*) into v_modeled from public.simulation_order_results x where x.run_id = p_run and x.in_totals and x.order_month = b.month;
      v_shipped := b.shipped;
      if v_shipped > v_modeled then v_upper := true; end if;
      foreach k in array coalesce(r.resolved_rule_keys, '{}'::text[]) loop
        if exists (select 1 from public.fee_rules m where m.version_id = v_r.monthly_fee_schedule_version_id and m.key = k and m.scope = 'order') then
          select coalesce(sum((e ->> 1)::bigint), 0) into v_sum
          from public.simulation_order_results x, jsonb_array_elements(x.fee_lines) e
          where x.run_id = p_run and x.in_totals and x.order_month = b.month and (v_dict -> (e ->> 0)::integer ->> 'key') = k;
          -- Each rule's monthly sum is rounded to cents once (RULES.md C1), scaled by coverage first when the month is not fully modeled.
          if v_modeled > 0 and v_shipped > v_modeled then v_counted := v_counted + round(v_sum::numeric * v_shipped / v_modeled / 100) * 100; else v_counted := v_counted + round(v_sum::numeric / 100) * 100; end if;
        else
          select ml.amount into v_amount from public.simulation_monthly_lines ml join public.fee_rules mr on mr.id = ml.rule_id where ml.run_id = p_run and mr.key = k and ml.status = 'priced';
          if v_amount is not null then v_counted := v_counted + round(round(v_amount * 10000) * v_f / 100) * 100; end if;
        end if;
      end loop;
      if (r.minimum ->> 'includesShipping')::boolean then
        select coalesce(sum(round(sr.expected * 10000)), 0) into v_sum from public.simulation_results sr
        where sr.run_id = p_run and sr.in_totals and sr.order_id in (select x.order_id from public.simulation_order_results x where x.run_id = p_run and x.in_totals and x.order_month = b.month);
        if v_modeled > 0 and v_shipped > v_modeled then v_counted := v_counted + round(v_sum::numeric * v_shipped / v_modeled / 100) * 100; else v_counted := v_counted + round(v_sum::numeric / 100) * 100; end if;
      end if;
      v_min := round((r.minimum ->> 'amount')::numeric * 10000 * v_f / 100) * 100;
      v_tot_min := v_tot_min + v_min; v_tot_counted := v_tot_counted + v_counted; v_tot_top := v_tot_top + greatest(0, v_min - v_counted);
    end loop;
    minimum_e4 := v_tot_min; counted_e4 := v_tot_counted; topup_e4 := v_tot_top; status := case when v_upper then 'upper_bound' else 'exact' end;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- finish_simulation_run: recomputes shipping totals, processing totals, monthly lines and minimum top-ups in SQL.
-- ---------------------------------------------------------------------------
drop function public.finish_simulation_run(uuid, jsonb, jsonb, text);
create function public.finish_simulation_run(p_run uuid, p_summary jsonb, p_reference_data jsonb, p_engine_version text, p_monthly_lines jsonb) returns jsonb
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
     set status = 'completed', summary = p_summary, reference_data = p_reference_data, engine_version = p_engine_version, fee_engine_version = p_summary ->> 'feeEngineVersion',
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

-- ---------------------------------------------------------------------------
-- Forecasts from assumptions: project + completed run in one transaction, no synthetic orders.
-- ---------------------------------------------------------------------------
create function public.save_forecast_run(p_brand uuid, p_rate_card uuid, p_name text, p_assumptions jsonb, p_summary jsonb, p_pins jsonb, p_engine_version text, p_fee_engine_version text) returns uuid
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
  end if;

  insert into public.simulation_projects (tenant_id, brand_id, kind, name, rate_card_id) values (v_tenant, p_brand, 'forecast', btrim(p_name), p_rate_card) returning id into v_project;
  insert into public.simulation_runs (project_id, tenant_id, brand_id, kind, status, pricing_basis, as_of_date, assumptions, total_shipments, processed_shipments, next_row_no, summary, reference_data, engine_version, fee_engine_version,
                                      fee_schedule_id, monthly_fee_schedule_version_id, forecast_months, volume_basis, monthly_orders,
                                      processing_orders, processing_definite, processing_estimated, monthly_fixed, minimum_topup, minimum_status, finished_at)
  values (v_project, v_tenant, p_brand, 'forecast', 'completed', 'fixed_date', v_as_of, p_assumptions, 0, 0, 1, p_summary, p_pins, p_engine_version, p_fee_engine_version,
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

revoke all on function public.advance_simulation_run(uuid, bigint, bigint, jsonb, jsonb, jsonb, jsonb, jsonb), public.finish_simulation_run(uuid, jsonb, jsonb, text, jsonb),
  public.save_forecast_run(uuid, uuid, text, jsonb, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.advance_simulation_run(uuid, bigint, bigint, jsonb, jsonb, jsonb, jsonb, jsonb), public.finish_simulation_run(uuid, jsonb, jsonb, text, jsonb),
  public.save_forecast_run(uuid, uuid, text, jsonb, jsonb, jsonb, text, text) to authenticated;

-- Audit metadata for runs now names the fee schedule too.
create or replace function app.audit_modeling() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'order_datasets' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('ready', 'discarded') then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.dataset_' || new.status, 'order_dataset', new.id::text,
        jsonb_build_object('name', new.name, 'orders', new.order_count, 'shipments', new.shipment_count, 'packages', new.package_count));
    end if;
    if tg_op = 'UPDATE' and new.shared_with_brand is distinct from old.shared_with_brand then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.dataset_' || case when new.shared_with_brand then 'shared' else 'unshared' end, 'order_dataset', new.id::text, '{}'::jsonb);
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
                           'service_override_id', new.service_override_id, 'total_shipments', new.total_shipments,
                           'fee_schedule_id', new.fee_schedule_id, 'monthly_fee_schedule_version_id', new.monthly_fee_schedule_version_id, 'volume_basis', new.volume_basis));
    elsif new.status is distinct from old.status and new.status in ('completed', 'failed', 'cancelled') then
      perform app.write_audit(new.tenant_id, new.brand_id, 'modeling.run_' || new.status, 'simulation_run', new.id::text,
        jsonb_build_object('project_id', new.project_id, 'processed', new.processed_shipments, 'total', new.total_shipments,
                           'ok', new.ok_shipments, 'unavailable', new.unavailable_shipments, 'modeled_orders', new.modeled_orders,
                           'processing_orders', new.processing_orders, 'minimum_status', new.minimum_status,
                           'engine_version', new.engine_version, 'fee_engine_version', new.fee_engine_version, 'error', left(new.error, 200)));
    end if;
  end if;
  return null;
end $$;
