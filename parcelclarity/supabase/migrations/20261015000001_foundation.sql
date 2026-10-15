-- ParcelClarity Milestone 1: identity, tenancy, permissions, invitations, audit.
--
-- Isolation model
--   * A tenant is a 3PL. A brand is a customer of exactly one tenant.
--   * Access is granted only through rows in public.memberships. Tenant staff
--     memberships have brand_id = null; brand memberships carry both ids and a
--     composite foreign key guarantees the brand really belongs to the tenant.
--   * Every table has RLS enabled. Policies call SECURITY DEFINER helpers in the
--     private `app` schema (not exposed through the Data API). Helpers read
--     memberships/permissions directly, which avoids recursive policies.
--   * Default privileges for anon/authenticated are revoked; every grant below is
--     explicit and column-scoped where relevant (least privilege).
--   * Platform administrators can list tenants and change tenant status through
--     an audited function. They get NO policy-based access to brands, members,
--     invitations or (in later milestones) rate cards, orders or reports.

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- New tables must opt in to grants; never inherit Supabase's permissive defaults.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Roles and permissions (single source of truth; mirrored in src/lib/auth/permissions.ts
-- and checked by a parity test).
-- ---------------------------------------------------------------------------
create table public.roles (
  key         text primary key,
  scope       text not null check (scope in ('tenant', 'brand')),
  label       text not null,
  description text not null
);

create table public.permissions (
  key         text primary key,
  description text not null
);

create table public.role_permissions (
  role_key       text not null references public.roles (key) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

insert into public.roles (key, scope, label, description) values
  ('tenant_admin',    'tenant', '3PL administrator', 'Manages the 3PL account, brands, staff, pricing and billing.'),
  ('tenant_employee', 'tenant', '3PL employee',      'Works with brand customers and quote projects; cannot change account structure.'),
  ('brand_admin',     'brand',  'Brand administrator', 'Manages the brand team and runs cost models for the brand.'),
  ('brand_employee',  'brand',  'Brand employee',    'Runs cost models and views reports for the brand.');

insert into public.permissions (key, description) values
  ('tenant.manage',  'Edit 3PL account settings and branding.'),
  ('staff.manage',   'Invite and manage 3PL staff.'),
  ('brand.view',     'View a brand account (scoped to the brands the member can reach).'),
  ('brand.create',   'Create brand accounts.'),
  ('brand.manage',   'Rename, suspend or revoke brand accounts.'),
  ('member.view',    'View memberships in scope.'),
  ('member.manage',  'Invite and manage brand members in scope.'),
  ('audit.view',     'View the tenant audit log.'),
  ('ratecard.view',  'View rate cards (Milestone 2).'),
  ('ratecard.manage','Upload and activate rate cards (Milestone 2).'),
  ('simulation.run', 'Run shipping and fulfillment cost simulations (Milestone 3+).'),
  ('report.view',    'View and download reports (Milestone 6).');

insert into public.role_permissions (role_key, permission_key) values
  ('tenant_admin', 'tenant.manage'), ('tenant_admin', 'staff.manage'), ('tenant_admin', 'brand.view'),
  ('tenant_admin', 'brand.create'),  ('tenant_admin', 'brand.manage'), ('tenant_admin', 'member.view'),
  ('tenant_admin', 'member.manage'), ('tenant_admin', 'audit.view'),   ('tenant_admin', 'ratecard.view'),
  ('tenant_admin', 'ratecard.manage'), ('tenant_admin', 'simulation.run'), ('tenant_admin', 'report.view'),
  ('tenant_employee', 'brand.view'), ('tenant_employee', 'ratecard.view'),
  ('tenant_employee', 'simulation.run'), ('tenant_employee', 'report.view'),
  ('brand_admin', 'brand.view'), ('brand_admin', 'member.view'), ('brand_admin', 'member.manage'),
  ('brand_admin', 'simulation.run'), ('brand_admin', 'report.view'),
  ('brand_employee', 'brand.view'), ('brand_employee', 'simulation.run'), ('brand_employee', 'report.view');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null check (email = lower(email)),
  full_name  text check (full_name is null or char_length(full_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Platform operators. Managed only with the service role / database owner: no
-- grants and no policies, so the Data API can never read or change it.
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status     text not null default 'active' check (status in ('active', 'suspended', 'pending_deletion')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.brands (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  status     text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index brands_tenant_name_key on public.brands (tenant_id, lower(btrim(name)));
create index brands_tenant_id_idx on public.brands (tenant_id);

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  brand_id   uuid,
  role_key   text not null references public.roles (key),
  status     text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets the Data API embed a member's profile (profiles.id mirrors auth.users.id).
  constraint memberships_user_profile_fkey foreign key (user_id) references public.profiles (id) on delete cascade,
  -- MATCH SIMPLE: not enforced when brand_id is null (tenant staff rows).
  constraint memberships_brand_belongs_to_tenant
    foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint memberships_role_matches_scope
    check ((role_key in ('tenant_admin', 'tenant_employee') and brand_id is null)
        or (role_key in ('brand_admin', 'brand_employee') and brand_id is not null))
);
create unique index memberships_staff_key on public.memberships (user_id, tenant_id) where brand_id is null;
create unique index memberships_brand_key on public.memberships (user_id, brand_id) where brand_id is not null;
create index memberships_user_idx on public.memberships (user_id) where status = 'active';
create index memberships_tenant_idx on public.memberships (tenant_id);
create index memberships_brand_idx on public.memberships (brand_id) where brand_id is not null;

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  brand_id    uuid,
  email       text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role_key    text not null references public.roles (key),
  -- SHA-256 of the one-time token. The raw token is shown/emailed once and never stored.
  token_hash  bytea not null unique check (octet_length(token_hash) = 32),
  invited_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint invitations_brand_belongs_to_tenant
    foreign key (brand_id, tenant_id) references public.brands (id, tenant_id) on delete restrict,
  constraint invitations_role_matches_scope
    check ((role_key in ('tenant_admin', 'tenant_employee') and brand_id is null)
        or (role_key in ('brand_admin', 'brand_employee') and brand_id is not null)),
  constraint invitations_expiry_window check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint invitations_single_outcome check (not (accepted_at is not null and revoked_at is not null))
);
create unique index invitations_pending_key on public.invitations
  (tenant_id, coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), email)
  where accepted_at is null and revoked_at is null;
create index invitations_tenant_idx on public.invitations (tenant_id);
create index invitations_email_idx on public.invitations (email);

-- Append-only audit trail. Intentionally no foreign keys: audit rows must outlive
-- the entities they describe. Written only by triggers and log_audit_event().
create table public.audit_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  tenant_id   uuid,
  brand_id    uuid,
  action      text not null check (action ~ '^[a-z_]{2,40}\.[a-z_]{2,40}$'),
  entity_type text,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 8192)
);
create index audit_events_tenant_time_idx on public.audit_events (tenant_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger tenants_touch before update on public.tenants for each row execute function app.touch_updated_at();
create trigger brands_touch before update on public.brands for each row execute function app.touch_updated_at();
create trigger memberships_touch before update on public.memberships for each row execute function app.touch_updated_at();
create trigger profiles_touch before update on public.profiles for each row execute function app.touch_updated_at();

create function app.prevent_audit_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only' using errcode = '42501';
end $$;
create trigger audit_events_no_update before update or delete on public.audit_events
  for each row execute function app.prevent_audit_mutation();
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function app.prevent_audit_mutation();

-- Keep profiles in sync with Supabase Auth users.
create function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(lower(new.email), ''), nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

create function app.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = lower(new.email) where id = new.id;
  return new;
end $$;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function app.handle_user_email_change();

-- ---------------------------------------------------------------------------
-- Authorization helpers (private schema, SECURITY DEFINER, fixed search_path)
-- ---------------------------------------------------------------------------
create function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = (select auth.uid()));
$$;

-- Any active membership in the tenant (brand members count only while their brand is active).
create function app.is_member_of_tenant(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    left join public.brands b on b.id = m.brand_id
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant
      and m.status = 'active'
      and (m.brand_id is null or b.status = 'active')
  );
$$;

-- Permission as 3PL staff (tenant-level membership) in an active tenant.
create function app.has_tenant_permission(p_tenant uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.status = 'active'
    join public.role_permissions rp on rp.role_key = m.role_key and rp.permission_key = p_permission
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant
      and m.brand_id is null
      and m.status = 'active'
  );
$$;

-- Permission on a brand, decided from the brand row's own columns (id, tenant, status)
-- plus memberships. It must not query public.brands: used by brands' own SELECT
-- policy, a helper that reads brands cannot see a row inserted in the same
-- statement, which would break INSERT ... RETURNING (and PostgREST's insert+select).
-- Brand members need the brand to be active; tenant staff do not.
create function app.can_access_brand_row(p_brand uuid, p_tenant uuid, p_status text, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.status = 'active'
    join public.role_permissions rp on rp.role_key = m.role_key and rp.permission_key = p_permission
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant
      and m.status = 'active'
      and (m.brand_id is null or (m.brand_id = p_brand and p_status = 'active'))
  );
$$;

-- Same decision, looked up by brand id (for policies on tables that reference a brand).
create function app.has_brand_permission(p_brand uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.brands b
    where b.id = p_brand and app.can_access_brand_row(b.id, b.tenant_id, b.status, p_permission)
  );
$$;

-- Can the caller see memberships/invitations in this scope?
create function app.can_view_membership(p_tenant uuid, p_brand uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_brand is null
              then app.has_tenant_permission(p_tenant, 'member.view')
              else app.has_brand_permission(p_brand, 'member.view') end;
$$;

-- Can the caller manage (invite, suspend, change role) memberships in this scope?
create function app.can_manage_membership(p_tenant uuid, p_brand uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_brand is null
              then app.has_tenant_permission(p_tenant, 'staff.manage')
              else app.has_brand_permission(p_brand, 'member.manage') end;
$$;

-- Can the caller grant this role in this scope? Prevents privilege escalation:
-- tenant roles only via staff.manage, brand roles only for brands of that tenant.
create function app.can_assign_role(p_tenant uuid, p_brand uuid, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_role in ('tenant_admin', 'tenant_employee') then
      p_brand is null and app.has_tenant_permission(p_tenant, 'staff.manage')
    when p_role in ('brand_admin', 'brand_employee') then
      p_brand is not null
      and exists (select 1 from public.brands b where b.id = p_brand and b.tenant_id = p_tenant)
      and app.has_brand_permission(p_brand, 'member.manage')
    else false end;
$$;

-- Used by profiles RLS: may the caller see this user's profile because they
-- can view one of that user's memberships?
create function app.can_view_profile(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) = p_user
      or exists (
        select 1 from public.memberships m
        where m.user_id = p_user and app.can_view_membership(m.tenant_id, m.brand_id)
      );
$$;

-- ---------------------------------------------------------------------------
-- Audit helpers and triggers
-- ---------------------------------------------------------------------------
create function app.write_audit(p_tenant uuid, p_brand uuid, p_action text, p_entity_type text,
                                p_entity_id text, p_metadata jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (actor_id, tenant_id, brand_id, action, entity_type, entity_id, metadata)
  values ((select auth.uid()), p_tenant, p_brand, p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;

create function app.audit_tenants() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.id, null, 'tenant.created', 'tenant', new.id::text, jsonb_build_object('name', new.name));
  elsif new.name is distinct from old.name or new.status is distinct from old.status then
    perform app.write_audit(new.id, null, case when new.status is distinct from old.status then 'tenant.status_changed' else 'tenant.updated' end,
      'tenant', new.id::text,
      jsonb_build_object('name', new.name, 'status_from', old.status, 'status_to', new.status));
  end if;
  return new;
end $$;
create trigger tenants_audit after insert or update on public.tenants for each row execute function app.audit_tenants();

create function app.audit_brands() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.tenant_id, new.id, 'brand.created', 'brand', new.id::text, jsonb_build_object('name', new.name));
  elsif new.name is distinct from old.name or new.status is distinct from old.status then
    perform app.write_audit(new.tenant_id, new.id, case when new.status is distinct from old.status then 'brand.status_changed' else 'brand.updated' end,
      'brand', new.id::text,
      jsonb_build_object('name_from', old.name, 'name_to', new.name, 'status_from', old.status, 'status_to', new.status));
  end if;
  return new;
end $$;
create trigger brands_audit after insert or update on public.brands for each row execute function app.audit_brands();

create function app.audit_memberships() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.tenant_id, new.brand_id, 'membership.created', 'membership', new.id::text,
      jsonb_build_object('user_id', new.user_id, 'role', new.role_key, 'status', new.status));
  elsif new.role_key is distinct from old.role_key or new.status is distinct from old.status then
    perform app.write_audit(new.tenant_id, new.brand_id, 'membership.updated', 'membership', new.id::text,
      jsonb_build_object('user_id', new.user_id, 'role_from', old.role_key, 'role_to', new.role_key,
                         'status_from', old.status, 'status_to', new.status));
  end if;
  return new;
end $$;
create trigger memberships_audit after insert or update on public.memberships for each row execute function app.audit_memberships();

create function app.audit_invitations() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform app.write_audit(new.tenant_id, new.brand_id, 'invitation.created', 'invitation', new.id::text,
      jsonb_build_object('email', new.email, 'role', new.role_key));
  elsif new.revoked_at is not null and old.revoked_at is null then
    perform app.write_audit(new.tenant_id, new.brand_id, 'invitation.revoked', 'invitation', new.id::text,
      jsonb_build_object('email', new.email, 'role', new.role_key));
  elsif new.accepted_at is not null and old.accepted_at is null then
    perform app.write_audit(new.tenant_id, new.brand_id, 'invitation.accepted', 'invitation', new.id::text,
      jsonb_build_object('email', new.email, 'role', new.role_key, 'accepted_by', new.accepted_by));
  end if;
  return new;
end $$;
create trigger invitations_audit after insert or update on public.invitations for each row execute function app.audit_invitations();

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------
-- Brand status: 'revoked' is terminal; tenant and creator are immutable.
create function app.guard_brand_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'brand tenant cannot change' using errcode = '42501';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'a revoked brand cannot be reactivated' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger brands_guard before update on public.brands for each row execute function app.guard_brand_update();

-- Memberships: identity columns are immutable; a tenant must keep an active admin.
create function app.guard_membership_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id or new.tenant_id is distinct from old.tenant_id
     or new.brand_id is distinct from old.brand_id then
    raise exception 'membership identity columns are immutable' using errcode = '42501';
  end if;
  if old.role_key = 'tenant_admin' and old.status = 'active'
     and (new.role_key <> 'tenant_admin' or new.status <> 'active') then
    perform 1 from public.memberships m
      where m.tenant_id = old.tenant_id and m.brand_id is null and m.role_key = 'tenant_admin'
        and m.status = 'active' and m.id <> old.id
      for update;
    if not found then
      raise exception 'a tenant must keep at least one active administrator' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger memberships_guard before update on public.memberships for each row execute function app.guard_membership_update();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles         enable row level security;
alter table public.platform_admins  enable row level security;
alter table public.tenants          enable row level security;
alter table public.brands           enable row level security;
alter table public.memberships      enable row level security;
alter table public.invitations      enable row level security;
alter table public.audit_events     enable row level security;

create policy roles_read on public.roles for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);

create policy profiles_read on public.profiles for select to authenticated
  using (app.can_view_profile(id));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy tenants_read on public.tenants for select to authenticated
  using (app.is_member_of_tenant(id) or app.is_platform_admin());
create policy tenants_update on public.tenants for update to authenticated
  using (app.has_tenant_permission(id, 'tenant.manage'))
  with check (app.has_tenant_permission(id, 'tenant.manage'));

create policy brands_read on public.brands for select to authenticated
  using (app.can_access_brand_row(id, tenant_id, status, 'brand.view'));
create policy brands_insert on public.brands for insert to authenticated
  with check (app.has_tenant_permission(tenant_id, 'brand.create') and status = 'active');
create policy brands_update on public.brands for update to authenticated
  using (app.has_tenant_permission(tenant_id, 'brand.manage'))
  with check (app.has_tenant_permission(tenant_id, 'brand.manage'));

create policy memberships_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or app.can_view_membership(tenant_id, brand_id));
-- A member can never change their own membership (no self-promotion, no self-reinstatement).
create policy memberships_update on public.memberships for update to authenticated
  using (user_id <> (select auth.uid()) and app.can_manage_membership(tenant_id, brand_id))
  with check (user_id <> (select auth.uid()) and app.can_assign_role(tenant_id, brand_id, role_key));

create policy invitations_read on public.invitations for select to authenticated
  using (app.can_manage_membership(tenant_id, brand_id));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (app.can_assign_role(tenant_id, brand_id, role_key)
              and invited_by = (select auth.uid())
              and accepted_at is null and revoked_at is null);

create policy audit_read on public.audit_events for select to authenticated
  using (tenant_id is not null and app.has_tenant_permission(tenant_id, 'audit.view'));

-- ---------------------------------------------------------------------------
-- Table privileges (explicit, minimal, column-scoped writes)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.roles, public.permissions, public.role_permissions to authenticated;
grant select on public.profiles, public.tenants, public.brands, public.memberships,
                public.invitations, public.audit_events to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant update (name) on public.tenants to authenticated;
grant insert (tenant_id, name) on public.brands to authenticated;
grant update (name, status) on public.brands to authenticated;
grant update (role_key, status) on public.memberships to authenticated;
grant insert (tenant_id, brand_id, email, role_key, token_hash, expires_at) on public.invitations to authenticated;

-- service_role keeps full table access (it bypasses RLS by design; never expose it).
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------------
-- RPC functions (public schema, callable by signed-in users only)
-- ---------------------------------------------------------------------------
-- Create a 3PL tenant and make the caller its first administrator.
create function public.create_tenant(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text;
  v_tenant uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if char_length(v_name) not between 1 and 120 then raise exception 'invalid tenant name' using errcode = '22023'; end if;
  if (select count(*) from public.tenants t where t.created_by = v_uid) >= 3 then
    raise exception 'tenant limit reached for this user' using errcode = '53400';
  end if;
  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_slug) < 2 then v_slug := 'tenant'; end if;
  v_slug := left(v_slug, 50) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  insert into public.tenants (name, slug, created_by) values (v_name, v_slug, v_uid) returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, brand_id, role_key, invited_by)
  values (v_uid, v_tenant, null, 'tenant_admin', v_uid);
  return v_tenant;
end $$;

-- Accept an invitation. The caller must be signed in with a confirmed email that
-- matches the invitation. Failures never reveal whether a token exists.
create function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_confirmed timestamptz;
  v_inv public.invitations%rowtype;
  v_membership uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_token is null or char_length(p_token) not between 20 and 200 then
    raise exception 'invalid_or_expired_invitation' using errcode = 'P0001';
  end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_email is null or v_confirmed is null then
    raise exception 'email_not_confirmed' using errcode = 'P0002';
  end if;
  select * into v_inv from public.invitations i
   where i.token_hash = sha256(convert_to(p_token, 'UTF8'))
   for update;
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null
     or v_inv.expires_at <= now() or v_inv.email <> v_email then
    raise exception 'invalid_or_expired_invitation' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.tenants t where t.id = v_inv.tenant_id and t.status = 'active')
     or (v_inv.brand_id is not null and not exists (select 1 from public.brands b where b.id = v_inv.brand_id and b.status = 'active')) then
    raise exception 'invalid_or_expired_invitation' using errcode = 'P0001';
  end if;

  select m.id into v_membership from public.memberships m
   where m.user_id = v_uid and m.tenant_id = v_inv.tenant_id and m.brand_id is not distinct from v_inv.brand_id
   for update;
  if found then
    update public.memberships set role_key = v_inv.role_key, status = 'active', invited_by = v_inv.invited_by
     where id = v_membership;
  else
    insert into public.memberships (user_id, tenant_id, brand_id, role_key, invited_by)
    values (v_uid, v_inv.tenant_id, v_inv.brand_id, v_inv.role_key, v_inv.invited_by)
    returning id into v_membership;
  end if;
  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_membership;
end $$;

create function public.revoke_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_inv public.invitations%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation for update;
  if not found or not app.can_manage_membership(v_inv.tenant_id, v_inv.brand_id) then
    raise exception 'invitation not found' using errcode = 'P0003';
  end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'invitation is no longer pending' using errcode = 'P0004';
  end if;
  update public.invitations set revoked_at = now() where id = p_invitation;
end $$;

-- Application-level audit events (exports, simulations, report generation, ...).
-- Security-critical changes are audited by triggers and cannot be forged here.
create function public.log_audit_event(p_tenant uuid, p_brand uuid, p_action text,
                                       p_entity_type text default null, p_entity_id text default null,
                                       p_metadata jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_action !~ '^(simulation|scenario|report|export|ratecard|import|billing|adjustment|carrier_rule|session)\.[a-z_]{2,40}$' then
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

-- Platform operators can suspend/reactivate a tenant (e.g. non-payment, abuse).
create function public.platform_set_tenant_status(p_tenant uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active', 'suspended', 'pending_deletion') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  update public.tenants set status = p_status where id = p_tenant;
  if not found then raise exception 'tenant not found' using errcode = 'P0003'; end if;
end $$;

revoke all on function public.create_tenant(text), public.accept_invitation(text), public.revoke_invitation(uuid),
  public.log_audit_event(uuid, uuid, text, text, text, jsonb), public.platform_set_tenant_status(uuid, text)
  from public, anon;
grant execute on function public.create_tenant(text), public.accept_invitation(text), public.revoke_invitation(uuid),
  public.log_audit_event(uuid, uuid, text, text, text, jsonb), public.platform_set_tenant_status(uuid, text)
  to authenticated;

-- Helpers are executable by signed-in users because RLS policies invoke them as the caller.
revoke all on all functions in schema app from public, anon;
grant execute on function app.is_platform_admin(), app.is_member_of_tenant(uuid),
  app.has_tenant_permission(uuid, text), app.has_brand_permission(uuid, text),
  app.can_access_brand_row(uuid, uuid, text, text),
  app.can_view_membership(uuid, uuid), app.can_manage_membership(uuid, uuid),
  app.can_assign_role(uuid, uuid, text), app.can_view_profile(uuid) to authenticated, service_role;

-- Lets the app ask "is the caller a platform administrator?" without exposing the table.
create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_platform_admin();
$$;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;
