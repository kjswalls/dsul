'use client';

import { usePlannerStore } from '@/lib/planner-store';
import { useScheduleFocusStore } from '@/lib/schedule-focus-store';
import { containerKindOf, containerName } from '@/lib/container-registry';
import { resolveFocus, type LanePlan } from '@/lib/schedule-lanes';
import { cn } from '@/lib/utils';

/**
 * The 18px cap row above a Schedule grid — the only place a grouped Schedule
 * says what its partition is.
 *
 * Two shapes for the two modes, one meaning. In LANES mode each cap sits over
 * its own band, so the caption is the lane's header. In FOCUS mode the caps are
 * a plain row of chips, because there is no x to hang them on — that is Week,
 * routine grouping, and any day whose group count is past the lane budget.
 *
 * Every cap is a toggle. Picking one recedes the other lanes; picking it again
 * clears. That is the whole of focus, and it is what makes the no-"Other"-lane
 * decision affordable: a group with no lane of its own is still one click from
 * having the entire grid to itself.
 */

/** Exported for Week, whose pinned column heads stick just under the row. */
export const LANE_CAP_H = 18;
const CAP_H = LANE_CAP_H;

/**
 * The group's own colour, when the key names something that has one.
 *
 * Read off the KEY, not the label: `groupRows` emits prefixed container refs
 * (`project:Work`, `group:health`) and `priority:high`, so the key already says
 * which namespace to ask. Routine and bucket groups have no colour and get no
 * bead rather than a grey one — an empty swatch reads as "colour missing", and
 * these genuinely have none.
 */
function useLaneAccent(key: string): string | undefined {
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);

  // One CLASSIFY kind since 039, so `containerKindOf` answering at all is the
  // whole test — it is still what tells a container ref apart from the other
  // section keys sharing this keyspace.
  if (containerKindOf(key)) return getProjectColor(containerName(key));
  if (key.startsWith('priority:')) {
    const p = key.slice('priority:'.length);
    return p === 'none' ? undefined : `var(--priority-${p})`;
  }
  return undefined;
}

function Cap({
  lane,
  focused,
  anyFocus,
  band,
}: {
  lane: { key: string; label: string; count: number; leftPct: number; rightPct: number };
  focused: boolean;
  anyFocus: boolean;
  /** Lanes mode positions each cap over its band; focus mode queues them. */
  band: boolean;
}) {
  const toggleFocus = useScheduleFocusStore((s) => s.toggleFocus);
  const accent = useLaneAccent(lane.key);

  return (
    <button
      type="button"
      onClick={() => toggleFocus(lane.key)}
      aria-pressed={focused}
      data-lane={lane.key}
      data-focused={focused ? 'true' : 'false'}
      title={`${lane.label} — ${lane.count} ${lane.count === 1 ? 'block' : 'blocks'}`}
      style={band ? { left: `${lane.leftPct}%`, right: `${lane.rightPct}%` } : undefined}
      className={cn(
        'flex h-[18px] min-w-0 items-center gap-1.5 rounded-[4px] px-1.5 text-2xs transition-colors hover:bg-accent',
        band ? 'absolute' : 'flex-none',
        // The unfocused caps recede too, so the row itself shows what is focused
        // without needing a second mark. TEXT only — the bead is the group's own
        // colour, and a project accent can be lime, which never fades.
        anyFocus && !focused ? 'text-muted-foreground/60' : 'text-muted-foreground',
        focused && 'bg-accent font-medium text-foreground'
      )}
    >
      {accent && (
        <span
          aria-hidden
          className="size-[7px] shrink-0 rounded-[2px]"
          style={{ background: accent }}
        />
      )}
      <span className="truncate">{lane.label}</span>
    </button>
  );
}

export function LaneCapRow({
  plan,
  /** Left inset of the events field, so the caps sit over their own bands. */
  fieldLeft,
  /**
   * Stacking level. Day has nothing to compete with; Week's pinned hour gutter
   * sits at WEEK_GUTTER_Z and would otherwise slide its opaque background over
   * the caps on the first vertical scroll — see LANE_CAP_Z.
   */
  z = 8,
  className,
}: {
  plan: LanePlan;
  fieldLeft: number;
  z?: number;
  className?: string;
}) {
  const focusedKey = useScheduleFocusStore((s) => s.focusedKey);
  const active = resolveFocus(plan, focusedKey);

  if (plan.mode === 'none') return null;

  return (
    <div
      data-testid="lane-cap-row"
      data-lane-mode={plan.mode}
      // Sticky so the partition stays legible while the grid scrolls — the caps
      // are the only thing naming what the x axis (or the recession) means, and
      // in focus mode they are the only way to clear a focus.
      //
      // A sticky box is constrained to its CONTAINING BLOCK, so this only works
      // if the caller puts it in one that spans the grid. Week had it in an 18px
      // wrapper of its own for a commit, which is zero travel.
      className={cn('sticky top-0 bg-[var(--canvas)]', className)}
      style={{ height: CAP_H, paddingLeft: fieldLeft, zIndex: z }}
    >
      {/* Focus mode has no bands to sit over, so the caps queue from the left and
          scroll when a day has more groups than the row can hold. */}
      <div
        className={cn(
          'h-full',
          plan.mode === 'lanes' ? 'relative' : 'flex items-center gap-1 overflow-x-auto'
        )}
      >
        {plan.lanes.map((lane) => (
          <Cap
            key={lane.key}
            lane={lane}
            focused={active === lane.key}
            anyFocus={active !== null}
            band={plan.mode === 'lanes'}
          />
        ))}
      </div>
    </div>
  );
}
