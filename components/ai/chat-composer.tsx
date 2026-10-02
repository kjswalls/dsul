'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Plus, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { resolveConversationId, useConversationsStore, type ConversationsState } from '@/lib/conversations-store';
import { bindingKey, sendFrom, type ComposerBinding } from '@/lib/open-chat';
import type { AskSurface } from '@/lib/rail-store';
import { chatAssistantName, chatPlaceholder, itemChatPlaceholder } from '@/lib/chat-utils';
import { cn } from '@/lib/utils';

/** Auto-grow ceiling, past which the field scrolls instead of pushing further. */
const MAX_HEIGHT_PX = 120;

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
  /** Grows the panel variant's icon buttons to touch size. 'dock' is already 48px. */
  touch?: boolean;
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
      return Object.values(s.threads).find((t) => t.itemId === binding.itemId && !t.saved && t.load !== 'gone')?.id ?? null;
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
  touch,
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

  const [ownInput, setOwnInput] = useState('');
  const input = value ?? ownInput;
  const setInput = (text: string) => {
    if (value === undefined) setOwnInput(text);
    else onValueChange?.(text);
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const displayName = chatAssistantName(target);
  // A box bound to an item says so: it looks like every other box.
  const placeholder =
    placeholderOverride ?? (binding.kind === 'item' ? itemChatPlaceholder(target) : chatPlaceholder(target));
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

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    void sendFrom(binding, text, { surface });
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
    // isComposing: Enter is how an IME COMMITS a candidate, so without this a
    // Japanese/Chinese/Korean user confirming 「こんにちは」 sends the half-built
    // string instead and loses the rest. This bar is the only field the phone's
    // chat tab has, so there is no other way to compose a message there.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

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
          'flex min-h-[48px] w-full items-end gap-2 rounded-[10px] bg-surface-2 py-[13px]',
          'shadow-[var(--shadow-key-rest)] transition-[padding] duration-150',
          hasText ? 'pl-[22px] pr-2' : 'px-[22px]'
        )}
      >
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
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

  return (
    <div className="rounded-2xl border border-border bg-muted/30 transition-colors focus-within:bg-muted/50">
      <Textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
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
        readOnly={isLoading}
        aria-busy={isLoading || undefined}
      />
      <div className="flex items-center justify-between px-2 pb-2">
        <Button
          variant="ghost"
          size="icon"
          className={cn('rounded-full text-muted-foreground', touch ? 'h-9 w-9' : 'h-8 w-8')}
          disabled
          title="Attach files (coming soon)"
        >
          <Plus className={cn(touch ? 'h-5 w-5' : 'h-4 w-4')} />
        </Button>
        {isLoading ? (
          <Button
            size="icon"
            className={cn('rounded-full', touch ? 'h-9 w-9' : 'h-8 w-8')}
            onClick={stop}
            aria-label="Stop generating"
            data-testid="chat-stop"
          >
            <Square className={cn('fill-current', touch ? 'h-3.5 w-3.5' : 'h-3 w-3')} />
          </Button>
        ) : hasText ? (
          <Button
            size="icon"
            className={cn('rounded-full', touch ? 'h-9 w-9' : 'h-8 w-8')}
            onClick={handleSend}
            disabled={isLoading}
            aria-label="Send"
          >
            <ArrowUp className={cn(touch ? 'h-5 w-5' : 'h-4 w-4')} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className={cn('rounded-full text-muted-foreground', touch ? 'h-9 w-9' : 'h-8 w-8')}
            disabled
            title="Voice input (coming soon)"
          >
            <Mic className={cn(touch ? 'h-5 w-5' : 'h-4 w-4')} />
          </Button>
        )}
      </div>
    </div>
  );
}
