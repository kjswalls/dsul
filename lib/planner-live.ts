import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * The tables a planner reads, whose changes another device makes. Each has a
 * `user_id`, which is the filter: Realtime checks the row against the
 * subscriber's RLS as well, so a channel only ever hears its owner's rows.
 * Migration 084 puts them in the `supabase_realtime` publication.
 */
export const LIVE_TABLES = ['items', 'projects', 'routines', 'seasons', 'goals', 'item_types'] as const;

/**
 * The membership tables, heard on INSERT and UPDATE only. Realtime cannot filter a DELETE
 * by column (the old row carries only its key), so an unfiltered DELETE would
 * reach every signed-in user's channel. A removal made elsewhere lands with
 * the next change or the next focus catch-up instead.
 */
export const LIVE_JOIN_TABLES = ['routine_items', 'season_items', 'season_routines', 'goal_items'] as const;

export type LiveTable = (typeof LIVE_TABLES)[number] | (typeof LIVE_JOIN_TABLES)[number];

export interface LiveChange {
  table: LiveTable;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  /** The row as it is now (empty for a DELETE). */
  row: Record<string, unknown>;
}

export interface LiveHandlers {
  onChange: (change: LiveChange) => void;
  /**
   * The channel is joined: the first time, and again after every reconnect.
   * Changes made while it was down were never heard, so a rejoin is a reason
   * to catch up.
   */
  onJoined: (rejoin: boolean) => void;
}

/**
 * Hear every change to this user's planner rows, made anywhere. Returns the
 * way to stop. The channel name carries the user id only to tell two
 * accounts' channels apart in one client; the filter and RLS do the scoping.
 */
export function subscribePlannerChanges(
  client: Pick<SupabaseClient, 'channel' | 'removeChannel'>,
  userId: string,
  handlers: LiveHandlers,
): () => void {
  const filter = `user_id=eq.${userId}`;
  let channel: RealtimeChannel = client.channel(`planner:${userId}`);
  const hear = (table: LiveTable, event: 'INSERT' | 'UPDATE') => {
    channel = channel.on(
      // The overload set is keyed on the literal; the cast keeps one call site.
      'postgres_changes' as never,
      { event, schema: 'public', table, filter } as never,
      ((payload: { eventType: LiveChange['eventType']; new: Record<string, unknown> | null }) =>
        handlers.onChange({ table, eventType: payload.eventType, row: payload.new ?? {} })) as never,
    );
  };
  // INSERT and UPDATE, not '*': items and containers are soft-deleted (an
  // UPDATE of deleted_at), and a filtered DELETE is not delivered anyway.
  for (const table of LIVE_TABLES) {
    hear(table, 'INSERT');
    hear(table, 'UPDATE');
  }
  for (const table of LIVE_JOIN_TABLES) {
    hear(table, 'INSERT');
    hear(table, 'UPDATE');
  }

  let joined = false;
  channel.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return;
    handlers.onJoined(joined);
    joined = true;
  });
  return () => {
    void client.removeChannel(channel);
  };
}
