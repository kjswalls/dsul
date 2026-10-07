import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNC_LINE_SWEEP } from '@/components/shell/planner-sync-line';

/**
 * The look-only preview's sync line CSS (app/globals.css, "Planner preview:
 * sync line"; components/shell/planner-sync-line.tsx). Read as text, the way
 * planner-skeleton.test.tsx and week-column-hover.test.tsx read theirs.
 *
 *  - Its own banner, after `@layer base {` and before the waiting shimmer
 *    (planner-shimmer-css.test.ts), then the Zen room: the skeleton test
 *    treats everything up to the next banner as the skeleton block, and the
 *    week recede region counts its transitions.
 *  - No transitions; both motion vetoes spelled out.
 *  - Never lime: no primary, success, accent or lime token anywhere in it.
 *  - The root's fade-in is never overridden by the done state, so a landing
 *    mid-fade cannot pop the line.
 */

const BANNER = '/* ── Planner preview: sync line';

const src = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
const start = src.indexOf(BANNER);
// The section runs to the next top-of-file banner.
const end = src.indexOf('/* ──', start + BANNER.length);
const section = src.slice(start, end);

/** The section with its comments removed, so prose about lime can't satisfy or trip a rule check. */
const rules = section.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { declarations }` pair in the section, nested @media bodies included. */
function ruleBlocks(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    out.push({ selector: m[1].trim().replace(/^@media[^{]*\{\s*/, ''), body: m[2] });
  }
  return out;
}

describe('the sync line CSS section', () => {
  it('sits under its own banner after `@layer base {`, after the skeleton, before the waiting shimmer', () => {
    expect(start, 'the banner is gone').toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(src.indexOf('@layer base {'));
    expect(start).toBeGreaterThan(src.indexOf('--day-recede:'));
    expect(start).toBeGreaterThan(src.indexOf('@keyframes planner-skeleton-in'));
    expect(end).toBe(src.indexOf('/* ── Planner preview: waiting shimmer'));
    // Guard the guard: the section actually holds the rules.
    expect(rules).toMatch(/\.planner-sync-line\s*\{/);
  });

  it('declares no transition', () => {
    expect(section.length).toBeGreaterThan(500);
    expect(rules).not.toMatch(/(^|[\s;{])transition[a-z-]*\s*:/m);
  });

  it('spells out both motion vetoes for the root and the travelling bar', () => {
    const media = rules.slice(rules.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rules).toContain('@media (prefers-reduced-motion: reduce)');
    expect(media).toMatch(/\.planner-sync-line\s*\{\s*animation:\s*planner-sync-in 1ms steps\(1\) 300ms both;/);
    expect(media).toMatch(/\.planner-sync-line__bar\s*\{\s*animation:\s*none;/);
    expect(rules).toMatch(
      /\[data-reduce-motion='true'\] \.planner-sync-line\s*\{\s*animation:\s*planner-sync-in 1ms steps\(1\) 300ms both;/
    );
    expect(rules).toMatch(/\[data-reduce-motion='true'\] \.planner-sync-line__bar\s*\{\s*animation:\s*none;/);
  });

  it('holds the 300ms delay so a warm load never shows it', () => {
    expect(rules).toMatch(/\.planner-sync-line\s*\{[^}]*animation:\s*planner-sync-in 200ms [^;]* 300ms both;/);
    expect(rules).toMatch(/\.planner-sync-line__bar\s*\{[^}]*animation:\s*planner-sync-travel [^;]* 300ms infinite;/);
  });

  it('never names lime, primary, success or the accent ramp', () => {
    expect(rules).not.toMatch(/--primary|--success|--accent|lime|--ring|--chart/);
    // Its ink is the neutral one.
    expect(rules).toContain('var(--muted-foreground)');
  });

  it("never sets an animation on the done ROOT — only on its track or ::after", () => {
    const done = ruleBlocks(rules).filter((r) => r.selector.includes(".planner-sync-line[data-state='done']"));
    // Guard the guard: the done state is styled at all.
    expect(done.length).toBeGreaterThanOrEqual(2);
    for (const { selector, body } of done) {
      if (!/animation/.test(body)) continue;
      // Each selector in the list must reach past the root: a descendant or a pseudo-element.
      for (const one of selector.split(',').map((s) => s.trim())) {
        expect(one, `"${one}" would cancel the root's fade-in`).toMatch(
          /\.planner-sync-line\[data-state='done'\](\s+\S|::?after)/
        );
      }
    }
  });

  it('plays, on the done ::after, the sweep whose end the component waits for', () => {
    // Renamed on one side only, every done line would end on its backstop
    // clock instead of with its sweep (components/shell/planner-sync-line.tsx).
    expect(rules).toMatch(
      new RegExp(`\\.planner-sync-line\\[data-state='done'\\]::after\\s*\\{\\s*animation:\\s*${SYNC_LINE_SWEEP} `)
    );
    expect(rules).toContain(`@keyframes ${SYNC_LINE_SWEEP} {`);
  });

  it('animates only opacity and transform in its keyframes, and the bar its band — no layout, no colour', () => {
    const frames = [...rules.matchAll(/@keyframes (planner-sync-[a-z-]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(frames.map((f) => f[1]).sort()).toEqual([
      'planner-sync-done',
      'planner-sync-in',
      'planner-sync-track-out',
      'planner-sync-travel',
    ]);
    for (const [, name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      expect(props.length, name).toBeGreaterThan(0);
      // The travelling bar is the waiting shimmer's band, painted as the titles
      // paint theirs (a background-position on a 2px line), so the two are drawn
      // in the same frame: a transform on the compositor ran a frame ahead.
      const allowed = name === 'planner-sync-travel' ? ['background-position-x'] : ['opacity', 'transform'];
      for (const p of props) expect(allowed, `${name}: ${p}`).toContain(p);
    }
  });
});
