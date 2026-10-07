import { postCapture } from '@/lib/app-api';
import { afterItemWrite } from '@/lib/recipes/server';

/**
 * POST /api/app/items — capture from the iPhone app into the braindump.
 * Body `{ id, title }`, where the id is the phone's own uuid so a retry is the
 * same row. The handler is in lib/app-api.ts. A new capture starts the user's
 * "I add an item" recipes on the server once it has committed
 * (lib/recipes/server/, isolated: a recipe never fails the capture).
 */
export function POST(req: Request): Promise<Response> {
  return postCapture(req, { onCommitted: afterItemWrite });
}
