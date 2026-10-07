'use client';

import { useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useModsStore } from '@/lib/mods-store';
import { useUIStore } from '@/lib/ui-store';
import { MOD_KINDS, modLabel, type ModKind, type UserMod } from '@/lib/mods/schema';
import type { SettingCtx } from '@/lib/settings/manifest';

/**
 * Settings → Make: what the person made, one section per kind, each with a
 * switch and Delete (memory/plans/mods.md). Building them comes in later PRs;
 * this is the list and the off switches.
 *
 * Rows load lazily, here: nothing outside Make needs them until recipes run.
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

  useEffect(() => {
    if (ctx.userId) void useModsStore.getState().hydrate(ctx.userId);
  }, [ctx.userId]);

  return (
    <div className="mb-2" data-testid="make-pane">
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
      ) : !loaded ? null : rows.length === 0 ? (
        <div data-testid="make-empty" className="py-3">
          <p className="text-foreground text-sm font-medium">Nothing made yet</p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Make is where your own recipes, mods, themes and Looks live. A recipe does something
            when you tick, skip or add an item. A mod adds a small panel or command. A theme sets
            the colors, and a Look pairs a layout with a theme for day and night. Whatever you make
            starts switched off and runs only for you.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">Recipes are coming soon.</p>
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
                  <MakeRow key={row.id} row={row} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function MakeRow({ row }: { row: UserMod }) {
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
    <div className="flex items-center gap-3 py-3" data-make-row={row.id}>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm">{label}</span>
        <span id={stateId} className="text-muted-foreground block text-xs">
          {stateText}
        </span>
      </span>
      <Switch
        checked={row.enabled}
        aria-label={label}
        aria-describedby={stateId}
        onCheckedChange={(on) => void useModsStore.getState().setEnabled(row.id, on)}
      />
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
  );
}
