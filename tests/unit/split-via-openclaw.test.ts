import { describe, it, expect, vi, beforeEach } from 'vitest';

/** OpenClaw sorts a paragraph out from this browser: the split route's own prompt and checking, a fresh session each time. */

const link = vi.hoisted(() => ({ chat: vi.fn(), current: null as unknown }));
vi.mock('@/lib/openclaw-browser-store', () => ({ browserLink: () => link.current }));
vi.mock('@/lib/ai-connection-store', () => ({
  useAIConnectionStore: { getState: () => ({ hydratedUserId: 'u1', openclaw: { agentId: 'main' } }) },
}));
vi.mock('@/lib/ai-settings-store', () => ({ useAISettingsStore: { getState: () => ({ systemPrompt: 'Be brief.' }) } }));

import { splitViaOpenClaw } from '@/lib/split-via-openclaw';
import { SPLIT_SYSTEM_PROMPT } from '@/lib/braindump-split';

beforeEach(() => {
  link.chat.mockReset();
  link.current = { chat: link.chat };
});

describe('splitViaOpenClaw', () => {
  it("asks with the split route's prompt and the person's instructions, in a fresh session, and checks the answer", async () => {
    link.chat.mockResolvedValue({ status: 'complete', content: 'Sure: {"drafts":[{"title":"Email Sam","notes":"Friday"},{"title":""}]}' });
    const out = await splitViaOpenClaw('email sam friday', new AbortController().signal);
    expect(out).toEqual({ ok: true, drafts: [{ title: 'Email Sam', notes: 'Friday' }] });
    const req = link.chat.mock.calls[0][0] as { sessionKey: string; message: string; agentId: string };
    expect(req.message.startsWith(SPLIT_SYSTEM_PROMPT)).toBe(true);
    expect(req.message).toContain('Be brief.');
    expect(req.message).toContain('email sam friday');
    expect(req.agentId).toBe('main');
    expect(req.sessionKey).toMatch(/^dsul:u:u1:split:[0-9a-f-]{36}$/);
    await splitViaOpenClaw('again', new AbortController().signal);
    expect((link.chat.mock.calls[1][0] as { sessionKey: string }).sessionKey).not.toBe(req.sessionKey);
  });

  it('says so when the browser is not paired or OpenClaw is offline', async () => {
    link.current = null;
    expect((await splitViaOpenClaw('x', new AbortController().signal)).ok).toBe(false);
    link.current = { chat: link.chat };
    link.chat.mockResolvedValue({ status: 'error', content: '', reason: 'offline' });
    expect(await splitViaOpenClaw('x', new AbortController().signal)).toEqual({ ok: false, error: "OpenClaw isn't reachable right now." });
  });
});
