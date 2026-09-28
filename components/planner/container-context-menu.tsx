'use client';

import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Link2, Maximize2, PanelRight, Power, PowerOff } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ItemMenuRow as Row } from '@/components/planner/item-context-menu';
import { PANEL } from '@/components/shell/bulk-edit-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useOpenConsole } from '@/lib/console-door';
import { useGoalsEnabled, useOrganizeEnabled } from '@/lib/extension-gates';
import { isSeasonActiveOn, routineStandingOn } from '@/lib/active';
import { setGateOn } from '@/lib/gate-toggle';
import { usePlannerStore } from '@/lib/planner-store';
import { toDateStr } from '@/lib/recurrence';

/**
 * THE RIGHT-CLICK MENU ON A CONTAINER — a project, routine, season or goal,
 * wherever one is drawn as a thing of its own: a canvas or braindump group
 * heading, a project's time block on the grid, an Organize list row.
 *
 * Deliberately small, and every row is a door to something that already
 * exists: the Organize pane (through useOpenConsole, the one sanctioned way to
 * arm that slot — lib/console-door.ts), the container's page, and the gate
 * switch's own write (lib/gate-toggle.ts). Delete is NOT here: each pane
 * words its own consequence sentence from what it holds, and a second copy of
 * those sentences is exactly the kind that drifts. It stays in the pane's ⋯.
 *
 * Pointer only, like the item menu.
 */

export type ContainerMenuKind = 'project' | 'routine' | 'season' | 'goal';

export function ContainerContextMenu({
  kind,
  id,
  inConsole,
  children,
}: {
  kind: ContainerMenuKind;
  id: string;
  /** Inside the console already: no "Open in Organize" — the row's click is that. */
  inConsole?: boolean;
  children: ReactElement;
}) {
  const isMobile = useIsMobile();
  const coarse = useMediaQuery('(pointer: coarse)');
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={isMobile || coarse}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className={PANEL} data-testid="container-context-menu" data-container-kind={kind}>
        <Body kind={kind} id={id} inConsole={inConsole} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const SECTION: Record<ContainerMenuKind, string> = {
  project: 'projects',
  routine: 'routines',
  season: 'seasons',
  goal: 'goals',
};

function Body({ kind, id, inConsole }: { kind: ContainerMenuKind; id: string; inConsole?: boolean }) {
  const router = useRouter();
  const openConsole = useOpenConsole();
  const organizeOn = useOrganizeEnabled();
  const goalsOn = useGoalsEnabled();
  const projects = usePlannerStore((s) => s.projects);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const goals = usePlannerStore((s) => s.goals);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  const list: readonly { id: string; name: string }[] =
    kind === 'project' ? projects : kind === 'routine' ? routines : kind === 'season' ? seasons : (goals ?? []);
  const container = list.find((c) => c.id === id);
  if (!container) return null;

  // Pausing is dateless: the switch is read and written at wall-clock today.
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toDateStr(new Date(), tz);
  const gateOn =
    kind === 'routine'
      ? routineStandingOn(routines.find((r) => r.id === id)!, seasons, today, tz).localOn
      : kind === 'season'
        ? isSeasonActiveOn(seasons.find((s) => s.id === id)!, today)
        : undefined;

  // The console's own gates: goals ride a second switch on top of Organize.
  const consoleDoor = !inConsole && organizeOn && (kind !== 'goal' || goalsOn);
  const href = `/${kind}/${id}`;

  return (
    <>
      <ContextMenuLabel className="text-muted-foreground max-w-60 truncate px-2 py-1 text-2xs font-normal">
        {container.name}
      </ContextMenuLabel>
      {consoleDoor && (
        <Row
          icon={<PanelRight className="size-3.5" />}
          label="Open in Organize"
          testId="container-menu-open"
          onSelect={() => openConsole({ section: SECTION[kind], focusId: id })}
        />
      )}
      <Row
        icon={<Maximize2 className="size-3.5" />}
        label="Open as page"
        testId="container-menu-open-page"
        onSelect={() => router.push(href)}
      />
      {gateOn !== undefined && (
        <>
          <ContextMenuSeparator />
          <Row
            icon={gateOn ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
            label={gateOn ? 'Turn off' : 'Turn on'}
            testId="container-menu-gate"
            onSelect={() => setGateOn(kind as 'routine' | 'season', id, !gateOn)}
          />
        </>
      )}
      <ContextMenuSeparator />
      <Row
        icon={<Link2 className="size-3.5" />}
        label="Copy link"
        testId="container-menu-copy-link"
        onSelect={() => {
          void navigator.clipboard?.writeText(`${window.location.origin}${href}`).then(
            () => toast('Link copied'),
            () => toast.error('Couldn’t copy the link')
          );
        }}
      />
    </>
  );
}
