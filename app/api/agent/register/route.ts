import { NextRequest, NextResponse } from 'next/server'
import { resolveUserIdFromApiKey, createServiceClient } from '@/lib/supabase-service'
import { registerPlugin, deregisterPlugin, PluginRegistration } from '@/lib/openclaw-registry'
import { assertSafeOutboundUrl } from '@/lib/openclaw-gateway'

/**
 * POST /api/agent/register
 *
 * Called on OpenClaw plugin startup. Registers the plugin's webhook URL so
 * dsul pushes change events when data mutates. Also accepts optional chatUrl
 * (plugin endpoint URL, e.g. …/plugins/dsul/chat) for plugin chat in Ask.
 *
 * Auth: Bearer <openclaw_api_key>  — userId resolved from the key automatically.
 *
 * Body:
 *   {
 *     pluginId:    string     // e.g. "dsul-context"
 *     webhookUrl?: string     // where dsul should POST change events (optional if chatUrl only)
 *     secret?:     string     // HMAC secret for payload verification (optional)
 *     events?:     string[]   // e.g. ["tasks.updated", "habits.updated"]
 *     chatUrl?:    string     // e.g. https://<gateway>/plugins/dsul/chat
 *     agentId?:    string     // OpenClaw agent (default main)
 *   }
 */
export async function POST(req: NextRequest) {
  const userId = await resolveFromBearer(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { pluginId, webhookUrl, secret, events, chatUrl, agentId } = body as {
    pluginId?: string
    webhookUrl?: string
    secret?: string
    events?: string[]
    chatUrl?: string
    agentId?: string
  }

  // chatUrl-only registration is allowed (no webhookUrl/events required).
  //
  // `Array.isArray` matters: `events?.length` is truthy for a STRING, so
  // `events: "tasks.updated"` passed this check, reached a `text[]` column, and
  // failed the insert — while still working locally, because
  // `"tasks.updated".includes("tasks.updated")` is true against the in-memory
  // copy. It delivered until the next cold start and then silently stopped.
  const hasWebhook =
    typeof webhookUrl === 'string' &&
    webhookUrl.length > 0 &&
    Array.isArray(events) &&
    events.length > 0 &&
    events.every((e) => typeof e === 'string')
  const hasChatUrl = typeof chatUrl === 'string' && chatUrl.length > 0

  if (!pluginId) {
    return NextResponse.json({ error: 'Missing required field: pluginId' }, { status: 400 })
  }
  if (!hasWebhook && !hasChatUrl) {
    return NextResponse.json({ error: 'Provide webhookUrl+events or chatUrl' }, { status: 400 })
  }

  // Persist chat URL + agent on user_settings.
  if (hasChatUrl) {
    const service = createServiceClient()
    const { error: upsertError } = await service.from('user_settings').upsert(
      {
        user_id: userId,
        openclaw_chat_url: chatUrl,
        openclaw_agent_id: typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main',
      },
      { onConflict: 'user_id' }
    )
    if (upsertError) {
      console.error(`[agent/register] Failed to store chatUrl for user ${userId}:`, upsertError.message)
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    console.log(`[agent/register] chatUrl stored for user ${userId} → ${chatUrl}`)
  }

  // Register webhook if provided
  if (hasWebhook) {
    // dsul POSTs the user's item data to this URL on every mutation, from
    // now until they revoke it. `assertSafeOutboundUrl` is the same guard the
    // gateway URL gets, minus the TLS requirement — a plugin listener on the
    // tailnet is ordinarily plain http, and that tunnel is already encrypted.
    // Unvalidated, `http://169.254.169.254/` was a durable SSRF that survived
    // cold starts on every instance.
    const allowed = assertSafeOutboundUrl(webhookUrl, { requireTls: false })
    if (!allowed.ok) {
      return NextResponse.json({ error: `webhookUrl: ${allowed.reason}` }, { status: 400 })
    }

    const registration: PluginRegistration = {
      pluginId,
      webhookUrl,
      secret: secret ?? '',
      userId,
      events,
      registeredAt: new Date().toISOString(),
    }

    // Awaited AND checked. Returning ok for a write that failed leaves the
    // plugin registered only in this instance's memory — precisely the bug
    // migration 039 exists to fix, now silent rather than absent.
    const written = await registerPlugin(registration)
    if (!written.ok) {
      return NextResponse.json({ error: written.reason }, { status: 500 })
    }
    console.log(`[agent/register] "${pluginId}" registered for user ${userId} → ${allowed.url}`)

    return NextResponse.json({
      ok: true,
      userId,
      registeredAt: registration.registeredAt,
      // False means "this instance only, until it restarts" — the caller can
      // decide whether that is good enough rather than being told it is.
      durable: written.durable,
    })
  }

  return NextResponse.json({ ok: true, userId, registeredAt: new Date().toISOString() })
}

/**
 * DELETE /api/agent/register
 * Deregisters a plugin (called on OpenClaw plugin shutdown).
 */
export async function DELETE(req: NextRequest) {
  const userId = await resolveFromBearer(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { pluginId } = await req.json()
  if (typeof pluginId !== 'string' || !pluginId) {
    return NextResponse.json({ error: 'Missing required field: pluginId' }, { status: 400 })
  }
  const removed = await deregisterPlugin(userId, pluginId)
  if (!removed.ok) {
    // The one operation whose failure has to be visible: the user is revoking
    // where their item data gets sent, and every other instance keeps reading
    // the row until it is actually gone.
    return NextResponse.json({ error: removed.reason }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

async function resolveFromBearer(req: NextRequest): Promise<string | null> {
  const token = req.headers.get('authorization')?.slice(7)
  if (!token) return null
  return resolveUserIdFromApiKey(token)
}
