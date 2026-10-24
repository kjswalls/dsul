import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SYNC_SHEEN_ATTR,
  SYNC_SHEEN_MS,
  SYNC_SHEEN_RETRY_MS,
  agentKey,
  itemKey,
  noteKey,
  syncSheen,
  targetsFor,
} from '@/lib/sync-sheen';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Two frames and a beat: the module looks once React has drawn. */
const settle = () => wait(60);

beforeEach(() => {
  document.body.innerHTML = `
    <div data-item-id="a">
      <p data-row-title="open">Call Sam</p>
      <div data-item-id="b"><p data-row-title="open">Nested task</p></div>
    </div>
    <span data-sync-key="agent:a">Queued · 6h</span>
    <span data-sync-key="item:a">Call Sam</span>
    <p data-sync-key="note:n1">A note</p>
    <span data-sync-key="conv:c1"><mark>Sam</mark> plan</span>
  `;
});

afterEach(() => {
  document.documentElement.removeAttribute('data-reduce-motion');
  document.documentElement.removeAttribute('data-planner-shimmer');
});

describe('targetsFor', () => {
  it("finds an item's row title by its row, not a nested row's, and its keyed text", () => {
    const found = targetsFor(itemKey('a')).map((el) => el.textContent);
    expect(found).toEqual(['Call Sam', 'Call Sam']);
    expect(targetsFor(itemKey('b')).map((el) => el.textContent)).toEqual(['Nested task']);
  });

  it('finds keyed text by its key alone', () => {
    expect(targetsFor(agentKey('a')).map((el) => el.textContent)).toEqual(['Queued · 6h']);
    expect(targetsFor(noteKey('n1'))).toHaveLength(1);
    expect(targetsFor(noteKey('nope'))).toHaveLength(0);
  });
});

describe('syncSheen', () => {
  it('marks every target once drawn, and lets each go after the pass', async () => {
    syncSheen([itemKey('a'), noteKey('n1')]);
    // Never in the same frame as the store's set(): the words are not drawn yet.
    expect(document.querySelectorAll(`[${SYNC_SHEEN_ATTR}]`)).toHaveLength(0);
    await settle();
    expect(document.querySelectorAll(`[${SYNC_SHEEN_ATTR}]`)).toHaveLength(3);
    // jsdom runs no animation, so the backstop takes the attribute off.
    await wait(SYNC_SHEEN_MS + 250);
    expect(document.querySelectorAll(`[${SYNC_SHEEN_ATTR}]`)).toHaveLength(0);
  });

  it('looks once more for a key with nothing on screen yet', async () => {
    syncSheen([noteKey('late')]);
    await settle();
    const p = document.createElement('p');
    p.setAttribute('data-sync-key', 'note:late');
    document.body.append(p);
    await wait(SYNC_SHEEN_RETRY_MS);
    expect(p.hasAttribute(SYNC_SHEEN_ATTR)).toBe(true);
  });

  it('leaves a search hit alone: its <mark> would vanish through the clip', async () => {
    syncSheen(['conv:c1']);
    await settle();
    expect(document.querySelector('[data-sync-key="conv:c1"]')!.hasAttribute(SYNC_SHEEN_ATTR)).toBe(false);
  });

  it("does nothing under the app's animations switch or the load's own shimmer", async () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    syncSheen([noteKey('n1')]);
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.setAttribute('data-planner-shimmer', 'wait');
    syncSheen([agentKey('a')]);
    await settle();
    expect(document.querySelectorAll(`[${SYNC_SHEEN_ATTR}]`)).toHaveLength(0);
  });
});

describe('the CSS', () => {
  const css = readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8');
  const section = css.slice(css.indexOf('/* ── Sync sheen'), css.indexOf('/* ── Drop targets'));
  /** The rules alone, for what must never be in them (the banner may name it). */
  const rules = section.replace(/\/\*[\s\S]*?\*\//g, '');

  it('runs the pass for as long as the module waits for it', () => {
    expect(section).toContain(`--sync-sheen-ms: ${SYNC_SHEEN_MS}ms;`);
  });

  it('is gated on both motion vetoes, forced colours and the load shimmer, and never transitions', () => {
    expect(section).toContain('@media (prefers-reduced-motion: no-preference) and (forced-colors: none)');
    expect(section).toContain(":root:not([data-reduce-motion='true']):not([data-planner-shimmer]) [data-sync-sheen]");
    expect(rules).not.toMatch(/transition/);
  });

  it('dims with the text’s own colour, never the accent', () => {
    expect(section).toContain('color-mix(in oklab, currentColor var(--sync-sheen-dip), transparent)');
    expect(rules).not.toMatch(/lime|--primary|--success/);
  });
});
