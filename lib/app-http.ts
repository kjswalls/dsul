import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * app-http.ts: the request and answer helpers every /api/app/* route module
 * shares (lib/app-api.ts, the planner and item routes; lib/app-containers.ts,
 * the Trash and the container routes). Moved out of lib/app-api.ts unchanged.
 *
 * A LEAF, and that is load-bearing. app-api.ts imports app-containers.ts (for
 * the payload's TRASH_WRITES), so if these lived in app-api.ts the container
 * module would import them back, and whichever module loaded first would find
 * the other's `const` schemas still in their temporal dead zone: the import
 * throws, in webpack's output and in Vitest alike. Nothing here imports
 * either route module.
 *
 * Every answer body carries a bare code (`invalid`, `not_found`, a refusal's
 * own word), never server text: the phone words the codes itself.
 */

type Client = SupabaseClient;

export const invalid = (details?: unknown) =>
  NextResponse.json(details === undefined ? { error: 'invalid' } : { error: 'invalid', details }, {
    status: 400,
  });
export const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 });
export const ok = () => NextResponse.json({ ok: true });
/** A well-formed intent the row's state refuses: a bare code, which the phone words. */
export const refused = (error: string, status: 400 | 409) => NextResponse.json({ error }, { status });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A real calendar day. The shape alone accepts 2026-02-31, and a date is data
 * here, not decoration: it is the day a completion is credited to.
 */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const DateStrSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-MM-dd')
  .refine(isCalendarDate, 'not a calendar date');

export const TimeStrSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

/** Parse + validate a JSON body, or the 400 to send instead. */
export async function parseBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.flatten());
  return parsed.data;
}

export const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;

/** A zone this runtime can resolve a day in. */
function isTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a pause resolves "today" in, and a snooze's day gate is held in:
 * the user's stored zone, else the device's, else UTC. That is the rule the
 * phone uses to say "today", so the resume day it shows is the one written.
 * Each candidate counts only if Intl knows it, so a junk value falls through
 * rather than throwing mid-write.
 *
 * A failed read throws, unlike the agent API's silent UTC: the phone retries a
 * failed write, and a pause resolved in the wrong zone is a wrong write.
 */
export async function pauseZone(client: Client, userId: string, deviceZone: string | undefined): Promise<string> {
  const { data, error } = await client.from('user_settings').select('timezone').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const stored = (data as { timezone?: string | null } | null)?.timezone?.trim();
  for (const zone of [stored, deviceZone?.trim()]) {
    if (zone && isTimeZone(zone)) return zone;
  }
  return 'UTC';
}
