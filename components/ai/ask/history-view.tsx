'use client';

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Sparkles, Square, SquareCheck } from 'lucide-react';
import { ComposerAwakeContext } from '@/components/ai/bound-composer';
import { useConversationsStore } from '@/lib/conversations-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useNowMinuteMs } from '@/lib/use-now-minutes';
import { CHAT_LIMITS, type ConversationSummary, type SearchHit } from '@/lib/conversation-types';
import { groupHistory, historySecondLine, historyTime, type SecondLineItem } from '@/lib/conversation-summary';
import { isDoneOn } from '@/lib/item-verbs';
import { toDateStr } from '@/lib/recurrence';
import { openConversation, openHistory } from '@/lib/open-chat';
import { useRailStore, type AskSurface } from '@/lib/rail-store';
import type { Item } from '@/lib/planner-types';

/**
 * History: every saved conversation, on every device, until it is deleted
 * (the Full Chat page, mock 5). One push over Ask home; "‹ Ask" goes back.
 *
 *  - SEARCH at the top. From two characters, 250ms after the last keystroke,
 *    it asks the server (titles and every message), and the results replace
 *    the groups with one flat list. Escape clears a field with text in it and
 *    is consumed; on the empty field it goes back a view (the rail's).
 *  - GROUPS: Starred (every starred conversation, and only there), then Today,
 *    Yesterday and Earlier by the last message, in the user's zone.
 *  - ROWS: a glyph (✦ a general conversation; ☐ an item's, ☑ once the item is
 *    done), the title, the time, and a second line saying what it CHANGED
 *    (lib/conversation-summary.ts historySecondLine), read live from the
 *    planner, never frozen into the row. An item's conversation is named by
 *    the item's live title, and opens the item, on its Conversation section.
 *  - PAGES of 30, the next one asked for as the last row scrolls into view.
 *
 * No per-row menu: Rename, Star and Delete are the conversation's own (its
 * title's ⌄), as mock 5 has it.
 */

/** A search under this many characters (code points) is no search. */
const SEARCH_MIN = CHAT_LIMITS.searchMin;
const SEARCH_DEBOUNCE_MS = 250;

const codePoints = (s: string) => Array.from(s).length;

export function HistoryView({ surface = 'desktop' }: { surface?: AskSurface }) {
  const [q, setQ] = useState('');
  const query = q.trim();
  const searching = codePoints(query) >= SEARCH_MIN;
  const inputRef = useRef<HTMLInputElement>(null);
  const awake = useContext(ComposerAwakeContext);
  const pending = useRailStore((s) => s.pendingFocus);

  // The list as it stands, and quietly the newest page again if it is old.
  // A search left from an earlier visit starts over.
  useEffect(() => {
    const store = useConversationsStore.getState();
    store.refreshIfStale(60_000);
    store.runSearch('');
  }, []);

  // Focused only when asked for (the palette's "Conversation history"); a
  // pointer open leaves focus on the heading.
  useEffect(() => {
    if (!awake || pending?.target !== 'history-search') return;
    if (!useRailStore.getState().consumeFocus('history-search')) return;
    setTimeout(() => {
      if (inputRef.current?.isConnected) inputRef.current.focus({ preventScroll: true });
    }, 0);
  }, [awake, pending]);

  useEffect(() => {
    if (!searching) {
      useConversationsStore.getState().runSearch('');
      return;
    }
    const t = setTimeout(() => useConversationsStore.getState().runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, searching]);

  return (
    <div data-ask-history="" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-2">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 focus-within:bg-muted/50">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Text first: cleared, and consumed, so the same press does not
              // also go back. The rail's Escape takes the next one.
              if (e.key !== 'Escape' || q === '') return;
              e.preventDefault();
              setQ('');
            }}
            // The store's cap (in code points, which never outnumber code
            // units), so the results always answer the query on screen.
            maxLength={CHAT_LIMITS.searchMax}
            placeholder="Search conversations"
            aria-label="Search conversations"
            data-ask-search=""
            data-testid="history-search"
            className="-mx-1 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" data-testid="history-list">
        {searching ? <SearchResults query={query} surface={surface} /> : <HistoryGroups surface={surface} />}
      </div>
    </div>
  );
}

/**
 * Now, re-read each minute, so Today becomes Yesterday at midnight on its own;
 * null only while hydrating (History then shows its skeleton).
 */
function useHistoryClock() {
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = useNowMinuteMs();
  const hour24 = usePlannerStore((s) => s.timeFormat === '24h');
  return { now, tz, hour24 };
}

function HistoryGroups({ surface }: { surface: AskSurface }) {
  const list = useConversationsStore((s) => s.list);
  const summaries = useConversationsStore((s) => s.summaries);
  const { now, tz, hour24 } = useHistoryClock();
  const groups = useMemo(
    () => (now === null ? [] : groupHistory(list, summaries, now, tz)),
    [list, summaries, now, tz]
  );
  const sentinel = useRef<HTMLDivElement>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const more = useCallback(async () => {
    setLoadingMore(true);
    try {
      await useConversationsStore.getState().loadMore();
    } finally {
      setLoadingMore(false);
    }
  }, []);

  // The next page, as the end of this one comes into view.
  const canMore = list.status === 'loaded' && list.cursor !== null;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void more();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [canMore, more]);

  const empty = groups.length === 0;
  if (now === null || (empty && (list.status === 'idle' || list.status === 'loading'))) return <RowSkeletons />;
  if (empty && list.status === 'error') {
    return <LoadError onRetry={() => void useConversationsStore.getState().ensureLoaded()} />;
  }
  if (empty) {
    return (
      <div data-testid="history-empty" className="px-3 py-10 text-center">
        <p className="text-sm text-foreground">No conversations yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          What you ask is kept here, on every device, until you delete it.
        </p>
      </div>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`history-group-${group.key}`} data-history-group={group.key}>
          <h3
            id={`history-group-${group.key}`}
            className="px-2 pt-3 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            {group.label}
          </h3>
          <ul className="flex flex-col">
            {group.ids.map((id) => (
              <li key={id}>
                <HistoryRow summary={summaries[id] as ConversationSummary} surface={surface} now={now} tz={tz} hour24={hour24} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div ref={sentinel} aria-hidden className="h-px" />
      {loadingMore && list.status === 'loading' && <RowSkeletons />}
      {list.status === 'error' && list.cursor !== null && <LoadError onRetry={() => void more()} />}
    </>
  );
}

function SearchResults({ query, surface }: { query: string; surface: AskSurface }) {
  const search = useConversationsStore((s) => s.search);
  const { now, tz, hour24 } = useHistoryClock();
  const current = search.q === query;

  let body: React.ReactNode;
  if (current && search.status === 'error') {
    body = <p className="px-2 py-6 text-center text-sm text-muted-foreground">Couldn&apos;t search right now.</p>;
  } else if (current && search.status === 'done' && search.hits.length === 0) {
    body = (
      <p data-testid="history-no-results" className="px-2 py-6 text-center text-sm text-muted-foreground">
        Nothing matches “{query}”.
      </p>
    );
  } else if (search.hits.length > 0 && now !== null) {
    body = (
      <ul className="flex flex-col">
        {search.hits.map((hit) => (
          <li key={hit.id}>
            <HistoryRow summary={hit} hit={hit} query={query} surface={surface} now={now} tz={tz} hour24={hour24} />
          </li>
        ))}
      </ul>
    );
  } else {
    body = <RowSkeletons count={3} />;
  }

  return (
    <section aria-labelledby="history-results" data-history-group="results">
      <h3 id="history-results" className="px-2 pt-3 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Results
      </h3>
      {body}
    </section>
  );
}

/**
 * One row. An item's conversation reads the item as the planner holds it NOW:
 * its live title (the stored one once the item is gone), whether it is done
 * (☑), and what its agent is up to for the second line.
 */
function HistoryRow({
  summary,
  hit,
  query,
  surface,
  now,
  tz,
  hour24,
}: {
  summary: ConversationSummary;
  hit?: SearchHit;
  query?: string;
  surface: AskSurface;
  now: number;
  tz: string;
  hour24: boolean;
}) {
  const item = usePlannerStore((s) => (summary.itemId ? s.items.find((i) => i.id === summary.itemId) : undefined));
  const title = (item?.title.trim() || hit?.itemTitle || summary.title).trim();
  const second = hit?.snippet ?? historySecondLine(summary, item ? agentFields(item) : null);
  const focusKey = `conv:${summary.id}`;

  return (
    <button
      type="button"
      data-testid="history-row"
      data-ask-focus={focusKey}
      onClick={() => openConversation(summary.id, surface === 'phone', { returnFocus: focusKey })}
      className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <span className="flex w-full items-center gap-2">
        <RowGlyph itemId={summary.itemId} item={item} tz={tz} now={now} />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {query ? <Marked text={title} query={query} /> : title}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          {historyTime(summary.lastMessageAt, now, tz, hour24)}
        </span>
      </span>
      <span data-testid="history-second-line" className="block truncate pl-[22px] text-xs text-muted-foreground">
        {query && hit?.snippet ? <Marked text={second} query={query} /> : second}
      </span>
    </button>
  );
}

/** What History's second line reads off a live item: its agent's hand-off, when it has one (a habit never does). */
function agentFields(item: Item): SecondLineItem {
  return 'assignee' in item ? { assignee: item.assignee ?? null, aiStatus: item.aiStatus ?? null } : {};
}

function RowGlyph({ itemId, item, tz, now }: { itemId: string | null; item: Item | undefined; tz: string; now: number }) {
  if (itemId === null) {
    return <Sparkles data-glyph="general" className="size-3.5 shrink-0 text-ai" aria-hidden />;
  }
  const done = !!item && isDoneOn(item, toDateStr(new Date(now), tz));
  const Glyph = done ? SquareCheck : Square;
  return <Glyph data-glyph={done ? 'item-done' : 'item'} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

/** The query, wherever it appears, set apart by weight alone (no highlight colour). */
function Marked({ text, query }: { text: string; query: string }) {
  const needle = query.toLocaleLowerCase();
  const hay = text.toLocaleLowerCase();
  // Case-folding can change a string's length; matching on positions is then
  // unsafe, so the text goes unmarked rather than mis-marked.
  if (!needle || hay.length !== text.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <strong key={at} className="font-medium text-foreground">
        {text.slice(at, at + needle.length)}
      </strong>
    );
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function RowSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div data-testid="history-loading" aria-busy="true" aria-label="Loading conversations" className="flex flex-col">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5 px-2 py-2">
          <div className="h-3.5 w-3/4 rounded bg-muted motion-safe:animate-pulse" />
          <div className="ml-[22px] h-3 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="history-error" className="flex flex-col items-center gap-2 px-3 py-6 text-center">
      <p className="text-sm text-muted-foreground">Couldn&apos;t load your conversations.</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * "History" in an Ask header. Hidden while saving is off (the migration is
 * missing): there would be nothing to list. Back from History hands focus
 * back here (`data-ask-focus`).
 */
export function HistoryButton({ surface = 'desktop' }: { surface?: AskSurface }) {
  const off = useConversationsStore((s) => s.saving === 'off');
  if (off) return null;
  return (
    <button
      type="button"
      data-testid="ask-history"
      data-ask-focus="history"
      onClick={() => openHistory(surface === 'phone', { returnFocus: 'history' })}
      className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      History
    </button>
  );
}
