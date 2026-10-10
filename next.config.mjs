import withSerwistInit from '@serwist/next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The OAuth metadata an MCP client reads to sign in to /api/mcp
  // (lib/mcp-oauth/core.ts). Served by API routes beside the rest of the OAuth
  // endpoints, under app/api/oauth/; the path-suffixed forms are what RFC 9728 and RFC 8414 build
  // from a resource or issuer with a path, and some clients ask for those.
  // The OAuth consent page is never framed: an Allow button inside another
  // site's frame is the clickjacking shape every authorize page guards against.
  async headers() {
    return [
      {
        source: '/oauth/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/:path*', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/authorization-server' },
      { source: '/.well-known/oauth-authorization-server/:path*', destination: '/api/oauth/authorization-server' },
      { source: '/.well-known/openid-configuration', destination: '/api/oauth/authorization-server' },
    ];
  },
  async redirects() {
    return [
      // The apex is a doorway, not the app. dsul lives at do.dsul.app and stays
      // there: the origin is expensive to move once a PWA is installed against
      // it and Supabase's redirect allowlist names it, while the apex is cheap
      // to repurpose — which is the point, because dsul.app is where a
      // marketing site would eventually live.
      //
      // 307, deliberately NOT 308: a permanent redirect is cached by the
      // browser indefinitely, so the day the apex starts serving its own page,
      // every visitor who ever hit it would keep being bounced here with no way
      // to notice. Reversibility is worth more than the redirect being cached.
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'dsul.app' }],
        destination: 'https://do.dsul.app/:path*',
        permanent: false,
      },
      // Seasons were "programs" until migration 046, and a season's page lived
      // at /program/[id]. The id is unchanged, so an old link or bookmark lands
      // on the same season. Not permanent, for the apex rule's reason: a cached
      // 308 cannot be taken back if the path is ever reused.
      {
        source: '/program/:id',
        destination: '/season/:id',
        permanent: false,
      },
    ];
  },
};

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  // Not on every reconnect. The default reloaded the whole page whenever the
  // connection came back (a laptop waking, a train out of a tunnel), throwing
  // away any draft, the undo history and the page tick's memory of which cues
  // it already rang (memory/plans/reminders-platforms.md §5.2, PR-1b).
  // hooks/use-local-cue-tick.ts listens for `online` instead.
  reloadOnOnline: false,
});

export default withSerwist(nextConfig);
