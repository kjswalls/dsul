# Sounds (extension)

Kirby asked for it on 2026-10-31 ("Plan a sound effects extension" thread): sound packs,
a subtle elegant default, a switch for each kind of sound. Tuned by ear on a prototype
page (https://claude.ai/artifact/3urhf59L4UJk5wmrF6zQfm) over four rounds the same night.

## Where the sounds come from

Made in the browser with Web Audio: oscillators, filtered noise, a small generated room.
No audio files, nothing licensed, nothing copied (the brief said "like Nintendo Switch UI
sounds", meaning the feel: short, soft, pitched, quiet). Free CC0 sources (Kenney,
Freesound's CC0 filter, sfxr) stay an option for a future pack; paid AI generators were
ruled out on cost.

## Shape

- `lib/sounds/registry.ts`: the 15 sounds, 7 groups (switches), 7 packs, config reader.
  Ids are stored, so they are permanent.
- `lib/sounds/synth.ts`: every pack's recipes. Lazily imported on the first sound.
- `lib/sounds/cue.ts`: `cueSound(event)`, the one door. Silent unless the extension is on
  and the group is on; silent for suppressed writes (recipes, mods, AI apply); the same
  sound twice in 60ms is one. `auditionSound` is the console's try button.
- `lib/sounds/volume.ts`: volume per device (`dsul.sounds.volume`).
- Account config in `user_extensions.config`: `pack`, `groups` (sparse booleans). No migration.
- Hooks: deletes and undo (and "nothing to undo") in planner-store; pick up and drop in
  AppShell's drag handlers; everything else heard by `components/providers/sound-cues.tsx`
  (mod events for tick/untick/add and day done, ui-store and askOpen for panels, view-store
  for views, the Do stuff sprint for the timer, conversations-store streaming for the AI).
  Panels and views sound only within 800ms of the person's own click or key, so a sync or a
  saved setting arriving stays silent.
- Settings: the switch record `extensions.sounds`, and `components/settings/sounds-console.tsx`
  under it: packs (pick plays a sample, each has a play button), volume, the switches with
  a try chip per sound. Everything can be tried with the extension off.

## Decisions

- Off by default: a sound fails "quiet until used".
- Default pack Silk (Kirby asked for something more elegant than Pebble; Silk and Felt were
  drafted for it and Kirby liked both). Panels and views start switched off.
- Kirby's picks: Pebble tick D (a bubble that lands), untick C (the tick backwards), drop B
  (soft wooden knock), nothing-to-undo A (quieter two notes). Paper tick A, untick C made a
  little louder, drop C (just a tap). Glass made softer (80%, gentler bell, top rolled off).
  Silk tick is the first version (A); Kirby liked all five options, so it can change.
- The Do stuff sprint runs out silently by design ("no sound, no red"); Sounds with Moments
  on is the opt-in that rings it.
- Relay is a first pass at a Tron Legacy / light-cycle pack with bass on the AI; Kirby wants
  a different feel and is reworking it next.

## Not yet

- The iPhone app: render each recipe to a short audio file at build time (OfflineAudioContext)
  and bundle them, so the phone plays the same pack.
- A pack from your own files, or one a mod writes.
