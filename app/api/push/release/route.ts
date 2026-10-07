import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/push/release
 *
 * Deletes every `push_subscriptions` row holding this endpoint, whoever owns
 * it. Body: { endpoint: string }. NO SESSION, on purpose (#254).
 *
 * A browser has to let go of its push subscription whenever the person at it
 * changes, and most of those moments come with no session for the account that
 * left: SIGNED_OUT fires after GoTrue has already dropped it, and a browser
 * that wakes up signed in as someone new never held the previous token at all
 * (lib/local-state.ts lists the five ways the user changes). The session-gated
 * /api/push/unsubscribe can only ever delete the CALLER's row, so it cannot
 * speak for any of those.
 *
 * Keyed on the exact endpoint and nothing else, which is why it is safe to
 * leave open: a web-push endpoint is an unguessable capability URL, the browser
 * that holds it is the only party that reads it, and anyone who has it can
 * already push to it. Releasing it grants nothing new. A miss is a no-op, so the
 * answer is `{ ok: true }` either way and says nothing about whether a row
 * existed.
 *
 * The client calls this BEFORE `subscription.unsubscribe()`
 * (lib/push-release.ts): row first, so there is never a moment where the
 * endpoint is live and the row names the previous account.
 */
const MAX_ENDPOINT = 2048;

function isEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let endpoint: unknown;
  try {
    ({ endpoint } = await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isEndpoint(endpoint)) {
    return NextResponse.json({ error: 'endpoint must be an https URL' }, { status: 400 });
  }

  const service = createServiceClient();
  const { error } = await service.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) {
    console.error('[push/release] delete failed:', error.message);
    return NextResponse.json({ error: 'release failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
