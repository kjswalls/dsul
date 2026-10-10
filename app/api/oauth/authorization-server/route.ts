import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_CORS, authorizationServerMetadata, originOf } from '@/lib/mcp-oauth/core';

/**
 * /.well-known/oauth-authorization-server (a rewrite in next.config.mjs): RFC 8414,
 * where an MCP client finds the register, authorize and token endpoints.
 * memory/plans/mcp-oauth.md.
 */
export function GET(req: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(originOf(req)), { headers: PUBLIC_CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS });
}
