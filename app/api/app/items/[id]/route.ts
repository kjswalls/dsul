import { postItemWrite } from '@/lib/app-api';

/**
 * POST /api/app/items/:id — one verb from the iPhone app on one item:
 *   { action: 'complete', date, done, count? }            a tick, for one date
 *   { action: 'schedule', date, startTime }               a braindump row dropped on an hour
 *   { action: 'skip', date, skipped }                     Skip today / Unskip today
 *   { action: 'move', date }                              Tomorrow, or Reschedule to a day
 *   { action: 'pause', paused, pausedUntil?, timeZone? }  Pause, Pause until, Resume
 *   { action: 'title', title }                            the title, typed
 *   { action: 'notes', notes }                            the notes, typed; null clears them
 *   { action: 'delete' }                                  Delete, with its subtasks, to the Trash
 *   { action: 'addSubtask', id, title }                   a new subtask under this item
 *   { action: 'resetStreak' }                             Reset streak
 * The handler is in lib/app-api.ts.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return postItemWrite(req, id);
}
