/**
 * Catalog of LIGHT-mode palettes for the ambient "data relay" field (see
 * components/primitives/relay-field.tsx). Kept as a named, exported set so it
 * can back a future user-theming / customization control — a setting picks a
 * key here and passes it to <RelayField lightPalette="…" />.
 *
 * These are light-mode only. Dark mode reads the live theme tokens directly (a
 * glowing lime bloom) and isn't a fixed catalog. A theme other than Paper
 * paints its own colours (`--relay-light` in app/globals.css) instead; a key
 * passed to <RelayField lightPalette> pins one of these regardless. Light mode can't add light to
 * near-white paper, so every palette below is painted `source-over` and the
 * pulse deepens tiles DOWNWARD toward the color at the ripple crest — a
 * subtractive "sonar" (see the primitive's docs). Colors are oklch strings so
 * the field can inject per-tile alpha via the `/ a` syntax.
 *
 * Design note (from a web-research sweep — GitHub's contribution graph,
 * Vercel/Stripe ambient grids): on warm near-white, cohesion comes from
 * collapsing hue variance. The `mono` palettes (one hue, shades only) read as
 * intentional texture; the `multi` palettes are the more colorful explorations
 * we kept for range. The warm paper (surface-3 is oklch .945/.0015/90) is why
 * cool hues sit cleanest and warm hues are the muddiest — see `harvest`.
 */

export type RelayLightPaletteKey =
  | 'relay'
  | 'quiet'
  | 'gray'
  | 'ink'
  | 'slate'
  | 'lime'
  | 'tide'
  | 'meadow'
  | 'harvest'
  | 'confetti';

export interface RelayLightPalette {
  /** Human label for a palette picker. */
  label: string;
  /** Shades of one hue (`mono`) vs a multi-hue spread (`multi`). */
  kind: 'mono' | 'multi';
  /** One-line description of the vibe / when to use it. */
  description: string;
  /** oklch tile colors, assigned per-tile at random and modulated by the pulse. */
  colors: string[];
}

export const RELAY_LIGHT_PALETTES: Record<RelayLightPaletteKey, RelayLightPalette> = {
  relay: {
    label: 'Relay',
    kind: 'multi',
    description:
      'The light logo colours: the dark field’s relay hues a shade deeper, in its mix — mostly lime, with orange, honey, teal, indigo and moss.',
    // Same order and weights as the dark field (readPalette: primary ×3,
    // accent-8, afternoon, accent-6, accent-2, accent-3, accent-1), and the
    // same values the light app mark is drawn in — keep the two together.
    colors: [
      'oklch(0.8 0.2 128)',
      'oklch(0.8 0.2 128)',
      'oklch(0.8 0.2 128)',
      'oklch(0.72 0.17 128)',
      'oklch(0.7 0.13 50)',
      'oklch(0.76 0.13 85)',
      'oklch(0.64 0.1 195)',
      'oklch(0.58 0.13 268)',
      'oklch(0.62 0.12 145)',
    ],
  },
  quiet: {
    label: 'Quiet',
    kind: 'multi',
    description:
      'Gray texture with the relay colours as sparks — about half the tiles stay gray. For fields on the gray dock.',
    colors: [
      'oklch(0.42 0.012 272)',
      'oklch(0.5 0.012 272)',
      'oklch(0.58 0.012 272)',
      'oklch(0.46 0.012 272)',
      'oklch(0.54 0.012 272)',
      'oklch(0.8 0.2 128)',
      'oklch(0.8 0.2 128)',
      'oklch(0.64 0.1 195)',
      'oklch(0.7 0.13 50)',
    ],
  },
  gray: {
    label: 'Gray',
    kind: 'mono',
    description: 'Shades of cool gray — tonal contrast, no color. The calm default.',
    colors: [
      'oklch(0.42 0.012 272)',
      'oklch(0.5 0.012 272)',
      'oklch(0.36 0.01 272)',
      'oklch(0.58 0.012 272)',
      'oklch(0.46 0.012 272)',
      'oklch(0.64 0.012 272)',
      'oklch(0.34 0.01 272)',
      'oklch(0.54 0.012 272)',
      'oklch(0.6 0.012 272)',
    ],
  },
  ink: {
    label: 'Ink',
    kind: 'mono',
    description: 'Shades of the cool ink (indigo, hue ~272) — echoes dsul’s text color.',
    colors: [
      'oklch(0.62 0.09 272)',
      'oklch(0.56 0.11 272)',
      'oklch(0.5 0.12 272)',
      'oklch(0.58 0.1 264)',
      'oklch(0.54 0.11 278)',
      'oklch(0.56 0.11 272)',
    ],
  },
  slate: {
    label: 'Slate',
    kind: 'mono',
    description: 'Shades of teal-slate (hue ~208) — cool, sits a step apart from the text ink.',
    colors: [
      'oklch(0.64 0.07 208)',
      'oklch(0.58 0.08 206)',
      'oklch(0.52 0.09 205)',
      'oklch(0.6 0.075 214)',
      'oklch(0.55 0.085 200)',
      'oklch(0.58 0.08 208)',
    ],
  },
  lime: {
    label: 'Lime',
    kind: 'mono',
    description: 'Shades of the brand lime (hue ~127) — the warm/green cousin of Gray.',
    colors: [
      'oklch(0.6 0.15 128)',
      'oklch(0.68 0.16 127)',
      'oklch(0.54 0.14 129)',
      'oklch(0.73 0.16 125)',
      'oklch(0.63 0.15 128)',
      'oklch(0.77 0.15 123)',
      'oklch(0.5 0.13 130)',
      'oklch(0.66 0.16 127)',
      'oklch(0.71 0.16 126)',
    ],
  },
  tide: {
    label: 'Tide',
    kind: 'multi',
    description: 'Cool multi-hue: teal → sky → periwinkle → indigo, with a sage nod.',
    colors: [
      'oklch(0.66 0.11 200)',
      'oklch(0.66 0.11 200)',
      'oklch(0.68 0.1 185)',
      'oklch(0.63 0.12 225)',
      'oklch(0.6 0.13 255)',
      'oklch(0.57 0.13 270)',
      'oklch(0.69 0.1 162)',
      'oklch(0.66 0.12 145)',
      'oklch(0.64 0.12 215)',
    ],
  },
  meadow: {
    label: 'Meadow',
    kind: 'multi',
    description: 'Brand-tonal: a tight lime → teal green arc; continuity with dark mode.',
    colors: [
      'oklch(0.7 0.15 128)',
      'oklch(0.7 0.15 128)',
      'oklch(0.67 0.14 140)',
      'oklch(0.65 0.13 156)',
      'oklch(0.67 0.12 172)',
      'oklch(0.66 0.11 188)',
      'oklch(0.66 0.11 200)',
      'oklch(0.73 0.15 115)',
      'oklch(0.69 0.13 146)',
    ],
  },
  harvest: {
    label: 'Harvest',
    kind: 'multi',
    description: 'Warm amber → terracotta → lime; leans into the paper (can go muddy).',
    colors: [
      'oklch(0.72 0.12 85)',
      'oklch(0.72 0.12 85)',
      'oklch(0.7 0.13 68)',
      'oklch(0.67 0.14 52)',
      'oklch(0.64 0.13 38)',
      'oklch(0.74 0.13 100)',
      'oklch(0.71 0.14 118)',
      'oklch(0.69 0.1 135)',
      'oklch(0.68 0.12 95)',
    ],
  },
  confetti: {
    label: 'Confetti',
    kind: 'multi',
    description: 'The original full-spectrum 9-hue spread — lively but scattered on gray.',
    colors: [
      'oklch(0.7 0.19 128)',
      'oklch(0.7 0.19 128)',
      'oklch(0.66 0.18 138)',
      'oklch(0.74 0.17 115)',
      'oklch(0.64 0.17 48)',
      'oklch(0.72 0.15 78)',
      'oklch(0.6 0.13 200)',
      'oklch(0.52 0.16 265)',
      'oklch(0.58 0.15 150)',
    ],
  },
};

/** The shipped default — the light logo colours, so field and mark agree. */
export const DEFAULT_LIGHT_PALETTE: RelayLightPaletteKey = 'relay';

/** What `tone="quiet"` paints under Paper — the dock's gray capsule. */
export const QUIET_LIGHT_PALETTE: RelayLightPaletteKey = 'quiet';

/** Resolve a key to its colors, falling back to the default if unknown. */
export function relayLightColors(key: RelayLightPaletteKey = DEFAULT_LIGHT_PALETTE): string[] {
  return (RELAY_LIGHT_PALETTES[key] ?? RELAY_LIGHT_PALETTES[DEFAULT_LIGHT_PALETTE]).colors;
}
