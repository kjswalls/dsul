import { postContainerCreate } from '@/lib/app-containers';

/**
 * POST /api/app/containers/:kind: a new routine, season, goal or project, from
 * the iPhone app's + menu. `:kind` is routine, season, goal or project (it
 * picks the table). The body is strict:
 *   routine, season, project  { id, name, icon? }
 *   goal                      { id, name, icon?, startsOn? }
 * `id` is the phone's own uuid (taken lowercased), `name` is trimmed and never
 * blank, `icon` an `icon:<Name>` token, `startsOn` the goal's first day
 * (yyyy-MM-dd). The container is made empty, with the web's create defaults
 * (lib/app-containers.ts containerCreateRecord).
 *
 * Answers 200 `{ok: true, id}` (made, or a row with this id is already the
 * caller's: nothing written), 400 `invalid`, 404 `not_found` (an unknown
 * kind), and for a project 409 `name_taken` (`{error, project: {id, name}}`, a
 * live project's name in any case) or `name_in_trash` (a project in the Trash
 * holds this exact name). The extension switches gate nothing here. No
 * webhook, no item_events, never the service role. The planner payload's
 * `containerWrites` lists `create` for each kind this takes. The handler is
 * in lib/app-containers.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }): Promise<Response> {
  const { kind } = await params;
  return postContainerCreate(req, kind);
}
