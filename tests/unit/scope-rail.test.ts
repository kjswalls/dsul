import { describe, it, expect } from 'vitest';
import { buildScopeRows, seasonStateForSwitch, type ScopeRow } from '@/lib/scope-rail';
import type { Routine, Season } from '@dsul/types';

const TZ = 'America/New_York';
const TODAY = '2026-08-10';
/** Noon UTC is still the same day in New York — no boundary meaning in fixtures. */
const JUL01 = '2026-07-01T12:00:00Z';

const routine = (id: string, over: Partial<Routine> = {}): Routine => ({
  id,
  name: `Routine ${id}`,
  itemIds: [],
  ...over,
});

const season = (id: string, over: Partial<Season> = {}): Season => ({
  id,
  name: `Season ${id}`,
  state: 'auto',
  itemIds: [],
  routineIds: [],
  ...over,
});

const build = (routines: Routine[], seasons: Season[]) =>
  buildScopeRows(routines, seasons, TODAY, TZ);

const row = (rows: ScopeRow[], id: string) => rows.find((r) => r.id === id)!;

describe('seasonStateForSwitch — prefer auto whenever auto already answers', () => {
  // The rule that keeps a binary switch from destroying a tri-state. Both
  // directions matter: turning a live summer off with `paused` and back on with
  // `active` loses its Aug 31 end, and turning a future term on with `active`
  // and off again with `paused` loses its Sep 1 start.
  const summer = season('s', { startsOn: '2026-06-01', endsOn: '2026-08-31' });
  const term = season('t', { startsOn: '2026-09-01', endsOn: '2026-12-20' });

  it('writes a manual override only when it is genuinely needed', () => {
    // Summer is live today; asking for OFF disagrees with the calendar.
    expect(seasonStateForSwitch(summer, false, TODAY)).toBe('paused');
    // Term is off today; asking for ON disagrees with the calendar.
    expect(seasonStateForSwitch(term, true, TODAY)).toBe('active');
  });

  it('returns to auto when auto is already producing the requested state', () => {
    expect(seasonStateForSwitch({ ...summer, state: 'paused' }, true, TODAY)).toBe('auto');
    expect(seasonStateForSwitch({ ...term, state: 'active' }, false, TODAY)).toBe('auto');
  });

  it('round-trips a dated season without losing its dates', () => {
    const off = seasonStateForSwitch(summer, false, TODAY);
    const back = seasonStateForSwitch({ ...summer, state: off }, true, TODAY);
    expect(back).toBe('auto');
    const on = seasonStateForSwitch(term, true, TODAY);
    const again = seasonStateForSwitch({ ...term, state: on }, false, TODAY);
    expect(again).toBe('auto');
  });

  it('a rangeless season still switches off manually', () => {
    const p = season('p');
    expect(seasonStateForSwitch(p, false, TODAY)).toBe('paused');
    expect(seasonStateForSwitch({ ...p, state: 'paused' }, true, TODAY)).toBe('auto');
  });
});

describe('buildScopeRows — the local/effective split', () => {
  it('a season has nothing above it, so its switch IS its effect', () => {
    const rows = build([], [season('p', { state: 'paused' })]);
    expect(row(rows, 'p').localOn).toBe(false);
    expect(row(rows, 'p').effectiveOn).toBe(false);
  });

  it('a routine held off by its season keeps its own switch ON', () => {
    // The correctness constraint. Render this routine as "off" and resuming the
    // season hands back a routine the user believes they turned off.
    const r = routine('r', { name: 'Mornings' });
    const p = season('p', { name: 'Term', state: 'paused', routineIds: ['r'] });
    const rows = build([r], [p]);
    expect(row(rows, 'r').localOn).toBe(true);
    expect(row(rows, 'r').effectiveOn).toBe(false);
    expect(row(rows, 'r').state).toBe('On · held with Term');
  });

  it('one live holder is enough — the rule is disjunctive', () => {
    const r = routine('r');
    const rows = build(
      [r],
      [
        season('off', { state: 'paused', routineIds: ['r'] }),
        season('on', { state: 'active', routineIds: ['r'] }),
      ]
    );
    expect(row(rows, 'r').effectiveOn).toBe(true);
    expect(row(rows, 'r').state).toBe('On');
  });

  it('names the soonest-returning blocker and counts the rest', () => {
    const r = routine('r');
    const rows = build(
      [r],
      [
        season('later', { name: 'Later', startsOn: '2026-10-01', routineIds: ['r'] }),
        season('soon', { name: 'Soon', startsOn: '2026-09-01', routineIds: ['r'] }),
      ]
    );
    // Disjunctive: the routine comes back when the FIRST holder does.
    expect(row(rows, 'r').state).toBe('On · held with Soon +1');
  });

  it('a self-paused routine reads off, with its own resume date', () => {
    const r = routine('r', { pausedAt: JUL01, pausedUntil: '2026-09-01' });
    const rows = build([r], []);
    expect(row(rows, 'r').localOn).toBe(false);
    expect(row(rows, 'r').state).toBe('Off · back Sep 1');
  });
});

describe('buildScopeRows — the state line', () => {
  const line = (p: Partial<Season>) => row(build([], [season('p', p)]), 'p').state;

  it('distinguishes a manual override from the calendar', () => {
    expect(line({ state: 'active' })).toBe('On · you turned it on');
    expect(line({ state: 'paused' })).toBe('Off · you turned it off');
  });

  it('reports an auto range from whichever end is in play', () => {
    expect(line({ startsOn: '2026-06-01', endsOn: '2026-08-31' })).toBe('On · until Aug 31');
    expect(line({ startsOn: '2026-09-01' })).toBe('Off · back Sep 1');
    expect(line({ endsOn: '2026-07-31' })).toBe('Off · ended Jul 31');
    expect(line({})).toBe('On');
  });

  it('promises no return date for an inverted range', () => {
    // Live on NO date, so its start is not a comeback — saying "back Sep 1"
    // would have the user waiting for a day that does nothing.
    expect(line({ startsOn: '2026-09-01', endsOn: '2026-08-01' })).toBe('Off');
  });
});

describe('buildScopeRows — ordering', () => {
  it('puts off containers last without dropping them, seasons before routines', () => {
    const rows = build(
      [routine('r-on'), routine('r-off', { pausedAt: JUL01 })],
      [season('p-on', { state: 'active' }), season('p-off', { state: 'paused' })]
    );
    expect(rows.map((r) => r.id)).toEqual(['p-on', 'r-on', 'p-off', 'r-off']);
  });

  it('ranks by the EFFECTIVE state, not by the switch', () => {
    // The two disagree only for a routine, and this is the case that tells the
    // two rules apart: `r-held` has its own switch ON and still belongs at the
    // bottom, because it is not carrying anything. Rank on localOn instead and
    // this test is the one that fails.
    const rows = build(
      [routine('r-held'), routine('r-free')],
      [season('p-off', { state: 'paused', routineIds: ['r-held'] })]
    );
    expect(rows.map((r) => r.id)).toEqual(['r-free', 'p-off', 'r-held']);
    expect(row(rows, 'r-held').localOn).toBe(true);
  });
});
