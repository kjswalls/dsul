-- 076_device_wakes.sql — the iPhone app's background wake (reminders PR-3c,
-- memory/plans/reminders-platforms.md §4.4 "Device wakes", §5.4).
--
-- WHY. The iPhone arms its own cues (`delivery 'local'`), so a habit ticked on
-- the Mac stays armed on the phone until dsul next opens there or iOS runs its
-- background refresh, and "ticked at 07:00, buzzed at 07:30" is the result. A
-- silent APNs push tells the phone to fetch and re-plan. This migration is
-- the half that notices: a change to an item with a reminder stamps the
-- user's apns rows `wake_requested_at`, and the reminder tick
-- (lib/devices/wake.ts) sends at most one wake per phone per 30 minutes,
-- stamping `last_background_push_at`.
--
-- WHERE IT DEPARTS FROM §4.4. No `device_wakes` table and no pg_net call per
-- write: two timestamps on the device row say everything the drain needs (is
-- one owed, when was the last), and the 5-minute tick that already runs is
-- the clock, so an item write costs one indexed UPDATE and never an HTTP
-- request. The phone refetches the whole planner, so which items changed is
-- not carried. The writer device is not skipped: a write does not say which
-- device made it, and a wake to the phone that wrote re-plans what it already
-- planned, inside the same throttle.
--
-- The trigger fires only for an item that has, or had, a reminder time, and
-- only when something the phone plans from changed: never for the scan's own
-- `reminder_sent_key` claim, which would wake every phone on every cue. It is
-- SECURITY DEFINER (owner postgres, empty search_path) because the session
-- client that writes items has no grant on devices, and it swallows its own
-- errors: a wake is never worth failing a tick.
--
-- Deploy leads migration: until this is applied the wake tier reads 42703 and
-- does nothing. Replays on an empty database; safe to re-run.

alter table public.devices add column if not exists wake_requested_at timestamptz;
alter table public.devices add column if not exists last_background_push_at timestamptz;

-- The drain's read: apns rows with a wake asked for. Tiny, and partial.
create index if not exists devices_wake_idx on public.devices (wake_requested_at)
  where transport = 'apns' and wake_requested_at is not null;

create or replace function public.items_request_wake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    if old.reminder_time is null then return null; end if;
    v_user := old.user_id;
  elsif tg_op = 'INSERT' then
    if new.reminder_time is null then return null; end if;
    v_user := new.user_id;
  else
    if old.reminder_time is null and new.reminder_time is null then return null; end if;
    if (old.status, old.title, old.start_time, old.start_date, old.repeat_frequency, old.repeat_days,
        old.repeat_month_day, old.completed_dates, old.skipped_dates, old.daily_counts, old.times_per_day,
        old.deleted_at, old.paused_at, old.paused_until, old.reminder_time, old.reminder_anchor,
        old.reminder_snooze_until, old.reminder_snooze_date)
       is not distinct from
       (new.status, new.title, new.start_time, new.start_date, new.repeat_frequency, new.repeat_days,
        new.repeat_month_day, new.completed_dates, new.skipped_dates, new.daily_counts, new.times_per_day,
        new.deleted_at, new.paused_at, new.paused_until, new.reminder_time, new.reminder_anchor,
        new.reminder_snooze_until, new.reminder_snooze_date)
    then
      return null;
    end if;
    v_user := new.user_id;
  end if;

  update public.devices
     set wake_requested_at = now()
   where user_id = v_user
     and transport = 'apns'
     and (wake_requested_at is null or wake_requested_at < now());
  return null;
exception when others then
  return null;
end;
$$;

revoke all on function public.items_request_wake() from public;
revoke all on function public.items_request_wake() from anon;
revoke all on function public.items_request_wake() from authenticated;

drop trigger if exists items_request_wake on public.items;
create trigger items_request_wake
  after insert or update or delete on public.items
  for each row execute function public.items_request_wake();
