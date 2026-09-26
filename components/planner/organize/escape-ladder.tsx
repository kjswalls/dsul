'use client';

import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

/**
 * THE ESCAPE LADDER — Escape backs out of one thing at a time, and only leaves
 * the console when there is nothing left to back out of.
 *
 * WHY THIS EXISTS AS A REGISTRY, when four `e.stopPropagation()` calls look like
 * they would do the same job: they do not work, at all. Radix's DismissableLayer
 * binds its Escape handler with
 *
 *     ownerDocument.addEventListener('keydown', handler, { capture: true })
 *
 * (`@radix-ui/react-use-escape-keydown`), so it runs on the CAPTURE path, at the
 * document, before the event has begun descending toward the focused input. By
 * the time any React `onKeyDown` fires, the dialog has already been told to
 * close. Stopping propagation there stops nothing — the decision is made.
 *
 * A capture-phase listener of our own on `document` does not fix it either:
 * same target, same phase, so Radix wins on registration order, and Radix
 * registered when the plate mounted.
 *
 * So the ladder goes through Radix's own door instead. `onEscapeKeyDown` is a
 * DialogContent prop, it fires before the close, and `preventDefault()` on it
 * keeps the plate open. The console asks the ladder whether anything wants the
 * press; if something does, it consumes it and the plate stays.
 *
 * Each rung decides for ITSELF whether the press is its own — normally "am I
 * focused, and do I have something to clear" — so no ordering rule is needed
 * and two rungs can never both claim one press.
 *
 * The dialog this replaced carried the same dead `stopPropagation` rungs from
 * the day it shipped to the day it was deleted, and nobody noticed — which is
 * the argument for the registry rather than for four more local handlers.
 */

/** Returns true when this rung consumed the press. */
type Rung = () => boolean;

const LadderContext = createContext<((rung: Rung) => () => void) | null>(null);

/**
 * Owned by the console. `consume()` goes on the plate's `onEscapeKeyDown`.
 */
export function useEscapeLadder() {
  const rungs = useRef(new Set<Rung>());

  const register = useCallback((rung: Rung) => {
    rungs.current.add(rung);
    return () => {
      rungs.current.delete(rung);
    };
  }, []);

  const consume = useCallback(() => {
    for (const rung of rungs.current) if (rung()) return true;
    return false;
  }, []);

  return { register, consume, Ladder: LadderContext.Provider };
}

/**
 * Claim Escape from inside the plate.
 *
 * The claim is re-read on every press rather than captured, so a rung can close
 * over live state (a query string, a draft) without re-registering each render.
 */
export function useEscapeRung(rung: Rung) {
  const register = useContext(LadderContext);
  const latest = useRef(rung);

  useEffect(() => {
    latest.current = rung;
  });

  useEffect(() => {
    if (!register) return;
    return register(() => latest.current());
  }, [register]);
}

/**
 * Is this node in the section the user is actually looking at?
 *
 * INSIDE THE CONSOLE THIS ALWAYS RETURNS TRUE, and it is kept anyway. (Outside
 * any tabpanel — the "new" dialog — it is true by definition.) Radix's `Tabs.Content`
 * renders `{present && children}` — the panel element exists for every section
 * but only the ACTIVE one has a subtree, so only the visible section's rungs are
 * ever registered. Verified, not assumed: a probe render of the plate finds one
 * `organize-list` and one filter field, and five panels with zero children.
 *
 * It stays because that is a property of Radix's default, not of this console.
 * Adding `forceMount` to preserve a section's scroll position — an entirely
 * reasonable future change — would mount all six at once, and without this guard
 * a search box left open in Routines would silently eat the Escape you pressed
 * while looking at Programs. One `closest()` call is a cheap way to make that
 * change safe instead of subtly broken.
 */
export function inActiveSection(node: Element | null | undefined): boolean {
  if (!node) return false;
  // Outside any section at all — the "new" dialog, which mounts the same member
  // lists with a ladder of its own — there is no inactive panel to guard against.
  const panel = node.closest('[role="tabpanel"]');
  return !panel || panel.getAttribute('data-state') === 'active';
}
