// dsul's app mark: "Wave", a 4×4 patch of the RelayField with the ripple's crest lit along the
// diagonal. Tiles are drawn the way components/primitives/relay-field.tsx bakes its dark sprite
// (a halo, a dim outer square and a bright core, blended additively on the navy ground), with
// the dots enlarged so they read at icon size. The light version paints the same relays as ink
// on paper, with no halo, like the field's light sprite.
//
// Returns SVG strings. The halos use `mix-blend-mode: plus-lighter`, which librsvg, sharp and
// Figma don't render, so rasterise in Chromium (build.mjs does).

// The field's dark-mode relay palette (globals.css `.dark`).
const DARK = {
  P: 'oklch(0.87 0.19 125)', // --primary (lime-solid)
  L: 'oklch(0.76 0.13 125)', // --accent-8 lime
  O: 'oklch(0.66 0.1 55)', //   --afternoon orange
  H: 'oklch(0.72 0.1 85)', //   --accent-6 honey
  T: 'oklch(0.66 0.09 190)', // --accent-2 teal
  I: 'oklch(0.64 0.11 265)', // --accent-3 indigo
  M: 'oklch(0.66 0.1 140)', //  --accent-1 moss
};
// The same hues a step deeper, so they hold against near-white paper (lime most of all).
const LIGHT = {
  P: 'oklch(0.8 0.2 128)',
  L: 'oklch(0.72 0.17 128)',
  O: 'oklch(0.7 0.13 50)',
  H: 'oklch(0.76 0.13 85)',
  T: 'oklch(0.64 0.1 195)',
  I: 'oklch(0.58 0.13 268)',
  M: 'oklch(0.62 0.12 145)',
};
const WHITE = 'oklch(1 0 0)';
const NAVY = 'oklch(0.173 0.009 264)'; // --paper-0, dark
const NAVY_LIFT = 'oklch(0.215 0.012 264)';
const PAPER = 'oklch(0.985 0.002 90)';
const PAPER_EDGE = 'oklch(0.955 0.004 90)';

/** n×n tiles as [colorKey, intensity 0–1], row-major. */
function grid(colors, level) {
  return colors.flatMap((row, y) => row.map((k, x) => [k, level(x + y)]));
}
// The crest runs bottom-left to top-right (x + y === 3); its neighbours glow at 0.42.
const WAVE = grid(
  [['L', 'M', 'H', 'T'], ['M', 'O', 'P', 'L'], ['H', 'P', 'L', 'M'], ['I', 'L', 'M', 'T']],
  (s) => (s === 3 ? 1 : s === 2 || s === 4 ? 0.42 : 0.14),
);
// 16px has room for three dots across, so the favicon is the 3×3 middle of the same crest.
const WAVE_SMALL = grid(
  [['M', 'H', 'T'], ['O', 'P', 'L'], ['L', 'I', 'M']],
  (s) => (s === 2 ? 1 : s === 1 || s === 3 ? 0.4 : 0.14),
);

const f = (v) => +v.toFixed(2);
function rr(x, y, s, r, fill, op) {
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(s)}" height="${f(s)}" rx="${f(r)}" fill="${fill}" fill-opacity="${op.toFixed(3)}"/>`;
}

/**
 * @param {number} size  canvas px
 * @param {object} o
 * @param {'dark'|'light'|'mono'} [o.theme]  mono = white tiles on transparent (Android themed / iOS tinted layer)
 * @param {'rounded'|'square'|'none'} [o.ground]  rounded tile, full-bleed square (the OS masks it), or transparent
 * @param {number} [o.span]  fraction of the canvas the dots span (big sizes only); 0.62 by default
 */
export function waveSVG(size, { theme = 'dark', ground = 'rounded', span = 0.62 } = {}) {
  const light = theme === 'light';
  const mono = theme === 'mono';
  const C = light ? LIGHT : DARK;
  const color = (k) => (mono ? WHITE : C[k]);
  const smallSize = size <= 32;
  let defs = `<radialGradient id="g" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="${light ? PAPER : smallSize ? NAVY : NAVY_LIFT}"/><stop offset="1" stop-color="${light ? (smallSize ? PAPER : PAPER_EDGE) : NAVY}"/></radialGradient>`;
  const bg =
    ground === 'none' || mono
      ? ''
      : `<rect width="${size}" height="${size}"${ground === 'rounded' ? ` rx="${f(size * (size <= 16 ? 0.14 : 0.225))}"` : ''} fill="url(#g)"/>`;
  let body = '';

  if (smallSize) {
    // Pixel-snapped cores, no halo: a one-pixel glow reads as mud.
    const tiles = size <= 16 ? WAVE_SMALL : WAVE;
    const n = Math.sqrt(tiles.length);
    let g = size <= 16 ? 1 : 2;
    const margin = size <= 16 ? 2 : 3;
    let core = Math.min(Math.floor((size - 2 * margin - (n - 1) * g) / n), Math.round(size * 0.3));
    // Centre on whole pixels: an odd n moves by the core, an even n only by the gap.
    if ((size - (n * core + (n - 1) * g)) % 2) {
      if (n % 2) core += size - (n * (core + 1) + (n - 1) * g) >= 2 ? 1 : -1;
      else g += size - (n * core + (n - 1) * (g + 1)) >= 2 ? 1 : -1;
    }
    const off = (size - (n * core + (n - 1) * g)) / 2;
    const r = Math.max(0.5, core * 0.26);
    tiles.forEach(([k, a], i) => {
      const x = off + (i % n) * (core + g);
      const y = off + Math.floor(i / n) * (core + g);
      body += rr(x, y, core, r, color(k), light ? 0.16 + 0.84 * a : 0.3 + 0.7 * a);
    });
  } else {
    // Big dots: cores 0.101 of the canvas (at the default span), outer square and halo in
    // proportion, additive on dark.
    const n = 4;
    const core = 0.101 * size * (span / 0.62);
    const p = (span * size - core) / (n - 1);
    const outer = Math.min(0.95 * p, 1.5 * core);
    const halo = 3 * core;
    const c0 = (size - span * size) / 2 + core / 2;
    if (!light && !mono) {
      for (const k of new Set(WAVE.map((t) => t[0]))) {
        defs += `<radialGradient id="h${k}"><stop offset="0" stop-color="${C[k]}" stop-opacity="0.34"/><stop offset="0.55" stop-color="${C[k]}" stop-opacity="0.09"/><stop offset="1" stop-color="${C[k]}" stop-opacity="0"/></radialGradient>`;
      }
    }
    WAVE.forEach(([k, a], i) => {
      const cx = c0 + (i % n) * p;
      const cy = c0 + Math.floor(i / n) * p;
      const square = rr(cx - outer / 2, cy - outer / 2, outer, outer * 0.19, color(k), light ? 0.14 : 0.16);
      const dot = rr(cx - core / 2, cy - core / 2, core, core * 0.26, color(k), light || mono ? 1 : 0.9);
      if (mono) body += `<g opacity="${(0.2 + 0.8 * a).toFixed(3)}">${dot}</g>`;
      else if (light) body += `<g opacity="${(0.1 + 0.9 * a).toFixed(3)}">${square}${dot}</g>`;
      else
        body +=
          `<g style="mix-blend-mode:plus-lighter" opacity="${(0.06 + 0.94 * a).toFixed(3)}">` +
          `<rect x="${f(cx - halo / 2)}" y="${f(cy - halo / 2)}" width="${f(halo)}" height="${f(halo)}" fill="url(#h${k})"/>` +
          `${square}${dot}</g>`;
    });
    body = `<g style="isolation:isolate">${body}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${defs}</defs>${bg}${body}</svg>`;
}
