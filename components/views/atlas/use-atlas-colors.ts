'use client';

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { useTheme } from 'next-themes';
import { useLookStore } from '@/lib/look-store';
import { usePaletteStore } from '@/lib/palette-store';
import { isDarkContext } from '@/components/primitives/relay-field';
import { toneForColor, type AtlasToneKey, type AtlasToneMode } from '@/lib/atlas-tones';

/**
 * What the far zoom and the minimap draw with, resolved for canvas (a
 * `fillStyle` can't take `var()`):
 *
 * - each container colour's Aurora tone, read from INSIDE the Atlas island,
 *   so under Dusk (`.dark` on the island) the base dark values answer;
 * - whether that context glows (dark) or blooms (paper), by `isDarkContext`,
 *   which also reads the minifier's `oklch(17.3% …)` right;
 * - the theme's own ink, muted ink and border for labels, dots and the
 *   minimap frame, so every theme and Tint keeps its own chrome.
 *
 * Re-resolved when the theme might have changed: the look-store picks, the
 * palette (Tint), next-themes' mode, `deps` (the island toggling Dusk), and a
 * MutationObserver on `<html>` for the class and data-look-* stamps.
 */
export interface AtlasColors {
  mode: AtlasToneMode;
  /** Container colour string to its tone. */
  tones: ReadonlyMap<string, AtlasToneKey>;
  fg: string;
  sub: string;
  dot: string;
  frameFill: string;
  /** The island's font stack, for canvas labels. */
  font: string;
}

const FALLBACK: Omit<AtlasColors, 'tones' | 'mode'> = {
  fg: 'rgba(40,40,52,1)',
  sub: 'rgba(110,110,125,1)',
  dot: 'rgba(30,30,45,0.15)',
  frameFill: 'rgba(128,128,140,0.12)',
  font: 'system-ui, sans-serif',
};

/** A counter that moves whenever the page's theme might have. */
export function useThemeVersion(): number {
  const light = useLookStore((s) => s.light);
  const dark = useLookStore((s) => s.dark);
  const palette = usePaletteStore((s) => s.palette);
  const { resolvedTheme } = useTheme();
  const [mutations, setMutations] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setMutations((n) => n + 1));
    mo.observe(document.documentElement, {
      attributes: true,
      // Never 'style': the sidebar drag writes --sidebar-w there every frame,
      // and user themes arrive as a <style> element and data-look stamps.
      attributeFilter: ['class', 'data-theme', 'data-look-light', 'data-look-dark'],
    });
    return () => mo.disconnect();
  }, []);
  // A string of everything, so a change to any one moves it.
  const [version, setVersion] = useState(0);
  const sig = `${light}|${dark}|${palette}|${resolvedTheme}|${mutations}`;
  const [lastSig, setLastSig] = useState(sig);
  if (sig !== lastSig) {
    setLastSig(sig);
    setVersion((v) => v + 1);
  }
  return version;
}

/** Whether the element sits in a light context (re-read when the theme moves). */
export function useAtlasLightContext(ref: RefObject<HTMLElement | null>): boolean {
  const version = useThemeVersion();
  const [light, setLight] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setLight(!isDarkContext(el));
  }, [ref, version]);
  return light;
}

function sameColors(a: AtlasColors, b: AtlasColors): boolean {
  if (a.mode !== b.mode || a.fg !== b.fg || a.sub !== b.sub || a.dot !== b.dot) return false;
  if (a.frameFill !== b.frameFill || a.font !== b.font || a.tones.size !== b.tones.size) return false;
  for (const [k, v] of a.tones) if (b.tones.get(k) !== v) return false;
  return true;
}

export function useAtlasColors(
  islandRef: RefObject<HTMLElement | null>,
  colors: readonly string[],
  deps: unknown
): AtlasColors {
  const version = useThemeVersion();
  const key = [...new Set(colors)].sort().join('\n');
  const [out, setOut] = useState<AtlasColors>(() => ({
    ...FALLBACK,
    mode: 'bloom',
    tones: new Map(colors.map((c) => [c, toneForColor(c)])),
  }));
  useLayoutEffect(() => {
    const el = islandRef.current;
    const list = key ? key.split('\n') : [];
    if (!el) {
      setOut((prev) => {
        const next = { ...prev, tones: new Map(list.map((c) => [c, toneForColor(c)])) };
        return sameColors(prev, next) ? prev : next;
      });
      return;
    }
    const cs = getComputedStyle(el);
    const read = (name: string) => cs.getPropertyValue(name).trim();
    const tones = new Map(list.map((c) => [c, toneForColor(c, read)]));
    const next: AtlasColors = {
      mode: isDarkContext(el) ? 'glow' : 'bloom',
      tones,
      fg: read('--foreground') || FALLBACK.fg,
      sub: read('--muted-foreground') || FALLBACK.sub,
      dot: read('--border') || FALLBACK.dot,
      frameFill: read('--accent') || FALLBACK.frameFill,
      font: cs.fontFamily || FALLBACK.font,
    };
    // The same answer keeps the same object, so nothing downstream repaints.
    setOut((prev) => (sameColors(prev, next) ? prev : next));
  }, [islandRef, key, version, deps]);
  return out;
}
