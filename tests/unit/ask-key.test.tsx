import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Ask key and the AI's mark, held to the shape that makes them safe to
 * look at and safe to swap:
 *
 *  - The mark is ONE component (components/ai/ask-mark.tsx), drawn by the Ask
 *    key, by Ask's header and everywhere else the AI is marked (where Lucide's
 *    Sparkles used to be), decorative in all of them; nothing else knows what
 *    it looks like, so swapping it is a change to that file. This file holds
 *    it to the slot's contract only (the accent solid, the slot's tokens,
 *    motion only when the key engages it), in both its tones, never to how
 *    many parts it has or which is lit, so a swap leaves it green.
 *  - The key's paint (app/globals.css, "Ask's key") obeys CLAUDE.md's accent
 *    rule with no exception: no opacity, filter, mask or blend anywhere in it,
 *    and the accent is never mixed into anything (only the partner steps
 *    toward the hairline).
 *  - Its motion is property-scoped, short, pointer-guarded on hover, off under
 *    reduced motion, and its fill and rim join the theme swap's window rather
 *    than flipping on its first frame.
 *  - Focus is the app's 2px full-strength ring.
 *
 * Behaviour (when it shows, the click, the fit, the chord) is
 * ask-opener.test.tsx's.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
// The relay ground behind Ask home's header draws on a canvas; it is not what this is about.
vi.mock('@/components/primitives/relay-field', () => ({ RelayField: () => null }));

import { AskOpener } from '@/components/ai/rail/ask-opener';
import { RailHeader } from '@/components/ai/rail/rail-header';
import { AskMark, AskMarkIcon, ASK_MARK_LIGHT, type AskMarkTone } from '@/components/ai/ask-mark';
import { useLookStore } from '@/lib/look-store';
import { seedAI, CONNECTED_MODEL } from './helpers/ai-fixtures';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

/** The "Ask's key" block of app/globals.css, from its header to the next section's. */
function askBlock(): string {
  const css = read('app/globals.css');
  const start = css.indexOf("/* ─── Ask's key");
  expect(start, "the Ask's key block is gone from globals.css").toBeGreaterThan(-1);
  const end = css.indexOf('/* ─── ', start + 8);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** [start, end) of every `@media <query> { ... }` block in `src` (brace-matched). */
function mediaBlocks(src: string, query: string): [number, number][] {
  const out: [number, number][] = [];
  let at = src.indexOf(`@media ${query}`);
  while (at !== -1) {
    const open = src.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push([at, i + 1]);
    at = src.indexOf(`@media ${query}`, i);
  }
  return out;
}

/** Every value of a `prop:` declaration in `src`. */
function values(src: string, prop: string): string[] {
  return Array.from(src.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g')), (m) => m[1].trim());
}

/** The comma-separated items of a value, ignoring commas inside parentheses. */
function items(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const ACCENT = /--(?:lime-solid|ask-icon-accent|ask-key-accent)\b/;

interface Rule {
  /** Its selector list, split at the top level. */
  selectors: string[];
  body: string;
  /** Where it starts in the source it was read from: later wins a tie. */
  at: number;
}

/** Every style rule in `src` (comments stripped), @media blocks opened, at-rules like @property skipped. */
function rules(src: string): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string, offset: number) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      let depth = 0;
      let j = open;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}' && --depth === 0) break;
      }
      const prelude = text.slice(i, open).trim();
      if (prelude.startsWith('@media')) walk(text.slice(open + 1, j), offset + open + 1);
      else if (!prelude.startsWith('@')) out.push({ selectors: items(prelude), body: text.slice(open + 1, j), at: offset + open });
      i = j + 1;
    }
  };
  walk(src, 0);
  return out;
}

type Specificity = [number, number, number];
const bySpecificity = (x: Specificity, y: Specificity) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** A selector's specificity: :is/:not/:has take their most specific argument, :where none. */
function specificity(sel: string): Specificity {
  const out: Specificity = [0, 0, 0];
  const word = /[\w-]/;
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '[') {
      out[1]++;
      i = sel.indexOf(']', i) + 1;
    } else if (ch === '#' || ch === '.') {
      out[ch === '#' ? 0 : 1]++;
      for (i++; word.test(sel[i] ?? ''); i++);
    } else if (ch === ':' && sel[i + 1] === ':') {
      out[2]++;
      for (i += 2; word.test(sel[i] ?? ''); i++);
    } else if (ch === ':') {
      const m = /^:([\w-]+)(\()?/.exec(sel.slice(i))!;
      i += m[0].length;
      if (!m[2]) {
        out[1]++;
        continue;
      }
      let depth = 1;
      let j = i;
      for (; j < sel.length && depth > 0; j++) {
        if (sel[j] === '(') depth++;
        else if (sel[j] === ')') depth--;
      }
      const arg = sel.slice(i, j - 1);
      i = j;
      if (m[1] === 'where') continue;
      if (['is', 'not', 'has'].includes(m[1])) {
        const best = items(arg).map(specificity).sort(bySpecificity).at(-1)!;
        best.forEach((v, k) => (out[k] += v));
      } else out[1]++;
    } else if (/[a-zA-Z]/.test(ch)) {
      out[2]++;
      for (; word.test(sel[i] ?? ''); i++);
    } else i++;
  }
  return out;
}

/** True when rule `a`'s selector `as` beats rule `b`'s selector `bs` on the same element. */
const beats = (a: Rule, as: string, b: Rule, bs: string) => {
  const c = bySpecificity(specificity(as), specificity(bs));
  return c > 0 || (c === 0 && a.at > b.at);
};

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let unseed: () => void = () => {};
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  useLookStore.setState({ layout: 'classic' });
  unseed = seedAI(CONNECTED_MODEL);
});
afterEach(() => {
  cleanup();
  unseed();
});

describe('the mark', () => {
  it("is drawn in the Ask key and on Ask's header, the same mark, decorative in both", () => {
    const { container: keyRow } = render(
      <div className="flex gap-3">
        <AskOpener className="ml-auto" />
      </div>
    );
    const { container: header } = render(<RailHeader title="Ask" home onClose={() => {}} />);
    const inKey = keyRow.querySelector('[data-ask-opener] [data-ask-key] [data-ask-mark]');
    const inHeader = header.querySelector('[data-ask-heading] [data-ask-mark]');
    expect(inKey).not.toBeNull();
    expect(inHeader).not.toBeNull();
    for (const mark of [inKey, inHeader]) {
      expect(mark).toHaveAttribute('aria-hidden', 'true');
      expect(mark).toHaveAttribute('focusable', 'false');
      expect(mark).toHaveClass('size-4');
    }
    // One mark, not two drawings of it.
    expect(inHeader?.outerHTML).toBe(inKey?.outerHTML);
    // The sparkle it replaced is gone from both, and the heading still reads "Ask".
    expect(keyRow.querySelector('.lucide-sparkles')).toBeNull();
    expect(header.querySelector('.lucide-sparkles')).toBeNull();
    expect(header.querySelector('[data-ask-heading]')).toHaveTextContent(/^Ask$/);
  });

  it("leads Ask home's heading only, not every view's", () => {
    const { container } = render(<RailHeader title="History" onClose={() => {}} />);
    expect(container.querySelector('[data-ask-mark]')).toBeNull();
  });

  it('is one file: nothing else draws it, and only the key reads its light point', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, name);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(tsx?|css)$/.test(name)) files.push(rel);
      }
    };
    ['app', 'components', 'lib', 'hooks'].forEach(walk);
    const drawing = files.filter((f) => /data-ask-mark=/.test(read(f)));
    expect(drawing).toEqual(['components/ai/ask-mark.tsx']);
    const lightReaders = files.filter(
      (f) => /\.tsx?$/.test(f) && f !== 'components/ai/ask-mark.tsx' && /ASK_MARK_LIGHT/.test(read(f))
    );
    expect(lightReaders).toEqual(['components/ai/rail/ask-opener.tsx']);
    // The key and the header carry it by importing it, never by drawing their own.
    for (const f of ['components/ai/rail/ask-opener.tsx', 'components/ai/rail/rail-header.tsx']) {
      expect(read(f)).toMatch(/import \{[^}]*\bAskMark\b[^}]*\} from '@\/components\/ai\/ask-mark'/);
      expect(read(f)).not.toMatch(/<svg|<rect|Sparkles/);
    }
    // The light point is a whole-pixel offset inside the 16px slot.
    for (const v of [ASK_MARK_LIGHT.x, ASK_MARK_LIGHT.y]) {
      expect(Number.isInteger(v * 2)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(8);
    }
  });

  // The sparkle that marked AI before the mark existed: every place it stood
  // for the AI carries the mark now, by importing it. Lucide's Sparkles stays
  // only in the glyph library users pick for their own containers.
  it('marks the AI everywhere the sparkle did, and no Lucide sparkle stands for it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, name);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name)) files.push(rel);
      }
    };
    ['app', 'components', 'lib', 'hooks'].forEach(walk);
    const sparkles = files.filter((f) => /import\s*\{[^}]*\bSparkles\b[^}]*\}\s*from\s*'lucide-react'/.test(read(f)));
    expect(sparkles).toEqual(['lib/category-icons.ts']);
    for (const f of [
      'components/ai/ask/ask-greeting.tsx',
      'components/ai/ask/history-view.tsx',
      'components/ai/proposal-card.tsx',
      'components/mobile/mode-switcher-sheet.tsx',
      'components/notices/ai-notice.tsx',
      'components/planner/item-context-menu.tsx',
      'components/planner/item-detail-sections.tsx',
      'components/sidebar/omnibar.tsx',
      'lib/commands/registry.ts',
      'lib/settings/manifest.ts',
    ]) {
      expect(read(f), f).toMatch(/import \{[^}]*\bAskMark(?:Icon)?\b[^}]*\} from '@\/components\/ai\/ask-mark'/);
    }
  });

  describe('in one ink, where a slot colours its glyph', () => {
    it('paints every part in the text colour round it, and never moves', () => {
      const { container } = render(<AskMark tone="ink" className="size-3" />);
      const svg = container.querySelector('svg[data-ask-mark]') as SVGSVGElement;
      expect(svg).toHaveAttribute('data-tone', 'ink');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveClass('size-3');
      expect(svg).not.toHaveClass('size-4');
      const tiles = Array.from(svg.querySelectorAll('*'));
      expect(tiles.length).toBeGreaterThan(0);
      for (const el of tiles) {
        expect(el.getAttribute('class')).toBe('fill-current');
        expect(el.getAttribute('fill')).toBeNull();
      }
    });

    it("stands in for a Lucide icon: sized by the slot's class, decorative whatever the slot passes", () => {
      const ref = { current: null as SVGSVGElement | null };
      const { container } = render(
        <AskMarkIcon ref={ref} className="h-3.5 w-3.5 text-destructive" strokeWidth={2.25} aria-hidden={false} />
      );
      const svg = container.querySelector('svg[data-ask-mark]') as SVGSVGElement;
      expect(ref.current).toBe(svg);
      expect(svg).toHaveAttribute('data-tone', 'ink');
      // 16px until a class sizes it, Lucide's way, so h-/w- and size- both win.
      expect(svg).toHaveAttribute('width', '16');
      expect(svg).toHaveAttribute('height', '16');
      expect(svg).toHaveClass('h-3.5', 'w-3.5', 'text-destructive');
      expect(svg.getAttribute('class')).not.toMatch(/\bsize-/);
      // A stroke means nothing to filled tiles, and it never loses aria-hidden.
      expect(svg).not.toHaveAttribute('stroke-width');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });

    it('passes data attributes through, and keeps its own', () => {
      const { container } = render(<AskMark data-glyph="general" data-ask-mark="other" />);
      const svg = container.querySelector('svg') as SVGSVGElement;
      expect(svg).toHaveAttribute('data-glyph', 'general');
      expect(svg).toHaveAttribute('data-ask-mark', 'aurora-step');
    });
  });

  /*
   * The mark's contract, which any mark swapped into ask-mark.tsx keeps and
   * nothing here says what the mark looks like (how many parts, which one is
   * lit, how it moves): drawn by the slot's rules, so a swap is a change to
   * that file alone.
   */
  describe("keeps the slot's contract, whatever it draws, in either tone", () => {
    const TONES: AskMarkTone[] = ['aurora', 'ink'];
    /** Every element of the mark in `tone`, the svg first. */
    const parts = (tone: AskMarkTone = 'aurora') => {
      const { container } = render(<AskMark tone={tone} />);
      const svg = container.querySelector('svg[data-ask-mark]') as SVGSVGElement;
      expect(svg).not.toBeNull();
      return [svg, ...Array.from(svg.querySelectorAll('*'))];
    };
    /** What paints an element: its classes, its style, and its paint attributes. */
    const paintOf = (el: Element) =>
      ['class', 'style', 'fill', 'stroke', 'color', 'stop-color', 'opacity', 'fill-opacity', 'stroke-opacity', 'filter', 'mask']
        .map((a) => el.getAttribute(a) ?? '')
        .join(' ');
    /** The class list as utilities, each with its variants (a colon inside [...] or (...) is the utility's own). */
    const utilities = (el: Element) =>
      (el.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((raw) => {
          const parts: string[] = [];
          let depth = 0;
          let cur = '';
          for (const ch of raw) {
            if (ch === '[' || ch === '(') depth++;
            if (ch === ']' || ch === ')') depth--;
            if (ch === ':' && depth === 0) {
              parts.push(cur);
              cur = '';
            } else cur += ch;
          }
          parts.push(cur);
          return { raw, variants: parts.slice(0, -1), utility: parts.at(-1)!.replace(/^!/, '') };
        });
    const SLOT = new Set(['--ask-icon-ink', '--ask-icon-lit', '--ask-icon-accent', '--ask-icon-pair', '--ask-icon-pair-ink', '--ask-icon-key']);

    /** Why `el` would fade what it paints (opacity, alpha, filter, mask, blend), or null. */
    function fades(el: Element): string | null {
      for (const attr of ['opacity', 'fill-opacity', 'stroke-opacity', 'filter', 'mask']) {
        if (el.hasAttribute(attr)) return `the ${attr} attribute`;
      }
      if (/opacity|filter|mask|mix-blend|plus-lighter/.test(el.getAttribute('style') ?? '')) return 'its style';
      for (const { raw, utility } of utilities(el)) {
        if (/^-?(?:opacity|fill-opacity|stroke-opacity|blur|drop-shadow|brightness|contrast|saturate|grayscale|invert|sepia|hue-rotate|filter|backdrop|mix-blend|bg-blend|mask)(?:-|$)/.test(utility)) return raw;
        if (/^\[(?:opacity|fill-opacity|stroke-opacity|filter|backdrop-filter|mask[\w-]*|mix-blend-mode):/.test(utility)) return raw;
        // An alpha modifier on a colour, or an alpha in the colour itself.
        if (/^(?:fill|stroke|text|bg|border|outline|ring|shadow|from|via|to|decoration)-.*\/(?:\d+|\[[^\]]*\]|\([^)]*\))$/.test(utility)) return raw;
        if (/transparent|_\/_|plus-lighter/.test(utility)) return raw;
      }
      return null;
    }

    it('is decorative and drawn for the 16px slot', () => {
      for (const tone of TONES) {
        const [svg] = parts(tone);
        expect(svg).toHaveAttribute('aria-hidden', 'true');
        expect(svg).toHaveAttribute('focusable', 'false');
        expect(svg).toHaveClass('size-4');
        expect(svg.hasAttribute('width') || svg.hasAttribute('height')).toBe(false);
        expect(svg).toHaveAttribute('viewBox');
      }
    });

    it('paints the accent solid: nothing fades a part that carries it, round it or inside it', () => {
      const all = TONES.flatMap((tone) => parts(tone));
      const lit = all.filter((el) => ACCENT.test(paintOf(el)));
      for (const el of lit) {
        const chain: Element[] = [];
        for (let a: Element | null = el; a && all.includes(a); a = a.parentElement) chain.push(a);
        chain.push(...Array.from(el.querySelectorAll('*')));
        for (const c of chain) expect(fades(c), `${c.tagName} fades the accent with ${fades(c)}`).toBeNull();
      }
      // A blend reaches whatever is under it, so none anywhere in the mark.
      for (const el of all) expect(paintOf(el)).not.toMatch(/mix-blend|bg-blend|plus-lighter/);
    });

    it("paints in the slot's tokens: a mix with the accent is a solid blend of slot tokens, and no colour is literal", () => {
      for (const el of TONES.flatMap((tone) => parts(tone))) {
        const paint = paintOf(el);
        for (const [mix] of paint.matchAll(/color-mix\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g)) {
          if (!ACCENT.test(mix)) continue;
          for (const [, token] of mix.matchAll(/var\((--[\w-]+)/g)) expect(SLOT, `${token} in ${mix}`).toContain(token);
          expect(mix).not.toMatch(/transparent|_\/_|\s\/\s/);
        }
        expect(paint, el.tagName).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/);
        for (const { raw, utility } of utilities(el)) {
          expect(utility, raw).not.toMatch(
            /^(?:fill|stroke|text|bg|border)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})$/
          );
        }
      }
    });

    it('moves only when the key engages it, by named properties, within 300ms with its delay, and never under reduced motion', () => {
      for (const el of TONES.flatMap((tone) => parts(tone))) {
        const us = utilities(el);
        const has = (raw: string) => us.some((u) => u.raw === raw);
        let duration = 0;
        let delay = 0;
        for (const { raw, variants, utility } of us) {
          // Engaged only by the Ask key: a state is a group variant on group/ask-key.
          for (const v of variants) {
            if (/hover|focus|active|peer|target|checked/.test(v)) expect(v, raw).toMatch(/^group-(?:hover|focus-visible|active)\/ask-key$/);
          }
          // Named properties, never all (Tailwind's bare `transition` is its catch-all list).
          if (/^transition(?:-|$)/.test(utility) && utility !== 'transition-none') {
            expect(utility, raw).not.toMatch(/^transition$|^transition-all$|\ball\b/);
            expect(has('motion-reduce:transition-none'), `${raw} without motion-reduce:transition-none`).toBe(true);
          }
          if (/^\[transition(?:-property)?:/.test(utility)) expect(utility, raw).not.toMatch(/\ball\b/);
          // Nothing runs at rest: an animation only while engaged, and never under reduced motion.
          if (/^animate-/.test(utility) && utility !== 'animate-none') {
            expect(variants.some((v) => /\/ask-key$/.test(v)), `${raw} runs at rest`).toBe(true);
            expect(has('motion-reduce:animate-none'), `${raw} without motion-reduce:animate-none`).toBe(true);
          }
          const ms = /^(duration|delay)-(?:(\d+)|\[(\d+(?:\.\d+)?)(ms|s)\])$/.exec(utility);
          if (ms) {
            const value = ms[2] ? Number(ms[2]) : Number(ms[3]) * (ms[4] === 's' ? 1000 : 1);
            if (ms[1] === 'duration') duration = Math.max(duration, value);
            else delay = Math.max(delay, value);
          }
        }
        expect(duration + delay, `${el.tagName}: ${duration}ms + ${delay}ms`).toBeLessThanOrEqual(300);
        expect(el.getAttribute('style') ?? '').not.toMatch(/transition|animation/);
        expect(el.querySelector('animate, animateTransform, animateMotion, set')).toBeNull();
      }
    });
  });
});

describe("the key's paint (app/globals.css)", () => {
  it('puts no opacity, filter, mask or blend on anything', () => {
    const block = stripComments(askBlock());
    expect(block).not.toMatch(/\bopacity\s*:/);
    expect(block).not.toMatch(/(?:^|[\s;{])(?:-webkit-)?(?:filter|backdrop-filter|mask|mask-image|mix-blend-mode)\s*:/);
    expect(block).not.toMatch(/plus-lighter/);
  });

  it('never mixes the accent into anything: only the partner steps toward the hairline', () => {
    const block = stripComments(askBlock());
    for (const [mix] of block.matchAll(/color-mix\((?:[^()]|\([^()]*\))*\)/g)) expect(mix).not.toMatch(ACCENT);
    // No alpha on it either.
    expect(block).not.toMatch(/var\(--(?:lime-solid|ask-icon-accent|ask-key-accent)\)\s*\//);
    // The accent token is the raw one, and the gradient holds it at full strength from the light point.
    expect(block).toMatch(/--ask-icon-accent:\s*var\(--lime-solid\);/);
    expect(block).toMatch(/var\(--ask-key-accent\) 0px,\s*var\(--ask-key-accent\) var\(--ask-key-hold\)/);
  });

  it("registers the light's lengths and the key's colours, so they ease", () => {
    const block = askBlock();
    for (const name of ['--ask-key-hold', '--ask-key-tail', '--ask-key-reach']) {
      expect(block).toMatch(new RegExp(`@property ${name} \\{\\s*syntax: '<length>';`));
    }
    for (const name of ['--ask-key-fill', '--ask-key-accent', '--ask-key-pair', '--ask-key-rim']) {
      expect(block).toMatch(new RegExp(`@property ${name} \\{\\s*syntax: '<color>';`));
    }
  });

  it('transitions named properties, never all, each 300ms or less', () => {
    const block = stripComments(askBlock());
    const shorthands = values(block, 'transition');
    const lists = values(block, 'transition-property');
    expect(shorthands.length).toBeGreaterThan(0);
    for (const v of [...shorthands, ...lists]) expect(v).not.toMatch(/\ball\b/);
    for (const v of shorthands) {
      if (/^none\b/.test(v)) continue;
      for (const item of items(v)) {
        // Each item starts with the property it animates, never a bare duration.
        expect(item).toMatch(/^(--[\w-]+|[a-z-]+)\s+\d+ms\b/);
        for (const [, ms] of item.matchAll(/(\d+)ms/g)) expect(Number(ms)).toBeLessThanOrEqual(300);
      }
    }
    for (const v of values(block, 'transition-duration')) {
      for (const [, ms] of v.matchAll(/(\d+)ms/g)) expect(Number(ms)).toBeLessThanOrEqual(300);
    }
  });

  it("stops every transition under reduced motion, the key's and the mark's wherever it is drawn", () => {
    const block = stripComments(askBlock());
    const reduce = mediaBlocks(block, '(prefers-reduced-motion: reduce)');
    expect(reduce).toHaveLength(1);
    const osVeto = rules(block.slice(...reduce[0]));
    // And the in-app animations-off setting, which the global rule only
    // clamps: delays survive it, and the header's mark held a part on the old
    // mode's colour for its 60ms on a theme flip.
    const appVeto = rules(block).filter((r) => r.selectors.every((s) => s.startsWith("[data-reduce-motion='true'] ")));
    for (const [name, veto] of [
      ['the OS setting', osVeto],
      ['the in-app setting', appVeto],
    ] as const) {
      const vetoes = veto.filter((r) => /transition:\s*none !important/.test(r.body) && /animation:\s*none !important/.test(r.body));
      const covered = vetoes.flatMap((r) => r.selectors.map((s) => s.replace("[data-reduce-motion='true'] ", '')));
      for (const sel of ['[data-ask-opener]', '[data-ask-opener]::before', '[data-ask-opener] *', '[data-ask-mark]', '[data-ask-mark] *']) {
        expect(covered, `${name} stills ${sel}`).toContain(sel);
      }
    }
  });

  // Ask's header carries the mark with no key round it: nothing engages it
  // there, so its only motion was the rest state's hand-off delay, which held
  // a part on the old colour through a mode flip outside the theme swap's
  // window (the OS flipping a 'system' theme).
  it('holds the mark still outside the key, while letting the theme swap ease it', () => {
    const all = rules(stripComments(askBlock()));
    const still = all.filter((r) => /(?:^|[\s;{])transition:\s*none\s*;/.test(r.body) && !/!important/.test(r.body));
    const selectors = still.flatMap((r) => r.selectors);
    expect(selectors).toContain('[data-ask-mark]:not([data-ask-key] [data-ask-mark])');
    expect(selectors).toContain('[data-ask-mark]:not([data-ask-key] [data-ask-mark]) *');
    // Not !important (filtered above), so the swap's window, which is, still
    // eases it with the header; and it beats the mark's own (layered) classes
    // by being unlayered, which the block is.
    const css = read('app/globals.css');
    const before = css.slice(0, css.indexOf("/* ─── Ask's key"));
    const depth = stripComments(before).split('{').length - stripComments(before).split('}').length;
    expect(depth, "the Ask's key block sits outside every @layer").toBe(0);
  });

  // A press eases the key's fill, and "Ask" is the key's colour: the two
  // move together, or an unwindowed mode flip snaps the word over the old fill.
  it('eases "Ask" with the key\'s fill, and keeps the press\'s durations in step with the list', () => {
    const all = rules(stripComments(askBlock()));
    const key = all.find((r) => r.selectors.length === 1 && r.selectors[0] === '[data-ask-key]');
    expect(key).toBeDefined();
    const list = items(values(key!.body, 'transition')[0]);
    const timing = (p: string) => list.find((i) => i.startsWith(`${p} `))?.slice(p.length + 1);
    expect(timing('color')).toBeDefined();
    expect(timing('color')).toBe(timing('--ask-key-fill'));
    // Every duration or curve list that re-times the key names one per property.
    for (const r of all.filter((r) => r.selectors.some((s) => s.endsWith('[data-ask-key]')))) {
      for (const prop of ['transition-duration', 'transition-timing-function']) {
        for (const v of values(r.body, prop)) expect(items(v), `${prop} in ${r.selectors.join(', ')}`).toHaveLength(list.length);
      }
    }
  });

  // The well popped: on the settle curve (--ease-out-soft) it was three
  // quarters there by its second frame, at any duration. It fades up now, on a
  // curve that spreads its travel, and goes back a little quicker; the light
  // runs round the rim on the same timing, so the two read as one gesture.
  // Keyboard focus brings only its focus line promptly, so a pointer on a
  // focused key still sees the card fade, and a press with no hover first
  // brings the card with the key's sink.
  it('fades the well up under the pointer where you can see it, and back a little quicker, with the light in step', () => {
    const css = stripComments(read('app/globals.css'));
    const all = rules(stripComments(askBlock()));
    const find = (sel: string) => {
      const r = all.find((x) => x.selectors.length === 1 && x.selectors[0] === sel);
      expect(r, sel).toBeDefined();
      return r!;
    };
    const ms = (v: string) => {
      const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(v.trim());
      expect(m, `a duration, not ${v}`).not.toBeNull();
      return Number(m![1]) * (m![2] === 's' ? 1000 : 1);
    };
    /** A shorthand list as {property: [duration, curve]}, each item one time (no delay). */
    const timings = (r: Rule) => {
      const out: Record<string, [number, string]> = {};
      for (const item of items(values(r.body, 'transition')[0])) {
        const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(item)!;
        expect(item.match(/\b\d+(?:\.\d+)?m?s\b/g), `${item}: one time, no delay`).toHaveLength(1);
        out[m[1]] = [ms(m[2]), m[3]];
      }
      return out;
    };
    /** A rule's transition-duration list, one per item. */
    const durations = (r: Rule) => items(values(r.body, 'transition-duration').at(-1)!).map(ms);
    /** A curve token's progress at x, solved from its control points. */
    const progress = (curve: string) => {
      const name = /^var\((--ease-[\w-]+)\)$/.exec(curve)?.[1];
      expect(name, `${curve} is a shared curve token`).toBeDefined();
      const def = new RegExp(`${name}:\\s*cubic-bezier\\(([^)]+)\\)`).exec(css);
      expect(def, `${name} is defined`).not.toBeNull();
      const [x1, y1, x2, y2] = def![1].split(',').map(Number);
      const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
      const f = (x: number) => {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 60; i++) {
          const t = (lo + hi) / 2;
          if (at(x1, x2, t) < x) lo = t;
          else hi = t;
        }
        return at(y1, y2, (lo + hi) / 2);
      };
      return { f, startSpeed: x1 > 0 ? y1 / x1 : Infinity };
    };

    const well = timings(find('[data-ask-opener]::before'));
    const props = ['background-color', 'box-shadow', 'transform'];
    expect(Object.keys(well).sort()).toEqual([...props].sort());
    const [out, curve] = well['background-color'];
    for (const p of props) expect(well[p], p).toEqual([out, curve]);

    // In: long enough to watch, inside the block's 300ms, and longer than out.
    const hover = find('[data-ask-opener]:hover::before');
    const [enter] = durations(hover);
    expect(new Set(durations(hover))).toEqual(new Set([enter]));
    expect(enter).toBeGreaterThanOrEqual(200);
    expect(enter).toBeLessThanOrEqual(300);
    expect(out).toBeLessThan(enter);
    expect(values(hover.body, 'transition-timing-function'), 'the way in keeps the curve').toHaveLength(0);

    // The curve spreads its travel and still moves on the first frame: never
    // the settle curve, no ease-in, under 60% by a quarter of the run (the
    // settle curve is 76%), and 90% there by three quarters, so it lands.
    expect(curve).not.toBe('var(--ease-out-soft)');
    const { f, startSpeed } = progress(curve);
    expect(progress('var(--ease-out-soft)').f(0.25)).toBeGreaterThan(0.75);
    expect(startSpeed, 'moves at least at linear speed from the first frame').toBeGreaterThanOrEqual(1);
    expect(f(0.25)).toBeLessThan(0.6);
    expect(f(0.75)).toBeGreaterThan(0.9);
    // And nothing holds it back.
    expect(stripComments(askBlock())).not.toMatch(/transition-delay\s*:/);

    // The light travels with the well, both ways; the chord brightens with it.
    const key = find('[data-ask-key]');
    const keyList = items(values(key.body, 'transition')[0]);
    const rim = ['--ask-key-hold', '--ask-key-tail', '--ask-key-reach'];
    const keyTimings = timings(key);
    for (const p of rim) expect(keyTimings[p], p).toEqual([out, curve]);
    const keyHover = durations(find('[data-ask-opener]:hover [data-ask-key]'));
    expect(keyHover).toHaveLength(keyList.length);
    rim.forEach((p) => expect(keyHover[keyList.findIndex((i) => i.startsWith(`${p} `))], p).toBe(enter));
    expect(timings(find('[data-ask-opener-chord]')).color).toEqual([out, curve]);
    expect(durations(find('[data-ask-opener]:hover [data-ask-opener-chord]'))).toEqual([enter]);

    // The key alone has no well: its hover fill is one, so the fill and the
    // colour that keeps pace with it take the well's timing both ways, with
    // the light. Both rules stand aside while pressed, so a press keeps the
    // key's own lists; the lift and the shadow keep the key's settle.
    const at = (p: string) => keyList.findIndex((i) => i.startsWith(`${p} `));
    const curves = (r: Rule) => items(values(r.body, 'transition-timing-function').at(-1)!);
    const iconRestSel = "[data-ask-opener][data-form='icon']:not(:active) [data-ask-key]";
    const iconHoverSel = "[data-ask-opener][data-form='icon']:hover:not(:active) [data-ask-key]";
    const iconRest = find(iconRestSel);
    const iconHover = find(iconHoverSel);
    for (const p of [...rim, '--ask-key-fill', 'color']) {
      expect(durations(iconRest)[at(p)], `${p}, the key alone's way back`).toBe(out);
      expect(curves(iconRest)[at(p)], `${p}, the key alone's curve`).toBe(curve);
      expect(durations(iconHover)[at(p)], `${p}, the key alone's way in`).toBe(enter);
    }
    for (const p of ['box-shadow', 'translate']) {
      expect(durations(iconRest)[at(p)], p).toBe(keyTimings[p][0]);
      expect(curves(iconRest)[at(p)], p).toBe(keyTimings[p][1]);
      expect(durations(iconHover)[at(p)], p).toBe(keyTimings[p][0]);
    }
    expect(values(iconHover.body, 'transition-timing-function'), 'the way in keeps the curve').toHaveLength(0);
    expect(beats(iconHover, iconHoverSel, iconRest, iconRestSel)).toBe(true);

    // Keyboard focus never paints the card, only the focus line and the
    // well's opening, which come with the ring on the key's 1px sink's
    // duration and curve; the card's colour keeps the fade, so a pointer on a
    // focused key sees it fade in and out as anywhere. A press brings all
    // three on the sink's timing (a tap or Space: the card with the sink),
    // and wins over every other timing of the well while it holds.
    const press = find('[data-ask-opener]:active [data-ask-key]');
    const sink = durations(press)[at('translate')];
    const sinkCurve = keyTimings.translate[1];
    const wellProps = items(values(find('[data-ask-opener]::before').body, 'transition')[0]).map((i) => i.split(/\s+/)[0]);
    const byProp = <T,>(bg: T, rest: T) => wellProps.map((p) => (p === 'background-color' ? bg : rest));
    const timed = (sel: string) => {
      const r = all.find((x) => x.selectors.length === 1 && x.selectors[0] === sel && values(x.body, 'transition-duration').length);
      expect(r, `${sel}, timed`).toBeDefined();
      return r!;
    };
    const focusSel = '[data-ask-opener]:focus-visible::before';
    const focusHoverSel = '[data-ask-opener]:focus-visible:hover:not(:active)::before';
    const pressSel = '[data-ask-opener]:active::before';
    const focus = timed(focusSel);
    const focusHover = timed(focusHoverSel);
    const pressWell = timed(pressSel);
    expect(durations(focus)).toEqual(byProp(out, sink));
    expect(curves(focus)).toEqual(byProp(curve, sinkCurve));
    expect(durations(focusHover)).toEqual(byProp(enter, sink));
    expect(values(focusHover.body, 'transition-timing-function'), "the focused hover keeps focus's curves").toHaveLength(0);
    expect(beats(focusHover, focusHoverSel, focus, focusSel)).toBe(true);
    expect(beats(focusHover, focusHoverSel, hover, '[data-ask-opener]:hover::before')).toBe(true);
    expect(new Set(durations(pressWell))).toEqual(new Set([sink]));
    expect(curves(pressWell)).toEqual([sinkCurve]);
    for (const r of all) {
      if (r === pressWell || /!important/.test(r.body) || !/(?:^|[\s;{])transition(?:-duration|-timing-function)?\s*:/.test(r.body)) continue;
      for (const s of r.selectors) {
        if (!s.endsWith('::before') || s.includes(':not(:active)')) continue;
        expect(beats(pressWell, pressSel, r, s), `${s} outranks the press's timing`).toBe(true);
      }
    }
    // The chord brightens with the focus line, or with the press, on the sink's timing.
    const chordSel = '[data-ask-opener]:is(:focus-visible, :active) [data-ask-opener-chord]';
    const chord = find(chordSel);
    expect(durations(chord)).toEqual([sink]);
    expect(curves(chord)).toEqual([sinkCurve]);
    expect(beats(chord, chordSel, find('[data-ask-opener]:hover [data-ask-opener-chord]'), '[data-ask-opener]:hover [data-ask-opener-chord]')).toBe(true);
    // The plain and masthead headers repaint the well as a wash, on its timing.
    for (const r of all) {
      if (!r.selectors.some((s) => /data-layout-header/.test(s) && s.endsWith('::before'))) continue;
      expect(r.body, r.selectors.join(', ')).not.toMatch(/transition/);
    }
  });

  it('lights up on hover for a pointer only, so a tap never leaves it lit', () => {
    const block = stripComments(askBlock());
    const guarded = mediaBlocks(block, '(hover: hover)');
    expect(guarded.length).toBeGreaterThan(0);
    let at = block.indexOf(':hover');
    expect(at).toBeGreaterThan(-1);
    while (at !== -1) {
      const spot = at;
      expect(guarded.some(([a, b]) => a < spot && spot < b), `an unguarded :hover at ${block.slice(spot - 60, spot + 10)}`).toBe(true);
      at = block.indexOf(':hover', at + 1);
    }
  });

  it("joins the theme swap's window with its fill and rim, adding to the window's list and dropping nothing", () => {
    const css = stripComments(read('app/globals.css'));
    const global = css.match(/:root\[data-theme-changing\] \*::after \{\s*transition-property:\s*([^!]+)!important/);
    expect(global).not.toBeNull();
    const granted = items(global![1].trim());
    const block = stripComments(askBlock());
    const motion = mediaBlocks(block, '(prefers-reduced-motion: no-preference)');
    expect(motion).toHaveLength(1);
    const body = block.slice(...motion[0]);
    const list = (sel: string) => {
      const m = body.match(new RegExp(`${sel.replace(/[[\]]/g, '\\$&')} \\{\\s*transition-property:\\s*([^!]+)!important`));
      expect(m, `${sel} in the theme swap's window`).not.toBeNull();
      return items(m![1].trim());
    };
    const key = list(':root[data-theme-changing] [data-ask-key]');
    const plate = list(':root[data-theme-changing] [data-ask-opener]');
    expect(key).toContain('--ask-key-fill');
    for (const rim of ['--ask-key-accent', '--ask-key-pair', '--ask-key-rim']) expect(plate).toContain(rim);
    for (const p of granted) {
      expect(key).toContain(p);
      expect(plate).toContain(p);
    }
    // Nothing that is not a colour sneaks in: no layout, transform or opacity.
    for (const p of [...key, ...plate]) expect(p).toMatch(/^(--ask-key-(fill|accent|pair|rim)|background-color|border-color|color|fill|stroke|text-decoration-color|box-shadow)$/);
  });

  it("focuses with the app's 2px full-strength ring, on the plate or, alone, on the key", () => {
    const block = stripComments(askBlock());
    expect(block).toMatch(/\[data-ask-opener\]:focus-visible \{\s*outline: 2px solid var\(--ring\);/);
    expect(block).toMatch(
      /\[data-ask-opener\]\[data-form='icon'\]:focus-visible \[data-ask-key\] \{[^}]*outline: 2px solid var\(--ring\);/
    );
    // Never the base layer's faded ring.
    expect(block).not.toMatch(/ring\/|color-mix\([^)]*--ring/);
  });

  // The key alone wears its ring on the key, and ring and line read as one:
  // the rim stops being the light and becomes the line (--success-text in
  // light, the ring's colour in dark, where the outline steps 1px in over it).
  it('focuses the key alone with its rim as the line: the plate drops its outline, and nothing outranks the rim', () => {
    const all = rules(stripComments(askBlock()));
    const find = (sel: string) => {
      const r = all.find((x) => x.selectors.includes(sel));
      expect(r, sel).toBeDefined();
      return r!;
    };
    const decl = (r: Rule, prop: string) => values(r.body, prop).at(-1);
    expect(decl(find("[data-ask-opener][data-form='icon']:focus-visible"), 'outline')).toBe('none');
    const keySel = "[data-ask-opener][data-form='icon']:focus-visible [data-ask-key]";
    const key = find(keySel);
    for (const p of ['--ask-key-accent', '--ask-key-pair', '--ask-key-rim']) expect(decl(key, p), p).toBe('var(--ask-focus-rim)');
    expect(decl(key, 'outline')).toBe('2px solid var(--ring)');
    expect(decl(key, 'outline-offset')).toBe('var(--ask-focus-rim-offset)');
    // The line's colour and the outline's step, per mode.
    const light = find('[data-ask-opener]');
    const dark = find('.dark [data-ask-opener]');
    expect(decl(light, '--ask-focus-rim')).toBe('var(--success-text)');
    expect(decl(light, '--ask-focus-rim-offset')).toBe('0px');
    expect(decl(dark, '--ask-focus-rim')).toBe('var(--ring)');
    expect(decl(dark, '--ask-focus-rim-offset')).toBe('-1px');
    // No rule that paints the key's rim on the key alone outranks the focus.
    for (const r of all) {
      if (r === key || !['--ask-key-accent', '--ask-key-pair', '--ask-key-rim'].some((p) => values(r.body, p).length)) continue;
      for (const s of r.selectors) {
        if (!s.endsWith('[data-ask-key]') || s.includes(":not([data-form='icon'])")) continue;
        expect(beats(key, keySel, r, s), `${s} outranks the key alone's focus`).toBe(true);
      }
    }
  });

  // Notepad Retro re-points the accent under whichever look is on, so its
  // partner has to win over every look's, in both modes.
  it("gives Notepad Retro its own partner over every look's, in light and dark", () => {
    const all = rules(stripComments(askBlock()));
    const pairs = all.filter((r) => values(r.body, '--ask-icon-pair').length);
    const retro = pairs.filter((r) => r.selectors.some((s) => s.includes("[data-layout-skin='retro']")));
    const looks = pairs.filter((r) => r.selectors.some((s) => /\[data-look-(?:light|dark)=/.test(s)));
    expect(looks.length).toBeGreaterThanOrEqual(4);
    for (const mode of [':root:not(.dark) ', ':root.dark ']) {
      const own = retro.find((r) => r.selectors.every((s) => s.startsWith(mode)));
      expect(own, `a Retro partner under ${mode.trim()}`).toBeDefined();
      for (const s of own!.selectors) {
        for (const look of looks) {
          for (const ls of look.selectors) expect(beats(own!, s, look, ls), `${s} loses to ${ls}`).toBe(true);
        }
      }
    }
  });

  // The plain and masthead headers take the capsule's material away, so the
  // whole key is drawn on the page: the page's colour (Notebook's page in the
  // masthead) and a 1px --input lip, at rest and pressed. The whole key is
  // the same with its chord or without, so these name every form but the key
  // alone.
  it('draws the whole key on the page in the plain and masthead headers, at rest and pressed', () => {
    const all = rules(stripComments(askBlock()));
    const fill = (r: Rule) => values(r.body, '--ask-key-fill').at(-1);
    const find = (sel: string) => {
      const r = all.find((x) => x.selectors.includes(sel));
      expect(r, sel).toBeDefined();
      return r!;
    };
    const DRAWN = ":is([data-layout-header='plain'], [data-layout-header='masthead'])";
    const WHOLE = ":not([data-form='icon'])";
    const plainRest = `${DRAWN} [data-ask-opener]${WHOLE} [data-ask-key]`;
    const mastRest = `[data-layout-header='masthead'] [data-ask-opener]${WHOLE} [data-ask-key]`;
    const plainPressed = `${DRAWN} [data-ask-opener]${WHOLE}:active [data-ask-key]`;
    const mastPressed = `[data-layout-header='masthead'] [data-ask-opener]${WHOLE}:active [data-ask-key]`;
    expect(fill(find(plainRest))).toBe('var(--canvas)');
    expect(values(find(plainRest).body, 'box-shadow').at(-1)).toBe('inset 0 -1px 0 0 var(--input)');
    expect(fill(find(mastRest))).toBe('var(--nb-page, var(--canvas))');
    expect(fill(find(plainPressed))).toBe('var(--canvas)');
    expect(fill(find(mastPressed))).toBe('var(--nb-page, var(--canvas))');
    // Each wins over the raised key's fill in the same state.
    const raisedRest = find('[data-ask-key]');
    const raisedPressed = find('[data-ask-opener]:active [data-ask-key]');
    expect(beats(find(plainRest), plainRest, raisedRest, '[data-ask-key]')).toBe(true);
    expect(beats(find(mastRest), mastRest, find(plainRest), plainRest)).toBe(true);
    expect(beats(find(plainPressed), plainPressed, raisedPressed, '[data-ask-opener]:active [data-ask-key]')).toBe(true);
    expect(beats(find(mastPressed), mastPressed, find(plainPressed), plainPressed)).toBe(true);
  });

  // The key without its chord ('key') is the whole key's paint less the
  // chord, which is its own element: a rule scoped to 'full' would leave it
  // half dressed (the raised key's fill on Notebook's page, no lip).
  it('paints the key without its chord as the whole key: no rule names the full form alone', () => {
    const all = rules(stripComments(askBlock()));
    const selectors = all.flatMap((r) => r.selectors);
    for (const s of selectors) expect(s, s).not.toMatch(/\[data-form='(?:full|key)'\]/);
    // Every form rule is the key alone's, or the whole key's in every form.
    const forms = selectors.filter((s) => s.includes('data-form'));
    expect(forms.length).toBeGreaterThan(0);
    for (const s of forms) expect(s, s).toMatch(/\[data-form='icon'\]/);
    expect(forms.filter((s) => s.includes(":not([data-form='icon'])")).length).toBeGreaterThanOrEqual(6);
  });

  // In light the ring carries a 1px --success-text line inside it, so the pair
  // reads at 3:1 on paper (the lime ring alone is 1.4:1). The plain and
  // masthead headers' wash took it away from a focused key under the pointer
  // or pressed: their ::before rules outranked the focus line's.
  it("keeps the focus line inside the ring while a focused key is hovered or pressed, in every header", () => {
    // The specificity reader, against the selectors it judges.
    expect(specificity("[data-ask-opener]:focus-visible::before")).toEqual([0, 2, 1]);
    expect(specificity(":is([data-layout-header='plain'], [data-layout-header='masthead']) [data-ask-opener]:hover::before")).toEqual([0, 3, 1]);
    expect(specificity(":root:not(.dark) [data-layout-skin='retro'] :is([data-ask-opener], [data-ask-mark])")).toEqual([0, 4, 0]);
    expect(specificity(':where(.a) b')).toEqual([0, 0, 1]);

    const all = rules(stripComments(askBlock()));
    const line = /^inset 0 0 0 1px var\(--ask-focus-line\)$/;
    const focusLines = all.filter((r) => values(r.body, 'box-shadow').some((v) => line.test(v)));
    expect(focusLines.length).toBeGreaterThan(0);
    const scope = (s: string) => s.slice(0, s.indexOf('[data-ask-opener]'));
    let judged = 0;
    for (const r of all) {
      if (!values(r.body, 'box-shadow').length) continue;
      for (const s of r.selectors) {
        // A well under a hovered or pressed key, which a focused key can also be.
        if (!/::before$/.test(s) || !/:(hover|active)\b/.test(s) || /:focus-visible/.test(s)) continue;
        judged++;
        const kept = focusLines.some((f) =>
          f.selectors.some(
            (fs) =>
              /:focus-visible::before$/.test(fs) &&
              // Unscoped, or scoped to the same headers as the well.
              (scope(fs) === '' || scope(fs) === scope(s)) &&
              beats(f, fs, r, s)
          )
        );
        expect(kept, `the focus line loses to ${s}`).toBe(true);
      }
    }
    expect(judged).toBeGreaterThanOrEqual(4);
  });

  // The design's docked key took the page's --input edge in these headers, as
  // the whole key did. Scoped to the whole key only, the key alone's edge away
  // from the light read as the raised key's faint 9% mix on paper.
  it("draws the page's --input hairline under the light in the plain and masthead headers, whole or alone, in light only", () => {
    const all = rules(stripComments(askBlock()));
    const onInput = all.filter((r) => values(r.body, '--ask-key-rim').some((v) => /--input\b/.test(v)));
    const selectors = onInput.flatMap((r) => r.selectors);
    expect(
      selectors.some(
        (s) => s.includes("[data-layout-header='plain']") && s.includes("[data-layout-header='masthead']") && !s.includes('data-form')
      ),
      'one rule, for both forms, in both headers'
    ).toBe(true);
    // Never in dark, where --input is translucent: the partner's steps mix
    // into the rim, and must stay solid colours there too.
    for (const s of selectors) expect(s).toMatch(/^:root:not\(\.dark\) /);
    const dark = all.filter((r) => r.selectors.some((s) => /(?<!:not\()\.dark\b/.test(s)));
    const darkRims = dark.flatMap((r) => values(r.body, '--ask-key-rim'));
    expect(darkRims.length).toBeGreaterThan(0);
    for (const v of darkRims) {
      expect(v).toMatch(/^color-mix\(in oklab, var\(--[\w-]+(?:, var\(--[\w-]+\))?\), var\(--foreground\) \d+%\)$/);
    }
  });
});
