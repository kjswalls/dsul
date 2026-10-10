import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_CORS } from '@/lib/mcp-oauth/core';
import { revokeToken } from '@/lib/mcp-oauth/store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/oauth/revoke — RFC 7009. An app signing out disconnects itself: the
 * whole grant goes, as if the user had pressed Disconnect in Settings. Always
 * 200, whether or not the token was known, as the RFC asks.
 */
export async function POST(req: NextRequest) {
  const type = req.headers.get('content-type') ?? '';
  let token: string | null = null;
  try {
    token = type.includes('application/json')
      ? ((await req.json()) as { token?: unknown })?.token as string | null
      : new URLSearchParams(await req.text()).get('token');
  } catch {
    /* an unreadable body revokes nothing */
  }
  if (typeof token === 'string' && token) await revokeToken(createServiceClient(), token).catch(() => {});
  return new NextResponse(null, { status: 200, headers: PUBLIC_CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
