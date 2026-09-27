import {
  CONTAINER_KINDS,
  type ContainerKind,
  type ContainerRole,
  type ClassifyKind,
} from './container-registry';

/**
 * item-bands.ts — the item surface's layout, asked as a registry question.
 *
 * The chips on the edit panel and on /item/[id] used to render as ONE flat
 * wrapping row in source order: Priority beside Project beside Routine beside
 * Goal beside Date, five identical pills answering five unrelated questions.
 * Every chip already asked lib/item-registry.ts whether it may exist — the
 * house rule — but nothing asked about order, grouping or emphasis, so the
 * three container ROLES that lib/container-registry.ts spends four screens
 * distinguishing (classify · gate · aspire) reached the user as no distinction
 * at all.
 *
 * A BAND is one labelled row of that surface: a noun on the left, its controls
 * on the right. This module decides which container bands exist and in what
 * order, and it is the only place that answers. It is deliberately pure — no
 * React, no store — so the ordering and the gating are unit-testable without
 * standing up a panel.
 *
 * ── two decisions, and they are not the same decision ────────────────────────
 *
 * **The label is the KIND's noun, not the ROLE's verb.** An earlier draft
 * labelled the bands by role — "filed" (classify), "gated by" (gate), "serves"
 * (aspire). Kirby refused it: *"Let's just use nouns like 'season' and 'goal'"*.
 * The verbs are true and they are also vocabulary the user never asked for; a
 * noun they already know does the same work. So a band's label is
 * `CONTAINER_KINDS[kind].label` and nothing else — CLAUDE.md's rule that the
 * user-facing noun lives ONLY there is what makes a future rename a string edit,
 * and a literal 'Project' in a component is what would break it.
 *
 * **The role still decides everything else.** It orders the bands (what the item
 * IS ABOUT, then what SWITCHES IT OFF, then what it is FOR) and it decides when
 * a band renders at all — see `visibleContainerBands`, whose policy is written
 * per-role, never per-kind. That is the registry's own seam kept intact: the
 * kind supplies the word, the role supplies the behaviour.
 *
 * ── one band per KIND, so the two gates are two rows ─────────────────────────
 *
 * `gate` covers BOTH `routine` and `season`, so a role-driven layout would draw
 * them as one band. They stay two, for three reasons that survive the naming
 * change:
 *
 *   1. Labelling by kind leaves a merged gate band with no name the registry can
 *      supply. It would have to invent one ("Gates", "Timing") — a literal noun
 *      in a component, which is the exact thing the rule above forbids.
 *   2. They are different questions, and item-dialog.tsx already says so where
 *      the two chips are declared: "which routine is this part of" vs "which
 *      stretch of life does this belong to", and a merged picker "would have to
 *      invent a grouping the user never asked for".
 *   3. They are separate stores, separate join tables and separate write paths.
 *      One row holding two independent multi-selects is a control that has to
 *      explain itself; two rows explain themselves.
 *
 * A fifth kind joins by declaring its role, and lands in the right place in the
 * right order with no edit here.
 */

/**
 * Reading order for the bands: what the item is ABOUT, what can switch it OFF,
 * what it is FOR.
 *
 * Not alphabetical and not the record's declaration order by luck — the record
 * happens to agree today, and this constant is what keeps it true when it stops
 * agreeing. Typed against `ContainerRole`, so a fourth role is a compile error
 * here rather than a kind that silently sorts to the front.
 */
export const CONTAINER_ROLE_ORDER: readonly ContainerRole[] = ['classify', 'gate', 'aspire'];

export interface ContainerBand {
  kind: ContainerKind;
  role: ContainerRole;
  /** The user-facing noun, from `CONTAINER_KINDS[kind].label`. Never a literal. */
  label: string;
  labelPlural: string;
}

/**
 * Every container band, role-ordered. Derived from the registry by iterating
 * it, never hand-listed — a band list written out by hand is a second place to
 * forget a kind.
 *
 * `Array.prototype.sort` is stable (ES2019+), so kinds sharing a role keep the
 * record's own order: routine before season.
 */
export const CONTAINER_BANDS: readonly ContainerBand[] = Object.values(CONTAINER_KINDS)
  .slice()
  .sort(
    (a, b) => CONTAINER_ROLE_ORDER.indexOf(a.role) - CONTAINER_ROLE_ORDER.indexOf(b.role)
  )
  .map(({ kind, role, label, labelPlural }) => ({ kind, role, label, labelPlural }));

/** What a surface knows about this item and this account, phrased as answers. */
export interface ContainerBandContext {
  /**
   * The classify kind this item TYPE answers with, or null when the type
   * carries no container axis at all (`ItemTypeConfig.containerKind === null`,
   * resolved through `classifyKindForItemType`).
   */
  classifyKind: ClassifyKind | null;
  /**
   * May this item be collected into the many-to-many containers?
   * `isCollectible(item)` in edit mode — which excludes subtasks — and the
   * type's `collectible` flag in add mode, where there is no item yet.
   */
  collectible: boolean;
  /** Are the routine/season tables reachable (planner-store's availability flag)? */
  collectionsAvailable: boolean;
  /** Is the goals table reachable? */
  goalsAvailable: boolean;
  /** Is the Goals extension switched on for this account? */
  goalsEnabled: boolean;
  /** Is the Organize console reachable — the gates' only door when none exist yet? */
  organizeEnabled: boolean;
  /** How many containers of each kind this account holds. */
  counts: Readonly<Partial<Record<ContainerKind, number>>>;
}

/**
 * The bands this surface renders, in order.
 *
 * AN EMPTY BAND STILL RENDERS. That is the rule carried over from the
 * progressive-disclosure direction that was otherwise refused: a band with no
 * memberships draws as a thin labelled affordance rather than vanishing, so the
 * layout does not jump as you fill it in and so you can discover a band you
 * have never used. What decides whether a band exists is therefore CAPABILITY,
 * never CONTENT — with one exception, below.
 *
 * The policy is written per ROLE:
 *
 *   classify — exactly the kind the type answers with. A type that carries no
 *     container axis gets no band; nothing else could be true, since the value
 *     lives in a column on the item.
 *
 *   gate — needs the tables, needs an item that may join them, and needs
 *     SOMEWHERE TO GO. That last clause is the exception to the empty-band rule
 *     and it is inherited, not invented: with zero routines the band's only
 *     content is the popover's "Organize routines…" door, and item-dialog.tsx
 *     already deletes that door while the Organize console is off, because "a
 *     door that cannot open is not worth the row it costs". A band whose
 *     affordance opens an empty popover is precisely the broken-looking state
 *     the empty-band rule exists to avoid, so zero containers AND no console
 *     means no band.
 *
 *   aspire — renders from zero, and does not consult the console. Its door
 *     rides the Goals extension rather than Organize (lib/extension-gates.ts,
 *     `consoleSectionsFor`), so it opens whenever the band is allowed to exist;
 *     and a goal is the container a user is most likely to want before they own
 *     any, which is the argument the Goal chip already shipped with.
 */
export function visibleContainerBands(ctx: ContainerBandContext): readonly ContainerBand[] {
  return CONTAINER_BANDS.filter((band) => {
    switch (band.role) {
      case 'classify':
        return ctx.classifyKind === band.kind;
      case 'gate':
        return (
          ctx.collectible &&
          ctx.collectionsAvailable &&
          ((ctx.counts[band.kind] ?? 0) > 0 || ctx.organizeEnabled)
        );
      case 'aspire':
        return ctx.collectible && ctx.goalsEnabled && ctx.goalsAvailable;
    }
  });
}

/**
 * What a band's control says when it holds memberships: `Deep work`, or
 * `Deep work +2`.
 *
 * One expression of it, because there were three — the routine, season and
 * goal chips each spelled the same ternary — and three copies of a format is
 * three places for the plus sign to drift.
 *
 * `undefined` for none, which is what `PropertyChip` reads as "unset" and draws
 * as the empty affordance.
 */
export function membershipSummary(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

/**
 * Stable e2e/unit handle for one band ROW.
 *
 * `item-band-*` is a prefix query (`[data-testid^="item-band-"]` reads the whole
 * stack in order), so nothing NESTED inside a band may share it — the readout's
 * add button is `band-add-<kind>` for exactly that reason.
 */
export const bandTestId = (kind: ContainerKind): string => `item-band-${kind}`;
