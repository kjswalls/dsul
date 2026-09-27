'use client';

import { useEffect, useMemo, useState } from 'react';
import { OrganizerSection } from '@/components/primitives/organizer-chips';
import { fetchItemEventsFor } from '@/lib/db';
import { formatShort, useToday } from '@/lib/collections';
import { addDaysStr } from '@/lib/container-schedule';
import { deriveActivity, type ActivityEvent } from '@/lib/container-activity';
import { cn } from '@/lib/utils';
import type { Item } from '@/lib/planner-types';

/**
 * A container pane's Activity — what happened to its members lately, newest
 * first (lib/container-activity.ts says what counts and why it is only days).
 *
 * The creates come from `item_events`, fetched once per member set; the
 * completions come from the store, so ticking a member updates this at once.
 * A failed or absent fetch leaves only the completions — never an error.
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
  const key = members.map((m) => m.id).join(',');

  useEffect(() => {
    let live = true;
    const ids = key ? key.split(',') : [];
    Promise.resolve()
      .then(() => fetchItemEventsFor(ids))
      .then((rows) => {
        if (live) setEvents(rows);
      })
      .catch(() => {
        // The feed is a courtesy — a failed read is a shorter feed.
      });
    return () => {
      live = false;
    };
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
