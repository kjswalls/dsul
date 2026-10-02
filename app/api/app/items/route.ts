import { postCapture } from '@/lib/app-api';

/**
 * POST /api/app/items — capture from the iPhone app into the braindump.
 * Body `{ id, title }`, where the id is the phone's own uuid so a retry is the
 * same row. The handler is in lib/app-api.ts.
 */
export function POST(req: Request): Promise<Response> {
  return postCapture(req);
}
