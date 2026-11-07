'use client';

import { forwardRef, useImperativeHandle, useRef, type ComponentProps, type UIEvent } from 'react';
import { useEscapeRung } from '@/components/planner/organize/escape-ladder';
import { Textarea } from '@/components/ui/textarea';
import { notesLineSpans, type NotesSpanKind } from '@/lib/notes-markdown';
import { cn } from '@/lib/utils';

/**
 * The notes editor: the same plain textarea as ever (its caret, selection,
 * undo, IME, spellcheck, paste and every test that types into it are the
 * browser's own), with its text drawn transparent over a painted copy of
 * itself where markdown's markers are faint and headings, bold and links
 * take their weight as you type (Kirby's pick C, 2026-11-07).
 *
 * The two layers must wrap at the same characters, so the painted one shares
 * the textarea's every metric (`className` goes on both) and never changes a
 * glyph's width: bold is a hairline text-shadow, not a heavier font, and
 * nothing is italic. It scrolls with the textarea, and both keep a stable
 * scrollbar gutter so a scrollbar appearing never narrows only one of them.
 * The caret is still the field's own (`.field`, lime ink).
 */
const PAINT: Record<NotesSpanKind, string | undefined> = {
  text: undefined,
  marker: 'text-muted-foreground/55',
  heading: 'text-foreground [text-shadow:0.4px_0_0_currentColor]',
  strong: 'text-foreground [text-shadow:0.4px_0_0_currentColor]',
  em: 'text-foreground',
  code: 'rounded-sm bg-muted',
  link: 'underline decoration-muted-foreground/60 underline-offset-2',
};

function Painted({ value }: { value: string }) {
  const lines = value.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {notesLineSpans(line).map((s, j) =>
            PAINT[s.kind] ? (
              <span key={j} className={PAINT[s.kind]}>
                {s.text}
              </span>
            ) : (
              s.text
            )
          )}
          {i < lines.length - 1 ? '\n' : null}
        </span>
      ))}
      {/* A textarea leaves room for a caret on a last, empty line; so does this. */}
      {'​'}
    </>
  );
}

type LiveNotesFieldProps = ComponentProps<typeof Textarea> & {
  value: string;
  /**
   * Escape while the field has focus, through the item's Escape ladder (Radix
   * decides on Escape before any onKeyDown here). True claims the press, so
   * finishing an edit never closes the item.
   */
  onEscape?: () => boolean;
};

export const LiveNotesField = forwardRef<HTMLTextAreaElement, LiveNotesFieldProps>(
  function LiveNotesField({ className, value, onScroll, onEscape, ...props }, ref) {
    const paintRef = useRef<HTMLDivElement>(null);
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => fieldRef.current as HTMLTextAreaElement);
    useEscapeRung(() => {
      if (!onEscape || !fieldRef.current || document.activeElement !== fieldRef.current) return false;
      return onEscape();
    });
    const sync = (e: UIEvent<HTMLTextAreaElement>) => {
      if (paintRef.current) paintRef.current.scrollTop = e.currentTarget.scrollTop;
      onScroll?.(e);
    };
    return (
      <div className="relative" data-live-notes>
        <div
          ref={paintRef}
          aria-hidden
          className={cn(
            // The Textarea primitive's own metrics first, then the caller's, so
            // the copy lays out exactly as the field does.
            'min-h-16 w-full border border-transparent px-3 py-2 text-base md:text-sm',
            className,
            'pointer-events-none absolute top-0 bottom-0 left-0 block overflow-hidden break-words whitespace-pre-wrap select-none [scrollbar-gutter:stable]'
          )}
        >
          <Painted value={value} />
        </div>
        <Textarea
          ref={fieldRef}
          value={value}
          onScroll={sync}
          spellCheck
          className={cn(
            className,
            'relative block text-transparent [scrollbar-gutter:stable] selection:bg-primary/20 selection:text-transparent'
          )}
          {...props}
        />
      </div>
    );
  }
);
