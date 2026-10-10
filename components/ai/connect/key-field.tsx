'use client';

import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react';
import { Loader2 } from 'lucide-react';
import { getDesktopBridge } from '@/lib/desktop';
import { cn } from '@/lib/utils';

/** Attributes every key field carries: never autofilled, never remembered, never spellchecked. */
export const KEY_FIELD_PROPS = {
  type: 'password',
  name: 'model-api-key',
  autoComplete: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
} as const;

/** What a form may do with the field. It reads the key once, at send time, and holds nothing. */
export interface KeyFieldHandle {
  /** The key in the box, trimmed ('' when empty). */
  read(): string;
  /** Empties the box (Clear, a provider change, a key that worked). */
  clear(): void;
  focus(): void;
}

const noopSubscribe = () => () => {};
/**
 * [Paste] reads the clipboard, which a browser may refuse; the desktop app
 * always does (it grants the page a clipboard write, never a read). Where it
 * cannot work it is not offered: Ctrl+V into the box works everywhere.
 */
const clipboardReadable = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.clipboard?.readText === 'function' &&
  getDesktopBridge() === null;

/**
 * The box a model key is pasted into, everywhere one is: the setup column's
 * card and folds, the fix home, and Settings → AI.
 *
 * Uncontrolled, on purpose: React writes a controlled input's value into its
 * `value` attribute too, where `innerHTML` and any extension can read it. Here
 * the key lives only in the input's value property, and the form reads it
 * when it sends (`read()`); state holds whether there is one, never what it
 * is. The value is emptied before the node leaves the page, and by the form
 * right after a key works, so a browser never sees a filled password field go
 * and offers to save it.
 *
 * Never `disabled`: while its key is being checked it is `readOnly` and
 * `aria-busy`, so focus stays in it (and with it the setup column's Escape
 * exception for a field with text). Enter sends, without a form to submit.
 * The control on its right is [Paste] while empty (where the clipboard can be
 * read), Show/Hide once a key is in, and a spinner while it is checked. Every
 * action that takes the place of the control puts focus back in the box.
 */
export function KeyField({
  ref,
  id,
  placeholder = 'Paste your key',
  checking = false,
  describedBy,
  testId,
  className,
  onChange,
  onPaste,
  onEnter,
}: {
  ref?: Ref<KeyFieldHandle>;
  id: string;
  placeholder?: string;
  /** Its key is out being checked. */
  checking?: boolean;
  describedBy?: string;
  testId?: string;
  className?: string;
  /** Typed into. Gets the trimmed key to read a prefix from: never keep it. */
  onChange?: (key: string) => void;
  /** A paste landed (Ctrl+V or [Paste]); the box holds it, trimmed. Never keep it. */
  onPaste?: (key: string) => void;
  onEnter?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [hasKey, setHasKey] = useState(false);
  const [shown, setShown] = useState(false);
  const [pasteRefused, setPasteRefused] = useState(false);
  const canPaste = useSyncExternalStore(noopSubscribe, clipboardReadable, () => false);

  useImperativeHandle(
    ref,
    () => ({
      read: () => input.current?.value.trim() ?? '',
      clear: () => {
        if (input.current) input.current.value = '';
        setHasKey(false);
        setShown(false);
        setPasteRefused(false);
        onChange?.('');
      },
      focus: () => input.current?.focus(),
    }),
    [onChange]
  );

  // Emptied before the node goes: a layout cleanup runs while it is still in
  // the page, so nothing ever sees a filled password field leave.
  useLayoutEffect(() => {
    const node = input.current;
    return () => {
      if (node) node.value = '';
    };
  }, []);

  /** A whole paste replaces the box: it holds one key. */
  const place = (text: string) => {
    const node = input.current;
    const key = text.trim();
    if (!node || key === '') return;
    node.value = key;
    setHasKey(true);
    setPasteRefused(false);
    onPaste?.(key);
  };

  const pasteFromClipboard = async () => {
    try {
      place(await navigator.clipboard.readText());
    } catch {
      // Refused (a permission prompt said no, or the paste menu was dismissed).
      setPasteRefused(true);
    }
    input.current?.focus();
  };

  const control = checking ? (
    <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground" aria-hidden>
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
    </span>
  ) : hasKey ? (
    <button
      type="button"
      // Named for what it does next, so never also aria-pressed: "Hide key,
      // pressed" would read as the key being hidden.
      aria-label={shown ? 'Hide key' : 'Show key'}
      aria-controls={id}
      onClick={() => setShown((v) => !v)}
      className="mr-1 shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {shown ? 'Hide' : 'Show'}
    </button>
  ) : canPaste ? (
    <button
      type="button"
      onClick={() => void pasteFromClipboard()}
      data-testid={testId ? `${testId}-paste` : undefined}
      className="mr-1 shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      Paste
    </button>
  ) : null;

  const described = [describedBy, pasteRefused ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="field flex h-9 w-full min-w-0 items-center border bg-transparent dark:bg-input/30">
        <input
          ref={input}
          id={id}
          {...KEY_FIELD_PROPS}
          type={shown ? 'text' : 'password'}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={placeholder}
          readOnly={checking}
          aria-busy={checking || undefined}
          aria-describedby={described}
          data-testid={testId}
          onChange={(e) => {
            const key = e.currentTarget.value.trim();
            setHasKey(key !== '');
            if (key === '') setShown(false);
            setPasteRefused(false);
            onChange?.(key);
          }}
          onPaste={(e) => {
            e.preventDefault();
            if (checking) return;
            place(e.clipboardData.getData('text/plain'));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!checking) onEnter?.();
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {control}
      </div>
      {pasteRefused && (
        <p id={hintId} className="text-xs text-muted-foreground">
          Paste into the box instead.
        </p>
      )}
    </div>
  );
}
