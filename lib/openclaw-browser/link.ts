import {
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  readConnectErrorDetailCode,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceIdentity,
} from '@openclaw/gateway-client/browser';
import { readDevice, updateDevice } from './device-store';
import { thisBrowserName } from './device-name';

/**
 * One browser's connection to the user's OpenClaw gateway: the documented
 * third-party browser client (docs.openclaw.ai/gateway/clients), with nothing
 * of dsul's server in the path.
 *
 * Setup hands it the gateway's shared token once. The gateway answers
 * PAIRING_REQUIRED, the person approves this browser on their own machine
 * (`openclaw devices approve`), and the next connect is let in and issued a
 * DEVICE token, which the device store keeps. The shared token is then dropped:
 * it lives in this object's memory for the length of setup and is never
 * written anywhere or sent anywhere but the gateway.
 *
 * Every connect after that signs the gateway's challenge with the device key
 * (non-extractable, lib/openclaw-browser/device-store.ts) and presents the
 * device token. The token without the key gets nobody in.
 *
 * What an approved browser can do, measured against a real gateway
 * (memory/plans/openclaw-browser-chat.md): `operator.write` is the narrowest
 * grant that can chat on a personal gateway, and it also reads sessions, logs
 * and redacted config and can call the agent's tools. It cannot change
 * config, approve devices or answer exec approvals. Setup says so in plain
 * words (components/settings/openclaw-browser-chat.tsx).
 */

/**
 * OpenClaw's own browser chat identity. The id, mode and platform stay fixed:
 * the gateway pins the platform, so changing it asks for approval again. The
 * display name is this browser's own (lib/openclaw-browser/device-name.ts), so
 * OpenClaw's device list can tell two paired browsers apart.
 */
const clientFor = (displayName: string) =>
  Object.freeze({
    id: 'webchat',
    mode: 'webchat',
    displayName,
    version: '1',
    platform: 'web',
  });

/**
 * What dsul asks for. Never `operator.admin`, `operator.pairing` or
 * `operator.approvals`: an exec approval is the person's own call, made in
 * OpenClaw, never one a dsul tab can answer.
 */
export const BROWSER_SCOPES = Object.freeze(['operator.read', 'operator.write']);

const ROLE = 'operator';
const PROTOCOL = 4;

/** While approval is pending, ask again this often. */
const PAIRING_POLL_MS = 2_500;
/** How long a send waits for a link that is still connecting. */
const READY_WAIT_MS = 12_000;

export type LinkRefusal =
  /** The gateway does not list this site in gateway.controlUi.allowedOrigins. */
  | 'origin'
  /** Setup: the shared token was wrong or missing. */
  | 'token'
  /** The pairing is gone: removed, revoked, or the shared token was rotated. */
  | 'unpaired'
  | 'other';

export type LinkStatus =
  | { kind: 'connecting' }
  /** Waiting for `openclaw devices approve <requestId>`. */
  | { kind: 'pairing'; requestId: string | null }
  | { kind: 'ready' }
  /** Couldn't reach it, or it dropped; retrying on its own. */
  | { kind: 'offline' }
  /** Stopped: something only the person can fix. */
  | { kind: 'refused'; why: LinkRefusal }
  | { kind: 'stopped' };

export interface ChatTurnRequest {
  sessionKey: string;
  agentId: string | null;
  message: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
}

export type ChatTurnResult =
  | { status: 'complete'; content: string }
  | { status: 'stopped'; content: string }
  | { status: 'error'; content: string; reason: 'offline' | 'unpaired' | 'agent' | 'empty' };

interface ChatEventPayload {
  runId?: unknown;
  sessionKey?: unknown;
  state?: unknown;
  deltaText?: unknown;
  message?: { content?: unknown } | null;
}

const UNPAIRED_CODES = new Set([
  'AUTH_DEVICE_TOKEN_MISMATCH',
  'DEVICE_AUTH_INVALID',
  'DEVICE_AUTH_DEVICE_ID_MISMATCH',
  'DEVICE_AUTH_SIGNATURE_INVALID',
  'DEVICE_AUTH_PUBLIC_KEY_INVALID',
]);
const TOKEN_CODES = new Set([
  'AUTH_REQUIRED',
  'AUTH_UNAUTHORIZED',
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_MISMATCH',
  'AUTH_PASSWORD_MISSING',
  'AUTH_PASSWORD_MISMATCH',
]);

/** A refusal's reason, from the gateway's structured details. Pure. */
export function refusalFor(code: string | null, setup: boolean): LinkRefusal | 'pairing' | 'later' {
  if (code === 'PAIRING_REQUIRED') return 'pairing';
  if (code === 'AUTH_RATE_LIMITED') return 'later';
  if (code === 'CONTROL_UI_ORIGIN_NOT_ALLOWED') return 'origin';
  if (code && UNPAIRED_CODES.has(code)) return 'unpaired';
  // With no shared token in hand, a credentials refusal means the device's own
  // token stopped working, which is the same thing to the person: set up again.
  if (code && TOKEN_CODES.has(code)) return setup ? 'token' : 'unpaired';
  return 'other';
}

/** The text of a final chat message, however the gateway shaped it. Pure. */
export function messageText(message: ChatEventPayload['message']): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('');
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function identityFrom(keys: CryptoKeyPair): Promise<GatewayBrowserDeviceIdentity> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const deviceId = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return {
    deviceId,
    publicKey: b64url(raw),
    sign: async (payload: string) =>
      b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, new TextEncoder().encode(payload)))),
  };
}

export interface LinkOptions {
  userId: string;
  url: string;
  /** Setup only: the gateway's shared token, used until the first approved connect. */
  sharedToken?: string;
  onStatus?: (status: LinkStatus) => void;
  /** How OpenClaw's device list names this browser. Defaults to `thisBrowserName()`. */
  displayName?: string;
}

export class GatewayLink {
  readonly userId: string;
  readonly url: string;
  private sharedToken: string | undefined;
  private readonly onStatus: (status: LinkStatus) => void;
  private readonly identity: ReturnType<typeof clientFor>;
  private client: GatewayProtocolClient<GatewayBrowserDeviceAuthPlan> | null = null;
  private current: LinkStatus = { kind: 'connecting' };
  private readonly waiters = new Set<() => void>();
  private rid = 0;

  constructor(opts: LinkOptions) {
    this.userId = opts.userId;
    this.url = opts.url;
    this.sharedToken = opts.sharedToken || undefined;
    this.onStatus = opts.onStatus ?? (() => {});
    this.identity = clientFor(opts.displayName ?? thisBrowserName());
  }

  get status(): LinkStatus {
    return this.current;
  }

  private set(status: LinkStatus) {
    this.current = status;
    this.onStatus(status);
    for (const wake of [...this.waiters]) wake();
  }

  start(): void {
    if (this.client) return;
    const userId = this.userId;
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => {
        const record = await readDevice(userId);
        return record ? identityFrom(record.keys) : null;
      },
      tokenStore: {
        load: async ({ role }) => {
          if (role !== ROLE) return null;
          return (await readDevice(userId))?.deviceToken ?? null;
        },
        store: async ({ role, token, scopes }) => {
          if (role !== ROLE) return;
          await updateDevice(userId, (r) => ({ ...r, deviceToken: { token, scopes }, pairedAt: r.pairedAt ?? Date.now() }));
        },
        clear: async ({ role }) => {
          if (role !== ROLE) return;
          await updateDevice(userId, (r) => ({ ...r, deviceToken: null }));
        },
      },
    });

    const client = new GatewayProtocolClient<GatewayBrowserDeviceAuthPlan>({
      createSocket: (h) => {
        const ws = new WebSocket(this.url);
        ws.onopen = () => h.open();
        ws.onmessage = (e) => h.message(String(e.data));
        ws.onclose = (e) => h.close(e.code, e.reason);
        ws.onerror = () => h.error(new Error('websocket error'));
        return {
          isOpen: () => ws.readyState === WebSocket.OPEN,
          send: (d) => ws.send(d),
          close: (c, r) => ws.close(c ?? 1000, r),
        };
      },
      createRequestId: () => `dsul-${++this.rid}`,
      handshake: { mode: 'require-challenge', timeoutMs: 15_000 },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
      buildConnectPlan: ({ nonce, challengeTs }) =>
        lifecycle.buildPlan({
          client: this.identity as never,
          role: ROLE,
          defaultScopes: BROWSER_SCOPES,
          token: this.sharedToken,
          nonce,
          challengeTs,
        }),
      buildConnectParams: (plan) => ({
        minProtocol: PROTOCOL,
        maxProtocol: PROTOCOL,
        client: this.identity,
        role: plan.role,
        scopes: plan.scopes,
        caps: [],
        device: plan.device,
        auth: plan.auth,
      }),
      onConnectHello: (hello, ctx) => lifecycle.acceptHello(hello, ctx.plan),
      onHello: () => {
        // Approved and issued a device token: the shared token's work is done.
        this.sharedToken = undefined;
        this.set({ kind: 'ready' });
      },
      onConnectFailure: (err, ctx) => {
        const code = readConnectErrorDetailCode(err.details);
        const why = refusalFor(code, this.sharedToken !== undefined);
        if (why === 'pairing') {
          const details = (err.details ?? {}) as { requestId?: unknown };
          this.set({ kind: 'pairing', requestId: typeof details.requestId === 'string' ? details.requestId : null });
          return { closeCode: 4000, closeReason: 'pairing pending', reconnectDelayMs: PAIRING_POLL_MS };
        }
        if (why === 'later') {
          this.set({ kind: 'offline' });
          return { closeCode: 4000, closeReason: 'rate limited', reconnectDelayMs: 30_000 };
        }
        if (why === 'unpaired') void lifecycle.clearStoredToken(ctx.plan).catch(() => {});
        this.set({ kind: 'refused', why });
        return { closeCode: 4000, closeReason: 'refused', stop: true };
      },
      resolveClose: (ctx) => {
        if (this.current.kind === 'refused' || this.current.kind === 'stopped') return { retry: false, notify: false };
        // Pairing keeps asking on its own schedule; anything else is the
        // gateway out of reach (asleep, off the tailnet, restarting).
        if (this.current.kind !== 'pairing' || ctx.helloReceived) this.set({ kind: 'offline' });
        const delay = ctx.connectFailure?.reconnectDelayMs;
        return { retry: true, notify: false, ...(delay !== undefined ? { reconnectDelayMs: delay } : {}) };
      },
      onConnectPlanError: () => {
        this.set({ kind: 'refused', why: 'unpaired' });
        return { closeCode: 4000, closeReason: 'no device key', stop: true };
      },
    });
    this.client = client;
    this.set({ kind: 'connecting' });
    client.start();
  }

  stop(): void {
    this.sharedToken = undefined;
    const client = this.client;
    this.client = null;
    if (this.current.kind !== 'refused') this.set({ kind: 'stopped' });
    try {
      client?.stop();
    } catch {
      // Already closed.
    }
  }

  /** Resolves true once ready, false on a refusal, a stop, the deadline or the signal. */
  private waitReady(signal: AbortSignal, ms = READY_WAIT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        const k = this.current.kind;
        if (k === 'ready') return done(true);
        if (k === 'refused' || k === 'stopped' || signal.aborted) return done(false);
      };
      const timer = setTimeout(() => done(false), ms);
      const onAbort = () => done(false);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      signal.addEventListener('abort', onAbort);
      this.waiters.add(check);
      check();
    });
  }

  /** One chat turn on one session. Never rejects. */
  async chat(req: ChatTurnRequest): Promise<ChatTurnResult> {
    const { signal } = req;
    if (!this.client) this.start();
    if (!(await this.waitReady(signal))) {
      if (signal.aborted) return { status: 'stopped', content: '' };
      return { status: 'error', content: '', reason: this.current.kind === 'refused' ? 'unpaired' : 'offline' };
    }
    const client = this.client!;
    const runId = crypto.randomUUID();
    const accepted = new Set([runId]);
    const early: ChatEventPayload[] = [];
    let acked = false;
    let content = '';

    return new Promise<ChatTurnResult>((resolve) => {
      let settled = false;
      const finish = (result: ChatTurnResult) => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(onLink);
        resolve(result);
      };
      const onPayload = (p: ChatEventPayload) => {
        if (typeof p.runId !== 'string' || !accepted.has(p.runId)) {
          if (!acked && typeof p.runId === 'string') early.push(p);
          return;
        }
        if (p.state === 'delta' && typeof p.deltaText === 'string' && p.deltaText) {
          content += p.deltaText;
          req.onDelta(p.deltaText);
        } else if (p.state === 'final') {
          // The final message is the whole reply; fill in anything the
          // deltas missed (a reconnect mid-stream).
          const whole = messageText(p.message);
          if (whole.startsWith(content) && whole.length > content.length) {
            const rest = whole.slice(content.length);
            content = whole;
            req.onDelta(rest);
          } else if (!content) content = whole;
          finish(content ? { status: 'complete', content } : { status: 'error', content, reason: 'empty' });
        } else if (p.state === 'error') {
          finish({ status: 'error', content, reason: 'agent' });
        } else if (p.state === 'aborted') {
          finish({ status: 'stopped', content });
        }
      };
      const off = client.addEventListener((ev) => {
        if (ev.event === 'chat') onPayload((ev.payload ?? {}) as ChatEventPayload);
      });
      // The link dropping mid-reply ends the turn with what arrived.
      const onLink = () => {
        const k = this.current.kind;
        if (k === 'refused') finish({ status: 'error', content, reason: 'unpaired' });
        else if (k === 'offline' || k === 'stopped') finish({ status: 'error', content, reason: 'offline' });
      };
      this.waiters.add(onLink);
      const onAbort = () => {
        void client
          .request('chat.abort', { sessionKey: req.sessionKey, runId, ...(req.agentId ? { agentId: req.agentId } : {}) })
          .catch(() => {});
        finish({ status: 'stopped', content });
      };
      signal.addEventListener('abort', onAbort);

      client
        .request<{ runId?: unknown }>('chat.send', {
          sessionKey: req.sessionKey,
          ...(req.agentId ? { agentId: req.agentId } : {}),
          message: req.message,
          idempotencyKey: runId,
        })
        .then((ack) => {
          if (typeof ack?.runId === 'string') accepted.add(ack.runId);
          acked = true;
          for (const p of early.splice(0)) onPayload(p);
        })
        .catch(() => finish({ status: 'error', content, reason: this.current.kind === 'ready' ? 'agent' : 'offline' }));
    });
  }
}
