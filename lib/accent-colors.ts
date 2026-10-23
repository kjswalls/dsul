import { foldContainerName, sameContainerName } from './container-registry';

/**
 * Theme-aware accent ramp helpers (tokens defined in app/globals.css).
 *
 * User-generated things that need a color (projects, custom habit groups)
 * pick deterministically from the 8-step --accent-N ramp so the same name
 * always gets the same color, and colors re-tune per theme for free.
 *
 * The iPhone draws the same colours (ios/DsulCore ContainerLook.swift), pinned
 * by tests/fixtures/organize/look.json, which also carries each token's oklch
 * values read out of globals.css.
 */

export const ACCENT_RAMP_SIZE = 8;

/** All ramp tokens, e.g. for a color picker. */
export const ACCENT_RAMP: readonly string[] = Array.from(
  { length: ACCENT_RAMP_SIZE },
  (_, i) => `var(--accent-${i + 1})`
);

/** Display names for --accent-1..8, from the ramp comments in globals.css. */
export const ACCENT_NAMES: readonly string[] = ['Moss', 'Teal', 'Indigo', 'Plum', 'Coral', 'Honey', 'Slate', 'Lime'];

/** Deterministic accent token for a user-provided name. */
export function accentColorForName(name: string): string {
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `var(--accent-${(hash % ACCENT_RAMP_SIZE) + 1})`;
}

/**
 * The three legacy theme tokens, by folded project name. They came over from
 * `getHabitGroupColor` (migration 039): Wellness, Work and Personal were the
 * shipped habit-group names, and dropping the map would restyle those rows
 * for every account that still has them.
 */
export const LEGACY_PROJECT_TOKENS: Readonly<Record<string, string>> = {
  wellness: 'var(--habit-wellness)',
  work: 'var(--habit-work)',
  personal: 'var(--habit-personal)',
};

/**
 * A project's colour on the grid (planner-store's getProjectColor, which is
 * this over the store's projects): the stored colour of the project the name
 * folds to wins; then the three legacy theme tokens; then the name-hash ramp
 * over the folded name.
 *
 * The cost of the legacy map on the merged axis is that a PROJECT named
 * "work" draws `--habit-work` instead of its name-hash colour, which is a
 * different colour and not a different meaning. Stored colours pass through
 * untouched either way, so anything the user actually picked is unaffected.
 *
 * Not Organize's rule: a container's tile there is its stored colour, else
 * accentColorForName over the RAW name, with no legacy tokens.
 */
export function projectColorToken(name: string, projects: readonly { name: string; color?: string }[]): string {
  const project = projects.find((p) => sameContainerName('project', p.name, name));
  if (project?.color) return project.color;
  const normalized = foldContainerName('project', name);
  // Own keys only: a project named "constructor" is not Object's.
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_PROJECT_TOKENS, normalized)
    ? LEGACY_PROJECT_TOKENS[normalized]
    : undefined;
  return legacy ?? accentColorForName(normalized);
}
