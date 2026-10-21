'use client';

import { useDoStuffStore } from '@/lib/do-stuff';
import { dayLabel, laneDef } from '@/lib/do-stuff-plan';

/**
 * Where one of today's rows is going while doing stuff, drawn on the row in
 * the grid (components/primitives/task-row.tsx): for a row leaving today, an
 * arrow and where to ("→ Thu", "→ later"). Lanes are colorless since the
 * room's round two, so a row staying today names its lane only to a screen
 * reader. One do stuff
 * (Kirby, 2026-10-13) plans today's open rows with the braindump's, so the
 * grid shows the same plan the lanes do. Nothing at rest, and nothing for a
 * row the plan does not hold.
 */
export function DoStuffMark({ id, todayStr }: { id: string; todayStr: string }) {
  const mark = useDoStuffStore((s) => (s.on ? s.marks.get(id) : undefined));
  if (!mark || !mark.onToday) return null;
  const def = laneDef(mark.lane);
  const where =
    mark.lane === 'calendar' && mark.day
      ? dayLabel(mark.day, todayStr)
      : mark.lane === 'leave'
        ? 'later'
        : mark.lane === 'archive'
          ? 'let go'
          : mark.lane === 'handoff'
            ? 'for me'
            : null;
  return (
    <span
      className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] text-muted-foreground"
      data-testid="do-stuff-mark"
      data-lane={mark.lane}
      title={def.label}
    >
      {where && <span>→ {where}</span>}
      <span className="sr-only">{where ? '' : def.label}</span>
    </span>
  );
}
