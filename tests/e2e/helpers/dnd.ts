import type { Locator, Page } from '@playwright/test';

/**
 * Drive a dnd-kit pointer drag.
 *
 * The previous version of this helper was wrong in four ways that each produced
 * a confusing failure rather than an honest one:
 *
 * 1. It called `target.scrollIntoViewIfNeeded()` AFTER `mouse.down()` with no
 *    try/finally. Most drop targets in this app only MOUNT while a drag is
 *    active, so when that call timed out the error escaped with the pointer still
 *    pressed — corrupting every later action in the test and reporting a
 *    scrollIntoViewIfNeeded timeout that hid the real cause.
 * 2. It aimed the CURSOR at the target's centre. The app uses `closestCenter`
 *    (components/shell/app-shell.tsx), which compares the DRAGGED element's rect
 *    centre — not the pointer — against each droppable's centre. Grabbing a row
 *    by its title put the row's centre ~120px right of the cursor because of the
 *    reserved metadata rail, so the aim was systematically off.
 * 3. It measured the source before pressing and never re-measured, even though
 *    activating a drag mounts a drop zone in every bucket and reflows the canvas.
 * 4. It slept `waitForTimeout(150)` and hoped, instead of waiting for the drop
 *    target to actually report itself as hovered.
 *
 * It also documented an 8px activation threshold; the sensor uses 5.
 *
 * This version presses at a known point, aims by the dragged rect rather than the
 * cursor, homes in on the target's own `data-dnd-over` signal, and always releases.
 *
 * KNOWN LIMIT — prefer an ADJACENT drop target. A drag that must cross a scroll
 * boundary (morning → evening, where evening starts below the fold) triggers
 * dnd-kit's autoscroll, and autoscroll makes the collision model genuinely
 * non-deterministic to drive: dnd-kit collides droppable rects measured at drag
 * start against a scroll-compensated active rect, so its answer depends on how
 * much scrolling happened to accumulate mid-gesture. The loop below converges most
 * of the time but not reliably enough to gate CI on. Test bucket reassignment
 * against a NEIGHBOURING bucket — identical store action, identical observable —
 * and cover long-distance moves through the schedule sheet, which issues the same
 * commands without a gesture.
 */

/**
 * NonTouchPointerSensor activationConstraint.distance — configured in
 * components/shell/app-shell.tsx, defined in lib/dnd/sensors.ts.
 *
 * This helper drives `page.mouse`, whose pointer events carry
 * `pointerType: 'mouse'`, so it goes through that sensor and this distance still
 * governs. Only a genuinely touch-driven drag takes the TouchSensor's 250ms
 * press-and-hold path, and nothing in the suite does that today.
 */
const ACTIVATION_DISTANCE = 5;

export interface DragOptions {
  /**
   * A locator that exists BEFORE the drag starts and sits near the target, used
   * to scroll the region into view while scrolling is still safe. Most contract
   * droppables (`unscheduled:{bucket}`, `scheduled:{bucket}:empty`) mount only
   * during a drag, so they cannot be scrolled to themselves.
   */
  scrollHint?: Locator;
  /** Steps for the travel move. dnd-kit recomputes collisions per pointermove. */
  steps?: number;
  /** How long to wait for the target to report `data-dnd-over="true"`. */
  hoverTimeout?: number;
  /**
   * Droppable ids that count as landing on `target`, when several are
   * contractually equivalent.
   *
   * This is not laxity — it is the collision model. `closestCenter` compares
   * CENTRES, and for an empty bucket the bare `{bucket}` droppable's centre sits
   * ~3px from `unscheduled:{bucket}`'s (measured: 802 vs 799). No pointer
   * position can reliably single one out, so demanding a specific one of the two
   * is a test that cannot pass. CONTRACT.md defines them as the same action
   * ("same as unscheduled:{bucket}"), so accepting either is exactly right.
   */
  accept?: string[];
}

async function box(locator: Locator, what: string) {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`drag: ${what} has no bounding box (not attached or not visible)`);
  if (b.width === 0 || b.height === 0) {
    throw new Error(`drag: ${what} has zero area (${b.width}×${b.height}) — nothing to aim at`);
  }
  return b;
}

const centre = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/**
 * Where to press to drag a row: its title's leading edge, not its centre.
 *
 * Moving the pointer onto a row reveals its hover cluster (task-row), which sits
 * over the middle of a wide row and stops pointerdown so its buttons work. A
 * press there never starts a drag, and the release clicks whichever control is
 * under it (a task moved to tomorrow, a habit paused). The title's start is
 * never covered. Draggables without a row title fall back to `fallback`'s centre.
 */
export async function pressPoint(root: Locator, fallback: Locator = root) {
  const title = root.locator('[data-row-title]').first();
  const titleBox = (await title.count()) > 0 ? await title.boundingBox() : null;
  return titleBox
    ? { x: titleBox.x + Math.min(8, titleBox.width / 2), y: titleBox.y + titleBox.height / 2 }
    : centre(await box(fallback, 'source'));
}

/**
 * Drag `source` onto `target`.
 *
 * `source` may be any element inside the draggable (a title, say) — the helper
 * resolves the real draggable root via the nearest `[data-item-id]` ancestor and
 * aims by THAT rect, which is what dnd-kit's collision detection measures.
 */
export async function dragTo(
  page: Page,
  source: Locator,
  target: Locator,
  options: DragOptions = {}
): Promise<void> {
  const { scrollHint, steps = 12, hoverTimeout = 8_000, accept } = options;

  // Everything that can scroll must scroll BEFORE the pointer goes down.
  await source.scrollIntoViewIfNeeded();
  if (scrollHint) await scrollHint.scrollIntoViewIfNeeded().catch(() => {});

  // The element dnd-kit will actually measure. `.first()` guards against a
  // locator that matches an item rendered in two places (a project-block task
  // also renders in its bucket).
  const draggable = source
    .locator('xpath=ancestor-or-self::*[@data-item-id][1]')
    .first();
  const hasDraggable = (await draggable.count()) > 0;
  const root = hasDraggable ? draggable : source;

  const press = await pressPoint(root, source);
  const rootBefore = await box(root, 'draggable root');

  const viewport = page.viewportSize();
  const clamp = (p: { x: number; y: number }) =>
    viewport
      ? {
          x: Math.min(Math.max(p.x, 1), viewport.width - 1),
          y: Math.min(Math.max(p.y, 1), viewport.height - 1),
        }
      : p;

  await page.mouse.move(press.x, press.y);
  await page.mouse.down();

  try {
    // Cross the activation threshold. Several small moves, not one jump: the
    // sensor measures distance from the pointerdown point, and dnd-kit only
    // starts tracking once activated.
    for (const dx of [3, 6, ACTIVATION_DISTANCE + 6]) {
      await page.mouse.move(press.x + dx, press.y, { steps: 2 });
    }

    // The target may only have mounted just now, as a result of activation.
    await target.first().waitFor({ state: 'attached', timeout: 5_000 });

    /**
     * Aim in dnd-kit's coordinate model, which is NOT the live layout.
     *
     * dnd-kit measures the dragged node's rect ONCE, in onDragStart, and then
     * collides `activeNodeRect + translate` against the droppables. Activation
     * mounts a drop zone in every bucket, which reflows the canvas and moves the
     * row's VISUAL position — so the live box and dnd-kit's model diverge by
     * exactly that reflow. Re-measuring the row post-activation (the obvious
     * thing to do) therefore aims at the wrong place, and with contract
     * droppables stacked ~38px apart that is enough to hand the drop to the
     * neighbouring zone.
     *
     * So: model the dragged centre as its PRE-activation centre plus the pointer
     * delta, and never re-measure the row.
     */
    const modelCentre = (p: { x: number; y: number }) => ({
      x: centre(rootBefore).x + (p.x - press.x),
      y: centre(rootBefore).y + (p.y - press.y),
    });

    const targetCentre = centre(await box(target.first(), 'target'));
    const destination = clamp({
      x: press.x + (targetCentre.x - centre(rootBefore).x),
      y: press.y + (targetCentre.y - centre(rootBefore).y),
    });

    let pointer = destination;
    await page.mouse.move(pointer.x, pointer.y, { steps });

    /**
     * Home in using the app's OWN hover signal, not geometry.
     *
     * Geometry aiming cannot be made reliable here, and it is worth recording
     * why. Reaching a bucket below the fold makes dnd-kit autoscroll the canvas.
     * dnd-kit measures droppable rects once at drag start and then collides them
     * against a scroll-COMPENSATED active rect — so after an autoscroll its
     * model and the live layout disagree by the scroll delta. Measured directly:
     * the dragged row landed dead-centre on `unscheduled:evening` (both centres
     * at y=715) while dnd-kit reported hovering `scheduled:evening:empty` 48px
     * away, because in ITS space the active rect had been pushed 84px down.
     *
     * `data-dnd-over` is the app answering the only question that matters. So:
     * step toward the target, ask which zone is actually hovered, and correct.
     * Direction comes from document order, which for these stacked droppables is
     * visual order. Step size halves on every reversal, so this converges instead
     * of oscillating, and it is immune to whatever dnd-kit believes internally.
     */
    const dndId = await target.first().getAttribute('data-dnd-id');
    if (dndId) {
      const acceptIds = accept?.length ? accept : [dndId];
      const hovered = page.locator(
        acceptIds.map((id) => `[data-dnd-id="${id}"][data-dnd-over="true"]`).join(", ")
      );
      const order = await page
        .locator('[data-dnd-id]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-dnd-id')));
      const targetIndex = order.indexOf(dndId);

      const deadline = Date.now() + hoverTimeout;
      let step = 32;
      let lastDirection = 0;

      while (Date.now() < deadline) {
        if (await hovered.count()) break;

        const current = await page
          .locator('[data-dnd-over="true"]')
          .first()
          .getAttribute('data-dnd-id')
          .catch(() => null);

        let direction: number;
        if (current && order.indexOf(current) >= 0 && targetIndex >= 0) {
          // Hovering something above the target → move down, and vice versa.
          direction = order.indexOf(current) < targetIndex ? 1 : -1;
        } else {
          // Over nothing: fall back to the target's live position.
          const targetNow = centre(await box(target.first(), 'target'));
          direction = targetNow.y > modelCentre(pointer).y ? 1 : -1;
        }

        if (lastDirection !== 0 && direction !== lastDirection) step = Math.max(3, step / 2);
        lastDirection = direction;

        pointer = clamp({ x: pointer.x, y: pointer.y + direction * step });
        await page.mouse.move(pointer.x, pointer.y, { steps: 3 });

        if (process.env.DEBUG_DND) {
          console.log(
            `[dnd] over=${current ?? '(none)'} want=${dndId} dir=${direction} step=${step} y=${Math.round(pointer.y)}`
          );
        }
      }
      if (!(await hovered.count())) {
        // Report which droppable DID win — a silent mis-drop is the hardest DnD
        // failure to diagnose, and closestCenter makes near-misses plausible.
        const actual = await page
          .locator('[data-dnd-over="true"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-dnd-id')));
        throw new Error(
          `drag: never hovered ${acceptIds.map((id) => `"${id}"`).join(' | ')} ` +
            `within ${hoverTimeout}ms. ` +
            `Currently over: ${actual.length ? actual.join(', ') : '(nothing)'}`
        );
      }

      // The hover must still hold at the instant of release, and hold STILL.
      //
      // Confirming once was not enough: an in-flight autoscroll keeps moving the
      // layout, so the target could win the collision during the check and lose it
      // again before mouse.up — producing a drop on a neighbouring bucket while the
      // helper believed it had succeeded (observed: asserted afternoon, got
      // evening). Two consecutive confirmations a frame apart mean the layout has
      // settled, not merely passed through the right state.
      const settleDeadline = Date.now() + 3_000;
      let consecutive = 0;
      while (consecutive < 2 && Date.now() < settleDeadline) {
        await page.waitForTimeout(50);
        consecutive = (await hovered.count()) ? consecutive + 1 : 0;
      }
      if (consecutive < 2) {
        const actual = await page
          .locator('[data-dnd-over="true"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-dnd-id')));
        throw new Error(
          `drag: hover on ${acceptIds.map((id) => `"${id}"`).join(' | ')} would not ` +
            `hold still (autoscroll still in flight?). Currently over: ` +
            `${actual.length ? actual.join(', ') : '(nothing)'}`
        );
      }
    }
  } finally {
    // Always release. A stuck pointerdown poisons every subsequent action in the
    // test and makes the failure look like it happened somewhere else.
    await page.mouse.up();
  }
}

/**
 * Drag an item onto one of a bucket's contract droppables.
 *
 * `zone: 'untimed'` schedules with NO time — `unscheduled:{bucket}`, or the bare
 * `{bucket}` fallback, which CONTRACT.md defines as the same action and whose
 * centre is unavoidably ~3px away (see DragOptions.accept).
 *
 * `zone: 'timed'` targets `scheduled:{bucket}:empty`, which schedules WITH a
 * bucket-default time. The two outcomes look identical in the rendered list but
 * write different rows, which is why both need naming.
 */
export async function dragItemToBucket(
  page: Page,
  itemId: string,
  bucket: 'anytime' | 'morning' | 'afternoon' | 'evening',
  zone: 'untimed' | 'timed' = 'untimed'
): Promise<void> {
  const dndId = zone === 'untimed' ? `unscheduled:${bucket}` : `scheduled:${bucket}:empty`;
  const accept = zone === 'untimed' ? [`unscheduled:${bucket}`, bucket] : [dndId];
  await dragTo(
    page,
    page.locator(`[data-item-id="${itemId}"]`).first(),
    page.locator(`[data-dnd-id="${dndId}"]`),
    { scrollHint: page.locator(`[data-dnd-bucket="${bucket}"]`), accept }
  );
}
