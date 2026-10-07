"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useModsStore } from "@/lib/mods-store";
import {
  LookManifestSchema,
  isModName,
  type LookManifest,
  type UserMod,
} from "@/lib/mods/schema";
import {
  LAYOUTS,
  isLayoutTheme,
  layoutDef,
  type LayoutTheme,
} from "@/lib/layout-themes";
import {
  DARK_LOOKS,
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  LIGHT_LOOKS,
  resolveDarkPick,
  resolveLightPick,
  type LookMode,
} from "@/lib/theme-looks";
import { isUserThemeSlug } from "@/lib/user-themes/css";
import { useUserThemes } from "@/lib/user-themes/store";
import {
  isOwnedPick,
  lookRefProblems,
  ownThemesOfMode,
} from "@/lib/user-looks";
import { useLookStore } from "@/lib/look-store";
import { usePaletteStore } from "@/lib/palette-store";
import { useViewStore } from "@/lib/view-store";
import { usePlannerStore } from "@/lib/planner-store";
import { LookMini } from "./look-mini";

/**
 * Settings → Make's Look form (memory/plans/mods.md, "Themes and Looks", build
 * order 5b): a name, one of the shipped layouts, and a light and a dark theme,
 * each a built-in or one of your own of that mode. No layout remixes
 * (decision 5). Saved switched off, like everything here; an edit keeps the
 * switch, since a Look is values.
 *
 * The previews draw each side as it resolves now, so a theme of yours that
 * is off shows the default here too, as it would once applied.
 */

interface FormState {
  name: string;
  layout: LayoutTheme;
  light: string;
  dark: string;
}

const selectClass =
  "field dark:bg-input/30 h-9 w-full min-w-0 border bg-transparent px-2 py-1 text-sm outline-none";

/** A saved Look back into the form; one that no longer parses keeps its name only. */
function formFromRow(row: UserMod): FormState {
  const parsed = LookManifestSchema.safeParse(row.manifest);
  if (!parsed.success)
    return {
      name: row.name,
      layout: "classic",
      light: DEFAULT_LIGHT_LOOK,
      dark: DEFAULT_DARK_LOOK,
    };
  return { name: row.name, ...parsed.data };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      {children}
    </label>
  );
}

function ThemeSelect({
  mode,
  value,
  onChange,
}: {
  mode: LookMode;
  value: string;
  onChange: (next: string) => void;
}) {
  // From the rows, not the theme registry: the rows say off from gone, and
  // they are there in safe mode, where the registry is empty.
  const rows = useModsStore((s) => s.rows);
  const yours = useMemo(() => ownThemesOfMode(rows, mode), [rows, mode]);
  const builtIns = mode === "light" ? LIGHT_LOOKS : DARK_LOOKS;
  // A saved Look naming a theme of yours that has since gone keeps it, so
  // opening the form never changes the Look by itself; Save then asks for
  // another (lookRefProblems).
  const gone = isUserThemeSlug(value) && !yours.some((t) => t.slug === value);
  const label = mode === "light" ? "Light theme" : "Dark theme";
  return (
    <Field label={label}>
      <select
        data-testid={`look-${mode}`}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {builtIns.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
        {(yours.length > 0 || gone) && (
          <optgroup label="Yours">
            {yours.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.enabled ? t.label : `${t.label} (off)`}
              </option>
            ))}
            {gone && <option value={value}>A theme you deleted</option>}
          </optgroup>
        )}
      </select>
    </Field>
  );
}

export function LookBuilder({
  userId,
  editing,
  onDone,
  onCancel,
}: {
  userId: string;
  /** The Look being edited, or null for a new one. */
  editing: UserMod | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() =>
    editing
      ? formFromRow(editing)
      : {
          name: "",
          layout: useLookStore.getState().layout,
          light: DEFAULT_LIGHT_LOOK,
          dark: DEFAULT_DARK_LOOK,
        },
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  // Subscribed so the previews redraw when a theme of yours switches on or off.
  useUserThemes((s) => s.rev);
  const tint = usePaletteStore((s) => s.palette);
  const bucketStyle = useViewStore((s) => s.bucketStyle);
  const typeMode = useViewStore((s) => s.typeMode);
  const showCompleted = usePlannerStore((s) => s.showCompletedTasks);

  const def = layoutDef(form.layout);
  const light = resolveLightPick(form.light);
  const dark = resolveDarkPick(form.dark);

  /**
   * The picks as saved: a theme of yours stays itself even while it is off
   * (or held back by safe mode), as the Look would save it; a pick naming
   * none of your themes of that mode becomes the default.
   */
  const useCurrent = () => {
    const now = useLookStore.getState();
    const rows = useModsStore.getState().rows;
    patch({
      layout: now.layout,
      light: isOwnedPick(now.light, "light", rows)
        ? now.light
        : DEFAULT_LIGHT_LOOK,
      dark: isOwnedPick(now.dark, "dark", rows) ? now.dark : DEFAULT_DARK_LOOK,
    });
  };

  const save = async () => {
    const found: string[] = [];
    if (!isModName(form.name.trim())) found.push("Give it a name.");
    const parsed = LookManifestSchema.safeParse({
      version: 1,
      layout: form.layout,
      light: form.light,
      dark: form.dark,
    });
    let manifest: LookManifest | null = null;
    if (!parsed.success) {
      if (!isLayoutTheme(form.layout)) found.push("Pick a layout.");
      found.push("Something in it is not valid.");
    } else {
      manifest = parsed.data;
      found.push(...lookRefProblems(manifest, useModsStore.getState().rows));
    }
    if (found.length > 0 || !manifest) {
      setProblems(found);
      return;
    }
    setProblems([]);
    setSaving(true);
    const store = useModsStore.getState();
    if (editing) {
      const ok = await store.saveLook(editing.id, {
        name: form.name,
        manifest,
      });
      setSaving(false);
      if (ok) onDone("Saved.");
      else setProblems(["Could not save it. Try again."]);
    } else {
      const created = await store.createLook(userId, {
        name: form.name,
        manifest,
      });
      setSaving(false);
      if (created.ok) onDone("Saved. It starts switched off.");
      else setProblems([created.reason]);
    }
  };

  const mini = (mode: LookMode) => (
    <figure className="m-0 min-w-0">
      <LookMini
        def={def}
        mode={mode}
        light={light}
        dark={dark}
        tint={tint}
        bucketStyle={bucketStyle}
        typeMode={typeMode}
        showCompleted={showCompleted}
        className="border-border rounded-[8px] border"
      />
      <figcaption className="text-muted-foreground mt-1 text-xs">
        {mode === "light" ? "Light" : "Dark"}
      </figcaption>
    </figure>
  );

  return (
    <div data-testid="look-builder" className="space-y-4 py-3">
      <h2 className="text-foreground text-sm font-medium">
        {editing ? "Edit Look" : "New Look"}
      </h2>

      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        data-testid="look-previews"
      >
        {mini("light")}
        {mini("dark")}
      </div>

      <Field label="Name">
        <Input
          data-testid="look-name"
          value={form.name}
          maxLength={60}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      <div>
        <Field label="Layout">
          <select
            data-testid="look-layout"
            className={selectClass}
            value={form.layout}
            onChange={(e) => {
              if (isLayoutTheme(e.target.value))
                patch({ layout: e.target.value });
            }}
          >
            {LAYOUTS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-muted-foreground mt-1 text-xs">
          Layouts and Looks show on a computer. A recipe that applies one on a
          phone sets only its colours.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ThemeSelect
          mode="light"
          value={form.light}
          onChange={(v) => patch({ light: v })}
        />
        <ThemeSelect
          mode="dark"
          value={form.dark}
          onChange={(v) => patch({ dark: v })}
        />
      </div>

      {def.slots.skin !== "theme" && (
        <p className="text-muted-foreground text-xs">
          {def.label} brings its own colours. These themes still dress menus and
          dialogs.
        </p>
      )}

      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="look-use-current"
        onClick={useCurrent}
      >
        Use what I have now
      </Button>

      {problems.length > 0 && (
        <ul
          data-testid="look-problems"
          role="alert"
          className="text-destructive space-y-1 text-xs"
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="look-save"
          disabled={saving}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-muted-foreground text-xs">
          {editing
            ? "Saving keeps its switch as it is."
            : "It starts switched off."}
        </span>
      </div>
    </div>
  );
}
