import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  LOCAL_STATE_OWNER_KEY,
  PERSISTED_USER_STORES,
  adoptLocalState,
  clearUserScopedLocalState,
  localStateOwner,
} from '@/lib/local-state';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useChatStore, itemChatStore } from '@/lib/chat-store';
import { useCommandUsageStore } from '@/lib/command-usage-store';
import { useEODStore } from '@/lib/eod-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { useMorningStore } from '@/lib/morning-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore, SIDEBAR_DEFAULT_WIDTH } from '@/lib/sidebar-store';
import { recordReleased, releasedOn } from '@/lib/sweep-grace';
import { useViewStore } from '@/lib/view-store';
import { seededLocalStorage } from '../e2e/helpers/session';

/**
 * The clear registry: what a change of user drops, what it deliberately keeps,
 * and what survives a browser whose owner we merely cannot VOUCH for.
 *
 * Everything in lib/*-store.ts that persists does so under a BROWSER-GLOBAL
 * localStorage key, so on a shared browser the next person to sign in inherits
 * the last person's. The sharp end is `dsul-ai-settings.apiKey` — a
 * credential the inheriting user can read out of devtools and edit through the
 * settings UI — but it is not the only end, and the drift scans at the bottom
 * of this file exist because a hand-kept list of eight stores is a list that
 * will be seven stores by next quarter.
 */

const USER_A = 'user-a';
const USER_B = 'user-b';

type AnyStore = { setState: (partial: Record<string, unknown>) => void };

/**
 * Registry key → the store behind it.
 *
 * Cross-checked against the registry below, so this map cannot quietly fall
 * behind it.
 */
const STORES: Record<string, AnyStore> = {
  'planner-storage': usePlannerStore as unknown as AnyStore,
  'dsul-view': useViewStore as unknown as AnyStore,
  'dsul-ai-settings': useAISettingsStore as unknown as AnyStore,
  'dsul-morning-store': useMorningStore as unknown as AnyStore,
  'dsul-eod-store': useEODStore as unknown as AnyStore,
  'dsul-sidebar-settings': useSidebarStore as unknown as AnyStore,
  'dsul-keyboard-shortcuts': useKeyboardShortcutsStore as unknown as AnyStore,
  'dsul-command-usage': useCommandUsageStore as unknown as AnyStore,
};

/** The `state` half of a zustand persist envelope. */
function persistedState(key: string): Record<string, unknown> {
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error(`nothing persisted under ${key} — the store never wrote`);
  return (JSON.parse(raw) as { state: Record<string, unknown> }).state;
}

/**
 * A value that is recognisably not the default, whatever type the default is.
 *
 * Type-preserving on purpose: the point is to prove the field came BACK, so the
 * dirty value has to be something the field could plausibly hold.
 */
function dirtied(value: unknown): unknown {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 7;
  if (typeof value === 'string') return `${value}-leak`;
  if (Array.isArray(value)) return ['leak'];
  if (value !== null && typeof value === 'object') return { ...(value as object), leak: true };
  return 'leak'; // null
}

/**
 * Drive the 'disclosive' scope through its only real entry point: an adopt on a
 * browser nothing has stamped, which is what every existing install presents on
 * its first load after this ships.
 */
function adoptUnstamped(userId: string) {
  localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
  return adoptLocalState(userId);
}

beforeEach(() => {
  localStorage.clear();
  // Force every persist blob back onto disk from the store's own defaults, so
  // a test that reads one is never reading another test's leftovers.
  clearUserScopedLocalState();
});

describe('the credential — dsul-ai-settings.apiKey', () => {
  it('is gone from memory and from disk after the user changes', () => {
    useAISettingsStore.setState({
      provider: 'anthropic',
      apiKey: 'sk-ant-user-a-secret',
      model: 'claude-opus-4',
      assistantName: "A's Beacon",
      systemPrompt: 'A private prompt about A',
    });
    expect(persistedState('dsul-ai-settings').apiKey).toBe('sk-ant-user-a-secret');

    clearUserScopedLocalState();

    expect(useAISettingsStore.getState().apiKey).toBe('');
    expect(persistedState('dsul-ai-settings')).toMatchObject({
      provider: 'openclaw',
      apiKey: '',
      assistantName: 'Beacon',
      systemPrompt: '',
    });
    // And nothing anywhere in localStorage still holds the string.
    expect(JSON.stringify(localStorage)).not.toContain('sk-ant-user-a-secret');
  });

  it('does not survive a DIFFERENT user signing in', () => {
    adoptLocalState(USER_A);
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret' });

    expect(adoptLocalState(USER_B)).toBe(true);

    expect(useAISettingsStore.getState().apiKey).toBe('');
    expect(localStateOwner()).toBe(USER_B);
  });

  it('DOES survive the same user signing in again', () => {
    adoptLocalState(USER_A);
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret' });

    // Supabase re-emits SIGNED_IN on every hidden→visible transition. A clear
    // on one of those would throw away what the user set this session.
    expect(adoptLocalState(USER_A)).toBe(false);

    expect(useAISettingsStore.getState().apiKey).toBe('sk-ant-user-a-secret');
  });

  it('is cleared even on an UNSTAMPED browser — a credential cannot wait for proof', () => {
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret' });

    expect(adoptUnstamped(USER_A)).toBe(true);

    expect(useAISettingsStore.getState().apiKey).toBe('');
  });
});

describe('Beacon transcripts', () => {
  it('drops the global thread and every item thread, opened this session or not', () => {
    useChatStore.setState({ messages: [{ role: 'user', content: 'A private question' }] });
    localStorage.setItem(
      'dsul-chat-history',
      JSON.stringify({
        messages: [{ role: 'user', content: 'A private question' }],
        savedAt: Date.now(),
      })
    );
    // One thread instantiated this session…
    itemChatStore('item-1').setState({ messages: [{ role: 'assistant', content: 'about item 1' }] });
    localStorage.setItem(
      'dsul-item-chat-item-1',
      JSON.stringify({
        messages: [{ role: 'assistant', content: 'about item 1' }],
        savedAt: Date.now(),
      })
    );
    // …and one that exists only on disk, which clearing the live stores misses.
    localStorage.setItem(
      'dsul-item-chat-item-2',
      JSON.stringify({ messages: [{ role: 'user', content: 'about item 2' }], savedAt: Date.now() })
    );

    clearUserScopedLocalState();

    expect(localStorage.getItem('dsul-chat-history')).toBeNull();
    expect(localStorage.getItem('dsul-item-chat-item-1')).toBeNull();
    expect(localStorage.getItem('dsul-item-chat-item-2')).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(itemChatStore('item-1').getState().messages).toEqual([]);
  });
});

describe('the sweep grace map', () => {
  it('drops the previous account row ids', () => {
    recordReleased(['item-of-user-a'], '2026-08-26');
    expect(releasedOn('item-of-user-a')).toBe('2026-08-26');

    clearUserScopedLocalState();

    expect(releasedOn('item-of-user-a')).toBeUndefined();
  });
});

describe('the ownership stamp', () => {
  it('never outlives a session', () => {
    adoptLocalState(USER_A);
    expect(localStateOwner()).toBe(USER_A);

    clearUserScopedLocalState();

    expect(localStateOwner()).toBeNull();
  });

  it('reads as unowned when storage throws, so the fail direction is clearing', () => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('private mode');
    };
    try {
      expect(localStateOwner()).toBeNull();
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });
});

describe('hostile storage cannot take the clear — or the boot — down with it', () => {
  it('runs every clearer even when persisting throws, and does not rethrow', () => {
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret' });
    useViewStore.setState({
      canvasFilters: { ...useViewStore.getState().canvasFilters, containers: ['project:A Private'] },
    });
    useCommandUsageStore.setState({ usage: { 'create.task': { count: 4, lastUsed: 1 } } });

    // zustand's persist calls storage.setItem UNWRAPPED, so this throw comes
    // straight back out of the first store's set(). In a bare loop it would
    // abort the seven stores after it, both raw clearers and the stamp write.
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    try {
      expect(() => clearUserScopedLocalState()).not.toThrow();
    } finally {
      Storage.prototype.setItem = setItem;
    }

    // In-memory state is the part that still can be fixed, and every store past
    // the first one got its turn.
    expect(useAISettingsStore.getState().apiKey).toBe('');
    expect(useViewStore.getState().canvasFilters.containers).toEqual([]);
    expect(useCommandUsageStore.getState().usage).toEqual({});
  });
});

describe('another tab adopting a new user (case 5)', () => {
  /** What the browser delivers to every tab EXCEPT the one that wrote. */
  function siblingTabStamped(userId: string | null) {
    localStorage.setItem(LOCAL_STATE_OWNER_KEY, userId ?? '');
    window.dispatchEvent(
      new StorageEvent('storage', { key: LOCAL_STATE_OWNER_KEY, newValue: userId })
    );
  }

  it('clears this tab, which the stamp comparison alone can never do', () => {
    adoptLocalState(USER_A);
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret' });

    siblingTabStamped(USER_B);

    // The whole hazard: this tab's own adopt now returns false, because the
    // stamp already says USER_B. If the listener had not cleared, the next
    // set() anywhere would write A's blob back under B's stamp — permanently,
    // since adopt would never fire again.
    expect(useAISettingsStore.getState().apiKey).toBe('');
    expect(adoptLocalState(USER_B)).toBe(false);
    useAISettingsStore.setState({ model: 'gpt-4o' });
    expect(persistedState('dsul-ai-settings').apiKey).toBe('');
  });

  it('ignores storage events for every other key', () => {
    adoptLocalState(USER_A);
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret' });

    window.dispatchEvent(
      new StorageEvent('storage', { key: 'dsul-view', newValue: '{"state":{}}' })
    );

    expect(useAISettingsStore.getState().apiKey).toBe('sk-ant-user-a-secret');
  });
});

describe('what a user change deliberately keeps', () => {
  it('keeps the sidebar width and chrome — a property of the monitor, not the account', () => {
    useSidebarStore.setState({
      leftSidebarWidth: 640,
      leftSidebarOpen: false,
      chatExpanded: true,
      leftSidebarHoverEnabled: true,
    });

    clearUserScopedLocalState();

    const sidebar = useSidebarStore.getState();
    expect(sidebar.leftSidebarWidth).toBe(640);
    expect(sidebar.leftSidebarOpen).toBe(false);
    expect(sidebar.chatExpanded).toBe(true);
    // The one field that IS an account preference (it round-trips through
    // saveSettings) goes back to its default on a known change of user.
    expect(sidebar.leftSidebarHoverEnabled).toBe(false);
    expect(sidebar.leftSidebarWidth).not.toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("keeps view-store's adoptedLegacy — a marker about this browser, not a preference", () => {
    useViewStore.setState({ adoptedLegacy: true, scope: 'week' });

    clearUserScopedLocalState();

    // Resetting it would re-run adoptLegacyViewPrefs against a store that has
    // just been cleared, and would invalidate the e2e fixture whose entire job
    // is to hold this flag true.
    expect(useViewStore.getState().adoptedLegacy).toBe(true);
    expect(useViewStore.getState().scope).toBe('day');
  });
});

describe("morning-store's sweep stamps are pruned, not kept and not dropped", () => {
  it('keeps the incoming account and evicts the roster of everyone else', () => {
    useMorningStore.getState().setAutoAgeLastRunDate(USER_A, '2026-08-26');
    useMorningStore.getState().setAutoAgeLastRunDate(USER_B, '2026-08-26');
    useMorningStore.getState().setAutoAgeLastRunDate('3f7c1b2e-old-account', '2026-08-26');

    adoptLocalState(USER_B);

    const map = useMorningStore.getState().morningAutoAgeLastRunByUser;
    // The stated benefit survives: sign back in the same day, no re-sweep.
    expect(map).toEqual({ [USER_B]: '2026-08-26' });
    // The values were never the problem. The KEYS are Supabase user ids, and
    // unpruned they accumulate a roster of everyone who has used this machine.
    expect(JSON.stringify(localStorage)).not.toContain('3f7c1b2e-old-account');
    expect(JSON.stringify(localStorage)).not.toContain(USER_A);
  });

  it('empties the map entirely on a sign-out, which has no incoming account', () => {
    useMorningStore.getState().setAutoAgeLastRunDate(USER_A, '2026-08-26');

    clearUserScopedLocalState();

    expect(useMorningStore.getState().morningAutoAgeLastRunByUser).toEqual({});
  });

  it('drops the receipts, which carry row titles however they are keyed', () => {
    useMorningStore.getState().setAutoAgeReceipt(USER_A, {
      date: '2026-08-26',
      items: [{ id: 'i1', title: "A's private task title", isScheduled: true }],
    });

    adoptLocalState(USER_B);

    expect(useMorningStore.getState().morningAutoAgeReceiptByUser).toEqual({});
    expect(JSON.stringify(localStorage)).not.toContain("A's private task title");
  });
});

describe('an unstamped browser drops the disclosive and spares the inert', () => {
  it('takes the credential, the filters, the transcripts and the ranking', () => {
    useAISettingsStore.setState({ apiKey: 'sk-ant-user-a-secret', systemPrompt: 'A wrote this' });
    useViewStore.setState({
      canvasFilters: { ...useViewStore.getState().canvasFilters, containers: ['project:A Private'] },
    });
    useCommandUsageStore.setState({ usage: { 'create.task': { count: 9, lastUsed: 1 } } });
    useMorningStore.setState({ morningCheckTime: '05:15' });
    useEODStore.setState({ lastEodReviewDate: '2026-08-25' });
    localStorage.setItem(
      'dsul-chat-history',
      JSON.stringify({ messages: [{ role: 'user', content: 'private' }], savedAt: Date.now() })
    );
    recordReleased(['item-of-user-a'], '2026-08-26');

    adoptUnstamped(USER_B);

    expect(useAISettingsStore.getState().apiKey).toBe('');
    expect(useAISettingsStore.getState().systemPrompt).toBe('');
    expect(useViewStore.getState().canvasFilters.containers).toEqual([]);
    expect(useCommandUsageStore.getState().usage).toEqual({});
    expect(useMorningStore.getState().morningCheckTime).toBe('08:00');
    expect(useEODStore.getState().lastEodReviewDate).toBeNull();
    expect(localStorage.getItem('dsul-chat-history')).toBeNull();
    expect(releasedOn('item-of-user-a')).toBeUndefined();
  });

  it('spares what could not describe anyone — and has no server copy to restore it', () => {
    // Neither dsul-view nor dsul-keyboard-shortcuts calls saveSettings, so
    // a blanket clear here is permanent loss for every existing install, on the
    // one load where all we know is that nobody has stamped this browser yet.
    useViewStore.setState({
      layout: 'schedule',
      bucketStyle: 'tray',
      typeMode: 'serif',
      collapsedBuckets: ['morning'],
      weekDaysVisible: 5,
    });
    useKeyboardShortcutsStore.setState({ overrides: { 'nav.today': ['ctrl', 'j'] } });
    usePlannerStore.setState({ compactMode: true, timeFormat: '24h', showPausedOnGrid: true });
    useSidebarStore.setState({ leftSidebarHoverEnabled: true });

    adoptUnstamped(USER_B);

    const view = useViewStore.getState();
    expect(view.layout).toBe('schedule');
    expect(view.bucketStyle).toBe('tray');
    expect(view.typeMode).toBe('serif');
    expect(view.collapsedBuckets).toEqual(['morning']);
    expect(view.weekDaysVisible).toBe(5);
    expect(useKeyboardShortcutsStore.getState().overrides).toEqual({ 'nav.today': ['ctrl', 'j'] });
    expect(usePlannerStore.getState().compactMode).toBe(true);
    expect(usePlannerStore.getState().timeFormat).toBe('24h');
    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);
    expect(useSidebarStore.getState().leftSidebarHoverEnabled).toBe(true);
  });

  it('takes the inert too once we KNOW the user changed', () => {
    adoptLocalState(USER_A);
    useViewStore.setState({ layout: 'schedule', bucketStyle: 'tray' });
    useKeyboardShortcutsStore.setState({ overrides: { 'nav.today': ['ctrl', 'j'] } });
    usePlannerStore.setState({ compactMode: true });

    adoptLocalState(USER_B);

    expect(useViewStore.getState().layout).toBe('buckets');
    expect(useViewStore.getState().bucketStyle).toBe('spine');
    expect(useKeyboardShortcutsStore.getState().overrides).toEqual({});
    expect(usePlannerStore.getState().compactMode).toBe(false);
  });
});

describe('the account-owned slice of every registered store', () => {
  it.each(PERSISTED_USER_STORES.map((s) => [s.key, s] as const))(
    '%s — each persisted field is cleared, kept or spared exactly as declared',
    (key, entry) => {
      const store = STORES[key];
      expect(store, `no store mapped for registry key ${key}`).toBeDefined();

      const defaults = persistedState(key);
      const fields = Object.keys(defaults);
      expect(fields.length, `${key} persists nothing`).toBeGreaterThan(0);

      const dirt: Record<string, unknown> = {};
      for (const field of fields) dirt[field] = dirtied(defaults[field]);

      const dirty = () => {
        store.setState(dirt);
        // Sanity: the dirtying actually reached disk, so a green result below
        // cannot mean "nothing ever changed".
        expect(persistedState(key)).not.toEqual(defaults);
      };

      // ── scope 'disclosive': an unstamped browser ────────────────────────
      dirty();
      adoptUnstamped(USER_B);
      let after = persistedState(key);
      for (const field of fields) {
        const spared = entry.keeps.includes(field) || entry.inert.includes(field);
        expect(
          after[field],
          spared
            ? `${key}.${field} is declared keep/inert but an unstamped adopt cleared it`
            : `${key}.${field} is disclosive but survived an unstamped adopt`
        ).toEqual(spared ? dirt[field] : defaults[field]);
      }

      // ── scope 'all': a known change of user ─────────────────────────────
      dirty();
      clearUserScopedLocalState();
      after = persistedState(key);
      for (const field of fields) {
        expect(
          after[field],
          entry.keeps.includes(field)
            ? `${key}.${field} is declared a keep but was cleared`
            : `${key}.${field} survived a change of user`
        ).toEqual(entry.keeps.includes(field) ? dirt[field] : defaults[field]);
      }
    }
  );
});

/**
 * The e2e fixture, checked against the real thing without running Playwright.
 *
 * tests/e2e/global-setup.ts hands every spec a browser that is signed in AND
 * carries seeded view prefs. Until the stamp was added to that list the two
 * halves disagreed: the cookie said "this account", the prefs said nothing at
 * all, and `adoptLocalState` correctly read an unattributed browser and cleared
 * what it could before the first assertion ran.
 *
 * The invariant is not "the stamp key is present" but "the fixture provokes NO
 * clear", so that is what this asserts — by replaying the fixture into jsdom and
 * driving the real adopt. A future edit that seeds prefs without the stamp, or
 * stamps the wrong id, fails here in three seconds instead of in a 1.4-hour
 * Playwright run.
 */
describe('the e2e fixture arrives owned, not orphaned', () => {
  const FIXTURE_USER = '00000000-0000-4000-8000-000000000001';

  /** Replay the fixture's localStorage the way a browser context would. */
  function applyFixture() {
    localStorage.clear();
    for (const { name, value } of seededLocalStorage(FIXTURE_USER)) {
      localStorage.setItem(name, value);
    }
  }

  it('carries the stamp under the key lib/local-state actually reads', () => {
    const stamp = seededLocalStorage(FIXTURE_USER).find(
      (e) => e.name === LOCAL_STATE_OWNER_KEY
    );
    expect(stamp?.value).toBe(FIXTURE_USER);
  });

  it('provokes no clear when the seeded account signs in', () => {
    applyFixture();
    // The fixture's own view seed, as global-setup writes it.
    const seededView = JSON.parse(localStorage.getItem('dsul-view')!);

    expect(adoptLocalState(FIXTURE_USER)).toBe(false);

    // Byte-identical: not merely "the fields survived", but "nothing ran".
    expect(JSON.parse(localStorage.getItem('dsul-view')!)).toEqual(seededView);
    expect(seededView.state.adoptedLegacy).toBe(true);
  });

  it('still clears for a DIFFERENT account, which is the point of stamping it', () => {
    applyFixture();

    expect(adoptLocalState(USER_B)).toBe(true);
    expect(localStateOwner()).toBe(USER_B);
  });
});

/**
 * The two scans below are the reason this fix is one place rather than eight.
 *
 * The registry is a hand-kept list, and a hand-kept list of stores goes stale
 * the first time someone adds a ninth. These read the source off disk and fail
 * on a persisted store or a browser-storage writer that nothing has been told
 * about, which is the only way to catch the store that has not been written
 * yet.
 *
 * They walk `lib/`, `hooks/`, `components/` and `app/`, and they collect `.tsx`
 * as well as `.ts` — an earlier version looked only at `lib/**\/*.ts` and could
 * be walked straight past by putting a store in a component file.
 */
describe('nothing persists per-user state outside the registry', () => {
  const roots = ['lib', 'hooks', 'components', 'app'].map((d) =>
    path.resolve(__dirname, '../..', d)
  );

  /** [repo-relative path, source] for every .ts/.tsx file under the roots. */
  function sources(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(full, rel);
        else if (/\.tsx?$/.test(entry.name)) out.push([rel, readFileSync(full, 'utf8')]);
      }
    };
    for (const root of roots) walk(root, path.basename(root));
    return out;
  }

  /**
   * Lines that are prose, not code.
   *
   * Four stores explain in their own docstrings why they are "Not persist()ed",
   * so a pattern that cannot tell a comment from a call counts them and the
   * scan asserts nothing. Skipping comment lines lets the pattern itself stay
   * loose enough to catch `create<X>()(persist(` on a single line.
   */
  const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

  function filesMatching(pattern: RegExp): string[] {
    return sources()
      .filter(([, src]) => src.split('\n').some((l) => !isComment(l) && pattern.test(l)))
      .map(([file]) => file)
      .sort();
  }

  /** Every file that calls zustand's persist(), and the registry key it owns. */
  const PERSISTED_STORE_FILES: Record<string, string> = {
    'lib/ai-settings-store.ts': 'dsul-ai-settings',
    'lib/command-usage-store.ts': 'dsul-command-usage',
    'lib/eod-store.ts': 'dsul-eod-store',
    'lib/keyboard-shortcuts-store.ts': 'dsul-keyboard-shortcuts',
    'lib/morning-store.ts': 'dsul-morning-store',
    'lib/planner-store.ts': 'planner-storage',
    'lib/sidebar-store.ts': 'dsul-sidebar-settings',
    'lib/view-store.ts': 'dsul-view',
  };

  it('every persist() in the app belongs to a registered store', () => {
    expect(filesMatching(/\bpersist\(/)).toEqual(Object.keys(PERSISTED_STORE_FILES).sort());
    expect(Object.values(PERSISTED_STORE_FILES).sort()).toEqual(
      PERSISTED_USER_STORES.map((s) => s.key).sort()
    );
    expect(Object.keys(STORES).sort()).toEqual(PERSISTED_USER_STORES.map((s) => s.key).sort());
  });

  it('and so does every file that so much as imports the middleware', () => {
    // The call-site pattern above is blind to `import { persist as keep }`.
    // The IMPORT is not: nothing can reach zustand's persist without naming the
    // module it comes from, whatever it calls the binding afterwards. Same
    // expected set, arrived at by a route an alias cannot leave.
    expect(filesMatching(/from '"?zustand\/middleware/)).toEqual(
      Object.keys(PERSISTED_STORE_FILES).sort()
    );
  });

  it('every browser-storage writer in the app is accounted for', () => {
    // `\bsetItem\(` rather than `localStorage.setItem(`: it also catches an
    // aliased handle (`const store = window.localStorage; store.setItem(…)`)
    // and sessionStorage, which the narrower pattern walked straight past.
    //
    // A ninth entry here means per-user state with nothing clearing it.
    expect(filesMatching(/\bsetItem\(/)).toEqual([
      // Per-user, disclosive, cleared by clearChatState — one key per thread,
      // so the field-level audit above cannot walk it. Own test in this file.
      'lib/chat-store.ts',
      // The ownership stamp itself.
      'lib/local-state.ts',
      // Per-user, disclosive, cleared by clearReleased. A bare map, likewise
      // unwalkable by the audit. Own test in this file.
      'lib/sweep-grace.ts',
      // The pre-paint script's one-shot ?reset-theme flag (sessionStorage) —
      // consumed by supabase-provider on the very next hydrate, and it says
      // nothing about anyone.
      'app/layout.tsx',
      // `dsul-settings-advanced:<pane>`, sessionStorage: whether one settings
      // pane's advanced disclosure is folded open. Scoped to the tab and dies
      // with it, a boolean per pane, and inert by the classification in
      // lib/local-state.ts — so it is not in the registry, deliberately.
      'components/settings/settings-shell.tsx',
      // The palette mirror the pre-paint script reads. Presentation, explicitly
      // out of scope — see the theme/palette note in lib/local-state.ts.
      'components/providers/supabase-provider.tsx',
      // `dsul.wordmark.nextFlavor`: which hover flavor the logo shows next.
      // One small integer, per device on purpose, and says nothing about anyone.
      'lib/wordmark-flavors.ts',
    ].sort());
  });
});
