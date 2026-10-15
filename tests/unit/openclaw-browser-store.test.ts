import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * This browser's pairing with the person's OpenClaw gateway, as the app sees
 * it (lib/openclaw-browser-store.ts), and what the gate makes of it.
 */

vi.mock('@/lib/openclaw-browser/link', async (orig) => {
  const real = await orig<typeof import('@/lib/openclaw-browser/link')>();
  class GatewayLink {
    started = false;
    constructor(public opts: { userId: string; url: string }) {}
    get userId() {
      return this.opts.userId;
    }
    get url() {
      return this.opts.url;
    }
    start() {
      this.started = true;
    }
    stop() {}
  }
  return { ...real, GatewayLink };
});

import { readDevice, writeDevice, generateDeviceKeys, deleteDevice } from '@/lib/openclaw-browser/device-store';
import {
  blockedAsMixedContent,
  browserLink,
  gatewaySocketUrl,
  useOpenClawBrowserStore,
} from '@/lib/openclaw-browser-store';
import { resolveAICapabilities } from '@/lib/ai-registry';
import { allowOriginCommand, approveCommand, SETUP_FAILURE_COPY } from '@/lib/openclaw-browser-copy';
import { browserMessage } from '@/lib/chat-transport';

const store = () => useOpenClawBrowserStore.getState();

beforeEach(async () => {
  store().reset();
  await deleteDevice('u1');
  await deleteDevice('u2');
});

describe('gatewaySocketUrl', () => {
  it('takes what the Control UI shows and gives the socket', () => {
    expect(gatewaySocketUrl('wss://box.tail1.ts.net')).toBe('wss://box.tail1.ts.net');
    expect(gatewaySocketUrl('https://box.tail1.ts.net/')).toBe('wss://box.tail1.ts.net');
    expect(gatewaySocketUrl('box.tail1.ts.net')).toBe('wss://box.tail1.ts.net');
    expect(gatewaySocketUrl('http://127.0.0.1:18789')).toBe('ws://127.0.0.1:18789');
  });

  it('refuses anything that is not a gateway address', () => {
    expect(gatewaySocketUrl('')).toBeNull();
    expect(gatewaySocketUrl('ftp://x')).toBeNull();
    expect(gatewaySocketUrl('wss://user:pw@box')).toBeNull();
    expect(gatewaySocketUrl('not a url at all')).toBeNull();
  });
});

describe('blockedAsMixedContent', () => {
  it('only plain ws:// to another machine, from an https page', () => {
    expect(blockedAsMixedContent('ws://box.lan:18789', 'https:')).toBe(true);
    expect(blockedAsMixedContent('ws://127.0.0.1:18789', 'https:')).toBe(false);
    expect(blockedAsMixedContent('ws://localhost:18789', 'https:')).toBe(false);
    expect(blockedAsMixedContent('wss://box.lan', 'https:')).toBe(false);
    expect(blockedAsMixedContent('ws://box.lan:18789', 'http:')).toBe(false);
  });
});

describe('the pairing record', () => {
  it('keeps the device key non-extractable', async () => {
    const keys = await generateDeviceKeys();
    expect(keys.privateKey.extractable).toBe(false);
  });

  it('is paired only once a device token was issued, and only for its own account', async () => {
    const keys = await generateDeviceKeys();
    await writeDevice({ userId: 'u1', url: 'wss://box', keys, deviceToken: null, pairedAt: null });
    await store().hydrate('u1');
    expect(store().paired).toBeNull();

    await writeDevice({ userId: 'u1', url: 'wss://box', keys, deviceToken: { token: 't', scopes: ['operator.write'] }, pairedAt: 5 });
    await store().hydrate('u1');
    expect(store().paired).toMatchObject({ url: 'wss://box', pairedAt: 5 });
    expect(store().paired?.deviceId).toMatch(/^[0-9a-f]{64}$/);

    await store().hydrate('u2');
    expect(store().paired).toBeNull();
  });

  it('Forget this browser deletes the key, the token and the address', async () => {
    const keys = await generateDeviceKeys();
    await writeDevice({ userId: 'u1', url: 'wss://box', keys, deviceToken: { token: 't', scopes: [] }, pairedAt: 5 });
    await store().hydrate('u1');
    await store().forget();
    expect(store().paired).toBeNull();
    expect(await readDevice('u1')).toBeNull();
  });

  it('starts one live link for a paired browser, none otherwise', async () => {
    expect(browserLink()).toBeNull();
    const keys = await generateDeviceKeys();
    await writeDevice({ userId: 'u1', url: 'wss://box', keys, deviceToken: { token: 't', scopes: [] }, pairedAt: 5 });
    await store().hydrate('u1');
    const a = browserLink();
    expect(a).not.toBeNull();
    expect(browserLink()).toBe(a);
  });
});

describe('setup refusals before any socket', () => {
  it('a bad address, a missing token, plain ws:// from https', async () => {
    await store().hydrate('u1');
    await store().startSetup({ url: 'ftp://x', token: 't' });
    expect(store().setup).toEqual({ step: 'failed', why: 'address' });
    await store().startSetup({ url: 'wss://box', token: '  ' });
    expect(store().setup).toEqual({ step: 'failed', why: 'token' });
  });

  it('has words for every failure', () => {
    for (const why of ['address', 'insecure', 'unreachable', 'origin', 'token', 'unpaired', 'unsupported', 'other'] as const) {
      expect(SETUP_FAILURE_COPY[why]).toMatch(/\S/);
      expect(SETUP_FAILURE_COPY[why]).not.toContain('—');
    }
  });
});

describe('the commands', () => {
  it('allows exactly this site', () => {
    expect(allowOriginCommand('https://do.dsul.app')).toBe(
      `openclaw config set gateway.controlUi.allowedOrigins '["https://do.dsul.app"]' --strict-json`
    );
    expect(approveCommand('abc')).toBe('openclaw devices approve abc');
    expect(approveCommand(null)).toBe('openclaw devices list');
  });
});

describe('the gate', () => {
  const base = {
    phase: 'ready' as const,
    available: true,
    model: null,
    openclaw: { gateway: false, agent: false, agentId: null },
    choice: 'openclaw' as const,
    aiHidden: false,
  };

  it('a paired browser answers as OpenClaw, through the browser', () => {
    const caps = resolveAICapabilities({ ...base, browserChat: true });
    expect(caps.target).toBe('openclaw');
    expect(caps.openclawTransport).toBe('browser');
    expect(caps.askInvite).toBe(false);
  });

  it('wins over the server gateway and the plugin on this browser', () => {
    const caps = resolveAICapabilities({
      ...base,
      openclaw: { ...base.openclaw, gateway: true },
      browserChat: true,
    });
    expect(caps.openclawTransport).toBe('browser');
  });

  it('nothing paired is nothing', () => {
    const caps = resolveAICapabilities({ ...base, browserChat: false });
    expect(caps.openclawTransport).toBeNull();
    expect(caps.canChat).toBe(false);
  });
});

describe('browserMessage', () => {
  const input = { message: 'What now?', context: '## Today\n- Dentist', contextBeyond: '## Braindump\n- Gift' };

  it('the first send carries the whole planner and the person’s instructions', () => {
    const { message, sent } = browserMessage(input, 'Be brief.', undefined);
    expect(message).toContain('<dsul_planner>');
    expect(message).toContain('## Today');
    expect(message).toContain('## Braindump');
    expect(message).toContain('Be brief.');
    expect(message.endsWith('What now?')).toBe(true);
    expect(sent).toBe(input.context);
  });

  it('a later send with the same day carries only the words', () => {
    expect(browserMessage(input, 'Be brief.', input.context).message).toBe('What now?');
  });

  it('a changed day is sent again, without the rest', () => {
    const { message } = browserMessage({ ...input, context: '## Today\n- Dentist\n- Gym' }, 'Be brief.', input.context);
    expect(message).toContain('- Gym');
    expect(message).not.toContain('## Braindump');
  });
});
