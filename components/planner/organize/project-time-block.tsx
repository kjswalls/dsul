'use client';

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePlannerStore } from '@/lib/planner-store';
import { currentDayOfWeek } from '@/lib/recurrence';
import { WEEKDAY_LABELS } from '@/lib/planner-types';
import { Segmented, SegmentedOption, SettingRow } from './primitives';
import { BufferedInput } from './detail-parts';
import { cn } from '@/lib/utils';
import { PropertyChip } from '@/components/primitives/property-chip';
import { blockWhen, hasTimeBlock } from '@/lib/project-block';
import { BUCKET_START_TIMES } from '@/lib/time-bucket';
import type { Project, RepeatFrequency, TimeBucket } from '@/lib/planner-types';

/**
 * A project's repeating block on the grid.
 *
 * ABSORBED FROM EditProjectDialog, which is deleted in the same commit — it was
 * a 425px modal opened from inside a 938px (now 1082px) modal, and the only thing it did that
 * the detail pane cannot is offer a Cancel.
 *
 * THE SAVE CONTRACT CHANGED, deliberately. That dialog buffered EVERYTHING
 * behind `Cancel` / `Save Changes`; this patches discrete controls live and
 * buffers only what you type (see BufferedInput). The net for the user is
 * better, not worse: the old Cancel could only discard the whole form, while ⌘Z
 * and the undo toast now step back through individual changes — which the
 * buffered form never offered at all, because it wrote once on Save.
 *
 * THE PREDICATE THIS DRIVES lives in lib/day-items.ts: a project renders a block
 * only when `startTime && timeBucket && repeatFrequency` all hold. That is why
 * the switch clears `timeBucket` and `startTime` and deliberately leaves
 * `duration` and the repeat fields alone — turning the block off must not throw
 * away how it was set up, and nothing reads those fields while the block is off.
 */

/** Each part of day's default start is lib/time-bucket.ts's, which the iPhone's Add a time shares. */
const BUCKETS: { value: TimeBucket; label: string; defaultTime: string }[] = [
  { value: 'morning', label: 'Morning', defaultTime: BUCKET_START_TIMES.morning },
  { value: 'afternoon', label: 'Afternoon', defaultTime: BUCKET_START_TIMES.afternoon },
  { value: 'evening', label: 'Evening', defaultTime: BUCKET_START_TIMES.evening },
];

const REPEATS: { value: RepeatFrequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom', label: 'Chosen days' },
];

/**
 * "Every day · 6pm–7pm" — the block in one line, for the console chip and the
 * project page alike so the two cannot word it differently. Undefined when
 * there is no block: day-items' own rule (lib/project-block.ts) — a row
 * missing its repeat draws on no day, so it must not read "Every day".
 */
export function timeBlockSummary(project: Project): string | undefined {
  if (!hasTimeBlock(project)) return undefined;
  const repeat = REPEATS.find((r) => r.value === project.repeatFrequency)?.label ?? project.repeatFrequency;
  return `${repeat} · ${blockWhen(project)}`;
}

/**
 * `none` is absent on purpose. A block with no repeat renders on no day —
 * day-items.ts's switch sends it to the `default` arm, which reads `repeatDays`,
 * and a `none` project has none — so offering it would be an option that
 * silently means "off" while the switch above still reads on.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

const durationLabel = (m: number) =>
  m < 60 ? `${m} minutes` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`;

/**
 * Which repeat values are driven by the DAY GRID.
 *
 * Mirrors lib/day-items.ts exactly rather than testing `=== 'custom'`: that
 * switch routes every UNRECOGNISED value to a `default` arm that reads
 * `repeatDays`, and the DB really does hold such values — `'weekly'` survives on
 * legacy rows as free text, which is why the dialog this replaces carried three
 * `=== 'weekly'` comparisons that TypeScript flagged as impossible (Project's
 * type has no such member). Testing "not one of the known non-day values"
 * instead of "is custom" keeps those rows editable; hard-coding `custom` would
 * render their block on the grid while hiding the only control that says which
 * days, and the user could neither see nor change it.
 */
const NON_DAY_REPEATS = ['none', 'daily', 'weekdays', 'weekends', 'monthly'];
const isDayDriven = (freq: string | undefined) => !!freq && !NON_DAY_REPEATS.includes(freq);

export function ProjectTimeBlock({ project }: { project: Project }) {
  const updateProject = usePlannerStore((s) => s.updateProject);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  const patch = (updates: Partial<Omit<Project, 'id'>>) => updateProject(project.id, updates);

  const on = !!project.startTime && !!project.timeBucket;
  const bucket = project.timeBucket ?? 'morning';
  const duration = project.duration ?? 60;
  const repeat = project.repeatFrequency ?? 'daily';
  const days = project.repeatDays ?? [];
  const isPreset = DURATIONS.includes(duration);

  /**
   * "Custom…" is a DISPLAY MODE, not a value, so the reveal has to live in
   * state. Deriving it from the stored duration alone — which is what absorbing
   * the dialog first did — makes the option inert: picking it writes nothing,
   * so `isPreset` never changes, so the controlled Select snaps back to the
   * preset and the minutes field never mounts. Every project starts at a preset
   * (60 by default), so that made arbitrary durations unreachable app-wide.
   *
   * Reset on project change rather than keyed at the call site: the detail pane
   * reuses this instance across selections, and a flag left set would open the
   * next project on a custom field it never asked for.
   */
  const [wantsCustom, setWantsCustom] = useState(false);
  const [lastId, setLastId] = useState(project.id);
  if (lastId !== project.id) {
    setLastId(project.id);
    setWantsCustom(false);
  }
  const showCustom = wantsCustom || !isPreset;

  return (
    <>
      <SettingRow label="Time block" description="A repeating slot on the grid, held for this project.">
        <Switch
          checked={on}
          data-testid="project-block-toggle"
          aria-label="Time block"
          onCheckedChange={(next) =>
            patch(
              next
                ? {
                    timeBucket: bucket,
                    startTime: project.startTime ?? bucketDefault(bucket),
                    // The third field the resolver needs. Without it the switch
                    // reads on and the grid shows nothing.
                    repeatFrequency: project.repeatFrequency ?? 'daily',
                  }
                : { timeBucket: undefined, startTime: undefined }
            )
          }
        />
      </SettingRow>

      {on && (
        <>
          <SettingRow label="Part of day">
            <Segmented>
              {BUCKETS.map((b) => (
                <SegmentedOption
                  key={b.value}
                  active={bucket === b.value}
                  testId={`project-bucket-${b.value}`}
                  // Moves the start time to the new bucket's opening, because a
                  // 5am start filed under Evening is a block the grid draws
                  // outside its own band. Guarded on the value actually
                  // changing: a segment is a button, not a Radix Select, so a
                  // confirming click on the lit one fires too — and re-seeding
                  // the opening there would silently discard a start time the
                  // user typed (14:30 under Afternoon snaps to 12:00).
                  onClick={() => {
                    if (bucket === b.value) return;
                    patch({ timeBucket: b.value, startTime: b.defaultTime });
                  }}
                >
                  {b.label}
                </SegmentedOption>
              ))}
            </Segmented>
          </SettingRow>

          <SettingRow label="Starts">
            <BufferedInput
              type="time"
              value={project.startTime ?? bucketDefault(bucket)}
              testId="project-start-time"
              ariaLabel="Start time"
              className="w-[104px] font-num"
              onCommit={(next) => patch({ startTime: next })}
            />
          </SettingRow>

          <SettingRow label="For">
            <div className="flex shrink-0 items-center gap-1.5">
              <Select
                value={showCustom ? 'custom' : String(duration)}
                onValueChange={(v) => {
                  // Switching to Custom writes nothing — it reveals the field.
                  // Writing a placeholder here would put a number on the grid
                  // the user never chose.
                  if (v === 'custom') {
                    setWantsCustom(true);
                    return;
                  }
                  setWantsCustom(false);
                  patch({ duration: Number(v) });
                }}
              >
                <SelectTrigger className="h-[26px] w-[132px] text-sm" data-testid="project-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {durationLabel(m)}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              {showCustom && (
                <BufferedInput
                  type="number"
                  min={1}
                  value={String(duration)}
                  testId="project-duration-custom"
                  ariaLabel="Duration in minutes"
                  className="w-[72px] font-num"
                  // The field this rule exists for: live-binding it would write
                  // `6` on the way to `60` and put a six-minute block on the grid
                  // for as long as it takes to type the second digit.
                  validate={(next) => Number.isFinite(Number(next)) && Number(next) > 0}
                  onCommit={(next) => {
                    // Latch the mode too, or typing a number that happens to be
                    // a preset (90, 120) collapses the field the instant it
                    // commits — the user is left in the list they just left.
                    setWantsCustom(true);
                    patch({ duration: Number(next) });
                  }}
                />
              )}
            </div>
          </SettingRow>

          <SettingRow label="Repeats">
            <Select
              value={repeat}
              onValueChange={(v) => {
                const freq = v as RepeatFrequency;
                // Landing on the day grid with nothing chosen would show a block
                // that renders on no day at all, so today is pre-selected — but
                // only when there is nothing to preserve.
                const seed =
                  isDayDriven(freq) && days.length === 0
                    ? [currentDayOfWeek(userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)]
                    : undefined;
                patch({ repeatFrequency: freq, ...(seed && { repeatDays: seed }) });
              }}
            >
              <SelectTrigger className="h-[26px] w-[132px] text-sm" data-testid="project-repeat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPEATS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
                {/* A legacy value kept selectable so the row does not render an
                    empty trigger. Radix Select shows nothing when the value
                    matches no item, which would read as "no repeat" for a
                    project that repeats every week. */}
                {!REPEATS.some((r) => r.value === repeat) && (
                  <SelectItem value={repeat}>{repeat} (as saved)</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingRow>

          {isDayDriven(repeat) && (
            <SettingRow label="On">
              <div className="flex shrink-0 gap-1" data-testid="project-days">
                {WEEKDAY_LABELS.map((day, index) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={days.includes(index)}
                    aria-label={day}
                    data-testid={`project-day-${index}`}
                    onClick={() =>
                      patch({
                        repeatDays: days.includes(index)
                          ? days.filter((d) => d !== index)
                          : [...days, index].sort((a, b) => a - b),
                      })
                    }
                    className={cn(
                      'h-[26px] w-[26px] rounded-[5px] text-2xs font-medium',
                      days.includes(index)
                        ? 'bg-surface-2 text-foreground shadow-[var(--shadow-elev-sm)]'
                        : 'bg-surface-3 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </SettingRow>
          )}

          {repeat === 'monthly' && (
            <SettingRow
              label="Day of month"
              description="Months that are shorter use their last day."
            >
              <Select
                value={String(project.repeatMonthDay ?? 1)}
                onValueChange={(v) => patch({ repeatMonthDay: Number(v) })}
              >
                <SelectTrigger className="h-[26px] w-[72px] text-sm" data-testid="project-month-day">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          )}
        </>
      )}
    </>
  );
}

const bucketDefault = (bucket: TimeBucket) =>
  BUCKETS.find((b) => b.value === bucket)?.defaultTime ?? BUCKET_START_TIMES.morning;

/**
 * The block as a property chip in the pane's chip row — "Weekdays · 6–7pm",
 * or "＋ Time block" when there is none — opening the same controls
 * (ProjectTimeBlock) in its popover. The block is a property of the project,
 * so it sits with the others rather than as a settings section of its own.
 */
export function TimeBlockChip({ project }: { project: Project }) {
  const value = timeBlockSummary(project);
  return (
    <PropertyChip
      label="＋ Time block"
      value={value}
      ariaLabel={value ? `Time block: ${value}` : 'Add a time block'}
      testId="project-time-block-chip"
      contentClassName="w-[22rem] p-3"
    >
      {() => (
        <div className="flex flex-col gap-1">
          <ProjectTimeBlock project={project} />
        </div>
      )}
    </PropertyChip>
  );
}
