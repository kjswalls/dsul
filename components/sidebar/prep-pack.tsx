'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import {
  packAction,
  packHref,
  packKindName,
  packLabel,
  packText,
  type Pack,
  type PrepPack,
} from '@/lib/prep-packs';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { doneNext } from '@/lib/do-stuff';
import { cn } from '@/lib/utils';

/**
 * A prep pack in the braindump (lib/prep-packs.ts): the chip on a "done for
 * you" row that says what is ready, and the card it opens. On desktop the card
 * peeks out beside the row (memory/plans/power-mode.md: roomy, editable,
 * ↑ ↓ between packs, the primary action on Enter); on the phone it opens in
 * place under the row, full width.
 *
 * Edits stay in the card: they shape what Copy and Open take with them, and
 * are never written back (the pack is the AI's draft, the sent thing is the
 * user's). Nothing leaves the app without the user's own tap.
 */

/** The row's trailing chip: what is ready. Opens (or closes) the card. */
export function PackChip({
  stored,
  open,
  onToggle,
}: {
  stored: PrepPack;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onKeyDown={(e) => e.stopPropagation()}
      aria-expanded={open}
      aria-label={`${packKindName(stored.pack)} ready. ${open ? 'Close' : 'Open'} it`}
      data-testid="prep-pack-chip"
      className={cn(
        '-my-1.5 flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-[11.5px] font-medium whitespace-nowrap hover:bg-accent',
        open ? 'border-foreground/30 bg-accent text-foreground' : 'border-border text-foreground'
      )}
    >
      <span className="text-muted-foreground"><AskMark tone="ink" className="size-3" /></span>
      {packLabel(stored.pack)}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

/** The pack's fields, editable in place. */
function PackFields({ pack, onChange }: { pack: Pack; onChange: (next: Pack) => void }) {
  switch (pack.kind) {
    case 'email':
      return (
        <>
          <Field label="To">
            <Input value={pack.to ?? ''} placeholder="who it goes to" onChange={(e) => onChange({ ...pack, to: e.target.value })} />
          </Field>
          <Field label="Subject">
            <Input value={pack.subject} onChange={(e) => onChange({ ...pack, subject: e.target.value })} />
          </Field>
          <Field label="Message">
            <Textarea value={pack.body} rows={7} onChange={(e) => onChange({ ...pack, body: e.target.value })} />
          </Field>
        </>
      );
    case 'message':
      return (
        <>
          {pack.to !== undefined && (
            <Field label="To">
              <Input value={pack.to} onChange={(e) => onChange({ ...pack, to: e.target.value })} />
            </Field>
          )}
          <Field label="Message">
            <Textarea value={pack.body} rows={4} onChange={(e) => onChange({ ...pack, body: e.target.value })} />
          </Field>
        </>
      );
    case 'call':
      return (
        <>
          <Field label="Who">
            <Input value={pack.who} onChange={(e) => onChange({ ...pack, who: e.target.value })} />
          </Field>
          <Field label="Number">
            <Input
              value={pack.number ?? ''}
              inputMode="tel"
              placeholder="add the number"
              onChange={(e) => onChange({ ...pack, number: e.target.value })}
            />
          </Field>
          <Field label="What to say">
            <Textarea
              value={pack.script.map((s) => `- ${s}`).join('\n')}
              rows={5}
              onChange={(e) => onChange({ ...pack, script: lines(e.target.value) })}
            />
          </Field>
        </>
      );
    case 'steps':
      return (
        <Field label="Steps">
          <Textarea
            value={pack.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
            rows={5}
            onChange={(e) => onChange({ ...pack, steps: lines(e.target.value) })}
          />
        </Field>
      );
  }
}

interface CardProps {
  itemId: string;
  title: string;
  stored: PrepPack;
  /** "2 of 3" and the ↑ ↓ between packs; absent with only one. */
  nav?: { index: number; count: number; go: (dir: -1 | 1) => void };
  onClose: () => void;
  /**
   * The phone's deck: a swipe right takes the pack out (its primary action),
   * a swipe left leaves it for later (the next one). Never from inside a field.
   */
  swipe?: boolean;
  /** After Done or Not needed; the deck stays open to deal the next. Defaults to onClose. */
  onSettled?: () => void;
}

/** The pack itself: a header, the fields, and the one tap that takes it out. */
/** How far a finger travels sideways before the deck acts on a swipe. */
const SWIPE_PX = 80;

export function PackCard({ itemId, title, stored, nav, onClose, swipe, onSettled = onClose }: CardProps) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  // Keyed by the caller on the pack (packKey), so ↑ ↓ or a fresh pack landing
  // starts again from what the AI wrote.
  const [pack, setPack] = useState<Pack>(stored.pack);
  const href = packHref(pack);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(packText(pack));
      toast('Copied');
    } catch {
      toast("Couldn't copy that.");
    }
  };
  const primary = () => {
    if (href) window.location.href = href;
    else void copy();
  };

  const endSwipe = () => {
    start.current = null;
    setDx(0);
  };
  const swipeHandlers = swipe
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          const t = e.target as HTMLElement;
          if (e.pointerType !== 'touch' || t.closest('input, textarea, button, a')) return;
          start.current = { x: e.clientX, y: e.clientY };
        },
        onPointerMove: (e: React.PointerEvent) => {
          const st = start.current;
          if (!st) return;
          const x = e.clientX - st.x;
          if (Math.abs(e.clientY - st.y) > 32 && Math.abs(e.clientY - st.y) > Math.abs(x)) return endSwipe();
          setDx(Math.max(-140, Math.min(140, x)));
        },
        onPointerUp: () => {
          if (dx >= SWIPE_PX) primary();
          else if (dx <= -SWIPE_PX) nav?.go(1);
          endSwipe();
        },
        onPointerCancel: endSwipe,
      }
    : {};

  return (
    <div
      data-testid="prep-pack-card"
      {...swipeHandlers}
      style={dx ? { transform: `translateX(${dx}px) rotate(${dx / 40}deg)` } : undefined}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Enter' && !typing) {
          e.preventDefault();
          primary();
        } else if (nav && !typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          nav.go(e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
      className={cn('flex max-h-[min(560px,80vh)] flex-col', swipe && 'touch-pan-y')}
    >
      <div className="flex items-start gap-2 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-snug font-semibold">{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AskMark tone="ink" className="size-3" />
            {packKindName(pack)} · written by your AI
          </div>
        </div>
        {nav && (
          <div className="flex items-center" aria-label="Other things ready">
            <button
              type="button"
              aria-label="Previous"
              aria-keyshortcuts="ArrowUp"
              onClick={() => nav.go(-1)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <ChevronUp className="size-4" />
            </button>
            <span className="font-num px-1 text-xs text-muted-foreground">
              {nav.index + 1} of {nav.count}
            </span>
            <button
              type="button"
              aria-label="Next"
              aria-keyshortcuts="ArrowDown"
              onClick={() => nav.go(1)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-3">
        <PackFields pack={pack} onChange={setPack} />
      </div>
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2.5">
        {href ? (
          <Button size="sm" asChild data-testid="prep-pack-primary">
            <a href={href}>{packAction(pack)}</a>
          </Button>
        ) : (
          <Button size="sm" onClick={() => void copy()} data-testid="prep-pack-primary">
            {packAction(pack)}
          </Button>
        )}
        {href && (
          <Button size="sm" variant="ghost" onClick={() => void copy()} className="text-muted-foreground">
            Copy
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onSettled();
            void usePrepPacksStore.getState().dismiss(itemId);
          }}
          data-testid="prep-pack-dismiss"
          className="text-muted-foreground"
        >
          Not needed
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onSettled();
            doneNext(itemId);
          }}
          data-testid="prep-pack-done"
        >
          Done
        </Button>
      </div>
    </div>
  );
}

const packKey = (card: CardProps) => `${card.itemId}:${card.stored.updatedAt}`;

/**
 * The card beside its row on desktop. Anchored to the row (the wrapper the
 * caller passes as children), so it peeks out to the braindump's right.
 */
export function PackPeek({
  open,
  children,
  ...card
}: CardProps & { open: boolean; children: React.ReactNode }) {
  return (
    <Popover open={open} onOpenChange={(o) => !o && card.onClose()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[440px] max-w-[calc(100vw-24px)] rounded-[16px] border-border p-0 shadow-[var(--shadow-elev-lg)]"
      >
        <PackCard key={packKey(card)} {...card} />
      </PopoverContent>
    </Popover>
  );
}

/** The card in place under its row, on the phone. */
export function PackInline(card: CardProps) {
  return (
    <div className="my-1 rounded-[12px] border border-border bg-surface-2 shadow-[var(--shadow-elev-sm)]">
      <PackCard key={packKey(card)} {...card} />
    </div>
  );
}

/**
 * The phone's review deck: every pack ready, dealt one at a time in a sheet.
 * Swipe right or tap to take one out, swipe left (or "Later") for the next.
 * "Done" and "Not needed" deal the next one in its place.
 */
export function PackDeck({
  open,
  onOpenChange,
  cards,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: readonly Omit<CardProps, 'nav' | 'onClose' | 'swipe' | 'onSettled'>[];
}) {
  const [index, setIndex] = useState(0);
  const count = cards.length;
  const at = count > 0 ? Math.min(index, count - 1) : 0;
  const card = cards[at];
  return (
    <Drawer open={open && count > 0} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="prep-pack-deck">
        <DrawerTitle className="sr-only">Things ready</DrawerTitle>
        {card && (
          <div className="px-3 pb-4">
            <PackCard
              key={`${card.itemId}:${card.stored.updatedAt}`}
              {...card}
              swipe
              nav={count > 1 ? { index: at, count, go: (dir) => setIndex((at + dir + count) % count) } : undefined}
              onClose={() => onOpenChange(false)}
              onSettled={() => {
                if (count <= 1) onOpenChange(false);
              }}
            />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
