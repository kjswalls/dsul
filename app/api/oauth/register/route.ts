import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_CORS, readRegistration } from '@/lib/mcp-oauth/core';
import { callerAddress, takeAnonymous } from '@/lib/mcp-oauth/limit';
import { registerClient } from '@/lib/mcp-oauth/store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/oauth/register — dynamic client registration (RFC 7591), how Claude,
 * Cursor and other MCP clients introduce themselves before the user's sign-in.
 * Anonymous by design; a registered app can do nothing until a signed-in user
 * says yes on /oauth/authorize. Public clients only (PKCE, no secret).
 * memory/plans/mcp-oauth.md.
 */
export async function POST(req: NextRequest) {
  if (!takeAnonymous(`register:${callerAddress(req)}`, 30)) {
    return NextResponse.json({ error: 'slow_down' }, { status: 429, headers: PUBLIC_CORS });
  }
  const body = await req.json().catch(() => null);
  const reg = readRegistration(body);
  if ('error' in reg) {
    return NextResponse.json({ error: reg.error }, { status: 400, headers: PUBLIC_CORS });
  }
  const client = await registerClient(createServiceClient(), reg);
  if (!client) return NextResponse.json({ error: 'server_error' }, { status: 503, headers: PUBLIC_CORS });
  return NextResponse.json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { status: 201, headers: PUBLIC_CORS }
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
