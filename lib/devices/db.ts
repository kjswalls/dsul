/**
 * The registry's columns and its one tolerance.
 *
 * Shared by the server modules and the Devices list, so the roster's select
 * string is written once. It is exactly 064's column grant to
 * `authenticated`, less nothing and plus nothing: a session client that asks
 * for `token` or `keys` (or `*`) gets 42501, which is the point, and a test
 * pins that this string names neither.
 */

/** What the owner may read (064's `grant select (…) to authenticated`). */
export const DEVICE_ROSTER_COLUMNS =
  'id, user_id, device_id, platform, transport, delivery, os, form, apns_environment, parent_device_id, ' +
  'label, app_version, os_version, timezone, prefs, registered_at, last_seen_at, last_sent_at, last_failure, ' +
  'created_at, updated_at'

/** What the sender reads through the service role. The only place `token` and `keys` are selected. */
export const DEVICE_SEND_COLUMNS =
  'id, user_id, device_id, platform, transport, delivery, os, form, token, keys, timezone, prefs, ' +
  'registered_at, last_seen_at'

/**
 * Is this "the devices table is not there"? Postgres says 42P01; PostgREST,
 * whose schema cache is what a client actually asks, says PGRST205. Either
 * means a build that landed ahead of 064 (PGRST202 below is the same for its function), and every reader falls back to
 * push_subscriptions (009) for that one release instead of failing
 * (memory/plans/reminders-platforms.md §5: deploy leads migration).
 */
export function isMissingRegistry(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  // PGRST202 is the same answer about register_device(), which 064 creates
  // beside the table.
  return code === '42P01' || code === 'PGRST205' || code === 'PGRST202'
}
