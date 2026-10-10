// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorizationServerMetadata,
  isAllowedRedirectUri,
  parseScope,
  pkceMatches,
  protectedResourceMetadata,
  readRegistration,
  redirectUriMatches,
  wwwAuthenticate,
} from '@/lib/mcp-oauth/core';
import {
  getClient,
  issueCode,
  listGrants,
  redeemCode,
  refresh,
  registerClient,
  resolveAccessToken,
  revokeGrant,
  revokeToken,
  type TokenPair,
} from '@/lib/mcp-oauth/store';

/**
 * Signing in to /api/mcp with OAuth (memory/plans/mcp-oauth.md): the pure rules
 * in lib/mcp-oauth/core.ts, then the store's flows against an in-memory stand-in
 * for migration 069's tables.
 */

// A 43-character verifier, the shortest RFC 7636 allows, and its S256 challenge.
const VERIFIER = 'dBjftJeZ4CVP-mB92K1uhbUJU1p1r_wW1gFWFOEjXk0';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe('the rules', () => {
  it('checks PKCE S256, and nothing else', async () => {
    expect(await pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(await pkceMatches(`${VERIFIER}x`, CHALLENGE)).toBe(false);
    expect(await pkceMatches('short', createHash('sha256').update('short').digest('base64url'))).toBe(false);
  });

  it('reads an absent or unknown scope as full access, and only planner:read alone as read-only', () => {
    expect(parseScope(undefined)).toBe('planner');
    expect(parseScope('openid profile')).toBe('planner');
    expect(parseScope('planner:read')).toBe('planner:read');
    expect(parseScope('planner planner:read')).toBe('planner');
  });

  it('takes https, loopback http and app schemes as redirect URIs, never the dangerous ones', () => {
    for (const ok of [
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost:33418/callback',
      'http://127.0.0.1/cb',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
    ]) {
      expect(isAllowedRedirectUri(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://evil.example/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'https://claude.ai/cb#frag',
      'https://user:pw@claude.ai/cb',
      'not a url',
    ]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    }
  });

  it('matches a redirect URI exactly, but lets a loopback one pick its port', () => {
    const registered = ['https://claude.ai/cb', 'http://localhost:1234/callback'];
    expect(redirectUriMatches('https://claude.ai/cb', registered)).toBe(true);
    expect(redirectUriMatches('https://claude.ai/cb2', registered)).toBe(false);
    expect(redirectUriMatches('http://localhost:5555/callback', registered)).toBe(true);
    expect(redirectUriMatches('http://localhost:5555/other', registered)).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:5555/callback', registered)).toBe(false);
  });

  it('registers public clients only, with a name it will show and at most ten URIs', () => {
    expect(readRegistration({ client_name: '  Claude  ', redirect_uris: ['https://claude.ai/cb'] })).toEqual({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/cb'],
    });
    expect(readRegistration({ redirect_uris: ['https://x.example/cb'] })).toMatchObject({ client_name: 'An app' });
    expect(readRegistration({ redirect_uris: [] })).toEqual({ error: 'invalid_redirect_uri' });
    expect(readRegistration({ redirect_uris: ['http://evil.example/cb'] })).toEqual({ error: 'invalid_redirect_uri' });
    // Asked for a secret, it is registered public anyway (the route answers 'none').
    expect(
      readRegistration({ redirect_uris: ['https://x.example/cb'], token_endpoint_auth_method: 'client_secret_post' })
    ).toEqual({ client_name: 'An app', redirect_uris: ['https://x.example/cb'] });
  });

  it('publishes metadata that points the client at the right endpoints', () => {
    const as = authorizationServerMetadata('https://do.dsul.app');
    expect(as).toMatchObject({
      issuer: 'https://do.dsul.app',
      authorization_endpoint: 'https://do.dsul.app/oauth/authorize',
      token_endpoint: 'https://do.dsul.app/api/oauth/token',
      registration_endpoint: 'https://do.dsul.app/api/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });
    expect(protectedResourceMetadata('https://do.dsul.app')).toMatchObject({
      resource: 'https://do.dsul.app/api/mcp',
      authorization_servers: ['https://do.dsul.app'],
    });
    expect(wwwAuthenticate('https://do.dsul.app')).toBe(
      'Bearer resource_metadata="https://do.dsul.app/.well-known/oauth-protected-resource"'
    );
  });
});

/* ── An in-memory stand-in for 069's tables ─────────────────────────────── */

type Row = Record<string, unknown>;
const JOINS: Record<string, { table: string; local: string; remote: string }> = {
  mcp_oauth_grants: { table: 'mcp_oauth_grants', local: 'grant_id', remote: 'id' },
  mcp_oauth_clients: { table: 'mcp_oauth_clients', local: 'client_id', remote: 'client_id' },
};

function fakeDb() {
  const tables: Record<string, Row[]> = {
    mcp_oauth_clients: [],
    mcp_oauth_grants: [],
    mcp_oauth_codes: [],
    mcp_oauth_tokens: [],
  };
  let ids = 0;

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    let inserted: Row[] = [];
    let cols = '';
    let returning = false;

    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const shape = (r: Row) => {
      const out: Row = { ...r };
      for (const m of cols.matchAll(/(\w+)!inner\(([^)]*)\)/g)) {
        const j = JOINS[m[1]];
        out[m[1]] = tables[j.table].find((x) => x[j.remote] === r[j.local]) ?? null;
      }
      return out;
    };
    const run = (): Row[] => {
      if (op === 'insert') return inserted;
      const hit = rows();
      if (op === 'update') for (const r of hit) Object.assign(r, patch);
      return hit.map(shape);
    };

    const builder = {
      select(c = '') {
        cols = c;
        returning = true;
        return builder;
      },
      eq(k: string, v: unknown) {
        filters.push((r) => r[k] === v);
        return builder;
      },
      is(k: string, v: unknown) {
        filters.push((r) => (r[k] ?? null) === v);
        return builder;
      },
      gt(k: string, v: string) {
        filters.push((r) => String(r[k]) > v);
        return builder;
      },
      order() {
        return builder;
      },
      update(p: Row) {
        op = 'update';
        patch = p;
        return builder;
      },
      insert(r: Row | Row[]) {
        op = 'insert';
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `id-${++ids}`, created_at: new Date().toISOString(), ...x }));
        tables[table].push(...inserted);
        return builder;
      },
      async maybeSingle() {
        const out = run();
        return { data: out[0] ?? null, error: null };
      },
      async single() {
        const out = run();
        return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'none' } };
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        try {
          const out = run();
          return Promise.resolve({ data: returning ? out : null, error: null }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  return { db: { from } as never, tables };
}

async function signIn(scope: 'planner' | 'planner:read' = 'planner') {
  const { db, tables } = fakeDb();
  const client = (await registerClient(db, { client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }))!;
  const code = (await issueCode(db, {
    userId: 'user-1',
    clientId: client.clientId,
    redirectUri: 'https://claude.ai/cb',
    codeChallenge: CHALLENGE,
    scope,
  }))!;
  return { db, tables, client, code };
}

describe('the flow', () => {
  it('trades a code once, with the right verifier, for tokens that name the user', async () => {
    const { db, client, code } = await signIn();
    expect(await getClient(db, client.clientId)).toMatchObject({ clientName: 'Claude' });

    const pair = (await redeemCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      verifier: VERIFIER,
    })) as TokenPair;
    expect(pair.access_token).toMatch(/^dsul_at_/);
    expect(pair.refresh_token).toMatch(/^dsul_rt_/);
    expect(await resolveAccessToken(db, pair.access_token)).toMatchObject({ userId: 'user-1', scope: 'planner' });

    // Spent: the same code again gets nothing.
    expect(
      await redeemCode(db, { code, clientId: client.clientId, redirectUri: 'https://claude.ai/cb', verifier: VERIFIER })
    ).toBe('invalid_grant');
  });

  it('refuses a code with the wrong verifier, client or redirect', async () => {
    for (const bad of [
      { verifier: `${VERIFIER}x` },
      { clientId: 'dsul_client_other' },
      { redirectUri: 'https://claude.ai/elsewhere' },
    ]) {
      const { db, client, code } = await signIn();
      const args = { code, clientId: client.clientId, redirectUri: 'https://claude.ai/cb', verifier: VERIFIER, ...bad };
      expect(await redeemCode(db, args), JSON.stringify(bad)).toBe('invalid_grant');
    }
  });

  it('stores only hashes', async () => {
    const { db, tables, client, code } = await signIn();
    const pair = (await redeemCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      verifier: VERIFIER,
    })) as TokenPair;
    const stored = JSON.stringify(tables);
    for (const secret of [code, pair.access_token, pair.refresh_token]) expect(stored).not.toContain(secret);
  });

  it('rotates a refresh token: good once, then refused', async () => {
    const { db, client, code } = await signIn();
    const first = (await redeemCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      verifier: VERIFIER,
    })) as TokenPair;
    const second = (await refresh(db, { refreshToken: first.refresh_token, clientId: client.clientId })) as TokenPair;
    expect(second.access_token).not.toBe(first.access_token);
    expect(await refresh(db, { refreshToken: first.refresh_token, clientId: client.clientId })).toBe('invalid_grant');
    expect(await refresh(db, { refreshToken: second.refresh_token, clientId: 'dsul_client_other' })).toBe('invalid_grant');
  });

  it('expires an access token after its hour', async () => {
    const { db, client, code } = await signIn();
    const pair = (await redeemCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      verifier: VERIFIER,
    })) as TokenPair;
    expect(await resolveAccessToken(db, pair.access_token, new Date(Date.now() + 61 * 60 * 1000))).toBeNull();
  });

  it('lists the app in Settings, and Disconnect stops every token at once', async () => {
    const { db, client, code } = await signIn('planner:read');
    const pair = (await redeemCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      verifier: VERIFIER,
    })) as TokenPair;
    const apps = (await listGrants(db, 'user-1'))!;
    expect(apps).toEqual([expect.objectContaining({ name: 'Claude', scope: 'planner:read' })]);

    // Someone else's id does nothing.
    expect(await revokeGrant(db, 'user-2', apps[0].id)).toBe(false);
    expect(await resolveAccessToken(db, pair.access_token)).not.toBeNull();

    expect(await revokeGrant(db, 'user-1', apps[0].id)).toBe(true);
    expect(await resolveAccessToken(db, pair.access_token)).toBeNull();
    expect(await refresh(db, { refreshToken: pair.refresh_token, clientId: client.clientId })).toBe('invalid_grant');
    expect(await listGrants(db, 'user-1')).toEqual([]);
  });

  it('lets the app sign itself out (RFC 7009), which disconnects it', async () => {
    const { db, client, code } = await signIn();
    const pair = (await redeemCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      verifier: VERIFIER,
    })) as TokenPair;
    await revokeToken(db, pair.refresh_token);
    expect(await resolveAccessToken(db, pair.access_token)).toBeNull();
  });

  it('keeps one grant per app: signing in again updates its scope', async () => {
    const { db, client } = await signIn('planner:read');
    await issueCode(db, {
      userId: 'user-1',
      clientId: client.clientId,
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: CHALLENGE,
      scope: 'planner',
    });
    expect(await listGrants(db, 'user-1')).toEqual([expect.objectContaining({ scope: 'planner' })]);
  });
});

describe('replays', () => {
  const redeem = (db: never, client: { clientId: string }, code: string, redirectUri = 'https://claude.ai/cb') =>
    redeemCode(db, { code, clientId: client.clientId, redirectUri, verifier: VERIFIER });

  it('disconnects the app when a spent code comes back', async () => {
    const { db, client, code } = await signIn();
    const pair = (await redeem(db, client, code)) as TokenPair;
    expect(await redeem(db, client, code)).toBe('invalid_grant');
    expect(await resolveAccessToken(db, pair.access_token)).toBeNull();
  });

  it('disconnects the app when a rotated refresh token comes back', async () => {
    const { db, client, code } = await signIn();
    const first = (await redeem(db, client, code)) as TokenPair;
    const second = (await refresh(db, { refreshToken: first.refresh_token, clientId: client.clientId })) as TokenPair;
    expect(await refresh(db, { refreshToken: first.refresh_token, clientId: client.clientId })).toBe('invalid_grant');
    expect(await resolveAccessToken(db, second.access_token)).toBeNull();
    expect(await refresh(db, { refreshToken: second.refresh_token, clientId: client.clientId })).toBe('invalid_grant');
  });

  it('wants the exact redirect URI at the token endpoint, port and all', async () => {
    const { db } = fakeDb();
    const client = (await registerClient(db, { client_name: 'Claude Code', redirect_uris: ['http://localhost:1234/callback'] }))!;
    const code = (await issueCode(db, {
      userId: 'user-1',
      clientId: client.clientId,
      redirectUri: 'http://localhost:5555/callback',
      codeChallenge: CHALLENGE,
      scope: 'planner',
    }))!;
    expect(await redeem(db, client, code, 'http://localhost:6666/callback')).toBe('invalid_grant');
  });
});
