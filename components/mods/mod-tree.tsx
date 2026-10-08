'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { ChevronDownIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { SelectContent, SelectItem } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { isSafeTypedValue } from '@/lib/mods/labels';
import { MOD_ATOM_TEXT_MAX, MOD_CLICK_SETTLE_MS } from '@/lib/mods/limits';
import type { AtomValue } from '@/lib/mods/protocol';
import { ModIcon } from '@/lib/mods/ui/icons';
import { runPanelAction } from '@/lib/mods/ui/panel-run';
import { atomsOf, usePanelStore } from '@/lib/mods/ui/panel-store';
import { atomValueFits, isRealDate, nodeKey, type AtomKind, type ModNode, type ModTone } from '@/lib/mods/ui/tree';
import { cn } from '@/lib/utils';
import { ModItemRef } from './mod-item-ref';

/**
 * Draws a mod panel's element tree (memory/plans/mods.md, build order 9).
 * The tree passed lib/mods/ui/tree.ts's parseModTree, so every string in it
 * met the surface rule; this still draws text only as React text, and nothing
 * the mod sent reaches a style, a class, a link or innerHTML.
 *
 * The lime never dims: tones are semantic tokens only, no class here or in
 * the wrappers carries an opacity or an alpha on primary, ring or success
 * (tests/unit/mods-ui-renderer.test.tsx walks the rendered DOM for it), and a
 * button in flight is `aria-busy`, never `disabled`, so it never fades.
 *
 * A press goes to the mod only as the person saw it: the tree's seq at
 * pointerdown or keydown must still be the current one at the click, and the
 * button must have looked the same for MOD_CLICK_SETTLE_MS. Anything else is
 * ignored without a word, since the newer tree is already showing.
 *
 * Fields read their atom from the panel store, falling back to the node's
 * initial value when the stored one does not fit the node. A checkbox or a
 * select commits on change; text, number and date keep a draft and commit on
 * blur or Enter. What the person types is refused when it is shaped like a
 * password or key, and no field takes autofill.
 */

export interface ModTreeProps {
  tree: ModNode;
  seq: number;
  modId: string;
  panelId: string;
  /** Drawn in the phone's sheet: an item opened from here closes the sheet first. */
  inSheet?: boolean;
  /** Where a select's list may go (the surface's own box). */
  boundary?: HTMLElement | null;
}

/* ── tones: semantic tokens only, so themes and Looks re-point them ───── */

const TEXT_TONE: Record<ModTone, string> = {
  muted: 'text-muted-foreground',
  accent: 'text-success-text',
  warn: 'text-warning-text',
};

const FILL_TONE: Record<ModTone, string> = {
  muted: 'bg-muted-foreground',
  accent: 'bg-primary',
  warn: 'bg-warning',
};

const BADGE_TONE: Record<ModTone, string> = {
  muted: 'text-muted-foreground',
  accent: 'bg-primary text-primary-foreground',
  warn: 'bg-warning text-warning-foreground',
};

/**
 * The stock components' alpha rings and disabled fades, put back to full
 * strength. tailwind-merge drops the stock class each of these conflicts with.
 */
const FULL_STRENGTH =
  'focus-visible:ring-ring aria-invalid:ring-destructive dark:aria-invalid:ring-destructive disabled:opacity-100';
const LABEL_FULL = 'peer-disabled:opacity-100 group-data-[disabled=true]:opacity-100';

/** A field the person's password manager must leave alone. */
function noAutofill(name: string) {
  return {
    autoComplete: 'off',
    name,
    'data-1p-ignore': true,
    'data-lpignore': 'true',
    'data-form-type': 'other',
    spellCheck: false,
    autoCorrect: 'off',
  } as const;
}

/** A per-mount field name, so no manager can learn a mod's field by its name. */
function useFieldName(): string {
  const [name] = useState(() => `m${Math.random().toString(36).slice(2, 10)}`);
  return name;
}

/** The stored value, when it fits the node; otherwise undefined and the node's initial shows. */
function shownValue(kind: AtomKind, stored: AtomValue | undefined): AtomValue | undefined {
  if (stored === undefined || stored === null) return undefined;
  if (kind.kind === 'text') return typeof stored === 'string' && stored.length <= MOD_ATOM_TEXT_MAX ? stored : undefined;
  return atomValueFits(kind, stored) ? stored : undefined;
}

export function ModTree(props: ModTreeProps) {
  return <ModNodeView node={props.tree} path={[]} ctx={props} />;
}

function ModNodeView({ node, path, ctx }: { node: ModNode; path: (string | number)[]; ctx: ModTreeProps }): ReactNode {
  const kids = (children: ModNode[]) =>
    children.map((child, i) => {
      const p = [...path, 'children', i];
      return <ModNodeView key={nodeKey(child, p)} node={child} path={p} ctx={ctx} />;
    });

  switch (node.type) {
    case 'stack':
      return <div className="flex min-w-0 flex-col gap-2">{kids(node.children)}</div>;
    case 'row':
      return <div className="flex min-w-0 flex-wrap items-center gap-2">{kids(node.children)}</div>;
    case 'list':
      return (
        <ul className="divide-border min-w-0 divide-y">
          {node.children.map((child, i) => {
            const p = [...path, 'children', i];
            return (
              <li key={nodeKey(child, p)} className="min-w-0 py-1.5">
                <ModNodeView node={child} path={p} ctx={ctx} />
              </li>
            );
          })}
        </ul>
      );
    case 'divider':
      return <Separator />;
    case 'heading':
      return <h3 className="text-foreground text-sm font-medium [overflow-wrap:anywhere]">{node.text}</h3>;
    case 'text':
      return (
        <p className={cn('text-sm whitespace-pre-line [overflow-wrap:anywhere]', node.tone && TEXT_TONE[node.tone])}>
          {node.text}
        </p>
      );
    case 'badge':
      return (
        <Badge
          variant="secondary"
          className={cn('max-w-full truncate', FULL_STRENGTH, node.tone && BADGE_TONE[node.tone])}
        >
          {node.text}
        </Badge>
      );
    case 'progress':
      return <ModProgress node={node} />;
    case 'stat':
      return (
        <div className="flex min-w-0 flex-col">
          <span className={cn('text-2xl tabular-nums', node.tone ? TEXT_TONE[node.tone] : 'text-foreground')}>
            {typeof node.value === 'number' ? node.value.toLocaleString('en-US') : node.value}
          </span>
          <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{node.label}</span>
        </div>
      );
    case 'button':
      return <ModButton node={node} ctx={ctx} />;
    case 'checkbox':
      return <ModCheckbox node={node} modId={ctx.modId} />;
    case 'input':
      return <ModInput node={node} modId={ctx.modId} />;
    case 'select':
      return <ModSelect node={node} modId={ctx.modId} boundary={ctx.boundary ?? null} />;
    case 'itemRef':
      return <ModItemRef id={node.id} inSheet={ctx.inSheet} />;
    case 'icon':
      return node.label ? (
        <ModIcon
          name={node.name}
          role="img"
          aria-label={node.label}
          className={cn('size-4 shrink-0', node.tone && TEXT_TONE[node.tone])}
        />
      ) : (
        <ModIcon name={node.name} aria-hidden className={cn('size-4 shrink-0', node.tone && TEXT_TONE[node.tone])} />
      );
  }
}

function ModProgress({ node }: { node: Extract<ModNode, { type: 'progress' }> }) {
  const value = Math.min(node.value, node.max);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {node.label && <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{node.label}</span>}
      <Progress
        value={value}
        max={node.max}
        aria-label={node.label}
        aria-valuetext={`${value} of ${node.max}`}
        indicatorClassName={node.tone ? FILL_TONE[node.tone] : 'bg-primary'}
      />
    </div>
  );
}

function ModButton({ node, ctx }: { node: Extract<ModNode, { type: 'button' }>; ctx: ModTreeProps }) {
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(0);
  const seqAtPress = useRef<number | null>(null);
  const flying = useRef(false);
  const look = `${node.label}\u0000${node.tone ?? ''}`;

  // When this key last changed how it looks. A press sooner than the settle
  // could be meant for whatever stood here before.
  useEffect(() => {
    shownAt.current = Date.now();
  }, [look]);

  const press = () => {
    seqAtPress.current = ctx.seq;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') press();
  };

  const onClick = () => {
    const pressed = seqAtPress.current;
    seqAtPress.current = null;
    if (flying.current || pressed !== ctx.seq || Date.now() - shownAt.current < MOD_CLICK_SETTLE_MS) return;
    flying.current = true;
    setBusy(true);
    void runPanelAction({ modId: ctx.modId, panelId: ctx.panelId }, node.action, node.arg, ctx.seq, atomsOf(ctx.modId))
      .catch((err) => console.error('[mods] panel action failed:', err))
      .finally(() => {
        flying.current = false;
        setBusy(false);
      });
  };

  const variant = node.tone === 'accent' ? 'default' : node.tone === 'muted' ? 'ghost' : 'outline';
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      aria-busy={busy || undefined}
      className={cn('max-w-full', FULL_STRENGTH, node.tone === 'accent' && 'hover:bg-primary')}
      onPointerDown={press}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <span className="truncate">{node.label}</span>
    </Button>
  );
}

function ModCheckbox({ node, modId }: { node: Extract<ModNode, { type: 'checkbox' }>; modId: string }) {
  const id = useId();
  const stored = usePanelStore((s) => s.atoms[modId]?.[node.atom]);
  const value = shownValue({ kind: 'checkbox' }, stored) ?? node.initial ?? false;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Checkbox
        id={id}
        checked={value === true}
        className={FULL_STRENGTH}
        onCheckedChange={(v) => usePanelStore.getState().setAtom(modId, node.atom, v === true, { fromUser: true })}
      />
      <Label htmlFor={id} className={cn('font-normal [overflow-wrap:anywhere]', LABEL_FULL)}>
        {node.label}
      </Label>
    </div>
  );
}

const SECRET_REFUSED = "That looks like a password or key, so it wasn't sent to your mod";

function ModInput({ node, modId }: { node: Extract<ModNode, { type: 'input' }>; modId: string }) {
  const id = useId();
  const name = useFieldName();
  const kind: AtomKind =
    node.kind === 'number'
      ? { kind: 'number', ...(node.min !== undefined && { min: node.min }), ...(node.max !== undefined && { max: node.max }) }
      : { kind: node.kind };
  const stored = usePanelStore((s) => s.atoms[modId]?.[node.atom]);
  const committed = shownValue(kind, stored) ?? node.initial ?? '';
  /** What the person is typing, until it commits; null shows the committed value. */
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  const commit = () => {
    if (draft === null) return;
    let value: AtomValue;
    if (node.kind === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(n)) return setDraft(null);
      value = Math.min(node.max ?? Infinity, Math.max(node.min ?? -Infinity, n));
    } else if (node.kind === 'date') {
      if (!isRealDate(draft)) return setDraft(null);
      value = draft;
    } else {
      if (!isSafeTypedValue(draft)) return setRefused(true);
      value = draft;
    }
    setRefused(false);
    setDraft(null);
    if (value === committed) return;
    usePanelStore.getState().setAtom(modId, node.atom, value, { fromUser: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className={cn('font-normal [overflow-wrap:anywhere]', LABEL_FULL)}>
        {node.label}
      </Label>
      <Input
        id={id}
        type={node.kind}
        {...noAutofill(name)}
        value={draft ?? String(committed)}
        placeholder={node.placeholder}
        min={node.kind === 'number' ? node.min : undefined}
        max={node.kind === 'number' ? node.max : undefined}
        maxLength={node.kind === 'text' ? MOD_ATOM_TEXT_MAX : undefined}
        aria-describedby={refused ? `${id}-refused` : undefined}
        className={cn('h-8', FULL_STRENGTH)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (refused) setRefused(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {refused && (
        <p id={`${id}-refused`} className="text-muted-foreground text-xs">
          {SECRET_REFUSED}
        </p>
      )}
    </div>
  );
}

function ModSelect({
  node,
  modId,
  boundary,
}: {
  node: Extract<ModNode, { type: 'select' }>;
  modId: string;
  boundary: HTMLElement | null;
}) {
  const id = useId();
  const kind: AtomKind = { kind: 'select', options: node.options.map((o) => o.value) };
  const stored = usePanelStore((s) => s.atoms[modId]?.[node.atom]);
  const value = shownValue(kind, stored) ?? node.initial;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className={cn('font-normal [overflow-wrap:anywhere]', LABEL_FULL)}>
        {node.label}
      </Label>
      <SelectPrimitive.Root
        value={typeof value === 'string' ? value : undefined}
        onValueChange={(v) => usePanelStore.getState().setAtom(modId, node.atom, v, { fromUser: true })}
      >
        <SelectPrimitive.Trigger
          id={id}
          data-slot="select-trigger"
          className="field dark:bg-input/30 flex h-8 w-full min-w-0 items-center justify-between gap-2 border bg-transparent px-3 text-sm whitespace-nowrap outline-none focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">
            <SelectPrimitive.Value />
          </span>
          <SelectPrimitive.Icon asChild>
            <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectContent className="titlebar-hole" {...(boundary && { collisionBoundary: boundary })}>
          {node.options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="data-[disabled]:opacity-100">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectPrimitive.Root>
    </div>
  );
}
