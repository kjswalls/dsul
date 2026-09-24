'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Plus, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useChatStore } from '@/lib/chat-store';
import { chatAssistantName } from '@/lib/chat-utils';
import { cn } from '@/lib/utils';

/** Auto-grow ceiling, past which the field scrolls instead of pushing further. */
const MAX_HEIGHT_PX = 120;

interface ChatComposerProps {
  /**
   * 'panel' is the tray at the foot of a conversation — a rounded field over an
   * attach/voice rail. 'dock' is the phone's bottom bar wearing the omnibar's
   * pill: on the Beacon tab the dock's one row IS the composer, so the phone
   * keeps a single address for typing whichever surface you are on.
   */
  variant: 'panel' | 'dock';
  /** Grows the panel variant's icon buttons to touch size. 'dock' is already 48px. */
  touch?: boolean;
  /** Increment to focus the field (a tab activating, a panel expanding). */
  focusSignal?: number;
}

/**
 * The Beacon/OpenClaw input, in the two shapes the app mounts it in.
 *
 * One component rather than two because the behaviour — Enter sends, Shift+Enter
 * newlines, auto-grow to a ceiling, disabled mid-stream, cleared and refocused
 * on send — is the contract, and the mobile redesign moved the phone's copy of
 * it from the foot of the conversation into the dock. Two implementations would
 * have drifted on the first of those rules that got fixed in one place.
 */
export function ChatComposer({ variant, touch, focusSignal }: ChatComposerProps) {
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const isLoading = useChatStore((s) => s.isLoading);
  const provider = useAISettingsStore((s) => s.provider);

  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const displayName = chatAssistantName(provider);
  const hasText = input.trim().length > 0;

  useEffect(() => {
    if (focusSignal !== undefined && focusSignal > 0) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [focusSignal]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, MAX_HEIGHT_PX) + 'px';
  }, [input]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing: Enter is how an IME COMMITS a candidate, so without this a
    // Japanese/Chinese/Korean user confirming 「こんにちは」 sends the half-built
    // string instead and loses the rest. This bar is the only field the phone's
    // Beacon tab has, so there is no other way to compose a message there.
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
          placeholder={`Message ${displayName}…`}
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
             store can (`abortController.abort()`) — there was simply no way to
             ask. Send is disabled mid-stream anyway, so this occupies a slot
             that was dead, and on the phone this bar is the only control the
             Beacon tab has. */
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
        placeholder={`Message ${displayName}...`}
        rows={1}
        // dark:bg-transparent for the same reason as the dock's field above —
        // the tray is the surface here, so the base's dark:bg-input/30 shows as
        // a second, lighter box inside it.
        className="min-h-0 resize-none border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
        disabled={isLoading}
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
