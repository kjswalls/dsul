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
    ];
  },
};

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

export default withSerwist(nextConfig);
