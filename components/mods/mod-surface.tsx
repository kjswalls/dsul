'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Puzzle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useModsStore } from '@/lib/mods-store';
import { splitModReason } from '@/lib/mods/faults';
import { modSurfaceLabel, surfaceMessage } from '@/lib/mods/labels';
import { modSandbox } from '@/lib/mods/sandbox-host';
import { ModIcon } from '@/lib/mods/ui/icons';
import type { ModPanelRef } from '@/lib/mods/ui/open-panel';
import { panelKey, usePanelStore } from '@/lib/mods/ui/panel-store';
import { panelOf, surfaceStateOf } from '@/lib/mods/ui/surface-state';
import { cn } from '@/lib/utils';
import { ModTree } from './mod-tree';

/**
 * One mod panel wherever it shows (memory/plans/mods.md, build order 9): the
 * rail, the braindump card or the phone's sheet. It draws the host's chrome
 * (the panel's icon, the mod's name, a "Your mod" badge and the panel's
 * label) above and outside the tree, so a mod can never draw a surface that
 * reads as the app's own. Below it, the panel's state (surfaceStateOf):
 * a skeleton while it loads, the tree, "draws nothing", the error with Try
 * again, switched off, or the sandbox's "can't run here".
 *
 * A mod's own words (a fault's message, the reason it was switched off) show
 * only under "Your mod reported:", and only when they meet the surface rule;
 * otherwise "(message hidden)".
 *
 * It counts as showing the panel (panel-store's mountPanel) only while
 * `active` and the mod can draw, so a rail covered by an item, or a card
 * whose braindump is closed, resolves nothing.
 */

export type ModPresentation = 'rail' | 'card' | 'sheet';

export interface ModSurfaceProps {
  panelRef: ModPanelRef | null;
  presentation: ModPresentation;
  /** False while something covers it: it keeps its state but asks for no draws. */
  active?: boolean;
  /** Runs before "Open in Make" navigates: the rail or sheet closes itself here. */
  onLeave?: () => void;
  /** After the chrome's label: the rail's close button. */
  trailing?: ReactNode;
  /** The chrome row's own classes, for the rail's header alignment. */
  headerClassName?: string;
}

const MESSAGE_MAX = 200;

const BODY: Record<ModPresentation, string> = {
  rail: 'min-h-0 flex-1 overflow-y-auto px-4 py-3',
  card: 'max-h-[min(320px,40vh)] overflow-y-auto px-3 pb-3',
  sheet: 'max-h-[70vh] overflow-y-auto px-4 pb-4',
};

const clip = (s: string) => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX - 1)}…` : s);

export function ModSurface({
  panelRef,
  presentation,
  active = true,
  onLeave,
  trailing,
  headerClassName,
}: ModSurfaceProps) {
  const router = useRouter();
  const rows = useModsStore((s) => s.rows);
  const safeMode = useModsStore((s) => s.safeMode);
  const key = panelRef ? panelKey(panelRef) : '';
  const status = usePanelStore((s) => s.status[key]);
  const cached = usePanelStore((s) => s.trees[key]);
  const message = usePanelStore((s) => s.errors[key]);
  const throttled = usePanelStore((s) => !!s.throttled[key]);
  const slowed = usePanelStore((s) => !!panelRef && !!s.slowed[panelRef.modId]);
  const [box, setBox] = useState<HTMLElement | null>(null);

  const row = panelRef ? (rows.find((r) => r.id === panelRef.modId && r.kind === 'mod') ?? null) : null;
  const panel = row && panelRef ? panelOf(row, panelRef.panelId) : null;
  const state = surfaceStateOf(panelRef, { rows, safeMode, sandboxStatus: modSandbox.status(), panel: status });
  const live = active && state !== 'absent' && state !== 'off' && state !== 'unavailable';

  useEffect(() => {
    if (!live || !panelRef) return;
    return usePanelStore.getState().mountPanel(panelRef);
    // The key names the panel; the ref object itself may be new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, key]);

  if (state === 'absent' || !panelRef) return null;

  const name = row ? modSurfaceLabel(row) : 'Your mod';
  const card = presentation === 'card';
  // The card wears the host's mod glyph, apart from the dock under it; the rail and sheet the panel's own.
  const iconName = card ? undefined : panel?.icon;

  const openMake = () => {
    onLeave?.();
    router.push('/settings/make');
  };
  const makeButton = (
    <Button type="button" size="sm" variant="outline" onClick={openMake}>
      Open in Make
    </Button>
  );
  const reported = (text: string | null | undefined) =>
    text ? (
      <p data-testid="mod-surface-reported" className="text-muted-foreground text-xs">
        Your mod reported: <span className="[overflow-wrap:anywhere]">{clip(surfaceMessage(text))}</span>
      </p>
    ) : null;

  let body: ReactNode;
  if (state === 'unavailable') {
    body = (
      <p className="text-muted-foreground text-sm">
        {modSandbox.status() === 'outdated' ? 'Reload to run your mods' : 'Mods can’t run in this browser yet'}
      </p>
    );
  } else if (state === 'off') {
    const split = row?.disabledReason ? splitModReason(row.disabledReason) : null;
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-foreground text-sm">This mod is switched off.</p>
        {split ? (
          <>
            <p className="text-muted-foreground text-xs">{split.head}</p>
            {reported(split.reported)}
          </>
        ) : (
          reported(row?.disabledReason)
        )}
        {makeButton}
      </div>
    );
  } else if (state === 'error') {
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-foreground text-sm">This mod hit an error</p>
        {reported(message)}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="mod-surface-retry"
            onClick={() => usePanelStore.getState().retry(panelRef)}
          >
            Try again
          </Button>
          {makeButton}
        </div>
      </div>
    );
  } else if (state === 'empty') {
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted-foreground text-sm">This mod draws nothing here yet.</p>
        {makeButton}
      </div>
    );
  } else if (cached && (state === 'ok' || state === 'loading')) {
    body = (
      <section aria-label={`${name}, your mod`} className="flex min-w-0 flex-col gap-2">
        <ModTree
          tree={cached.tree}
          seq={cached.seq}
          modId={panelRef.modId}
          panelId={panelRef.panelId}
          inSheet={presentation === 'sheet'}
          boundary={box}
        />
        {throttled && <p className="text-muted-foreground text-xs">Paused, redrawing too often</p>}
        {slowed && <p className="text-muted-foreground text-xs">Slow down a little</p>}
      </section>
    );
  } else {
    body = (
      <div data-testid="mod-surface-loading" aria-hidden className="flex flex-col gap-2 py-1">
        <div className="bg-muted h-3 w-3/4 rounded" />
        <div className="bg-muted h-3 w-1/2 rounded" />
        <div className="bg-muted h-3 w-2/3 rounded" />
      </div>
    );
  }

  return (
    <div
      data-testid="mod-surface"
      data-mod-presentation={presentation}
      data-mod-state={state}
      className={cn('flex min-w-0 flex-col', presentation === 'rail' && 'h-full min-h-0')}
    >
      <div
        data-testid="mod-surface-chrome"
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          card ? 'px-3 pt-2.5 pb-2 text-xs' : 'px-4 py-3 text-sm',
          headerClassName
        )}
      >
        <ModIcon name={iconName} fallback={Puzzle} aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="text-foreground min-w-0 truncate font-medium">{name}</span>
        <Badge variant="outline" className="focus-visible:ring-ring">
          Your mod
        </Badge>
        {panel && (
          <span className="text-muted-foreground min-w-0 truncate">
            <span aria-hidden>· </span>
            {panel.label}
          </span>
        )}
        {trailing && <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
      </div>
      <div ref={setBox} className={BODY[presentation]}>
        {body}
      </div>
    </div>
  );
}
