'use client';

import { Check } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { ChipOption, PropertyChip } from '@/components/primitives/property-chip';
import { formatShort, parseDay } from '@/lib/collections';
import { cn } from '@/lib/utils';
import { TIME_BUCKET_RANGES, WEEKDAY_LABELS, type TimeBucket } from '@/lib/planner-types';
import {
  whenOptions,
  type NewItemContext,
  type NewItemWhen,
  type RepeatWhen,
} from '@/lib/new-item-shape';

/**
 * WHEN a row typed into a create form happens — one chip on the row, so a
 * habit is born on its days rather than "daily, fix it later".
 *
 * Offers only what the list allows (whenOptions): repeats for a routine's
 * habits and a check-in, one-offs for a milestone, either for a plain member.
 * The time of day is asked only where it places something: an UNDATED one-off
 * takes no bucket (lib/new-item-shape.ts says why).
 */

const REPEATS: { value: RepeatWhen; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'custom', label: 'Custom days' },
  { value: 'monthly', label: 'Monthly' },
];

const BUCKETS = Object.keys(TIME_BUCKET_RANGES) as TimeBucket[];

export function whenLabel(when: NewItemWhen, bucket: TimeBucket): string {
  let text: string;
  if (when.kind === 'once') {
    text = when.date ? formatShort(when.date) : 'No date';
  } else if (when.frequency === 'custom') {
    text = [...(when.days ?? [])].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join(', ') || 'Custom days';
  } else if (when.frequency === 'monthly') {
    text = when.monthDay ? `Monthly · ${when.monthDay}` : 'Monthly';
  } else {
    text = REPEATS.find((r) => r.value === when.frequency)!.label;
  }
  const placed = when.kind === 'repeat' || !!when.date;
  return placed && bucket !== 'anytime' ? `${text} · ${TIME_BUCKET_RANGES[bucket].label}` : text;
}

export function NewItemWhenChip({
  ctx,
  when,
  bucket,
  todayStr,
  title,
  testId,
  onChange,
}: {
  ctx: NewItemContext;
  when: NewItemWhen;
  bucket: TimeBucket;
  todayStr: string;
  /** The row's title, for the chip's accessible name. */
  title: string;
  testId: string;
  onChange: (patch: { when?: NewItemWhen; bucket?: TimeBucket }) => void;
}) {
  const opts = whenOptions(ctx);
  const label = whenLabel(when, bucket);
  const todayDow = parseDay(todayStr)?.getDay() ?? 0;
  const placed = when.kind === 'repeat' || !!when.date;

  const pickRepeat = (frequency: RepeatWhen) =>
    onChange({
      when: {
        kind: 'repeat',
        frequency,
        // Newly into Custom: today's weekday, as the item dialog seeds it —
        // an empty set is not a rule. Monthly: today's date.
        days: frequency === 'custom' ? (when.kind === 'repeat' && when.days?.length ? when.days : [todayDow]) : undefined,
        monthDay: frequency === 'monthly' ? (parseDay(todayStr)?.getDate() ?? 1) : undefined,
      },
    });

  const toggleDay = (day: number) => {
    if (when.kind !== 'repeat') return;
    const days = when.days ?? [];
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    // Never down to none: the last day stays until another is chosen.
    if (next.length === 0) return;
    onChange({ when: { ...when, days: next } });
  };

  return (
    <PropertyChip
      label={label}
      value={label}
      ariaLabel={`When: ${label} — ${title}`}
      testId={testId}
      alwaysChevron
      align="end"
      className="h-6 shrink-0 text-[11.5px]"
      contentClassName="w-[17rem] p-1"
    >
      {(close) => (
        <div className="flex flex-col">
          {opts.once && (
            <>
              <ChipOption
                selected={when.kind === 'once' && !when.date}
                value="once"
                testId={`${testId}-once`}
                onSelect={() => {
                  onChange({ when: { kind: 'once' } });
                  close();
                }}
              >
                {opts.repeat ? 'Once · no date' : 'No date'}
                {when.kind === 'once' && !when.date && <Check className="ml-auto size-3.5" />}
              </ChipOption>
              <div className="px-1 pb-1">
                <Calendar
                  mode="single"
                  selected={when.kind === 'once' ? parseDay(when.date) : undefined}
                  defaultMonth={(when.kind === 'once' ? parseDay(when.date) : undefined) ?? parseDay(todayStr)}
                  onSelect={(date) => {
                    if (!date) return;
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, '0');
                    const d = String(date.getDate()).padStart(2, '0');
                    onChange({ when: { kind: 'once', date: `${y}-${m}-${d}` } });
                  }}
                />
              </div>
            </>
          )}
          {opts.once && opts.repeat && <div className="bg-border my-1 h-px" />}
          {opts.repeat &&
            REPEATS.map((r) => {
              const on = when.kind === 'repeat' && when.frequency === r.value;
              return (
                <div key={r.value}>
                  <ChipOption
                    selected={on}
                    value={r.value}
                    testId={`${testId}-${r.value}`}
                    onSelect={() => {
                      pickRepeat(r.value);
                      if (r.value !== 'custom' && r.value !== 'monthly') close();
                    }}
                  >
                    {r.label}
                    {on && <Check className="ml-auto size-3.5" />}
                  </ChipOption>
                  {on && r.value === 'custom' && when.kind === 'repeat' && (
                    <div className="flex gap-1 px-2 pt-1 pb-2" role="group" aria-label="Days">
                      {WEEKDAY_LABELS.map((day, index) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => toggleDay(index)}
                          aria-pressed={(when.days ?? []).includes(index)}
                          data-testid={`${testId}-day-${index}`}
                          className={cn(
                            'h-7 flex-1 rounded-md text-[11px] font-medium',
                            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                            (when.days ?? []).includes(index)
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-secondary text-secondary-foreground hover-wash'
                          )}
                        >
                          {day.slice(0, 2)}
                        </button>
                      ))}
                    </div>
                  )}
                  {on && r.value === 'monthly' && when.kind === 'repeat' && (
                    <div className="grid grid-cols-7 gap-1 px-2 pt-1 pb-2">
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => onChange({ when: { ...when, monthDay: day } })}
                          aria-pressed={when.monthDay === day}
                          className={cn(
                            'font-num h-6 rounded-sm text-[11px]',
                            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                            when.monthDay === day ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover-wash'
                          )}
                        >
                          {day}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          {placed && (
            <>
              <div className="bg-border my-1 h-px" />
              <p className="text-muted-foreground px-2 pt-0.5 pb-1 text-[10px] font-semibold tracking-wider uppercase">
                Time of day
              </p>
              <div className="flex gap-1 px-1 pb-1" role="group" aria-label="Time of day">
                {BUCKETS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={bucket === b}
                    data-testid={`${testId}-bucket-${b}`}
                    onClick={() => onChange({ bucket: b })}
                    className={cn(
                      'h-7 flex-1 rounded-md text-[11px] font-medium',
                      'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                      bucket === b ? 'bg-accent text-foreground' : 'text-muted-foreground hover-wash'
                    )}
                  >
                    {TIME_BUCKET_RANGES[b].label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </PropertyChip>
  );
}
