-- Durable, instance-independent rate limiting for authenticated server actions.
-- Counters are keyed by the caller's auth.uid() and an action name chosen by the
-- server code, so a user can only ever consume their own budget. Unauthenticated
-- endpoints (sign-in, sign-up, password reset) are throttled by Supabase Auth itself.

create table public.rate_limit_counters (
  user_id      uuid not null references auth.users (id) on delete cascade,
  action       text not null check (action ~ '^[a-z_.]{2,60}$'),
  window_start timestamptz not null,
  hits         integer not null default 0 check (hits >= 0),
  primary key (user_id, action, window_start)
);
alter table public.rate_limit_counters enable row level security; -- no policies, no grants: function-only access

create function public.check_rate_limit(p_action text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_window timestamptz;
  v_hits integer;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_counters as c (user_id, action, window_start, hits)
  values (v_uid, p_action, v_window, 1)
  on conflict (user_id, action, window_start) do update set hits = c.hits + 1
  returning c.hits into v_hits;
  -- Opportunistic cleanup of this user's expired windows.
  delete from public.rate_limit_counters where user_id = v_uid and window_start < now() - interval '1 day';
  return v_hits <= p_limit;
end $$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.check_rate_limit(text, integer, integer) to authenticated;
