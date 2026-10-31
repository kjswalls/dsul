/**
 * The Sounds extension's vocabulary: which moments make a sound, how they are
 * grouped for the switches, and which packs exist. No audio here (that is
 * lib/sounds/synth.ts, loaded only when a sound plays), so the settings
 * manifest, the console and the tests can all read it in node.
 *
 * Every sound is made in the browser from a few lines of Web Audio: no files,
 * nothing licensed, nothing copied (memory/plans/sounds.md). Pack and group
 * ids are stored in user_extensions.config, so they are permanent: rename the
 * label, never the id.
 */

export const SOUND_EVENTS = [
  'complete',
  'uncomplete',
  'add',
  'remove',
  'pickup',
  'drop',
  'open',
  'close',
  'nav',
  'timer',
  'daydone',
  'undo',
  'nope',
  'aiStart',
  'aiDone',
] as const;

export type SoundEvent = (typeof SOUND_EVENTS)[number];

/** What each sound is called in the console, and when it plays. */
export const SOUND_COPY: Record<SoundEvent, { label: string; when: string }> = {
  complete: { label: 'Tick off', when: 'A task or habit marked done' },
  uncomplete: { label: 'Untick', when: 'Changed your mind' },
  add: { label: 'Add', when: 'Something new lands in the planner or braindump' },
  remove: { label: 'Delete', when: 'Something leaves' },
  pickup: { label: 'Pick up', when: 'A drag starts' },
  drop: { label: 'Drop', when: 'It lands in its new spot' },
  open: { label: 'Open panel', when: 'An item or Ask opens' },
  close: { label: 'Close panel', when: 'It closes again' },
  nav: { label: 'Switch view', when: 'Day, week, list and the other views' },
  timer: { label: 'Timer done', when: 'A Do stuff sprint runs out' },
  daydone: { label: 'Day done', when: 'The last thing on today is ticked' },
  undo: { label: 'Undo', when: 'Something put back' },
  nope: { label: 'Nothing to undo', when: 'Undo with nothing left to take back' },
  aiStart: { label: 'AI started', when: 'You asked, and it is on it' },
  aiDone: { label: 'AI finished', when: 'Its reply lands' },
};

export interface SoundGroup {
  id: string;
  label: string;
  note: string;
  events: readonly SoundEvent[];
  /** What someone who never touched the switch gets. */
  defaultOn: boolean;
}

/**
 * The switches. Panels and views start off: a sound on every click is the
 * fastest way to make the whole extension feel busy.
 */
export const SOUND_GROUPS: readonly SoundGroup[] = [
  { id: 'tick', label: 'Ticking things off', note: 'Tick and untick', events: ['complete', 'uncomplete'], defaultOn: true },
  { id: 'edit', label: 'Adding and deleting', note: 'Anything new, anything gone', events: ['add', 'remove'], defaultOn: true },
  { id: 'move', label: 'Moving things', note: 'Pick up and drop', events: ['pickup', 'drop'], defaultOn: true },
  { id: 'panels', label: 'Panels and views', note: 'Open, close, switch. Busy, so off to start', events: ['open', 'close', 'nav'], defaultOn: false },
  { id: 'moments', label: 'Moments', note: 'Timer done, day done', events: ['timer', 'daydone'], defaultOn: true },
  { id: 'oops', label: 'Undo', note: 'Put back, or nothing to put back', events: ['undo', 'nope'], defaultOn: true },
  { id: 'ai', label: 'AI', note: 'Started on it, finished it', events: ['aiStart', 'aiDone'], defaultOn: true },
];

export function soundGroupOf(event: SoundEvent): SoundGroup {
  return SOUND_GROUPS.find((g) => g.events.includes(event))!;
}

export const SOUND_PACKS = [
  { id: 'silk', name: 'Silk', blurb: 'Pure, slow-blooming tones. Calm and a little luxe.' },
  { id: 'pebble', name: 'Pebble', blurb: 'Soft wooden clicks and small pitched notes.' },
  { id: 'felt', name: 'Felt', blurb: 'A muted piano with the lid down. Warm and close.' },
  { id: 'glass', name: 'Glass', blurb: 'Little chimes with some air around them.' },
  { id: 'paper', name: 'Paper', blurb: 'Barely there. Taps, page turns, a soft thump.' },
  { id: 'pixel', name: 'Pixel', blurb: 'A softened 8-bit pack, for fun.' },
  { id: 'relay', name: 'Relay', blurb: 'Deep synth bass, light-cycle passes and servo clicks.' },
] as const;

export type SoundPackId = (typeof SOUND_PACKS)[number]['id'];

export const DEFAULT_SOUND_PACK: SoundPackId = 'silk';

export function isSoundPackId(v: unknown): v is SoundPackId {
  return SOUND_PACKS.some((p) => p.id === v);
}

/** The keys this extension keeps in user_extensions.config. */
export const SOUNDS_CONFIG_PACK = 'pack';
export const SOUNDS_CONFIG_GROUPS = 'groups';

export interface SoundsConfig {
  pack: SoundPackId;
  groups: Record<string, boolean>;
}

/**
 * The stored config, read defensively: it is a jsonb a person's other devices
 * (and older builds) write too, so an unknown pack falls back to the default
 * and a group with no stored answer to its own default.
 */
export function readSoundsConfig(config: Record<string, unknown> | undefined): SoundsConfig {
  const pack = isSoundPackId(config?.[SOUNDS_CONFIG_PACK]) ? (config![SOUNDS_CONFIG_PACK] as SoundPackId) : DEFAULT_SOUND_PACK;
  const stored = config?.[SOUNDS_CONFIG_GROUPS];
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const groups: Record<string, boolean> = {};
  for (const g of SOUND_GROUPS) groups[g.id] = typeof saved[g.id] === 'boolean' ? (saved[g.id] as boolean) : g.defaultOn;
  return { pack, groups };
}
