import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isSameOrigin, NO_STORE, readJson, requireSession } from '@/app/api/ai/_shared/guard'
import type { ChatErrorCode } from '@/lib/ai-types'
import { extractJsonObject } from '@/lib/json-extract'
import { appendInstructions, clipText, PREP_OUTPUT_TOKENS } from '@/lib/ai-limits'
import {
  AiDbError,
  openModelConnection,
  setConnectionLimit,
  setConnectionStatus,
  type Opened,
} from '@/lib/ai-server/connections'
import {
  httpStatusFor,
  logProviderError,
  toChatErrorCode,
  toProviderError,
  USER_MESSAGES,
} from '@/lib/ai-server/errors'
import { getAdapter } from '@/lib/ai-server/providers'
import { anySignal } from '@/lib/ai-server/stream'
import { PackSchema, packBody, packFromRow, PREP_BATCH, type PrepPack } from '@/lib/prep-packs'

/**
 * /api/ai/prep — prep packs (lib/prep-packs.ts; memory/plans/power-mode.md,
 * build order 3).
 *
 *   GET            the account's packs.
 *   POST           `{ items: [{ id, title, notes? }] }`, at most PREP_BATCH:
 *                  the user's own model writes a pack for each item it can
 *                  honestly get ready, and the route keeps them. Answers the
 *                  packs it kept; an item it chose to skip simply has none.
 *   DELETE ?item=  drops one pack (the card's "not needed").
 *
 * The answerer is always the model the user connected, never OpenClaw (an
 * agent takes a whole item through the hand-off, not a draft), and the client
 * asks only while that model is who answers (`canPrep`). Every write goes
 * through the session client under RLS, never the service role. Failures
 * answer `{ error, code }` in our own words; a provider's text never reaches
 * the response.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PREP_TIMEOUT_MS = 45_000
const MAX_BODY_BYTES = 64_000
const MAX_TITLE_CHARS = 500
const MAX_NOTES_CHARS = 1_500
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const JSON_ONLY_LINE = 'Whatever the instructions above say, reply with the JSON object only.'

const SYSTEM_PROMPT = `You are the assistant inside dsul, a daily planner for neurodivergent people.

The user has a list of things they keep not doing. For each one you can honestly get ready from its title and notes alone, write a PREP PACK: the draft or script that turns it into a one-tap job. You never send, call or book anything; the user takes it from there.

Reply with a JSON object and nothing else — no prose before or after it, no markdown fences.

The shape, exactly:
{
  "packs": [
    { "itemId": "<id>", "kind": "email", "to": "address, only if given", "subject": "...", "body": "..." },
    { "itemId": "<id>", "kind": "message", "to": "who, if given", "body": "..." },
    { "itemId": "<id>", "kind": "call", "who": "who to call", "number": "only if given", "script": ["what to say first", "what to ask", "..."] },
    { "itemId": "<id>", "kind": "steps", "steps": ["first step, under five minutes", "..."] }
  ]
}

Rules:
- "itemId" MUST be an id from the list, copied exactly. At most one pack per item.
- Pick the kind the item asks for: writing to someone is an email or a message, phoning is a call, anything else that is stuck for want of a start is steps.
- Never invent an email address, a phone number, a name, a price, a date or a fact. Use only what the title and notes say. Leave "to" and "number" out when they are not given.
- Emails and messages: short, warm, plain, ready to send as they are. No placeholders in brackets. No sign-off name.
- Call scripts: two to six short lines, in the order they would be said.
- Steps: two to five concrete actions; the first one takes under five minutes.
- Skip any item a draft would not genuinely help (an errand, a chore, something already small). Skipping is fine.
- If nothing on the list can be prepared, return {"packs":[]}.`

const PREP_EMPTY =
  "Your model ran out of room before anything was ready. A model that doesn't reason first gets there sooner."

const NOT_CONNECTED = 'Connect a model in Settings to get things ready.'

function jsonError(status: number, error: string, code: ChatErrorCode, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status, headers: NO_STORE })
}

const ok = (body: unknown) => NextResponse.json(body, { headers: NO_STORE })

const ItemsSchema = z
  .array(
    z.object({
      id: z.string().regex(UUID_RE),
      title: z.string(),
      notes: z.string().optional(),
    })
  )
  .min(1)
  .max(PREP_BATCH)

const SELECT = 'item_id, kind, body, made_for, updated_at'

export async function GET(): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'Your session ended. Sign in again.', 'unauthorized')
  const { data, error } = await session.db
    .from('prep_packs')
    .select(SELECT)
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) {
    // Before 074 is applied the table is missing: no packs, and say so.
    if (error.code === '42P01' || error.code === 'PGRST205') return ok({ packs: [], available: false })
    console.warn('[ai] prep list failed', error.code)
    return jsonError(503, USER_MESSAGES.upstream, 'server')
  }
  const packs = (data ?? []).map(packFromRow).filter((p): p is PrepPack => p !== null)
  return ok({ packs, available: true })
}

export async function DELETE(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'Your session ended. Sign in again.', 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, "That request wasn't allowed.", 'forbidden')
  const item = new URL(req.url).searchParams.get('item') ?? ''
  if (!UUID_RE.test(item)) return jsonError(400, "That request couldn't be read.", 'invalid')
  const { error } = await session.db.from('prep_packs').delete().eq('item_id', item)
  if (error) {
    console.warn('[ai] prep delete failed', error.code)
    return jsonError(503, USER_MESSAGES.upstream, 'server')
  }
  return ok({ ok: true })
}

interface PrepBody {
  items?: unknown
  customInstructions?: unknown
}

export async function POST(req: Request): Promise<Response> {
  const session = await requireSession()
  if (!session) return jsonError(401, 'Your session ended. Sign in again.', 'unauthorized')
  if (!isSameOrigin(req)) return jsonError(403, "That request wasn't allowed.", 'forbidden')
  const { user, db } = session

  const read = await readJson<PrepBody>(req, MAX_BODY_BYTES)
  if (!read.ok) {
    return read.error === 'too_large'
      ? jsonError(413, 'That request is too large.', 'too_large')
      : jsonError(read.status, "That request couldn't be read.", 'invalid')
  }
  const body: PrepBody = read.body && typeof read.body === 'object' ? read.body : {}
  const items = ItemsSchema.safeParse(body.items)
  if (!items.success) return jsonError(400, "That request couldn't be read.", 'invalid')

  // The titles the packs are written for, clipped as the model is sent them.
  const titles = new Map(items.data.map((i) => [i.id, clipText(i.title, MAX_TITLE_CHARS).trim()]))
  const userTurn = [
    'The list:',
    ...items.data.map((i) => {
      const notes = clipText(i.notes, MAX_NOTES_CHARS).trim()
      return `- id ${i.id}: ${titles.get(i.id)}${notes ? `\n  notes: ${notes.replace(/\n+/g, ' ')}` : ''}`
    }),
  ].join('\n')

  let conn: Opened
  try {
    conn = await openModelConnection(user.id)
  } catch (err) {
    if (err instanceof AiDbError) console.warn('[ai] db', err.op, 'failed', err.code)
    else console.warn('[ai] prep connection read failed')
    return jsonError(503, USER_MESSAGES.upstream, 'server')
  }
  if (!conn.ok) {
    switch (conn.reason) {
      case 'unavailable':
        return jsonError(503, NOT_CONNECTED, 'not_connected', { available: false })
      case 'blocked_url':
        return jsonError(400, USER_MESSAGES.blocked_url, 'blocked_url')
      default:
        return jsonError(409, NOT_CONNECTED, 'not_connected')
    }
  }

  const timeout = AbortSignal.timeout(PREP_TIMEOUT_MS)
  const signal = anySignal([req.signal, timeout])
  const { row, creds, model } = conn
  let raw: string
  try {
    raw = await getAdapter(creds.provider).completeText(creds, {
      model,
      modelMeta: row.model_meta ?? {},
      system: [[appendInstructions(SYSTEM_PROMPT, body.customInstructions), JSON_ONLY_LINE].join('\n\n')],
      messages: [{ role: 'user', content: userTurn }],
      maxOutputTokens: PREP_OUTPUT_TOKENS,
      signal,
      json: true,
    })
  } catch (err) {
    const e = toProviderError(err, creds.provider, 'call')
    logProviderError('prep', creds.provider, e.kind, e.status)
    if (e.kind === 'auth') {
      await setConnectionStatus(user.id, row.key_ciphertext, 'failing', 'key_rejected').catch(() => {})
    } else if (e.kind === 'daily_limit') {
      await setConnectionLimit(user.id, row.key_ciphertext, e.resetAt ?? null).catch(() => {})
    }
    if (e.kind === 'aborted') return new Response(null, { status: 204, headers: NO_STORE })
    // Chat's copy for this one talks about "a shorter message", which there is
    // none of here: say what happened in Do stuff's own words.
    if (e.kind === 'empty') return jsonError(httpStatusFor(e.kind), PREP_EMPTY, toChatErrorCode(e.kind))
    return jsonError(httpStatusFor(e.kind), e.message, toChatErrorCode(e.kind))
  }

  // One pack per asked-for item, each checked on its own: a bad one is
  // dropped, never the batch.
  const parsed = extractJsonObject(raw) as { packs?: unknown } | null
  const list = Array.isArray(parsed?.packs) ? parsed.packs : []
  const rows = new Map<string, { item_id: string; kind: string; body: Record<string, unknown>; made_for: string; model: string | null }>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const itemId = (entry as { itemId?: unknown }).itemId
    if (typeof itemId !== 'string' || !titles.has(itemId) || rows.has(itemId)) continue
    const pack = PackSchema.safeParse(entry)
    if (!pack.success) continue
    rows.set(itemId, {
      item_id: itemId,
      kind: pack.data.kind,
      body: packBody(pack.data),
      made_for: titles.get(itemId)!,
      model: typeof model === 'string' ? model.slice(0, 200) : null,
    })
  }
  if (rows.size === 0) return ok({ packs: [] })

  // No `updated_at` in the payload: the row's own default stamps an insert and
  // migration 078's trigger stamps an update. 074 granted authenticated INSERT
  // on five named columns only, and Postgres checks every column an INSERT
  // names, so naming `updated_at` here made every save fail with 42501 and the
  // client show "Couldn't get things ready." on every run (found 2026-10-17).
  const { data, error } = await db
    .from('prep_packs')
    .upsert([...rows.values()], { onConflict: 'item_id' })
    .select(SELECT)
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      return jsonError(503, 'Prep packs are not set up yet.', 'server', { available: false })
    }
    if (error.message?.includes('prep_packs_limit')) {
      return jsonError(409, 'You have 200 things ready already. Clear a few first.', 'too_large')
    }
    console.warn('[ai] prep save failed', error.code)
    return jsonError(503, USER_MESSAGES.upstream, 'server')
  }
  const packs = (data ?? []).map(packFromRow).filter((p): p is PrepPack => p !== null)
  return ok({ packs })
}
