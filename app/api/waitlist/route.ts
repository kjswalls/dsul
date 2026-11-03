import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { isMissingSchema } from '@/lib/ai-server/schema-codes';
import { isSameOrigin, readJson } from '@/app/api/ai/_shared/guard';
import {
  callerOf,
  clipWhy,
  isPlanner,
  isTicket,
  normalizeEmail,
  sourceOf,
  takeWaitlistToken,
} from '@/lib/waitlist';

/**
 * The waitlist on dsul.app (public/site/index.html), anonymous by design.
 *
 *   POST  { email, source?, hp? }             → 200 { ok, ticket }
 *   PATCH { ticket, planner?, why? }          → 200 { ok }
 *
 * Writes go through the service role into `waitlist_signups` (migration 088),
 * which no browser can read or write. Three rules hold here:
 *
 * - A signup never says whether the address was already on the list. A repeat
 *   gets a fresh random ticket that names no row, in the same 200 a new one
 *   gets, so the form cannot be used to test who signed up.
 * - The optional answer ("which planner did you quit last, and why?") is saved
 *   by ticket, never by email, and only for a day after the signup: knowing
 *   someone's address is not enough to write on their row.
 * - Nothing personal is logged. An error logs its database code, never the
 *   address, the answer or the caller.
 *
 * Only the page itself may post: a request another site's page sends is
 * refused (isSameOrigin), and the body must be `application/json` (readJson),
 * which a browser will not send across sites without a preflight this route
 * never answers. Otherwise any page could sign its visitors' addresses up from
 * their own browsers, past the per-address limit.
 *
 * `hp` is a honeypot the page hides from people, under a name no autofill
 * knows. A request that fills it gets an ordinary-looking 200 and writes
 * nothing.
 *
 * A signup from anywhere but production (a PR preview's /welcome, a dev
 * server) is written with `from_preview` set: Preview shares production's
 * database, so its test rows land in the real list and must be told apart.
 *
 * Until 088 is applied every write answers 503 'unavailable', and the page says
 * to try again later.
 */

const TABLE = 'waitlist_signups';
const BODY_MAX = 4_096;
const ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

type Body = Record<string, unknown>;

function answer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(req: Request): Promise<Body | NextResponse> {
  if (!isSameOrigin(req)) return answer(403, { error: 'forbidden' });
  const read = await readJson<unknown>(req, BODY_MAX);
  if (!read.ok) return answer(read.status, { error: read.error });
  const body = read.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Body;
  return answer(400, { error: 'invalid' });
}

function failed(op: 'join' | 'answer', error: { code?: string | null }): NextResponse {
  if (isMissingSchema(error.code)) return answer(503, { error: 'unavailable' });
  console.error('[waitlist]', op, error.code ?? 'error');
  return answer(500, { error: 'failed' });
}

function serviceClient() {
  try {
    return createServiceClient();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;

  if (typeof body.hp === 'string' && body.hp.trim() !== '') {
    return answer(200, { ok: true, ticket: randomUUID() });
  }
  if (!takeWaitlistToken(callerOf(req.headers), 'join')) {
    return answer(429, { error: 'rate_limited' });
  }
  const email = normalizeEmail(body.email);
  if (!email) return answer(400, { error: 'invalid_email' });

  const db = serviceClient();
  if (!db) return answer(503, { error: 'unavailable' });

  // ignoreDuplicates: a repeat inserts nothing and returns no row, so its
  // ticket is a random one (see the first rule above).
  const { data, error } = await db
    .from(TABLE)
    .upsert(
      { email, source: sourceOf(body.source), from_preview: process.env.VERCEL_ENV !== 'production' },
      { onConflict: 'email', ignoreDuplicates: true }
    )
    .select('ticket');
  if (error) return failed('join', error);

  const ticket = Array.isArray(data) ? (data[0] as { ticket?: unknown } | undefined)?.ticket : undefined;
  return answer(200, { ok: true, ticket: typeof ticket === 'string' ? ticket : randomUUID() });
}

export async function PATCH(req: Request) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;

  if (!takeWaitlistToken(callerOf(req.headers), 'answer')) {
    return answer(429, { error: 'rate_limited' });
  }
  if (!isTicket(body.ticket)) return answer(400, { error: 'invalid_ticket' });

  const patch: Record<string, unknown> = {};
  if ('planner' in body) {
    if (body.planner === null) patch.planner = null;
    else if (isPlanner(body.planner)) patch.planner = body.planner;
    else return answer(400, { error: 'invalid_planner' });
  }
  if ('why' in body) patch.why = clipWhy(body.why);
  if (Object.keys(patch).length === 0) return answer(400, { error: 'nothing_to_save' });
  patch.answered_at = new Date().toISOString();

  const db = serviceClient();
  if (!db) return answer(503, { error: 'unavailable' });

  // A ticket that names no row (a repeat signup's, an old one) updates
  // nothing and still answers ok: there is nothing for the page to do about it.
  const since = new Date(Date.now() - ANSWER_WINDOW_MS).toISOString();
  const { error } = await db.from(TABLE).update(patch).eq('ticket', body.ticket).gte('created_at', since);
  if (error) return failed('answer', error);

  return answer(200, { ok: true });
}
