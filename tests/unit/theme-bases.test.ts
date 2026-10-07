import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseColor, printColor } from '@/lib/mods/color';
import { THEME_BASES, TINT_GROUND_KEYS, type ThemeBaseId } from '@/lib/mods/theme-bases';
import {
  COLOR_KEYS,
  CSS_VAR,
  PREPAINT_TABLE,
  RELAY_KEYS,
  SHADOW_VALUES,
  SHADOW_VARS,
  THEME_FONTS,
  parseToken,
} from '@/lib/mods/theme-grammar';

/**
 * Drift: lib/mods/theme-bases.ts restates the six built-in themes as token
 * values, and app/globals.css is where they really live. A user theme falls back
 * to these, so a value that drifted would make "start from Studio" look unlike
 * Studio. Also: the grammar's token set is exactly what the built-in blocks set.
 */

const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** A selector list split at its top-level commas (`:is(a, b)` stays whole). */
function splitSelectors(head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of head) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\s+/g, ' '));
}

/** Top-level rules only: @media, @layer and @theme bodies are skipped whole. */
function topLevelRules(src: string): { selectors: string[]; decls: Map<string, string> }[] {
  const out: { selectors: string[]; decls: Map<string, string> }[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    // A statement at-rule (`@import …;`) ends at its semicolon, not at a brace.
    const raw = src.slice(i, open);
    const head = raw.slice(raw.lastIndexOf(';') + 1).trim();
    if (head.startsWith('@')) {
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      i = j;
      continue;
    }
    const close = src.indexOf('}', open);
    const body = src.slice(open + 1, close);
    const decls = new Map<string, string>();
    for (const part of body.split(';')) {
      const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
      if (m) decls.set(m[1], m[2].replace(/\s+/g, ' '));
    }
    out.push({ selectors: splitSelectors(head), decls });
    i = close + 1;
  }
  return out;
}

const RULES = topLevelRules(css);

/** Every declaration of rules that list `selector`, later rules winning. */
function declsFor(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of RULES) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) out.set(k, v);
  return out;
}

const ASK = ':is([data-ask-opener], [data-ask-mark])';
const LIGHT_ROOT = declsFor(':root');
const DARK_ROOT = new Map([...LIGHT_ROOT, ...declsFor('.dark')]);
const BODY = declsFor('body');
const ASK_LIGHT = declsFor(ASK);
const ASK_DARK = new Map([...ASK_LIGHT, ...declsFor(`.dark ${ASK}`)]);

function themeHead(id: ThemeBaseId): string | null {
  if (id === 'paper' || id === 'night') return null;
  return THEME_BASES[id].mode === 'light' ? `:root[data-look-light='${id}']:not(.dark)` : `:root[data-look-dark='${id}'].dark`;
}

/** What the page computes for a variable under this theme, before any var() resolves. */
function cssValue(id: ThemeBaseId, name: string): string | undefined {
  const head = themeHead(id);
  const dark = THEME_BASES[id].mode === 'dark';
  const scope = PREPAINT_TABLE[name]?.scope ?? 'root';
  if (scope === 'ask') {
    const own = head ? declsFor(`${head} ${ASK}`).get(name) : undefined;
    return own ?? (dark ? ASK_DARK : ASK_LIGHT).get(name);
  }
  if (scope === 'body') {
    return (head ? declsFor(`${head} body`).get(name) : undefined) ?? BODY.get(name);
  }
  return (head ? declsFor(head).get(name) : undefined) ?? (dark ? DARK_ROOT : LIGHT_ROOT).get(name);
}

const IDS = Object.keys(THEME_BASES) as ThemeBaseId[];
const remToPx = (v: string) => v.replace(/(\d*\.?\d+)rem/g, (_m, n) => `${Number(n) * 16}px`);

describe('THEME_BASES matches app/globals.css', () => {
  it('finds the blocks it reads', () => {
    expect(LIGHT_ROOT.get('--paper-0')).toBeTruthy();
    expect(DARK_ROOT.get('--paper-0')).not.toBe(LIGHT_ROOT.get('--paper-0'));
    for (const id of IDS) {
      const head = themeHead(id);
      if (head) expect(declsFor(head).size, id).toBeGreaterThan(10);
    }
  });

  it.each(IDS)('%s: every colour token, literal or left to its chain', (id) => {
    const base = THEME_BASES[id];
    for (const key of COLOR_KEYS) {
      const expected = cssValue(id, CSS_VAR[key]);
      const alias = base.same[key];
      if (alias) {
        expect(expected, `${id} ${key}`).toBe(`var(${CSS_VAR[alias]})`);
        continue;
      }
      if (expected === undefined || /var\(|color-mix\(/.test(expected)) {
        expect(base.tokens[key], `${id} ${key} is a chain in the CSS`).toBeUndefined();
        continue;
      }
      expect(base.tokens[key], `${id} ${key}`).toBe(expected);
    }
  });

  it.each(IDS)('%s: radius, shadows, font and relays', (id) => {
    const base = THEME_BASES[id];
    expect(`${base.tokens.radius}px`).toBe(remToPx(cssValue(id, '--radius')!));
    SHADOW_VARS.forEach((name, i) => {
      expect(SHADOW_VALUES[base.tokens.shadows!][i], `${id} ${name}`).toBe(cssValue(id, name));
    });
    expect(THEME_FONTS[base.tokens.font!].stack).toBe(cssValue(id, '--font-ui'));
    for (const key of RELAY_KEYS) {
      const expected = cssValue(id, CSS_VAR[key]);
      expect(base.tokens[key]?.join(', '), `${id} ${key}`).toBe(expected);
    }
  });

  it('every base value parses and re-prints to itself', () => {
    for (const id of IDS) {
      const t = THEME_BASES[id].tokens;
      for (const key of COLOR_KEYS) {
        const v = t[key];
        if (v === undefined) continue;
        const c = parseToken(key, v);
        expect(c, `${id} ${key}`).not.toBeNull();
        expect(printColor(c!), `${id} ${key}`).toBe(v);
      }
      for (const key of RELAY_KEYS) for (const v of t[key] ?? []) expect(printColor(parseColor(v)!)).toBe(v);
    }
  });

  it('every base has a literal for everything a tint touches', () => {
    for (const id of IDS) {
      for (const key of TINT_GROUND_KEYS) expect(THEME_BASES[id].tokens[key], `${id} ${key}`).toBeDefined();
    }
  });
});

describe('the token set is what the built-in theme blocks set', () => {
  const builtIns = IDS.filter((id) => themeHead(id));

  it('root and Ask rules: exactly the table, less the font', () => {
    const set = new Set<string>();
    for (const id of builtIns) {
      const head = themeHead(id)!;
      for (const k of declsFor(head).keys()) set.add(k);
      for (const k of declsFor(`${head} ${ASK}`).keys()) set.add(k);
    }
    const table = new Set(Object.keys(PREPAINT_TABLE).filter((k) => k !== '--font-ui'));
    expect([...set].sort()).toEqual([...table].sort());
  });

  it('body rules: the UI font, plus Terminal’s code face, which is not a token (mods.md)', () => {
    const set = new Set<string>();
    for (const id of builtIns) for (const k of declsFor(`${themeHead(id)!} body`).keys()) set.add(k);
    expect([...set].sort()).toEqual(['--font-mono', '--font-ui']);
    expect(PREPAINT_TABLE['--font-mono']).toBeUndefined();
  });
});
