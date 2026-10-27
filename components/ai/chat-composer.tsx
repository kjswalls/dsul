'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUp, Mic, Plus, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { ModelPicker } from '@/components/settings/model-picker';
import { connectErrorCopy, labelName } from '@/components/ai/connect/connect-shared';
import { resolveConversationId, useConversationsStore, type ConversationsState } from '@/lib/conversations-store';
import { bindingKey, sendFrom, type ComposerBinding } from '@/lib/open-chat';
import type { AskSurface } from '@/lib/rail-store';
import { chatAssistantName, chatPlaceholder, itemChatPlaceholder } from '@/lib/chat-utils';
import { useBoxAnswersAgent } from '@/lib/agent-question';
import { activeMention, insertMention, mentionChoices } from '@/lib/chat-mentions';
import { activeSlash } from '@/lib/chat-slash';
import { SlashCommands, type SlashCommandsHandle } from './chat-slash-commands';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { MAX_CHAT_IMAGES, imageDataUrl, type ChatImage } from '@/lib/chat-images';
import { ITEM_FILE_LIMITS, REFUSAL_COPY, fileBadge, isThumbable, sizeLabel } from '@/lib/item-files';
import { useItemFilesStore } from '@/lib/item-files-store';
import { ATTACH_COPY, readChatImage } from './chat-image-attach';

/** Auto-grow ceiling, past which the field scrolls instead of pushing further. */
const MAX_HEIGHT_PX = 120;

/**
 * A file in an item's box, waiting for Send: the ORIGINAL, which is what the
 * item keeps, plus the shrunk picture the model sees this turn (when one does),
 * and an object URL for a picture's chip when no model will see it.
 */
interface ItemAttachment {
  id: string;
  file: File;
  image?: ChatImage;
  preview?: string;
}

const isPicture = (f: File) => f.type.startsWith('image/');
const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
const revoke = (list: readonly ItemAttachment[]) => {
  for (const a of list) if (a.preview) URL.revokeObjectURL(a.preview);
};

interface ChatComposerProps {
  /**
   * 'panel' is the tray at the foot of a conversation — a rounded field over an
   * attach/voice rail. 'dock' is the phone's bottom bar wearing the omnibar's
   * pill: on the chat tab the dock's one row IS the composer, so the phone
   * keeps a single address for typing whichever surface you are on.
   */
  variant: 'panel' | 'dock';
  /** Where a send goes (lib/open-chat.ts `sendFrom` decides what that means). */
  binding: ComposerBinding;
  /**
   * Which Ask stack a send that starts a conversation pushes it on: the
   * phone's dock bar says 'phone'. Absent: the desktop rail's.
   */
  surface?: AskSurface;
  /**
   * The text, held by the caller (BoundComposer keeps it in rail-store, so a
   * half-typed message outlives the view it was typed in). Absent: the field
   * keeps its own.
   */
  value?: string;
  onValueChange?: (text: string) => void;
  /** Overrides the wording for whoever answers ("Reply…" under a conversation). */
  placeholder?: string;
  /**
   * False while the field is mounted where nobody can see it (BoundComposer's
   * ComposerAwakeContext: Ask hidden under an item). A hidden field measures
   * 0px tall, so the auto-grow waits, and measures again the moment it shows.
   */
  awake?: boolean;
}

/**
 * The conversation a binding is showing right now, if it has one yet: an
 * item's resolves through the store's index (or the draft still on its way to
 * its first save).
 */
function boundThreadId(s: ConversationsState, binding: ComposerBinding): string | null {
  switch (binding.kind) {
    case 'home':
      return null;
    case 'item': {
      const known = s.itemIndex[binding.itemId];
      if (typeof known === 'string') return resolveConversationId(known);
      return (
        Object.values(s.threads).find((t) => t.itemId === binding.itemId && !t.saved && t.load !== 'gone')?.id ?? null
      );
    }
    default:
      return resolveConversationId(binding.id);
  }
}

/**
 * The chat input (a connected model, or OpenClaw), in the two shapes the app
 * mounts it in. Named after whoever EFFECTIVELY answers (the AI gate's
 * `target`), never after the device's stored choice, which may not be usable.
 *
 * One component rather than two because the behaviour — Enter sends, Shift+Enter
 * newlines, auto-grow to a ceiling, busy mid-stream, cleared and refocused on
 * send — is the contract, and the mobile redesign moved the phone's copy of
 * it from the foot of the conversation into the dock. Two implementations would
 * have drifted on the first of those rules that got fixed in one place.
 */
export function ChatComposer({
  variant,
  binding,
  surface,
  value,
  onValueChange,
  awake = true,
  placeholder: placeholderOverride,
}: ChatComposerProps) {
  const threadId = useConversationsStore((s) => boundThreadId(s, binding));
  // Busy from the moment a send starts (before an item's conversation is even
  // known) until the reply has finished arriving.
  const isLoading = useConversationsStore(
    (s) => !!s.sending[bindingKey(binding)] || (threadId !== null && !!s.threads[threadId]?.streaming)
  );
  const { target } = useAICapabilities();

  const itemId = binding.kind === 'item' ? binding.itemId : null;
  const busy = isLoading;

  const [ownInput, setOwnInput] = useState('');
  const input = value ?? ownInput;
  const setInput = (text: string) => {
    if (value === undefined) setOwnInput(text);
    else onValueChange?.(text);
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // @ items (lib/chat-mentions.ts): the caret says whether an @ is being
  // typed, and the planner's items are what it can pick. Escape closes the
  // list for that one @, which a new @ (or a move away and back) reopens.
  const items = usePlannerStore((s) => s.items);
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const mention = caret === null ? null : activeMention(input, caret);
  const choices = useMemo(
    () => (mention && mention.start !== closedAt ? mentionChoices(items, mention.query) : []),
    [mention?.start, mention?.query, closedAt, items] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const listOpen = choices.length > 0 && !busy;
  const listId = useId();
  const active = listOpen ? Math.min(highlight, choices.length - 1) : -1;

  // / commands (lib/chat-slash.ts): a message that starts with "/" offers the
  // ⌘K commands that match it. Escape closes the list until the "/" is gone.
  const slashRef = useRef<SlashCommandsHandle>(null);
  const [slashClosed, setSlashClosed] = useState(false);
  const slash = caret === null || mention ? null : activeSlash(input, caret);
  const slashOpen = !!slash && !slashClosed && !busy;
  // Named by the list itself, which alone knows whether anything matched.
  const [slashActive, setSlashActive] = useState<string | undefined>(undefined);

  const readCaret = (ta: HTMLTextAreaElement) => {
    const at = ta.selectionStart === ta.selectionEnd ? ta.selectionStart : null;
    setCaret(at);
    if (at === null || !activeMention(ta.value, at)) setClosedAt(null);
    if (!ta.value.startsWith('/')) setSlashClosed(false);
  };
  const pick = (item: Item) => {
    if (!mention) return;
    const next = insertMention(input, mention, item.title);
    setInput(next.text);
    setHighlight(0);
    // Picked: this @ is done, even though its words still match the item.
    setClosedAt(mention.start);
    setCaret(next.caret);
    // The value lands on the next render; the caret goes after it.
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.caret, next.caret);
    });
  };

  // An agent's open question on this item takes the box (lib/agent-question.ts).
  const answeringAgent = useBoxAnswersAgent(binding.kind === 'item' ? binding.itemId : null);
  const displayName = answeringAgent ?? chatAssistantName(target);
  // A box bound to an item says so: it looks like every other box.
  const placeholder =
    placeholderOverride ??
    (answeringAgent
      ? `Answer ${answeringAgent}…`
      : binding.kind === 'item'
        ? itemChatPlaceholder(target)
        : chatPlaceholder(target));
  const hasText = input.trim().length > 0;

  // Auto-grow, measured while the field can be: a field with no box (hidden,
  // or an ancestor display:none) reads scrollHeight 0, and writing that down
  // would leave a 0px field behind once it shows. So a hidden field keeps no
  // inline height (rows=1 governs), and showing it measures again.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !awake) return;
    ta.style.height = 'auto';
    if (ta.scrollHeight === 0) {
      ta.style.height = '';
      return;
    }
    ta.style.height = Math.min(ta.scrollHeight, MAX_HEIGHT_PX) + 'px';
  }, [input, awake]);

  // Pictures (lib/chat-images.ts): the panel's attach button or a paste, only
  // while the connected model answers, and sent with the next message only.
  // Held here, not in rail-store: a half-typed message outlives its view, a
  // picture does not.
  //
  // An ITEM's box (the rail's panel; the inline box and the phone's dock keep
  // the pictures-only rule) attaches any file to the item instead: kept on the
  // item when you send (lib/item-files-store.ts `add`, the session client's
  // row, bytes, ready), never on attach, so removing a chip is the undo. A
  // picture also goes to the model with that one message, shrunk, as before.
  const filesAvailable = useItemFilesStore((s) => s.available);
  const listed = useItemFilesStore((s) => (itemId ? (s.byItem[itemId]?.files.length ?? 0) : 0));
  const uploading = useItemFilesStore((s) => (itemId ? (s.uploading[itemId] ?? 0) : 0));
  const toItem = variant === 'panel' && !!itemId && filesAvailable !== false;
  const canAttach = variant === 'panel' && (target === 'model' || toItem);
  const [pictures, setPictures] = useState<{ id: string; image: ChatImage }[]>([]);
  const [attached, setAttached] = useState<ItemAttachment[]>([]);
  // The chips' object URLs go with the box.
  const attachedRef = useRef(attached);
  useEffect(() => {
    attachedRef.current = attached;
  }, [attached]);
  useEffect(() => () => revoke(attachedRef.current), []);
  const room = ITEM_FILE_LIMITS.perItem - listed - uploading - attached.length;
  const fileRef = useRef<HTMLInputElement>(null);
  const attachToItem = async (files: readonly File[]) => {
    const fit: File[] = [];
    for (const f of files) {
      if (f.size <= 0) toast.error(REFUSAL_COPY.empty(f.name));
      else if (f.size > ITEM_FILE_LIMITS.bytes) toast.error(REFUSAL_COPY.too_big(f.name));
      else fit.push(f);
    }
    if (fit.length > room) toast.error(REFUSAL_COPY.item_full(''));
    const taking = fit.slice(0, Math.max(0, room));
    if (taking.length === 0) return;
    let carrying = attached.filter((a) => a.image).length;
    const added = await Promise.all(
      taking.map(async (file): Promise<ItemAttachment> => {
        let image: ChatImage | undefined;
        if (target === 'model' && isPicture(file) && carrying < MAX_CHAT_IMAGES) {
          carrying++;
          // A picture the model cannot read (HEIC, say) is still kept on the item, quietly.
          const read = await readChatImage(file);
          if (read.ok) image = read.image;
        }
        const preview =
          !image && isThumbable(file.type) && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : undefined;
        return { id: crypto.randomUUID(), file, ...(image ? { image } : {}), ...(preview ? { preview } : {}) };
      })
    );
    setAttached((cur) => [...cur, ...added]);
  };
  const attach = async (files: readonly File[]) => {
    if (!canAttach || files.length === 0) return;
    if (toItem) return attachToItem(files);
    const room = MAX_CHAT_IMAGES - pictures.length;
    if (files.length > room) toast.error(ATTACH_COPY.tooMany(MAX_CHAT_IMAGES));
    const read = await Promise.all(files.slice(0, Math.max(0, room)).map(readChatImage));
    const added = read.flatMap((r) => (r.ok ? [{ id: crypto.randomUUID(), image: r.image }] : []));
    const failed = read.find((r) => !r.ok);
    if (failed && !failed.ok) toast.error(failed.reason);
    if (added.length) setPictures((cur) => [...cur, ...added].slice(0, MAX_CHAT_IMAGES));
  };
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const files = Array.from(e.clipboardData.files).filter((f) => toItem || f.type.startsWith('image/'));
    if (files.length === 0) return;
    // A picture alone is taken here; words pasted with it still land in the box.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    void attach(files);
  };
  const removeAttached = (a: ItemAttachment) => {
    revoke([a]);
    setAttached((cur) => cur.filter((x) => x.id !== a.id));
    textareaRef.current?.focus();
  };

  // Dropping files on the box: counted in and out, since every child the drag
  // crosses fires its own enter and leave. Only a drag that carries files.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dropProps = canAttach
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (e: React.DragEvent) => {
          if (hasFiles(e)) e.preventDefault();
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void attach(Array.from(e.dataTransfer.files));
        },
      }
    : {};

  const canSend = hasText || (toItem && attached.length > 0);
  const handleSend = () => {
    const text = input.trim();
    if (isLoading) return;
    if (toItem && itemId) {
      if (!text && attached.length === 0) return;
      // Taken before the message is stamped, so the files' cards sit just above it.
      const placedAt = Date.now();
      const images =
        target === 'model' ? attached.flatMap((a) => (a.image ? [a.image] : [])).slice(0, MAX_CHAT_IMAGES) : [];
      if (attached.length)
        void useItemFilesStore.getState().add(
          itemId,
          attached.map((a) => a.file),
          { placedAt }
        );
      revoke(attached);
      setAttached([]);
      // The Send button goes with the files; keep focus in the box, not on <body>.
      textareaRef.current?.focus();
      if (!text) return;
      setInput('');
      void sendFrom(binding, text, { surface, ...(images.length ? { images } : {}) });
      return;
    }
    if (!text) return;
    setInput('');
    const images = canAttach ? pictures.map((p) => p.image) : [];
    setPictures([]);
    void sendFrom(binding, text, { surface, ...(images.length ? { images } : {}) });
  };

  const refocus = useRef(false);
  /** Stops this conversation's reply only: another conversation's stream is its own. */
  const stop = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Stop's slot turns into Send or the disabled Mic once the reply ends, and
    // a focused button that goes disabled drops focus to <body>, where the next
    // Tab starts over at the top of the page. A keyboard Stop hands focus to
    // the box: at once where the box is only read-only, and once the reply has
    // ended where it is disabled (the dock).
    if (e.currentTarget === document.activeElement) {
      refocus.current = true;
      textareaRef.current?.focus();
    }
    if (threadId) useConversationsStore.getState().stop(threadId);
  };
  useEffect(() => {
    if (isLoading || !refocus.current) return;
    refocus.current = false;
    // Only focus that went nowhere: if the reader has moved on, leave them.
    const at = document.activeElement;
    if (!at || at === document.body) textareaRef.current?.focus();
  }, [isLoading]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSlashClosed(true);
        return;
      }
      const taken = (e.key !== 'Enter' || !e.shiftKey) && slashRef.current?.key(e.key);
      if (taken) {
        e.preventDefault();
        return;
      }
    }
    if (listOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlight((active + step + choices.length) % choices.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(choices[active]);
        return;
      }
      if (e.key === 'Escape') {
        // The list's own Escape: the rail (or the phone's sheet) must not close too.
        e.preventDefault();
        e.stopPropagation();
        setClosedAt(mention?.start ?? null);
        return;
      }
    }
    // isComposing: Enter is how an IME COMMITS a candidate, so without this a
    // Japanese/Chinese/Korean user confirming 「こんにちは」 sends the half-built
    // string instead and loses the rest. This bar is the only field the phone's
    // chat tab has, so there is no other way to compose a message there.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // A textbox that suggests, as GitHub's comment box does: it stays a textbox
  // (role combobox on a multi-line field is not one a reader expects), and
  // the list it controls and the option in hand are named while it is open.
  const comboProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': listOpen || (slashOpen && slashActive) ? listId : undefined,
    'aria-activedescendant': listOpen ? `${listId}-${active}` : slashOpen ? slashActive : undefined,
  };
  const list = listOpen ? (
    <MentionList id={listId} choices={choices} active={active} onPick={pick} onHover={setHighlight} />
  ) : slashOpen && slash ? (
    <SlashCommands
      ref={slashRef}
      id={listId}
      query={slash.query}
      highlight={highlight}
      onHighlight={setHighlight}
      onActive={setSlashActive}
      onRan={() => {
        setInput('');
        setHighlight(0);
        setCaret(null);
      }}
    />
  ) : null;

  if (variant === 'dock') {
    return (
      <div
        // The pill LOOKS like the field, so all of it behaves like one — the
        // 22px side padding and the slack above and below a 22px text line
        // would otherwise be dead. Same treatment, and the same reason, as the
        // omnibar this bar stands in for on the other two tabs.
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          textareaRef.current?.focus();
        }}
        className={cn(
          'relative flex min-h-[48px] w-full items-end gap-2 rounded-[10px] bg-surface-2 py-[13px]',
          'shadow-[var(--shadow-key-rest)] transition-[padding] duration-150',
          hasText ? 'pl-[22px] pr-2' : 'px-[22px]'
        )}
      >
        {list}
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setHighlight(0);
            readCaret(e.target);
          }}
          onSelect={(e) => readCaret(e.currentTarget)}
          onBlur={() => setCaret(null)}
          onKeyDown={onKeyDown}
          {...comboProps}
          placeholder={placeholder}
          rows={1}
          data-testid="chat-dock-input"
          aria-label={`Message ${displayName}`}
          // 13px + 22px + 13px is the pill's 48px exactly, so a one-line field
          // sits centred without the row having to guess at a height.
          //
          // dark:bg-transparent is load-bearing (same reason as
          // components/planner/item-dialog.tsx:2226): Textarea's base carries
          // dark:bg-input/30, which compiles to `&:is(.dark *)` and outranks a
          // plain bg-transparent on specificity — leaving a lighter rounded-md
          // rectangle floating inside the pill in dark mode.
          className="max-h-[120px] min-h-[22px] -mx-1 flex-1 resize-none border-0 bg-transparent px-1 py-0 text-sm leading-[22px] shadow-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
          disabled={isLoading}
        />
        {isLoading ? (
          /* A reply that has started going wrong is worth interrupting, and the
             store can (it aborts the reply's stream) — there was simply no way to
             ask. Send is disabled mid-stream anyway, so this occupies a slot
             that was dead, and on the phone this bar is the only control the
             chat tab has. */
          <Button
            size="icon"
            className="-my-[5px] size-8 shrink-0 rounded-full"
            onClick={stop}
            aria-label="Stop generating"
            data-testid="chat-stop"
          >
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          hasText && (
            <Button
              size="icon"
              // -my-[5px] lets the 32px button overhang the 22px text line rather
              // than set the pill's floor — without it the bar is 58px tall the
              // moment you type, and 10px taller than the omnibar it replaces.
              className="-my-[5px] size-8 shrink-0 rounded-full"
              onClick={handleSend}
              disabled={isLoading}
              aria-label="Send"
            >
              <ArrowUp className="size-4" />
            </Button>
          )
        )}
      </div>
    );
  }

  const pictureCount = attached.filter((a) => isPicture(a.file)).length;
  const attachmentsNote =
    target === 'openclaw'
      ? 'Kept on this item when you send. OpenClaw doesn’t get files.'
      : pictureCount > MAX_CHAT_IMAGES
        ? `Kept on this item when you send. The AI sees the first ${MAX_CHAT_IMAGES} pictures.`
        : 'Kept on this item when you send.';

  return (
    <div
      className="relative rounded-2xl border border-border bg-muted/30 transition-colors focus-within:bg-muted/50"
      data-testid="chat-composer-panel"
      {...dropProps}
    >
      {list}
      {dragging && (
        <div
          data-testid="chat-drop-zone"
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-border bg-background/85 text-xs text-muted-foreground"
        >
          {toItem ? 'Drop to add to this item' : 'Drop pictures to send with your message'}
        </div>
      )}
      {toItem && attached.length > 0 && (
        <div className="flex flex-col gap-1.5 px-3 pt-3">
          <ul className="flex flex-wrap gap-2" aria-label="Files to add to this item" data-testid="chat-attachments">
            {attached.map((a) => {
              const src = a.image ? imageDataUrl(a.image) : a.preview;
              const badge = fileBadge(a.file.name, a.file.type);
              return (
                <li key={a.id} className="relative" data-testid="chat-attachment">
                  {src ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- a data: or blob: URL in memory, nothing to optimise */
                    <img src={src} alt={a.file.name} className="size-14 rounded-lg border border-border object-cover" />
                  ) : (
                    <span className="flex h-14 max-w-[12rem] items-center gap-2 rounded-lg border border-border bg-background px-2">
                      <span
                        className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted font-mono text-[8.5px] uppercase text-muted-foreground"
                        aria-hidden
                      >
                        {badge}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs text-foreground">{a.file.name}</span>
                        <span className="text-2xs text-muted-foreground">{sizeLabel(a.file.size)}</span>
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${a.file.name}`}
                    data-testid="chat-attachment-remove"
                    onClick={() => removeAttached(a)}
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-2xs text-muted-foreground" data-testid="chat-attachments-note">
            {attachmentsNote}
          </p>
        </div>
      )}
      {!toItem && canAttach && pictures.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached pictures" data-testid="chat-attachments">
          {pictures.map((p, i) => (
            <li key={p.id} className="relative" data-testid="chat-attachment">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL in memory, nothing to optimise */}
              <img
                src={imageDataUrl(p.image)}
                alt={`Picture ${i + 1}`}
                className="size-14 rounded-lg border border-border object-cover"
              />
              <button
                type="button"
                aria-label={`Remove picture ${i + 1}`}
                data-testid="chat-attachment-remove"
                onClick={() => {
                  setPictures((cur) => cur.filter((x) => x.id !== p.id));
                  textareaRef.current?.focus();
                }}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setHighlight(0);
          readCaret(e.target);
        }}
        onSelect={(e) => readCaret(e.currentTarget)}
        onBlur={() => setCaret(null)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        {...comboProps}
        placeholder={placeholder}
        rows={1}
        // dark:bg-transparent for the same reason as the dock's field above —
        // the tray is the surface here, so the base's dark:bg-input/30 shows as
        // a second, lighter box inside it.
        aria-label={`Message ${displayName}`}
        className="min-h-0 resize-none border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
        // Read-only mid-reply, not disabled: disabling a focused field drops
        // focus to <body>, where the next keystroke fires a bare-key shortcut,
        // and a disabled field cannot take the focus a send hands to the
        // conversation it pushed. handleSend already refuses while busy. (The
        // phone's dock bar stays disabled on purpose: a reply on its way puts
        // the keyboard away so the reply can be read, and a phone has no
        // bare-key shortcuts for a lost focus to fire.)
        readOnly={busy}
        aria-busy={busy || undefined}
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-full text-muted-foreground"
            disabled={
              toItem ? busy || room <= 0 : !canAttach || isLoading || pictures.length >= MAX_CHAT_IMAGES
            }
            onClick={() => fileRef.current?.click()}
            aria-label={toItem ? 'Attach files' : 'Attach pictures'}
            title={
              toItem
                ? 'Attach files to this item'
                : canAttach
                  ? 'Attach pictures'
                  : 'Pictures go to a connected model only'
            }
            data-testid="chat-attach"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={toItem ? undefined : 'image/jpeg,image/png,image/webp,image/gif'}
            multiple
            hidden
            data-testid="chat-attach-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void attach(files);
            }}
          />
          {target === 'model' && <ChatModelChip disabled={isLoading} />}
        </div>
        {isLoading ? (
          <Button
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={stop}
            aria-label="Stop generating"
            data-testid="chat-stop"
          >
            <Square className="h-3 w-3 fill-current" />
          </Button>
        ) : canSend ? (
          <Button
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={handleSend}
            disabled={isLoading}
            aria-label="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-muted-foreground"
            disabled
            title="Voice input (coming soon)"
          >
            <Mic className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Which model answers, at the foot of the box while the connected model is the
 * one answering (never for OpenClaw, which picks its own). The same chip and
 * setting as Settings → AI's: a pick here is the account's model, from the
 * next message on. Held still while a reply is arriving.
 */
function ChatModelChip({ disabled }: { disabled: boolean }) {
  const model = useAIConnectionStore((s) => s.model);
  if (!model?.model) return null;
  const name = labelName(model.provider, model.baseUrl);
  return (
    <ModelPicker
      variant="chat"
      disabled={disabled}
      errorCopy={(code, field) => connectErrorCopy(code, name, { during: 'model', field })}
    />
  );
}

/**
 * The items an @ can pick, above the box. Pointer picks keep the focus in the
 * box (mousedown is cancelled), so typing carries on where it was.
 */
function MentionList({
  id,
  choices,
  active,
  onPick,
  onHover,
}: {
  id: string;
  choices: Item[];
  active: number;
  onPick: (item: Item) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Items"
      data-testid="chat-mention-list"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-soft-md"
    >
      {choices.map((item, i) => {
        const step = 'parentItemId' in item && !!item.parentItemId;
        const project = 'project' in item ? item.project : undefined;
        return (
          <li
            key={item.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            data-testid="chat-mention-option"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(item)}
            onMouseEnter={() => onHover(i)}
            className={cn(
              'flex cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-sm text-foreground',
              i === active && 'bg-accent'
            )}
          >
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {(step || project) && (
              <span className="shrink-0 text-2xs text-muted-foreground">{step ? 'step' : project}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
