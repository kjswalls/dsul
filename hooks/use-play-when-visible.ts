'use client';

import { useEffect, useState, type RefObject } from 'react';

import { prefersReducedMotion } from '@/lib/zen-transition';

/**
 * Should a looping decoration be moving right now?
 *
 * Yes only while it is on screen, the tab is visible, and neither motion veto
 * is set — the OS `prefers-reduced-motion` and the app's own
 * `<html data-reduce-motion>` (Settings → Look). The extensions store puts a
 * dozen loops on one page, so "only while on screen" is what keeps that page
 * from running eleven animations nobody can see.
 *
 * Lifted from RelayField's inline observer (components/primitives/relay-field.tsx)
 * rather than shared with it: that one drives a canvas loop, this one only
 * flips a data attribute that CSS keys its animations off. A caller's resting
 * (not playing) styles must be a frame that already makes sense on its own,
 * because that is what reduced motion shows forever.
 */
export function usePlayWhenVisible(
  ref: RefObject<Element | null>,
  { whileEngaged = false }: { whileEngaged?: boolean } = {}
): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), {
      threshold: 0.15,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  // A shelf of cards is a page of loops; with `whileEngaged` each one waits on
  // its still frame until its own card is pointed at or focused. The card is
  // the nearest link or button around the preview, so hovering its title plays
  // it too.
  useEffect(() => {
    const el = ref.current;
    if (!whileEngaged || !el) return;
    const host = el.closest('a, button') ?? el;
    // Keyboard focus only: a browser focuses a link on mousedown, so counting
    // any focus kept a ⌘-clicked card looping long after the pointer left.
    const keyboardFocus = () => host.matches(':focus-visible') || host.querySelector(':focus-visible') !== null;
    const on = () => setEngaged(true);
    const focusIn = () => {
      if (keyboardFocus()) setEngaged(true);
    };
    const off = () => setEngaged(keyboardFocus());
    const blur = (event: Event) => {
      if (!host.contains((event as FocusEvent).relatedTarget as Node | null)) setEngaged(host.matches(':hover'));
    };
    host.addEventListener('pointerenter', on);
    host.addEventListener('pointerleave', off);
    host.addEventListener('focusin', focusIn);
    host.addEventListener('focusout', blur);
    return () => {
      host.removeEventListener('pointerenter', on);
      host.removeEventListener('pointerleave', off);
      host.removeEventListener('focusin', focusIn);
      host.removeEventListener('focusout', blur);
    };
  }, [ref, whileEngaged]);

  useEffect(() => {
    const sync = () => setTabVisible(document.visibilityState !== 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  useEffect(() => {
    const sync = () => setReduced(prefersReducedMotion());
    sync();
    // The app veto is an attribute on <html>, flipped from Settings → Look
    // while this page may be open, so it is watched as well as the media query.
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener?.('change', sync);
    const attrs = new MutationObserver(sync);
    attrs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    return () => {
      media?.removeEventListener?.('change', sync);
      attrs.disconnect();
    };
  }, []);

  return onScreen && tabVisible && !reduced && (!whileEngaged || engaged);
}
