import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import {
  IDENTICAL_TOL,
  MIN_HOST_FREE_FRAC,
  MIN_HOST_FREE_MIN,
  NOMINAL_FIELD,
  planOverlaps,
  type BandLength,
  type OverlapEntry,
  type OverlapPlan,
} from '@/lib/schedule-overlap';
import {
  BAND_COMFORT,
  COL_GAP,
  HOUR_PX,
  LANE_PX,
  LINE_H,
  MAX_DEPTH_DAY,
  MIN_CHANNEL_PX,
  NEST_PX,
  NEST_RIGHT_PX,
  PANE_MIN_H,
  PANE_OFFSET,
  PANE_TALL_H,
  PANE_TRIM,
  PANE_WRAP_PX,
  SHINGLE_PX,
} from '@/lib/schedule-constants';
import { ECLIPSE_PX } from '@/components/views/day-schedule';

/**
 * The overlap pass, shared with the iPhone.
 *
 * lib/schedule-overlap.ts `planOverlaps` decides where overlapping schedule
 * blocks go: clusters on painted extents, then for Day containment (up to
 * MAX_DEPTH_DAY), first-fit columns capped by MIN_CHANNEL_PX and tiles for a
 * genuine double booking, and for Week the shingle. Every case is built here,
 * run through the real TS, and written with its answer to
 * tests/fixtures/day/overlap.json; DsulCore's OverlapFixtureTests.swift reads
 * the same file and asserts ScheduleOverlap.swift answers identically.
 *
 * A case is the pass's input as the phone gives it: 75pt an hour, a grid from
 * midnight, a phone's Day field width (none for Week, which never caps), and
 * the entries in the order the grid draws them (deriveTimedEntries' order,
 * which is the pass's paint order). `expected` carries only the subset the
 * phone draws (design §5.3): depth, the band, the pane margins, the rail and
 * bead, z, the width fraction, the content band and the two grip lanes, one
 * row per planned block in the TS's order. A block with no row is not laid
 * out: it draws as a lone block does (the whole field, a 12pt lane). Hover,
 * wash, glass, pockets and branch ticks are the web's alone and are not
 * written, so a web-only change to them moves nothing here. `constants` pins
 * every web number ScheduleMath.swift copies: the pass's and the pane's, the
 * narrow pane's PANE_WRAP_PX and the now marker's ECLIPSE_PX.
 *
 * Every length is `{ pct, px }`: pct percent of the box it resolves against,
 * plus px. `left` and `right` resolve against the field; `paneLeft`,
 * `paneRight`, `railX` and `beadX` against the block's own band.
 *
 * This test fails when the committed file no longer matches what the TS says.
 * Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/overlap-fixtures.test.ts
 *
 * then commit the JSON together with the Swift change that keeps the port in
 * step. Never hand-edit the JSON: the inputs live here.
 */

const DIR = path.resolve(__dirname, '../fixtures/day');

/** Entry n → a fixed, valid v4-shaped uuid, as the phone's item ids are. The
 *  pass breaks ties on the id string, so a tie's order is the uuids'. */
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const HM = (h: number, m = 0) => h * 60 + m;
const e = (n: number, startMin: number, duration: number, projectBlock: string | null = null): OverlapEntry => ({
  id: uid(n),
  startMin,
  duration,
  projectBlock,
});

/** A phone's Day field (the grid right of the gutter: the screen less the
 *  52pt gutter and the 8pt right margin), one width for each answer a phone
 *  can get. The pass counts channels on each AREA's own width, and two need
 *  280pt: the root's area is the field less its 4pt right inset (two from
 *  284), a nest's is 26pt narrower again (14 left, 8 right: two from 306), and
 *  a nest inside a nest 48pt (two from 328). So 280pt carries one channel
 *  everywhere; 300pt two at the root and one in any nest; 315pt, a 375pt
 *  phone's field (the SE, the mini, Display Zoom, or a 393pt phone whose
 *  gutter grew with the text), two at the root and in a nest but one in a
 *  nest's nest; and 330pt, a 393pt phone's, two everywhere. A wider phone
 *  answers as 330 does until 424pt (three at the root), which none reaches. */
const PHONE_FIELDS = [280, 300, 315, 330];

type PlannedRow = {
  id: string;
  depth: number;
  left: BandLength;
  right: BandLength;
  paneLeft: BandLength;
  paneRight: BandLength;
  railX: BandLength;
  beadX: BandLength;
  z: number;
  widthFraction: number;
  contentTop: number | null;
  contentHeight: number | null;
  handleTopLane: boolean;
  handleBottomLane: boolean;
};

type OverlapCase = {
  name: string;
  variant: 'day' | 'week';
  hourPx: number;
  gridStartMin: number;
  fieldWidth: number | null;
  entries: OverlapEntry[];
  expected: PlannedRow[];
};

type OverlapFixture = { constants: Record<string, number>; cases: OverlapCase[] };

const row = (id: string, p: OverlapPlan): PlannedRow => ({
  id,
  depth: p.depth,
  left: p.left,
  right: p.right,
  paneLeft: p.paneLeft,
  paneRight: p.paneRight,
  railX: p.railX,
  beadX: p.beadX,
  z: p.z,
  widthFraction: p.widthFraction,
  contentTop: p.contentTop,
  contentHeight: p.contentHeight,
  handleTopLane: p.handleTopLane,
  handleBottomLane: p.handleBottomLane,
});

function run(name: string, variant: 'day' | 'week', fieldWidth: number | null, entries: OverlapEntry[]): OverlapCase {
  const options = { hourPx: HOUR_PX, gridStartMin: 0, variant, fieldWidth };
  return {
    name,
    variant,
    hourPx: HOUR_PX,
    gridStartMin: 0,
    fieldWidth,
    entries,
    expected: [...planOverlaps(entries, options)].map(([id, p]) => row(id, p)),
  };
}

const five = [0, 1, 2, 3, 4].map((i) => e(i + 1, HM(10) + i * 15, 180));

/** Day: each at every phone field width. */
const DAY_CASES: [string, OverlapEntry[]][] = [
  ['solo', [e(1, HM(9), 60)]],
  ['two apart', [e(1, HM(9), 60), e(2, HM(13), 60)]],
  ['crossing', [e(1, HM(10), 120), e(2, HM(11), 120)]],
  ['nested', [e(1, HM(9), 180), e(2, HM(10), 60)]],
  ['nested, flush top', [e(1, HM(9), 180), e(2, HM(9), 60)]],
  ['nested, flush bottom', [e(1, HM(9), 180), e(2, HM(11), 60)]],
  ['too little room to host', [e(1, HM(9), 60), e(2, HM(9, 10), 45)]],
  ['two deep', [e(1, HM(8), 480), e(2, HM(9), 240), e(3, HM(10), 60)]],
  ['three deep, demoted', [e(1, HM(8), 600), e(2, HM(9), 420), e(3, HM(10), 240), e(4, HM(11), 60)]],
  // Crossings packed inside a nest, on the nest's own width: one level down
  // they get two channels from 306pt, two levels down from 328pt.
  ['crossing inside a host', [e(1, HM(9), 360), e(2, HM(10), 120), e(3, HM(11), 120)]],
  ['crossing two deep', [e(1, HM(8), 720), e(2, HM(9), 480), e(3, HM(10), 120), e(4, HM(11), 120)]],
  // Drawn b before a: the tiles go in id order, never the drawing order.
  ['double booked', [e(0xb, HM(9), 60), e(0xa, HM(9), 60)]],
  ['double booked, three', [e(3, HM(9), 60), e(1, HM(9), 60), e(2, HM(9), 60)]],
  ['double booked within two minutes', [e(1, HM(9), 60), e(2, HM(9, 2), 59)]],
  ['three minutes apart is a crossing', [e(1, HM(9), 60), e(2, HM(9, 3), 57)]],
  ['a project block group', [e(3, HM(18), 60, 'Gym'), e(1, HM(18), 60, 'Gym'), e(2, HM(18), 60, 'Gym')]],
  ['a project block beside a block', [e(1, HM(18), 60, 'Gym'), e(2, HM(18), 60, 'Gym'), e(3, HM(18, 30), 60)]],
  ['two project blocks at one time', [e(1, HM(10), 60, 'Gym'), e(2, HM(10), 60, 'Work')]],
  ['three-way crossing', [e(1, HM(10), 120), e(2, HM(11), 120), e(3, HM(11, 30), 120)]],
  ['five crossing', five],
  ['two quarters back to back', [e(1, HM(9), 15), e(2, HM(9, 15), 15)]],
  [
    'four quarters back to back',
    [e(1, HM(9), 15), e(2, HM(9, 15), 15), e(3, HM(9, 30), 15), e(4, HM(9, 45), 15)],
  ],
  ['a quarter inside an hour', [e(1, HM(9), 60), e(2, HM(9, 30), 15)]],
  ['a host holding a double booking', [e(1, HM(10), 420), e(2, HM(11), 60), e(3, HM(11), 60)]],
  ['a double booking cannot host', [e(1, HM(9), 180), e(2, HM(9), 180), e(3, HM(10), 60)]],
  // A stored length of 0 reaches the pass as 0 (deriveTimedEntries keeps it):
  // its painted extent is the pane floor's, and it has no length of its own
  // for the containment and double-booking tests to read.
  ['a zero-minute block inside an hour', [e(1, HM(9), 60), e(2, HM(9, 30), 0)]],
  ['two zero-minute blocks at one time', [e(1, HM(14), 0), e(2, HM(14), 0)]],
  // Painted past midnight: nothing clamps the extent at 1440.
  ['past midnight', [e(1, HM(23, 30), 60), e(2, HM(23, 45), 30)]],
  [
    'a full morning',
    [
      e(1, HM(7), 30),
      e(2, HM(9), 120),
      e(3, HM(10), 15),
      e(4, HM(10), 30),
      e(5, HM(12), 60),
      e(6, HM(13), 60),
      e(7, HM(13, 30), 90),
    ],
  ],
];

/** Week: no field width, as the web's week passes none. */
const WEEK_CASES: [string, OverlapEntry[]][] = [
  ['crossing', [e(1, HM(10), 120), e(2, HM(11), 120)]],
  ['nested', [e(1, HM(9), 180), e(2, HM(10), 60)]],
  ['double booked', [e(0xb, HM(9), 60), e(0xa, HM(9), 60)]],
  ['four stepped', [e(1, HM(9), 240), e(2, HM(9, 30), 120), e(3, HM(10), 60), e(4, HM(10, 15), 30)]],
  ['a project block group', [e(1, HM(18), 60, 'Gym'), e(2, HM(18), 60, 'Gym')]],
  ['two quarters back to back', [e(1, HM(9), 15), e(2, HM(9, 15), 15)]],
];

function buildOverlap(): OverlapFixture {
  return {
    constants: {
      HOUR_PX,
      LANE_PX,
      PANE_OFFSET,
      PANE_TRIM,
      PANE_MIN_H,
      PANE_TALL_H,
      COL_GAP,
      NEST_PX,
      NEST_RIGHT_PX,
      LINE_H,
      BAND_COMFORT,
      SHINGLE_PX,
      MAX_DEPTH_DAY,
      MIN_CHANNEL_PX,
      MIN_HOST_FREE_MIN,
      MIN_HOST_FREE_FRAC,
      IDENTICAL_TOL,
      NOMINAL_FIELD_DAY: NOMINAL_FIELD.day,
      NOMINAL_FIELD_WEEK: NOMINAL_FIELD.week,
      PANE_WRAP_PX,
      ECLIPSE_PX,
    },
    cases: [
      ...DAY_CASES.flatMap(([name, entries]) =>
        PHONE_FIELDS.map((w) => run(`${name}, ${w}pt`, 'day', w, entries))
      ),
      ...WEEK_CASES.map(([name, entries]) => run(`week: ${name}`, 'week', null, entries)),
    ],
  };
}

const serialize = (f: unknown) => JSON.stringify(f, null, 2) + '\n';

/** A band's x extent in a field `w` wide, as the phone draws it. */
const at = (l: BandLength, w: number) => (l.pct / 100) * w + l.px;

describe('overlap fixtures shared with DsulCore', () => {
  const fixture = buildOverlap();
  const file = path.join(DIR, 'overlap.json');

  if (process.env.UPDATE_FIXTURES) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, serialize(fixture));
  }

  it('overlap.json exists', () => {
    expect(existsSync(file), `missing ${file}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('overlap.json has cases with unique names', () => {
    const names = fixture.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('overlap.json is what the TS answers today', () => {
    // On drift: if the TS change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore/Sources/DsulCore/.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(serialize(fixture)));
  });

  it('the cases reach every topology the phone draws', () => {
    const rows = fixture.cases.flatMap((c) => c.expected.map((r) => ({ c, r })));
    const day = rows.filter(({ c }) => c.variant === 'day');
    const week = rows.filter(({ c }) => c.variant === 'week');
    // Nothing to do: a lone block and two apart are not laid out.
    expect(fixture.cases.filter((c) => c.expected.length === 0).map((c) => c.name)).toEqual(
      expect.arrayContaining(['solo, 330pt', 'two apart, 330pt'])
    );
    // Nested, two deep, and never deeper.
    expect(day.some(({ r }) => r.depth === 1)).toBe(true);
    expect(day.some(({ r }) => r.depth === MAX_DEPTH_DAY)).toBe(true);
    expect(day.every(({ r }) => r.depth <= MAX_DEPTH_DAY)).toBe(true);
    // Tiles (a pane margin with a percentage) and the inset cascade (a stepped
    // plate at the root).
    expect(day.some(({ r }) => r.paneLeft.pct > 0)).toBe(true);
    expect(day.some(({ r }) => r.depth === 0 && r.z > 2)).toBe(true);
    // The grips' lanes and a re-anchored title.
    expect(day.some(({ r }) => r.handleTopLane)).toBe(true);
    expect(day.some(({ r }) => r.handleBottomLane)).toBe(true);
    expect(day.some(({ r }) => r.contentTop !== null)).toBe(true);
    // Week shingles by SHINGLE_PX, two steps at most, and tiles a double booking.
    expect(new Set(week.map(({ r }) => r.left.px))).toEqual(new Set([0, SHINGLE_PX, 2 * SHINGLE_PX]));
    expect(week.some(({ r }) => r.widthFraction === 0.5)).toBe(true);
  });

  it('a double booking tiles in id order, whatever order the grid draws it in', () => {
    const c = fixture.cases.find((x) => x.name === 'double booked, 330pt') as OverlapCase;
    expect(c.entries.map((x) => x.id)).toEqual([uid(0xb), uid(0xa)]);
    const tile = (n: number) => c.expected.find((r) => r.id === uid(n)) as PlannedRow;
    expect(tile(0xa).paneLeft).toEqual({ pct: 0, px: LANE_PX });
    expect(tile(0xb).paneLeft).toEqual({ pct: 50, px: LANE_PX });
  });

  it('back-to-back quarters never share a column on a phone wide enough for two', () => {
    for (const w of PHONE_FIELDS.filter((x) => x - 4 >= 2 * MIN_CHANNEL_PX)) {
      const c = fixture.cases.find((x) => x.name === `two quarters back to back, ${w}pt`) as OverlapCase;
      const [a, b] = c.expected;
      const ra = { l: at(a.left, w), r: w - at(a.right, w) };
      const rb = { l: at(b.left, w), r: w - at(b.right, w) };
      expect(ra.r <= rb.l || rb.r <= ra.l, `${w}pt`).toBe(true);
    }
  });
});
