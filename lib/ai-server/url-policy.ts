/**
 * Where a user-supplied model base URL may point, and the one `fetch` every
 * upstream call goes through.
 *
 * Server-only. https only, public hosts only (no private, loopback,
 * link-local, CGNAT or metadata), `redirect: 'error'`, checked on save AND
 * before every request; a custom host's response bodies are byte-capped
 * inside `guardedFetch` (design 1.4).
 *
 * Stricter than the OpenClaw gateway guard (lib/openclaw-gateway.ts), which
 * allows private and Tailscale ranges on purpose: a gateway is the user's own
 * machine, while a model host is any address a user can type, and the server
 * sends that user's key to it.
 *
 * Residual (design R2): the DNS pre-check does not pin the address undici then
 * connects to, so a rebinding host the user typed themselves could still
 * answer differently the second time.
 */

import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { ProviderError } from './errors';

export type UrlPolicy =
  | { ok: true; baseUrl: string; origin: string; hostname: string }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'not_https'
        | 'credentials'
        | 'query'
        | 'too_long'
        | 'blocked_host'
        | 'blocked_address';
    };

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** Byte caps on the DECODED response body of a user-chosen (custom) host. */
export const CUSTOM_RESPONSE_CAPS: { body: 2_000_000; stream: 4_000_000 } = {
  body: 2_000_000,
  stream: 4_000_000,
};

const MAX_URL_LENGTH = 2048;
const DNS_TIMEOUT_MS = 3_000;

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

/**
 * Every range a model request must never reach.
 *
 * NEVER add `::ffff:0:0/96` here. Node's BlockList folds IPv4-mapped IPv6 into
 * the IPv4 rules (`::ffff:127.0.0.1` already matches 127/8), and the mapped
 * prefix itself matches EVERY IPv4 address, `8.8.8.8` included: it would block
 * the whole public internet. A test pins `8.8.8.8` as allowed for that reason.
 */
let blockList: BlockList | null = null;
function blocked(): BlockList {
  if (blockList) return blockList;
  const bl = new BlockList();
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [net, prefix] of v4) bl.addSubnet(net, prefix, 'ipv4');
  const v6: Array<[string, number]> = [
    ['::', 128],
    ['::1', 128],
    // IPv4-compatible (deprecated), e.g. `::7f00:1`. Unlike the mapped prefix
    // above, this does NOT match plain IPv4 addresses (verified on Node 22).
    ['::', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ];
  for (const [net, prefix] of v6) bl.addSubnet(net, prefix, 'ipv6');
  blockList = bl;
  return bl;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Fails closed: anything that is not a well-formed IP address counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  try {
    if (typeof ip !== 'string') return true;
    // A zone id (`fe80::1%eth0`) makes BlockList miss the link-local rule.
    const bare = stripBrackets(ip.trim()).replace(/%.*$/, '');
    const family = isIP(bare);
    if (family === 4) return blocked().check(bare, 'ipv4');
    if (family === 6) return blocked().check(bare, 'ipv6');
    return true;
  } catch {
    return true;
  }
}

function isBlockedHostname(host: string): boolean {
  if (host === '' || host === 'localhost' || host === 'metadata') return true;
  if (host.includes('metadata.google.internal')) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  // A single label (`intranet`, `gateway`) resolves through search domains.
  return !host.includes('.');
}

/**
 * Normalization: strip a trailing `/`, then a trailing `/chat/completions` or
 * `/models`, then `/` again, so a pasted endpoint URL lands on its base.
 */
function normalizePath(pathname: string): string {
  let p = pathname.replace(/\/+$/, '');
  p = p.replace(/\/(chat\/completions|models)$/i, '');
  return p.replace(/\/+$/, '');
}

export function checkModelBaseUrl(raw: unknown): UrlPolicy {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
  const input = raw.trim();
  if (input === '') return { ok: false, reason: 'invalid' };
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
    return { ok: false, reason: 'query' };
  }

  // WHATWG has already folded `0x7f.1` and `2130706433` to `127.0.0.1`, and
  // serializes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`.
  const hostname = url.hostname;
  const bare = stripBrackets(hostname).replace(/\.$/, '');
  if (isIP(bare) !== 0) {
    if (isBlockedAddress(bare)) return { ok: false, reason: 'blocked_address' };
  } else if (isBlockedHostname(bare.toLowerCase())) {
    return { ok: false, reason: 'blocked_host' };
  }

  const baseUrl = url.origin + normalizePath(url.pathname);
  if (baseUrl.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, baseUrl, origin: url.origin, hostname };
}

const defaultLookup: LookupFn = async (host) => {
  const found = await dns.lookup(host, { all: true, verbatim: true });
  return found.map((a) => ({ address: a.address, family: a.family }));
};

/** Throws ProviderError('blocked_url' | 'network'). */
export async function assertPublicHost(hostname: string, lookup: LookupFn = defaultLookup): Promise<void> {
  const host = stripBrackets(String(hostname ?? '')).replace(/\.$/, '');
  if (host === '') throw new ProviderError('blocked_url');

  // An IP literal needs no lookup, and an injected lookup may not echo one.
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new ProviderError('blocked_url');
    return;
  }
  if (isBlockedHostname(host.toLowerCase())) throw new ProviderError('blocked_url');

  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('network')), DNS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new ProviderError('network');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) throw new ProviderError('network');
  // EVERY address must be public: a host that answers [public, private] is
  // one connection attempt away from the private one.
  if (addresses.some((a) => isBlockedAddress(a?.address))) throw new ProviderError('blocked_url');
}

function resolveUrl(input: RequestInfo | URL): URL {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    throw new ProviderError('blocked_url');
  }
}

/** Statuses whose Response may not carry a body; they are returned untouched. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function capBody(res: Response, caps: { body: number; stream: number }): Response {
  if (res.body === null || NULL_BODY_STATUSES.has(res.status)) return res;
  const isStream = (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
  const limit = isStream ? caps.stream : caps.body;

  let seen = 0;
  let over = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (over) return;
      seen += chunk.byteLength;
      if (seen > limit) {
        over = true;
        // The same object reaches `Response.json()`, `text()` and a stream
        // reader, and both SDKs rethrow it, so `toProviderError` passes it
        // through as `upstream`.
        controller.error(new ProviderError('upstream'));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  const capped = new Response(res.body.pipeThrough(counter), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  try {
    Object.defineProperty(capped, 'url', { value: res.url });
  } catch {
    // `url` is informational only (SDK debug logs); losing it is harmless.
  }
  return capped;
}

/**
 * The fetch every upstream model call goes through (design 1.4):
 *   1. resolve the URL;
 *   2. refuse any origin but `opts.origin`, which pins the key to one host;
 *   3. for a user-chosen host, check DNS resolves only to public addresses;
 *   4. keep only allowlisted request headers, when an allowlist is given;
 *   5. fetch with `redirect: 'error'`, so a 3xx cannot carry the key elsewhere;
 *   6. byte-cap the decoded body, when caps are given.
 */
export function guardedFetch(opts: {
  origin: string;
  checkDns: boolean;
  lookup?: LookupFn;
  /** Anthropic: strips ANTHROPIC_CUSTOM_HEADERS (design 4.3). */
  headerAllowlist?: (name: string) => boolean;
  /** Byte caps on the DECODED response body. Set for every user-chosen host (custom). */
  maxResponseBytes?: { body: number; stream: number };
}): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input);
    if (url.origin !== opts.origin) throw new ProviderError('blocked_url');
    if (opts.checkDns) await assertPublicHost(url.hostname, opts.lookup);

    let headers = init?.headers;
    if (opts.headerAllowlist) {
      const merged = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
      const kept = new Headers();
      merged.forEach((value, name) => {
        if (opts.headerAllowlist?.(name.toLowerCase())) kept.set(name, value);
      });
      headers = kept;
    }

    const res = await globalThis.fetch(input, {
      ...init,
      ...(headers !== undefined ? { headers } : {}),
      redirect: 'error',
    });
    return opts.maxResponseBytes ? capBody(res, opts.maxResponseBytes) : res;
  };
  return guarded as typeof fetch;
}
