import { NextRequest } from 'next/server';
import { releaseWebPushToken } from '@/lib/devices/registry';
import { answer, badRequest, isWebPushEndpoint, readJson } from '@/lib/devices/routes';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/push/release — kept for ONE release, for a page loaded from a
 * build before the device registry.
 *
 * Body: { endpoint }. NO SESSION, on purpose (#254): exactly
 * /api/devices/release's token form, which says why that is safe. New code
 * posts there.
 */
export async function POST(req: NextRequest) {
  const json = await readJson(req);
  if (!json.ok) return badRequest('invalid JSON');
  const { endpoint } = (json.body ?? {}) as Record<string, unknown>;
  if (!isWebPushEndpoint(endpoint)) return badRequest('endpoint must be an https URL');
  return answer(await releaseWebPushToken(createServiceClient(), endpoint), 'push/release');
}
