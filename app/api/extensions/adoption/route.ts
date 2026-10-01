import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';
import { computeAdoption, type AdoptionCounts } from '@/lib/extension-adoption';

/**
 * GET /api/extensions/adoption → { available: true, stats: { [slug]: { hasItOn, keptOn30d } } }
 *
 * How many people keep each extension on, for the extensions store.
 *
 * The session authorises (anyone signed in may read it); the service role
 * performs, because extension_adoption() aggregates ACROSS accounts and is
 * executable by nothing else (migration 051). Only rounded fractions leave this
 * route, and computeAdoption withholds any figure built on too few people — the
 * counts themselves never reach a browser.
 *
 * A database without migration 051 answers `{ available: false }`: the store
 * then simply shows no figures, which is also what it shows before launch.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const { data, error } = await service.rpc('extension_adoption');

  if (error) {
    // 42883 undefined_function / PGRST202 "could not find the function": the
    // migration has not run. Quiet, not a failure the store has to explain.
    if (error.code === '42883' || error.code === 'PGRST202') {
      return NextResponse.json({ available: false, stats: {} });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { available: true, stats: computeAdoption((data ?? []) as AdoptionCounts[]) },
    // Figures move by the day, not the second, and are the same for every
    // reader; an hour in the browser's cache spares the aggregate a run per
    // store visit. `private` because the response still sits behind a session.
    { headers: { 'Cache-Control': 'private, max-age=3600' } }
  );
}
