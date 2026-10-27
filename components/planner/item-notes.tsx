'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
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
import { holdNoteEditor, useItemNotesStore } from '@/lib/item-notes-store';
import { usePlannerStore } from '@/lib/planner-store';
import { noteIsLong, type NoteEntry } from '@/lib/item-timeline';
import { noteKey } from '@/lib/sync-sheen';
import { cn } from '@/lib/utils';

/**
 * Notes on an item's timeline (lib/item-notes.ts, migration 082), as every
 * host of the timeline draws them: a line in the stream (`TimelineNoteRow`)
 * with its menu (Move to Notes, Edit, Delete), its editor, and an inline
 * delete confirm. Nothing writes a new one since the item panel tidy, round 3
 * made the description under the title (`items.notes`) the one place for what
 * is true about an item; Move to Notes carries one there.
 *
 * A note is yours: saved to the item, never sent to a model.
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
          'text-foreground font-sans text-sm leading-relaxed break-words whitespace-pre-wrap',
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

/**
 * Carry a timeline note into the item's description, after what is there, and
 * then delete it. The description is written first: if the delete then fails,
 * the text is in both places, never in neither.
 */
async function moveToNotes(itemId: string, note: ItemNote): Promise<void> {
  const planner = usePlannerStore.getState();
  const item = planner.items.find((i) => i.id === itemId);
  if (!item) return;
  const had = item.notes?.trimEnd() ?? '';
  const notes = had ? `${had}\n\n${note.body}` : note.body;
  if (item.type === 'habit') planner.updateHabit(itemId, { notes });
  else planner.updateTask(itemId, { notes });
  await useItemNotesStore.getState().remove(itemId, note.id);
}

/** Move to Notes, Edit, Delete. Disabled while the note's insert has not answered. */
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
        <DropdownMenuItem data-testid="item-note-move" onSelect={() => void moveToNotes(itemId, note)}>
          Move to Notes
        </DropdownMenuItem>
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
  // No menu while editing or confirming: a move would take the note out from
  // under the edit.
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
