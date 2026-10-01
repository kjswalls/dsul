import { createClient } from '@/lib/supabase';

export interface UserSettingsRow {
  theme?: string;
  /** IANA timezone string from DB (synced from client on load) */
  timezone?: string | null;
  time_format?: string;
  week_start_day?: string;
  default_view?: string;
  default_time_bucket?: string;
  show_completed_tasks?: boolean;
  animations_enabled?: boolean;
  compact_mode?: boolean;
  chill_mode?: boolean;
  show_time_indicator?: boolean;
  morning_check_enabled?: boolean;
  left_sidebar_hover?: boolean;
  right_sidebar_hover?: boolean;
  morning_check_time?: string;
  /** null clears the dismissal so today's morning check shows again. */
  morning_check_dismissed_date?: string | null;
  /** Opt-in: unschedule items past due by more than morning_auto_age_days. */
  morning_auto_age_enabled?: boolean;
  morning_auto_age_days?: number;
  eod_review_time?: string;
  eod_review_enabled?: boolean;
  /** Master switch for per-item reminders (migration 032). */
  habit_reminders_enabled?: boolean;
  habit_last_call_enabled?: boolean;
  habit_last_call_time?: string;
  /** The nightly stakes settlement (migration 034). */
  stakes_enabled?: boolean;
  stakes_settle_time?: string;
  /**
   * The settlement's own bookkeeping. The client writes it in exactly ONE
   * place — switching stakes on, to close the books on everything before today
   * — and reads it nowhere: no store hydrates it, so a stale copy can never be
   * written back to re-open a day that was already settled. Deliberately absent
   * from DEFAULT_SETTINGS for the same reason; there is no client-side default
   * for a value only the server should move.
   */
  stakes_settled_date?: string;
  /**
   * Active ground palette slug (lib/theme-palettes.ts). Deliberately absent
   * from DEFAULT_SETTINGS: undefined means "never chosen on any device", and
   * the provider only applies real values — so a device-local choice made
   * before the first server write (or before migration 025) is not clobbered
   * by a synthetic 'default'.
   */
  theme_palette?: string | null;
  /**
   * The theme picked for each mode (lib/theme-looks.ts, migration 052). Absent
   * from DEFAULT_SETTINGS for the same reason as theme_palette: undefined means
   * "never chosen on any device", so a device-local pick is not clobbered.
   */
  theme_light?: string | null;
  theme_dark?: string | null;
  /** The desktop layout (lib/layout-themes.ts, migration 055). Same null rule. */
  layout?: string | null;
}

const DEFAULT_SETTINGS: UserSettingsRow = {
  theme: 'system',
  time_format: '12h',
  week_start_day: 'sunday',
  default_view: 'day',
  default_time_bucket: 'anytime',
  show_completed_tasks: true,
  animations_enabled: true,
  compact_mode: false,
  chill_mode: false,
  show_time_indicator: true,
  morning_check_enabled: true,
  left_sidebar_hover: false,
  right_sidebar_hover: false,
  morning_check_time: '08:00',
  morning_check_dismissed_date: undefined,
  morning_auto_age_enabled: false,
  morning_auto_age_days: 30,
  eod_review_time: '21:00',
  eod_review_enabled: false,
  habit_reminders_enabled: false,
  habit_last_call_enabled: false,
  habit_last_call_time: '20:30',
  stakes_enabled: false,
  stakes_settle_time: '03:00',
};

/**
 * Columns that every deployed database is known to have.
 *
 * PostgREST rejects the ENTIRE select with 42703 if a single named column is
 * missing, and loadSettings' error path returns DEFAULT_SETTINGS — so naming one
 * column the database doesn't have yet silently resets every setting for every
 * user (theme, timezone, dismissal dates, the lot) until someone notices the
 * console error. That is why the column list is split rather than inlined.
 */
const STABLE_SETTINGS_COLUMNS = [
  'theme',
  'timezone',
  'time_format',
  'week_start_day',
  'default_view',
  'default_time_bucket',
  'show_completed_tasks',
  'animations_enabled',
  'compact_mode',
  'chill_mode',
  'show_time_indicator',
  'morning_check_enabled',
  'left_sidebar_hover',
  'right_sidebar_hover',
  'morning_check_time',
  'morning_check_dismissed_date',
  'eod_review_time',
  'eod_review_enabled',
  // Promoted from pending once migration 025 was applied to prod (2026-08-12).
  'theme_palette',
] as const;

/**
 * Columns whose migration may not have run yet on some database the client talks
 * to (local dev, a preview branch, prod between deploy and migrate).
 *
 * WHEN YOU ADD A SETTINGS COLUMN: put it here, with the migration that adds it.
 * Once that migration is applied everywhere — prod included — move it up into
 * STABLE_SETTINGS_COLUMNS. A column left here too long costs one extra
 * round-trip on databases that predate it and nothing else; a column moved up
 * too early wipes everyone's settings, so err towards leaving it here.
 *
 * Currently: migration 022 (morning auto-age), 029 (habit reminders), 031
 * (stakes), 052 (theme per mode) and 055 (layout). Migration 025 (theme_palette) graduated to stable on 2026-08-12
 * once it was applied to prod.
 */
const PENDING_SCHEMA_COLUMNS = [
  'morning_auto_age_enabled',
  'morning_auto_age_days',
  'habit_reminders_enabled',
  'habit_last_call_enabled',
  'habit_last_call_time',
  'stakes_enabled',
  'stakes_settle_time',
  // Listed for the WRITE path: flushSettings drops these when the database is
  // behind, and without it a pre-031 database would reject the whole batched
  // upsert. It rides along in the select too, where nothing reads it.
  'stakes_settled_date',
  // Migration 052: the theme picked for each mode.
  'theme_light',
  'theme_dark',
  // Migration 055: the desktop layout.
  'layout',
] as const;

const SETTINGS_SELECT = [...STABLE_SETTINGS_COLUMNS, ...PENDING_SCHEMA_COLUMNS].join(',');
const STABLE_SETTINGS_SELECT = STABLE_SETTINGS_COLUMNS.join(',');

/**
 * True only for "the database doesn't have a column we asked for".
 *
 * Deliberately narrow. 42703 is Postgres' undefined_column; PGRST204 is
 * PostgREST's own flavour of it (raised when a write names an unknown column).
 * The message test is a belt-and-braces fallback for transports that forward the
 * Postgres text without the SQLSTATE — its shape ("column user_settings.x does
 * not exist") has been stable across PostgREST releases.
 *
 * The narrowness is the point: an offline/CORS/5xx failure arrives as a fetch
 * error with no code and a message like "Failed to fetch", so it does NOT match
 * and keeps taking the loud error path. Misclassifying a network blip as a stale
 * schema would mean quietly discarding two real settings on every flaky load.
 */
function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  return /column\b.*\bdoes not exist/i.test(error.message ?? '');
}

export async function loadSettings(userId: string): Promise<UserSettingsRow> {
  const supabase = createClient();

  const read = async (columns: string) => {
    const { data, error } = await supabase
      .from('user_settings')
      .select(columns)
      .eq('user_id', userId)
      .maybeSingle();
    return { data: data as Partial<UserSettingsRow> | null, error };
  };

  // Happy path is a single round-trip: ask for everything, and only pay for a
  // second request if the database turns out to be older than this build.
  let result = await read(SETTINGS_SELECT);
  let schemaIsBehind = false;

  if (result.error && isMissingColumnError(result.error)) {
    schemaIsBehind = true;
    console.warn(
      `[settings] user_settings is missing a column this build selects (${result.error.message}). ` +
        'Re-reading without the not-yet-migrated columns — ' +
        `${PENDING_SCHEMA_COLUMNS.join(', ')} will read as defaults. ` +
        'Apply the pending migration in supabase/migrations to fix this.'
    );
    result = await read(STABLE_SETTINGS_SELECT);
  }

  const { data, error } = result;

  if (error) {
    console.error('[settings] loadSettings error:', error.message);
    return DEFAULT_SETTINGS;
  }

  if (!data) {
    // First-time user — upsert defaults. Same schema caveat as the select: an
    // insert naming a column the database lacks fails outright, which would
    // leave the new user with no settings row at all.
    const seed: Record<string, unknown> = { user_id: userId, ...DEFAULT_SETTINGS };
    if (schemaIsBehind) {
      for (const column of PENDING_SCHEMA_COLUMNS) delete seed[column];
    }
    await supabase.from('user_settings').upsert(seed, { onConflict: 'user_id' });
    return DEFAULT_SETTINGS;
  }

  // Columns dropped by the fallback are simply absent from `data`, so they land
  // on their DEFAULT_SETTINGS value — the degradation is scoped to the settings
  // the database can't store yet instead of all of them.
  return { ...DEFAULT_SETTINGS, ...data };
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _pending: Partial<UserSettingsRow> = {};
let _pendingUserId: string | null = null;

/**
 * Debounced settings write. Calls within the window MERGE rather than replace.
 *
 * The timer is a single module-level one shared by every call site, so the
 * obvious implementation — capture `patch` in the timeout closure and
 * clearTimeout the previous one — silently discards every write but the last.
 * That was survivable when settings changes were clicks in a dialog; the
 * command palette can fire eight of them one Enter apart, so the patches are
 * accumulated into `_pending` and flushed as one upsert instead.
 *
 * A userId change flushes immediately: the pending patch belongs to the
 * previous user and must not be written against the new one.
 */
export function saveSettings(userId: string, patch: Partial<UserSettingsRow>): void {
  if (_pendingUserId && _pendingUserId !== userId) flushSettings();

  _pendingUserId = userId;
  _pending = { ..._pending, ...patch };

  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSettings, 500);
}

/**
 * Write any accumulated patch now and reset the buffer.
 *
 * Await this before signing out or navigating away: the debounce window is
 * 500ms, and a write that lands after `signOut()` is rejected by the
 * user_settings RLS policy with nothing but a console error to show for it.
 */
export function flushSettings(): Promise<void> {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }

  const userId = _pendingUserId;
  const patch = _pending;
  _pendingUserId = null;
  _pending = {};

  if (!userId || Object.keys(patch).length === 0) return Promise.resolve();

  return (async () => {
    const supabase = createClient();
    let { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });

    // Mirror loadSettings' missing-column fallback on the WRITE path: patches
    // merge across the debounce window, so one pending column (e.g.
    // theme_palette pre-migration-025) must not take a co-batched stable write
    // (e.g. theme) down with it. Retry once with the stable columns only; the
    // pending values degrade to device-local, which is what their doc comments
    // promise for the schema-behind window.
    if (error && isMissingColumnError(error)) {
      const stable: Record<string, unknown> = { ...patch };
      for (const column of PENDING_SCHEMA_COLUMNS) delete stable[column];
      console.warn(
        `[settings] user_settings is missing a column this build writes (${error.message}). ` +
          `Retrying without the not-yet-migrated columns — ` +
          `${PENDING_SCHEMA_COLUMNS.join(', ')} were dropped from the patch. ` +
          'Apply the pending migration in supabase/migrations to fix this.'
      );
      if (Object.keys(stable).length > 0) {
        ({ error } = await supabase
          .from('user_settings')
          .upsert({ user_id: userId, ...stable }, { onConflict: 'user_id' }));
      } else {
        error = null;
      }
    }

    if (error) console.error('[settings] saveSettings error:', error.message);
  })();
}
