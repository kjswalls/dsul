'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  decodeKeys,
  encodeKeys,
  formatKeys,
  isApplePlatform,
  matchesBinding,
  normalizeBinding,
  pressedKeys,
} from '@/lib/commands/keys';
import { useShortcutBindings } from '@/lib/keyboard-shortcuts-store';
import type { ShortcutSettingRecord } from '@/lib/settings/manifest';

/**
 * The one control that records a key chord instead of choosing a value.
 *
 * It lives beside the other setting controls because a binding IS a setting
 * now (see SHORTCUT_RECORDS in lib/settings/manifest.ts): SettingRow renders it
 * through the same `ControlFor` switch as a Switch or a chip, which is what
 * makes one binding searchable, deep-linkable and resettable by the machinery
 * every other row already uses.
 *
 * Both shells — the Keyboard settings pane and the ⌘/ overlay — render THIS,
 * so what recording does cannot differ between them.
 */

/** The chord, as caps. Presentational; the ordering is formatKeys' job. */
export function KeyCaps({ keys, isMac }: { keys: string[]; isMac: boolean }) {
  const labels = formatKeys(keys, isMac);
  if (labels.length === 0) return <span className="text-muted-foreground">No shortcut</span>;
  return (
    <>
      {labels.map((label, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1">+</span>}
          {label}
        </span>
      ))}
    </>
  );
}

/**
 * Why a recorded chord cannot be accepted, or null when it can.
 *
 * A pure function, and separate from the control, because both of its arms are
 * invisible from the outside: one depends on the PLATFORM (a bare Control combo
 * is dead on macOS, where pressedKeys deliberately leaves Control to the text
 * system) and one depends on every OTHER binding. A recorder that silently
 * accepts either produces a shortcut that looks set and runs nothing, or one
 * that looks set and runs something else.
 */
export function rejectionFor(
  keys: string[],
  shortcutId: string,
  bindings: { id: string; label: string; keys: string[] }[]
): string | null {
  // 'ctrl' survives normalization only on macOS — everywhere else pressedKeys
  // folds it into 'mod'. So its presence here IS the platform test.
  if (keys.includes('ctrl')) return 'macOS text editing. Use ⌘ instead';

  // The dispatcher takes the FIRST match in registry order, so saving a
  // duplicate leaves the row displaying a shortcut that runs another command.
  //
  // Normalized on BOTH sides, and after the ctrl test above rather than before
  // it (normalizeBinding folds ctrl into mod, which would erase the very thing
  // that test looks for). matchesBinding requires its left side sorted — a
  // contract it inherits from pressedKeys — so a caller that hands over a
  // display-ordered chord would otherwise get a silent "no conflict".
  const chord = normalizeBinding(keys);
  const clash = bindings.find(
    (other) => other.id !== shortcutId && matchesBinding(chord, other.keys)
  );
  return clash ? clash.label : null;
}

export function KeysControl({
  record,
  value,
  disabled,
  controlId,
  describedBy,
  onWrite,
}: {
  record: ShortcutSettingRecord;
  value: string;
  disabled?: boolean;
  controlId: string;
  describedBy?: string;
  onWrite: (next: string) => void;
}) {
  // Every binding, so a recorded chord can be checked against the ones already
  // taken. Read from the store rather than passed in: the overlay and the pane
  // must run the same conflict check, and a prop is a chance to pass a
  // different list.
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);

  // navigator.platform cannot change within a session, so reading it during a
  // render is safe — but it is undefined on the server.
  const isMac = useMemo(() => isApplePlatform(), []);

  const stop = () => {
    setRecording(false);
    setRecorded([]);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!recording) return;
    // Both, and not just preventDefault: the app's ONE window keydown
    // dispatcher (hooks/use-command-shortcuts.ts) and the settings page's own
    // '/' handler both listen on window, and a chord being RECORDED must not
    // also be RUN. stopPropagation on the native event is what keeps it from
    // reaching either.
    event.preventDefault();
    event.stopPropagation();
    if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;

    // Escape cancels. Without this it is recorded like any other key, which
    // both binds a key nothing should be bound to and leaves the recorder with
    // no way out that isn't clicking elsewhere.
    if (event.key === 'Escape') {
      stop();
      return;
    }

    // The exact function the dispatcher uses, so what you record is what will
    // match. Recording with different rules is how ['?', 'shift'] used to get
    // stored for a key that only ever arrives as ['?'].
    const keys = pressedKeys(event.nativeEvent);
    if (keys.length > 0 && keys.length <= 3) setRecorded(keys);
  };

  const handleKeyUp = () => {
    if (!recording || recorded.length === 0) return;

    const rejection = rejectionFor(recorded, record.shortcutId, bindings);
    if (rejection) {
      setConflict(rejection);
      stop();
      return;
    }

    setConflict(null);
    onWrite(encodeKeys(recorded));
    stop();
  };

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <button
        type="button"
        id={controlId}
        data-setting={record.id}
        data-shortcut={record.shortcutId}
        aria-describedby={describedBy}
        aria-label={
          recording
            ? `Recording a new shortcut for ${record.label}. Press a key combination, or Escape to cancel.`
            : `${record.label}: ${formatKeys(decodeKeys(value), isMac).join(' ') || 'no shortcut'}. Press to record a new one.`
        }
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={() => {
          if (recording) stop();
        }}
        onClick={() => {
          setRecording(true);
          setRecorded([]);
          setConflict(null);
        }}
        className={cn(
          'flex min-w-[100px] flex-wrap items-center justify-center gap-1 rounded-md border px-2 py-1',
          'font-mono text-xs outline-none transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          recording
            ? 'border-primary bg-primary/10 text-primary ring-primary ring-1'
            : 'border-border bg-muted text-foreground hover:border-primary/50',
          'focus-visible:ring-ring focus-visible:ring-2'
        )}
      >
        {recording ? (
          <span className="text-primary animate-pulse">Recording…</span>
        ) : (
          <KeyCaps keys={decodeKeys(value)} isMac={isMac} />
        )}
      </button>

      {/* Announced, not just coloured: refusing a chord silently is
          indistinguishable from the recorder not working.

          Rendered EMPTY from first paint rather than mounted with its message —
          creating a live region and its text in the same commit is why live
          regions silently fail (the same rule settings-shell's status line
          follows). It takes no height while it has nothing to say. */}
      <p
        role="status"
        aria-live="polite"
        className="text-destructive max-w-[132px] text-right text-[10px] empty:hidden"
      >
        {conflict
          ? conflict.startsWith('macOS')
            ? `Reserved for ${conflict}`
            : `Already used by “${conflict}”`
          : ''}
      </p>
    </div>
  );
}
