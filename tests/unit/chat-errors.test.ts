import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_ERROR_COPY,
  MODEL_ERROR_COPY,
  ROUTE_ERROR_COPY,
  chatErrorCopy,
  isReplyErrorCode,
  replyErrorCode,
  type ReplyErrorCode,
} from '@/lib/chat-errors';
import { USER_MESSAGES } from '@/lib/ai-server/errors';
import { ERROR_CODE_RE } from '@/lib/conversation-types';

/**
 * A failed reply is saved as a CODE (migration 057), so these words are the
 * only place it is ever said. Every code must have them, the server must say
 * the same thing, and an unknown code must never reach a save.
 */

const CHAT_CODES: ReplyErrorCode[] = [
  'auth',
  'forbidden',
  'quota',
  'rate_limit',
  'bad_model',
  'bad_request',
  'upstream',
  'timeout',
  'network',
  'blocked_url',
  'empty',
  'refused',
  'not_connected',
  'unauthorized',
  'invalid',
  'too_large',
  'server',
];
const CLIENT_CODES: ReplyErrorCode[] = ['plugin_setup', 'plugin_unreachable', 'plugin_error', 'no_response', 'client'];

describe('chatErrorCopy', () => {
  it.each([...CHAT_CODES, ...CLIENT_CODES])('%s has copy for either answerer, and fits a saved row', (code) => {
    expect(isReplyErrorCode(code)).toBe(true);
    expect(code).toMatch(ERROR_CODE_RE);
    for (const answerer of ['model', 'openclaw', null] as const) {
      const copy = chatErrorCopy(code, answerer);
      expect(copy.trim().length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/—|Beacon/);
    }
  });

  it('says who was not connected, and whose gateway could not be reached', () => {
    expect(chatErrorCopy('not_connected', 'model')).toBe('Connect a model in Settings to chat.');
    expect(chatErrorCopy('not_connected', 'openclaw')).toBe('Connect your OpenClaw gateway in Settings to chat.');
    expect(chatErrorCopy('upstream', 'openclaw')).toBe("Couldn't reach your OpenClaw gateway.");
    expect(chatErrorCopy('upstream', 'model')).toBe(MODEL_ERROR_COPY.upstream);
  });

  it("reads 'forbidden' as the provider's refusal, except where there is no provider", () => {
    // On the model path a 403 is nearly always the provider's. OpenClaw has
    // none, so there it can only be /api/chat's own origin check.
    expect(chatErrorCopy('forbidden', 'model')).toBe(MODEL_ERROR_COPY.forbidden);
    expect(chatErrorCopy('forbidden', 'openclaw')).toBe(ROUTE_ERROR_COPY.forbidden);
    expect(ROUTE_ERROR_COPY.forbidden).toBe("That request wasn't allowed.");
  });

  it("keeps today's plugin and fallback lines", () => {
    expect(chatErrorCopy('plugin_setup', 'openclaw')).toBe(
      "OpenClaw isn't reachable yet. Run `openclaw dsul-context setup` and set publicUrl in openclaw.json."
    );
    expect(chatErrorCopy('plugin_unreachable', 'openclaw')).toBe("Couldn't reach OpenClaw. Check that it is running.");
    expect(chatErrorCopy('no_response', 'model')).toBe('No response received.');
    expect(chatErrorCopy('client', 'model')).toBe('Something went wrong. Try again.');
  });

  it('reads an unknown or missing code as the generic line', () => {
    expect(chatErrorCopy('teapot', 'model')).toBe(CLIENT_ERROR_COPY.client);
    expect(chatErrorCopy(null, null)).toBe(CLIENT_ERROR_COPY.client);
  });
});

describe('replyErrorCode', () => {
  it('passes a known code and turns anything else into client', () => {
    expect(replyErrorCode('timeout')).toBe('timeout');
    expect(replyErrorCode('plugin_error')).toBe('plugin_error');
    for (const bad of [undefined, null, '', 'TIMEOUT', 'Your provider rejected the key.', 42, {}]) {
      expect(replyErrorCode(bad)).toBe('client');
    }
  });
});

describe('one copy, client and server', () => {
  it("the server's USER_MESSAGES reads the same strings for every chat kind", () => {
    for (const [kind, copy] of Object.entries(MODEL_ERROR_COPY)) {
      expect(USER_MESSAGES[kind as keyof typeof USER_MESSAGES]).toBe(copy);
    }
  });

  it("every line the chat route says itself is chat-errors' line, read from there, never retyped", () => {
    const route = readFileSync(join(process.cwd(), 'app/api/chat/route.ts'), 'utf8');
    expect(route).toMatch(/import \{ ROUTE_ERROR_COPY \} from '@\/lib\/chat-errors'/);
    for (const [key, copy] of Object.entries(ROUTE_ERROR_COPY)) {
      expect(route).toContain(`ROUTE_ERROR_COPY.${key}`);
      expect(route).not.toContain(copy);
    }
    // And no line it says is typed in place: every error's words are a name.
    expect(route).not.toMatch(/jsonChatError\(\s*\d+\s*,\s*['"`]/);
  });
});
