/**
 * The far zoom's colours (design PR3): the six Aurora icon tones, and the
 * mapping from a container's stored colour to the nearest one, so the far
 * zoom always looks like the icon even when someone picks an odd colour.
 *
 * A constant, not globals.css tokens: these are canvas drawing colours, and
 * the canvas is told which context it sits in (glow on a dark ground, Bloom on
 * paper). The labels, the dots and the minimap frame still read the theme's
 * own tokens (components/views/atlas/use-atlas-colors.ts). Read-only use of
 * accent-colors.ts (design D9).
 *
 * Ported from project-canvas/constellation.html (`AUR`, `ok`, `tone`, `pale`).
 */

export type AtlasToneKey = 'lime' | 'green' | 'honey' | 'teal' | 'ember' | 'indigo';

/**
 * How the far zoom draws. `glow`: added light on a dark ground (any dark
 * theme, or Dusk on paper). `bloom`: ink on paper, deeper and a step more
 * saturated, with washes and pools in place of glow.
 */
export type AtlasToneMode = 'glow' | 'bloom';

/** [L, C, h] for the glow mode. Bloom takes them deeper (toneColor). */
export const ATLAS_TONES: Readonly<Record<AtlasToneKey, readonly [number, number, number]>> = {
  lime: [0.9, 0.21, 132],
  green: [0.85, 0.19, 150],
  honey: [0.88, 0.16, 90],
  teal: [0.84, 0.14, 195],
  ember: [0.78, 0.18, 48],
  indigo: [0.72, 0.18, 272],
};

export const ATLAS_TONE_KEYS = Object.keys(ATLAS_TONES) as AtlasToneKey[];

/**
 * The Aurora icon's own ground, top-left to bottom-right, and the lighter
 * dusky slate a light theme falls to under Dusk (the mock's two gradients).
 * Dusk's ground is one colour, the middle of its gradient, so it can be a
 * `background-color` transition (nothing fades by opacity, D8).
 */
export const ATLAS_GLOW_GROUND = ['oklch(0.21 0.02 250)', 'oklch(0.12 0.012 264)'] as const;
export const ATLAS_DUSK_GROUND = 'oklch(0.305 0.038 256)';

/** oklch to an `rgba()` string a canvas `fillStyle` can take. */
export function oklchToRgba(L: number, C: number, h: number, a = 1): string {
  const r = (h * Math.PI) / 180;
  const A = C * Math.cos(r);
  const B = C * Math.sin(r);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const g = (x: number) => {
    const v = Math.max(0, Math.min(1, x));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  const alpha = Math.max(0, Math.min(1, a));
  return `rgba(${g(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)},${g(
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  )},${g(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)},${+alpha.toFixed(4)})`;
}

/**
 * A tone at an alpha. Glow takes it as is (lightened by `dl`); Bloom takes it
 * deeper and a step more saturated, so it reads as ink on paper.
 */
export function toneColor(k: AtlasToneKey, mode: AtlasToneMode, a = 1, dl = 0): string {
  const [L, C, h] = ATLAS_TONES[k];
  return mode === 'glow'
    ? oklchToRgba(Math.min(0.97, L + dl), C, h, a)
    : oklchToRgba(Math.max(0.3, L - 0.24 + dl), Math.min(0.23, C + 0.04), h, a);
}

/** Bloom's pale tint of a tone: open tiles, pools and washes on paper. */
export function paleColor(k: AtlasToneKey, a = 1): string {
  const [, C, h] = ATLAS_TONES[k];
  return oklchToRgba(0.86, C * 0.7, h, a);
}

export interface Oklch {
  L: number;
  C: number;
  h: number;
}

/** sRGB 0 to 255 to oklch. */
export function rgbToOklch(r: number, g: number, b: number): Oklch {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

/**
 * Parse a resolved CSS colour: `oklch()` (as authored, `oklch(0.68 0.11 140)`,
 * or as the production minifier writes it, `oklch(68% .11 140)`), `#rgb`,
 * `#rrggbb` (an alpha byte ignored), or `rgb()`/`rgba()`. Null for anything
 * else, a `var()` included: resolve it first.
 */
export function parseCssColor(raw: string): Oklch | null {
  const s = raw.trim().toLowerCase();
  const ok = s.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?/);
  if (ok) {
    const L = parseFloat(ok[1]) / (ok[2] ? 100 : 1);
    // A chroma percentage is of 0.4 (CSS Color 4).
    const C = ok[4] ? (parseFloat(ok[3]) / 100) * 0.4 : parseFloat(ok[3]);
    const h = parseFloat(ok[5]);
    return Number.isFinite(L) && Number.isFinite(C) && Number.isFinite(h) ? { L, C, h } : null;
  }
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let v = hex[1];
    if (v.length === 3 || v.length === 4) v = [...v.slice(0, 3)].map((c) => c + c).join('');
    if (v.length !== 6 && v.length !== 8) return null;
    return rgbToOklch(parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16));
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return rgbToOklch(+rgb[1], +rgb[2], +rgb[3]);
  return null;
}

/** A tone's (a, b) in Oklab, for the nearest-tone test. */
function ab(C: number, h: number): [number, number] {
  const r = (h * Math.PI) / 180;
  return [C * Math.cos(r), C * Math.sin(r)];
}

/**
 * The Aurora tone nearest a resolved colour, by distance in Oklab's a/b plane
 * (hue and chroma, lightness left out: every container colour is drawn at the
 * tone's own lightness). Moss lands on green and lime on lime, which a hue-only
 * test gets wrong (moss sits 8 degrees from lime). An unparseable colour is
 * teal, the quietest tone.
 */
export function nearestTone(css: string): AtlasToneKey {
  const c = parseCssColor(css);
  if (!c) return 'teal';
  const [a, b] = ab(c.C, c.h);
  let best: AtlasToneKey = 'teal';
  let bd = Infinity;
  for (const k of ATLAS_TONE_KEYS) {
    const [, C, h] = ATLAS_TONES[k];
    const [ta, tb] = ab(C, h);
    const d = Math.hypot(a - ta, b - tb);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/**
 * Each shipped token's tone, for when the token cannot be read (a test, or a
 * colour resolved before styles load). Taken from the Paper values in
 * globals.css through nearestTone; a test pins that they agree.
 */
export const TOKEN_TONE_FALLBACK: Readonly<Record<string, AtlasToneKey>> = {
  '--accent-1': 'green',
  '--accent-2': 'teal',
  '--accent-3': 'indigo',
  '--accent-4': 'indigo',
  '--accent-5': 'ember',
  '--accent-6': 'honey',
  '--accent-7': 'teal',
  '--accent-8': 'lime',
  '--habit-wellness': 'teal',
  '--habit-work': 'indigo',
  '--habit-personal': 'indigo',
};

/** The custom property a `var(--x)` or `var(--x, fallback)` names, or null. */
export function varName(color: string): string | null {
  const m = color.trim().match(/^var\(\s*(--[\w-]+)/);
  return m ? m[1] : null;
}

/**
 * A stored container colour's tone: a `var()` through `resolve` (the island's
 * computed style), else the fallback table; a raw colour (legacy hex, an
 * oklch) parsed directly.
 */
export function toneForColor(color: string, resolve?: (name: string) => string): AtlasToneKey {
  const name = varName(color);
  if (!name) return nearestTone(color);
  const resolved = resolve?.(name)?.trim();
  if (resolved && parseCssColor(resolved)) return nearestTone(resolved);
  return TOKEN_TONE_FALLBACK[name] ?? 'teal';
}
