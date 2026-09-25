import {
  Bungee,
  Fredoka,
  Instrument_Serif,
  JetBrains_Mono,
  Permanent_Marker,
  Rubik_Bubbles,
  Silkscreen,
  Space_Mono,
  Tilt_Neon,
} from 'next/font/google';

/**
 * The faces the wordmark's hover flavors wear. None is preloaded: the page
 * ships only their @font-face rules, and a browser fetches a face the first
 * time a flavor actually draws with it, so a user who never hovers the mark
 * never downloads one. `swap` means the first hover of a flavor may show the
 * fallback for a beat while its face arrives. Each call spells its options
 * out because the next/font transform rejects a spread.
 */
const bubble = Rubik_Bubbles({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '400',
  variable: '--font-wm-bubble',
});
const pixel = Silkscreen({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '400',
  variable: '--font-wm-pixel',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: ['500', '700'],
  variable: '--font-wm-mono',
});
const marker = Permanent_Marker({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '400',
  variable: '--font-wm-marker',
});
const neon = Tilt_Neon({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-wm-neon',
});
const serif = Instrument_Serif({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '400',
  style: 'italic',
  variable: '--font-wm-serif',
});
const round = Fredoka({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '600',
  variable: '--font-wm-round',
});
const code = Space_Mono({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '700',
  variable: '--font-wm-code',
});
const block = Bungee({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  weight: '400',
  variable: '--font-wm-block',
});

export const wordmarkFontVars = [bubble, pixel, mono, marker, neon, serif, round, code, block]
  .map((f) => f.variable)
  .join(' ');
