import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Ask key and the AI's mark, held to the shape that makes them safe to
 * look at and safe to swap:
 *
 *  - The mark is ONE component (components/ai/ask-mark.tsx), drawn by the Ask
 *    key and by Ask's header, decorative in both; nothing else knows what it
 *    looks like, so swapping it is a change to that file.
 *  - The key's paint (app/globals.css, "Ask's key") obeys CLAUDE.md's accent
 *    rule with no exception: no opacity, filter, mask or blend anywhere in it,
 *    and the accent is never mixed into anything (only the partner steps
 *    toward the hairline). The mark paints the accent solid too.
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
import { AskMark, ASK_MARK_LIGHT } from '@/components/ai/ask-mark';
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

  it('paints the accent solid and moves only inside the key, briefly, and never under reduced motion', () => {
    const { container } = render(<AskMark />);
    const tiles = Array.from(container.querySelectorAll('rect'));
    expect(tiles).toHaveLength(3);
    const src = read('components/ai/ask-mark.tsx');
    const classes = tiles.map((t) => t.getAttribute('class') ?? '');
    for (const c of classes) {
      // Nothing fades: no opacity, alpha modifier, filter, blend or mask.
      expect(c).not.toMatch(/opacity|blur|drop-shadow|mix-blend|mask|brightness|saturate/);
      expect(c).not.toMatch(/transparent|\)\]\/\d/);
      // Motion: named properties only, short, off under reduced motion.
      expect(c).not.toMatch(/transition-all|\btransition\b(?!-)/);
      if (/transition-\[/.test(c)) {
        expect(c).toMatch(/transition-\[(fill|scale)\]/);
        expect(c).toContain('motion-reduce:transition-none');
      }
      for (const [, ms] of c.matchAll(/(?:duration|delay)-\[(\d+)ms\]/g)) expect(Number(ms)).toBeLessThanOrEqual(300);
      // Engaged only by the key: every state is a group variant on group/ask-key.
      for (const cls of c.split(/\s+/)) {
        if (/(^|:)(hover|focus|focus-visible|active):/.test(cls)) expect(cls).toMatch(/^group-(hover|focus-visible|active)\/ask-key:/);
      }
    }
    // The foot is the accent itself.
    expect(classes[0]).toBe('fill-[var(--ask-icon-accent)]');
    // A mix with the accent in it is a solid blend of two solid tokens.
    for (const [mix] of src.matchAll(/color-mix\((?:[^()]|\([^()]*\))*\)/g)) {
      if (ACCENT.test(mix)) expect(mix).toMatch(/^color-mix\(in_oklch,var\(--ask-icon-accent\),var\(--ask-icon-pair-ink\)_\d+%\)$/);
    }
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

  it('stops every transition under reduced motion', () => {
    const block = stripComments(askBlock());
    const reduce = mediaBlocks(block, '(prefers-reduced-motion: reduce)');
    expect(reduce).toHaveLength(1);
    const body = block.slice(...reduce[0]);
    for (const sel of ['[data-ask-opener]', '[data-ask-opener]::before', '[data-ask-opener] *']) expect(body).toContain(sel);
    expect(body).toMatch(/transition:\s*none !important;/);
    expect(body).toMatch(/animation:\s*none !important;/);
    // And the in-app animations-off setting, which the global rule only clamps (delays survive it).
    expect(block).toMatch(
      /\[data-reduce-motion='true'\] \[data-ask-opener\] \*,[\s\S]*?\{\s*transition: none !important;\s*animation: none !important;/
    );
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
