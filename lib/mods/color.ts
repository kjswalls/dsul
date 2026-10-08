/**
 * Colour parsing, printing and contrast for user themes (memory/plans/mods.md,
 * "Themes and Looks"). Pure, safe on the server.
 *
 * A theme's value is never passed through. It is parsed here into numbers and
 * printed back from those numbers, so what reaches a stylesheet can only be the
 * shapes `printColor` writes: `#rrggbb` or `oklch(L C H[ / A%])`.
 */

export type Color =
  | { kind: 'hex'; r: number; g: number; b: number }
  | { kind: 'oklch'; l: number; c: number; h: number; a?: number };

/** A plain decimal: no sign, no exponent. */
const NUM = String.raw`(\d{1,4}(?:\.\d{1,6})?|\.\d{1,6})`;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const OKLCH_RE = new RegExp(String.raw`^oklch\( *${NUM}(%?) +${NUM} +${NUM}(?: *\/ *${NUM}(%?))? *\)$`, 'i');

/** Bounds an oklch colour must sit inside. Chroma past 0.4 is outside every display. */
const C_MAX = 0.4;

/**
 * `#rgb`, `#rrggbb` or `oklch(L C H[ / A])`, with surrounding spaces allowed and
 * nothing else. Null when the text is anything other than those shapes or a
 * number is out of range. Alpha is returned as 0 to 1; whether a token may
 * carry it is the grammar's call, not this one's.
 */
export function parseColor(input: string): Color | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.replace(/^ +| +$/g, '');
  const hex = HEX_RE.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
    return {
      kind: 'hex',
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const m = OKLCH_RE.exec(s);
  if (!m) return null;
  const [, lRaw, lPct, cRaw, hRaw, aRaw, aPct] = m;
  const l = lPct ? Number(lRaw) / 100 : Number(lRaw);
  const c = Number(cRaw);
  const h = Number(hRaw);
  if (!(l >= 0 && l <= 1) || !(c >= 0 && c <= C_MAX) || !(h >= 0 && h <= 360)) return null;
  if (aRaw === undefined) return { kind: 'oklch', l, c, h };
  const a = aPct ? Number(aRaw) / 100 : Number(aRaw);
  if (!(a >= 0 && a <= 1)) return null;
  return { kind: 'oklch', l, c, h, a };
}

/** Rounds to at most `dp` places and drops trailing zeros. */
function fixed(n: number, dp: number): string {
  const s = n.toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** The one way a colour is written out: from its numbers, never from the text it came from. */
export function printColor(c: Color): string {
  if (c.kind === 'hex') return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const body = `${fixed(c.l, 4)} ${fixed(c.c, 4)} ${fixed(c.h, 2)}`;
  return c.a === undefined ? `oklch(${body})` : `oklch(${body} / ${fixed(c.a * 100, 2)}%)`;
}

/** The alpha a colour carries, 1 when it carries none. */
export function alphaOf(c: Color): number {
  return c.kind === 'oklch' && c.a !== undefined ? c.a : 1;
}

/* ── sRGB, luminance, contrast ─────────────────────────────────────────────── */

type Rgb = [number, number, number];

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Linear sRGB, clamped into gamut. */
export function toLinearRgb(c: Color): Rgb {
  if (c.kind === 'hex') return [decode(c.r / 255), decode(c.g / 255), decode(c.b / 255)];
  const rad = (c.h * Math.PI) / 180;
  const a = c.c * Math.cos(rad);
  const b = c.c * Math.sin(rad);
  const l_ = (c.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (c.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (c.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp01(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp01(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** WCAG relative luminance. */
export function luminance(c: Color): number {
  const [r, g, b] = toLinearRgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. Alpha is ignored: only opaque pairs are checked. */
export function contrast(a: Color, b: Color): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `#rrggbb`, for <meta name="theme-color"> and <input type="color">. */
export function toHex(c: Color): string {
  if (c.kind === 'hex') return printColor(c);
  const [r, g, b] = toLinearRgb(c);
  return `#${hex2(encode(r) * 255)}${hex2(encode(g) * 255)}${hex2(encode(b) * 255)}`;
}

/* ── OKLab ─────────────────────────────────────────────────────────────────── */

/** OKLab coordinates [L, a, b]. A hex colour goes through sRGB; an oklch one is unrolled. */
export function toOklab(c: Color): [number, number, number] {
  if (c.kind === 'oklch') {
    const rad = (c.h * Math.PI) / 180;
    return [c.l, c.c * Math.cos(rad), c.c * Math.sin(rad)];
  }
  const [r, g, b] = toLinearRgb(c);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * `color-mix(in oklab, a p, b)` for opaque colours, p from 0 to 1: `p` of `a`,
 * the rest `b`. What the browser draws for the waiting shimmer's ink.
 */
export function mixOklab(a: Color, b: Color, p: number): Color {
  const A = toOklab(a);
  const B = toOklab(b);
  const L = A[0] * p + B[0] * (1 - p);
  const x = A[1] * p + B[1] * (1 - p);
  const y = A[2] * p + B[2] * (1 - p);
  const h = (Math.atan2(y, x) * 180) / Math.PI;
  return { kind: 'oklch', l: L, c: Math.hypot(x, y), h: h < 0 ? h + 360 : h };
}
