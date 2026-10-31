import { addDays, subDays } from 'date-fns';
import { usePlannerStore } from './planner-store';
import { useViewStore } from './view-store';

/**
 * Date navigation, extracted so the header capsule, the mobile header, and
 * the command palette all move the date cursor the same way.
 *
 * The dance being shared is the nav-direction one: `navDirection` drives the
 * canvas slide animation and has to be set BEFORE the date changes and cleared
 * after the transition, or the next render animates from a stale direction.
 * It was copy-pasted (with a bare setTimeout each) in header-capsule and
 * mini-week-nav; two navigations inside the window left the second one's reset
 * racing the first's.
 */

/** Matches the canvas slide duration; the direction is cleared after it. */
export const NAV_DIRECTION_MS = 600;

let navResetTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Move the date cursor. `direction` is the slide the canvas should play —
 * 'left' for going forward in time, 'right' for back, null for a jump with no
 * directional animation (a calendar pick).
 */
export function goToDate(date: Date, direction: 'left' | 'right' | null = null): void {
  const { setSelectedDate, setNavDirection } = usePlannerStore.getState();

  if (navResetTimer) clearTimeout(navResetTimer);

  setNavDirection(direction);
  setSelectedDate(date);

  if (direction) {
    navResetTimer = setTimeout(() => {
      usePlannerStore.getState().setNavDirection(null);
      navResetTimer = null;
    }, NAV_DIRECTION_MS);
  }
}

/**
 * Step the cursor by whole days regardless of scope — the unit `stepScope`
 * below is built from, and its only caller. The mobile week strip used to be
 * the other one; it is gone, and the phone calls `goToDate` outright (Go to
 * date and the Today key), so a change here reaches the desktop
 * chevrons and the palette's Next/Previous, not the phone.
 */
export function stepDays(delta: number): void {
  const { selectedDate } = usePlannerStore.getState();
  const next = delta >= 0 ? addDays(selectedDate, delta) : subDays(selectedDate, -delta);
  goToDate(next, delta >= 0 ? 'left' : 'right');
}

/**
 * Step by one unit of the CURRENT scope — a day in day scope, a week in week
 * scope. This is what the header chevrons and the Next/Previous commands do.
 */
export function stepScope(delta: 1 | -1): void {
  const { scope } = useViewStore.getState();
  // Atlas has no day of its own: a step there would move a date nobody can see.
  if (scope === 'atlas') return;
  const span = scope === 'week' ? 7 : 1;
  stepDays(delta * span);
}
