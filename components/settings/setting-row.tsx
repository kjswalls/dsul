'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { PropertyChip, ChipOption } from '@/components/primitives/property-chip';
import { cn } from '@/lib/utils';
import {
  displayValue,
  isModified,
  type SettingCtx,
  type SettingRecord,
  type ShortcutSettingRecord,
} from '@/lib/settings/manifest';
import { KeysControl } from './keys-control';
import { highlightRuns, type MatchRange } from '@/lib/settings/search';

/**
 * One setting, as a two-column contract: label (plus one consequence line) on
 * the left, exactly one control right-aligned on the right.
 *
 * The 132px control column is the point — every control's left and right edge
 * lands on the same two verticals down the whole pane, which is the single
 * biggest source of calm in a surface this long.
 *
 * Three defects in the old SettingRow are fixed here and are load-bearing:
 *   · the Label had no htmlFor, so every Switch in the dialog was nameless to
 *     assistive tech;
 *   · the description had no aria-describedby, so the explanation was invisible;
 *   · disabled rows used `opacity-50 pointer-events-none`, which leaves the
 *     control in the tab order and keyboard-operable while looking dead.
 */

const RESET_LABEL = 'Reset to default';

/**
 * The words a reset says for one label and its default — shared by a row's
 * reset and a chip's, so the two never drift.
 */
export function resetLabel(label: string, fallback: string): { title: string; ariaLabel: string } {
  return {
    title: `${RESET_LABEL} · ${fallback}`,
    ariaLabel: `${label} is changed from its default. ${RESET_LABEL}: ${fallback}`,
  };
}

/** The same words for one record — what its row's and its chip's reset say. */
export function resetLabelFor(record: SettingRecord) {
  return resetLabel(record.label, displayValue(record, record.defaultValue));
}

/**
 * With one user and no support channel, per-row reset IS the support channel.
 *
 * The label names the STATE as well as the action, because the lime modified
 * bar is a ::before pseudo-element and therefore invisible to assistive tech —
 * this is the only place a non-visual reader learns the row is off-default.
 *
 * Rendered rather than `hidden`-until-hover: display:none also removes it from
 * the accessibility tree and puts it out of reach on touch, where there is no
 * hover at all. It goes transparent instead, and is revealed by hover,
 * focus-within, or a coarse pointer.
 */
function ResetButton({
  record,
  onReset,
  className,
}: {
  record: SettingRecord;
  onReset: () => void;
  className?: string;
}) {
  const words = resetLabelFor(record);
  return (
    <button
      type="button"
      onClick={onReset}
      title={words.title}
      aria-label={words.ariaLabel}
      className={cn(
        'text-muted-foreground hover:text-foreground absolute grid size-6 place-items-center',
        'rounded-[5px] opacity-0 transition-[opacity,color]',
        'group-hover/set:opacity-100 group-focus-within/set:opacity-100 focus-visible:opacity-100',
        '[@media(hover:none)]:opacity-100',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
    >
      <RotateCcw className="size-3" aria-hidden />
    </button>
  );
}

function LabelTag({
  asLabel,
  htmlFor,
  className,
  children,
}: {
  asLabel: boolean;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!asLabel) return <span className={className}>{children}</span>;
  return (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  );
}

/**
 * What stands in the control slot while the row's store is still fetching.
 *
 * NOT the control, disabled. A disabled Switch still draws a position, and the
 * position it would draw is `read()`'s fallback — the manifest default, which
 * is not this account's answer and may be its opposite. Drawing nothing that
 * looks like a value is the only honest option: the row keeps its label, its
 * description and its place in the column, and says it is still loading.
 *
 * `animate-pulse` for the same reason SettingsSkeleton uses it — globals.css
 * clamps every animation to nothing under [data-reduce-motion], which the
 * animations setting stamps, so this respects it without knowing about it.
 */
function PendingControl({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={`${label}, still loading`}
      data-setting-pending="true"
      className="bg-secondary h-5 w-[52px] animate-pulse rounded-full"
    />
  );
}

function ControlFor({
  record,
  ctx,
  value,
  disabled,
  controlId,
  describedBy,
  onWrite,
}: {
  record: SettingRecord;
  ctx: SettingCtx;
  value: string | boolean;
  disabled: boolean;
  controlId: string;
  describedBy?: string;
  onWrite: (next: string | boolean) => void;
}) {
  // Text settings commit on BLUR, not on every keystroke: these are the only
  // composed values on the page, and saveSettings is debounced into a shared
  // buffer that a per-character write would thrash.
  const [draft, setDraft] = useState(String(value));
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const wasDirty = dirty.current;
    dirty.current = false;
    // A write-only credential's read() returns '' whatever is stored, so
    // "different from the rendered value" cannot see the one edit that matters
    // most — CLEARING the field. Without the dirty flag a stored token could be
    // replaced but never deleted from the UI, which is the wrong direction for
    // the only control here that holds a key to someone's house.
    const changed = record.textVariant === 'secret' ? wasDirty : draft !== String(value);
    if (!changed) return;
    onWrite(draft);
    // A write-only credential renders empty BY CONTRACT — its read() returns ''
    // whatever is stored — so `value` never changes and the sync effect above
    // never fires. Without this the typed token stays sitting in the box,
    // covering the placeholder that is the only signal anything was saved, and
    // the next blur re-sends it.
    if (record.textVariant === 'secret') setDraft('');
  };

  switch (record.control) {
    case 'switch':
      return (
        <Switch
          id={controlId}
          data-setting={record.dbColumn ?? record.id}
          aria-describedby={describedBy}
          checked={Boolean(value)}
          disabled={disabled}
          onCheckedChange={(next) => onWrite(next)}
        />
      );

    case 'enum':
      return (
        <PropertyChip
          id={controlId}
          // The visible text is the VALUE ("Dark"), so the name has to be
          // supplied — otherwise a screen reader announces "Dark, button".
          ariaLabel={record.label}
          label={record.label}
          value={displayValue(record, value)}
          // A preference is always set, so the caret stays: this chip is a
          // switcher, not a value that might be empty.
          alwaysChevron
          align="end"
          disabled={disabled}
          testId={`setting-${record.id}`}
          className="max-w-full"
          // PropertyChip's default picker is a fixed w-60 (240px), which is
          // right for the item dialog's project and label lists — long, free
          // text, often needing the room. A settings enum is three or four
          // known words ("Sunday", "12-hour", "Head & tray"), so a 240px panel
          // is mostly empty. Sized to the widest option instead, floored at the
          // trigger's own width so the panel never looks narrower than the
          // chip that opened it.
          contentClassName="w-auto min-w-[var(--radix-popover-trigger-width)] max-w-[min(18rem,var(--radix-popover-content-available-width))] p-1"
        >
          {(close) => (
            <div className="flex flex-col gap-0.5">
              {record.options?.map((option) => (
                <ChipOption
                  key={option.value}
                  value={option.value}
                  selected={String(value) === option.value}
                  onSelect={() => {
                    onWrite(option.value);
                    close();
                  }}
                >
                  {option.label}
                </ChipOption>
              ))}
            </div>
          )}
        </PropertyChip>
      );

    case 'time':
      return (
        <input
          id={controlId}
          type="time"
          data-setting={record.dbColumn ?? record.id}
          aria-describedby={describedBy}
          value={String(value)}
          disabled={disabled}
          // Clearing a native time input (or a half-typed one, in some
          // browsers) fires change with ''. That is not a time, and writing it
          // would store a cue that never fires.
          onChange={(e) => {
            if (e.target.value) onWrite(e.target.value);
          }}
          className={cn(
            'field bg-background text-foreground h-8 w-[104px] border px-2',
            'font-num text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
      );

    case 'text': {
      // Selected by the record's declared variant, not by its id. The old test
      // was `record.id === 'beacon.apiKey'`, which was fine at one record and
      // would have become a growing list of ids the moment the channel
      // credentials arrived.
      const variant = record.textVariant ?? 'multiline';
      const placeholder =
        typeof record.placeholder === 'function' ? record.placeholder(ctx) : record.placeholder;

      // Multiline is the only variant that needs more than 132px; it drops to
      // its own line (see `wide` below, which must agree with this).
      if (variant === 'multiline') {
        return (
          <Textarea
            id={controlId}
            aria-describedby={describedBy}
            value={draft}
            disabled={disabled}
            rows={4}
            placeholder={placeholder}
            onChange={(e) => {
              dirty.current = true;
              setDraft(e.target.value);
            }}
            onBlur={commit}
            className="min-h-20 w-full text-xs"
          />
        );
      }

      return (
        <Input
          id={controlId}
          // A 'secret' record's read() returns '' by contract, so there is
          // nothing to mask — the password type is here to stop the browser
          // offering to remember, and to keep a token off a shared screen while
          // it is being typed.
          type={variant === 'secret' ? 'password' : 'text'}
          aria-describedby={describedBy}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            dirty.current = true;
            setDraft(e.target.value);
          }}
          onBlur={commit}
          className="h-8 w-[132px] text-xs"
        />
      );
    }

    case 'action':
      return (
        <Button
          id={controlId}
          variant="outline"
          size="sm"
          disabled={disabled}
          data-setting={record.id}
          onClick={() => record.write(true, ctx)}
        >
          {String(value)}
        </Button>
      );

    case 'info':
      return (
        <span className="text-muted-foreground font-num truncate text-xs" title={String(value)}>
          {String(value)}
        </span>
      );

    case 'keys':
      // Only SHORTCUT_RECORDS declare this control, and they are the only
      // records that carry `shortcutId` — the cast is the boundary between the
      // open SettingRecord the row is given and the narrower record this one
      // control needs. `write` goes through onWrite like every other control,
      // so the row's reset button reaches the same path.
      return (
        <KeysControl
          record={record as ShortcutSettingRecord}
          value={String(value)}
          disabled={disabled}
          controlId={controlId}
          describedBy={describedBy}
          onWrite={onWrite}
        />
      );
  }
}

export function SettingRow({
  record,
  ctx,
  value,
  onWrite,
  onReset,
  /** Set while the row is a search result — shows its pane and match reason. */
  paneName,
  ranges,
  matchedValue,
  /**
   * An ancestor is off. Search results only — the pane hides such a row
   * instead (lib/settings/groups.ts) — and genuinely disabled, never faded.
   */
  inactive,
  highlighted,
  /**
   * A way to where the setting is actually made, drawn after the control.
   * Search results only, for a record whose control lives in a panel rather
   * than in its row (CONNECT_PANEL_RECORD_IDS): an 'info' value alone is a
   * dead end.
   */
  action,
}: {
  record: SettingRecord;
  ctx: SettingCtx;
  value: string | boolean;
  onWrite: (next: string | boolean) => void;
  onReset: () => void;
  paneName?: string;
  ranges?: MatchRange[];
  matchedValue?: string;
  inactive?: boolean;
  highlighted?: boolean;
  action?: React.ReactNode;
}) {
  const uid = useId();
  const controlId = `set-${record.id}-${uid}`;
  const descId = record.description ? `${controlId}-desc` : undefined;

  // A store that cannot answer yet outranks every other reason a row might be
  // disabled: until it answers, "unavailable", "inactive" and the value itself
  // are all being computed from defaults. Read behind a try/catch for the same
  // reason settings-shell reads `read()` that way — one extension must never
  // cost the others their row.
  let pending = false;
  try {
    pending = record.pending?.(ctx) ?? false;
  } catch {
    pending = false;
  }
  const unavailableReason = pending ? null : (record.unavailable?.(ctx) ?? null);
  const disabled = pending || Boolean(inactive) || unavailableReason !== null;
  const modified = isModified(record, ctx) && !disabled;
  // Must agree with the variant switch above: only the textarea goes full width.
  const wide = record.control === 'text' && (record.textVariant ?? 'multiline') === 'multiline';

  const runs = highlightRuns(record.label, ranges ?? []);

  return (
    <div
      data-setting-row={record.id}
      data-highlight={highlighted || undefined}
      tabIndex={-1}
      className={cn(
        'group/set relative -mx-3 rounded-[5px] px-3 py-2.5 transition-colors',
        // Transparent at rest, so the translucent wash composites identically in
        // both themes. Anything with a resting fill uses hover-wash instead.
        'hover:bg-accent',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        // 162px = the 132px control column plus the 24px reset slot and its gap,
        // so every control's right edge still lands on one vertical down the
        // whole pane — the single biggest source of calm in a surface this long.
        wide ? 'flex flex-col gap-2' : 'grid grid-cols-[minmax(0,1fr)_162px] items-center gap-6',
        // Its own element, and never inside anything that fades: the lime
        // accent must not be dimmed through a parent's opacity.
        modified &&
          'before:bg-primary before:absolute before:top-1/2 before:left-0 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:content-[""]',
        highlighted && 'after:ring-ring after:pointer-events-none after:absolute after:inset-0 after:rounded-[5px] after:ring-2 after:content-[""]'
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {/* An 'info' row has no control to label — a <label htmlFor> pointing
              at a <span> is a dangling association, not a helpful one. A
              pending row has no control either, for the same window. */}
          <LabelTag
            asLabel={record.control !== 'info' && !pending}
            htmlFor={controlId}
            className={cn(
              'text-sm font-medium',
              disabled ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {runs.map((run, i) =>
              run.hit ? (
                <mark key={i} className="bg-primary/30 rounded-[2px] px-0.5 text-inherit">
                  {run.text}
                </mark>
              ) : (
                <span key={i}>{run.text}</span>
              )
            )}
          </LabelTag>
          {record.advanced && paneName && (
            <span className="border-border text-muted-foreground rounded-[4px] border px-1 text-[9px] font-medium tracking-wide uppercase">
              Advanced
            </span>
          )}
        </div>

        {record.description && (
          <p id={descId} className="text-muted-foreground mt-[3px] max-w-[46ch] text-xs">
            {record.description}
          </p>
        )}

        {paneName && (
          <p className="text-muted-foreground mt-[3px] text-[10px] font-medium tracking-wider uppercase">
            {paneName}
          </p>
        )}

        {/* Why this row surfaced, when it wasn't the label that matched. */}
        {matchedValue && (
          <p className="text-muted-foreground font-num mt-[3px] text-[10px]">
            matches: {matchedValue}
          </p>
        )}

        {/* Silence here reads as a broken index — you search again with the
            same words. Name the reason instead. */}
        {unavailableReason && (
          <p className="text-muted-foreground mt-[3px] text-[10px]">
            Unavailable: {unavailableReason}
          </p>
        )}

        {/* Said in words as well as in the placeholder: the difference between
            "off" and "not known yet" is invisible if you only look at a
            control, and this row's whole failure mode was being read as off. */}
        {pending && (
          <p className="text-muted-foreground mt-[3px] text-[10px]">Still loading…</p>
        )}
      </div>

      {/* Right-packed, with reset rendered BEFORE the control. Because the row
          packs to the end, adding the button doesn't move the control — it
          appears in the space to its left — so there is no hover jitter and no
          reserved slot to leave a hundred pixels of dead air beside a 32px
          switch. */}
      <div
        className={cn(
          'flex min-h-7 items-center gap-1.5',
          wide ? 'w-full' : 'justify-end'
        )}
      >
        {!wide && modified && (
          <ResetButton record={record} onReset={onReset} className="static translate-y-0" />
        )}
        {pending ? (
          <PendingControl label={record.label} />
        ) : (
          <ControlFor
            record={record}
            ctx={ctx}
            value={value}
            disabled={disabled}
            controlId={controlId}
            describedBy={descId}
            onWrite={onWrite}
          />
        )}
        {action}
      </div>

      {/* On a wide row the control is a full-width textarea below the label, so
          the button parks on the LABEL line instead — over the textarea it
          would eat the click that places your caret. */}
      {wide && modified && (
        <ResetButton record={record} onReset={onReset} className="top-2.5 right-3" />
      )}
    </div>
  );
}
