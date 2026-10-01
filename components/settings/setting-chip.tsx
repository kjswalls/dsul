'use client';

import { useId } from 'react';
import { ArrowUpRight, RotateCcw } from 'lucide-react';
import { PropertyChip, ChipOption } from '@/components/primitives/property-chip';
import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { formatCueTime } from '@/lib/reminders/copy';
import {
  displayValue,
  isModified,
  type SettingCtx,
  type SettingRecord,
} from '@/lib/settings/manifest';
import type { ChipSpec } from '@/lib/settings/groups';
import { resetLabel, resetLabelFor } from './setting-row';

/**
 * A dependent setting, drawn as a chip under its root row.
 *
 * The chip is a smaller SettingRow, not a different contract: it keeps the
 * row's hooks (data-setting-row, tabIndex -1, the highlight ring) so a deep
 * link lands on it, its disabled precedence (pending, then unavailable) and
 * the real `disabled` attribute rather than a fade, a modified mark and a
 * reset that says the same words the row's does. What it drops is the visible
 * description — that becomes the chip's accessible description and its title.
 *
 * A merged chip is two records — a switch and its one value — and writes both
 * through the shell's own write path, each to its own column. "Off" writes the
 * switch alone, so the stored value is still there when it comes back on.
 */

type OnWrite = (record: SettingRecord, next: string | boolean) => void;

/** The pill, sized to the 11px row description it sits under. Overrides
 *  PropertyChip's dimmed disabled state on purpose: the modified dot sits
 *  beside it, and nothing here fades through opacity. */
const PILL = cn(
  'bg-secondary text-foreground h-auto min-h-6 rounded-sm border-transparent px-2 py-0.5',
  'text-left text-[11px] leading-snug',
  'disabled:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-100'
);

function safeRead(record: SettingRecord, ctx: SettingCtx): string | boolean {
  try {
    return record.read(ctx);
  } catch {
    return record.defaultValue;
  }
}

/** Same precedence as SettingRow: a store that has not answered outranks
 *  every other reason, because until it does the rest is computed from defaults. */
function availability(records: SettingRecord[], ctx: SettingCtx) {
  let pending = false;
  try {
    pending = records.some((r) => r.pending?.(ctx) ?? false);
  } catch {
    pending = false;
  }
  let reason: string | null = null;
  if (!pending) {
    for (const r of records) {
      reason = r.unavailable?.(ctx) ?? null;
      if (reason) break;
    }
  }
  return { pending, reason, disabled: pending || reason !== null };
}

/**
 * The chip's accessible description. A row prints its disabled reason and
 * "Still loading…" as visible text; a chip has no room for that, and the
 * disabled control cannot take focus to reveal a title, so the reason rides
 * in the description the control points at.
 */
function describe(
  description: string | undefined,
  pending: boolean,
  reason: string | null
): string | undefined {
  const status = pending ? 'Still loading…' : reason ? `Unavailable — ${reason}` : undefined;
  return [description, status].filter(Boolean).join(' ') || undefined;
}

/** Muted noun, then the value — the mockup's "Auto-clear stale items  after 30 days". */
function ChipText({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-normal">
      <span className="text-muted-foreground">{label}</span>{' '}
      <span className="font-medium">{value}</span>
    </span>
  );
}

function ChipFrame({
  hostId,
  aliasId,
  highlighted,
  modified,
  title,
  descId,
  description,
  children,
}: {
  hostId: string;
  aliasId?: string;
  highlighted?: boolean;
  modified: boolean;
  title?: string;
  descId: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      data-setting-row={hostId}
      data-setting-alias={aliasId}
      data-highlight={highlighted || undefined}
      tabIndex={-1}
      title={title}
      className={cn(
        'relative inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        highlighted &&
          'after:ring-ring after:pointer-events-none after:absolute after:inset-0 after:rounded-sm after:ring-2 after:content-[""]'
      )}
    >
      {/* Its own element, a sibling of the pill and never inside anything
          that fades: the lime accent must not be dimmed through a parent. */}
      {modified && (
        <span
          aria-hidden
          data-chip-modified
          className="bg-primary absolute -top-0.5 -left-0.5 z-10 size-1.5 rounded-full"
        />
      )}
      {children}
      {description && (
        <span id={descId} className="sr-only">
          {description}
        </span>
      )}
    </span>
  );
}

/**
 * An enum (alone, or as the value half of a merged pair) or a merged time:
 * anything whose chip opens a picker.
 */
function PickerChip({
  record,
  toggle,
  ctx,
  highlighted,
  onWrite,
  onReset,
  onResetMany,
}: {
  record: SettingRecord;
  toggle?: SettingRecord;
  ctx: SettingCtx;
  highlighted?: boolean;
  onWrite: OnWrite;
  onReset: (record: SettingRecord) => void;
  onResetMany: (records: SettingRecord[], label: string, display: string) => void;
}) {
  const uid = useId();
  const controlId = `chip-${record.id}-${uid}`;
  const descId = `${controlId}-desc`;
  // SettingCtx carries no time format, and a cue time is the one value here
  // the user reads in their own clock.
  const timeFormat = usePlannerStore((s) => s.timeFormat);

  const value = safeRead(record, ctx);
  const toggleOn = toggle ? Boolean(safeRead(toggle, ctx)) : true;
  const { pending, reason, disabled } = availability(toggle ? [toggle, record] : [record], ctx);

  const valueText = (v: string | boolean) => {
    const shown =
      record.control === 'time' ? formatCueTime(String(v), timeFormat) : displayValue(record, v);
    return [record.chipPrefix, shown].filter(Boolean).join(' ');
  };
  const label = toggle?.label ?? record.label;
  const current = pending ? 'Loading…' : toggle && !toggleOn ? 'Off' : valueText(value);
  const defaultText = toggle && !toggle.defaultValue ? 'Off' : valueText(record.defaultValue);

  // With the switch off, the value is not in force — a changed days count
  // under "Off" is not a change anyone can see working.
  const modified =
    !disabled &&
    (toggle
      ? isModified(toggle, ctx) || (toggleOn && isModified(record, ctx))
      : isModified(record, ctx));
  const resetWords = toggle ? resetLabel(label, defaultText) : resetLabelFor(record);
  const description = describe(toggle?.description ?? record.description, pending, reason);
  const doReset = () =>
    toggle ? onResetMany([toggle, record], label, defaultText) : onReset(record);

  const choose = (next: string) => {
    onWrite(record, next);
    if (toggle && !toggleOn) onWrite(toggle, true);
  };

  return (
    <ChipFrame
      hostId={toggle?.id ?? record.id}
      aliasId={toggle ? record.id : undefined}
      highlighted={highlighted}
      modified={modified}
      title={reason ? `Unavailable — ${reason}` : (toggle?.description ?? record.description)}
      descId={descId}
      description={description}
    >
      <PropertyChip
        id={controlId}
        ariaLabel={pending ? `${label} — still loading` : `${label}: ${current}`}
        ariaDescribedBy={description ? descId : undefined}
        label={label}
        value={current}
        display={<ChipText label={label} value={current} />}
        alwaysChevron
        align="start"
        disabled={disabled}
        testId={`setting-${toggle?.id ?? record.id}`}
        className={PILL}
        contentClassName="w-auto min-w-[var(--radix-popover-trigger-width)] max-w-[min(18rem,var(--radix-popover-content-available-width))] p-1"
      >
        {(close) => (
          <div className="flex flex-col gap-0.5">
            {toggle && (
              <ChipOption
                value="off"
                selected={!toggleOn}
                onSelect={() => {
                  onWrite(toggle, false);
                  close();
                }}
              >
                Off
              </ChipOption>
            )}
            {record.control === 'time' ? (
              <>
                {toggle && (
                  <ChipOption
                    value="on"
                    selected={toggleOn}
                    onSelect={() => {
                      onWrite(toggle, true);
                      close();
                    }}
                  >
                    On
                  </ChipOption>
                )}
                <div className="flex items-center justify-between gap-3 px-2 py-1.5">
                  <label htmlFor={`${controlId}-time`} className="text-muted-foreground text-xs">
                    {record.label}
                  </label>
                  <input
                    id={`${controlId}-time`}
                    type="time"
                    data-setting={record.dbColumn ?? record.id}
                    value={String(value)}
                    onChange={(e) => {
                      // '' is a cleared field, not a time.
                      if (e.target.value) choose(e.target.value);
                    }}
                    className={cn(
                      'border-input bg-background text-foreground h-8 w-[104px] rounded-md border px-2',
                      'font-num text-xs',
                      'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
                    )}
                  />
                </div>
              </>
            ) : (
              record.options?.map((option) => (
                <ChipOption
                  key={option.value}
                  value={option.value}
                  selected={toggleOn && String(value) === option.value}
                  onSelect={() => {
                    choose(option.value);
                    close();
                  }}
                >
                  {option.label}
                </ChipOption>
              ))
            )}
            {modified && (
              <ChipOption
                tone="muted"
                className="border-border mt-0.5 rounded-t-none border-t text-xs"
                ariaLabel={resetWords.ariaLabel}
                onSelect={() => {
                  doReset();
                  close();
                }}
              >
                <RotateCcw className="size-3" aria-hidden />
                {resetWords.title}
              </ChipOption>
            )}
          </div>
        )}
      </PropertyChip>
    </ChipFrame>
  );
}

/** A lone time: the native input IS the chip's value, labelled by its noun. */
function TimeChip({
  record,
  ctx,
  highlighted,
  onWrite,
  onReset,
}: {
  record: SettingRecord;
  ctx: SettingCtx;
  highlighted?: boolean;
  onWrite: OnWrite;
  onReset: (record: SettingRecord) => void;
}) {
  const uid = useId();
  const controlId = `chip-${record.id}-${uid}`;
  const descId = `${controlId}-desc`;
  const value = safeRead(record, ctx);
  const { pending, reason, disabled } = availability([record], ctx);
  const modified = !disabled && isModified(record, ctx);
  const words = resetLabelFor(record);
  const description = describe(record.description, pending, reason);

  return (
    <ChipFrame
      hostId={record.id}
      highlighted={highlighted}
      modified={modified}
      title={reason ? `Unavailable — ${reason}` : record.description}
      descId={descId}
      description={description}
    >
      <span
        className={cn(
          PILL,
          'inline-flex items-center gap-1.5',
          'focus-within:ring-ring focus-within:ring-2',
          disabled && 'text-muted-foreground'
        )}
      >
        {/* Until the store answers, the value is a manifest default, and a live
            input would show it as the user's own — the "reads as off / wrong
            value" failure SettingRow's PendingControl exists to avoid. */}
        {pending ? (
          <span
            data-testid={`setting-${record.id}`}
            aria-describedby={description ? descId : undefined}
            aria-label={`${record.label} — still loading`}
            role="status"
          >
            <span className="text-muted-foreground">{record.label}</span>{' '}
            <span className="font-medium">Loading…</span>
          </span>
        ) : (
          <>
            <label htmlFor={controlId} className="text-muted-foreground">
              {record.label}
            </label>
            <input
              id={controlId}
              type="time"
              data-setting={record.dbColumn ?? record.id}
              data-testid={`setting-${record.id}`}
              aria-describedby={description ? descId : undefined}
              value={String(value)}
              disabled={disabled}
              onChange={(e) => {
                // '' is a cleared field, not a time — writing it would store a
                // ritual that never fires.
                if (e.target.value) onWrite(record, e.target.value);
              }}
              // -mx-1 px-1: room for the caret to paint, cancelled so the
              // value still sits where the borderless text would (caret-room).
              className="font-num -mx-1 min-w-0 bg-transparent px-1 font-medium focus-visible:outline-none disabled:cursor-not-allowed"
            />
          </>
        )}
      </span>
      {modified && (
        <button
          type="button"
          onClick={() => onReset(record)}
          title={words.title}
          aria-label={words.ariaLabel}
          className={cn(
            'text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-[5px]',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <RotateCcw className="size-3" aria-hidden />
        </button>
      )}
    </ChipFrame>
  );
}

/** A way somewhere, not a value — never modified, nothing to reset. */
function ActionChip({
  record,
  ctx,
  highlighted,
  onWrite,
}: {
  record: SettingRecord;
  ctx: SettingCtx;
  highlighted?: boolean;
  onWrite: OnWrite;
}) {
  const uid = useId();
  const descId = `chip-${record.id}-${uid}-desc`;
  const { pending, reason, disabled } = availability([record], ctx);
  const description = describe(record.description, pending, reason);
  return (
    <ChipFrame
      hostId={record.id}
      highlighted={highlighted}
      modified={false}
      title={reason ? `Unavailable — ${reason}` : record.description}
      descId={descId}
      description={description}
    >
      <button
        type="button"
        data-setting={record.id}
        data-testid={`setting-${record.id}`}
        aria-label={`${record.label}: ${String(safeRead(record, ctx))}`}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => onWrite(record, true)}
        className={cn(
          PILL,
          'hover-wash inline-flex items-center gap-1 font-medium transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        {record.label}
        <ArrowUpRight className="size-3" aria-hidden />
      </button>
    </ChipFrame>
  );
}

export function SettingChip({
  spec,
  ctx,
  highlight,
  onWrite,
  onReset,
  onResetMany,
}: {
  spec: ChipSpec;
  ctx: SettingCtx;
  /** The shell's highlighted id; a chip lights for its host id. */
  highlight: string | null;
  onWrite: OnWrite;
  onReset: (record: SettingRecord) => void;
  onResetMany: (records: SettingRecord[], label: string, display: string) => void;
}) {
  if (spec.kind === 'merged') {
    return (
      <PickerChip
        record={spec.value}
        toggle={spec.toggle}
        ctx={ctx}
        highlighted={highlight === spec.toggle.id}
        onWrite={onWrite}
        onReset={onReset}
        onResetMany={onResetMany}
      />
    );
  }
  const { record } = spec;
  const highlighted = highlight === record.id;
  switch (record.control) {
    case 'time':
      return (
        <TimeChip
          record={record}
          ctx={ctx}
          highlighted={highlighted}
          onWrite={onWrite}
          onReset={onReset}
        />
      );
    case 'action':
      return <ActionChip record={record} ctx={ctx} highlighted={highlighted} onWrite={onWrite} />;
    default:
      return (
        <PickerChip
          record={record}
          ctx={ctx}
          highlighted={highlighted}
          onWrite={onWrite}
          onReset={onReset}
          onResetMany={onResetMany}
        />
      );
  }
}
