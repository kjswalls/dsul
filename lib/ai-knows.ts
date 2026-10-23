/**
 * WHAT YOUR AI KNOWS (Kirby's pick E, 2026-10-23; memory/plans/power-mode.md,
 * "Sure, fairly sure, or ask"): answers the person chose to keep for every
 * item, not only the one they were asked about ("Who's Sammy? My dog"). A
 * line each, in Do stuff's config (user_extensions.config) beside "How you
 * write", so every device reads the same list and Settings shows it, to
 * change or to clear. Nothing goes in unless the person ticks "Remember for
 * other tasks" under an answer, or types it in Settings.
 *
 * Read by the person's own model when it prepares (/api/ai/prep) and by an
 * agent handed an item to prepare (dsul_prep_brief). Pure.
 */

/** Do stuff's config key for the lines. */
export const AI_KNOWS_KEY = 'knows';

/** The most the list may hold, as stored and as a model is sent it. */
export const MAX_KNOWS_CHARS = 3_000;
/** The most one remembered line may hold. */
export const MAX_KNOW_LINE_CHARS = 240;

type Config = Readonly<Record<string, unknown>> | undefined;

/** The list as stored, trimmed to its cap. */
export function aiKnowsOf(config: Config): string {
  const v = config?.[AI_KNOWS_KEY];
  return typeof v === 'string' ? v.trim().slice(0, MAX_KNOWS_CHARS) : '';
}

/**
 * The list with new lines added at the end. A line already there (any case)
 * is not added twice; past the cap the oldest lines go first.
 */
export function withKnown(list: string, add: readonly string[]): string {
  const lines = list.split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Set(lines.map((l) => l.toLowerCase()));
  for (const raw of add) {
    const line = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_KNOW_LINE_CHARS);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    lines.push(line);
  }
  while (lines.length > 1 && lines.join('\n').length > MAX_KNOWS_CHARS) lines.shift();
  return lines.join('\n').slice(0, MAX_KNOWS_CHARS);
}
