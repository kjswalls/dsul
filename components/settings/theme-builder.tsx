'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useModsStore } from '@/lib/mods-store';
import { isModName, type UserMod } from '@/lib/mods/schema';
import {
  ALPHA_BOUNDS,
  WASH_KEYS,
  DARK_BASES,
  LIGHT_BASES,
  ON_ACCENT_KEYS,
  RADIUS_MAX,
  RELAY_MAX,
  RELAY_MODE,
  SHADOW_PRESETS,
  THEME_FONTS,
  THEME_FONT_KEYS,
  ThemeManifestSchema,
  canonicalTokens,
  effectiveColor,
  parseOpaque,
  parseToken,
  printTheme,
  type ColorKey,
  type RelayKey,
  type ShadowPreset,
  type ThemeFont,
  type ThemeManifest,
  type ThemeMode,
  type ThemeTokens,
} from '@/lib/mods/theme-grammar';
import { THEME_BASES, type ThemeBaseId } from '@/lib/mods/theme-bases';
import { contrastWarnings } from '@/lib/mods/theme-contrast';
import { parseColor, toHex } from '@/lib/mods/color';
import { DRAFT_SLUG } from '@/lib/user-themes/css';
import { setUserThemeDraft } from '@/lib/user-themes/store';
import { DARK_LOOKS, LIGHT_LOOKS, resolveDarkPick, resolveLightPick } from '@/lib/theme-looks';
import { useLookStore } from '@/lib/look-store';
import { usePaletteStore } from '@/lib/palette-store';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { layoutDef } from '@/lib/layout-themes';
import { LookMini } from './look-mini';

/**
 * Settings → Make's theme form (memory/plans/mods.md, "Themes and Looks"): a
 * name, light or dark, a built-in to start from, and any of the tokens. Every
 * token left empty is the base's. Each colour takes `#rgb`, `#rrggbb` or
 * `oklch(L C H)`; the hover, selection, behind-dialogs and line colours may add
 * `/ A%`, within bounds. What is saved is the host's own print of each value.
 *
 * The preview is a LookMini drawn with the draft's slug, whose rules the
 * injector writes as a preview twin only, so nothing outside the preview moves
 * while you type. A contrast shortfall warns and blocks Save until "Save
 * anyway" is ticked. A new theme is saved switched off, like everything here.
 */

type FieldKey = Exclude<ColorKey, (typeof ON_ACCENT_KEYS)[number]> | 'onAccent';

const GROUPS: { title: string; fields: { key: FieldKey; label: string }[] }[] = [
  {
    title: 'Ground',
    fields: [
      { key: 'paper0', label: 'Backdrop' },
      { key: 'paper1', label: 'Sidebar' },
      { key: 'paper2', label: 'Page' },
      { key: 'paper3', label: 'Cards' },
      { key: 'paperWell', label: 'Well' },
    ],
  },
  {
    title: 'Text',
    fields: [
      { key: 'ink0', label: 'Text' },
      { key: 'ink1', label: 'Secondary text' },
      { key: 'ink2', label: 'Muted text' },
    ],
  },
  {
    title: 'Accent',
    fields: [
      { key: 'limeSolid', label: 'Accent fill' },
      { key: 'limeInk', label: 'Accent text' },
      { key: 'limeTint', label: 'Accent wash' },
      { key: 'onAccent', label: 'Text on accent' },
    ],
  },
  {
    title: 'Lines',
    fields: [
      { key: 'border', label: 'Border' },
      { key: 'input', label: 'Control border' },
      { key: 'sidebarBorder', label: 'Sidebar border' },
      { key: 'accent', label: 'Hover' },
      { key: 'rowSelected', label: 'Selected' },
      { key: 'scrim', label: 'Behind dialogs' },
    ],
  },
  {
    title: 'Ask button',
    fields: [
      { key: 'askIconPair', label: 'Fill' },
      { key: 'askIconPairInk', label: 'Icon' },
    ],
  },
];

const RELAY_LABELS: Record<RelayKey, string> = {
  relayLight: 'Field colours',
  relayLightQuiet: 'Quiet field colours',
  relayDark: 'Field colours',
};

const SHADOW_LABELS: Record<ShadowPreset, string> = {
  paper: 'Soft (Paper)',
  studio: 'Hairline (Studio)',
  sorbet: 'Warm (Sorbet)',
  night: 'Lit edge (Night)',
  terminal: 'Outline (Terminal)',
  dusk: 'Glow (Dusk)',
};

const BASE_LABEL = Object.fromEntries([...LIGHT_LOOKS, ...DARK_LOOKS].map((l) => [l.value, l.label])) as Record<
  ThemeBaseId,
  string
>;

const selectClass =
  'field dark:bg-input/30 h-9 w-full min-w-0 border bg-transparent px-2 py-1 text-sm outline-none';

const tokenOf = (key: FieldKey): ColorKey => (key === 'onAccent' ? 'primaryForeground' : key);

interface FormState {
  name: string;
  mode: ThemeMode;
  base: ThemeBaseId;
  colors: Partial<Record<FieldKey, string>>;
  relays: Partial<Record<RelayKey, string>>;
  radius: number | null;
  shadows: ShadowPreset | null;
  font: ThemeFont | null;
  themeColor: string;
  override: boolean;
}

function blankForm(): FormState {
  return {
    name: '',
    mode: 'light',
    base: 'paper',
    colors: {},
    relays: {},
    radius: null,
    shadows: null,
    font: null,
    themeColor: '',
    override: false,
  };
}

/** A saved theme back into the form. From the shape alone, so one that no longer passes still opens. */
function formFromRow(row: UserMod): FormState {
  const parsed = ThemeManifestSchema.safeParse(row.manifest);
  if (!parsed.success) return { ...blankForm(), name: row.name };
  const m = parsed.data;
  const colors: FormState['colors'] = {};
  for (const group of GROUPS) {
    for (const f of group.fields) {
      const v = m.tokens[tokenOf(f.key)];
      if (v !== undefined) colors[f.key] = v;
    }
  }
  const relays: FormState['relays'] = {};
  for (const key of ['relayLight', 'relayLightQuiet', 'relayDark'] as const) {
    const list = m.tokens[key];
    if (list) relays[key] = list.join(', ');
  }
  return {
    name: row.name,
    mode: m.mode,
    base: m.base,
    colors,
    relays,
    radius: m.tokens.radius ?? null,
    shadows: m.tokens.shadows ?? null,
    font: m.tokens.font ?? null,
    themeColor: m.themeColor ?? '',
    override: m.contrastOverride === true,
  };
}

/** The form as tokens, with an error per field that does not parse. */
function tokensFromForm(form: FormState): { tokens: ThemeTokens; errors: Record<string, string> } {
  const tokens: ThemeTokens = {};
  const errors: Record<string, string> = {};
  for (const group of GROUPS) {
    for (const f of group.fields) {
      const raw = form.colors[f.key]?.trim();
      if (!raw) continue;
      const key = tokenOf(f.key);
      if (!parseToken(key, raw)) {
        const bounds = ALPHA_BOUNDS[key];
        const range = bounds ? `${Math.round(bounds[0] * 100)}% to ${Math.round(bounds[1] * 100)}%` : '';
        errors[f.key] = !bounds
          ? 'Use #rrggbb, #rgb or oklch(L C H), with no transparency.'
          : WASH_KEYS.includes(key)
            ? `Use oklch(L C H / N%), with N from ${range}.`
            : `Use #rrggbb, #rgb or oklch(L C H), with / ${range} if you like.`;
        continue;
      }
      if (f.key === 'onAccent') for (const k of ON_ACCENT_KEYS) tokens[k] = raw;
      else tokens[key] = raw;
    }
  }
  for (const key of ['relayLight', 'relayLightQuiet', 'relayDark'] as const) {
    if (RELAY_MODE[key] !== form.mode) continue;
    const raw = form.relays[key]?.trim();
    if (!raw) continue;
    const list = raw.split(',').map((v) => v.trim()).filter(Boolean);
    if (list.length < 1 || list.length > RELAY_MAX || list.some((v) => !parseOpaque(v))) {
      errors[key] = `1 to ${RELAY_MAX} colours, separated by commas, with no transparency.`;
      continue;
    }
    tokens[key] = list;
  }
  if (form.radius !== null) tokens.radius = form.radius;
  if (form.shadows) tokens.shadows = form.shadows;
  if (form.font) tokens.font = form.font;
  return { tokens: canonicalTokens(tokens), errors };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      {children}
    </label>
  );
}

function ColorField({
  id,
  label,
  value,
  placeholder,
  alpha,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  alpha: boolean;
  error?: string;
  onChange: (next: string) => void;
}) {
  const errorId = `${id}-error`;
  const shown = parseColor(value.trim()) ?? parseColor(placeholder);
  return (
    <div>
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      <div className="flex items-center gap-2">
        {!alpha && (
          <input
            type="color"
            aria-label={`Pick a colour for ${label}`}
            className="border-border h-9 w-9 flex-none cursor-pointer rounded-[6px] border bg-transparent p-0.5"
            value={shown ? toHex(shown) : '#000000'}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <Input
          data-testid={`theme-field-${id}`}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={value}
          placeholder={placeholder}
          maxLength={64}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 flex-none"
            aria-label={`Reset ${label}`}
            onClick={() => onChange('')}
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      {error && (
        <p id={errorId} className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function ThemeBuilder({
  userId,
  editing,
  onDone,
  onCancel,
}: {
  userId: string;
  /** The theme being edited, or null for a new one. */
  editing: UserMod | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => (editing ? formFromRow(editing) : blankForm()));
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const setColor = (key: FieldKey, value: string) => setForm((f) => ({ ...f, colors: { ...f.colors, [key]: value } }));

  const { tokens, errors } = useMemo(() => tokensFromForm(form), [form]);
  // The browser bar takes a hex only: browser chrome does not reliably read oklch.
  const bar = form.themeColor.trim() ? parseOpaque(form.themeColor.trim()) : null;
  const themeColorError = form.themeColor.trim() && bar?.kind !== 'hex' ? 'Use #rrggbb.' : undefined;
  const themeColor = bar?.kind === 'hex' ? toHex(bar) : undefined;
  const manifest: ThemeManifest = useMemo(
    () => ({ version: 1, mode: form.mode, base: form.base, tokens, ...(themeColor && { themeColor }) }),
    [form.mode, form.base, themeColor, tokens]
  );
  const warnings = useMemo(() => contrastWarnings(manifest), [manifest]);

  // The preview: the draft's rules as a preview twin only (the injector), so
  // nothing but the LookMini below changes while you type.
  const printedKey = JSON.stringify(manifest);
  useEffect(() => {
    const printed = printTheme(JSON.parse(printedKey) as ThemeManifest);
    setUserThemeDraft({ slug: DRAFT_SLUG, mode: printed.mode, decls: printed.decls });
  }, [printedKey]);
  useEffect(() => () => setUserThemeDraft(null), []);

  const layout = useLookStore((s) => s.layout);
  const lightPick = useLookStore((s) => s.light);
  const darkPick = useLookStore((s) => s.dark);
  const tint = usePaletteStore((s) => s.palette);
  const bucketStyle = useViewStore((s) => s.bucketStyle);
  const typeMode = useViewStore((s) => s.typeMode);
  const showCompleted = usePlannerStore((s) => s.showCompletedTasks);

  const bases = form.mode === 'light' ? LIGHT_BASES : DARK_BASES;
  const baseOnly = { base: form.base, tokens: {} };
  const placeholderFor = (key: FieldKey) =>
    effectiveColor(baseOnly, tokenOf(key)) ?? (key === 'onAccent' ? 'Accent text' : 'From the base');

  const blocked = warnings.length > 0 && !form.override;

  const save = async () => {
    const found: string[] = [];
    if (!isModName(form.name.trim())) found.push('Give it a name.');
    if (Object.keys(errors).length > 0 || themeColorError) found.push('Fix the fields marked above.');
    const final: ThemeManifest = { ...manifest, ...(warnings.length > 0 && form.override ? { contrastOverride: true as const } : {}) };
    if (!ThemeManifestSchema.safeParse(final).success) found.push('Something in it is not valid.');
    if (blocked) found.push('Tick Save anyway to keep these colours.');
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    setProblems([]);
    setSaving(true);
    const store = useModsStore.getState();
    if (editing) {
      const ok = await store.saveTheme(editing.id, { name: form.name, manifest: final });
      setSaving(false);
      if (ok) onDone('Saved.');
      else setProblems(['Could not save it. Try again.']);
    } else {
      const created = await store.createTheme(userId, { name: form.name, manifest: final });
      setSaving(false);
      if (created.ok) onDone('Saved. It starts switched off.');
      else setProblems([created.reason]);
    }
  };

  return (
    <div data-testid="theme-builder" className="space-y-4 py-3">
      <h2 className="text-foreground text-sm font-medium">{editing ? 'Edit theme' : 'New theme'}</h2>

      <LookMini
        def={layoutDef(layout)}
        mode={form.mode}
        light={form.mode === 'light' ? DRAFT_SLUG : resolveLightPick(lightPick)}
        dark={form.mode === 'dark' ? DRAFT_SLUG : resolveDarkPick(darkPick)}
        tint={tint}
        bucketStyle={bucketStyle}
        typeMode={typeMode}
        showCompleted={showCompleted}
        className="border-border rounded-[8px] border"
      />

      <Field label="Name">
        <Input
          data-testid="theme-name"
          value={form.name}
          maxLength={60}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Light or dark">
          <select
            data-testid="theme-mode"
            className={selectClass}
            value={form.mode}
            // A saved theme keeps its mode: it may be someone's light or dark
            // pick, and a pick of the other mode would strand on every device.
            disabled={!!editing}
            aria-describedby={editing ? 'theme-mode-kept' : undefined}
            onChange={(e) => {
              const mode = e.target.value as ThemeMode;
              // Colours chosen for one mode rarely read in the other: start over.
              patch({
                mode,
                base: mode === 'light' ? 'paper' : 'night',
                colors: {},
                relays: {},
                themeColor: '',
                override: false,
              });
            }}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <Field label="Start from">
          <select
            data-testid="theme-base"
            className={selectClass}
            value={form.base}
            onChange={(e) => patch({ base: e.target.value as ThemeBaseId })}
          >
            {bases.map((b) => (
              <option key={b} value={b}>
                {BASE_LABEL[b]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {editing && (
        <p id="theme-mode-kept" className="text-muted-foreground text-xs">
          A saved theme stays {form.mode}. Make a new one for {form.mode === 'light' ? 'dark' : 'light'}.
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        Leave a field empty to keep {BASE_LABEL[form.base]}&apos;s. Colours are #rrggbb, #rgb or oklch(L C H). Hover,
        Selected and Behind dialogs need a see-through oklch(L C H / N%), and the borders may take one.
      </p>

      {GROUPS.map((group) => (
        <fieldset key={group.title} className="space-y-3">
          <legend className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
            {group.title}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.fields.map((f) => (
              <ColorField
                key={f.key}
                id={f.key}
                label={f.label}
                value={form.colors[f.key] ?? ''}
                placeholder={placeholderFor(f.key)}
                alpha={!!ALPHA_BOUNDS[tokenOf(f.key)]}
                error={errors[f.key]}
                onChange={(v) => setColor(f.key, v)}
              />
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="space-y-3">
        <legend className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">Shape</legend>
        <Field label={`Corners: ${form.radius ?? THEME_BASES[form.base].tokens.radius ?? 16}px`}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              data-testid="theme-radius"
              min={0}
              max={RADIUS_MAX}
              step={1}
              className="w-full"
              value={form.radius ?? THEME_BASES[form.base].tokens.radius ?? 16}
              onChange={(e) => patch({ radius: Number(e.target.value) })}
            />
            {form.radius !== null && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 flex-none"
                aria-label="Reset corners"
                onClick={() => patch({ radius: null })}
              >
                <RotateCcw className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shadows">
            <select
              data-testid="theme-shadows"
              className={selectClass}
              value={form.shadows ?? ''}
              onChange={(e) => patch({ shadows: (e.target.value || null) as ShadowPreset | null })}
            >
              <option value="">{BASE_LABEL[form.base]}&apos;s</option>
              {SHADOW_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {SHADOW_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Font">
            <select
              data-testid="theme-font"
              className={selectClass}
              value={form.font ?? ''}
              onChange={(e) => patch({ font: (e.target.value || null) as ThemeFont | null })}
            >
              <option value="">{BASE_LABEL[form.base]}&apos;s</option>
              {THEME_FONT_KEYS.map((f) => (
                <option key={f} value={f}>
                  {THEME_FONTS[f].label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
          Background field
        </legend>
        {(['relayLight', 'relayLightQuiet', 'relayDark'] as const)
          .filter((key) => RELAY_MODE[key] === form.mode)
          .map((key) => (
            <div key={key}>
              <Field label={`${RELAY_LABELS[key]} (separate with commas)`}>
                <Input
                  data-testid={`theme-field-${key}`}
                  aria-invalid={errors[key] ? true : undefined}
                  aria-describedby={errors[key] ? `${key}-error` : undefined}
                  value={form.relays[key] ?? ''}
                  placeholder={THEME_BASES[form.base].tokens[key]?.join(', ') ?? 'The shipped colours'}
                  spellCheck={false}
                  onChange={(e) => patch({ relays: { ...form.relays, [key]: e.target.value } })}
                />
              </Field>
              {errors[key] && (
                <p id={`${key}-error`} className="text-destructive mt-1 text-xs">
                  {errors[key]}
                </p>
              )}
            </div>
          ))}
      </fieldset>

      <ColorField
        id="themeColor"
        label="Browser bar colour"
        value={form.themeColor}
        placeholder={toHex(parseColor(effectiveColor(manifest, 'paper0') ?? '#ffffff')!)}
        alpha={false}
        error={themeColorError}
        onChange={(v) => patch({ themeColor: v })}
      />

      {warnings.length > 0 && (
        <div data-testid="theme-contrast" id="theme-contrast" className="border-border space-y-2 rounded-[6px] border p-3">
          <p className="text-foreground text-xs font-medium">Some text may be hard to read:</p>
          <ul className="text-muted-foreground space-y-1 text-xs">
            {warnings.map((w) => (
              <li key={w.label}>
                {w.label}: {w.ratio} to 1, where {w.min} to 1 reads comfortably.
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="theme-save-anyway"
              checked={form.override}
              onChange={(e) => patch({ override: e.target.checked })}
            />
            Save anyway
          </label>
        </div>
      )}

      {problems.length > 0 && (
        <ul data-testid="theme-problems" role="alert" className="text-destructive space-y-1 text-xs">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="theme-save"
          disabled={saving}
          aria-describedby={blocked ? 'theme-contrast' : undefined}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-muted-foreground text-xs">
          {editing ? 'Saving keeps its switch as it is.' : 'It starts switched off.'}
        </span>
      </div>
    </div>
  );
}
