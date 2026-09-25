import { describe, it, expect, vi } from 'vitest';
import { planSeed, runFirstRunSeed, type SeedDeps } from '@/lib/seed-containers';
import { DEFAULT_PROJECTS } from '@/lib/planner-types';
import type { Item } from '@/lib/planner-types';

/**
 * WHAT AN ACCOUNT GETS WRITTEN INTO IT WITHOUT ASKING.
 *
 * This is the highest-consequence automatic write in the app: it fires on load,
 * with no user gesture, against whatever the fetch happened to return. Every
 * branch is pinned here rather than through the store, because the failure worth
 * preventing — deciding a populated account is empty — is a decision this
 * function makes alone.
 *
 * The live data is the reason the rule is not "sections are empty, so seed": one
 * account carries 763 items, zero container rows, and 119 habits whose
 * container text reads "Personal" with nothing behind it.
 *
 * ONE LIST since migration 039 collapsed the two CLASSIFY kinds. The plan used
 * to carry `projects` and `groups` separately and the account was left alone if
 * EITHER was non-empty; that subtlety is simply the rule now.
 */

const task = (over: Partial<Item> = {}): Item =>
  ({ id: 't1', type: 'task', title: 'T', status: 'pending', isScheduled: false, order: 0, ...over }) as Item;

const habit = (over: Partial<Item> = {}): Item =>
  ({
    id: 'h1', type: 'habit', title: 'H', status: 'pending', repeatFrequency: 'daily',
    completedDates: [], skippedDates: [], streak: 0, project: 'Personal', order: 0, isScheduled: false,
    ...over,
  }) as Item;

const empty = { items: [], projects: [] };

describe('an account that already has containers', () => {
  it('is left alone entirely', () => {
    expect(planSeed({ ...empty, projects: [{ name: 'Work' }] }).reason).toBe('none');
    expect(planSeed({ ...empty, projects: [{ name: 'Morning' }] }).reason).toBe('none');
  });

  it('keeps its dangling names dangling', () => {
    /**
     * A live account references a project "Housework" that has no row, while
     * owning four other projects — so its owner is managing them by hand, and a
     * name they have not created in all that time is a name they do not want.
     * 027's backfill made the same call.
     */
    const plan = planSeed({
      items: [task({ project: 'Housework' })],
      projects: [{ name: 'Work' }],
    });
    expect(plan).toEqual({ reason: 'none', projects: [] });
  });
});

describe('a brand-new account', () => {
  it('gets the whole starter set', () => {
    const plan = planSeed(empty);
    expect(plan.reason).toBe('new-account');
    expect(plan.projects).toEqual(DEFAULT_PROJECTS);
  });

  it('ships no name twice, so no filter chip is ambiguous', () => {
    // The two starter lists were made disjoint when projects and habit groups
    // were separate namespaces (a chip reading "Work" could not say which it
    // meant). That is what made concatenating them safe in 039 — and the
    // uniqueness has to hold now for a plainer reason: one namespace, one
    // unique index, and a duplicate name is a 23505 on first load.
    const names = planSeed(empty).projects.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(6);
  });

  it('ships icon TOKENS, not the bare emoji the constants had for a year', () => {
    for (const seed of planSeed(empty).projects) {
      expect(seed.emoji).toMatch(/^icon:[A-Z]/);
    }
  });

  it('is not new at all once the BIN holds a container', () => {
    /**
     * An account with trashed containers and no live ones has created
     * containers and then deleted them — it has answered the question, and a
     * starter set contradicts the rule the whole phase rests on. The e2e
     * account is a live instance: five trashed projects, zero live.
     *
     * This also removes the 23505 hazard by construction rather than by filter.
     * The unique indexes have no `WHERE deleted_at IS NULL`, so a soft-deleted
     * container reserves its name for thirty days while being invisible to
     * every fetch the store makes.
     */
    expect(planSeed({ ...empty, trashedProjectNames: ['Anything'] })).toEqual({
      reason: 'none',
      projects: [],
    });
  });
});

describe('an account with items but no containers — the adopt case', () => {
  it('creates only the containers its items already name', () => {
    // The 119-habit case. It must NOT also invent Work, Home and Health into an
    // account that has visibly never used projects.
    const plan = planSeed({
      ...empty,
      items: [habit({ project: 'Personal' }), habit({ id: 'h2', project: 'Personal' })],
    });
    expect(plan.reason).toBe('adopt');
    expect(plan.projects.map((p) => p.name)).toEqual(['Personal']);
  });

  it('adopts project names too, from task-like items', () => {
    const plan = planSeed({ ...empty, items: [task({ project: 'Housework' })] });
    expect(plan.projects.map((p) => p.name)).toEqual(['Housework']);
  });

  it('leaves adopted glyphs unset, so nothing on screen changes', () => {
    // CategoryIcon's name hash is the glyph the app has drawn for that name all
    // along. Picking one here would restyle 119 rows as a side effect of a repair.
    const plan = planSeed({ ...empty, items: [habit({ project: 'Personal' })] });
    expect(plan.projects[0].emoji).toBe('');
  });

  it('does not case-fold, because the unique index does not', () => {
    // "personal" and "Personal" are two legal rows. Folding would adopt one and
    // leave the other half of the items dangling with no sign of why.
    const plan = planSeed({
      ...empty,
      items: [habit({ project: 'Personal' }), habit({ id: 'h2', project: 'personal' })],
    });
    expect(plan.projects.map((p) => p.name).sort()).toEqual(['Personal', 'personal']);
  });

  it('de-dupes, so 119 items naming one group make one container', () => {
    const items = Array.from({ length: 119 }, (_, i) => habit({ id: `h${i}`, project: 'Personal' }));
    expect(planSeed({ ...empty, items }).projects).toHaveLength(1);
  });

  it('drops blank and whitespace-only names', () => {
    // A cleared container used to write '' rather than NULL. A container named
    // "" is not something any surface can render or the user can delete.
    const plan = planSeed({
      ...empty,
      items: [habit({ project: '' }), habit({ id: 'h2', project: '   ' }), task({ project: '' })],
    });
    expect(plan.projects).toEqual([]);
  });

  it('does NOT trim, because the adopting UPDATE cannot', () => {
    /**
     * This trimmed, on the theory that " Personal" and "Personal" are one
     * container. They are not, to the only judge that matters: the unique index
     * is over the raw text and the adopting UPDATE filters on the name it is
     * given. Trimming made the store link the padded item while the database
     * matched nothing — a link that looked right until the next reload silently
     * dropped it.
     */
    const plan = planSeed({
      ...empty,
      items: [habit({ project: ' Personal' }), habit({ id: 'h2', project: 'Personal' })],
    });
    expect(plan.projects.map((p) => p.name).sort()).toEqual([' Personal', 'Personal']);
  });

  it('skips a name the bin is holding, and adopts the rest', () => {
    const plan = planSeed({
      ...empty,
      items: [habit({ project: 'Personal' }), habit({ id: 'h2', project: 'Work' })],
      trashedProjectNames: ['Personal'],
    });
    expect(plan.projects.map((p) => p.name)).toEqual(['Work']);
  });

  it('NEVER falls through to the starter set', () => {
    // The whole point of the branch: an account with items is not new, however
    // few items it has, and giving it six containers it never asked for is the
    // outcome this design exists to prevent.
    const plan = planSeed({ ...empty, items: [task({ project: undefined })] });
    expect(plan.reason).toBe('adopt');
    expect(plan.projects).toEqual([]);
  });
});

/* ── the orchestration, where the ORDER is the design ─────────────────── */

describe('runFirstRunSeed', () => {
  const harness = (over: Partial<SeedDeps> = {}, state: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const deps: SeedDeps = {
      hasSeeded: vi.fn(async () => {
        calls.push('read-latch');
        return false;
      }),
      markSeeded: vi.fn(async () => {
        calls.push('set-latch');
      }),
      trashedNames: vi.fn(async () => {
        calls.push('read-bin');
        return { projects: [] };
      }),
      snapshot: () => ({
        userId: 'u1',
        isLoading: false,
        loadFailedUserId: null,
        items: [] as Item[],
        projects: [] as { name: string }[],
        ...state,
      }),
      commit: vi.fn(() => {
        calls.push('commit');
        return 'committed' as const;
      }),
      ...over,
    };
    return { deps, calls };
  };

  it('LATCHES ON THE OUTCOME, after the commit has reported back', async () => {
    /**
     * The first version latched first, reasoning that a failed write must not
     * become a re-seed. It had it backwards: `commit` can REFUSE (the store
     * moved under the awaits), the refusal was invisible because commit
     * returned void, and the account ended latched with zero containers and no
     * path that could ever retry.
     *
     * Inverting is safe because the durable idempotence guard was never the
     * latch — it is `projects.length > 0` read back from the database. Rows
     * landing without the latch self-heal on the next load.
     */
    const { deps, calls } = harness();
    await runFirstRunSeed('u1', deps);
    expect(calls).toEqual(['read-latch', 'read-bin', 'commit', 'set-latch']);
  });

  it('reads the latch FIRST, so every later load is one SELECT and out', async () => {
    const { deps, calls } = harness({ hasSeeded: vi.fn(async () => true) });
    expect(await runFirstRunSeed('u1', deps)).toBe('none');
    expect(calls).toEqual([]);
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.markSeeded).not.toHaveBeenCalled();
  });

  it('latches an account that needs nothing, so it stops being asked', async () => {
    const { deps } = harness({}, { projects: [{ name: 'Work' }] });
    expect(await runFirstRunSeed('u1', deps)).toBe('none');
    expect(deps.markSeeded).toHaveBeenCalledOnce();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('does nothing mid-load, and does NOT latch — the next load retries', async () => {
    // Seeding inside the load window is the documented trap: initializeStore
    // replaces the arrays wholesale, so the rows would vanish on the next
    // reload. Latching there would make that permanent.
    const { deps } = harness({}, { isLoading: true });
    expect(await runFirstRunSeed('u1', deps)).toBe('none');
    expect(deps.markSeeded).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('does not PLAN from a failed load, and does not latch — the retry asks again', async () => {
    // A failed load settles with isLoading false and every array empty, which
    // planSeed reads as a brand-new account. Refused here, before the plan: the
    // commit's own check cannot see it once a retry has landed the real items,
    // because an account whose containers are only names on its items still
    // has no project rows by then.
    const { deps, calls } = harness({}, { loadFailedUserId: 'u1' });
    expect(await runFirstRunSeed('u1', deps)).toBe('none');
    expect(calls).toEqual(['read-latch']);
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.markSeeded).not.toHaveBeenCalled();
  });

  it('drops out if the account had already switched', async () => {
    const { deps } = harness({}, { userId: 'someone-else' });
    expect(await runFirstRunSeed('u1', deps)).toBe('none');
    expect(deps.markSeeded).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });

  /**
   * THE RACE THE PREVIOUS VERSION OF THIS SUITE COULD NOT REACH.
   *
   * The old harness gave `snapshot` a constant thunk, so nothing ever changed
   * under any await — it proved the guard EXISTED and never that it fires. The
   * defect shipped straight through it.
   *
   * The window is real and the codebase already treats it as such: the provider
   * handles "a bare SIGNED_IN for a different user" in two other places, because
   * Supabase can deliver one with no intervening SIGNED_OUT. Two awaits remain
   * after the userId check — the bin read and the latch write — and an account
   * switch inside either of them used to carry A's plan into B's account.
   */
  const switching = (at: 'bin' | 'latch') => {
    let userId = 'u1';
    const { deps } = harness({}, {});
    deps.snapshot = () => ({
      userId,
      isLoading: false,
      loadFailedUserId: null,
      items: [] as Item[],
      projects: [] as { name: string }[],
    });
    const flip = () => {
      userId = 'u2';
    };
    if (at === 'bin') {
      deps.trashedNames = vi.fn(async () => {
        flip();
        return { projects: [] };
      });
    } else {
      deps.markSeeded = vi.fn(async () => flip());
    }
    return deps;
  };

  it('does not commit A’s plan into B’s account — switch during the BIN read', async () => {
    const deps = switching('bin');
    await runFirstRunSeed('u1', deps);
    // Either it refused outright, or it handed the commit the account the plan
    // was computed FOR so the store can refuse. What it must never do is commit
    // blind into whoever is loaded now.
    for (const call of vi.mocked(deps.commit).mock.calls) expect(call[1]).toBe('u1');
  });

  it('does not commit A’s plan into B’s account — switch during the LATCH write', async () => {
    const deps = switching('latch');
    await runFirstRunSeed('u1', deps);
    for (const call of vi.mocked(deps.commit).mock.calls) expect(call[1]).toBe('u1');
  });

  /**
   * THE LATCH MUST NOT BE SPENT ON A REFUSAL.
   *
   * `commit` used to return void, so every guard inside the store action was a
   * silent refusal the orchestrator could not see — and the latch had already
   * been written. The account ends latched with zero containers and no code
   * path that can ever retry: recovery is a hand-written UPDATE.
   *
   * The trigger is ordinary. `isLoading` turning true after the pre-await check
   * is a SIGNED_IN re-emit re-entering initializeStore, which this file's own
   * comments call an ordinary event.
   */
  it('does NOT latch when the commit refuses, so the next load retries', async () => {
    const { deps } = harness({ commit: vi.fn(() => 'refused' as const) });
    await runFirstRunSeed('u1', deps);
    expect(deps.markSeeded).not.toHaveBeenCalled();
  });

  it('DOES latch when there was genuinely nothing to create', async () => {
    // A stable answer, unlike a refusal — asking again on every load forever
    // would never produce a different one.
    const { deps } = harness({ commit: vi.fn(() => 'nothing-to-do' as const) });
    await runFirstRunSeed('u1', deps);
    expect(deps.markSeeded).toHaveBeenCalledOnce();
  });

  it('treats an account with TRASHED containers as not new', async () => {
    // 5 trashed projects and no live ones is an account that has managed
    // containers and emptied them — the opposite of brand new. Giving it a
    // starter set contradicts the whole rule this phase is built on.
    const { deps } = harness({
      trashedNames: vi.fn(async () => ({
        projects: [{ name: 'Old' }, { name: 'Older' }],
        groups: [],
      })),
    });
    await runFirstRunSeed('u1', deps);
    const plan = vi.mocked(deps.commit).mock.calls[0][0];
    expect(plan.reason).toBe('none');
    expect(plan.projects).toEqual([]);
  });

  it('feeds the bin into the plan, so a held name is never created', async () => {
    const { deps } = harness({
      trashedNames: vi.fn(async () => ({ projects: [{ name: 'Work' }] })),
    });
    await runFirstRunSeed('u1', deps);
    const plan = vi.mocked(deps.commit).mock.calls[0][0];
    expect(plan.projects.map((p) => p.name)).not.toContain('Work');
  });

  it('surfaces a latch-write failure rather than swallowing it', async () => {
    // The containers are already committed at this point, and that is fine: the
    // next load reads them back from the database and takes the 'none' branch,
    // latching then. What must not happen is the failure disappearing, because
    // an account that stays unlatched with containers present is exactly the
    // state the 'none' branch is there to resolve.
    const { deps } = harness({
      markSeeded: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(runFirstRunSeed('u1', deps)).rejects.toThrow('offline');
  });
});
