import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client — bypasses RLS.
 * ONLY use server-side (API routes, never in client components).
 * Required for:
 *   - Reading, writing and resolving the agent key (user_secrets, below)
 *   - Writing to user_settings on behalf of a user resolved via API key
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY

  if (!url || !serviceKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY env vars')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * The agent key (the OpenClaw plugin's `dsul_…` bearer for /api/agent/*,
 * /api/mcp and the context route) lives in `user_secrets.openclaw_api_key`
 * since migration 059: service-role only, like the gateway token beside it.
 * It used to sit in `user_settings`, which RLS lets the user's own browser
 * SELECT, so any script on the page could read a full read+write key (#123).
 *
 * Every read and write of the key goes through the four helpers below. Each
 * falls back to the old `user_settings` column ONLY when `user_secrets` has no
 * such column yet (a build deployed ahead of 059), never on a miss: after 059
 * the old column is null and CHECKed null, so a row a browser could write
 * there can never authenticate.
 */
function isMissingKeyColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /column\b.*\bdoes not exist/i.test(error.message ?? '')
  )
}

/** The user's agent key, or null when they never connected. Throws on a database error. */
export async function readAgentKey(userId: string, client?: ServiceClient): Promise<string | null> {
  const service = client ?? createServiceClient()
  const secrets = await service
    .from('user_secrets')
    .select('openclaw_api_key')
    .eq('user_id', userId)
    .maybeSingle()
  if (!isMissingKeyColumn(secrets.error)) {
    if (secrets.error) throw new Error(secrets.error.message)
    return keyOf(secrets.data)
  }
  const legacy = await service
    .from('user_settings')
    .select('openclaw_api_key')
    .eq('user_id', userId)
    .maybeSingle()
  if (legacy.error) throw new Error(legacy.error.message)
  return keyOf(legacy.data)
}

/** Store the user's agent key. Returns the database's message on failure. */
export async function storeAgentKey(
  userId: string,
  apiKey: string,
  client?: ServiceClient
): Promise<{ error: string | null }> {
  const service = client ?? createServiceClient()
  const { error } = await service
    .from('user_secrets')
    .upsert({ user_id: userId, openclaw_api_key: apiKey }, { onConflict: 'user_id' })
  if (!isMissingKeyColumn(error)) return { error: error?.message ?? null }
  const legacy = await service
    .from('user_settings')
    .upsert({ user_id: userId, openclaw_api_key: apiKey }, { onConflict: 'user_id' })
  return { error: legacy.error?.message ?? null }
}

/**
 * Delete the user's agent key: Unpair (`unpairOpenClaw`,
 * lib/ai-server/connections.ts). Every bearer route stops resolving it at
 * once, and a later device authorization mints a new one. Idempotent: no row,
 * or a null key, is already done.
 *
 * Returns the database's error CODE on failure, never its message: an
 * update's failure can quote the row, and this row holds other secrets.
 */
export async function clearAgentKey(userId: string, client: ServiceClient): Promise<{ error: string | null }> {
  const { error } = await client.from('user_secrets').update({ openclaw_api_key: null }).eq('user_id', userId)
  if (!isMissingKeyColumn(error)) return { error: error ? codeOrUnknown(error) : null }
  const legacy = await client.from('user_settings').update({ openclaw_api_key: null }).eq('user_id', userId)
  return { error: legacy.error ? codeOrUnknown(legacy.error) : null }
}

function codeOrUnknown(error: { code?: string }): string {
  return typeof error.code === 'string' && error.code !== '' ? error.code : 'unknown'
}

/**
 * Resolve a userId from an OpenClaw API key.
 * Returns null if the key doesn't exist.
 * Pass an existing service client to avoid creating a second one per request.
 */
export async function resolveUserIdFromApiKey(
  apiKey: string,
  client?: ServiceClient
): Promise<string | null> {
  const service = client ?? createServiceClient()
  const secrets = await service
    .from('user_secrets')
    .select('user_id')
    .eq('openclaw_api_key', apiKey)
    .maybeSingle()
  if (!isMissingKeyColumn(secrets.error)) return secrets.error ? null : (secrets.data?.user_id ?? null)

  const { data } = await service
    .from('user_settings')
    .select('user_id')
    .eq('openclaw_api_key', apiKey)
    .maybeSingle()

  return data?.user_id ?? null
}

function keyOf(row: unknown): string | null {
  const v = (row as { openclaw_api_key?: unknown } | null)?.openclaw_api_key
  return typeof v === 'string' && v !== '' ? v : null
}
