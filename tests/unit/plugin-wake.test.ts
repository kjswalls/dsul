import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The OpenClaw plugin's wake receiver (openclaw-plugin/src/wake.ts, 0.3.0).
 *
 * Tested from the app repo because the plugin's dist is gitignored and CI gates
 * nothing in it. The load-bearing rule is the security one: a run spends the
 * user's model budget, so it starts only for an `items.handedOff` signed with
 * the configured `webhookSecret`. Everything else is a 200 no-op or a 401.
 */

import {
  handleWebhookRequest,
  handoffMessage,
  handoffSessionKey,
  parseHandoff,
  verifySignature,
} from '@/openclaw-plugin/src/wake';

const SECRET = 'wake-secret';
const ITEM = '0b8f3c1e-4d2a-4f6b-9c1d-2e3f4a5b6c7d';
const CFG = { dsulUrl: 'https://do.dsul.app', apiKey: 'dsul_test', webhookSecret: SECRET };

const event = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'items.handedOff',
    userId: 'u1',
    data: { itemId: ITEM, title: 'Book the dentist', type: 'task' },
    timestamp: '2026-10-11T12:00:00.000Z',
    ...over,
  });

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function deliver(body: string, opts: { signature?: string; cfg?: Record<string, unknown>; runFails?: boolean } = {}) {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = opts.signature !== undefined ? { 'x-dsul-signature': opts.signature } : {};
  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    writeHead(this: { headersSent: boolean }, code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      text += chunk ?? '';
    },
  } as unknown as ServerResponse;
  const runtime = {
    subagent: {
      run: vi.fn(async () => {
        if (opts.runFails) throw new Error('gateway busy');
        return { runId: 'r1' };
      }),
      waitForRun: vi.fn(),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await handleWebhookRequest(req, res, (opts.cfg ?? CFG) as never, runtime as never, logger);
  return { status, text, run: runtime.subagent.run, waitForRun: runtime.subagent.waitForRun, logger };
}

describe('the plugin wake', () => {
  it('starts one run for a signed hand-off, in dsul:handoff:<itemId>, without waiting for it', async () => {
    const body = event();
    const r = await deliver(body, { signature: sign(body) });
    expect(r.status).toBe(202);
    expect(r.run).toHaveBeenCalledTimes(1);
    const params = (r.run.mock.calls[0] as unknown[])[0] as { sessionKey: string; message: string; idempotencyKey: string };
    expect(params.sessionKey).toBe(`dsul:handoff:${ITEM}`);
    expect(params.message).toContain(ITEM);
    expect(params.message).toContain('"Book the dentist"');
    for (const tool of ['dsul_my_work', 'dsul_report_progress', 'dsul_ask_user']) {
      expect(params.message).toContain(tool);
    }
    // A redelivery of the same event is the same run.
    expect(params.idempotencyKey).toBe(`dsul-handoff-${ITEM}-2026-10-11T12:00:00.000Z`);
    expect(r.waitForRun).not.toHaveBeenCalled();
  });

  it('names only tools dsul’s MCP server really has', async () => {
    const { MCP_TOOLS } = await import('@/lib/mcp/tools');
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    const message = handoffMessage({ itemId: ITEM, title: 'x', type: 'task', timestamp: '' });
    for (const named of message.match(/dsul_[a-z_]+/g) ?? []) expect(names.has(named), named).toBe(true);
  });

  it('refuses an unsigned or wrongly signed hand-off, and starts nothing', async () => {
    const body = event();
    for (const signature of [undefined, '', 'sha256=00', sign(body, 'other-secret'), sign(event({ userId: 'u2' }))]) {
      const r = await deliver(body, { signature });
      expect(r.status, String(signature)).toBe(401);
      expect(r.run).not.toHaveBeenCalled();
    }
  });

  it('refuses a hand-off when no webhookSecret is set, even one that carries a signature', async () => {
    const body = event();
    for (const webhookSecret of [undefined, '']) {
      const r = await deliver(body, { signature: sign(body), cfg: { ...CFG, webhookSecret } });
      expect(r.status).toBe(401);
      expect(r.run).not.toHaveBeenCalled();
      expect(r.logger.warn).toHaveBeenCalled();
    }
  });

  it('answers 200 to every other event and starts nothing', async () => {
    for (const name of ['tasks.updated', 'habits.updated', 'projects.updated', 'habitGroups.updated']) {
      const body = event({ event: name, data: { action: 'update', id: ITEM, updates: {} } });
      const signed = await deliver(body, { signature: sign(body) });
      expect(signed.status).toBe(200);
      expect(signed.run).not.toHaveBeenCalled();
      // An older dsul registration may still send these unsigned: a no-op too.
      const unsigned = await deliver(body, { cfg: { ...CFG, webhookSecret: undefined } });
      expect(unsigned.status).toBe(200);
      expect(unsigned.run).not.toHaveBeenCalled();
    }
  });

  it('400s a signed hand-off with no usable item id', async () => {
    const body = event({ data: { itemId: 'not-an-id', title: 'x', type: 'task' } });
    const r = await deliver(body, { signature: sign(body) });
    expect(r.status).toBe(400);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('answers 200 and logs when the run cannot start: dsul does not retry, the poll catches it', async () => {
    const body = event();
    const r = await deliver(body, { signature: sign(body), runFails: true });
    expect(r.status).toBe(200);
    expect(r.logger.warn).toHaveBeenCalled();
  });

  it('parses only the hand-off event, and verifies in constant shape', () => {
    expect(parseHandoff(event())).toMatchObject({ itemId: ITEM, title: 'Book the dentist', type: 'task' });
    expect(parseHandoff(event({ event: 'tasks.updated' }))).toBeNull();
    expect(parseHandoff('not json')).toBeNull();
    expect(handoffSessionKey(ITEM)).toBe(`dsul:handoff:${ITEM}`);
    const body = event();
    expect(verifySignature(SECRET, body, sign(body))).toBe(true);
    expect(verifySignature('', body, sign(body, ''))).toBe(false);
  });
});
