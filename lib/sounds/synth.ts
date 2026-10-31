/**
 * The Sounds extension's synth: every pack, made live with Web Audio.
 *
 * Imported lazily by lib/sounds/cue.ts the first time a sound plays, so it
 * never loads for anyone with the extension off. Each sound is a few notes
 * and noise bursts through one shared chain: a pack's sounds → a dry bus and
 * a small room (a generated impulse) → the volume → a gentle compressor that
 * keeps two overlapping sounds from clipping.
 *
 * The packs were tuned with Kirby on a prototype page (2026-10-31; the
 * picks are recorded in memory/plans/sounds.md), so a number here is a
 * sound someone chose, not a placeholder. Change one by ear.
 */

import type { SoundEvent, SoundPackId } from './registry';

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode;
let bus: GainNode;
let wet: GainNode;
let noiseBuf: AudioBuffer;

function impulse(c: Ctx, sec: number, decay: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * sec);
  const b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

/** The context, made on first use. Null where the browser has no Web Audio. */
function audio(): Ctx | null {
  if (ctx) return ctx;
  const AC =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const c = new AC();
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  master = c.createGain();
  master.connect(comp);
  comp.connect(c.destination);
  bus = c.createGain();
  bus.connect(master);
  const room = c.createConvolver();
  room.buffer = impulse(c, 1.1, 3.2);
  wet = c.createGain();
  wet.connect(room);
  room.connect(master);
  noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  ctx = c;
  return c;
}

function route(node: AudioNode) {
  node.connect(bus);
  node.connect(wet);
}

interface Voice {
  f: number;
  /** Glide the pitch to this over `glide` (default the whole note). */
  f2?: number;
  glide?: number;
  type?: OscillatorType;
  a?: number;
  d?: number;
  g?: number;
  at?: number;
  /** A bell-like modulator: ratio to the pitch, and depth. */
  fm?: { ratio: number; index: number };
  /** Lowpass, optionally swept to lp2, with resonance lq. */
  lp?: number;
  lp2?: number;
  lq?: number;
  /** Stereo position, optionally travelling to pan2. */
  pan?: number;
  pan2?: number;
}

/** One pitched note. */
function v(c: Ctx, { f, f2, glide, type = 'sine', a = 0.003, d = 0.15, g = 0.2, at = 0, fm, lp, lp2, lq, pan, pan2 }: Voice) {
  const t = c.currentTime + 0.005 + at;
  const end = t + a + d;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + (glide || d));
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(g, t + a);
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  if (fm) {
    const m = c.createOscillator();
    m.frequency.value = f * fm.ratio;
    const mg = c.createGain();
    mg.gain.setValueAtTime(f * fm.index, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.02), end);
    m.connect(mg);
    mg.connect(o.frequency);
    m.start(t);
    m.stop(end + 0.05);
  }
  if (lp) {
    const fl = c.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.setValueAtTime(lp, t);
    if (lp2) fl.frequency.exponentialRampToValueAtTime(lp2, end);
    if (lq) fl.Q.value = lq;
    o.connect(fl);
    fl.connect(env);
  } else {
    o.connect(env);
  }
  if (pan != null && c.createStereoPanner) {
    const pn = c.createStereoPanner();
    pn.pan.setValueAtTime(pan, t);
    if (pan2 != null) pn.pan.linearRampToValueAtTime(pan2, end);
    env.connect(pn);
    route(pn);
  } else {
    route(env);
  }
  o.start(t);
  o.stop(end + 0.05);
}

interface Noise {
  f?: number;
  f2?: number;
  q?: number;
  type?: BiquadFilterType;
  a?: number;
  d?: number;
  g?: number;
  at?: number;
}

/** A filtered noise burst: clicks, taps, page turns, whooshes. */
function n(c: Ctx, { f = 3000, f2, q = 1, type = 'bandpass', a = 0.001, d = 0.03, g = 0.15, at = 0 }: Noise) {
  const t = c.currentTime + 0.005 + at;
  const end = t + a + d;
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const fl = c.createBiquadFilter();
  fl.type = type;
  fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, end);
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(g, t + a);
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  s.connect(fl);
  fl.connect(env);
  route(env);
  s.start(t, Math.random() * 0.5);
  s.stop(end + 0.05);
}

type Pack = { space: number } & Record<SoundEvent, (c: Ctx) => void>;

/* ── instruments ───────────────────────────────────────────────────────── */

const pluck = (c: Ctx, f: number, at = 0, g = 0.25) => {
  v(c, { f, at, d: 0.13, g, lp: 3600 });
  v(c, { f: f * 2, type: 'triangle', at, d: 0.05, g: g * 0.22, lp: 3600 });
  n(c, { f: 4200, q: 1.5, at, d: 0.007, g: g * 0.35 });
};
const bell = (c: Ctx, f: number, at = 0, g = 0.15, d = 0.9) => {
  v(c, { f, at, d, g });
  v(c, { f: f * 2.76, at, d: d * 0.28, g: g * 0.22 });
  v(c, { f: f * 5.4, at, d: d * 0.09, g: g * 0.08 });
};
// Glass at the softness Kirby asked for: 80% level, a gentler bell, the top rolled off.
const chime = (c: Ctx, f: number, at = 0, g = 0.12, d = 0.4) => {
  v(c, { f, at, a: 0.005, d, g: g * 0.8, fm: { ratio: 3.5, index: 1.15 }, lp: 6500 });
  v(c, { f: f * 2, at, a: 0.005, d: d * 0.3, g: g * 0.12, lp: 6500 });
};
const tap = (c: Ctx, f: number, at = 0, g = 0.2, d = 0.02) => {
  n(c, { f, q: 2.2, at, d, g });
  v(c, { f: f / 8, at, d: 0.04, g: g * 0.35 });
};
const sq = (c: Ctx, f: number, at = 0, d = 0.07, g = 0.06) => v(c, { f, type: 'square', at, d, g, lp: 2600 });
const silk = (c: Ctx, f: number, at = 0, g = 0.12, d = 0.45) => {
  v(c, { f, at, a: 0.012, d, g, lp: 2600 });
  v(c, { f: f * 2, at, a: 0.008, d: d * 0.4, g: g * 0.12 });
  v(c, { f: f * 3, at, a: 0.006, d: d * 0.15, g: g * 0.035 });
};
const key = (c: Ctx, f: number, at = 0, g = 0.13, d = 0.35) => {
  v(c, { f, type: 'triangle', at, a: 0.004, d, g, lp: 1400 });
  v(c, { f, at, a: 0.004, d: d * 1.7, g: g * 0.55 });
  n(c, { f: 600, type: 'lowpass', q: 0.7, at, d: 0.015, g: g * 0.25 });
};
// Relay's grid synth: clean pings, detuned saw bass under a closing filter,
// light-cycle passes that travel left to right, servo click trains.
const ping = (c: Ctx, f: number, at = 0, g = 0.06, d = 0.08) => {
  v(c, { f, at, a: 0.002, d, g });
  v(c, { f, type: 'square', at, a: 0.002, d: d * 0.7, g: g * 0.35, lp: 2400 });
};
const bass = (c: Ctx, f: number, at = 0, g = 0.09, d = 0.25, open = 1400) => {
  v(c, { f, type: 'sawtooth', at, a: 0.006, d, g, lp: open, lp2: 90, lq: 4 });
  v(c, { f: f * 1.007, type: 'sawtooth', at, a: 0.006, d, g: g * 0.8, lp: open, lp2: 90, lq: 4 });
  v(c, { f: f / 2, at, a: 0.01, d: d * 1.2, g: g * 1.1 });
};
const cycle = (c: Ctx, f1: number, f2: number, at = 0, g = 0.05, d = 0.3, dir = 1) => {
  const o: Voice = { f: f1, f2, glide: d, type: 'sawtooth', at, a: 0.03, d, lp: 300, lp2: 3200, lq: 9, pan: -0.8 * dir, pan2: 0.8 * dir };
  v(c, { ...o, g });
  v(c, { ...o, f: f1 * 1.01, f2: f2 * 1.01, g: g * 0.7 });
  v(c, { f: f1 / 2, f2: f2 / 2, glide: d, at, a: 0.04, d, g: g * 1.2 });
};
const servo = (c: Ctx, at = 0, up = true, clicks = 5, g = 0.1) => {
  for (let i = 0; i < clicks; i++) {
    n(c, { f: up ? 2200 + i * 500 : 4200 - i * 500, q: 3, at: at + i * 0.018, d: 0.006, g: g * (0.6 + 0.4 * Math.random()) });
  }
  v(c, { f: up ? 480 : 900, f2: up ? 900 : 420, type: 'square', at, a: 0.01, d: clicks * 0.018 + 0.03, g: g * 0.22, lp: 1600 });
};

/* ── packs ─────────────────────────────────────────────────────────────── */

const PACKS: Record<SoundPackId, Pack> = {
  silk: {
    space: 0.22,
    complete: (c) => { silk(c, 659, 0, 0.14); silk(c, 988, 0.08, 0.12, 0.55); },
    uncomplete: (c) => { silk(c, 988, 0, 0.08, 0.3); silk(c, 659, 0.07, 0.07, 0.35); },
    add: (c) => silk(c, 880, 0, 0.1, 0.3),
    remove: (c) => silk(c, 523, 0, 0.08, 0.25),
    pickup: (c) => silk(c, 784, 0, 0.06, 0.12),
    drop: (c) => { silk(c, 392, 0, 0.09, 0.25); silk(c, 587, 0.02, 0.035, 0.2); },
    open: (c) => { n(c, { f: 600, f2: 1800, q: 0.8, a: 0.05, d: 0.18, g: 0.035 }); silk(c, 1175, 0.08, 0.03, 0.3); },
    close: (c) => n(c, { f: 1800, f2: 600, q: 0.8, a: 0.04, d: 0.14, g: 0.03 }),
    nav: (c) => v(c, { f: 1568, a: 0.004, d: 0.05, g: 0.035 }),
    undo: (c) => { silk(c, 880, 0, 0.09, 0.25); silk(c, 659, 0.07, 0.08, 0.3); },
    nope: (c) => { silk(c, 466, 0, 0.07, 0.18); silk(c, 440, 0.11, 0.06, 0.22); },
    timer: (c) => [698, 880, 1047, 1319].forEach((f, i) => silk(c, f, i * 0.12, 0.09, 1.2)),
    daydone: (c) => { [523, 659, 784, 988, 1175, 1319].forEach((f, i) => silk(c, f, i * 0.08, 0.075, 1.4)); silk(c, 1568, 0.5, 0.05, 2); },
    aiStart: (c) => { silk(c, 1175, 0, 0.05, 0.3); silk(c, 1480, 0.07, 0.045, 0.35); },
    aiDone: (c) => { silk(c, 880, 0, 0.08, 0.9); silk(c, 1319, 0.1, 0.07, 1.1); },
  },
  pebble: {
    space: 0.14,
    complete: (c) => { v(c, { f: 600, f2: 1200, glide: 0.05, d: 0.06, g: 0.1 }); pluck(c, 1568, 0.05, 0.12); },
    uncomplete: (c) => { pluck(c, 1175, 0, 0.13); pluck(c, 784, 0.065, 0.11); },
    add: (c) => { v(c, { f: 520, f2: 1040, glide: 0.05, d: 0.1, g: 0.2 }); n(c, { f: 5000, d: 0.006, g: 0.07 }); },
    remove: (c) => v(c, { f: 620, f2: 300, glide: 0.07, d: 0.09, g: 0.17 }),
    pickup: (c) => v(c, { f: 440, f2: 660, glide: 0.06, type: 'triangle', d: 0.07, g: 0.12, lp: 2500 }),
    drop: (c) => { v(c, { f: 260, f2: 200, d: 0.07, g: 0.15 }); n(c, { f: 700, q: 1.2, d: 0.02, g: 0.05 }); },
    open: (c) => { n(c, { f: 700, f2: 2600, q: 1.2, a: 0.03, d: 0.13, g: 0.07 }); v(c, { f: 1320, at: 0.06, d: 0.08, g: 0.04 }); },
    close: (c) => { n(c, { f: 2600, f2: 700, q: 1.2, a: 0.02, d: 0.11, g: 0.06 }); v(c, { f: 990, at: 0.05, d: 0.06, g: 0.035 }); },
    nav: (c) => { n(c, { f: 5200, q: 2, d: 0.005, g: 0.2 }); v(c, { f: 1760, d: 0.025, g: 0.05 }); },
    undo: (c) => { pluck(c, 1175, 0, 0.17); pluck(c, 880, 0.06, 0.15); },
    nope: (c) => { v(c, { f: 392, d: 0.12, g: 0.11, lp: 1800 }); v(c, { f: 392, at: 0.11, d: 0.12, g: 0.09, lp: 1800 }); },
    timer: (c) => { bell(c, 1047, 0); bell(c, 1319, 0.15); bell(c, 1568, 0.3, 0.15, 1.3); },
    daydone: (c) => { [784, 880, 1047, 1319, 1568].forEach((f, i) => bell(c, f, i * 0.075, 0.11, 0.55)); bell(c, 2093, 0.42, 0.07, 1.4); },
    aiStart: (c) => [1047, 1319, 1568].forEach((f, i) => pluck(c, f, i * 0.05, 0.09 - i * 0.01)),
    aiDone: (c) => { bell(c, 1319, 0, 0.1, 0.7); bell(c, 1976, 0.09, 0.08, 0.9); },
  },
  felt: {
    space: 0.16,
    complete: (c) => { key(c, 523, 0, 0.13); key(c, 784, 0.065, 0.12); },
    uncomplete: (c) => { key(c, 659, 0, 0.09); key(c, 523, 0.06, 0.08); },
    add: (c) => key(c, 880, 0, 0.11, 0.25),
    remove: (c) => key(c, 440, 0, 0.09, 0.25),
    pickup: (c) => key(c, 659, 0, 0.06, 0.12),
    drop: (c) => key(c, 262, 0, 0.11, 0.3),
    open: (c) => { n(c, { f: 400, f2: 1200, q: 0.8, a: 0.04, d: 0.15, g: 0.04 }); key(c, 1047, 0.06, 0.04, 0.2); },
    close: (c) => n(c, { f: 1200, f2: 400, q: 0.8, a: 0.03, d: 0.12, g: 0.035 }),
    nav: (c) => key(c, 1319, 0, 0.045, 0.06),
    undo: (c) => { key(c, 784, 0, 0.09); key(c, 587, 0.06, 0.08); },
    nope: (c) => { key(c, 311, 0, 0.08, 0.15); key(c, 311, 0.12, 0.07, 0.15); },
    timer: (c) => [523, 659, 784, 1047].forEach((f, i) => key(c, f, i * 0.13, 0.1, 0.7)),
    daydone: (c) => { [523, 659, 784, 988, 1047, 1319].forEach((f, i) => key(c, f, i * 0.09, 0.09, 0.6)); key(c, 1568, 0.56, 0.07, 1.2); },
    aiStart: (c) => [1047, 1175, 1319].forEach((f, i) => key(c, f, i * 0.06, 0.05, 0.15)),
    aiDone: (c) => { key(c, 784, 0, 0.09, 0.6); key(c, 1175, 0.08, 0.08, 0.7); },
  },
  glass: {
    space: 0.26,
    complete: (c) => { chime(c, 1568, 0, 0.13, 0.35); chime(c, 2349, 0.06, 0.11, 0.5); },
    uncomplete: (c) => { chime(c, 1760, 0, 0.08, 0.25); chime(c, 1319, 0.05, 0.07, 0.3); },
    add: (c) => chime(c, 2093, 0, 0.11, 0.25),
    remove: (c) => chime(c, 1175, 0, 0.09, 0.2),
    pickup: (c) => chime(c, 1760, 0, 0.06, 0.12),
    drop: (c) => chime(c, 1319, 0, 0.11, 0.3),
    open: (c) => { n(c, { f: 2000, f2: 6000, type: 'highpass', q: 0.7, a: 0.04, d: 0.18, g: 0.035 }); chime(c, 2637, 0.08, 0.05, 0.3); },
    close: (c) => n(c, { f: 6000, f2: 2000, type: 'highpass', q: 0.7, a: 0.03, d: 0.15, g: 0.03 }),
    nav: (c) => chime(c, 3136, 0, 0.045, 0.06),
    undo: (c) => { chime(c, 2349, 0, 0.1, 0.2); chime(c, 1760, 0.06, 0.1, 0.3); },
    nope: (c) => { chime(c, 740, 0, 0.1, 0.18); chime(c, 698, 0.1, 0.1, 0.25); },
    timer: (c) => [1568, 1976, 2349].forEach((f, i) => chime(c, f, i * 0.18, 0.12, 1.2)),
    daydone: (c) => [1568, 1760, 2093, 2349, 2637, 3136].forEach((f, i) => chime(c, f, i * 0.06, 0.09, 1)),
    aiStart: (c) => [2349, 2637, 3136].forEach((f, i) => chime(c, f, i * 0.05, 0.06, 0.2)),
    aiDone: (c) => { chime(c, 1976, 0, 0.1, 0.8); chime(c, 2637, 0.1, 0.09, 1); },
  },
  paper: {
    space: 0.05,
    complete: (c) => { tap(c, 2400, 0, 0.24); tap(c, 3200, 0.05, 0.19); v(c, { f: 660, d: 0.06, g: 0.04 }); },
    uncomplete: (c) => { tap(c, 1400, 0, 0.17); v(c, { f: 440, d: 0.08, g: 0.045 }); },
    add: (c) => n(c, { f: 1200, f2: 3000, q: 1.4, a: 0.02, d: 0.06, g: 0.13 }),
    remove: (c) => n(c, { f: 3000, f2: 900, q: 1.4, a: 0.02, d: 0.06, g: 0.11 }),
    pickup: (c) => tap(c, 1500, 0, 0.12),
    drop: (c) => tap(c, 1100, 0, 0.11, 0.03),
    open: (c) => n(c, { f: 500, f2: 1500, q: 0.7, a: 0.05, d: 0.16, g: 0.08 }),
    close: (c) => n(c, { f: 1500, f2: 500, q: 0.7, a: 0.04, d: 0.13, g: 0.07 }),
    nav: (c) => tap(c, 4200, 0, 0.17, 0.006),
    undo: (c) => { tap(c, 2000, 0, 0.15); tap(c, 1500, 0.05, 0.15); },
    nope: (c) => { v(c, { f: 180, d: 0.07, g: 0.24 }); v(c, { f: 180, at: 0.1, d: 0.07, g: 0.2 }); },
    timer: (c) => { v(c, { f: 880, d: 0.5, g: 0.07 }); v(c, { f: 1320, at: 0.2, d: 0.7, g: 0.06 }); },
    daydone: (c) => { [1800, 2200, 2700, 3300].forEach((f, i) => tap(c, f, i * 0.06, 0.14)); v(c, { f: 1047, at: 0.24, d: 1, g: 0.05 }); },
    aiStart: (c) => { n(c, { f: 800, f2: 2400, q: 1.2, a: 0.02, d: 0.08, g: 0.08 }); tap(c, 3000, 0.1, 0.1, 0.012); tap(c, 3400, 0.16, 0.09, 0.012); },
    aiDone: (c) => { tap(c, 2600, 0, 0.16); v(c, { f: 1047, at: 0.02, d: 0.5, g: 0.045 }); },
  },
  pixel: {
    space: 0.08,
    complete: (c) => { sq(c, 988, 0, 0.06); sq(c, 1319, 0.06, 0.1); },
    uncomplete: (c) => { sq(c, 659, 0, 0.05); sq(c, 494, 0.05, 0.08); },
    add: (c) => v(c, { f: 440, f2: 880, glide: 0.06, type: 'square', d: 0.07, g: 0.055, lp: 2800 }),
    remove: (c) => v(c, { f: 660, f2: 220, type: 'square', d: 0.08, g: 0.055, lp: 2800 }),
    pickup: (c) => sq(c, 784, 0, 0.04, 0.05),
    drop: (c) => sq(c, 392, 0, 0.06),
    open: (c) => v(c, { f: 330, f2: 990, glide: 0.1, type: 'square', d: 0.1, g: 0.04, lp: 2600 }),
    close: (c) => v(c, { f: 990, f2: 330, glide: 0.1, type: 'square', d: 0.1, g: 0.04, lp: 2600 }),
    nav: (c) => sq(c, 1568, 0, 0.02, 0.04),
    undo: (c) => { sq(c, 1047, 0, 0.05); sq(c, 784, 0.05, 0.07); },
    nope: (c) => {
      v(c, { f: 110, type: 'sawtooth', d: 0.09, g: 0.08, lp: 1200 });
      v(c, { f: 110, type: 'sawtooth', at: 0.11, d: 0.09, g: 0.07, lp: 1200 });
    },
    timer: (c) => [1047, 1319, 1568, 2093].forEach((f, i) => sq(c, f, i * 0.09, 0.1)),
    daydone: (c) => { [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => sq(c, f, i * 0.07, 0.08, 0.05)); sq(c, 2093, 0.58, 0.3, 0.05); },
    aiStart: (c) => [1319, 1568, 1760].forEach((f, i) => sq(c, f, i * 0.04, 0.04, 0.04)),
    aiDone: (c) => { sq(c, 1568, 0, 0.12, 0.05); sq(c, 2093, 0.07, 0.16, 0.05); },
  },
  relay: {
    space: 0.2,
    complete: (c) => { bass(c, 82, 0, 0.07, 0.2); ping(c, 988, 0, 0.06); ping(c, 1480, 0.06, 0.06); },
    uncomplete: (c) => { ping(c, 1480, 0, 0.05); ping(c, 988, 0.06, 0.045, 0.1); },
    add: (c) => { cycle(c, 180, 360, 0, 0.04, 0.16); ping(c, 1976, 0.13, 0.035, 0.05); },
    remove: (c) => cycle(c, 360, 150, 0, 0.04, 0.16, -1),
    pickup: (c) => servo(c, 0, true, 4, 0.09),
    drop: (c) => { servo(c, 0, false, 3, 0.08); bass(c, 55, 0.05, 0.08, 0.16, 700); },
    open: (c) => cycle(c, 110, 220, 0, 0.045, 0.32),
    close: (c) => cycle(c, 220, 110, 0, 0.04, 0.26, -1),
    nav: (c) => ping(c, 2637, 0, 0.035, 0.03),
    undo: (c) => servo(c, 0, false, 4, 0.08),
    nope: (c) => {
      v(c, { f: 55, type: 'square', d: 0.09, g: 0.09, lp: 320 });
      v(c, { f: 55, type: 'square', at: 0.12, d: 0.09, g: 0.08, lp: 320 });
    },
    timer: (c) => [659, 784, 988, 1319].forEach((f, i) => { bass(c, 82, i * 0.16, 0.05, 0.12, 900); ping(c, f, i * 0.16, 0.05, 0.1); }),
    daydone: (c) => {
      cycle(c, 82, 330, 0, 0.05, 0.9);
      [659, 988, 1319, 1976].forEach((f, i) => ping(c, f, 0.35 + i * 0.08, 0.05, 0.25));
      bass(c, 41, 0.7, 0.1, 0.9, 600);
    },
    // Powering up: a bass swell opening from underneath, a servo spinning up on top.
    aiStart: (c) => {
      v(c, { f: 55, type: 'sawtooth', a: 0.18, d: 0.45, g: 0.07, lp: 120, lp2: 1100, lq: 6 });
      v(c, { f: 55.4, type: 'sawtooth', a: 0.18, d: 0.45, g: 0.05, lp: 120, lp2: 1100, lq: 6 });
      v(c, { f: 27.5, a: 0.18, d: 0.5, g: 0.09 });
      servo(c, 0.12, true, 5, 0.06);
    },
    // Landed: a bass hit that drops away, and a clean two-note ping over it.
    aiDone: (c) => {
      v(c, { f: 82, f2: 41, glide: 0.3, a: 0.004, d: 0.5, g: 0.13 });
      bass(c, 82, 0, 0.08, 0.45, 1800);
      ping(c, 988, 0.03, 0.05, 0.3);
      ping(c, 1480, 0.1, 0.05, 0.45);
    },
  },
};

/**
 * Play one sound from one pack at `volume` (0 to 1, already curved). Never
 * throws: a browser that refuses audio just stays quiet.
 */
export function playSynth(pack: SoundPackId, event: SoundEvent, volume: number): void {
  try {
    const c = audio();
    if (!c) return;
    if (c.state === 'suspended') void c.resume().catch(() => {});
    const p = PACKS[pack] ?? PACKS.silk;
    master.gain.setTargetAtTime(volume, c.currentTime, 0.01);
    wet.gain.setTargetAtTime(p.space, c.currentTime, 0.01);
    p[event](c);
  } catch (err) {
    console.warn('[sounds]', err);
  }
}
