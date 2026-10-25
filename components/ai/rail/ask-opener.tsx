'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { AskMark, ASK_MARK_LIGHT } from '@/components/ai/ask-mark';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { INBOX_SURFACE, NeedsYouInbox, useNeedsYouCount } from '@/components/ai/needs-you/needs-you-badge';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { toggleRail } from '@/lib/open-chat';
import { RAIL_HANDBACK_WAIT_MS, holdRailHeader, usePanelOverlays, useRailMode } from '@/lib/rail-store';
import { useViewStore } from '@/lib/view-store';
import { useLayoutDef } from '@/lib/look-store';
import { railHeaderRowOffset } from '@/lib/layout-themes';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/**
 * How much of the button the header row has room for, widest first: the key
 * and its chord on the plate ('full'), the key on the plate without the chord
 * ('key'), the 32px key with the mark alone ('icon'), or nothing ('none').
 */
type Fit = 'full' | 'key' | 'icon' | 'none';

/** The key alone: the capsule's square controls' size (h-8 w-8). */
const ICON_PX = 32;

/** The key's end padding after the word, with no chord on it (pr-[11px]). */
const KEY_END_PX = 11;

/** A frame at 60Hz, rounded up. */
const FRAME_MS = 17;

/**
 * The longest the button waits, unseen, for the room a closing column is
 * about to give it (useHeaderFit). The wait ends by itself once the column
 * has gone, since it then has no more room to give: the 300ms ease, and
 * Notebook's sheet margin, which goes when the ease reports its end
 * (desktop-shell.tsx LEAVE_FALLBACK_MS, 400ms, at the latest). So this is
 * only the backstop for a column that never goes, and it is the focus
 * hand-back's own wait (rail-store RAIL_HANDBACK_WAIT_MS) less two frames,
 * so the button is drawn in time for focus to land on it. Not two thirds of
 * the ease: the key form fits only once the column's last 20-40px have gone,
 * the slow tail of its ease-out, and a 200ms cap showed the key alone for
 * 30-130ms before it (Notebook's Week x Buckets, Classic's Week x Schedule).
 */
export const ASK_OPENER_CLOSE_WAIT_MS = RAIL_HANDBACK_WAIT_MS - 2 * FRAME_MS;

const px = (v: string) => parseFloat(v) || 0;

/**
 * The font the button draws in, as far as its width goes. The look sets it
 * (`--font-ui`: Geist in Studio, Nunito in Sorbet, JetBrains Mono in
 * Terminal), so it changes with a look or a light/dark flip under one header
 * face, and so do the widths read in it.
 */
const fontOf = (own: CSSStyleDeclaration) =>
  [own.fontFamily, own.fontSize, own.fontWeight, own.fontStyle, own.letterSpacing].join(' ');

/**
 * The button's natural width, without its margins: from its left edge to its
 * last child's far edge, plus its end padding and border. Not its scrollWidth
 * alone: the button's overflow is visible (the key's rim light and the focus
 * ring paint past its box), and a squeezed box with visible overflow reports a
 * scrollWidth that stops at its children's far edge and leaves the end padding
 * out, so a button 8-10px short of its width read as fitting and stayed whole,
 * the well and the ring cutting into the chord. Nor the larger of the two: a
 * scrollWidth is whole pixels, so it read the key form up to half a pixel
 * wider than the whole button had said it was (82 against 81.64), and the
 * ladder's two reads of one width disagreed. Only a DOM that lays nothing out
 * (a test's) has the scrollWidth alone.
 */
function naturalWidth(el: HTMLElement, own: CSSStyleDeclaration): number {
  const box = el.getBoundingClientRect();
  const last = el.lastElementChild;
  if (!last || box.width === 0) return el.scrollWidth;
  return last.getBoundingClientRect().right - box.left + px(own.paddingRight) + px(own.borderRightWidth);
}

/**
 * The 'key' form's natural width, without its margins, read off the whole
 * button while it is drawn: from its left edge to the key's far edge, plus
 * the key form's end padding and the border. The key form is the whole
 * button less the chord, so the key's far edge is read as it would stand
 * without it: less the chord, which is printed on the key, the key's gap
 * before it, and the narrower end padding beside it, plus the end padding
 * after the word (KEY_END_PX). Its well is even all round (8px round the
 * raised key, 4px round the drawn one), so its end padding is the start
 * padding both forms share. Drawn as the key form, naturalWidth reads the
 * same width straight, to the subpixel. A DOM that lays nothing out (a
 * test's) draws the chord 0 wide, and the key is read as it stands.
 */
function keyFormWidth(el: HTMLElement, own: CSSStyleDeclaration): number {
  const key = el.querySelector<HTMLElement>('[data-ask-key]');
  if (!key) return 0;
  let right = key.getBoundingClientRect().right;
  const chord = key.querySelector<HTMLElement>('[data-ask-opener-chord]');
  const chordPx = chord?.getBoundingClientRect().width ?? 0;
  if (chordPx > 0) {
    const keyStyle = getComputedStyle(key);
    right -= chordPx + px(keyStyle.columnGap) + px(keyStyle.paddingRight) - KEY_END_PX;
  }
  return right - el.getBoundingClientRect().left + px(own.paddingLeft) + px(own.borderRightWidth);
}

/**
 * The room the header row has yet to gain from the docked right column
 * (desktop-shell.tsx RailColumn) while it eases shut: the width it still takes
 * (and its dress's margin, Notebook's spread). 0 once it has gone, and for an
 * overlay, which takes no width from the row.
 */
function closingColumnPx(rail: Element | null): number {
  if (!rail) return 0;
  const style = getComputedStyle(rail);
  if (style.position === 'absolute') return 0;
  return rail.getBoundingClientRect().width + Math.max(0, px(style.marginLeft)) + Math.max(0, px(style.marginRight));
}

/**
 * The room the header row leaves this button, read off the row as laid out:
 * its content width less every other child that takes room (the capsule, a
 * notice, WeekScale) and the gaps between. The button's slot gives way to
 * them, never they to it: it shrinks first and to nothing (`min-w-0`, a shrink
 * weight no sibling has), so they keep their natural widths and what is
 * measured does not depend on what this chose. A fixed canvas breakpoint could not do this:
 * the capsule is ~70px wider while it shows Today, and Notebook's masthead
 * date up to ~90px wider on a long date, so any width that is safe for those
 * hides the button on every ordinary day.
 *
 * The ladder is full, then key, then icon, then none, and each rung is a
 * width with the button's own margins: `fullPx`, the key and its chord, and
 * `keyPx`, the key without the chord, are its natural widths, read whenever it
 * is drawn whole (naturalWidth and keyFormWidth, squeezed or not), and
 * `keyPx` whenever it is drawn as the key form too, so a layout's own face and
 * a rebinding's longer chord are what is measured, not a guess; the key alone
 * is 32px. A change of face (`face`: the header slot and the chord) or of
 * the font the button draws in (fontOf: the look's) forgets both, since
 * another face's, chord's or font's widths say nothing about this one's: the
 * ladder then reads 0 for them, so the button is drawn whole (or not at all,
 * with no room), read and placed before the next paint. Only the widths of
 * the form drawn and those wider than it are read again, so a narrower
 * form's remembered widths would outlive a font they were not read in, the
 * key form stuck without its chord after a flip to a narrower font (Classic
 * at 1290 from Terminal by night to Paper by day).
 *
 * It cannot flap at a rung. The room does not depend on the form chosen (the
 * siblings keep their widths whatever the slot does), room exactly at a rung
 * takes that rung, and a width is read only while its own form or a wider one
 * is drawn: a step down never re-reads the width that took it there, and the
 * narrower forms are not read at all.
 *
 * Closing Ask (or an item) hands the button back while the docked column is
 * still easing shut, so for 300ms the row is narrower than it is about to be.
 * Read as it stood, the button came back as the key alone for a few frames
 * and then whole, its rim light replaying as it switched (Classic at 1440 and
 * 1366). So while the column eases shut a form the row is about to have room
 * for (closingColumnPx: the width the column still takes) is waited for,
 * unseen, rather than a smaller one standing in (the key without its chord
 * no more than the key alone); one it will not have room for even then gives
 * way at once, as ever. The column is watched too, so each frame of its ease
 * is read, and the wait runs until the column has gone, when the room it
 * reads is the room it will have. The guess can be generous (a braindump the
 * column had narrowed takes some of the room back as it goes), which only
 * means waiting out the rest of the ease. It is capped
 * (ASK_OPENER_CLOSE_WAIT_MS) for a column that never goes, inside the focus
 * hand-back's own wait for the button to be drawn (rail-store
 * `restoreFocus`).
 */
function useHeaderFit(ref: RefObject<HTMLButtonElement | null>, active: boolean, face: string): Fit {
  const [fit, setFit] = useState<Fit>('full');
  const fullPx = useRef(0);
  const keyPx = useRef(0);
  /** The face and font `fullPx` and `keyPx` were read in. */
  const measuredIn = useRef('');
  /** When the button began waiting for a closing column's room, if it is. */
  const waitingSince = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const slot = el?.parentElement;
    const row = slot?.parentElement;
    if (!active || !el || !slot || !row) {
      // Hidden (Ask or an item shows): the next close starts its own wait.
      waitingSince.current = null;
      return;
    }
    const rail = document.querySelector('[data-rail]');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const style = getComputedStyle(row);
      const gap = parseFloat(style.columnGap) || 0;
      const content = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      let others = 0;
      for (const child of Array.from(row.children)) {
        if (child === slot) continue;
        const w = child.getBoundingClientRect().width;
        // A child with nothing to say renders no box, and takes no gap either.
        if (w > 0) others += w + gap;
      }
      // Its margins (the drawn key's inset off the row's end) are the same in
      // every form, so they are read off whichever is drawn, and every rung
      // needs them.
      const own = getComputedStyle(el);
      const margins = px(own.marginLeft) + px(own.marginRight);
      const reading = `${face} ${fontOf(own)}`;
      if (measuredIn.current !== reading) {
        measuredIn.current = reading;
        fullPx.current = 0;
        keyPx.current = 0;
      }
      const drawn = slot.dataset.fit;
      if (drawn === 'full') {
        fullPx.current = naturalWidth(el, own) + margins;
        keyPx.current = keyFormWidth(el, own) + margins;
      } else if (drawn === 'key') keyPx.current = naturalWidth(el, own) + margins;
      const room = content - others;
      const fitIn = (r: number): Fit =>
        r >= fullPx.current ? 'full' : r >= keyPx.current ? 'key' : r >= ICON_PX + margins ? 'icon' : 'none';
      const now = fitIn(room);
      let next = now;
      if (fitIn(room + closingColumnPx(rail)) === now) waitingSince.current = null;
      else {
        const at = Date.now();
        waitingSince.current ??= at;
        const left = waitingSince.current + ASK_OPENER_CLOSE_WAIT_MS - at;
        if (left > 0) {
          next = 'none';
          timer ??= setTimeout(() => {
            timer = undefined;
            measure();
          }, left);
        }
      }
      setFit(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return () => clearTimeout(timer);
    // The row, the button, and each sibling: a date that grows, Today coming
    // and going, WeekScale arriving with the week, a font that loads late. And
    // the column, easing shut.
    const sizes = new ResizeObserver(measure);
    sizes.observe(row);
    for (const child of Array.from(row.children)) sizes.observe(child);
    if (rail) sizes.observe(rail);
    const siblings = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => n instanceof Element && sizes.observe(n));
        r.removedNodes.forEach((n) => n instanceof Element && sizes.unobserve(n));
      }
      measure();
    });
    siblings.observe(row, { childList: true });
    return () => {
      clearTimeout(timer);
      sizes.disconnect();
      siblings.disconnect();
    };
    // `fit` re-runs it after a change, so a form drawn anew is re-read.
  }, [ref, active, fit, face]);
  return fit;
}

/**
 * The Ask button: a raised keycap reading "Ask" with the mark in it and the
 * chord printed on it ("Ctrl+J"), the twin of the braindump's do stuff key, on the canvas's header row
 * while Ask is closed. Ask starts closed (sidebar-store ASK_OPEN_DEFAULT), and
 * this is the way to it that does not need the chord.
 *
 * WHAT IT DOES is exactly what Ctrl+J does from closed (lib/open-chat.ts
 * `toggleRail`): leave Zen, summon Ask with its box focused, and write
 * `askOpen`, so it stays open across reloads until closed again. The summon
 * notes this button as where focus came from (rail-store `rememberFocus`), so
 * closing Ask by ✕ or Ctrl+J from inside it hands focus back here; so does a
 * close with no record of its own (Ask summoned from <body>, or open since
 * boot). It stays mounted, `hidden`, while the column shows, so that hand-back
 * has a node to land on, and the hand-back waits out the column's ease for it
 * to be drawn (rail-store `restoreFocus`): squeezed by the closing column, it
 * can measure no room and stay hidden until the column has gone. A click
 * focuses it first: Safari leaves a clicked button unfocused, and there would
 * be nothing to note. A pointer's click (one with a click count; a key's has
 * none) also holds Ask's header, and this button's own spot, against the
 * pointer for a moment (rail-store `holdRailHeader`): the header row opens
 * where this was, and in Console the braindump slides under it as the column
 * eases in, so a double-click's second click would otherwise land on History,
 * "+" or ✕, or on whatever of the braindump's had just arrived there.
 *
 * WHEN it shows: under exactly one of the AI gate's `canChat` (something
 * answers: lit, "Ask"), `askInvite` (nothing connected and the account never
 * said "No AI, thanks": unlit, "Set up AI") and `askFix` (a saved model needs
 * attention and nothing else answers: unlit, "Fix AI"), asked, never
 * re-derived; unknown is none of them. On the desktop, outside Zen, and only
 * while the right column is not shown, i.e. Ask (or the setup column) closed
 * and no item open (rail-store `railMode` is 'hidden'). Below 1180px that
 * includes an Ask kept open but not summoned this session: the column is
 * hidden there, and this summons it as the overlay Ctrl+J would. The phone
 * has the Ask tab instead.
 *
 * UNLIT it opens the setup column (components/ai/rail/ask-setup.tsx), with no
 * box to focus and nothing written to `askOpen`, and it wears no light: the
 * mark's neutral ink, no rim light, no lime (globals.css `[data-lit='false']`).
 * Its name is its word, and the chord still shows from the first day.
 *
 * WHERE: the last thing on the canvas's header row (desktop-shell.tsx), the
 * key on the date's line (`railHeaderRowOffset`, the rail header's own rule,
 * so when Ask opens its header row is where the key was). In day scope it
 * takes the row's far end (`ml-auto`, passed in); in the week views WeekScale
 * does, and this sits just past it. It gives way to everything else on the
 * row (useHeaderFit): the key without its chord when key and chord do not
 * fit, the key alone when that does not either, nothing when not even the key
 * does, so it never overlaps the capsule, a notice or WeekScale, never wraps
 * onto a line of its own and never grows the row the grid's height is
 * measured under.
 *
 * Out of room it hides rather than docking in the capsule's date row (the
 * design study's docked twin): that row has no room to spare in every
 * layout. Notebook's masthead date fills it on a long date, and a past or
 * future date's Today fills it on others, so a docked key would widen the
 * capsule past the row it was measured into, or need the capsule to shorten
 * its own date to make way. Ctrl+J and the command palette's "Ask AI" stay.
 *
 * HOW IT LOOKS (the CSS is app/globals.css, "Ask's key"):
 *  - 'full': the plate holds the raised key (--surface-2, the omnibar's
 *    key-press shadow pair, a 3px skirt under it) with the chord printed on
 *    it as a small inset in --ink-1. Hover and press fade the header
 *    capsule's own well in under it, and press sinks the key 2px into its
 *    skirt. The mark is the light source: the key's rim glows
 *    in the accent beside the mark's lit tile (ASK_MARK_LIGHT) and hands off
 *    through the look's aurora partner to the hairline; engaged, the light
 *    travels round the whole rim. The plain and masthead headers, which have
 *    no capsule material, draw the key on the page instead.
 *  - 'key': the same plate, key and light with the chord gone (the well is
 *    even all round the key in every form: 8px; 4px drawn on the page), the design study's
 *    narrow step: "Ask" stays where the chord does not fit (1280px Week x
 *    Schedule in Classic, its capsule 392px against Week x Buckets' 384px,
 *    which still fits whole). The chord stays in the title.
 *  - 'icon': the 32px key alone, the same light caught on its left arc. Its
 *    focus ring sits on the key, whose rim takes the focus colour. Drawn on
 *    the page it keeps the whole key's 14px inset off the row's end.
 *
 * `titlebar-hole`: in Writer the row starts at the window's top, inside the
 * desktop app's 43px drag band, which would swallow its clicks.
 *
 * The chord is the live binding through chordLabel (Ctrl+J; ⌘J on a Mac),
 * on the plate and in the title, which keeps it in every form (the key
 * without it and the key alone still say it on hover); never typed by hand.
 */
export function AskOpener({ className }: { className?: string }) {
  const { canChat, askInvite, askFix } = useAICapabilities();
  // The gate says which, at most one of the three (lib/ai-registry.ts).
  const offered = canChat || askInvite || askFix;
  // "ask stuff" beside "do stuff" (Kirby, 2026-10-13); the rail still names itself Ask.
  const word = canChat ? 'ask stuff' : askFix ? 'Fix AI' : 'Set up AI';
  const isMobile = useIsMobile();
  const zen = useViewStore((s) => s.zenOpen);
  const columnShown = useRailMode(usePanelOverlays()) !== 'hidden';
  const keys = useShortcutKeys('toggle_right_sidebar');
  const isMac = useMemo(() => isApplePlatform(), []);
  const { slots } = useLayoutDef();
  const ref = useRef<HTMLButtonElement>(null);
  const hidden = columnShown || zen;
  const chord = chordLabel(keys, isMac);
  // A rebinding is a change of face too: the chord's width is read afresh.
  // So is the word: "Set up AI" is wider than "ask stuff", and a width read for
  // one must never place the other.
  const fit = useHeaderFit(ref, offered && !isMobile && !hidden, `${slots.header} ${chord} ${word}`);

  const { open: waiting } = useNeedsYouCount();
  // The count rides the key only where the key is drawn and Ask can answer;
  // while it does, it is where the inbox opens (lib/needs-you-door.ts).
  const counted = canChat && waiting > 0 && !isMobile && !hidden && fit !== 'none';
  const hostInbox = useNeedsYouStore((s) => s.hostInbox);
  useEffect(() => (counted ? hostInbox() : undefined), [counted, hostInbox]);
  const peek = useHoverPeek(counted);

  if (!offered || isMobile) return null;
  const full = fit === 'full';
  // The key on its plate, with its chord or without; else the key alone.
  const plate = full || fit === 'key';
  // The capsule's header raises the key off its plate; the plain and
  // masthead headers, which take the capsule's material away, draw it on the
  // page (globals.css keys that paint on [data-layout-header]).
  const raised = slots.header === 'capsule';
  // The key's top is the rail header row's (railHeaderRowOffset). The whole
  // plate stands proud of it by its own padding: 8px round the raised key,
  // 4px round the drawn one.
  const offset = !plate ? railHeaderRowOffset(slots) : raised ? 'mt-0' : '-mt-1';
  // Where the rim's light comes from: the mark's lit part, from its slot's
  // centre. Unlit there is no light to aim.
  const light = canChat
    ? ({
        '--ask-light-x': `${ASK_MARK_LIGHT.x}px`,
        '--ask-light-y': `${ASK_MARK_LIGHT.y}px`,
      } as CSSProperties)
    : undefined;

  return (
    // The slot is the row's child: what is hidden, and what gives way.
    <span
      data-ask-opener-slot=""
      data-fit={fit}
      hidden={hidden || fit === 'none'}
      className={cn('relative flex min-w-0 shrink-[1000]', offset, className)}
      onPointerEnter={peek.enter}
      onPointerLeave={peek.leave}
    >
      <button
        ref={ref}
        type="button"
        data-ask-opener=""
        data-tour="ask-key"
        data-form={plate ? fit : 'icon'}
        data-lit={canChat ? undefined : 'false'}
        onClick={(e) => {
          if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
          if (e.detail > 0) holdRailHeader(e.currentTarget);
          // A peek the pointer rested into gives way to Ask, which lists the same questions.
          peek.dismiss();
          toggleRail();
        }}
        // Lit, it opens Ask and says so; unlit, its name is its word.
        aria-label={canChat ? 'Open Ask' : word}
        // Not while the count shows: resting on the key peeks the questions,
        // and the browser's tooltip would stack on them.
        title={counted ? undefined : `${canChat ? 'Open Ask' : word} (${chord})`}
        style={light}
        className={cn(
          'titlebar-hole group/ask-key relative isolate flex min-w-0 cursor-pointer items-center gap-2 text-[12px] leading-[17px] font-medium whitespace-nowrap text-[var(--ink-1)]',
          // The well is even all round the key in every form, the chord being
          // on the key (keyFormWidth counts on it).
          !plate
            ? 'size-7 rounded-[8px]'
            : raised
              ? 'h-11 rounded-[10px] p-2'
              : 'h-9 rounded-[11px] p-1',
          // The drawn key keeps its inset off the row's end in every form
          // (Notebook's ribbon sits just past it), and the fit counts it.
          !raised && 'mr-3.5'
        )}
      >
        <span
          data-ask-key=""
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 border border-transparent text-foreground',
            // KEY_END_PX after the word; less beside the chord's own inset.
            plate ? (full ? 'pr-[5px] pl-[9px]' : 'pr-[11px] pl-[9px]') : 'w-7 justify-center',
            plate && !raised ? 'rounded-[7px]' : 'rounded-[8px]'
          )}
        >
          <AskMark lit={canChat} raised={counted} />
          {plate && <span>{word}</span>}
          {full && (
            <kbd
              data-ask-opener-chord=""
              aria-hidden
              className="inline-flex h-4 items-center rounded-[4px] px-[4px] pt-px font-sans text-[10.5px] leading-none font-medium tracking-[0.01em] tabular-nums"
            >
              {chord}
            </kbd>
          )}
        </span>
      </button>
      {counted && <AskCount count={waiting} plate={plate} raised={raised} peek={peek} />}
    </span>
  );
}

/**
 * What is waiting on the user, on the Ask key's corner (Kirby's pick,
 * 2026-10-24): a small count in an aurora ring, the mark's top tile raised
 * beside it. Pressing the count, or resting the mouse on the key or the count
 * (useHoverPeek), peeks the inbox under the key without opening Ask; pressing
 * the key opens Ask, whose home lists every question. A sibling
 * of the button, never inside it, so a press here never toggles the rail, and
 * absolutely placed, so the header's fit never counts it.
 */
function AskCount({ count, plate, raised, peek }: { count: number; plate: boolean; raised: boolean; peek: HoverPeek }) {
  const inbox = useNeedsYouStore((s) => s.inbox);
  const openInbox = useNeedsYouStore((s) => s.openInbox);
  const closeInbox = useNeedsYouStore((s) => s.closeInbox);
  const label = `${count} waiting on you`;
  return (
    <Popover open={inbox.open} onOpenChange={(next) => (next ? openInbox() : closeInbox())}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-ask-count=""
          data-testid="ask-count"
          aria-label={label}
          onClick={(e) => {
            // Over a peek, a press keeps it rather than toggling it shut.
            if (peek.pin()) e.preventDefault();
          }}
          className={cn(
            'titlebar-hole absolute z-10 grid size-6 cursor-pointer place-items-center rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            // On the key's top corner in each form; the drawn key's inset off
            // the row's end (mr-3.5) moves the corner in.
            plate ? (raised ? '-top-1 -right-1' : '-top-2 right-1.5') : raised ? '-top-3 -right-3' : '-top-3 right-0.5'
          )}
        >
          <span className="ask-count-disc grid h-[17px] min-w-[17px] place-items-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums">
            {count > 9 ? '9+' : count}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        data-testid="needs-you-inbox"
        aria-label="Needs you"
        className={INBOX_SURFACE}
        // A peek never takes the keyboard; a press on the count does.
        onOpenAutoFocus={(e) => peek.peeking() && e.preventDefault()}
        onPointerEnter={peek.enter}
        onPointerLeave={peek.leave}
        onPointerDown={() => peek.pin()}
        onFocusCapture={() => peek.pin()}
      >
        <NeedsYouInbox />
      </PopoverContent>
    </Popover>
  );
}

/** How long the pointer rests on the key or its count before the questions peek. */
export const PEEK_OPEN_MS = 450;
/** How long a peek waits for the pointer to cross the gap into it. */
export const PEEK_CLOSE_MS = 200;

type HoverPeek = {
  enter: (e: ReactPointerEvent) => void;
  leave: (e: ReactPointerEvent) => void;
  /** Keeps an open peek (a press or the keyboard in it); true if there was one to keep. */
  pin: () => boolean;
  /** Whether the open inbox is a peek nothing has kept yet. */
  peeking: () => boolean;
  /** Shuts a peek, kept or not, and drops a pending one. */
  dismiss: () => void;
};

/**
 * Resting a mouse on the Ask key or its count peeks the questions waiting
 * (Kirby, 2026-10-25), after PEEK_OPEN_MS so a pointer passing on its way to
 * the window's edge opens nothing. A peek closes PEEK_CLOSE_MS after the
 * pointer leaves both the key and the card, unless it was kept: a press in
 * it, focus in it, or a press on the count. Touch and pen never peek (a tap
 * is a press), and only while the count shows.
 */
function useHoverPeek(active: boolean): HoverPeek {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const peeked = useRef(false);
  const clear = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => {
    if (!active) {
      clearTimeout(timer.current);
      peeked.current = false;
    }
  }, [active]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    enter: (e) => {
      if (!active || e.pointerType !== 'mouse') return;
      clear();
      if (useNeedsYouStore.getState().inbox.open) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        peeked.current = true;
        useNeedsYouStore.getState().openInbox();
      }, PEEK_OPEN_MS);
    },
    leave: (e) => {
      if (e.pointerType !== 'mouse') return;
      clear();
      if (!peeked.current) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (!peeked.current) return;
        peeked.current = false;
        useNeedsYouStore.getState().closeInbox();
      }, PEEK_CLOSE_MS);
    },
    pin: () => {
      clear();
      const was = peeked.current && useNeedsYouStore.getState().inbox.open;
      peeked.current = false;
      return was;
    },
    peeking: () => peeked.current,
    dismiss: () => {
      clear();
      peeked.current = false;
      if (useNeedsYouStore.getState().inbox.open) useNeedsYouStore.getState().closeInbox();
    },
  };
}
