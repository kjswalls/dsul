'use client';

import { memo } from 'react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import type { AtlasLane, AtlasTimelineDecor } from '@/lib/atlas-layouts';
import { cn } from '@/lib/utils';

/**
 * What sits behind the cards in Momentum, By goal and Timeline: the columns
 * or lanes, their headings with a count, and on the Timeline the months, the
 * season bars and today's line. World coordinates, inside `.atlas-world`, and
 * pointer-transparent, so a press on a lane pans like bare canvas.
 *
 * The lane a dragged card would land in lights before release (a dashed
 * outline, an ink wash and its name), read from atlas-ui-store's `hotLane`
 * so a drag re-renders this layer and never a card. Colour and outline only,
 * never opacity (D8).
 */
export const AtlasLanes = memo(function AtlasLanes({
  lanes,
  timeline,
}: {
  lanes: readonly AtlasLane[];
  timeline: AtlasTimelineDecor | null;
}) {
  const hot = useAtlasUiStore((s) => s.hotLane);
  return (
    <div aria-hidden className="pointer-events-none absolute left-0 top-0" data-testid="atlas-lanes">
      {timeline && <TimelineDecor timeline={timeline} />}
      {lanes.map((lane) => {
        const isHot = lane.drop && hot === lane.id;
        const timelineRow = lane.kind === 'timeline';
        return (
          <div
            key={lane.id}
            data-atlas-lane={lane.id}
            data-lane-kind={lane.kind}
            data-hot={isHot ? 'true' : undefined}
            className={cn(
              'absolute',
              timelineRow ? '' : 'rounded-[22px] bg-muted/50',
              isHot && 'bg-foreground/[0.08] outline-dashed outline-[1.5px] outline-muted-foreground'
            )}
            style={{ left: lane.rect.x, top: lane.rect.y, width: lane.rect.w, height: lane.rect.h }}
          >
            <h3
              className={cn(
                'flex items-baseline gap-2 whitespace-nowrap px-5 pt-4 text-2xs font-semibold uppercase tracking-wide text-muted-foreground',
                timelineRow && 'px-1 pt-1'
              )}
              data-testid="atlas-lane-heading"
            >
              {lane.kind === 'goal' && lane.color && (
                <span className="size-[9px] flex-none self-center rounded-[3px]" style={{ background: lane.color }} />
              )}
              <span className="text-foreground">{lane.label}</span>
              {!timelineRow && <span className="tabular-nums">{lane.count}</span>}
              {lane.hint && <span className="font-normal normal-case tracking-normal">{lane.hint}</span>}
            </h3>
          </div>
        );
      })}
    </div>
  );
});

function TimelineDecor({ timeline }: { timeline: AtlasTimelineDecor }) {
  return (
    <>
      {timeline.months.map((m) => (
        <div
          key={m.start}
          data-testid="atlas-month"
          className="absolute top-0 border-l border-border"
          style={{ left: m.x, width: m.w, height: timeline.height }}
        >
          <span className="block px-2 pt-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{m.label}</span>
        </div>
      ))}
      {timeline.seasonBars.map((b) => (
        <div
          key={b.key}
          data-testid="atlas-season-bar"
          className="absolute flex items-center overflow-hidden rounded-full border bg-card px-2 text-2xs font-medium text-foreground"
          style={{ left: b.x, top: b.y, width: b.w, height: 22, borderColor: b.color }}
        >
          <span className="mr-1.5 size-[7px] flex-none rounded-full" style={{ background: b.color }} />
          <span className="truncate">{b.label}</span>
        </div>
      ))}
      <div
        data-testid="atlas-today-line"
        className="absolute top-6 border-l-[1.5px] border-dashed border-foreground"
        style={{ left: timeline.todayX, height: timeline.height - 24 }}
      >
        <span className="absolute -top-0.5 left-1 text-2xs font-semibold text-foreground">{ATLAS_COPY.today}</span>
      </div>
    </>
  );
}
