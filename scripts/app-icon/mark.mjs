// dsul's app mark: "Aurora", a 4×4 patch of the RelayField with the ripple's crest lit along the
// diagonal and a band of lime-to-teal light behind the crest. Tiles are drawn the way
// components/primitives/relay-field.tsx bakes its dark sprite (a halo, a dim outer square and a
// bright core, blended additively on a dark ground), with the relay colours pushed brighter
// and the dots enlarged so the icon still reads in a dock full of other apps.
//
// Returns SVG strings. The halos use `mix-blend-mode: plus-lighter`, which librsvg, sharp and
// Figma don't render, so rasterise in Chromium (build.mjs does).

// The field's dark-mode relay hues (globals.css `.dark`), lighter and more saturated.
const AURORA = {
  P: 'oklch(0.95 0.22 128)', // lime-solid
  L: 'oklch(0.9 0.21 132)', //  lime
  O: 'oklch(0.78 0.18 48)', //  afternoon orange
  H: 'oklch(0.88 0.16 90)', //  honey
  T: 'oklch(0.84 0.14 195)', // teal
  I: 'oklch(0.72 0.18 272)', // indigo
  M: 'oklch(0.85 0.19 150)', // moss
};
const WHITE = 'oklch(1 0 0)';
// Ground: a diagonal from a blue-slate corner to near-black.
const GROUND = ['oklch(0.21 0.02 250)', 'oklch(0.12 0.012 264)'];
// The light band along the crest: lime in the middle, teal at its ends.
const GLOW = { mid: 'oklch(0.75 0.2 128)', end: 'oklch(0.7 0.13 195)', midAlpha: 0.95, endAlpha: 0.42 };

/** n×n tiles as [colorKey, intensity 0–1], row-major. */
function grid(colors, level) {
  return colors.flatMap((row, y) => row.map((k, x) => [k, level(x + y)]));
}
// The crest runs bottom-left to top-right (x + y === 3); its neighbours glow at 0.6.
const WAVE = grid(
  [['L', 'M', 'H', 'T'], ['M', 'O', 'P', 'L'], ['H', 'P', 'L', 'M'], ['I', 'L', 'M', 'T']],
  (s) => (s === 3 ? 1 : s === 2 || s === 4 ? 0.6 : 0.26),
);
// Under ~20px there is room for three dots across, so it is the 3×3 middle of the same crest.
const WAVE_SMALL = grid(
  [['M', 'H', 'T'], ['O', 'P', 'L'], ['L', 'I', 'M']],
  (s) => (s === 2 ? 1 : s === 1 || s === 3 ? 0.6 : 0.26),
);

const f = (v) => +v.toFixed(2);
function rr(x, y, s, r, fill, op) {
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(s)}" height="${f(s)}" rx="${f(r)}" fill="${fill}" fill-opacity="${op.toFixed(3)}"/>`;
}

/**
 * @param {number} size  canvas px
 * @param {object} o
 * @param {'color'|'mono'} [o.theme]  mono = white tiles on transparent (Android themed / iOS tinted layer)
 * @param {'rounded'|'square'|'none'} [o.ground]  rounded tile, full-bleed square (the OS masks it), or transparent
 * @param {number} [o.span]  fraction of the canvas the dots span (big sizes only); 0.62 by default
 * @param {boolean} [o.dots]  false draws the ground and glow alone (Android's background layer)
 */
export function auroraSVG(size, { theme = 'color', ground = 'rounded', span = 0.62, dots = true } = {}) {
  const mono = theme === 'mono';
  const color = (k) => (mono ? WHITE : AURORA[k]);
  const small = size <= 32;
  const rx = ground === 'rounded' ? ` rx="${f(size * (size <= 16 ? 0.22 : 0.225))}"` : '';
  let defs = '';
  let bg = '';
  if (ground !== 'none' && !mono) {
    defs += `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GROUND[0]}"/><stop offset="1" stop-color="${GROUND[1]}"/></linearGradient>`;
    bg = `<rect width="${size}" height="${size}"${rx} fill="url(#g)"/>`;
    // The glow band. A favicon skips it: at 16 or 32px it only muddies the ground.
    if (!small) {
      const c = size / 2;
      defs +=
        `<radialGradient id="gl"><stop offset="0" stop-color="${GLOW.mid}" stop-opacity="${GLOW.midAlpha}"/>` +
        `<stop offset="0.5" stop-color="${GLOW.end}" stop-opacity="${GLOW.endAlpha}"/><stop offset="1" stop-color="${GLOW.end}" stop-opacity="0"/></radialGradient>` +
        `<clipPath id="cp"><rect width="${size}" height="${size}"${rx}/></clipPath>`;
      // Clipped outside the rotation, so the band's ends meet the tile's own edge.
      bg += `<g clip-path="url(#cp)"><ellipse cx="${c}" cy="${c}" rx="${f(size * 0.62)}" ry="${f(size * 0.3)}" transform="rotate(-45 ${c} ${c})" fill="url(#gl)"/></g>`;
    }
  }
  let body = '';

  if (!dots) {
    // ground and glow only
  } else if (small) {
    // Pixel-snapped cores with air between them, no halo: a one-pixel glow reads as mud.
    // 16px → 2px dots, 2px gaps; 32px → 4px dots, 3px gaps.
    const tiles = size <= 20 ? WAVE_SMALL : WAVE;
    const n = Math.sqrt(tiles.length);
    const core = Math.max(1, Math.round(size / 8));
    const g = Math.max(1, Math.round((size * 3) / 32));
    const off = Math.floor((size - (n * core + (n - 1) * g)) / 2);
    const r = Math.max(0.5, core * 0.26);
    tiles.forEach(([k, a], i) => {
      const x = off + (i % n) * (core + g);
      const y = off + Math.floor(i / n) * (core + g);
      body += rr(x, y, core, r, color(k), 0.22 + 0.78 * a);
    });
  } else {
    // Big dots: cores 0.101 of the canvas (at the default span), outer square and halo in
    // proportion, additive on the dark ground.
    const n = 4;
    const core = 0.101 * size * (span / 0.62);
    const p = (span * size - core) / (n - 1);
    const outer = Math.min(0.95 * p, 1.5 * core);
    const halo = 3 * core;
    const c0 = (size - span * size) / 2 + core / 2;
    if (!mono) {
      for (const k of new Set(WAVE.map((t) => t[0]))) {
        defs += `<radialGradient id="h${k}"><stop offset="0" stop-color="${AURORA[k]}" stop-opacity="0.6"/><stop offset="0.55" stop-color="${AURORA[k]}" stop-opacity="0.17"/><stop offset="1" stop-color="${AURORA[k]}" stop-opacity="0"/></radialGradient>`;
      }
    }
    WAVE.forEach(([k, a], i) => {
      const cx = c0 + (i % n) * p;
      const cy = c0 + Math.floor(i / n) * p;
      const square = rr(cx - outer / 2, cy - outer / 2, outer, outer * 0.19, color(k), 0.16);
      const dot = rr(cx - core / 2, cy - core / 2, core, core * 0.26, color(k), 1);
      if (mono) body += `<g opacity="${(0.2 + 0.8 * a).toFixed(3)}">${dot}</g>`;
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
