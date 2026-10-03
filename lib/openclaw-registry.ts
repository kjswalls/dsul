/**
 * Where dsul POSTs change events, and how it finds them.
 *
 * Registrations live in `plugin_registrations` (migration 042). They used to
 * live in an in-process Map, with a comment saying "in production this would
 * live in Supabase" — and production arrived. On Vercel that Map dies with the
 * instance and is absent on every other one, so a plugin that registered
 * against instance A never heard about a mutation served by instance B. The
 * plugin re-registering on startup did not save it: the very next cold start
 * lost it again.
 *
 * THREE THINGS ABOUT THE SHAPE:
 *
 * 1. The table is the truth; the Map below is a CACHE with a short TTL. This is
 *    called from `lib/db.ts` on every mutation, and a query per write to find
 *    the usually-zero rows would be a real cost for a rare payoff. Staleness is
 *    bounded by the TTL, which is strictly better than the old behaviour's
 *    "invisible to other instances forever".
 *
 * 2. It degrades to the old Map when the table is missing, so a build deployed
 *    ahead of `db:push` keeps registering rather than 500ing. Same
 *    `…Available` flag pattern `lib/db.ts` uses for `item_events`.
 *
 * 3. SERVER ONLY, and it has to say so at runtime: `notifyPlugins` is reached
 *    through `lib/db.ts`, which the BROWSER also imports. There is no service
 *    key there, so the client path is a deliberate no-op — exactly what the
 *    empty Map did before. The import is dynamic so the service client lands in
 *    a lazy chunk rather than the main one; it does NOT remove it from the
 *    client build, and nothing here depends on that — the key check is what
 *    makes the branch unreachable, and no secret is in the bundle either way.
 *
 * ONE HONEST COST. Every call site fires this unawaited and there is no
 * `waitUntil`, so on serverless a frozen invocation can cut the delivery short.
 * The read now sits in front of the `fetch`, which widens that window for a
 * WARM instance whose cache has just expired. It does not widen it for the case
 * this exists to fix: before, a cold instance had an empty Map and delivered
 * NOTHING, so cold-start delivery went from impossible to merely at risk.
 * Closing the rest means `after()` at the route level, which cannot live in
 * this module — `lib/db.ts` reaches it from the browser.
 */

export interface PluginRegistration {
  pluginId: string
  webhookUrl: string
  secret: string
  userId: string
  events: string[]
  registeredAt: string
}

/**
 * The fallback store, and the cache.
 *
 * Keyed `${pluginId}:${userId}`, as it always was. Still exported because it is
 * the whole registry when the table is absent.
 */
export const registeredPlugins = new Map<string, PluginRegistration>()

/**
 * When to try the table again after it answered "no such relation".
 *
 * A one-way latch was wrong here, and dangerously so right after `db:push`:
 * PostgREST returns PGRST205 for anything missing from its SCHEMA CACHE, which
 * includes the propagation window on a table that genuinely exists. One such
 * reply would have disabled persistence for the whole life of that instance —
 * registrations accepted in that window are memory-only and lost on the next
 * cold start, and deregistrations become no-ops.
 *
 * `lib/db.ts` latches `item_events` the same way and is right to: a lost trace
 * is a missing line in a feed. Here it costs the user a webhook they think they
 * revoked, so it expires instead.
 */
const TABLE_RETRY_MS = 5 * 60_000
let tableUnavailableUntil = 0

function tableAvailable(): boolean {
  return Date.now() >= tableUnavailableUntil
}

/** PostgREST/Postgres for "that relation is not in my schema cache". */
function missingTable(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205'
}

/** Result of a write, so a caller can tell the user the truth. */
export type RegistryWrite =
  | { ok: true; durable: boolean }
  | { ok: false; reason: string }

/**
 * How long a user's rows may be reused before re-reading.
 *
 * Bounds how late a NEW registration starts receiving events on an instance
 * that had already cached an answer. A minute is short next to "until the next
 * cold start", which is what it replaces, and long enough that a burst of
 * mutations costs one query rather than one each.
 */
const CACHE_TTL_MS = 60_000

const cache = new Map<string, { rows: PluginRegistration[]; at: number }>()

/**
 * Do we hold a service key?
 *
 * The question that actually matters, rather than "am I in Node". Next inlines
 * only `NEXT_PUBLIC_*` into the browser bundle, so `SUPABASE_SECRET_KEY` is
 * `undefined` on the client by construction — which makes this the same test as
 * "server-side" without depending on a global that a test environment may
 * legitimately provide.
 */
function haveServiceKey(): boolean {
  return Boolean(process.env.SUPABASE_SECRET_KEY)
}

function rowToRegistration(row: Record<string, unknown>): PluginRegistration {
  return {
    pluginId: String(row.plugin_id ?? ''),
    webhookUrl: String(row.webhook_url ?? ''),
    secret: String(row.secret ?? ''),
    userId: String(row.user_id ?? ''),
    events: Array.isArray(row.events) ? (row.events as string[]) : [],
    registeredAt: String(row.registered_at ?? ''),
  }
}

/** The pre-migration store: only consulted when the table is not usable. */
function fallbackFor(userId: string): PluginRegistration[] {
  return [...registeredPlugins.values()].filter((r) => r.userId === userId)
}

/** Every registration for one user, table first, cache in front. */
async function registrationsFor(userId: string): Promise<PluginRegistration[]> {
  if (!haveServiceKey() || !tableAvailable()) return fallbackFor(userId)

  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows

  try {
    const { createServiceClient } = await import('./supabase-service')
    const { data, error } = await createServiceClient()
      .from('plugin_registrations')
      .select('plugin_id, webhook_url, secret, user_id, events, registered_at')
      .eq('user_id', userId)

    if (error) {
      if (missingTable(error)) {
        tableUnavailableUntil = Date.now() + TABLE_RETRY_MS
        return fallbackFor(userId)
      }
      console.warn('[openclaw-registry] registration read failed', error.message)
      // NOT the fallback Map. The table exists and this was a blip; the Map may
      // hold a registration the user revoked days ago on another instance, and
      // delivering their items to a webhook they took away is worse than
      // missing a notification. Serve what was last read, or nothing.
      return hit?.rows ?? []
    }

    const rows = (data ?? []).map((r) => rowToRegistration(r as Record<string, unknown>))
    // Reconcile: the table is the truth, so anything this instance remembers
    // for this user and the table does not is gone (deregistered elsewhere, or
    // the account deleted and cascaded).
    for (const [key, reg] of registeredPlugins) {
      if (reg.userId === userId && !rows.some((r) => r.pluginId === reg.pluginId)) {
        registeredPlugins.delete(key)
      }
    }
    rememberFresh(userId, rows)
    return rows
  } catch (err) {
    console.warn('[openclaw-registry] registration read threw', err)
    return cache.get(userId)?.rows ?? []
  }
}

/**
 * Cache a read, sweeping anything long expired.
 *
 * One entry per user, never removed, would grow forever on a long-lived
 * multi-user host — irrelevant for a personal app on serverless, and free to
 * avoid.
 */
function rememberFresh(userId: string, rows: PluginRegistration[]): void {
  const now = Date.now()
  cache.set(userId, { rows, at: now })
  if (cache.size > 64) {
    for (const [key, entry] of cache) {
      if (now - entry.at >= CACHE_TTL_MS) cache.delete(key)
    }
  }
}

/**
 * Record a webhook registration. Upserts — a plugin restarting must replace its
 * row, not add a second one.
 */
export async function registerPlugin(reg: PluginRegistration): Promise<RegistryWrite> {
  // Written to the Map too, so this instance is correct immediately and so the
  // fallback path has something to serve.
  registeredPlugins.set(`${reg.pluginId}:${reg.userId}`, reg)
  if (!haveServiceKey() || !tableAvailable()) {
    cache.delete(reg.userId)
    // Honest, not cheerful: it registered, but only here and only until this
    // instance dies — which is the entire bug migration 039 exists to fix.
    return { ok: true, durable: false }
  }

  try {
    const { createServiceClient } = await import('./supabase-service')
    const { error } = await createServiceClient()
      .from('plugin_registrations')
      .upsert(
        {
          user_id: reg.userId,
          plugin_id: reg.pluginId,
          webhook_url: reg.webhookUrl,
          secret: reg.secret,
          events: reg.events,
          registered_at: reg.registeredAt,
        },
        { onConflict: 'user_id,plugin_id' }
      )

    // AFTER the write, not before. Invalidating first left an await boundary
    // (the dynamic import guarantees one) in which a concurrent notify could
    // read the pre-write table and re-cache it fresh for the full TTL — so the
    // very instance that accepted the change served the old answer for a
    // minute, which is exactly what awaiting the call was meant to prevent.
    cache.delete(reg.userId)

    if (error) {
      if (missingTable(error)) {
        tableUnavailableUntil = Date.now() + TABLE_RETRY_MS
        return { ok: true, durable: false }
      }
      console.warn('[openclaw-registry] registration write failed', error.message)
      return { ok: false, reason: error.message }
    }
    return { ok: true, durable: true }
  } catch (err) {
    cache.delete(reg.userId)
    const reason = err instanceof Error ? err.message : 'registration write failed'
    console.warn('[openclaw-registry] registration write threw', err)
    return { ok: false, reason }
  }
}

/**
 * Forget a registration — called on plugin shutdown.
 *
 * The one operation whose failure MUST be visible. Everything else here is a
 * notification that might not arrive; this is the user revoking where their
 * item data gets sent. A swallowed failure means every other instance keeps
 * reading the row and POSTing their items to a webhook they took away — and
 * they were told it worked.
 */
export async function deregisterPlugin(
  userId: string,
  pluginId: string
): Promise<RegistryWrite> {
  registeredPlugins.delete(`${pluginId}:${userId}`)

  if (!haveServiceKey() || !tableAvailable()) {
    cache.delete(userId)
    // The row may exist and be unreachable from here. Saying "removed" would
    // be a lie about the only thing on this surface that has to be true.
    return { ok: false, reason: 'Could not reach the registration store, so nothing was revoked.' }
  }

  try {
    const { createServiceClient } = await import('./supabase-service')
    const { error } = await createServiceClient()
      .from('plugin_registrations')
      .delete()
      .eq('user_id', userId)
      .eq('plugin_id', pluginId)

    cache.delete(userId)

    if (error) {
      if (missingTable(error)) {
        tableUnavailableUntil = Date.now() + TABLE_RETRY_MS
        return { ok: false, reason: 'Could not reach the registration store, so nothing was revoked.' }
      }
      console.warn('[openclaw-registry] deregister failed', error.message)
      return { ok: false, reason: error.message }
    }
    return { ok: true, durable: true }
  } catch (err) {
    cache.delete(userId)
    const reason = err instanceof Error ? err.message : 'deregister failed'
    console.warn('[openclaw-registry] deregister threw', err)
    return { ok: false, reason }
  }
}

/** Test seam: drop cached rows so a following read hits the table again. */
export function clearRegistrationCache(): void {
  cache.clear()
}

/**
 * Notify all registered plugins for a given user + event type.
 * Called from db.ts whenever a mutation succeeds.
 *
 * Payload shape (sent as JSON to webhookUrl):
 *   { event, userId, data, timestamp }
 *
 * HMAC signature (if secret is set):
 *   X-Dsul-Signature: sha256=<hex>
 */
export async function notifyPlugins(
  userId: string,
  event: DsulEvent,
  data: unknown
): Promise<void> {
  const payload = JSON.stringify({
    event,
    userId,
    data,
    timestamp: new Date().toISOString(),
  })

  const registrations = await registrationsFor(userId)
  const promises: Promise<void>[] = []

  for (const reg of registrations) {
    // Belt and braces: the query already filters by user, but the fallback Map
    // holds every user this instance has seen.
    if (reg.userId !== userId) continue
    if (!reg.events.includes(event) && !reg.events.includes('*')) continue

    promises.push(sendWebhook(reg, payload))
  }

  // Fire-and-forget: don't block the mutation response
  await Promise.allSettled(promises)
}

async function sendWebhook(reg: PluginRegistration, payload: string): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Sign the payload if a secret is configured
  if (reg.secret) {
    const sig = await hmacSha256(reg.secret, payload)
    headers['X-Dsul-Signature'] = `sha256=${sig}`
  }

  try {
    const res = await fetch(reg.webhookUrl, { method: 'POST', headers, body: payload })
    if (!res.ok) {
      console.warn(`[openclaw-registry] Webhook delivery failed for ${reg.pluginId}: ${res.status}`)
    }
  } catch (err) {
    console.warn(`[openclaw-registry] Webhook error for ${reg.pluginId}:`, err)
  }
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * `habitGroups.updated` is PINNED even though the kind is gone (migration 039).
 *
 * `notifyPlugins` DROPS an unregistered event name, so removing it here would
 * not merely stop a redundant webhook — it would silently unsubscribe every
 * deployed plugin build that registered for it, with nothing logged. The
 * container writes in lib/db.ts emit both names for that reason.
 */
export type DsulEvent =
  | 'tasks.updated'
  | 'habits.updated'
  | 'projects.updated'
  | 'habitGroups.updated'
  | '*'
