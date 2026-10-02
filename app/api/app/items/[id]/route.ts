import { postItemWrite } from '@/lib/app-api';

/**
 * POST /api/app/items/:id — one verb from the iPhone app on one item:
 *   { action: 'complete', date, done, count? }  a tick, for one date
 *   { action: 'schedule', date, startTime }     a braindump row dropped on an hour
 * The handler is in lib/app-api.ts.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return postItemWrite(req, id);
}
