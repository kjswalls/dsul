import {
  CalendarRange,
  Flame,
  FolderCog,
  HandCoins,
  LineChart,
  MessageSquare,
  PartyPopper,
  PhoneCall,
  Speaker,
  Target,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * The official extensions catalog — dsul's declarative "plugin" surface.
 *
 * An extension is optional, first-party, extended functionality a user toggles
 * per-account in Settings → Extensions. This registry is the manifest list the
 * plan doc (memory/plans/plugins-themes-store.md, Project B) calls for: adding
 * an extension means adding config here, a gate at its surface, and nothing
 * else. No third-party code executes — "extensions" are declarative by locked
 * decision. Your OWN code is a separate, planned surface: private mods and
 * recipes (memory/plans/mods.md, unbuilt) will live in Settings → Make, never
 * in this catalog.
 *
 * Enabled state lives in the user_extensions table (migration 026) as sparse
 * per-user rows; a slug with no row falls back to defaultEnabled here. Slugs
 * are permanent identifiers (they are the DB rows and the settings deep links)
 * — rename the label, never the slug.
 */
export interface ExtensionManifest {
  /** Permanent machine name — lowercase slug, mirrors user_extensions.slug. */
  slug: string;
  name: string;
  /** One line, user-facing, shown under the settings toggle. */
  description: string;
  icon: LucideIcon;
  category: 'habits' | 'views' | 'integrations' | 'fun' | 'planning';
  /** What a user who never touched the toggle gets. Extensions are opt-in. */
  defaultEnabled: boolean;

  /* ── The store's copy (/extensions, and the header of each extension pane) ──
     Required, so an extension cannot reach the store half-described. */

  /** A few words for the store card, under the name. */
  tagline: string;
  /** Which store shelf it sits on — what it does FOR you, not how it's built
   *  (`category` above is the build-side grouping; the two differ on purpose). */
  shelf: ExtensionShelf;
  /** Outside things it can't work without, as chips ("Twilio account"). */
  needs?: string[];
  /** Why it can cost real money: a stake you can lose, or a provider's per-use bill. */
  costs?: 'stake' | 'usage';
  /** One to three plain lines on what turning it on changes. */
  whatChanges: string[];
  /** The maker's note: why it exists, in two sentences. The store's only
   *  "review" until there are enough people for a kept-on rate to mean anything. */
  makerNote: string;
}

export type ExtensionShelf = 'plan' | 'habits' | 'reach' | 'stakes';

/**
 * Ideas, not peripherals (Tier 0) — the first two entries that gate what dsul
 * MEANS rather than what it TOUCHES.
 *
 * Everything else in this catalog is a peripheral: a heatmap, a burst of
 * confetti, six ways to reach out of the app. "The Weight of dsul" found the
 * registry was gating only those, so a brand-new account arrived holding the
 * entire conceptual model — goals, seasons, routines, two rituals and a
 * twelve-section console — on day one. These two are the first half of the
 * answer, and they are the two the audit named as safest to cut first: goals
 * were built as a role that deliberately reaches nothing downstream, and the
 * console is one self-contained surface.
 *
 * OFF is INERT, NOT HIDDEN, and that is the whole design (Kirby, 2026-08-26):
 * "off means inert, but still findable. Like an extension store." A switched-off
 * extension keeps its catalog row, its settings pane and its search hits — every
 * one of these slugs is in OFFICIAL_EXTENSIONS below, which is what generates
 * all three. Only the BEHAVIOUR stops. What that means per surface is stated at
 * each gate and gathered in lib/extension-gates.ts.
 *
 * They split on the default now. GOALS still defaults off, for the reason the
 * channels do not share: a concept you have not met is weight you carry for
 * nothing. ORGANIZE defaults ON as of 2026-08-28 — the console was reworked to
 * be approachable rather than a wall of sections, so it stopped being weight and
 * started being the obvious home for the structure a user already has. Each
 * entry's `defaultEnabled` note carries the specifics, and — because the
 * fallback is evaluated per read — flipping Organize on reaches every account
 * with no saved row for it, existing and new, no migration.
 */
export const EXT_GOALS = 'goals';
export const EXT_ORGANIZE = 'organize';

/**
 * Streaks (default ON) — the one entry that ships enabled, and the reason the
 * `safeEnabled` fallback in lib/extension-gates.ts bothers to tell the manifest
 * default apart from a hard `false`.
 *
 * It defaults ON because it is not a new idea a fresh account has to grow into;
 * it is a core habit mechanic that has always been visible, and defaulting it
 * off would silently strip the flame from every account that already reads one.
 * So this toggle ADDS an off switch rather than gating a feature in: turn it off
 * and every flame, streak count and reset control disappears, while the counter
 * itself keeps moving — reminders and stakes read `counters.streak`, not this,
 * so a streak-at-risk call still rings and a Beeminder datapoint still posts.
 * What stops is only what dsul SHOWS you — the same browser-only asymmetry the
 * goals gates make (see lib/extension-gates.ts).
 */
export const EXT_STREAKS = 'streaks';

/**
 * Do stuff (default ON) — the braindump sorted by size, walked quick-first.
 *
 * An idea rather than a peripheral, like Organize, and on by default for the
 * same reason Organize is: it costs nothing until it is used. A braindump that
 * has not grown past a handful of rows, and has nothing sized, draws exactly as
 * it did before this existed; the one "do stuff" row appears only once the list
 * is long enough to need it (DO_STUFF_MIN_OPEN in lib/do-stuff.ts), and a size
 * shows on a row only after the user gave it one.
 *
 * Off is inert, as everywhere here: the row, the size dots and the menu go,
 * the braindump is exactly the old list, and every stored size stays on its
 * item, so switching back on brings them all back.
 */
export const EXT_DO_STUFF = 'do-stuff';

export const EXT_HABIT_HEATMAP = 'habit-heatmap';
export const EXT_COMPLETION_CONFETTI = 'completion-confetti';
/**
 * Reminder delivery channels (Tier 2).
 *
 * Each slug is BOTH the extension's identity here and the channel's slug in
 * lib/reminders/channels — see the note on NudgeChannel.slug for why those are
 * deliberately the same string rather than a short internal name and a pretty
 * external one.
 *
 * All three default OFF, and that is not the usual caution about new features:
 * these reach out of the app and into a room or a phone, and two of them spend
 * the user's money. An integration that could ring you should never arrive
 * already able to.
 */
export const EXT_VOICE_ANNOUNCEMENTS = 'voice-announcements';
export const EXT_SMS_NUDGE = 'sms-nudge';
export const EXT_PHONE_CALL = 'phone-call';

/**
 * Stakes (Tier 3) — what a finished day is worth.
 *
 * These do not deliver anything at the moment a habit is due; they settle the
 * day afterwards and report it somewhere with consequences attached. Off by
 * default for a sharper version of the Tier 2 reason: one of them can cost real
 * money, and none of them should be able to start doing that because a toggle
 * defaulted on.
 */
export const EXT_BEEMINDER = 'beeminder';
export const EXT_PLEDGE = 'pledge';
export const EXT_ACCOUNTABILITY_PARTNER = 'accountability-partner';

export const OFFICIAL_EXTENSIONS: ExtensionManifest[] = [
  {
    slug: EXT_GOALS,
    name: 'Goals',
    // Says what it costs as well as what it buys. A goal is a third container
    // role on top of projects and routines, and someone who has not asked for
    // one should be able to read this row and decide they do not want it.
    description:
      'Long-term goals with milestones and check-ins, plus a Goal filter and grouping. A goal hides nothing. It only says why work matters.',
    icon: Target,
    category: 'planning',
    defaultEnabled: false,
    tagline: 'Say why the work matters',
    shelf: 'plan',
    whatChanges: [
      'Goals join Organize, with milestones and check-ins as ordinary items.',
      'An item can say which goal it serves.',
      'The display menu gains a Goal filter and grouping.',
    ],
    makerNote:
      'A goal is a third kind of container on top of projects and routines, so it stays off until you want one. It hides nothing; it only says why the work matters.',
  },
  {
    slug: EXT_ORGANIZE,
    name: 'Organize console',
    description:
      'One console for bulk container management: routines, seasons, projects, item types, habit groups and the trash.',
    icon: FolderCog,
    category: 'planning',
    // Defaults ON since the console was made approachable (2026-08-28): a warm
    // welcome per section, a silhouette per rail row, inline creation, and an
    // Overview that greets a first open. The "Weight of dsul" verdict was that
    // it arrived as twelve sections of weight; once it stopped being that, the
    // reason to hide it went too. The fallback is per-read, so this reaches every
    // account with no saved toggle — existing and new alike. Goals below stays
    // OFF: it is the larger concept, and the audit named it safest to keep opt-in.
    defaultEnabled: true,
    tagline: 'Every container in one place',
    shelf: 'plan',
    whatChanges: [
      'Routines, seasons, projects, item types and the trash in one console, plus goals when Goals is on.',
      'Opens from ⌘K and the sidebar.',
    ],
    makerNote:
      'It started life as twelve sections of weight, which is why it used to be off. Once every section learned to welcome you, it became the obvious home for the structure you already have.',
  },
  {
    slug: EXT_DO_STUFF,
    name: 'Do stuff',
    description:
      'Sort the braindump by size and walk the quick ones first. A size is your call, made once and kept.',
    icon: Zap,
    category: 'planning',
    // ON by default: see EXT_DO_STUFF above. It adds nothing to a short or
    // unsized braindump, so there is no weight to opt into.
    defaultEnabled: true,
    tagline: 'Get the pile moving',
    shelf: 'plan',
    whatChanges: [
      'A "do stuff" row above the braindump once it gets long.',
      'Turn it on and the list sorts into quick, errands, big and fuzzy, with the next thing lifted to the top.',
      'Hover a row to give it a size.',
    ],
    makerNote:
      'Fifteen undated things all look the same weight, so none of them gets picked. Splitting off the quick ones is usually all it takes to start.',
  },
  {
    slug: EXT_STREAKS,
    name: 'Streaks',
    // Says what stays behind. The whole point of an off switch here is to quiet
    // the guilt of a broken chain, so the row has to promise that quieting the
    // display does not quietly stop the reminders or stakes that count on it.
    description:
      'Flame badges and streak counts across the app. Turn it off to hide them. Your streaks keep counting for reminders and stakes.',
    icon: Flame,
    category: 'habits',
    defaultEnabled: true,
    tagline: 'Keep the chain visible',
    shelf: 'habits',
    whatChanges: [
      'A flame and a count on every habit with a streak.',
      'Turning it off hides them everywhere. Your streaks keep counting for reminders and stakes.',
    ],
    makerNote:
      'The off switch is here to quiet the guilt of a broken chain. Hiding the flame never stops the reminders or stakes that count on it.',
  },
  {
    slug: EXT_HABIT_HEATMAP,
    name: 'Habit heatmap',
    description: 'A six-month completion grid in the item panel for anything with a streak.',
    icon: CalendarRange,
    category: 'habits',
    defaultEnabled: false,
    tagline: 'Six months at a glance',
    shelf: 'habits',
    whatChanges: [
      'A six-month grid in the item panel for anything with a streak.',
      'Each filled square is a day you did it.',
    ],
    makerNote:
      'A streak tells you about today. The grid tells you about the season, which is usually the more honest story.',
  },
  {
    slug: EXT_COMPLETION_CONFETTI,
    name: 'Completion confetti',
    description: 'A small burst when you complete something. Purely celebratory.',
    icon: PartyPopper,
    category: 'fun',
    defaultEnabled: false,
    tagline: 'A small burst when you finish',
    shelf: 'habits',
    whatChanges: [
      'A small burst when you tick something off.',
      'Nothing else changes, and it stays still when animations are off.',
    ],
    makerNote: 'Purely celebratory. Some days a tiny party is the whole reason to tick the box.',
  },
  {
    slug: EXT_VOICE_ANNOUNCEMENTS,
    name: 'Speak reminders aloud',
    // Says what it needs, because the setting is useless without it and finding
    // that out three screens later is the worst version of this.
    description: 'Reads reminders through your Home Assistant speakers. Needs a Home Assistant URL and token.',
    icon: Speaker,
    category: 'integrations',
    defaultEnabled: false,
    tagline: 'Hear it from the kitchen',
    shelf: 'reach',
    needs: ['Home Assistant'],
    whatChanges: [
      'Reminders are read aloud on the Home Assistant speakers you pick.',
      'Each is one short spoken line: the habit, and how many days you have kept it up.',
    ],
    makerNote:
      'A reminder you hear from across the room is harder to swipe away than one on a lock screen. Your Home Assistant has to be reachable from the internet, because dsul calls it from its own server.',
  },
  {
    slug: EXT_SMS_NUDGE,
    name: 'Text me',
    description: 'Sends reminders as a text message through Twilio. Needs a Twilio account.',
    icon: MessageSquare,
    category: 'integrations',
    defaultEnabled: false,
    tagline: 'Reminders by text',
    shelf: 'reach',
    needs: ['Twilio account'],
    costs: 'usage',
    whatChanges: [
      'Reminders arrive as a text message, sent from your own Twilio number.',
      'Twilio bills you for each message.',
    ],
    makerNote:
      'For the reminders that need to cut through a muted phone. It sends through your own Twilio account, so the cost is yours to see.',
  },
  {
    slug: EXT_PHONE_CALL,
    name: 'Call me',
    // Names the default out loud. A channel that rings a phone must not leave
    // anyone guessing how often it will.
    description: 'Rings you through Twilio. Last call only unless you change it, since a call for every reminder is a lot.',
    icon: PhoneCall,
    category: 'integrations',
    defaultEnabled: false,
    tagline: 'A last call that rings',
    shelf: 'reach',
    needs: ['Twilio account'],
    costs: 'usage',
    whatChanges: [
      'Your phone rings for the streak-at-risk last call.',
      'A call for every reminder is possible, but off unless you change it.',
    ],
    makerNote:
      'A call for every reminder is a lot, so it rings for the last call only unless you change it. That is the moment a ringing phone earns its place.',
  },
  {
    slug: EXT_BEEMINDER,
    name: 'Beeminder',
    description: 'Posts each completed habit to a Beeminder goal, where missing costs real money.',
    icon: LineChart,
    category: 'habits',
    defaultEnabled: false,
    tagline: 'Put money on the habit',
    shelf: 'stakes',
    needs: ['Beeminder account'],
    costs: 'stake',
    whatChanges: [
      'Ticking a habit posts a datapoint to its Beeminder goal right away.',
      'A nightly settlement catches anything ticked away from a browser.',
      'Every post lands in your ledger.',
    ],
    makerNote:
      'A datapoint that arrives after midnight arrives after the money is gone, so this posts the moment you tick. The nightly settlement is only the backstop.',
  },
  {
    slug: EXT_PLEDGE,
    name: 'Pledge',
    // The limitation is IN the description, not buried in a doc. A commitment
    // device that seems to collect and does not is worse than none, because you
    // keep trusting it — so the one sentence everyone reads has to say it.
    description:
      'Records what each miss costs, payable to a cause you can’t stand. dsul keeps the ledger but cannot take payment.',
    icon: HandCoins,
    category: 'habits',
    defaultEnabled: false,
    tagline: 'Keep a ledger of misses',
    shelf: 'stakes',
    whatChanges: [
      'Each missed day records what it costs, payable to a cause you can’t stand.',
      'dsul keeps the ledger. It cannot take payment.',
    ],
    makerNote:
      'A commitment device that seems to collect and doesn’t is worse than none, because you keep trusting it. So it says so up front, and what it gives you is an honest ledger.',
  },
  {
    slug: EXT_ACCOUNTABILITY_PARTNER,
    name: 'Accountability partner',
    description: 'Sends a short daily digest to a Slack or Discord webhook. Someone expecting it is the point.',
    icon: Users,
    category: 'habits',
    defaultEnabled: false,
    tagline: 'Someone reads your day',
    shelf: 'stakes',
    needs: ['Slack or Discord webhook'],
    whatChanges: [
      'A short digest of your day posts to a Slack or Discord channel once the day settles.',
      'It names you however you choose, since someone else is reading it.',
    ],
    makerNote: 'The digest is short on purpose. Knowing someone expects it is what does the work.',
  },
];

export function extensionManifest(slug: string): ExtensionManifest | undefined {
  return OFFICIAL_EXTENSIONS.find((extension) => extension.slug === slug);
}

/** Resolve a slug against sparse per-user rows, falling back to the manifest default. */
export function resolveEnabled(enabled: Record<string, boolean>, slug: string): boolean {
  return enabled[slug] ?? extensionManifest(slug)?.defaultEnabled ?? false;
}
