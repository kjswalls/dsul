/**
 * Who made a change, written into its `item_events` payload as `by` (since
 * 2026-10-11; the item timeline, lib/item-timeline.ts, reads it). 'ai' is a
 * card the user accepted (planner-store `applyProposal` passes it), 'agent'
 * and 'recipe' come from the service client that made the write, tagged
 * here, and everything else is the signed-in person, written as no `by` at all.
 *
 * Its own module, not lib/db.ts, so the many tests that stand in for db.ts
 * need not know about it.
 */

export type EventActor = 'you' | 'ai' | 'agent' | 'recipe';

const clientActors = new WeakMap<object, EventActor>();

/** Mark a service client as an agent's or a recipe's, so its writes say so in the timeline. */
export function tagClientActor<C extends object>(client: C, actor: EventActor): C {
  clientActors.set(client, actor);
  return client;
}

export function clientActor(client: object | undefined): EventActor | undefined {
  return client ? clientActors.get(client) : undefined;
}
