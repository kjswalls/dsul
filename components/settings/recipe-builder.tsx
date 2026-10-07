'use client';

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useModsStore } from '@/lib/mods-store';
import { ALL_ITEM_TYPES, getItemTypeConfig } from '@/lib/item-registry';
import { EMPTY_PICK_LISTS, fetchRecipePickLists, type RecipePickLists } from '@/lib/recipes/pick-lists';
import { canCreateType } from '@/lib/proposal';
import { DARK_LOOKS, LIGHT_LOOKS } from '@/lib/theme-looks';
import { useUserThemes } from '@/lib/user-themes/store';
import { isUserThemeSlug } from '@/lib/user-themes/css';
import { LOOKS } from '@/lib/looks';
import { isUserLookRef, unlistedLookLabel, useUserLooks } from '@/lib/user-looks';
import { RECIPE_VERBS, RecipeManifestSchema, type UserMod } from '@/lib/mods/schema';
import { currentRecipeEnv, ITEM_TRIGGERS, openTodayFits, type RecipeEnv } from '@/lib/recipes/validate';
import {
  STEP_CHOICES,
  TRIGGER_CHOICES,
  blankDraft,
  blankStep,
  draftToManifest,
  manifestToDraft,
  type RecipeDraft,
  type StepDraft,
  type StepKind,
} from '@/lib/recipes/draft';

/**
 * Settings → Make's recipe form (memory/plans/mods.md, "Recipes"): a name, one
 * trigger, optional filters, ordered steps from the closed list. A new recipe
 * is saved switched off. Save checks the shape and the run rules
 * (lib/recipes/draft.ts, validate.ts) and says each problem in plain words.
 *
 * It never reads the planner store: /settings is a lean route that does not
 * load it (lib/route-data.ts). What it offers to pick from (items, projects,
 * your own types) it fetches itself (lib/recipes/pick-lists.ts). Projects are
 * typed, with the list as suggestions; an unknown one is refused at run time.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BUCKETS = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
];

const selectClass =
  'field dark:bg-input/30 h-9 w-full min-w-0 border bg-transparent px-2 py-1 text-sm outline-none';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      {children}
    </label>
  );
}

const isVerbKind = (kind: StepKind) => (RECIPE_VERBS as readonly string[]).includes(kind);

export function RecipeBuilder({
  userId,
  editing,
  onDone,
  onCancel,
}: {
  userId: string;
  /** The recipe being edited, or null for a new one. */
  editing: UserMod | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RecipeDraft>(() => {
    if (!editing) return blankDraft();
    // From the shape alone: a recipe the run rules refuse today still opens,
    // so it can be fixed.
    const parsed = RecipeManifestSchema.safeParse(editing.manifest);
    return parsed.success ? manifestToDraft(editing.name, parsed.data) : { ...blankDraft(), name: editing.name };
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [lists, setLists] = useState<RecipePickLists>(EMPTY_PICK_LISTS);
  useEffect(() => {
    let live = true;
    fetchRecipePickLists(userId)
      .then((l) => {
        if (live) setLists(l);
      })
      .catch((err) => console.warn('[recipes] pick lists failed:', err));
    return () => {
      live = false;
    };
  }, [userId]);

  const itemTrigger = (ITEM_TRIGGERS as readonly string[]).includes(draft.trigger);
  const typeGroupId = useId();
  const stepsNoteId = useId();
  const env: RecipeEnv = useMemo(() => {
    const names = [...currentRecipeEnv().customTypeNames, ...lists.types.map((t) => t.name)];
    return { customTypeNames: [...new Set(names)] };
  }, [lists.types]);
  const typeNames = useMemo(() => [...ALL_ITEM_TYPES, ...env.customTypeNames], [env]);
  const typeLabel = (name: string) =>
    lists.types.find((t) => t.name === name)?.label ?? getItemTypeConfig(name).label;
  const creatable = typeNames.filter((t) => canCreateType(t, env));
  const pickable = lists.items;
  const projects = lists.projects;

  const patch = (p: Partial<RecipeDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchStep = (i: number, p: Partial<StepDraft>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const moveStep = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const steps = [...d.steps];
      const j = i + by;
      if (j < 0 || j >= steps.length) return d;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });

  const save = async () => {
    const result = draftToManifest(draft, env);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    setSaving(true);
    const store = useModsStore.getState();
    if (editing) {
      const ok = await store.saveRecipe(editing.id, { name: draft.name, manifest: result.manifest });
      setSaving(false);
      // saveRecipe switches a recipe off when what it does changed.
      const offNow = editing.enabled && !useModsStore.getState().rows.find((r) => r.id === editing.id)?.enabled;
      if (ok) onDone(offNow ? 'Saved and switched off. Switch it on to run it.' : 'Saved.');
      else setProblems(['Could not save it. Try again.']);
    } else {
      const created = await store.createRecipe(userId, { name: draft.name, manifest: result.manifest });
      setSaving(false);
      if (created.ok) onDone('Saved. Switch it on to run it.');
      else setProblems([created.reason]);
    }
  };

  return (
    <div data-testid="recipe-builder" className="space-y-4 py-3">
      <h2 className="text-foreground text-sm font-medium">{editing ? 'Edit recipe' : 'New recipe'}</h2>

      <Field label="Name">
        <Input
          data-testid="recipe-name"
          value={draft.name}
          maxLength={60}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      <Field label="When">
        <select
          data-testid="recipe-trigger"
          className={selectClass}
          value={draft.trigger}
          onChange={(e) => patch({ trigger: e.target.value as RecipeDraft['trigger'] })}
        >
          {draft.trigger === 'time' && <option value="time">At a set time (not available yet)</option>}
          {TRIGGER_CHOICES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>

      {draft.trigger === 'bucket.changed' && (
        <Field label="Part of day">
          <select
            data-testid="recipe-bucket"
            className={selectClass}
            value={draft.bucket}
            onChange={(e) => patch({ bucket: e.target.value })}
          >
            <option value="">Any</option>
            {BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      <fieldset className="space-y-3" data-testid="recipe-filters">
        <legend className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
          Only if
        </legend>
        {itemTrigger && (
          <div className="space-y-3" data-testid="recipe-item-filters">
            <div>
              <span id={typeGroupId} className="text-muted-foreground mb-1 block text-xs">
                Type
              </span>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby={typeGroupId}>
                {typeNames.map((t) => (
                  <label key={t} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.types.includes(t)}
                      onChange={(e) =>
                        patch({
                          types: e.target.checked ? [...draft.types, t] : draft.types.filter((x) => x !== t),
                        })
                      }
                    />
                    {typeLabel(t)}
                  </label>
                ))}
              </div>
            </div>
            <Field label="Project (separate with commas)">
              <Input
                data-testid="recipe-filter-projects"
                list="recipe-projects"
                value={draft.projects}
                onChange={(e) => patch({ projects: e.target.value })}
              />
            </Field>
            <Field label="Title contains">
              <Input
                data-testid="recipe-filter-title"
                value={draft.title}
                maxLength={120}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </Field>
            {openTodayFits(draft.trigger) && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="recipe-filter-open-today"
                  checked={draft.openToday}
                  onChange={(e) => patch({ openToday: e.target.checked })}
                />
                Still open today
              </label>
            )}
          </div>
        )}
        <div>
          <span className="text-muted-foreground mb-1 block text-xs">Days</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
            {WEEKDAYS.map((d, i) => {
              const on = draft.weekdays.includes(i);
              return (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={on ? 'default' : 'outline'}
                  aria-pressed={on}
                  onClick={() =>
                    patch({ weekdays: on ? draft.weekdays.filter((x) => x !== i) : [...draft.weekdays, i] })
                  }
                >
                  {d}
                </Button>
              );
            })}
          </div>
        </div>
      </fieldset>

      <datalist id="recipe-projects">
        {projects.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <fieldset className="space-y-3" aria-describedby={stepsNoteId}>
        <legend className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
          Steps
        </legend>
        <p id={stepsNoteId} data-testid="recipe-steps-note" className="text-muted-foreground text-xs">
          Steps that change items happen first. Messages, views and themes come after.
        </p>
        <ol className="space-y-3">
          {draft.steps.map((step, i) => (
            <li key={i} data-testid="recipe-step" className="border-border space-y-2 rounded-[6px] border p-2">
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground w-5 text-xs">{i + 1}.</span>
                <select
                  aria-label={`Step ${i + 1}`}
                  data-testid="recipe-step-kind"
                  className={selectClass}
                  value={step.do}
                  onChange={(e) =>
                    patchStep(i, { ...blankStep(e.target.value as StepKind, itemTrigger) })
                  }
                >
                  {STEP_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Move step ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => moveStep(i, -1)}
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Move step ${i + 1} down`}
                  disabled={i === draft.steps.length - 1}
                  onClick={() => moveStep(i, 1)}
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
              <StepFields
                step={step}
                index={i}
                itemTrigger={itemTrigger}
                pickable={pickable}
                creatable={creatable}
                typeLabel={typeLabel}
                onChange={(p) => patchStep(i, p)}
              />
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="recipe-add-step"
          disabled={draft.steps.length >= 25}
          onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, blankStep('toast', itemTrigger)] }))}
        >
          <Plus className="size-3.5" aria-hidden /> Add a step
        </Button>
      </fieldset>

      {problems.length > 0 && (
        <ul data-testid="recipe-problems" role="alert" className="text-destructive space-y-1 text-xs">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button type="button" size="sm" data-testid="recipe-save" disabled={saving} onClick={() => void save()}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StepFields({
  step,
  index,
  itemTrigger,
  pickable,
  creatable,
  typeLabel,
  onChange,
}: {
  step: StepDraft;
  index: number;
  itemTrigger: boolean;
  pickable: { id: string; title: string }[];
  creatable: string[];
  typeLabel: (name: string) => string;
  onChange: (p: Partial<StepDraft>) => void;
}) {
  const n = index + 1;
  const userThemes = useUserThemes((s) => s.themes);
  const userLooks = useUserLooks();
  const modRows = useModsStore((s) => s.rows);
  if (isVerbKind(step.do)) {
    const known = step.item === 'trigger' || step.item === '' || pickable.some((p) => p.id === step.item);
    return (
      <div className="space-y-2">
        <Field label="Which item">
          <select
            data-testid="recipe-step-item"
            aria-label={`Which item, step ${n}`}
            className={selectClass}
            value={step.item}
            onChange={(e) => onChange({ item: e.target.value })}
          >
            <option value="">Pick an item</option>
            {itemTrigger && <option value="trigger">The item that started it</option>}
            {!known && <option value={step.item}>An item not loaded here</option>}
            {pickable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        {step.do === 'reschedule' && (
          <Field label="In how many days">
            <Input
              data-testid="recipe-step-days"
              inputMode="numeric"
              value={step.inDays}
              onChange={(e) => onChange({ inDays: e.target.value })}
            />
          </Field>
        )}
      </div>
    );
  }
  switch (step.do) {
    case 'create':
      return (
        <div className="space-y-2">
          <Field label="Type">
            <select
              className={selectClass}
              aria-label={`Type, step ${n}`}
              value={step.type}
              onChange={(e) => onChange({ type: e.target.value })}
            >
              {!creatable.includes(step.type) && <option value={step.type}>{step.type}</option>}
              {creatable.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <Input
              data-testid="recipe-step-title"
              value={step.title}
              maxLength={120}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </Field>
          <Field label="Part of day">
            <select
              className={selectClass}
              aria-label={`Part of day, step ${n}`}
              value={step.bucket}
              onChange={(e) => onChange({ bucket: e.target.value })}
            >
              <option value="">None</option>
              <option value="anytime">Anytime</option>
              {BUCKETS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Project">
            <Input list="recipe-projects" value={step.project} onChange={(e) => onChange({ project: e.target.value })} />
          </Field>
        </div>
      );
    case 'toast':
      return (
        <Field label="Message">
          <Input
            data-testid="recipe-step-text"
            value={step.text}
            maxLength={140}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </Field>
      );
    case 'goto':
      return (
        <div className="flex gap-2">
          <select
            className={selectClass}
            aria-label={`Day or week for step ${n}`}
            value={step.scope}
            onChange={(e) => onChange({ scope: e.target.value as StepDraft['scope'] })}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
          <select
            className={selectClass}
            aria-label={`Layout for step ${n}`}
            value={step.layout}
            onChange={(e) => onChange({ layout: e.target.value as StepDraft['layout'] })}
          >
            <option value="buckets">Parts of day</option>
            <option value="schedule">Schedule</option>
            <option value="list">List</option>
          </select>
        </div>
      );
    case 'setTheme': {
      const looks = step.mode === 'light' ? LIGHT_LOOKS : DARK_LOOKS;
      const yours = Object.values(userThemes).filter((t) => t.mode === step.mode);
      // A saved step naming one of your themes that is off (or gone) keeps it.
      const offOwn = isUserThemeSlug(step.theme) && !yours.some((t) => t.slug === step.theme);
      return (
        <div className="flex gap-2">
          <select
            className={selectClass}
            aria-label={`Light or dark for step ${n}`}
            value={step.mode}
            onChange={(e) => onChange({ mode: e.target.value as StepDraft['mode'], theme: '' })}
          >
            <option value="light">Light theme</option>
            <option value="dark">Dark theme</option>
          </select>
          <select
            className={selectClass}
            aria-label={`Theme for step ${n}`}
            value={step.theme}
            onChange={(e) => onChange({ theme: e.target.value })}
          >
            <option value="">Pick a theme</option>
            {looks.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
            {(yours.length > 0 || offOwn) && (
              <optgroup label="Yours" data-testid="recipe-theme-yours">
                {yours.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.label}
                  </option>
                ))}
                {offOwn && <option value={step.theme}>Your theme (off)</option>}
              </optgroup>
            )}
          </select>
        </div>
      );
    }
    case 'applyLook': {
      // A saved step naming one of your Looks that is not listed (off, gone,
      // or held back by safe mode) keeps it, named from its row when it has one.
      const offOwn = isUserLookRef(step.look) && !userLooks.some((l) => l.ref === step.look);
      const offLabel = offOwn ? unlistedLookLabel(step.look, modRows) : '';
      return (
        <select
          className={selectClass}
          aria-label={`Look for step ${n}`}
          value={step.look}
          onChange={(e) => onChange({ look: e.target.value })}
        >
          <option value="">Pick a Look</option>
          {LOOKS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
          {(userLooks.length > 0 || offOwn) && (
            <optgroup label="Yours" data-testid="recipe-look-yours">
              {userLooks.map((l) => (
                <option key={l.ref} value={l.ref}>
                  {l.label}
                </option>
              ))}
              {offOwn && <option value={step.look}>{offLabel}</option>}
            </optgroup>
          )}
        </select>
      );
    }
    default:
      return null;
  }
}
