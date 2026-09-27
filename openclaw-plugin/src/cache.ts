import type { DsulCache, PluginConfig } from './plugin-types.js'
import { DsulContextResponseSchema } from '@dsul/types'

let cache: DsulCache | null = null
const lastInjectedAt = new Map<string, number>()  // per-conversation: when full context was last returned to the model
let lastModifiedAt: number | null = null  // when cache was last dirtied by a write/webhook (cache-wide)

export function getCache(): DsulCache | null {
  return cache
}

export function isCacheFresh(ttlMs: number): boolean {
  return !!cache && Date.now() - cache.fetchedAt < ttlMs
}

export function markCacheDirty(): void {
  lastModifiedAt = Date.now()
}

export function markContextInjected(conversationId: string): void {
  lastInjectedAt.set(conversationId, Date.now())
}

export function shouldSkipInjection(ttlMs: number, conversationId: string): boolean {
  const injectedAt = lastInjectedAt.get(conversationId) ?? null
  return (
    injectedAt !== null &&
    (lastModifiedAt === null || lastModifiedAt <= injectedAt) &&
    (Date.now() - injectedAt) < ttlMs
  )
}

export function getLastInjectedAt(conversationId: string): number | null {
  return lastInjectedAt.get(conversationId) ?? null
}

export function isCacheDirty(): boolean {
  return lastModifiedAt !== null && (cache === null || lastModifiedAt > cache.fetchedAt)
}

export function shouldRefreshCache(ttlMs: number): boolean {
  if (!cache) return true
  if (Date.now() - cache.fetchedAt > ttlMs) return true
  if (lastModifiedAt !== null && lastModifiedAt > cache.fetchedAt) return true
  return false
}

let inFlight: Promise<void> | null = null
let queued: Promise<void> | null = null

/**
 * Single-flight wrapper around the context fetch (issue #140).
 *
 * dsul can deliver webhooks back-to-back, and each one calls this. Without a
 * guard, two overlapping fetches both write `cache` and the *last to resolve*
 * wins — which may be the older snapshot.
 *
 * A caller that arrives mid-flight is not simply dropped: the running request
 * may predate the change that triggered this call, so it chains one follow-up
 * fetch instead. At most one follow-up is ever queued, so a webhook burst
 * collapses to two requests rather than N.
 */
export function fetchContext(cfg: PluginConfig): Promise<void> {
  if (inFlight) {
    if (!queued) {
      queued = inFlight
        // A failed in-flight fetch must not cancel the follow-up — the queued
        // caller still has a change to pick up.
        .catch(() => {})
        .then(() => {
          queued = null
          return startFetch(cfg)
        })
    }
    return queued
  }
  return startFetch(cfg)
}

function startFetch(cfg: PluginConfig): Promise<void> {
  inFlight = doFetch(cfg).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doFetch(cfg: PluginConfig): Promise<void> {
  const res = await fetch(`${cfg.dsulUrl}/api/agent/context`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  })
  if (!res.ok) throw new Error(`dsul context fetch failed: ${res.status} ${res.statusText}`)

  const raw = await res.json()
  const parsed = DsulContextResponseSchema.safeParse(raw)
  if (!parsed.success) {
    // Schema mismatch — dsul API may have changed. Log details and use what we have.
    console.warn('[dsul-context] API response validation failed. The @dsul/types package may need updating.')
    console.warn(parsed.error.flatten())
    throw new Error('dsul API schema mismatch — see logs for details')
  }

  const data = parsed.data
  cache = {
    userId: data.userId,
    userTimezone: data.userTimezone ?? "UTC",
    tasks: data.tasks,
    habits: data.habits,
    projects: data.projects,
    habitGroups: data.habitGroups,
    // All three are optional on the wire and default to empty here, so this
    // build keeps working verbatim against a schemaVersion 2 or 3 server: the
    // difference-based "paused" accounting simply finds nothing, which is the
    // correct answer when the server never told us about suppression.
    items: data.items ?? [],
    routines: data.routines ?? [],
    seasons: data.seasons ?? [],
    goals: data.goals ?? [],
    fetchedAt: Date.now(),
  }
}

/** Test helper — resets all module-level singletons. */
export function resetCacheState(): void {
  cache = null
  lastInjectedAt.clear()
  lastModifiedAt = null
  inFlight = null
  queued = null
}
