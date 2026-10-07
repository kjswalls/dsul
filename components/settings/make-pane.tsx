'use client';

import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useModsStore } from '@/lib/mods-store';
import { useUIStore } from '@/lib/ui-store';
import { MOD_KINDS, modLabel, type ModKind, type UserMod } from '@/lib/mods/schema';
import type { SettingCtx } from '@/lib/settings/manifest';
import { RecipeBuilder } from './recipe-builder';
import { RecipeRuns } from './recipe-runs';

/**
 * Settings → Make: what the person made, one section per kind, each with a
 * switch and Delete (memory/plans/mods.md). Recipes also get New, Edit and
 * Recent runs (./recipe-builder.tsx, ./recipe-runs.tsx); building mods, themes
 * and Looks comes in later PRs.
 *
 * Rows load here, and from RecipeHost (components/recipes/recipe-host.tsx) on
 * any route where the planner has loaded, since that is where recipes run.
 * The pane's one record ("Turn all mods off", make.allOff) is drawn below this
 * by the shell's flat rows, which is also what makes the pane searchable.
 */

const SECTION: Record<ModKind, string> = {
  recipe: 'Recipes',
  mod: 'Mods',
  theme: 'Themes',
  look: 'Looks',
};

export function MakePane({ ctx }: { ctx: SettingCtx }) {
  const available = useModsStore((s) => s.available);
  const loaded = useModsStore((s) => s.loaded);
  const failed = useModsStore((s) => s.failed);
  const rows = useModsStore((s) => s.rows);
  const safeMode = useModsStore((s) => s.safeMode);
  /** null: the list. 'new' or a row id: the recipe form in its place. */
  const [editing, setEditing] = useState<null | 'new' | string>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editingRow = editing && editing !== 'new' ? (rows.find((r) => r.id === editing) ?? null) : null;
  const paneRef = useRef<HTMLDivElement>(null);
  /** What opened the form, so closing it puts focus back there and not on <body>. */
  const opener = useRef<null | 'new' | string>(null);

  useEffect(() => {
    if (editing !== null || opener.current === null) return;
    const from = opener.current;
    opener.current = null;
    const pane = paneRef.current;
    const back =
      (from !== 'new' && pane?.querySelector<HTMLElement>(`[data-make-row="${from}"] [data-make-edit]`)) ||
      pane?.querySelector<HTMLElement>('[data-testid="make-new-recipe"]');
    back?.focus();
  }, [editing]);

  useEffect(() => {
    if (ctx.userId) void useModsStore.getState().hydrate(ctx.userId);
  }, [ctx.userId]);

  return (
    <div className="mb-2" data-testid="make-pane" ref={paneRef}>
      {safeMode && (
        <p
          data-testid="make-safe-mode"
          role="status"
          className="border-border bg-secondary text-foreground mb-3 rounded-[6px] border px-3 py-2 text-xs"
        >
          Safe mode is on. Nothing you made runs in this tab. Reload without ?safe-mode to turn it off.
        </p>
      )}

      {!available ? (
        <p data-testid="make-unavailable" className="text-muted-foreground py-3 text-xs">
          Make needs a database update that has not landed here yet.
        </p>
      ) : failed ? (
        <div data-testid="make-failed" className="flex items-center gap-3 py-3">
          <p className="text-muted-foreground flex-1 text-xs">Could not load what you made.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (ctx.userId) void useModsStore.getState().hydrate(ctx.userId);
            }}
          >
            Try again
          </Button>
        </div>
      ) : !loaded ? null : editing && ctx.userId && (editing === 'new' || editingRow) ? (
        <RecipeBuilder
          key={editing}
          userId={ctx.userId}
          editing={editingRow}
          onCancel={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            setNotice(message);
          }}
        />
      ) : rows.length === 0 ? (
        <div data-testid="make-empty" className="py-3">
          <p className="text-foreground text-sm font-medium">Nothing made yet</p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Make is where your own recipes, mods, themes and Looks live. A recipe does something
            when you tick, skip or add an item. A mod adds a small panel or command. A theme sets
            the colors, and a Look pairs a layout with a theme for day and night. Whatever you make
            starts switched off and runs only for you.
          </p>
        </div>
      ) : (
        MOD_KINDS.map((kind) => {
          const ofKind = rows.filter((r) => r.kind === kind);
          if (ofKind.length === 0) return null;
          return (
            <section key={kind} data-make-section={kind}>
              <h2 className="text-muted-foreground mt-4 mb-1 text-[10px] font-medium tracking-wider uppercase">
                {SECTION[kind]}
              </h2>
              <div className="divide-border divide-y">
                {ofKind.map((row) => (
                  <MakeRow
                    key={row.id}
                    row={row}
                    onEdit={
                      row.kind === 'recipe'
                        ? () => {
                            setNotice(null);
                            opener.current = row.id;
                            setEditing(row.id);
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      {available && loaded && !failed && !editing && ctx.userId && (
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            data-testid="make-new-recipe"
            onClick={() => {
              setNotice(null);
              opener.current = 'new';
              setEditing('new');
            }}
          >
            <Plus className="size-3.5" aria-hidden /> New recipe
          </Button>
          {notice && (
            <p role="status" data-testid="make-notice" className="text-muted-foreground text-xs">
              {notice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A time trigger is the server runner's (build order 6), so such a row says it waits. */
function waitsForServer(row: UserMod): boolean {
  return (row.manifest as { trigger?: { on?: unknown } } | null)?.trigger?.on === 'time';
}

function MakeRow({ row, onEdit }: { row: UserMod; onEdit?: () => void }) {
  const stateId = `make-state-${row.id}`;
  const label = modLabel(row);
  const stateText = row.disabledReason
    ? `Switched off: ${row.disabledReason}`
    : row.enabled
      ? 'On'
      : 'Off';

  const askDelete = () =>
    useUIStore.getState().confirm({
      title: `Delete ${label}?`,
      description: 'It goes from every device and cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      testId: 'make-delete-confirm',
      onConfirm: () => void useModsStore.getState().remove(row.id),
    });

  return (
    <div data-make-row={row.id}>
      <div className="flex items-center gap-3 py-3">
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm">{label}</span>
          <span id={stateId} className="text-muted-foreground block text-xs">
            {stateText}
          </span>
          {row.kind === 'recipe' && waitsForServer(row) && (
            <span className="text-muted-foreground block text-xs">Runs at a set time. Not available yet.</span>
          )}
        </span>
        <Switch
          checked={row.enabled}
          aria-label={label}
          aria-describedby={stateId}
          onCheckedChange={(on) => void useModsStore.getState().setEnabled(row.id, on)}
        />
        {onEdit && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            data-make-edit
            aria-label={`Edit ${label}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Delete ${label}`}
          onClick={askDelete}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
      {row.kind === 'recipe' && <RecipeRuns modId={row.id} label={label} />}
    </div>
  );
}
