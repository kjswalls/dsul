import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_CORS } from '@/lib/mcp-oauth/core';
import { callerAddress, takeAnonymous } from '@/lib/mcp-oauth/limit';
import { redeemCode, refresh } from '@/lib/mcp-oauth/store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/oauth/token — trades a code (with its PKCE verifier) or a refresh
 * token for an access token to /api/mcp. Form-encoded per RFC 6749, JSON
 * accepted too. Refresh tokens rotate: each is good once.
 * memory/plans/mcp-oauth.md.
 */
export async function POST(req: NextRequest) {
  if (!takeAnonymous(`token:${callerAddress(req)}`, 120)) {
    return fail('slow_down', 429);
  }
  const params = await readParams(req);
  if (!params) return fail('invalid_request');
  const clientId = params.get('client_id') ?? '';
  if (!clientId) return fail('invalid_client', 401);
  const db = createServiceClient();

  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = params.get('code');
    const redirectUri = params.get('redirect_uri');
    const verifier = params.get('code_verifier');
    if (!code || !redirectUri || !verifier) return fail('invalid_request');
    return answer(await redeemCode(db, { code, clientId, redirectUri, verifier }));
  }
  if (grantType === 'refresh_token') {
    const token = params.get('refresh_token');
    if (!token) return fail('invalid_request');
    return answer(await refresh(db, { refreshToken: token, clientId }));
  }
  return fail('unsupported_grant_type');
}

async function readParams(req: NextRequest): Promise<URLSearchParams | null> {
  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = (await req.json()) as Record<string, unknown>;
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string') out.set(k, v);
      return out;
    }
    return new URLSearchParams(await req.text());
  } catch {
    return null;
  }
}

function answer(result: Awaited<ReturnType<typeof redeemCode>>) {
  if (typeof result === 'string') {
    return fail(result, result === 'server_error' ? 503 : result === 'invalid_client' ? 401 : 400);
  }
  return NextResponse.json(result, { headers: { ...PUBLIC_CORS, Pragma: 'no-cache' } });
}

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: PUBLIC_CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
