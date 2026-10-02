/**
 * What every /api/ai/conversations/** route shares beyond guard.ts: one answer
 * per `ConvResult` failure, and the one answer to a throw.
 *
 * Lives beside guard.ts for the same reason: a `_` folder is not routed. The
 * reads and writes themselves are lib/ai-server/conversations.ts, over the
 * session's own client (requireSession); a later bearer route for the phone
 * calls the same functions with lib/app-auth.ts's client instead.
 */

import type { NextResponse } from 'next/server';
import type { ConvFailure } from '@/lib/ai-server/conversations';
import { jsonError } from './guard';

/**
 * A failure as its status and code, in our words only:
 *   missing_schema → 503 unavailable (057 not applied: the client latches "saving off")
 *   not_found      → 404 not_found   (no such conversation of yours)
 *   conflict       → 409 conflict, with the item's existing conversationId
 *   invalid        → 400 invalid     (the database refused a value the parsers let by)
 *   db             → 500 server      (already logged by its code)
 */
export function convFailure(f: { reason: ConvFailure; conversationId?: string }): NextResponse {
  switch (f.reason) {
    case 'missing_schema':
      return jsonError(503, 'unavailable');
    case 'not_found':
      return jsonError(404, 'not_found');
    case 'conflict':
      return jsonError(409, 'conflict', f.conversationId ? { conversationId: f.conversationId } : undefined);
    case 'invalid':
      return jsonError(400, 'invalid');
    default:
      return jsonError(500, 'server');
  }
}

/**
 * A throw from anywhere in a handler: 500, and a log line with the error's
 * name only. Its message could quote the request, and the request is what
 * the user typed.
 */
export function convThrew(op: string, err: unknown): NextResponse {
  console.warn('[ai] conv', op, 'threw', err instanceof Error ? err.name : typeof err);
  return jsonError(500, 'server');
}
