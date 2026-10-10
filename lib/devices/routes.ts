/**
 * What the three /api/devices routes and their /api/push aliases share: the
 * body shapes and the answer a registry result becomes. Server only.
 */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { RegistryResult } from './registry'

const TOKEN = z.string().min(16).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/)
const KEYS = z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict()

/** POST /api/devices/release, either form. Web push only for the token form. */
export const ReleaseBodySchema = z.union([
  z.object({ transport: z.literal('webpush'), token: TOKEN }).strict(),
  z.object({ deviceId: z.string().regex(/^[A-Za-z0-9:._-]{8,128}$/) }).strict(),
])

/** POST /api/devices/rotate, from the service worker. `oldToken` is null when the browser gave none. */
export const RotateBodySchema = z
  .object({ oldToken: TOKEN.nullable(), token: TOKEN, keys: KEYS })
  .strict()

/** A web push endpoint is an https URL; anything else is no endpoint. */
export function isWebPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || !TOKEN.safeParse(value).success) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The device id an endpoint stands in for when its sender has none: the
 * /api/push aliases (a build from before the registry) and 065's backfill,
 * which use the same `web:` + sha256 so the two land on one row. The browser's
 * next boot re-registers with its real id, and register_device moves the row
 * there.
 */
export function placeholderDeviceId(endpoint: string): string {
  return `web:${createHash('sha256').update(endpoint, 'utf8').digest('hex')}`
}

export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false }
  }
}

export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 })

/** A registry result as an HTTP answer. 503 `unavailable` is a build ahead of 065 asked for something 009 cannot hold. */
export function answer(result: RegistryResult, tag: string): NextResponse {
  if (result.ok) return NextResponse.json({ ok: true })
  if (result.code === 'unavailable') return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  if (result.code === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
  console.error(`[${tag}] registry write failed:`, result.detail)
  return NextResponse.json({ error: 'failed' }, { status: 500 })
}
