'use client';

import { useEffect, useMemo, useState } from 'react';
import { OrganizerSection } from '@/components/primitives/organizer-chips';
import { fetchItemEventsFor } from '@/lib/db';
import { formatShort, useToday } from '@/lib/collections';
import { addDaysStr } from '@/lib/container-schedule';
import { ACTIVITY_DAYS, deriveActivity, type ActivityEvent } from '@/lib/container-activity';
import { cn } from '@/lib/utils';
import type { Item } from '@/lib/planner-types';

/**
 * A container pane's Activity — what happened to its members lately, newest
 * first (lib/container-activity.ts says what counts and why it is only days).
 *
 * Recurring completions come from the store, so ticking a habit shows at once.
 * Creates and one-off completions come from `item_events`, re-read whenever
 * the member set or a member's status changes — and read twice: those rows are
 * written fire-and-forget AFTER the item write resolves, so a read at the
 * instant the store changed usually beats them there. A failed or absent fetch
 * leaves only the store's completions — never an error.
 * Nothing to show, no section: an empty "Activity" heading says nothing.
 */
export function ContainerActivity({
  members,
  testId,
}: {
  members: readonly Item[];
  testId: string;
}) {
  const { todayStr, tz } = useToday();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const ids = members.map((m) => m.id).join(',');
  const key = `${ids}|${members.map((m) => m.status).join(',')}`;

  useEffect(() => {
    let live = true;
    const list = ids ? ids.split(',') : [];
    // A day of slack past the window: deriveActivity cuts by the user's date.
    const since = new Date(Date.now() - (ACTIVITY_DAYS + 1) * 86_400_000).toISOString();
    const read = () =>
      Promise.resolve()
        .then(() => fetchItemEventsFor(list, since))
        .then((rows) => {
          if (live) setEvents(rows);
        })
        .catch(() => {
          // The feed is a courtesy — a failed read is a shorter feed.
        });
    void read();
    const again = setTimeout(() => void read(), 2000);
    return () => {
      live = false;
      clearTimeout(again);
    };
    // `key` carries the statuses; `ids` alone would miss a one-off ticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const entries = useMemo(
    () => deriveActivity({ members, events, todayStr, tz }),
    [members, events, todayStr, tz]
  );
  if (entries.length === 0) return null;

  const dayLabel = (d: string) =>
    d === todayStr ? 'Today' : d === addDaysStr(todayStr, -1) ? 'Yesterday' : formatShort(d);

  return (
    <OrganizerSection label="Activity" testId={testId}>
      <ul className="flex flex-col">
        {entries.map((e) => (
          <li
            key={`${e.kind}:${e.itemId}:${e.date}`}
            className="text-muted-foreground flex h-7 items-center gap-2.5 px-[7px] text-xs"
            data-testid={`${testId}-entry`}
          >
            <span
              aria-hidden
              className={cn('size-1.5 shrink-0 rounded-full', e.kind === 'completed' ? 'bg-primary' : 'bg-muted-foreground/40')}
            />
            <span className="min-w-0 flex-1 truncate">
              {e.kind === 'completed' ? 'Completed' : 'Added'}{' '}
              <span className="text-foreground/85 font-medium">{e.title}</span>
            </span>
            <span className="shrink-0">{dayLabel(e.date)}</span>
          </li>
        ))}
      </ul>
    </OrganizerSection>
  );
}
