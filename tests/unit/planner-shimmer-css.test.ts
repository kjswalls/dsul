import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNC_LINE_DELAY_MS } from '@/components/shell/planner-sync-line';
import {
  AWAY_ATTR,
  INK_CURVE,
  MUTE_ANIMATION,
  RISE_ANIMATION,
  SHIMMER,
  SHIMMER_ATTR,
  SWEEP_ANIMATION,
  SYNC_BAR_ANIMATION,
} from '@/lib/planner-shimmer';
import { DARK_LOOKS, DEFAULT_DARK_LOOK, DEFAULT_LIGHT_LOOK, LIGHT_LOOKS } from '@/lib/theme-looks';

/**
 * The look-only preview's waiting shimmer CSS (app/globals.css, "Planner
 * preview: waiting shimmer"; lib/planner-shimmer.ts). Read as text, the way
 * planner-preview-css.test.ts and week-column-hover.test.tsx read theirs.
 *
 * It is the second thing in the app allowed to dim while nothing is wrong
 * (Kirby's ask, 2026-10-07), so its reach is locked here:
 *
 *  - Only a row title's TEXT: every rule that paints lands on
 *    [data-row-title='open'], under a preview root (wait) or a settle scope
 *    (land, ease). Never a container, never an opacity, never lime. The one
 *    rule under a title gives its emoji their own fill back.
 *  - Nothing at all through the 300ms delay, and nothing when it ends: the
 *    mute starts from plain text, and every rise ends on it.
 *  - Off under both reduced-motion vetoes and forced colours, by the media
 *    query and the app's own switch on every rule.
 *  - Three passes, then still. One period, one start, shared with the sync
 *    line's bar. Every number matches the module's.
 */

const BANNER = '/* ── Planner preview: waiting shimmer';

const src = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
const start = src.indexOf(BANNER);
const end = src.indexOf('/* ──', start + BANNER.length);
const section = src.slice(start, end);
/** The section with its comments removed, so prose can't satisfy or trip a rule check. */
const rules = section.replace(/\/\*[\s\S]*?\*\//g, '');

const syncStart = src.indexOf('/* ── Planner preview: sync line');
const syncRules = src.slice(syncStart, start).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { declarations }` pair, nested @media bodies included, with the media query it sits in. */
function ruleBlocks(css: string): { selector: string; body: string; media: string | null }[] {
  const out: { selector: string; body: string; media: string | null }[] = [];
  let media: string | null = null;
  let depth = 0;
  let mediaDepth = -1;
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      depth -= 1;
      if (depth === mediaDepth) {
        media = null;
        mediaDepth = -1;
      }
      i = close + 1;
      continue;
    }
    const head = css.slice(i, open).trim();
    if (head.startsWith('@media')) {
      media = head;
      mediaDepth = depth;
      depth += 1;
      i = open + 1;
      continue;
    }
    if (head.startsWith('@keyframes')) {
      // Skip the whole keyframes block.
      let d = 1;
      let j = open + 1;
      while (d > 0 && j < css.length) {
        if (css[j] === '{') d += 1;
        else if (css[j] === '}') d -= 1;
        j += 1;
      }
      i = j;
      continue;
    }
    const bodyEnd = css.indexOf('}', open);
    out.push({ selector: head.replace(/\s+/g, ' '), body: css.slice(open + 1, bodyEnd), media });
    i = bodyEnd + 1;
  }
  return out;
}

/** A selector list split at its top-level commas (an :is() list stays whole). */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out;
}

function keyframes(css: string, name: string): string {
  const at = css.indexOf(`@keyframes ${name} {`);
  expect(at, `@keyframes ${name}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('\n}', at) + 2);
}

const blocks = ruleBlocks(rules);
/** The rules that touch a title: everything but the level, band and period tokens. */
const titleRules = blocks.filter((b) => b.selector.includes('data-row-title'));
const tokenRules = blocks.filter((b) => !b.selector.includes('data-row-title'));
/** The rules that paint a title, and the one that keeps its emoji out of the paint. */
const paintRules = titleRules.filter((b) => !b.selector.includes('data-row-emoji'));
const emojiRules = titleRules.filter((b) => b.selector.includes('data-row-emoji'));

/** One keyframe block's declarations, by its selector (`from`, `50%`, ...). */
function frame(css: string, name: string, at: string): Record<string, string> {
  const body = keyframes(css, name);
  const m = new RegExp(`\\n\\s*${at.replace('.', '\\.')} \\{([^}]*)\\}`).exec(body);
  expect(m, `${name} ${at}`).not.toBeNull();
  return Object.fromEntries(
    m![1]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
  );
}

/** A cubic-bezier split at its parameter midpoint (de Casteljau), each half rescaled to the unit square. */
function halves([x1, y1, x2, y2]: number[]): [number[], number[]] {
  const mid = (a: number, b: number) => (a + b) / 2;
  const p01 = [mid(0, x1), mid(0, y1)];
  const p12 = [mid(x1, x2), mid(y1, y2)];
  const p23 = [mid(x2, 1), mid(y2, 1)];
  const a = [mid(p01[0], p12[0]), mid(p01[1], p12[1])];
  const b = [mid(p12[0], p23[0]), mid(p12[1], p23[1])];
  const m = [mid(a[0], b[0]), mid(a[1], b[1])];
  const left = [p01[0] / m[0], p01[1] / m[1], a[0] / m[0], a[1] / m[1]];
  const right = [(b[0] - m[0]) / (1 - m[0]), (b[1] - m[1]) / (1 - m[1]), (p23[0] - m[0]) / (1 - m[0]), (p23[1] - m[1]) / (1 - m[1])];
  return [left, right];
}
const bezier = (v: string) => /^cubic-bezier\(([^)]*)\)$/.exec(v)![1].split(',').map(Number);

describe('the waiting shimmer CSS section', () => {
  it('sits under its own banner after the sync line and before the Zen room', () => {
    expect(start, 'the banner is gone').toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(syncStart);
    expect(end).toBe(src.indexOf('/* ── Zen room'));
    // Guard the guard: the section holds its rules.
    expect(titleRules.length).toBeGreaterThanOrEqual(4);
  });

  it('declares no transition', () => {
    expect(rules).not.toMatch(/(^|[\s;{])transition[a-z-]*\s*:/m);
  });

  it('paints only an open row title, under the phase attribute and the app’s motion switch', () => {
    for (const { selector } of paintRules) {
      for (const one of selectors(selector)) {
        // The phase, on the root, with the app's animations switch.
        expect(one, one).toMatch(
          new RegExp(`^:root\\[${SHIMMER_ATTR}='(wait|land|ease)'\\]:not\\(\\[data-reduce-motion='true'\\]\\)\\s`)
        );
        // The subject is the title itself: nothing after it but its own away state.
        expect(one, one).toMatch(new RegExp(`\\[data-row-title='open'\\](:not\\(\\[${AWAY_ATTR}\\]\\)|\\[${AWAY_ATTR}\\])?$`));
        // Waiting is scoped to a preview root; the landing to the canvas and braindump scopes.
        if (one.includes("='wait'")) expect(one, one).toContain("[data-preview='true'] [data-row-title='open']");
        else expect(one, one).toMatch(/:is\(\[data-settle-scope='canvas'\], \[data-settle-scope='braindump'\]\)\s+\[data-row-title='open'\]/);
      }
    }
  });

  it('never touches a muted title', () => {
    expect(rules).not.toContain("data-row-title='muted'");
  });

  it('gives an emoji inside a waiting title its own fill back, and does nothing else', () => {
    // Through a clipped ground a colour glyph is only a mask: a flat silhouette.
    expect(emojiRules).toHaveLength(1);
    const [{ selector, body }] = emojiRules;
    expect(selector).toBe(
      `:root[${SHIMMER_ATTR}]:not([data-reduce-motion='true']) [data-row-title='open'] [data-row-emoji]`
    );
    expect(body.trim()).toBe('-webkit-text-fill-color: currentColor;');
  });

  it('is off under the OS reduced-motion setting and forced colours: every title rule sits in the media query', () => {
    for (const { selector, media } of titleRules) {
      expect(media, selector).toBe('@media (prefers-reduced-motion: no-preference) and (forced-colors: none)');
    }
    // Tokens only outside it.
    for (const { selector, body, media } of tokenRules) {
      expect(media, selector).toBeNull();
      for (const decl of body.split(';').map((d) => d.trim()).filter(Boolean)) {
        expect(decl, selector).toMatch(/^--planner-shimmer-(level|band|period):/);
      }
    }
  });

  it('never dims through an opacity, a filter or a blend, and moves nothing', () => {
    expect(rules).not.toMatch(/(^|[\s;{])(opacity|filter|mix-blend-mode|transform|visibility)\s*:/m);
  });

  it('never names lime, primary, success or the accent ramp', () => {
    expect(rules).not.toMatch(/--primary|--success|--accent|lime|--ring|--chart/);
    // Its inks are the neutral ones.
    expect(rules).toContain('var(--foreground)');
    expect(rules).toContain('var(--muted-foreground)');
  });

  it('draws the ink as the title’s own background clipped to its glyphs', () => {
    const paint = titleRules.find((r) => r.body.includes('background-clip: text'));
    expect(paint, 'the shared paint rule').toBeDefined();
    expect(paint!.body).toMatch(/-webkit-background-clip:\s*text;/);
    expect(paint!.body).toMatch(/-webkit-text-fill-color:\s*transparent;/);
    expect(paint!.body).toMatch(
      /--planner-shimmer-ink:\s*color-mix\(in oklab, var\(--foreground\) var\(--planner-shimmer-level\), var\(--muted-foreground\)\);/
    );
    expect(paint!.body).toMatch(/background-color:\s*var\(--planner-shimmer-ink\);/);
    // The band is drawn in the title's own colour, so a rise can carry it down to the ground.
    expect(paint!.body).toMatch(/background-image:\s*var\(--planner-shimmer-light\);/);
    const light = /--planner-shimmer-light:\s*(linear-gradient\([\s\S]*?\));/.exec(paint!.body)?.[1] ?? '';
    expect(light).toContain('currentColor 50%');
    expect(light).not.toContain('var(--foreground)');
    // One band, half-width each side, never repeated.
    expect(paint!.body).toMatch(/background-size:\s*calc\(2 \* var\(--planner-shimmer-band\)\) 100%;/);
    expect(paint!.body).toMatch(/background-repeat:\s*no-repeat;/);
    // All three phases share it.
    expect(selectors(paint!.selector)).toHaveLength(3);
  });

  it('animates the title’s paint and nothing else', () => {
    const allowed: Record<string, string[]> = {
      [MUTE_ANIMATION]: ['background-color', '-webkit-text-fill-color'],
      [SWEEP_ANIMATION]: ['background-position-x'],
      [RISE_ANIMATION]: ['background-color', 'background-image', '-webkit-text-fill-color', 'color', 'animation-timing-function'],
    };
    for (const [name, props] of Object.entries(allowed)) {
      const body = keyframes(rules, name);
      const used = [...body.matchAll(/(-?[a-z-]+)\s*:/g)].map((p) => p[1]);
      expect(used.length, name).toBeGreaterThan(0);
      for (const p of used) expect(props, `${name}: ${p}`).toContain(p);
    }
  });

  it('is plain text through the delay, then the clipped ground at full ink easing to the rule’s waiting ink', () => {
    // A warm load that lands inside the 300ms delay sees nothing at all.
    expect(frame(rules, MUTE_ANIMATION, 'from')).toEqual({
      'background-color': 'transparent',
      '-webkit-text-fill-color': 'currentColor',
    });
    expect(frame(rules, MUTE_ANIMATION, '0.01%')).toEqual({
      'background-color': 'var(--foreground)',
      '-webkit-text-fill-color': 'transparent',
    });
    // No `to`: the end is the rule's own waiting ink, so no registered property holds it.
    expect(keyframes(rules, MUTE_ANIMATION)).not.toMatch(/\n\s*(to|100%) \{/);
  });

  it('rises to plain text, swapping its paint at the curve’s midpoint, so the end changes nothing', () => {
    const from = frame(rules, RISE_ANIMATION, 'from');
    const half = frame(rules, RISE_ANIMATION, '50%');
    const swap = frame(rules, RISE_ANIMATION, '50.01%');
    const to = frame(rules, RISE_ANIMATION, 'to');
    expect(from['background-color']).toBe('var(--planner-shimmer-from)');
    expect(from['-webkit-text-fill-color']).toBe('transparent');
    // Up to the midpoint the clipped ground rises and the band (in color) comes down to meet it.
    expect(half).toMatchObject({
      color: 'var(--planner-shimmer-mid)',
      'background-color': 'var(--planner-shimmer-mid)',
      'background-image': 'var(--planner-shimmer-light)',
      '-webkit-text-fill-color': 'transparent',
    });
    // Then plain text of the same colour, which eases to the title's own.
    expect(swap).toMatchObject({
      color: 'var(--planner-shimmer-mid)',
      'background-color': 'transparent',
      'background-image': 'none',
      '-webkit-text-fill-color': 'currentColor',
    });
    expect(to).toEqual({
      'background-color': 'transparent',
      'background-image': 'none',
      '-webkit-text-fill-color': 'currentColor',
    });
    // The two halves of --ease-roll, so the rise is the app's settle curve with its fastest moment at the swap.
    const roll = /--ease-roll:\s*(cubic-bezier\([^)]*\))/.exec(src)![1];
    const [left, right] = halves(bezier(roll));
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));
    close(bezier(from['animation-timing-function']), left);
    close(bezier(swap['animation-timing-function']), right);
    expect(half['animation-timing-function']).toBe('linear');
  });
});

describe('the shimmer’s timing', () => {
  const wait = titleRules.find((r) => r.selector.includes("='wait'") && /animation:\s*planner-shimmer-mute/.test(r.body));
  const away = titleRules.find((r) => r.selector.endsWith(`[${AWAY_ATTR}]`));
  const land = titleRules.find((r) => r.selector.includes("='land'") && r.body.includes('animation'));
  const ease = titleRules.find((r) => r.selector.includes("='ease'") && r.body.includes('animation'));

  it('waits out the sync line’s own delay, then eases the ink down on the module’s curve', () => {
    expect(SHIMMER.delayMs).toBe(SYNC_LINE_DELAY_MS);
    expect(wait, 'the waiting rule').toBeDefined();
    expect(wait!.body).toContain(
      `planner-shimmer-mute ${SHIMMER.inkMs}ms var(--ease-out-soft) ${SHIMMER.delayMs}ms backwards`
    );
    const curve = /--ease-out-soft:\s*cubic-bezier\(([^)]*)\)/.exec(src);
    expect(curve?.[1].split(',').map(Number)).toEqual([...INK_CURVE]);
  });

  it('crosses three times, then stops: the cap', () => {
    expect(SHIMMER.passes).toBe(3);
    expect(wait!.body).toContain(
      `${SWEEP_ANIMATION} var(--planner-shimmer-period) linear ${SHIMMER.delayMs}ms ${SHIMMER.passes} both`
    );
    // Never forever.
    expect(rules).not.toContain('infinite');
  });

  it('runs one period, the module’s', () => {
    const period = /--planner-shimmer-period:\s*([\d.]+)s;/.exec(rules);
    expect(Number(period?.[1]) * 1000).toBe(SHIMMER.periodMs);
  });

  it('scales the band with the viewport', () => {
    expect(rules).toMatch(/--planner-shimmer-band:\s*clamp\(\d+px, \d+vw, \d+px\);/);
  });

  it('holds a title outside the viewport still, at the waiting ink, with no band', () => {
    expect(away, 'the away rule').toBeDefined();
    expect(away!.selector).toContain("='wait'");
    // With no animation the band would sit at position 0, the title's left edge.
    expect(away!.body.replace(/\s+/g, ' ').trim()).toBe('animation: none; background-image: none;');
    // And it sits the landing out.
    expect(land!.selector).toContain(`:not([${AWAY_ATTR}])`);
    expect(ease!.selector).toContain(`:not([${AWAY_ATTR}])`);
  });

  it('lands with the sweep carried on and each title’s rise, on the module’s numbers', () => {
    expect(land!.body).toContain(`${SWEEP_ANIMATION} var(--planner-shimmer-period) linear ${SHIMMER.delayMs}ms ${SHIMMER.passes} both`);
    // No CSS delay on the rise: the module sets each title's from its x. The
    // curve is in the keyframes, and `both` holds the plain text it ends on.
    expect(land!.body).toMatch(new RegExp(`${RISE_ANIMATION} ${SHIMMER.riseMs}ms linear both;`));
    expect(ease!.body).toMatch(new RegExp(`${RISE_ANIMATION} ${SHIMMER.easeMs}ms linear both;`));
    // Nothing static to snap from: the rise owns the paint for the whole landing.
    expect(land!.body).not.toMatch(/background-color\s*:/);
    expect(ease!.body).not.toMatch(/background-color\s*:/);
  });

  it('rises from the depth the ink had reached, full waiting ink by default', () => {
    const paint = titleRules.find((r) => r.body.includes('background-clip: text'))!;
    expect(paint.body).toMatch(
      /--planner-shimmer-from:\s*color-mix\(in oklab, var\(--planner-shimmer-ink\) var\(--planner-shimmer-depth, 100%\), var\(--foreground\)\);/
    );
    expect(paint.body).toMatch(
      /--planner-shimmer-mid:\s*color-mix\(in oklab, var\(--planner-shimmer-from\) 50%, var\(--foreground\)\);/
    );
    // The depth is never a property of the root (see the module's begin()).
    expect(src).not.toMatch(/:root\s*\{[^}]*--planner-shimmer-depth/);
  });

  it('shares its keyframe stops and its start with the sync line’s bar: one clock', () => {
    const stops = (css: string) => [...css.matchAll(/^\s*(\d+%)[,\s]/gm)].map((m) => m[1]);
    const sweep = keyframes(rules, SWEEP_ANIMATION);
    const bar = keyframes(syncRules, SYNC_BAR_ANIMATION);
    expect(stops(sweep)).toEqual(['0%', '14%', '62%', '100%']);
    expect(stops(bar)).toEqual(stops(sweep));
    // The same parked and crossing positions, as a transform on the bar.
    expect(sweep).toContain('calc(-2 * var(--planner-shimmer-band) - var(--planner-shimmer-x, 0px))');
    expect(sweep).toContain('calc(100vw - var(--planner-shimmer-x, 0px))');
    expect(bar).toContain('translateX(calc(-2 * var(--planner-shimmer-band) - var(--planner-shimmer-x, 0px)))');
    expect(bar).toContain('translateX(calc(100vw - var(--planner-shimmer-x, 0px)))');
    expect(syncRules).toMatch(
      new RegExp(`\\.planner-sync-line__bar\\s*\\{[^}]*animation:\\s*${SYNC_BAR_ANIMATION} var\\(--planner-shimmer-period\\) linear ${SHIMMER.delayMs}ms infinite;`)
    );
    expect(syncRules).toMatch(/\.planner-sync-line__bar\s*\{[^}]*width:\s*calc\(2 \* var\(--planner-shimmer-band\)\);/);
  });
});

describe('the shimmer’s contrast floor', () => {
  const level = (selector: string) => {
    const block = tokenRules.find((b) => b.selector === selector);
    expect(block, selector).toBeDefined();
    const m = /--planner-shimmer-level:\s*(\d+)%;/.exec(block!.body);
    expect(m, selector).not.toBeNull();
    return Number(m![1]);
  };

  it('sets a waiting level for every shipped theme, light and dark', () => {
    const levels = [
      level(':root'),
      level('.dark'),
      ...LIGHT_LOOKS.filter((l) => l.value !== DEFAULT_LIGHT_LOOK).map((l) =>
        level(`:root[data-look-light='${l.value}']:not(.dark)`)
      ),
      ...DARK_LOOKS.filter((l) => l.value !== DEFAULT_DARK_LOOK).map((l) =>
        level(`:root[data-look-dark='${l.value}'].dark`)
      ),
    ];
    // Somewhere between the labels' ink and full ink: never the labels', never full.
    for (const v of levels) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(100);
    }
  });
});
