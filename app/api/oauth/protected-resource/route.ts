import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_CORS, originOf, protectedResourceMetadata } from '@/lib/mcp-oauth/core';

/**
 * /.well-known/oauth-protected-resource (a rewrite in next.config.mjs): RFC 9728,
 * the document /api/mcp's 401 points at. It names this origin as the
 * authorization server. memory/plans/mcp-oauth.md.
 */
export function GET(req: NextRequest) {
  return NextResponse.json(protectedResourceMetadata(originOf(req)), { headers: PUBLIC_CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
