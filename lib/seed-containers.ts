import { DEFAULT_PROJECTS, type ContainerSeed } from './planner-types';
import type { Item } from './planner-types';

/**
 * WHAT, IF ANYTHING, TO CREATE FOR AN ACCOUNT ON ITS FIRST CONSIDERED LOAD.
 *
 * Pure, and separate from the store on purpose: this decides whether to write
 * rows into an account automatically, which is the highest-consequence automatic
 * write in the app. Every branch is reachable from a plain function call, so the
 * blast radius is testable without standing up a store or a network.
 *
 * THREE OUTCOMES, and the middle one is the reason this is not a one-liner.
 *
 *   'none'        — the account already has containers. Touch nothing at all.
 *   'new-account' — no containers AND no items. The full starter set.
 *   'adopt'       — no containers but items exist. Create ONLY the containers
 *                   those items already name, and nothing else.
 *
 * The 'adopt' branch exists because the live data made the naive rule
 * indefensible. The main account carries 763 items, zero container rows, and 119
 * habits whose `group` text reads "Personal" with nothing behind it. "Sections
 * are empty, so seed" would have written Work, Home and Health into an account
 * that has visibly never used projects — inventing three containers to fix a
 * problem about one. Adopting says the only thing the data supports: these items
 * claim a container, so give them the container they claim.
 *
 * It also fixes something the text-only reference could not. Until a row exists,
 * "Personal" cannot be renamed, cannot be given a glyph, cannot be deleted, and
 * does not appear in the console at all — while 119 items sit inside it.
 *
 * AN ACCOUNT WITH SOME CONTAINERS IS LEFT ALONE ENTIRELY, including its dangling
 * names. One live account references a project "Housework" that has no row; the
 * account has four other projects, so its owner is clearly managing them by
 * hand, and a name they have not created in all that time is a name they do not
 * want. That is today's behaviour and 027's backfill made the same call.
 *
 * TRASHED NAMES ARE EXCLUDED, and this is a correctness guard rather than
 * politeness. `projects_user_id_name_key` is a PLAIN unique index over
 * `(user_id, name)` with no `WHERE deleted_at IS
 * NULL`, so a soft-deleted container reserves its name for the full 30 days
 * while being invisible to every `deleted_at`-filtered fetch the store makes.
 * Adopting a name the bin still holds would raise 23505 and seat exactly the
 * phantom container `undoFailedCreate` exists to clean up — from an automatic
 * write the user never asked for.
 */
export type SeedReason = 'none' | 'new-account' | 'adopt';

export interface SeedPlan {
  reason: SeedReason;
  projects: ContainerSeed[];
}

const NOTHING: SeedPlan = { reason: 'none', projects: [] };

export function planSeed(input: {
  items: readonly Item[];
  projects: readonly { name: string }[];
  /** Container names held by soft-deleted rows — see the note above. */
  trashedProjectNames?: readonly string[];
}): SeedPlan {
  const { items, projects } = input;

  // One list since 039 collapsed the two CLASSIFY kinds. It used to be "either
  // list non-empty means the account is already being managed", deliberately
  // rather than seeding each side independently; with one namespace that
  // subtlety is simply the rule.
  if (projects.length > 0) return NOTHING;

  const heldProjects = new Set(input.trashedProjectNames ?? []);

  /**
   * A BIN WITH CONTAINERS IN IT MEANS THIS ACCOUNT IS NOT NEW, and the live
   * data is why this branch exists: the e2e account holds five trashed projects
   * and zero live ones, so "no containers" was true and "brand new" was not.
   * Someone who has created containers and deleted them has answered the
   * question, and handing them a starter set contradicts the rule the whole
   * phase rests on.
   *
   * Adoption still runs — an item naming a container it lost is a repair, not
   * an invention — and the held names are filtered out of it below.
   */
  const everHadContainers = heldProjects.size > 0;

  if (items.length === 0) {
    if (everHadContainers) return NOTHING;
    // No per-name bin filter here, and its absence is the point: the branch
    // above already returned for ANY held name, so a filter would be unreachable
    // code dressed as a safety net. (It was there, and writing the test for the
    // new rule is what exposed it.) The starter set is only ever handed to an
    // account whose bin holds no container at all.
    return { reason: 'new-account', projects: DEFAULT_PROJECTS };
  }

  return {
    reason: 'adopt',
    projects: adoptable(namesUsed(items), heldProjects),
  };
}

/**
 * The container names this account's items actually reference.
 *
 * EXACT, and that now means untrimmed as well as un-case-folded.
 *
 * The first version trimmed, on the theory that " Personal" and "Personal" are
 * one container. They are not, to the only judge that matters: the unique index
 * is over the raw text, so both are legal rows — and the adopting UPDATE filters
 * on the name it is given. Trimming made the store link the padded item while
 * the database matched nothing, so the link looked right until the next reload
 * silently dropped it. The store and the write have to agree about what the name
 * IS, and the database's answer is the only one that survives.
 *
 * Blank and whitespace-only values are still dropped, because a container named
 * " " is not something any surface can render or the user can delete. Their
 * items keep dangling on text, exactly as today.
 */
function namesUsed(items: readonly Item[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const raw = (item as unknown as Record<string, unknown>).project;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Adopted containers get a name-hashed glyph, not a picked one.
 *
 * `emoji: ''` lets `CategoryIcon` fall back to its name hash, which is the same
 * glyph the app has been drawing for that name all along — so adopting changes
 * nothing on screen except that the row now exists. Choosing an icon here would
 * silently restyle 119 rows as a side effect of a repair.
 */
function adoptable(names: readonly string[], held: ReadonlySet<string>): ContainerSeed[] {
  return names.filter((name) => !held.has(name)).map((name) => ({ name, emoji: '' }));
}

/**
 * The whole first-run pass, run after a load that RESOLVED CLEANLY.
 *
 * Lives here rather than in supabase-provider.tsx because the order of its four
 * steps is the design, and an ordering that only exists inside a provider
 * closure is an ordering no test can reach. The provider keeps the trigger; this
 * keeps the decision.
 *
 *   1. LATCH FIRST, so every load after the first costs one SELECT and stops.
 *      `fetchContainersSeeded` fails CLOSED — a read that did not work answers
 *      "already seeded" — because the failure on the other side is writing
 *      containers into an account whose state could not be read.
 *   2. RE-CHECK THE STORE. The latch read is an await, and Supabase re-emits
 *      SIGNED_IN on every hidden→visible transition, so the store can have been
 *      replaced underneath by then.
 *   3. READ THE BIN. The container name indexes have no
 *      `WHERE deleted_at IS NULL`, so a soft-deleted row holds its name for
 *      thirty days while being invisible to the store; creating it anyway is
 *      23505 and a phantom container, out of a write nobody asked for.
 *   4. LATCH ON THE OUTCOME, not before it. See below — this is the half the
 *      first version got backwards.
 *
 * An account that HAS containers is latched too. It needs nothing, but it has
 * now been considered, and leaving it unlatched would spend a SELECT on every
 * load forever asking a question whose answer cannot change.
 *
 * THE COMMIT REPORTS BACK, AND `userId` TRAVELS WITH THE PLAN. Both of those are
 * corrections to a first version that reasoned about the awaits and then wrote
 * the checks where they could not cover them:
 *
 *   - The account-switch check ran BEFORE two more awaits (the bin read and the
 *     latch write) and nothing re-checked afterwards, so a bare SIGNED_IN for a
 *     different user — which the provider handles in two other places precisely
 *     because Supabase delivers them — carried one account's plan into another
 *     account's store. Passing `userId` into `commit` lets the writer refuse.
 *   - `commit` returned void, so every guard inside it was a silent refusal this
 *     function could not see, and the latch had already been spent. The account
 *     ended latched with zero containers and NO PATH THAT COULD EVER RETRY;
 *     recovery was a hand-written UPDATE. Latching only on a real outcome makes
 *     a refusal cost one wasted load instead of the feature.
 *
 * That inverts the original ordering argument, and the inversion is safe because
 * the durable idempotence guard was never the latch: it is `projects.length > 0`
 * READ BACK FROM THE DATABASE. If the containers landed and the latch write did
 * not, the next load fetches them and takes the 'none' branch — self-healing.
 * The latch's real job is narrower and still intact: remembering that an account
 * which DELETED its starter set must not be given another one.
 */
export type CommitResult = 'committed' | 'nothing-to-do' | 'refused';

export interface SeedDeps {
  hasSeeded: (userId: string) => Promise<boolean>;
  markSeeded: (userId: string) => Promise<void>;
  trashedNames: (userId: string) => Promise<{ projects: { name: string }[] }>;
  snapshot: () => {
    userId: string | null;
    isLoading: boolean;
    /** The account whose most recent load failed, if any (planner-store). */
    loadFailedUserId: string | null;
    items: readonly Item[];
    projects: readonly { name: string }[];
  };
  commit: (plan: SeedPlan, forUserId: string) => CommitResult;
}

export async function runFirstRunSeed(userId: string, deps: SeedDeps): Promise<SeedReason> {
  if (await deps.hasSeeded(userId)) return 'none';

  const before = deps.snapshot();
  // A FAILED load settles like a finished one, with every array empty, and the
  // plan below is made from this snapshot. Planned here, it reads an account
  // with a year of items as brand new; the commit's own refusal cannot catch
  // that if a retry lands the real items first, because an account whose
  // containers exist only as names on its items still has no project rows.
  if (before.userId !== userId || before.isLoading || before.loadFailedUserId === userId) {
    return 'none';
  }

  if (before.projects.length > 0) {
    await deps.markSeeded(userId);
    return 'none';
  }

  const trashed = await deps.trashedNames(userId);
  const plan = planSeed({
    items: before.items,
    projects: before.projects,
    trashedProjectNames: trashed.projects.map((t) => t.name),
  });

  const result = deps.commit(plan, userId);
  // A refusal means the store moved under us — a load re-entered or failed, the
  // account switched, containers appeared. Nothing was written and nothing is
  // known, so the account stays unlatched and the next load asks again.
  if (result === 'refused') return 'none';

  await deps.markSeeded(userId);
  return plan.reason;
}
