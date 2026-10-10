import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The account's stored zone (user_settings.timezone), written by the device
 * the user is on: the web's PATCH /api/user/timezone on a load whose browser
 * zone differs (hooks/use-timezone-sync.ts), and the iPhone's POST
 * /api/app/timezone. The reminder scan reads the day and the minute in it
 * (lib/reminders/scan.ts), so it is the zone a cue rings in for every device
 * the server pushes to.
 *
 * One writer for both doors, with the caller's client: RLS scopes the row to
 * the signed-in user either way.
 */

/** An IANA name is under 40 characters; this only bounds a body. */
export const TIMEZONE_MAX_LENGTH = 100;

export type TimezoneWrite = { ok: true; unchanged: boolean } | { invalid: 'timezone is required' | 'Invalid timezone' };

/**
 * Validate `timezone` and store it, unless it is already what is stored.
 *
 * The skip matters: the web asks on load, and an unconditional upsert per
 * load made this one of the database's largest write sources (WAL, a dead
 * tuple, later autovacuum) for a value that changes maybe twice a year. The
 * read is a cache hit; the upsert it avoids is not. `maybeSingle` answers null
 * for a brand-new account with no row, which falls through to the upsert so
 * the row is still created.
 *
 * A database error is thrown, for the caller to word.
 */
export async function saveTimezone(client: SupabaseClient, userId: string, timezone: unknown): Promise<TimezoneWrite> {
  if (!timezone || typeof timezone !== 'string' || timezone.length > TIMEZONE_MAX_LENGTH) {
    return { invalid: 'timezone is required' };
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    return { invalid: 'Invalid timezone' };
  }

  const { data: existing, error: readError } = await client
    .from('user_settings')
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing && (existing as { timezone?: string | null }).timezone === timezone) {
    return { ok: true, unchanged: true };
  }

  const { error } = await client.from('user_settings').upsert({ user_id: userId, timezone }, { onConflict: 'user_id' });
  if (error) throw error;
  return { ok: true, unchanged: false };
}
