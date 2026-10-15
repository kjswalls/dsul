import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * This browser's link to the person's OpenClaw gateway (lib/openclaw-browser/link.ts).
 *
 * The protocol client is a fake: these cases drive the frames a real gateway
 * sends (recorded against OpenClaw 2026.10.3, memory/plans/openclaw-browser-chat.md)
 * and pin what a chat turn makes of them: deltas in order, the final message
 * filling a gap, a stop that tells the gateway, and a link that drops mid-reply.
 */

type Listener = (ev: { event: string; payload?: unknown }) => void;

const fake = vi.hoisted(() => ({
  instances: [] as Array<{
    opts: Record<string, (...a: never[]) => unknown>;
    listeners: Set<(ev: { event: string; payload?: unknown }) => void>;
    requests: Array<{ method: string; params: Record<string, unknown> }>;
    answer: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    started: boolean;
  }>,
}));

vi.mock('@openclaw/gateway-client/browser', () => {
  class GatewayProtocolClient {
    listeners = new Set<Listener>();
    requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    started = false;
    answer: (method: string, params: Record<string, unknown>) => Promise<unknown> = async (method, params) =>
      method === 'chat.send' ? { runId: params.idempotencyKey, status: 'started' } : {};
    constructor(public opts: Record<string, (...a: never[]) => unknown>) {
      fake.instances.push(this as never);
    }
    start() {
      this.started = true;
    }
    stop() {}
    addEventListener(l: Listener) {
      this.listeners.add(l);
      return () => this.listeners.delete(l);
    }
    request(method: string, params: Record<string, unknown>) {
      this.requests.push({ method, params });
      return this.answer(method, params);
    }
  }
  class GatewayBrowserDeviceAuthLifecycle {
    buildPlan() {
      return {};
    }
    acceptHello() {}
    clearStoredToken() {
      return Promise.resolve();
    }
  }
  const readConnectErrorDetailCode = (d: unknown) =>
    d && typeof d === 'object' && typeof (d as { code?: unknown }).code === 'string' ? (d as { code: string }).code : null;
  return { GatewayProtocolClient, GatewayBrowserDeviceAuthLifecycle, readConnectErrorDetailCode };
});

vi.mock('@/lib/openclaw-browser/device-store', () => ({
  readDevice: async () => null,
  updateDevice: async () => null,
}));

import { BROWSER_SCOPES, GatewayLink, messageText, refusalFor, type LinkStatus } from '@/lib/openclaw-browser/link';

function emit(i: (typeof fake.instances)[number], payload: Record<string, unknown>) {
  for (const l of [...i.listeners]) l({ event: 'chat', payload });
}

/** A started link that has said hello. */
function readyLink(statuses: LinkStatus[] = []) {
  const link = new GatewayLink({ userId: 'u1', url: 'wss://claw.example', onStatus: (s) => statuses.push(s) });
  link.start();
  const client = fake.instances.at(-1)!;
  (client.opts.onHello as () => void)();
  return { link, client };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fake.instances.length = 0;
});

describe('what it asks the gateway for', () => {
  it('chat scopes only: never admin, pairing or approvals', () => {
    expect([...BROWSER_SCOPES].sort()).toEqual(['operator.read', 'operator.write']);
    for (const s of BROWSER_SCOPES) expect(s).not.toMatch(/admin|pairing|approvals|questions/);
  });

  it('holds the shared token only until the gateway lets it in', () => {
    const link = new GatewayLink({ userId: 'u1', url: 'wss://claw.example', sharedToken: 'tok' });
    link.start();
    expect((link as unknown as { sharedToken?: string }).sharedToken).toBe('tok');
    (fake.instances.at(-1)!.opts.onHello as () => void)();
    expect(link.status).toEqual({ kind: 'ready' });
    expect((link as unknown as { sharedToken?: string }).sharedToken).toBeUndefined();
  });
});

describe('refusalFor', () => {
  it('reads the gateway codes the way the person needs them', () => {
    expect(refusalFor('PAIRING_REQUIRED', true)).toBe('pairing');
    expect(refusalFor('CONTROL_UI_ORIGIN_NOT_ALLOWED', true)).toBe('origin');
    expect(refusalFor('AUTH_TOKEN_MISMATCH', true)).toBe('token');
    expect(refusalFor('AUTH_TOKEN_MISMATCH', false)).toBe('unpaired');
    expect(refusalFor('AUTH_DEVICE_TOKEN_MISMATCH', false)).toBe('unpaired');
    expect(refusalFor('AUTH_RATE_LIMITED', false)).toBe('later');
    expect(refusalFor(null, false)).toBe('other');
  });
});

describe('connect failures', () => {
  it('waits on approval with the request id, and asks again', () => {
    const statuses: LinkStatus[] = [];
    const link = new GatewayLink({ userId: 'u1', url: 'wss://x', sharedToken: 't', onStatus: (s) => statuses.push(s) });
    link.start();
    const client = fake.instances.at(-1)!;
    const decision = (client.opts.onConnectFailure as unknown as (e: unknown, c: unknown) => { stop?: boolean; reconnectDelayMs?: number })(
      { details: { code: 'PAIRING_REQUIRED', requestId: 'req-1' } },
      { plan: {} }
    );
    expect(statuses.at(-1)).toEqual({ kind: 'pairing', requestId: 'req-1' });
    expect(decision.stop).toBeFalsy();
    expect(decision.reconnectDelayMs).toBeGreaterThan(0);
  });

  it('stops on a refused origin', () => {
    const statuses: LinkStatus[] = [];
    const link = new GatewayLink({ userId: 'u1', url: 'wss://x', sharedToken: 't', onStatus: (s) => statuses.push(s) });
    link.start();
    const client = fake.instances.at(-1)!;
    const decision = (client.opts.onConnectFailure as unknown as (e: unknown, c: unknown) => { stop?: boolean })(
      { details: { code: 'CONTROL_UI_ORIGIN_NOT_ALLOWED' } },
      { plan: {} }
    );
    expect(statuses.at(-1)).toEqual({ kind: 'refused', why: 'origin' });
    expect(decision.stop).toBe(true);
  });
});

describe('a chat turn', () => {
  it('streams deltas and completes on final', async () => {
    const { link, client } = readyLink();
    const deltas: string[] = [];
    const turn = link.chat({
      sessionKey: 'dsul:u:u1:chat:c1',
      agentId: null,
      message: 'hi',
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d),
    });
    await flush();
    const send = client.requests.find((r) => r.method === 'chat.send')!;
    expect(send.params).toMatchObject({ sessionKey: 'dsul:u:u1:chat:c1', message: 'hi' });
    expect(send.params).not.toHaveProperty('agentId');
    const runId = send.params.idempotencyKey as string;
    emit(client, { runId, state: 'status', phase: 'starting_model' });
    emit(client, { runId: 'someone-else', state: 'delta', deltaText: 'NOT MINE' });
    emit(client, { runId, state: 'delta', deltaText: 'Hello' });
    emit(client, { runId, state: 'delta', deltaText: ' there' });
    emit(client, { runId, state: 'final', message: { content: [{ type: 'text', text: 'Hello there.' }] } });
    await expect(turn).resolves.toEqual({ status: 'complete', content: 'Hello there.' });
    // The final message fills in what the deltas missed.
    expect(deltas).toEqual(['Hello', ' there', '.']);
  });

  it('names the agent when one is chosen', async () => {
    const { link, client } = readyLink();
    void link.chat({ sessionKey: 'k', agentId: 'work', message: 'hi', signal: new AbortController().signal, onDelta: () => {} });
    await flush();
    expect(client.requests.find((r) => r.method === 'chat.send')!.params.agentId).toBe('work');
  });

  it('a gateway error is the agent failing, with what arrived kept', async () => {
    const { link, client } = readyLink();
    const turn = link.chat({ sessionKey: 'k', agentId: null, message: 'hi', signal: new AbortController().signal, onDelta: () => {} });
    await flush();
    const runId = client.requests.find((r) => r.method === 'chat.send')!.params.idempotencyKey as string;
    emit(client, { runId, state: 'delta', deltaText: 'Half' });
    emit(client, { runId, state: 'error', errorMessage: 'model fell over' });
    await expect(turn).resolves.toEqual({ status: 'error', content: 'Half', reason: 'agent' });
  });

  it('a stop tells the gateway and keeps what arrived', async () => {
    const { link, client } = readyLink();
    const ac = new AbortController();
    const turn = link.chat({ sessionKey: 'k', agentId: null, message: 'hi', signal: ac.signal, onDelta: () => {} });
    await flush();
    const runId = client.requests.find((r) => r.method === 'chat.send')!.params.idempotencyKey as string;
    emit(client, { runId, state: 'delta', deltaText: 'Some' });
    ac.abort();
    await expect(turn).resolves.toEqual({ status: 'stopped', content: 'Some' });
    expect(client.requests.find((r) => r.method === 'chat.abort')?.params).toMatchObject({ sessionKey: 'k', runId });
  });

  it('the link dropping mid-reply ends the turn as offline', async () => {
    const { link, client } = readyLink();
    const turn = link.chat({ sessionKey: 'k', agentId: null, message: 'hi', signal: new AbortController().signal, onDelta: () => {} });
    await flush();
    (client.opts.resolveClose as unknown as (c: unknown) => unknown)({ helloReceived: true });
    await expect(turn).resolves.toEqual({ status: 'error', content: '', reason: 'offline' });
  });

  it('a refused link reads as unpaired, without sending', async () => {
    const link = new GatewayLink({ userId: 'u1', url: 'wss://x' });
    link.start();
    const client = fake.instances.at(-1)!;
    (client.opts.onConnectFailure as unknown as (e: unknown, c: unknown) => unknown)(
      { details: { code: 'AUTH_DEVICE_TOKEN_MISMATCH' } },
      { plan: {} }
    );
    await expect(
      link.chat({ sessionKey: 'k', agentId: null, message: 'hi', signal: new AbortController().signal, onDelta: () => {} })
    ).resolves.toEqual({ status: 'error', content: '', reason: 'unpaired' });
    expect(client.requests).toEqual([]);
  });
});

describe('messageText', () => {
  it('joins text blocks and ignores the rest', () => {
    expect(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] })).toBe('ab');
    expect(messageText({ content: 'plain' })).toBe('plain');
    expect(messageText(null)).toBe('');
  });
});
