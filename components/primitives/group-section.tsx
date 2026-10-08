'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { BUCKET_LABEL_INK } from '@/components/primitives/bucket-card';
import { GateSwitch } from '@/components/primitives/gate-switch';
import { ContainerContextMenu, type ContainerMenuKind } from '@/components/planner/container-context-menu';
import { CategoryIcon } from '@/lib/category-icons';
import { containerKindOf, containerName, sameContainerName } from '@/lib/container-registry';
import { usePlannerStore } from '@/lib/planner-store';
import { cn } from '@/lib/utils';

/**
 * Section heading: a category icon (lib/category-icons) + label in the content
 * color + a chevron that collapses/expands the rows. When the section names a
 * container, its stored glyph (a picked icon token) drives the
 * icon — resolved from the live store so editing a project's icon updates the
 * heading; otherwise the icon derives from the label name. Icon matches the
 * label's font color.
 * The whole heading row is the hit target — hovering anywhere reveals the
 * chevron and a subtle highlight, Linear-style. Collapse state is local.
 *
 * `variant` picks the surface. 'sidebar' (default, the Braindump) keeps the
 * leading type icon and the content-color label. 'canvas' (the body/day
 * views) drops the icon and uses the muted-gray label from the mockups — the
 * icon and heavier color there were noise that hurt row readability.
 */
export function GroupSection({
  label,
  groupKey,
  gate,
  children,
  className,
  variant = 'sidebar',
  forceOpen = false,
}: {
  label: string;
  /**
   * `RowGroup.key` — the prefixed ref when this section names a container.
   *
   * The glyph is resolved from THIS, not from `label`, because a label has had
   * its namespace thrown away and a heading is not the only thing that can be
   * called "Work". Before A′ the lookup matched a container by bare label, which
   * meant a project named "High" put its emoji on the Priority › High heading.
   * The key still carries a KIND for that reason after 039 collapsed the two
   * classify kinds: `containerKindOf` answering at all is what says "this
   * section is a container", and a bare name could not.
   *
   * Omitted means "this section is not a container" — no store lookup at all,
   * and `CategoryIcon` derives from the name as it always has.
   */
  groupKey?: string;
  /**
   * Present only on GATE sections (routine/season) — `RowGroup.gate`. When set,
   * the header carries a pause switch for that container. Omitted everywhere
   * else, so no other heading gains a control.
   */
  gate?: { kind: 'routine' | 'season'; id: string };
  children: React.ReactNode;
  className?: string;
  variant?: 'canvas' | 'sidebar';
  /**
   * Show the rows while this is true, whatever the chevron says, without
   * touching the user's collapse. The braindump sets it on the section a
   * dragged item is about to land in, so the slot it lights is on screen.
   */
  forceOpen?: boolean;
}) {
  const isCanvas = variant === 'canvas';
  const [collapsedByUser, setCollapsed] = useState(false);
  const collapsed = collapsedByUser && !forceOpen;
  // Subscribe to the arrays (not the getter fns) so a glyph edit re-renders.
  const projects = usePlannerStore((s) => s.projects);
  const kind = groupKey ? containerKindOf(groupKey) : null;
  const name = kind ? containerName(groupKey!) : '';
  // `kind` is still the gate, not decoration: it is what keeps this from
  // hunting a container glyph for a `priority:high` or `goal:none` heading.
  const glyph = kind
    ? projects.find((p) => sameContainerName('project', p.name, name))?.emoji
    : undefined;

  const heading = (
    <button
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      className={cn(
        'group/heading flex items-center gap-1 rounded-[5px] py-1 text-xs font-medium',
        // flex-1 (not w-full) when a switch sits beside it, so the switch keeps
        // its width and the label truncates into what is left; w-full otherwise,
        // the shape every non-gate heading has always had. The hover wash rides
        // the WRAPPER in the gate case (so the switch + right padding highlight
        // too — the whole row is the hit target), and the button itself here.
        gate ? 'min-w-0 flex-1' : 'w-full hover:bg-accent',
        // px-2 on canvas, matching TaskRow's own px-2, so this label lands on
        // the checkbox column instead of 4px shy of it. That near-miss was
        // invisible while the bucket caption above sat out on the card's edge;
        // now that the caption indents to the rows' columns it is the only
        // thing on this left edge not on one.
        isCanvas ? 'px-2' : 'px-1',
        // BUCKET_LABEL_INK — the canvas heading and the bucket caption above
        // it are the same voice, and both sit UNDER the rows in the reading
        // order on purpose. Imported rather than re-typed so muting one can't
        // silently leave the other behind.
        isCanvas ? BUCKET_LABEL_INK : 'text-foreground/70'
      )}
    >
      {!isCanvas && (
        <CategoryIcon glyph={glyph} name={label} className="mr-0.5 shrink-0 text-foreground/70" />
      )}
      <span className={cn(gate && 'truncate')}>{label}</span>
      <ChevronDown
        className={cn(
          'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
          collapsed && '-rotate-90'
        )}
      />
    </button>
  );

  // The container this heading names, for its right-click menu: a gate carries
  // its id; a project heading only its name, resolved the way the glyph is.
  const projectId =
    kind === 'project' ? projects.find((p) => sameContainerName('project', p.name, name))?.id : undefined;
  const menuTarget: { kind: ContainerMenuKind; id: string } | undefined =
    gate ?? (projectId ? { kind: 'project', id: projectId } : undefined);

  const head = gate ? (
    // A gate section pairs the collapse control with a pause switch. The
    // switch must be a SIBLING of the button, not nested inside it —
    // interactive controls cannot nest, and the outer button's click would
    // otherwise toggle collapse. pr matches the button's own px so the switch
    // lands on the row's right padding.
    <div
      className={cn('flex items-center rounded-[5px] hover:bg-accent', isCanvas ? 'pr-2' : 'pr-1')}
    >
      {heading}
      <GateSwitch kind={gate.kind} id={gate.id} />
    </div>
  ) : (
    heading
  );

  return (
    // A settle frame (lib/settle.ts): the cached → fresh landing glides the
    // section to its new place, and its rows ride along.
    <div className={className} data-settle-key={`group:${groupKey ?? label}`} data-settle-role="frame">
      {menuTarget ? (
        <ContainerContextMenu kind={menuTarget.kind} id={menuTarget.id}>
          {head}
        </ContainerContextMenu>
      ) : (
        head
      )}
      {!collapsed && <div className="space-y-0">{children}</div>}
    </div>
  );
}
