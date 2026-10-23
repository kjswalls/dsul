import { postContainerWrite } from '@/lib/app-containers';

/**
 * POST /api/app/containers/:kind/:id: one field of one routine, season, goal
 * or project, or its delete, from the iPhone app. `:kind` is routine, season,
 * goal or project (it picks the table; ids are unique per table only), `:id`
 * the container's uuid. The body is one strict intent of that kind:
 *   routine  pause { paused, pausedUntil?, timeZone? }, usualTime { usualTime },
 *            notes { notes }
 *   season   state { state: 'auto' | 'active' | 'paused' },
 *            dates { startsOn, endsOn }, notes { notes }
 *   goal     state { state: 'active' | 'achieved' | 'abandoned' },
 *            window { startsOn, targetOn }, why { why }
 *   project  notes { notes }
 *   all four rename { name }, icon { icon }, color { color }, delete {}
 * each with its `action`. The planner payload's `containerWrites` lists what
 * each kind takes.
 *
 * Answers 200 `{ok: true}` (written, or already so: nothing written), 400
 * `invalid` (a body that is not one intent of that kind), 404 `not_found` (an
 * unknown kind, a malformed id, or no live container of the caller's: never
 * one, in the Trash, or purged; a delete answers 200 for one already in the
 * Trash, and 404 only when there is no row at all), and 409 `pause_refused`
 * (a resume day not after today on a routine that is not paused), or for a
 * project rename `name_taken` / `name_in_trash`. The extension switches gate
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
