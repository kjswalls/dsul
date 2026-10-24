'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { format, isToday } from 'date-fns';
import { ArrowUp, MoreHorizontal, Pin } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SERIF_NOTES_CLASS } from '@/components/planner/surface';
import { TimelineAvatar } from '@/components/planner/item-timeline';
import { useEscapeRung } from '@/components/planner/organize/escape-ladder';
import { NOTE_COPY, cleanNoteBody, noteLength, noteRefusal, type ItemNote } from '@/lib/item-notes';
import { holdNoteEditor, saveNoteFrom, useItemNotesStore } from '@/lib/item-notes-store';
import { noteIsLong, type NoteEntry } from '@/lib/item-timeline';
import { noteDraftKey, useRailStore } from '@/lib/rail-store';
import { noteKey } from '@/lib/sync-sheen';
import { cn } from '@/lib/utils';

/**
 * Notes on an item's timeline (lib/item-notes.ts, migration 082), as every
 * host of the timeline draws them: a line in the stream (`TimelineNoteRow`),
 * the one pinned note on top (`PinnedNote`), each with its menu (Pin to top or
 * Unpin, Edit, Delete), its editor, and an inline delete confirm; and, where
 * no AI answers, the Note box at the timeline's foot (`ItemNoteBox`).
 *
 * A note is yours: saved to the item, never sent to a model. The description
 * under the title (`items.notes`) is a different field and is untouched here.
 *
 * ESCAPE goes through the item's Escape ladder (ItemDialog owns it): Radix
 * Dialog and vaul decide on Escape in the capture phase, before any onKeyDown
 * in the body, so the editor and the confirm register rungs that back out
 * first and keep the item open. The onKeyDown below is the fallback for the
 * docked panel and any host with no ladder.
 */

const timeOf = (at: number | string) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** The body as written: serif, newlines kept, a long one folded under "Show all". */
export function NoteBody({ note, clampable = true }: { note: ItemNote; clampable?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = clampable && noteIsLong(note.body);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <p
        className={cn(
          'text-foreground font-serif text-sm leading-relaxed break-words whitespace-pre-wrap',
          long && !open && 'line-clamp-8'
        )}
        data-testid="item-note-body"
        // A note another device added or changed takes a pass of light (lib/sync-sheen.ts).
        data-sync-key={noteKey(note.id)}
      >
        {note.body}
      </p>
      {long && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-2xs"
          data-testid="item-note-more"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** Pin to top or Unpin, Edit, Delete. Disabled while the note's insert has not answered. */
export function NoteMenu({
  itemId,
  note,
  onEdit,
  onDelete,
}: {
  itemId: string;
  note: ItemNote;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const pending = useItemNotesStore((s) => !!s.pending[note.id]);
  // An Edit or Delete moves focus into the foot it opens, not back to this button.
  const steered = useRef(false);
  const pinned = note.pinnedAt !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={pending}>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Note options"
          aria-disabled={pending || undefined}
          disabled={pending}
          data-testid="item-note-menu"
          className={cn(
            'text-muted-foreground hover:text-foreground size-5 shrink-0 rounded',
            'opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100'
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (!steered.current) return;
          steered.current = false;
          e.preventDefault();
        }}
      >
        {pinned ? (
          <DropdownMenuItem
            data-testid="item-note-unpin"
            onSelect={() => void useItemNotesStore.getState().unpin(itemId, note.id)}
          >
            Unpin
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            data-testid="item-note-pin"
            onSelect={() => void useItemNotesStore.getState().pin(itemId, note.id)}
          >
            Pin to top
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          data-testid="item-note-edit"
          onSelect={() => {
            steered.current = true;
            onEdit();
          }}
        >
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="item-note-delete"
          className="text-destructive-text"
          onSelect={() => {
            steered.current = true;
            onDelete();
          }}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Grow a textarea to its content, up to `max` px, then scroll. */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, max: number) {
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    if (ta.scrollHeight === 0) {
      ta.style.height = '';
      return;
    }
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [ref, value, max]);
}

/**
 * The body's place while editing. It stays mounted until `edit()` settles:
 * read-only while the save is on its way, closed on success, and open with
 * the text you wrote on any refusal, so a failed save never loses an edit.
 */
export function NoteEditor({ itemId, note, onDone }: { itemId: string; note: ItemNote; onDone: () => void }) {
  const [text, setText] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const lost = useItemNotesStore((s) => !!s.lost[note.id]);
  const pending = useItemNotesStore((s) => !!s.pending[note.id]);
  useAutoGrow(fieldRef, text, 240);
  // A lost note goes once no editor shows it (the item closed without Cancel).
  useEffect(() => holdNoteEditor(itemId, note.id), [itemId, note.id]);
  useEffect(() => {
    const ta = fieldRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const cancel = () => {
    if (lost) useItemNotesStore.getState().forget(itemId, note.id);
    onDone();
  };
  useEscapeRung(() => {
    if (!wrapRef.current?.contains(document.activeElement)) return false;
    cancel();
    return true;
  });

  const blank = !cleanNoteBody(text);
  const save = async () => {
    if (busy || blank || pending) return;
    const body = cleanNoteBody(text);
    const why = noteRefusal(body);
    if (why) {
      if (why === 'too_long') toast.error(NOTE_COPY.refusal.too_long(noteLength(body)));
      return;
    }
    if (lost) {
      toast.error(NOTE_COPY.noteGone);
      return;
    }
    setBusy(true);
    const res = await useItemNotesStore.getState().edit(itemId, note.id, body);
    setBusy(false);
    if (res === true) onDone();
  };

  return (
    <div ref={wrapRef} className="flex flex-col gap-1.5" data-testid="item-note-editor">
      <Textarea
        ref={fieldRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={busy}
        aria-busy={busy || undefined}
        aria-label="Edit note"
        data-sub-input
        rows={2}
        className={cn(SERIF_NOTES_CLASS, 'border-border mx-0 w-full rounded-md border px-2 py-1.5')}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            cancel();
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          data-testid="item-note-save"
          disabled={blank || pending}
          aria-busy={busy || undefined}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-3 text-xs" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** "Delete this note?" Delete · Keep, where the note's foot was. Escape means Keep. */
function DeleteConfirm({ itemId, note, onDone }: { itemId: string; note: ItemNote; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus({ preventScroll: true });
  }, []);
  useEscapeRung(() => {
    if (!ref.current?.contains(document.activeElement)) return false;
    onDone();
    return true;
  });
  return (
    <div
      ref={ref}
      className="flex items-center gap-2 text-xs"
      data-testid="item-note-confirm-row"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        onDone();
      }}
    >
      <span className="text-muted-foreground">Delete this note?</span>
      <button
        type="button"
        className="text-destructive-text hover:underline"
        data-testid="item-note-confirm"
        onClick={async () => {
          if (await useItemNotesStore.getState().remove(itemId, note.id)) return;
          onDone();
        }}
      >
        Delete
      </button>
      <button
        ref={keepRef}
        type="button"
        className="text-muted-foreground hover:text-foreground"
        data-testid="item-note-keep"
        onClick={onDone}
      >
        Keep
      </button>
    </div>
  );
}

/**
 * A note's line and body, with its menu, editor and confirm. `header` draws
 * the line around the menu it is handed; a note found deleted while it was
 * being edited (`lost`) shows nothing but its editor.
 */
function NoteFrame({
  itemId,
  note,
  header,
  body,
}: {
  itemId: string;
  note: ItemNote;
  header: (menu: ReactNode) => ReactNode;
  body: (content: ReactNode) => ReactNode;
}) {
  const lost = useItemNotesStore((s) => !!s.lost[note.id]);
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const back = () => setMode('view');
  if (lost) return <>{body(<NoteEditor itemId={itemId} note={note} onDone={back} />)}</>;
  // No menu while editing or confirming: a pin or unpin would move the note to
  // the other host (PinnedNote / TimelineNoteRow), remounting this frame and
  // dropping the edit.
  const menu =
    mode === 'view' ? (
      <NoteMenu itemId={itemId} note={note} onEdit={() => setMode('edit')} onDelete={() => setMode('confirm')} />
    ) : null;
  return (
    <>
      {header(menu)}
      {body(
        mode === 'edit' ? (
          <NoteEditor itemId={itemId} note={note} onDone={back} />
        ) : (
          <>
            <NoteBody note={note} />
            {mode === 'confirm' && <DeleteConfirm itemId={itemId} note={note} onDone={back} />}
          </>
        )
      )}
    </>
  );
}

/** One note in the stream: You · note, the time, its menu, and the body under it. */
export function TimelineNoteRow({ itemId, entry }: { itemId: string; entry: NoteEntry }) {
  const { note } = entry;
  return (
    <div data-testid="item-timeline-note" data-note-id={note.id} className="group/note flex flex-col">
      <NoteFrame
        key={note.id}
        itemId={itemId}
        note={note}
        header={(menu) => (
          <div className="flex items-center gap-2">
            <TimelineAvatar who="you" />
            <span className="min-w-0 flex-1 truncate text-xs">
              <span className="text-foreground font-medium">You</span>
              <span className="text-muted-foreground"> · note</span>
            </span>
            {note.editedAt && (
              <span className="text-muted-foreground text-2xs" title={new Date(note.editedAt).toLocaleString()}>
                edited
              </span>
            )}
            <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">{timeOf(entry.at)}</time>
            {menu}
          </div>
        )}
        body={(content) => <div className="my-1 pl-7">{content}</div>}
      />
    </div>
  );
}

/**
 * The item's one pinned note, on top of the timeline. No lime, no opacity.
 * Hosts key it by the note's id, so a different note pinned (here or on another
 * device) never inherits this one's open editor or confirm.
 */
export function PinnedNote({ itemId, note }: { itemId: string; note: ItemNote }) {
  const created = new Date(note.createdAt);
  return (
    <div
      data-testid="item-note-pinned"
      data-note-id={note.id}
      className="group/note border-border bg-surface-2 flex flex-col gap-1.5 rounded-xl border px-3 py-2.5"
    >
      <NoteFrame
        key={note.id}
        itemId={itemId}
        note={note}
        header={(menu) => (
          <div className="flex items-center gap-1.5">
            <Pin className="text-muted-foreground size-3 shrink-0" aria-hidden />
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px] tracking-wider uppercase">
              Note · pinned
            </span>
            <time
              className="text-muted-foreground/70 shrink-0 font-mono text-[10px]"
              dateTime={created.toISOString()}
              title={created.toLocaleString()}
            >
              {isToday(created) ? timeOf(note.createdAt) : format(created, 'MMM d')}
            </time>
            {menu}
          </div>
        )}
        body={(content) => content}
      />
    </div>
  );
}

/**
 * The Note box where no AI answers (part (d)): at the foot of ItemTimeline,
 * with no switch, since there is only one thing it can do. Its text is the
 * item's note draft (rail-store `noteDraftKey`), so a half-written note
 * outlives the view and a failed save's put-back lands here. Drawn only once
 * notes are known to be available.
 */
export function ItemNoteBox({ itemId }: { itemId: string }) {
  const available = useItemNotesStore((s) => s.available);
  const key = noteDraftKey(itemId);
  const draft = useRailStore((s) => s.drafts[key] ?? '');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(fieldRef, draft, 160);
  if (available !== true) return null;
  const save = () => {
    const body = cleanNoteBody(draft);
    const why = noteRefusal(body);
    if (why) {
      if (why === 'too_long') toast.error(NOTE_COPY.refusal.too_long(noteLength(body)));
      return;
    }
    useRailStore.getState().setDraft(key, '');
    void saveNoteFrom(itemId, body);
  };
  return (
    <div className="field flex items-end gap-1.5 border px-2 py-1" data-testid="item-note-box">
      <Textarea
        ref={fieldRef}
        value={draft}
        rows={1}
        onChange={(e) => useRailStore.getState().setDraft(key, e.target.value)}
        placeholder="Add a note…"
        aria-label="Note on this item"
        data-sub-input
        data-testid="item-note-input"
        className="placeholder:text-muted-foreground -mx-1 min-h-0 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-0.5 text-xs leading-5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          save();
        }}
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        disabled={!draft.trim()}
        onClick={save}
        aria-label="Save note"
        data-testid="item-note-box-save"
      >
        <ArrowUp className="size-3.5" />
      </Button>
    </div>
  );
}
