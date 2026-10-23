import { postContainerWrite } from '@/lib/app-containers';

/**
 * POST /api/app/containers/:kind/:id: one field of one routine, season, goal
 * or project, from the iPhone app. `:kind` is routine, season, goal or
 * project (it picks the table; ids are unique per table only), `:id` the
 * container's uuid. The body is one strict intent of that kind:
 *   routine  { action: 'pause', paused, pausedUntil?, timeZone? }   Pause, Pause until, Resume
 *   season   { action: 'state', state: 'auto' | 'active' | 'paused' }   Dates, On, Off
 * A goal and a project take none yet. The planner payload's `containerWrites`
 * lists what each kind takes.
 *
 * Answers 200 `{ok: true}` (written, or already so: nothing written), 400
 * `invalid` (a body that is not one intent of that kind), 404 `not_found` (an
 * unknown kind, a malformed id, or no live container of the caller's: never
 * one, in the Trash, or purged) and 409 `pause_refused` (a resume day not
 * after today on a routine that is not paused). The extension switches gate
 * nothing here. No webhook, no item_events, never the service role. The
 * handler is in lib/app-containers.ts.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
): Promise<Response> {
  const { kind, id } = await params;
  return postContainerWrite(req, kind, id);
}
