import { z } from 'zod';
import { parseColor, printColor, toHex, type Color } from './color';
import { THEME_BASES, type ThemeBaseId } from './theme-bases';

/**
 * The grammar of a user theme (memory/plans/mods.md, "Themes and Looks"). Pure,
 * safe on the server, and the one place a theme's values are read.
 *
 * A theme is token values, never CSS. The tokens are every variable a built-in
 * theme block in app/globals.css restates (tests/unit/theme-bases.test.ts
 * checks the set both ways), plus the UI font and the browser bar colour. Each
 * value is parsed into numbers or a closed choice and printed back from those,
 * so a stylesheet only ever receives text this module wrote. `url()`,
 * `image-set`, `@import`, selectors, `content`, `var()`, comments, semicolons
 * and braces cannot be spelled in any shape below.
 *
 * Departures from the plan's body, recorded in mods.md: bounded alpha is also
 * allowed on the three hairlines (border, input, sidebar border), because every
 * dark built-in draws them in alpha; and Terminal's mono face for code is not a
 * token, so a theme built on Terminal gets the UI face only.
 */

export type ThemeMode = 'light' | 'dark';

/** Colour tokens set on the root, in print order. */
export const ROOT_COLOR_KEYS = [
  'paper0',
  'paper1',
  'paper2',
  'paper3',
  'paperWell',
  'ink0',
  'ink1',
  'ink2',
  'limeSolid',
  'limeInk',
  'limeTint',
  'primaryForeground',
  'successForeground',
  'priorityLowForeground',
  'sidebarPrimaryForeground',
  'accent',
  'border',
  'input',
  'rowSelected',
  'scrim',
  'sidebarBorder',
] as const;
/** Colour tokens set on the Ask opener and mark, not on the root. */
export const ASK_COLOR_KEYS = ['askIconPair', 'askIconPairInk'] as const;
export const COLOR_KEYS = [...ROOT_COLOR_KEYS, ...ASK_COLOR_KEYS] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

/** The four on-fill foregrounds, which the editor shows as one "Text on accent" field. */
export const ON_ACCENT_KEYS = [
  'primaryForeground',
  'successForeground',
  'priorityLowForeground',
  'sidebarPrimaryForeground',
] as const satisfies readonly ColorKey[];

export const RELAY_KEYS = ['relayLight', 'relayLightQuiet', 'relayDark'] as const;
export type RelayKey = (typeof RELAY_KEYS)[number];
/** A relay list is named by mode (relay-field.tsx), so a theme sets only its own mode's. */
export const RELAY_MODE: Record<RelayKey, ThemeMode> = {
  relayLight: 'light',
  relayLightQuiet: 'light',
  relayDark: 'dark',
};
export const RELAY_MAX = 12;

export const CSS_VAR: Record<ColorKey | RelayKey | 'radius' | 'font', string> = {
  paper0: '--paper-0',
  paper1: '--paper-1',
  paper2: '--paper-2',
  paper3: '--paper-3',
  paperWell: '--paper-well',
  ink0: '--ink-0',
  ink1: '--ink-1',
  ink2: '--ink-2',
  limeSolid: '--lime-solid',
  limeInk: '--lime-ink',
  limeTint: '--lime-tint',
  primaryForeground: '--primary-foreground',
  successForeground: '--success-foreground',
  priorityLowForeground: '--priority-low-foreground',
  sidebarPrimaryForeground: '--sidebar-primary-foreground',
  accent: '--accent',
  border: '--border',
  input: '--input',
  rowSelected: '--row-selected',
  scrim: '--scrim',
  sidebarBorder: '--sidebar-border',
  askIconPair: '--ask-icon-pair',
  askIconPairInk: '--ask-icon-pair-ink',
  relayLight: '--relay-light',
  relayLightQuiet: '--relay-light-quiet',
  relayDark: '--relay-dark',
  radius: '--radius',
  font: '--font-ui',
};

/**
 * The tokens that may carry alpha, and its bounds (0 to 1). Every other colour
 * is opaque, `--lime-solid` above all (decision 4: the accent never dims). The
 * scrim's floor is the built-in light scrim's 12%.
 */
export const ALPHA_BOUNDS: Partial<Record<ColorKey, readonly [number, number]>> = {
  accent: [0.02, 0.2],
  rowSelected: [0.04, 0.3],
  scrim: [0.12, 0.6],
  border: [0.04, 0.4],
  input: [0.04, 0.4],
  sidebarBorder: [0.04, 0.4],
};

/** The alpha tokens that are washes over content, so never opaque. */
export const WASH_KEYS: readonly ColorKey[] = ['accent', 'rowSelected', 'scrim'];

export const RADIUS_MAX = 24;

/** Box shadows come from presets: the built-in themes' own sets, verbatim. */
export const SHADOW_VARS = ['--shadow-elev-sm', '--shadow-elev-md', '--shadow-elev-lg', '--shadow-elev-bar'] as const;
export const SHADOW_PRESETS = ['paper', 'studio', 'sorbet', 'night', 'terminal', 'dusk'] as const;
export type ShadowPreset = (typeof SHADOW_PRESETS)[number];
export const SHADOW_VALUES: Record<ShadowPreset, readonly [string, string, string, string]> = {
  paper: [
    '0 4px 4px oklch(0 0 0 / 14%), 0 1px 2px oklch(0 0 0 / 8%)',
    '0 4px 10px oklch(0 0 0 / 14%), 0 2px 4px oklch(0 0 0 / 8%)',
    '0 8px 24px oklch(0 0 0 / 16%), 0 4px 8px oklch(0 0 0 / 10%)',
    '0 1px 2px oklch(0 0 0 / 7%), 0 4px 12px -2px oklch(0 0 0 / 10%)',
  ],
  studio: [
    '0 0 0 1px oklch(0 0 0 / 8%)',
    '0 0 0 1px oklch(0 0 0 / 8%), 0 1px 2px oklch(0 0 0 / 5%)',
    '0 0 0 1px oklch(0 0 0 / 8%), 0 8px 24px oklch(0 0 0 / 8%)',
    '0 0 0 1px oklch(0 0 0 / 7%)',
  ],
  sorbet: [
    '0 2px 6px oklch(0.55 0.1 30 / 12%), 0 1px 2px oklch(0.55 0.1 30 / 8%)',
    '0 4px 14px oklch(0.55 0.1 30 / 14%), 0 2px 4px oklch(0.55 0.1 30 / 8%)',
    '0 10px 30px oklch(0.55 0.1 30 / 18%), 0 4px 8px oklch(0.55 0.1 30 / 10%)',
    '0 3px 12px oklch(0.55 0.1 30 / 12%)',
  ],
  night: [
    'inset 0 1px 0 oklch(1 0 0 / 8%), 0 1px 2px oklch(0 0 0 / 35%), 0 4px 10px oklch(0 0 0 / 30%)',
    'inset 0 1px 0 oklch(1 0 0 / 9%), 0 2px 4px oklch(0 0 0 / 35%), 0 8px 20px oklch(0 0 0 / 38%)',
    'inset 0 1px 0 oklch(1 0 0 / 10%), 0 4px 8px oklch(0 0 0 / 40%), 0 16px 40px oklch(0 0 0 / 45%)',
    'inset 0 1px 0 oklch(1 0 0 / 7%), 0 1px 2px oklch(0 0 0 / 40%), 0 6px 18px -4px oklch(0 0 0 / 45%)',
  ],
  terminal: [
    '0 0 0 1px oklch(0.8 0.15 70 / 16%)',
    '0 0 0 1px oklch(0.8 0.15 70 / 16%)',
    '0 0 0 1px oklch(0.8 0.15 70 / 22%), 0 8px 24px oklch(0 0 0 / 60%)',
    '0 0 0 1px oklch(0.8 0.15 70 / 16%)',
  ],
  dusk: [
    'inset 0 1px 0 oklch(1 0 0 / 8%), 0 2px 6px oklch(0.08 0.05 285 / 50%)',
    'inset 0 1px 0 oklch(1 0 0 / 10%), 0 4px 14px oklch(0.08 0.05 285 / 55%)',
    'inset 0 1px 0 oklch(1 0 0 / 10%), 0 12px 36px oklch(0.08 0.05 285 / 65%)',
    'inset 0 1px 0 oklch(1 0 0 / 7%), 0 4px 14px oklch(0.08 0.05 285 / 45%)',
  ],
};

/** Faces the app already loads (app/layout.tsx), with the exact stacks the built-ins use. */
export const THEME_FONTS = {
  inter: { label: 'Inter', stack: "var(--font-inter), 'Inter', system-ui, sans-serif" },
  geist: { label: 'Geist', stack: "var(--font-geist), 'Geist', system-ui, sans-serif" },
  nunito: { label: 'Nunito', stack: "var(--font-nunito), 'Nunito', system-ui, sans-serif" },
  jetbrains: {
    label: 'JetBrains Mono',
    stack: "var(--font-jetbrains-mono), 'JetBrains Mono', ui-monospace, monospace",
  },
  plex: { label: 'IBM Plex Mono', stack: "var(--font-plex-mono), 'IBM Plex Mono', ui-monospace, monospace" },
  dm: { label: 'DM Mono', stack: "var(--font-dm-mono), 'DM Mono', ui-monospace, monospace" },
  serif: { label: 'Source Serif', stack: "var(--font-source-serif), 'Source Serif 4', Georgia, serif" },
} as const;
export type ThemeFont = keyof typeof THEME_FONTS;
export const THEME_FONT_KEYS = Object.keys(THEME_FONTS) as ThemeFont[];

/* ── Parsing ───────────────────────────────────────────────────────────────── */

/** A colour token's value, or null when the token cannot take it. */
export function parseToken(key: ColorKey, text: string): Color | null {
  const c = parseColor(text);
  if (!c) return null;
  const alpha = c.kind === 'oklch' && c.a !== undefined ? c.a : undefined;
  const bounds = ALPHA_BOUNDS[key];
  if (alpha !== undefined && !bounds) return null;
  // A wash (hover, selection, scrim) is never opaque: a missing alpha is 1 and
  // meets the ceiling like any other. The hairlines may be opaque, as the
  // light built-ins draw them.
  const a = alpha ?? (WASH_KEYS.includes(key) ? 1 : undefined);
  if (a !== undefined && bounds && (a < bounds[0] - 1e-9 || a > bounds[1] + 1e-9)) return null;
  return c;
}

/** An opaque colour (a relay entry, the browser bar), or null. */
export function parseOpaque(text: string): Color | null {
  const c = parseColor(text);
  return c && !(c.kind === 'oklch' && c.a !== undefined) ? c : null;
}

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

export const THEME_BASE_IDS = ['paper', 'studio', 'sorbet', 'night', 'terminal', 'dusk'] as const;
export const LIGHT_BASES = ['paper', 'studio', 'sorbet'] as const;
export const DARK_BASES = ['night', 'terminal', 'dusk'] as const;

const colorField = (key: ColorKey) =>
  z.string().refine((v) => parseToken(key, v) !== null, { message: 'Not a colour this can take.' });
const opaqueField = z.string().refine((v) => parseOpaque(v) !== null, { message: 'Not a colour.' });
const relayField = z.array(opaqueField).min(1).max(RELAY_MAX);

const colorShape = Object.fromEntries(COLOR_KEYS.map((k) => [k, colorField(k).optional()])) as {
  [K in ColorKey]: z.ZodOptional<ReturnType<typeof colorField>>;
};

export const ThemeTokensSchema = z
  .object({
    ...colorShape,
    relayLight: relayField.optional(),
    relayLightQuiet: relayField.optional(),
    relayDark: relayField.optional(),
    radius: z.number().int().min(0).max(RADIUS_MAX).optional(),
    shadows: z.enum(SHADOW_PRESETS).optional(),
    font: z.enum(THEME_FONT_KEYS as [ThemeFont, ...ThemeFont[]]).optional(),
  })
  .strict();
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

export const ThemeManifestSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['light', 'dark']),
    base: z.enum(THEME_BASE_IDS),
    tokens: ThemeTokensSchema.default({}),
    themeColor: z.string().regex(HEX6_RE).optional(),
    contrastOverride: z.literal(true).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (THEME_BASES[m.base].mode !== m.mode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['base'], message: `Pick a ${m.mode} theme to start from.` });
    }
    for (const key of RELAY_KEYS) {
      if (m.tokens[key] !== undefined && RELAY_MODE[key] !== m.mode) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokens', key], message: `Only a ${RELAY_MODE[key]} theme sets this.` });
      }
    }
  });
export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;

/**
 * The tokens with every value re-printed from its parse: what Save stores, so a
 * manifest read back is the host's text, not the typist's.
 */
export function canonicalTokens(tokens: ThemeTokens): ThemeTokens {
  const out: ThemeTokens = {};
  for (const key of COLOR_KEYS) {
    const v = tokens[key];
    const c = v === undefined ? null : parseToken(key, v);
    if (c) out[key] = printColor(c);
  }
  for (const key of RELAY_KEYS) {
    const list = tokens[key];
    if (list) out[key] = list.map((v) => parseOpaque(v)).filter((c): c is Color => !!c).map(printColor);
  }
  if (tokens.radius !== undefined) out.radius = tokens.radius;
  if (tokens.shadows !== undefined) out.shadows = tokens.shadows;
  if (tokens.font !== undefined) out.font = tokens.font;
  return out;
}

/* ── Printing ──────────────────────────────────────────────────────────────── */

export type Decl = [cssVar: string, value: string];

export interface PrintedTheme {
  mode: ThemeMode;
  /** Every declaration, root, body and Ask alike; PREPAINT_TABLE says which is which. */
  decls: Decl[];
  /** `#rrggbb`: the manifest's, or its ground's. */
  themeColor: string;
}

/**
 * A colour token's value after the base fills what the theme left unset: the
 * theme's, else the base's literal, else (an alias like Studio's Ask ink) the
 * value of the token it follows. Null when the base leaves it to the shipped
 * var() chain, which then resolves through the theme's own values.
 */
export function effectiveColor(m: Pick<ThemeManifest, 'base' | 'tokens'>, key: ColorKey): string | null {
  const own = m.tokens[key];
  if (own !== undefined) {
    const c = parseToken(key, own);
    return c ? printColor(c) : null;
  }
  const base = THEME_BASES[m.base];
  const alias = base.same[key];
  if (alias) return effectiveColor(m, alias);
  const literal = base.tokens[key];
  if (literal === undefined) return null;
  const c = parseToken(key, literal);
  return c ? printColor(c) : null;
}

/** Parsed: the declarations to write, never the manifest's text. */
export function printTheme(m: ThemeManifest): PrintedTheme {
  const base = THEME_BASES[m.base];
  const decls: Decl[] = [];
  for (const key of ROOT_COLOR_KEYS) {
    const v = effectiveColor(m, key);
    if (v !== null) decls.push([CSS_VAR[key], v]);
  }
  const radius = m.tokens.radius ?? base.tokens.radius;
  if (radius !== undefined) decls.push([CSS_VAR.radius, `${radius}px`]);
  const shadows = SHADOW_VALUES[m.tokens.shadows ?? base.tokens.shadows ?? 'paper'];
  SHADOW_VARS.forEach((name, i) => decls.push([name, shadows[i]]));
  for (const key of RELAY_KEYS) {
    if (RELAY_MODE[key] !== m.mode) continue;
    const list = m.tokens[key] ?? base.tokens[key];
    if (!list) continue;
    const printed = list.map((v) => parseOpaque(v)).filter((c): c is Color => !!c).map(printColor);
    if (printed.length > 0) decls.push([CSS_VAR[key], printed.slice(0, RELAY_MAX).join(', ')]);
  }
  decls.push([CSS_VAR.font, THEME_FONTS[m.tokens.font ?? base.tokens.font ?? 'inter'].stack]);
  for (const key of ASK_COLOR_KEYS) {
    const v = effectiveColor(m, key);
    if (v !== null) decls.push([CSS_VAR[key], v]);
  }

  const bar = m.themeColor ? parseOpaque(m.themeColor) : null;
  const ground = parseColor(effectiveColor(m, 'paper0') ?? '#ffffff');
  return { mode: m.mode, decls, themeColor: bar ? printColor(bar) : ground ? toHex(ground) : '#ffffff' };
}

/* ── The pre-paint table ───────────────────────────────────────────────────── */

export type DeclScope = 'root' | 'body' | 'ask';

const N = String.raw`\d+(?:\.\d+)?`;
const OPAQUE_SRC = String.raw`(?:#[0-9a-f]{6}|oklch\(${N} ${N} ${N}\))`;
const WASH_SRC = String.raw`oklch\(${N} ${N} ${N} \/ ${N}%\)`;
const ALPHA_SRC = `(?:${OPAQUE_SRC}|${WASH_SRC})`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const exactly = (values: readonly string[]) => `^(?:${[...new Set(values)].map(escapeRe).join('|')})$`;

function buildPrepaintTable(): Record<string, { scope: DeclScope; re: string }> {
  const t: Record<string, { scope: DeclScope; re: string }> = {};
  for (const key of ROOT_COLOR_KEYS) {
    const src = WASH_KEYS.includes(key) ? WASH_SRC : ALPHA_BOUNDS[key] ? ALPHA_SRC : OPAQUE_SRC;
    t[CSS_VAR[key]] = { scope: 'root', re: `^${src}$` };
  }
  t[CSS_VAR.radius] = { scope: 'root', re: String.raw`^\d{1,2}px$` };
  SHADOW_VARS.forEach((name, i) => {
    t[name] = { scope: 'root', re: exactly(SHADOW_PRESETS.map((p) => SHADOW_VALUES[p][i])) };
  });
  for (const key of RELAY_KEYS) {
    t[CSS_VAR[key]] = { scope: 'root', re: `^${OPAQUE_SRC}(?:, ${OPAQUE_SRC}){0,${RELAY_MAX - 1}}$` };
  }
  t[CSS_VAR.font] = { scope: 'body', re: exactly(THEME_FONT_KEYS.map((f) => THEME_FONTS[f].stack)) };
  for (const key of ASK_COLOR_KEYS) t[CSS_VAR[key]] = { scope: 'ask', re: `^${OPAQUE_SRC}$` };
  return t;
}

/**
 * Every declaration a printed theme may hold, where it goes, and a regex for the
 * shape of its value. The pre-paint script (lib/user-themes/prepaint.ts) and the
 * cache reader check each cached declaration against this before it reaches a
 * <style>; tests/unit/user-theme-prepaint.test.ts proves every printer output
 * matches it. Shape only: numeric bounds are checked at save and on every load.
 */
export const PREPAINT_TABLE: Readonly<Record<string, { scope: DeclScope; re: string }>> = buildPrepaintTable();

const compiled = new Map<string, RegExp>();
/** True when a declaration is one the table knows and its value has a printed shape. */
export function isPrintedDecl(name: unknown, value: unknown): boolean {
  if (typeof name !== 'string' || typeof value !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(PREPAINT_TABLE, name)) return false;
  let re = compiled.get(name);
  if (!re) {
    re = new RegExp(PREPAINT_TABLE[name].re);
    compiled.set(name, re);
  }
  return re.test(value);
}

export type { ThemeBaseId };
