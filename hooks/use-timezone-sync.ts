import { useEffect, useRef } from 'react'
import { usePlannerStore } from '@/lib/planner-store'
import { useMorningStore } from '@/lib/morning-store'
import { settingsBelongToUser } from '@/lib/settings/hydration'

/**
 * Does the browser's zone differ from the one stored for this account?
 *
 * A blank stored value (null, '' or whitespace — hydrateSettings trims it to
 * null, but a persisted leftover may not have been) is a mismatch, so a new
 * account's row still gets its first zone. An empty browser answer never
 * syncs: there is nothing to send.
 */
export function shouldSyncTimezone(
  stored: string | null | undefined,
  browser: string | undefined
): browser is string {
  return !!browser && (stored?.trim() || null) !== browser
}

/**
 * Syncs the browser's current IANA timezone to the server — once per account
 * per app load, and only when it differs from the stored one, so a traveller's
 * stored zone stays accurate. Fire-and-forget — failures are silent
 * (non-critical).
 *
 * It used to PATCH unconditionally on mount, which put a request (two auth
 * checks and a read, server side) into the cold-start burst on every load for
 * a value that changes maybe twice a year. Now it waits for two things:
 *
 * - THE SETTINGS ARE THIS ACCOUNT'S. `userTimezone` is persisted with the
 *   planner's settings slice, so until hydrateSettings lands it may be the
 *   previous user's on a shared browser — or this user's stale copy. Comparing
 *   against that would skip a sync that was needed. `settingsBelongToUser` is
 *   the gate the /settings route uses for the same reason; hydrateSettings
 *   writes `userTimezone` in the same synchronous block that stamps the owner,
 *   so it cannot see a half-applied state.
 * - THE PLANNER LOAD HAS SETTLED, to keep the request out of the burst.
 *
 * The route still compares server side (app/api/user/timezone/route.ts), so a
 * stale "mismatch" costs a read, never a needless write.
 */
export function useTimezoneSync() {
  const userId = usePlannerStore((s) => s.userId)
  const isLoading = usePlannerStore((s) => s.isLoading)
  const stored = usePlannerStore((s) => s.userTimezone)
  const owner = useMorningStore((s) => s.settingsHydratedUserId)
  /** The account already checked this mount — at most one PATCH per account. */
  const synced = useRef<string | null>(null)

  useEffect(() => {
    if (!settingsBelongToUser(userId, owner) || isLoading) return
    if (synced.current === userId) return
    synced.current = userId
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!shouldSyncTimezone(stored, timezone)) return

    fetch('/api/user/timezone', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone }),
    }).catch(() => {
      // Non-critical — don't surface timezone sync failures to the user
    })
  }, [userId, isLoading, stored, owner])
}
