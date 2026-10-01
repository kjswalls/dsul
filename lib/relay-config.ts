/**
 * Feature flags for the ambient "data relay" field (see
 * components/primitives/relay-field.tsx) — a subtle glowing tile-grid ported
 * from the Sunday Softworks site. Each surface is gated independently so any
 * placement that reads as too busy can be switched off here without touching
 * the component. Flip a value to `false` to remove that instance.
 *
 * Light-mode color options live alongside in lib/relay-palettes.ts. The
 * shipped default is 'relay' (the light logo colours); fields on the gray dock
 * take `tone="quiet"`; a theme can replace both (lib/theme-looks.ts).
 */
export const RELAY = {
  /** Behind the sidebar dock capsule (identity + omnibar); brightens on focus. */
  dock: true,
  /**
   * The omnibar's field, in the two shapes the bar mounts it in: a halo around
   * the pill that energizes while the input is focused (desktop), or — under
   * `captureRelay`, which is the phone's dock — clipped INSIDE the pill and
   * struck once each time an item files itself. One flag, because it is one
   * field either way; only its placement and its trigger differ.
   */
  omnibar: true,
  /** In the Beacon chat panel; wakes up while a response is streaming. */
  beacon: true,
  /** In the "you are here" current time-of-day bucket header; slow heartbeat. */
  currentBucket: false,
  /** One-shot burst behind the streak flame when the best streak ticks up. */
  streak: true,
  /** Faint fill for empty surfaces (empty Braindump) so dead space has life. */
  emptyState: true,
  /** Fuller, hero-style field on the login / auth screen. */
  auth: true,
} as const;

export type RelaySurface = keyof typeof RELAY;
