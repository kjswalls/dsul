'use client';

import { useEffect, useState } from 'react';
import { usePlannerStore, wasNeverCreated } from '@/lib/planner-store';
import { fetchTrashedNames, type TrashedName } from '@/lib/db';

/**
 * The container names a trashed row is still holding.
 *
 * `projects_user_id_name_key` is a PLAIN
 * unique index over `(user_id, name)` — no `WHERE deleted_at IS NULL` — so a
 * deleted container reserves its name for the full 30 days while being
 * invisible to `usePlannerStore`, whose arrays come from `deleted_at`-filtered
 * fetches. The store literally cannot see the row that is about to reject the
 * write.
 *
 * That gap is a live bug on the create and the rename path both, and the create
 * half is the louder one. `addProject` de-dupes against live rows, passes, `set()`s
 * optimistically, and only then does the insert raise 23505 into a
 * `.catch(console.error)`. The console then selects the phantom, opens its
 * detail pane, and accepts a glyph, a colour and a whole time block — every one
 * an `.eq('id', …)` update matching zero rows — while any item filed into it
 * fails its own write on `items_project_id_fkey`. Nothing on screen says a
 * word, and the lot evaporates on the next reload.
 *
 * THE SERVER FETCH ALONE IS NOT ENOUGH, and the first version of this said the
 * opposite in a comment that had the mechanism backwards. It claimed a name
 * entering the bin mid-visit was still safe, "because the store still knows
 * about it live, so the ordinary sibling check catches it". It does not:
 * `removeProject` FILTERS the row out of `state.projects`. So after deleting a
 * project without leaving the section — which is two clicks, and exactly what
 * someone tidying up does — the live sibling check has nothing to match, the
 * fetched bin predates the delete, and the phantom this hook exists to prevent
 * is reachable. Verified by rendering the console and doing it.
 *
 * So the answer is a UNION: the server's bin, plus every container that left
 * the live arrays during this session. Tracked through a store subscription
 * rather than by refetching on a count change, because `removeProject` fires
 * `dbDeleteProject(...)` WITHOUT awaiting it — a refetch triggered by the
 * synchronous optimistic set() would race the write and could read the bin
 * before `deleted_at` had landed. The union needs no round trip and so cannot
 * lose that race.
 *
 * A container that comes BACK — undo, or a Trash restore — drops out of the
 * union again, because it is live once more.
 *
 * `enabled` gates the FETCH only, never the subscription. The item dialog
 * mounts its body (and this hook) only while open, plus a short exit grace, and
 * passes `!!state` so the closing frames fire no SELECT; container-dialog and
 * container-page pass `kind === 'project'`, the one kind whose name a trashed
 * row can hold. The cost lands at the moment a create becomes possible, which
 * is the first moment the answer can matter, and it is fresher there.
 */
export function useTrashedNames(
  { enabled = true }: { enabled?: boolean } = {},
): { projects: TrashedName[] } {
  const userId = usePlannerStore((s) => s.userId);
  // One list since 039 collapsed the two CLASSIFY kinds. Kept as an object with
  // a `projects` key rather than a bare array: that is the shape every caller
  // destructures, and it is what `fetchTrashedNames` returns.
  const [names, setNames] = useState<{ projects: TrashedName[] }>({ projects: [] });
  /** Containers that vanished from the live array since this section mounted. */
  const [gone, setGone] = useState<{ projects: TrashedName[] }>({ projects: [] });

  useEffect(() => {
    if (!userId || !enabled) return;
    let live = true;
    loadTrashedNames(userId)
      .then((rows) => {
        if (live) setNames(rows);
      })
      // FAILS OPEN, and the catch has to be here rather than only inside
      // fetchTrashedNames: the query error is handled there, but constructing
      // the client can reject too (no env, no session), and an unhandled
      // rejection out of a render effect is a different kind of breakage from
      // the one this guard is worth. Falling back to the empty list restores
      // exactly today's behaviour — the create can still produce a phantom —
      // which is a bug that reappears with the network, not a create row that
      // refuses everything because a lookup is down.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, enabled]);

  useEffect(() => {
    // Optional-called: a unit test that mocks `@/lib/planner-store` with only
    // the members it needs has no `subscribe`, and this runs on mount.
    return usePlannerStore.subscribe?.((next, prev) => {
      // A container the look-only preview showed and the fresh load lacks was
      // not deleted in this session; the server's bin speaks for it if it was.
      if (next.projects === prev.projects || prev.isPreview) return;
      setGone((current) => ({
        projects: stillGone([...current.projects, ...vanished(prev.projects, next.projects)], next.projects),
      }));
    });
  }, []);

  // Deduped by id: a later remount refetches, and a container deleted this
  // session will by then be in the server's bin as well.
  return { projects: mergeById(names.projects, gone.projects) };
}

/**
 * Containers that left the live array — MINUS the ones that were never in the
 * database to begin with.
 *
 * A rollback looks exactly like a delete from out here: `undoFailedCreate`
 * filters the refused container out of `state.projects`, which is the same
 * observable event `removeProject` produces. Without the exemption the guard
 * held the name of a row that does not exist, in the bin or anywhere else, and
 * answered the user's retry — the one move left to them after "Nothing was
 * saved" — with a sentence inviting them to restore it from a Trash it is not
 * in. Only a reload cleared it.
 *
 * A 23505 failure loses nothing by this: there IS a trashed row holding that
 * name, and the server list already carries it under its own real id.
 */
/**
 * Requests in flight, so hooks that mount in the same tick share one round trip.
 *
 * The console's Labels pane is the case that needs it: Projects and Item types
 * each call this hook, both are mounted together, and each call is a SELECT.
 * Deduping by user id collapses that to one without any of the staleness a
 * result cache would introduce — the entry is dropped the moment it settles, so
 * the NEXT mount still gets a fresh read, which is the behaviour the union is
 * built around.
 */
const inFlight = new Map<string, Promise<{ projects: TrashedName[] }>>();

const loadTrashedNames = (userId: string) => {
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const request = fetchTrashedNames(userId).finally(() => {
    inFlight.delete(userId);
  });
  inFlight.set(userId, request);
  return request;
};

const vanished = (before: TrashedName[], after: TrashedName[]): TrashedName[] =>
  before
    .filter((b) => !after.some((a) => a.id === b.id) && !wasNeverCreated(b.id))
    .map((b) => ({ id: b.id, name: b.name }));

/** Drop anything that is live again — undo, or a restore out of the Trash. */
const stillGone = (list: TrashedName[], live: { id: string }[]): TrashedName[] =>
  list.filter((t) => !live.some((l) => l.id === t.id));

const mergeById = (a: TrashedName[], b: TrashedName[]): TrashedName[] => {
  const byId = new Map(a.map((r) => [r.id, r]));
  for (const row of b) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
};

/**
 * The sentence for a name a trashed container is holding, or null.
 *
 * EXACT match, not case-folded, and that is the DB's rule rather than a choice:
 * `projects.name` is plain `text` and the unique index is case-sensitive, so
 * "work" against a trashed "Work" inserts perfectly well. Refusing it would
 * block a name Postgres accepts — the opposite failure, and just as invisible
 * to the person typing.
 *
 * The message names the Trash because the bin is the fix. Without it this reads
 * as the app inventing a rule about a container the user cannot see anywhere.
 */
export function heldByTrash(
  trashed: TrashedName[],
  next: string,
  noun: string,
): string | null {
  const holder = trashed.find((t) => t.name === next);
  if (!holder) return null;
  return `A deleted ${noun} called “${holder.name}” still has that name. Restore it from Trash, or pick a different one.`;
}
