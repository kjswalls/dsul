'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';

import type { SettingOption, SettingRecord } from '@/lib/settings/manifest';
import { cn } from '@/lib/utils';

/**
 * A pick between two or three named options, drawn as a tray (Kirby,
 * 2026-11-07, after the done/skip control): a sunk tray holding the options,
 * the picked one a raised face with a lime tick. A switch still means on or
 * off; a tray means "pick one of these", and a longer list stays a menu.
 *
 * It is a radio group: the picked option is the one tab stop, and the arrow
 * keys move the pick, as a native radio group does.
 */

/** Longest the labels may run, together, before a tray outgrows a row. */
const TRAY_LABEL_CHARS = 22;

/** A record drawn as a tray rather than a menu: 2 or 3 short options. */
export function trayFits(record: SettingRecord): boolean {
  const options = record.options ?? [];
  if (record.control !== 'enum' || options.length < 2 || options.length > 3) return false;
  return options.reduce((n, o) => n + o.label.length, 0) <= TRAY_LABEL_CHARS;
}

export function SettingTray({
  id,
  label,
  options,
  value,
  disabled,
  describedBy,
  testId,
  onChange,
}: {
  id?: string;
  label: string;
  options: readonly SettingOption[];
  value: string;
  disabled?: boolean;
  describedBy?: string;
  testId?: string;
  onChange: (next: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const picked = options.findIndex((o) => o.value === value);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next].value);
  };

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      data-slot="tray"
      className="tray"
    >
      {options.map((option, index) => {
        const on = index === picked;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            // The picked option is the group's one tab stop; with nothing
            // picked (a value no option names), the first one is.
            tabIndex={on || (picked === -1 && index === 0) ? 0 : -1}
            disabled={disabled}
            data-value={option.value}
            data-picked={on || undefined}
            onClick={() => {
              if (!on) onChange(option.value);
            }}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn('tray-option')}
          >
            {on && <Check aria-hidden className="tray-tick" strokeWidth={3} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
