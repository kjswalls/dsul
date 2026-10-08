import type { RecipeManifest, RecipeStep } from '@/lib/mods/schema';
import { formatCueTime } from '@/lib/reminders/copy';
import { STEP_CHOICES, TRIGGER_CHOICES } from './draft';
import { isItemTrigger } from './validate';

/**
 * A recipe in plain words, for the "Write with AI" draft card
 * (components/settings/make-write.tsx): when it runs, what must match, each
 * step, and what it can touch. Pure. The trigger and step words are the
 * builder's own (./draft.ts), so the card and the form say the same thing.
 */

export interface RecipeLabels {
  /** A type slug's label ("Task", or a custom type's). */
  type(name: string): string;
  /** A theme id or ref's label. */
  theme(ref: string): string;
  /** A Look id or ref's label. */
  look(ref: string): string;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const BUCKET_NAMES: Record<string, string> = {
  morning: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
  anytime: 'any time',
};
const LAYOUT_NAMES: Record<string, string> = { buckets: 'Buckets', schedule: 'Schedule', list: 'List' };

const triggerLabel = (on: string) => TRIGGER_CHOICES.find((t) => t.value === on)?.label ?? on;
const stepLabel = (kind: string) => STEP_CHOICES.find((s) => s.value === kind)?.label ?? kind;

function stepLine(s: RecipeStep, labels: RecipeLabels): string {
  switch (s.do) {
    case 'complete':
      return 'Complete that item';
    case 'skip':
      return 'Skip that item today';
    case 'unskip':
      return 'Unskip that item';
    case 'pause':
      return 'Pause that item';
    case 'resume':
      return 'Resume that item';
    case 'nextDay':
      return 'Move that item to the next day';
    case 'braindump':
      return 'Move that item to the braindump';
    case 'reschedule':
      return s.inDays === 0
        ? 'Move that item to today'
        : `Move that item ${s.inDays} ${s.inDays === 1 ? 'day' : 'days'} later`;
    case 'create': {
      const where = [
        s.bucket ? `this ${BUCKET_NAMES[s.bucket] ?? s.bucket}` : null,
        s.project ? `in ${s.project}` : null,
      ].filter(Boolean);
      return `Add the ${labels.type(s.type).toLowerCase()} "${s.title}"${where.length ? `, ${where.join(', ')}` : ''}`;
    }
    case 'toast':
      return `Show the message "${s.text}"`;
    case 'goto':
      return `Go to the ${s.scope === 'week' ? 'week' : 'day'}, as ${LAYOUT_NAMES[s.layout] ?? s.layout}`;
    case 'organize':
      return 'Open Organize';
    case 'setTheme':
      return `Set the ${s.mode} theme to ${labels.theme(s.theme)}`;
    case 'applyLook':
      return `Apply the Look ${labels.look(s.look)}`;
  }
  return stepLabel((s as RecipeStep).do);
}

export function describeRecipe(
  m: RecipeManifest,
  labels: RecipeLabels,
  timeFormat: '12h' | '24h' = '24h'
): { when: string; only: string[]; steps: string[] } {
  const t = m.trigger;
  const label = triggerLabel(t.on);
  // "I tick an item" keeps its "I"; "A new day starts" reads "When a new day starts".
  let when = `When ${label.startsWith('I ') ? label : label.charAt(0).toLowerCase() + label.slice(1)}`;
  if (t.on === 'time') when = `At ${formatCueTime(t.at, timeFormat)} each day`;
  if (t.on === 'bucket.changed' && t.bucket) when = `When the ${BUCKET_NAMES[t.bucket] ?? t.bucket} starts`;
  if (t.on === 'command') when = 'When you run it from the command menu';

  const f = m.filters ?? {};
  const only: string[] = [];
  if (f.types) only.push(`Only for ${f.types.map((n) => labels.type(n).toLowerCase()).join(' or ')} items`);
  if (f.projects) only.push(`Only in ${f.projects.join(' or ')}`);
  if (f.title) only.push(`Only when the title has "${f.title.contains}"`);
  if (f.weekdays) only.push(`Only on ${f.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', ')}`);
  if (f.openToday) only.push('Only while the item is still open today');

  return { when, only, steps: m.steps.map((s) => stepLine(s, labels)) };
}

/** What a recipe can touch, one plain line per kind of reach, in a fixed order. */
export function recipeTouches(m: RecipeManifest, timeFormat: '12h' | '24h' = '24h'): string[] {
  const has = (...kinds: RecipeStep['do'][]) => m.steps.some((s) => kinds.includes(s.do));
  const out: string[] = [];
  if (has('complete', 'skip', 'unskip', 'pause', 'resume', 'nextDay', 'reschedule', 'braindump')) {
    out.push(
      isItemTrigger(m.trigger)
        ? 'Changes the item that started it (completes, skips, moves or pauses it)'
        : 'Changes your items (completes, skips, moves or pauses them)'
    );
  }
  if (has('create')) out.push('Adds items');
  if (has('toast')) out.push('Shows a message');
  if (has('goto', 'organize')) out.push('Changes the view or opens Organize');
  if (has('setTheme', 'applyLook')) out.push('Changes your theme or Look');
  if (m.trigger.on === 'time') {
    out.push(`Runs on dsul's server at ${formatCueTime(m.trigger.at, timeFormat)}, even with dsul closed`);
  }
  return out;
}

export const THEME_TOUCHES = ['Only colours, corner radius, shadows and the font. Nothing else.'];
export const LOOK_TOUCHES = ['Your layout and your day and night themes, when you apply it.'];
