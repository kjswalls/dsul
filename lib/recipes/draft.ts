import {
  RECIPE_VERBS,
  RecipeManifestSchema,
  type RecipeManifest,
  type RecipeStep,
} from '@/lib/mods/schema';
import { ITEM_TRIGGERS, openTodayFits, validateRecipe, type RecipeEnv } from './validate';

/**
 * The builder's form state (components/settings/recipe-builder.tsx) and its
 * round trip to a manifest. Pure. Every field is a string or a list, as a form
 * holds it; `draftToManifest` turns it into a manifest the schema and
 * validateRecipe accept, or plain problems.
 */

export type TriggerChoice =
  | 'item.completed'
  | 'item.uncompleted'
  | 'item.skipped'
  | 'item.created'
  | 'review.saved'
  | 'day.opened'
  | 'bucket.changed'
  | 'time'
  | 'command';

export const TRIGGER_CHOICES: { value: TriggerChoice; label: string }[] = [
  { value: 'item.completed', label: 'I tick an item' },
  { value: 'item.uncompleted', label: 'I untick an item' },
  { value: 'item.skipped', label: 'I skip an item' },
  { value: 'item.created', label: 'I add an item' },
  { value: 'review.saved', label: "I save the day's review" },
  { value: 'day.opened', label: 'A new day starts' },
  { value: 'bucket.changed', label: 'Morning, afternoon or evening starts' },
  { value: 'time', label: 'At a time of day' },
  { value: 'command', label: 'I run it from the command menu' },
];

export type StepKind = RecipeStep['do'];

export const STEP_CHOICES: { value: StepKind; label: string }[] = [
  { value: 'complete', label: 'Complete an item' },
  { value: 'skip', label: 'Skip an item today' },
  { value: 'unskip', label: 'Unskip an item' },
  { value: 'pause', label: 'Pause an item' },
  { value: 'resume', label: 'Resume an item' },
  { value: 'nextDay', label: 'Move an item to the next day' },
  { value: 'reschedule', label: 'Reschedule an item' },
  { value: 'braindump', label: 'Move an item to the braindump' },
  { value: 'create', label: 'Add an item' },
  { value: 'toast', label: 'Show a message' },
  { value: 'goto', label: 'Go to a view' },
  { value: 'organize', label: 'Open Organize' },
  { value: 'setTheme', label: 'Set a theme' },
  { value: 'applyLook', label: 'Apply a Look' },
];

export interface StepDraft {
  do: StepKind;
  /** 'trigger', an item id, or '' for none picked. */
  item: string;
  inDays: string;
  type: string;
  title: string;
  /** '' for no part of day. */
  bucket: string;
  project: string;
  text: string;
  scope: 'day' | 'week';
  layout: 'buckets' | 'schedule' | 'list';
  mode: 'light' | 'dark';
  theme: string;
  look: string;
}

export interface RecipeDraft {
  name: string;
  trigger: TriggerChoice;
  /** For bucket.changed: '' (any) or a part of day. */
  bucket: string;
  /** For a time trigger: HH:MM in the user's time zone. */
  at: string;
  types: string[];
  projects: string;
  title: string;
  weekdays: number[];
  openToday: boolean;
  steps: StepDraft[];
}

export function blankStep(kind: StepKind = 'toast', itemTrigger = true): StepDraft {
  return {
    do: kind,
    item: itemTrigger ? 'trigger' : '',
    inDays: '1',
    type: 'task',
    title: '',
    bucket: '',
    project: '',
    text: '',
    scope: 'day',
    layout: 'buckets',
    mode: 'light',
    theme: '',
    look: '',
  };
}

export function blankDraft(): RecipeDraft {
  return {
    name: '',
    trigger: 'item.completed',
    bucket: '',
    at: '',
    types: [],
    projects: '',
    title: '',
    weekdays: [],
    openToday: false,
    steps: [blankStep('toast')],
  };
}

const isVerb = (kind: StepKind) => (RECIPE_VERBS as readonly string[]).includes(kind);

/** A saved manifest back into the form. */
export function manifestToDraft(name: string, m: RecipeManifest): RecipeDraft {
  const f = m.filters ?? {};
  return {
    name,
    trigger: m.trigger.on,
    bucket: m.trigger.on === 'bucket.changed' ? (m.trigger.bucket ?? '') : '',
    at: m.trigger.on === 'time' ? m.trigger.at : '',
    types: f.types ?? [],
    projects: (f.projects ?? []).join(', '),
    title: f.title?.contains ?? '',
    weekdays: f.weekdays ?? [],
    openToday: !!f.openToday,
    steps: m.steps.map((s) => {
      const d = blankStep(s.do);
      if ('item' in s) d.item = s.item === 'trigger' ? 'trigger' : s.item.id;
      if (s.do === 'reschedule') d.inDays = String(s.inDays);
      if (s.do === 'create') {
        d.type = s.type;
        d.title = s.title;
        d.bucket = s.bucket ?? '';
        d.project = s.project ?? '';
      }
      if (s.do === 'toast') d.text = s.text;
      if (s.do === 'goto') {
        d.scope = s.scope;
        d.layout = s.layout;
      }
      if (s.do === 'setTheme') {
        d.mode = s.mode;
        d.theme = s.theme;
      }
      if (s.do === 'applyLook') d.look = s.look;
      return d;
    }),
  };
}

function stepFromDraft(d: StepDraft, n: number, problems: string[]): unknown {
  if (isVerb(d.do)) {
    if (!d.item) {
      problems.push(`Pick an item for step ${n}.`);
      return null;
    }
    const item = d.item === 'trigger' ? 'trigger' : { id: d.item };
    if (d.do !== 'reschedule') return { do: d.do, item };
    const inDays = Number(d.inDays);
    if (!/^\d+$/.test(d.inDays.trim()) || inDays > 365) {
      problems.push(`Step ${n} needs a number of days from 0 to 365.`);
      return null;
    }
    return { do: d.do, item, inDays };
  }
  switch (d.do) {
    case 'create': {
      const title = d.title.trim();
      if (!title) problems.push(`Give the item in step ${n} a title.`);
      else if (/https?:\/\/|www\./i.test(title)) problems.push(`Step ${n}: no links in a title.`);
      return {
        do: 'create',
        type: d.type,
        title,
        ...(d.bucket && { bucket: d.bucket }),
        ...(d.project.trim() && { project: d.project.trim() }),
      };
    }
    case 'toast': {
      const text = d.text.trim();
      if (!text) problems.push(`Write the message for step ${n}.`);
      return { do: 'toast', text };
    }
    case 'goto':
      return { do: 'goto', scope: d.scope, layout: d.layout };
    case 'organize':
      return { do: 'organize' };
    case 'setTheme':
      if (!d.theme) problems.push(`Pick a ${d.mode} theme for step ${n}.`);
      return { do: 'setTheme', mode: d.mode, theme: d.theme };
    case 'applyLook':
      if (!d.look) problems.push(`Pick a Look for step ${n}.`);
      return { do: 'applyLook', look: d.look };
  }
  return null;
}

/** The form as a manifest, or the plain problems that stop it saving. */
export function draftToManifest(
  draft: RecipeDraft,
  env: RecipeEnv
): { ok: true; manifest: RecipeManifest } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Give it a name.');
  if (draft.steps.length === 0) problems.push('Add a step.');
  if (draft.trigger === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.at)) problems.push('Pick a time.');

  const trigger =
    draft.trigger === 'bucket.changed'
      ? { on: 'bucket.changed', ...(draft.bucket && { bucket: draft.bucket }) }
      : draft.trigger === 'time'
        ? { on: 'time', at: draft.at }
        : { on: draft.trigger };

  const projects = draft.projects
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // Item filters are hidden unless an item starts the recipe, so they are not
  // saved then either.
  const withItem = (ITEM_TRIGGERS as readonly string[]).includes(draft.trigger);
  const filters = {
    ...(withItem && draft.types.length > 0 && { types: draft.types }),
    ...(withItem && projects.length > 0 && { projects }),
    ...(withItem && draft.title.trim() && { title: { contains: draft.title.trim() } }),
    ...(draft.weekdays.length > 0 && { weekdays: [...draft.weekdays].sort((a, b) => a - b) }),
    ...(withItem && openTodayFits(draft.trigger) && draft.openToday && { openToday: true }),
  };
  const steps = draft.steps.map((s, i) => stepFromDraft(s, i + 1, problems));
  if (problems.length > 0) return { ok: false, problems };

  const parsed = RecipeManifestSchema.safeParse({ version: 1, trigger, filters, steps });
  if (!parsed.success) {
    // The shape broke somewhere the form did not catch: name the step if it is one.
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const [head, index] = issue.path;
      const line =
        head === 'steps' && typeof index === 'number'
          ? `Step ${index + 1} is not complete.`
          : head === 'filters'
            ? 'One of the filters is not valid.'
            : head === 'name'
              ? 'Give it a name.'
              : 'Something in it is not valid.';
      if (!seen.has(line)) {
        seen.add(line);
        problems.push(line);
      }
    }
    return { ok: false, problems };
  }
  const rules = validateRecipe(parsed.data, env);
  if (rules.length > 0) return { ok: false, problems: rules };
  return { ok: true, manifest: parsed.data };
}
