'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SettingRow } from './setting-row';
import { SettingChip } from './setting-chip';
import { LookPreview } from './look-preview';
import {
  ALL_PANES,
  PANES,
  paneById,
  railPaneFor,
  settingById,
  extensionSlugFromPane,
  displayValue,
  type PaneId,
  type SettingCtx,
  type SettingRecord,
  type DestinationRecord,
} from '@/lib/settings/manifest';
import { searchSettings, paneRows, paneMatchCount, highlightRuns } from '@/lib/settings/search';
import {
  groupPaneRows,
  isShown,
  anyAncestorPending,
  ancestorsOf,
  type PaneGroup,
} from '@/lib/settings/groups';
import { ExtensionIndex } from './extension-index';
import { ExtensionHero, ExtensionStoreDoor } from './extension-hero';
import { ShortcutsPanel } from './shortcuts-panel';

/**
 * The settings surface: a rail that is a map, and a content column that is
 * either one pane or one filtered list.
 *
 * The pane scrolls the DOCUMENT, not an inner box — no overflow-y-auto and no
 * <ScrollArea> (which silently drops height caps anyway). That is what retires
 * the skipped desktop-scroll test for issue #92 rather than re-fixing it.
 *
 * The rail is ONE level and stays that way. Extensions have panes of their own
 * (/settings/extensions/<slug>) but they do not get rail entries — seven map
 * entries plus one per extension is not a map. A sub-pane instead lights its
 * parent's rail row, rolls its search hits up into that row's count, and puts
 * the way back in the breadcrumb. Search itself is NOT scoped to a pane, here
 * or anywhere: a query still crosses every pane, sub-panes included, which is
 * why the results list groups by ALL_PANES rather than by the rail.
 */

const ADV_KEY = 'dsul-settings-advanced';
/** How long a deep link waits out a loading ancestor before settling on the
 *  nearest drawn row — a load that never finishes must not strand it. */
const PENDING_WAIT_MS = 3000;

function Eyebrow({
  children,
  icon: Icon,
  // A group header in the results carries the whole "which pane does this live
  // in" story, so it has to be a real heading — otherwise pressing H finds
  // nothing between <h1>Settings</h1> and the end of the page.
  as: Tag = 'p',
  id,
}: {
  children: React.ReactNode;
  icon?: React.ElementType;
  as?: 'p' | 'h2';
  id?: string;
}) {
  return (
    <Tag
      id={id}
      className="text-muted-foreground mt-6 mb-1 flex items-center gap-2 text-[10px] font-medium tracking-wider uppercase"
    >
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </Tag>
  );
}

function CountChip({ n }: { n: number }) {
  return (
    <span className="bg-secondary text-secondary-foreground font-num ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-[5px] px-1.5 text-[10px]">
      {n}
    </span>
  );
}

function DestinationRow({
  record,
  ranges,
  onOpen,
}: {
  record: DestinationRecord;
  ranges: [number, number][];
  onOpen: (record: DestinationRecord) => void;
}) {
  const runs = highlightRuns(record.label, ranges);
  return (
    <button
      type="button"
      onClick={() => onOpen(record)}
      className={cn(
        'hover:bg-accent -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2.5 rounded-[5px] px-3 py-2.5',
        'text-left transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      {/* A square marks identity — the house rule that separates a type or
          container from a value, which wears a dot. */}
      <span className="bg-muted-foreground/40 size-[9px] shrink-0 rounded-[3px]" aria-hidden />
      <span className="text-foreground text-sm">
        {runs.map((run, i) =>
          run.hit ? (
            <mark key={i} className="bg-primary/30 rounded-[2px] px-0.5 text-inherit">
              {run.text}
            </mark>
          ) : (
            <span key={i}>{run.text}</span>
          )
        )}
      </span>
      <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
        {record.where}
        <ArrowUpRight className="size-3" aria-hidden />
      </span>
    </button>
  );
}

export function SettingsShell({
  pane,
  ctx,
  focusId,
  isMobile,
  onOpenDestination,
}: {
  pane: PaneId;
  ctx: SettingCtx;
  focusId?: string;
  isMobile: boolean;
  onOpenDestination: (record: DestinationRecord) => void;
}) {
  const router = useRouter();
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [includeAdvanced, setIncludeAdvanced] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Present in the DOM from first paint and EMPTY at init — creating the region
  // and its message in the same tick is why live regions silently fail.
  const [status, setStatus] = useState('');
  // Row actions get their OWN region. The search-count effect below re-runs on
  // every `results` identity change, and a reset writes a store → new ctx → new
  // results in the SAME commit, so a message sharing that state was blanked
  // milliseconds later — inside the window where AT drops a polite mutation.
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePane = paneById(pane)!;
  const parentPane = activePane.parent ? paneById(activePane.parent) : undefined;
  // The rail row this pane belongs to — itself, or its parent inside a sub-pane.
  const railPane = railPaneFor(pane);

  /* ── Advanced disclosure state is per-pane and deliberately NOT a setting ──
     An effect, not a lazy initialiser: this is a client component but it still
     server-renders, and sessionStorage during render would throw there and
     mismatch on hydration here. react-hooks/set-state-in-effect flags the
     synchronous set; syncing FROM an external store is the case the rule's own
     guidance carves out. */
  useEffect(() => {
    let next = false;
    try {
      next = sessionStorage.getItem(`${ADV_KEY}:${pane}`) === '1';
    } catch {
      /* private mode — default closed */
    }
    setAdvOpen((current) => (current === next ? current : next));
  }, [pane]);

  const toggleAdv = useCallback(() => {
    setAdvOpen((open) => {
      try {
        sessionStorage.setItem(`${ADV_KEY}:${pane}`, open ? '0' : '1');
      } catch {
        /* private mode — the disclosure just doesn't persist */
      }
      return !open;
    });
  }, [pane]);

  /* ── Debounced query ──────────────────────────────────────────────────── */
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 120);
    return () => clearTimeout(t);
  }, [rawQuery]);

  /* ── / and ⌘F focus the field; Escape is two-stage ────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if ((e.key === 'f' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(
    () => searchSettings(query, ctx, { includeAdvanced, isMobile }),
    // ctx identity changes whenever the page re-renders off a store change,
    // which is exactly when a value label or a modified-tiebreak could differ.
    [query, ctx, includeAdvanced, isMobile]
  );

  const searching = query.trim().length > 0;

  /* ── The count is what makes two results read as complete, not broken ──── */
  useEffect(() => {
    // Announced from a timeout rather than synchronously: a live region that is
    // rewritten on every keystroke is read as a stream of interruptions.
    const t = setTimeout(
      () => {
        if (!searching) {
          setStatus('');
          return;
        }
        const n = results.total;
        const settings =
          n === 0 ? 'No settings match' : n === 1 ? '1 setting matches' : `${n} settings match`;
        const dest = results.destinations.length
          ? ` · ${results.destinations.length} place${results.destinations.length > 1 ? 's' : ''} elsewhere`
          : '';
        setStatus(settings + dest);
      },
      searching ? 400 : 0
    );
    return () => clearTimeout(t);
  }, [searching, results]);

  /* ── ?focus=<id> — reveal, scroll, ring for 1.6s, focus the ROW ──────────
     Two things make this fiddly enough to be worth spelling out.

     One: the param has to be stripped so a refresh doesn't re-fire the arrival
     — but stripping it re-renders with focusId undefined, which changes this
     effect's deps and runs its cleanup. A cleanup that cancelled the ring's
     rAF and its 1600ms reset would therefore destroy the highlight it had just
     scheduled. So the timers are held in refs and cleared only on unmount, and
     a ref guards against re-arrival for the same id.

     Two: an advanced row isn't in the DOM until its disclosure is open, so a
     deep link to one has to open it first and come back on the next commit.

     Three: a dependent may not be a row of its own. The value half of a merged
     chip answers through `data-setting-alias`, and a dependent hidden because
     an ancestor is off lands on the nearest ancestor that IS drawn — the
     switch that has to go on before the thing you were sent to exists. While
     an ancestor is still loading, "hidden" is not known yet, so the arrival
     waits for `focusPending` to clear rather than ringing the wrong row. */
  const arrivedFor = useRef<string | null>(null);
  const focusRecord = focusId ? settingById(focusId) : undefined;
  const focusPending = focusRecord ? anyAncestorPending(focusRecord, ctx) : false;
  // A load that never finishes (a failed extensions hydrate leaves its loaded
  // flag false until the next auth event) must not strand the arrival — and the
  // `?focus=` it would have stripped. After PENDING_WAIT_MS the walk runs anyway
  // and settles on the nearest drawn ancestor, which is the pending toggle row.
  const [waitedOutFor, setWaitedOutFor] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId || !focusPending) return;
    const t = setTimeout(() => setWaitedOutFor(focusId), PENDING_WAIT_MS);
    return () => clearTimeout(t);
  }, [focusId, focusPending]);
  const ringRef = useRef<number | null>(null);
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (ringRef.current !== null) cancelAnimationFrame(ringRef.current);
      if (clearRef.current !== null) clearTimeout(clearRef.current);
    },
    []
  );

  useEffect(() => {
    if (!focusId || arrivedFor.current === focusId) return;

    // Reveal first; `advOpen` is a dep, so we're called again once it's open.
    // Deliberately not written to sessionStorage — a deep link reveals the
    // section, it doesn't re-declare the user's preference for it.
    if (settingById(focusId)?.advanced && !advOpen) {
      setAdvOpen(true);
      return;
    }

    const find = (id: string) =>
      document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`) ??
      document.querySelector<HTMLElement>(`[data-setting-alias="${id}"]`);
    let node = find(focusId);
    if (!node) {
      if (focusPending && waitedOutFor !== focusId) return;
      const record = settingById(focusId);
      for (const ancestor of record ? ancestorsOf(record) : []) {
        node = find(ancestor.id);
        if (node) break;
      }
    }
    if (!node) return;
    arrivedFor.current = focusId;
    const hostId = node.dataset.settingRow ?? focusId;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    // The ROW (or the chip's frame), not the control — a screen reader should
    // read label, description and current value before Space can flip anything.
    node.focus({ preventScroll: true });

    // Ring on the next frame, so the scroll is under way before it appears.
    ringRef.current = requestAnimationFrame(() => setHighlight(hostId));
    clearRef.current = setTimeout(() => setHighlight(null), 1600);
    window.history.replaceState({}, '', window.location.pathname);
  }, [focusId, pane, advOpen, focusPending, waitedOutFor]);

  const write = useCallback(
    (record: SettingRecord, next: string | boolean) => {
      record.write(next, ctx);
    },
    [ctx]
  );

  const announce = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }, []);

  const reset = useCallback(
    (record: SettingRecord) => {
      record.write(record.defaultValue, ctx);
      announce(`${record.label} reset to ${displayValue(record, record.defaultValue)}`);
    },
    [ctx, announce]
  );

  /** A merged chip is two records and one sentence: each half goes back to its
   *  own default, in the order given, and the notice names the chip. */
  const resetMany = useCallback(
    (records: SettingRecord[], label: string, display: string) => {
      for (const record of records) record.write(record.defaultValue, ctx);
      announce(`${label} reset to ${display}`);
    },
    [ctx, announce]
  );

  useEffect(() => () => void (noticeTimer.current && clearTimeout(noticeTimer.current)), []);

  const rowFor = (record: SettingRecord, extra?: { paneName?: string; ranges?: [number, number][]; matchedValue?: string }) => {
    // In the pane a dependent whose ancestor is off is not drawn at all (see
    // groupFor) — the chips and rows under a switch exist while it is on. This
    // path still meets one in SEARCH, which lists every record it counts, so
    // there it is drawn and genuinely disabled, never `opacity-50
    // pointer-events-none`, which leaves a control keyboard-operable while
    // looking dead. isShown walks the whole chain, not one link.
    const inactive = record.dependsOn ? !isShown(record, ctx) : false;

    let value: string | boolean = '';
    try {
      value = record.read(ctx);
    } catch {
      value = record.defaultValue;
    }

    return (
      <div key={record.id}>
        <SettingRow
          record={record}
          ctx={ctx}
          value={value}
          inactive={inactive}
          highlighted={highlight === record.id}
          onWrite={(next) => write(record, next)}
          onReset={() => reset(record)}
          paneName={extra?.paneName}
          ranges={extra?.ranges}
          matchedValue={extra?.matchedValue}
        />
      </div>
    );
  };

  /**
   * One pane group as one list item. No indent and no rail on anything: a
   * dependent shares its root's left edge, and is simply absent while an
   * ancestor is off.
   *
   * Chips are a SIBLING block below the root's row, not inside it — inside,
   * they would sit in the row's label column, take its hover wash and wake its
   * reset button on focus, and the root's switch would lose its vertical.
   */
  const groupFor = (group: PaneGroup) => {
    if (group.mode === 'row') return rowFor(group.parent);
    if (group.mode === 'rows') {
      return (
        <Fragment key={group.parent.id}>
          {rowFor(group.parent)}
          {group.descendants.filter((d) => isShown(d, ctx)).map((d) => rowFor(d))}
        </Fragment>
      );
    }
    const shown = group.chips.filter((chip) =>
      isShown(chip.kind === 'merged' ? chip.toggle : chip.record, ctx)
    );
    return (
      <div key={group.parent.id} data-setting-group={group.parent.id}>
        {rowFor(group.parent)}
        {shown.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-3">
            {shown.map((chip) => (
              <SettingChip
                key={chip.kind === 'merged' ? chip.toggle.id : chip.record.id}
                spec={chip}
                ctx={ctx}
                highlight={highlight}
                onWrite={write}
                onReset={reset}
                onResetMany={resetMany}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  const { rows, advanced } = paneRows(pane, { isMobile });

  return (
    <main className="mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-8">
      {/* Three crumbs inside an extension, two everywhere else. The rail's
          Extensions row does navigate back up, but from inside a sub-pane it
          renders as the CURRENT row — a lit row does not read as a way out. So
          the parent crumb is the way back that looks like one, and it has to be
          a real link rather than the plain label the last crumb is. */}
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link
          href="/"
          className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          dsul
        </Link>
        {parentPane && (
          <>
            <span aria-hidden>/</span>
            <Link href={`/settings/${parentPane.id}`} className="hover:text-foreground transition-colors">
              {parentPane.name}
            </Link>
          </>
        )}
        <span aria-hidden>/</span>
        <span className="text-foreground font-medium">{activePane.name}</span>
      </nav>

      <h1 className="text-foreground text-2xl font-semibold tracking-tight">Settings</h1>

      <div className="flex flex-col gap-8 md:flex-row md:gap-10">
        {/* Rail. On mobile it becomes a chip strip that bleeds to the edge. */}
        <nav
          aria-label="Settings sections"
          className={cn(
            '-mx-6 flex shrink-0 gap-1 overflow-x-auto px-6',
            // Sticky, so the map stays put while a long pane scrolls under it.
            // `self-start` is required: a flex child stretches to the row's
            // height by default, and a box as tall as its container has nothing
            // to stick within — the classic silent no-op. The pane scrolls the
            // DOCUMENT (no inner overflow box, which is what closed #92), so
            // this sticks against the viewport with nothing else to configure.
            'md:mx-0 md:w-[184px] md:flex-col md:self-start md:overflow-visible md:px-0',
            'md:sticky md:top-8'
          )}
        >
          {PANES.map((p) => {
            // paneMatchCount, not counts[p.id]: a hit inside an extension's own
            // pane belongs to the Extensions rail row, which has no key of its
            // own in `counts` and would otherwise dim at zero while holding the
            // only route to the result.
            const count = searching ? paneMatchCount(results, p.id) : null;
            const active = !searching && p.id === railPane;
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                aria-current={active || undefined}
                onClick={() => {
                  setRawQuery('');
                  setQuery('');
                  router.push(`/settings/${p.id}`);
                }}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors md:w-full',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  active
                    ? 'bg-secondary text-foreground font-medium'
                    : 'text-secondary-foreground hover:bg-accent',
                  searching && count === 0 && 'text-muted-foreground/50'
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="whitespace-nowrap">{p.name}</span>
                {count !== null && <CountChip n={count} />}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 md:max-w-[600px]">
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-3.5"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              onKeyDown={(e) => {
                // Two-stage: clear the query first, leave the field second.
                // Never discard a query invisibly — and never leave Escape
                // inert, because AppShell (which owned every app-wide Escape
                // handler) is not mounted on this route, so nothing else would
                // answer it and `/` would have no counterpart.
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopPropagation();
                if (rawQuery) {
                  setRawQuery('');
                  setQuery('');
                  return;
                }
                inputRef.current?.blur();
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              autoComplete="off"
              spellCheck={false}
              data-testid="settings-search"
              className={cn(
                'bg-secondary text-foreground placeholder:text-muted-foreground h-9 w-full rounded-md',
                'border-input border pr-20 pl-9 text-sm',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
              )}
            />
            <button
              type="button"
              aria-pressed={includeAdvanced}
              onClick={() => setIncludeAdvanced((v) => !v)}
              title="Include advanced settings in results"
              className={cn(
                'absolute top-1.5 right-1.5 flex h-6 items-center gap-1 rounded-sm px-2 text-[10px]',
                'font-medium tracking-wide uppercase transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                includeAdvanced
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <SlidersHorizontal className="size-3" aria-hidden />
              Adv
            </button>
          </div>

          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="settings-status"
            className="text-muted-foreground font-num mt-2 min-h-[13px] text-[10px]"
          >
            {status}
          </p>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="settings-notice"
            className="sr-only"
          >
            {notice}
          </p>

          {searching ? (
            <>
              {results.didYouMean && results.settings.length > 0 && (
                <Eyebrow>Did you mean</Eyebrow>
              )}

              {/* ALL_PANES, not PANES. Every extension field lives in a
                  sub-pane now, so grouping by the rail would silently drop
                  every one of them from the results while still counting them
                  — the exact shape of "search stopped finding my Twilio
                  token". ALL_PANES is ordered parent-then-children, so the
                  groups still read down the rail. */}
              {ALL_PANES.map((p) => {
                const hits = results.settings.filter((h) => h.record.pane === p.id);
                if (!hits.length) return null;
                // A sub-pane names its parent too: "Beeminder" alone doesn't
                // say where to go, and the group header is the only place the
                // result list explains where a row actually lives.
                const groupName = p.parent
                  ? `${paneById(p.parent)?.name ?? p.parent} · ${p.name}`
                  : p.name;
                return (
                  <section key={p.id} aria-labelledby={`results-${p.id}`}>
                    <Eyebrow as="h2" id={`results-${p.id}`} icon={p.icon}>
                      {groupName}
                    </Eyebrow>
                    <div className="divide-border divide-y">
                      {hits.map((hit) =>
                        rowFor(hit.record, {
                          paneName: groupName,
                          ranges: hit.ranges,
                          matchedValue: hit.matchedValue,
                        })
                      )}
                    </div>
                  </section>
                );
              })}

              {results.destinations.length > 0 && (
                <section aria-labelledby="results-elsewhere">
                  <Eyebrow as="h2" id="results-elsewhere">
                    Elsewhere in dsul
                  </Eyebrow>
                  <div className="divide-border divide-y">
                    {results.destinations.map((hit) => (
                      <DestinationRow
                        key={hit.record.id}
                        record={hit.record}
                        ranges={hit.ranges}
                        onOpen={onOpenDestination}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* A different component from "this pane is empty" — conflating
                  the two is the classic bug. These are the three things a
                  settings query usually really is. */}
              {results.total === 0 && results.destinations.length === 0 && (
                <div className="py-8">
                  <p className="text-foreground text-sm">
                    No settings match “{query.trim()}”.
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {includeAdvanced
                      ? 'Advanced settings are included in this search.'
                      : 'Advanced settings are excluded — turn on Adv to include them.'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setIncludeAdvanced(true)}>
                      Search advanced too
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/">Ask Beacon</Link>
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {pane === 'look' && <LookPreview />}

              <Eyebrow icon={activePane.icon}>{activePane.name}</Eyebrow>
              {/* An extension pane's blurb IS its catalog description, and the
                  toggle directly below carries that same sentence as its own
                  description — printing it twice, one line apart, reads as a
                  bug. The header keeps the name; the row keeps the sentence. */}
              {!activePane.parent && (
                <p className="text-muted-foreground -mt-0.5 mb-2 text-xs">{activePane.blurb}</p>
              )}

              {/* The one pane whose body is a catalog rather than rows. It has
                  no records of its own by design — every extension switch moved
                  into the extension's own pane, so a row here would be a second
                  copy of a control that already has a permanent home. */}
              {/* An extension's pane opens with what the store shows about it —
                  preview, what changes, the maker's note — above its own rows,
                  which are unchanged and still hold the one switch. */}
              {activePane.parent === 'extensions' && <ExtensionHero slug={extensionSlugFromPane(pane)!} />}

              {pane === 'extensions' && <ExtensionStoreDoor />}
              {pane === 'extensions' && <ExtensionIndex ctx={ctx} />}

              {/* The Keyboard pane's rows ARE the shortcut records, and they
                  are grouped rather than flat — nineteen bindings in one
                  undivided list is a wall. The panel is the shared component
                  the ⌘/ overlay also renders (components/settings/
                  shortcuts-panel.tsx), so the two shells cannot group or order
                  the same set differently. It renders every row this pane
                  holds, which is why the flat list below is the ELSE arm and
                  not a sibling — a test pins that the two sets are the same.
                  Search results still go through rowFor like every other
                  record, so a hit here is drawn by the generic path. */}
              {pane === 'keyboard' ? (
                <ShortcutsPanel
                  variant="pane"
                  ctx={ctx}
                  highlightId={highlight}
                  onReset={reset}
                />
              ) : (
                <div className="divide-border divide-y">{groupPaneRows(rows).map(groupFor)}</div>
              )}

              {advanced.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={advOpen}
                    onClick={toggleAdv}
                    className={cn(
                      'text-muted-foreground hover:bg-accent -mx-3 mt-2 flex h-8 w-[calc(100%+1.5rem)]',
                      'items-center gap-2 rounded-[5px] px-3 text-xs font-medium transition-colors',
                      'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
                    )}
                  >
                    <ChevronRight
                      className={cn('size-3 transition-transform', advOpen && 'rotate-90')}
                      aria-hidden
                    />
                    Advanced
                    <CountChip n={advanced.length} />
                  </button>
                  {/* A reveal, not a nav level: everything inside is a normal
                      row at normal depth. */}
                  {advOpen && (
                    <div className="divide-border divide-y">
                      {advanced.map((record) => rowFor(record))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
