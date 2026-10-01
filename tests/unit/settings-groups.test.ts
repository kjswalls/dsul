import { describe, it, expect, afterEach } from 'vitest';
import { SETTINGS, settingById, type SettingRecord } from '@/lib/settings/manifest';
import { paneRows } from '@/lib/settings/search';
import {
  groupPaneRows,
  rootOf,
  ancestorsOf,
  type ChipSpec,
  type PaneGroup,
} from '@/lib/settings/groups';

/**
 * The grouping rules behind the Rituals chips, pinned on the real manifest.
 *
 * Every assertion here is about SHAPE: nothing in groups.ts names an id, so a
 * dependent's place on screen follows from its control kind and its place in
 * the dependsOn graph. These are the cases that decide whether a new record
 * lands as a chip, as a row, or nowhere at all.
 */

const ids = (chips: ChipSpec[]) =>
  chips.map((c) => (c.kind === 'merged' ? `${c.toggle.id}+${c.value.id}` : c.record.id));

const groupOf = (groups: PaneGroup[], id: string) => groups.find((g) => g.parent.id === id);

/** A throwaway record, only ever passed straight to groupPaneRows. */
function rec(id: string, control: SettingRecord['control'], dependsOn?: string): SettingRecord {
  return {
    id,
    pane: 'rituals',
    label: id,
    control,
    dependsOn,
    keywords: [],
    read: () => true,
    write: () => {},
    defaultValue: true,
  };
}

describe('Rituals', () => {
  const groups = groupPaneRows(paneRows('rituals').rows);

  it('starts a group at every root, in manifest order', () => {
    expect(groups.map((g) => g.parent.id)).toEqual([
      'rituals.morningCheck',
      'rituals.eod',
      'rituals.reminders',
      'rituals.stakes',
      'rituals.push',
    ]);
  });

  it('merges each switch-plus-value pair into one chip, under its ROOT', () => {
    // Both pairs are grandchildren: the merge happens one level down, but the
    // chip still renders under the top of the chain.
    const morning = groupOf(groups, 'rituals.morningCheck')!;
    expect(morning.mode).toBe('chips');
    expect(ids((morning as Extract<PaneGroup, { mode: 'chips' }>).chips)).toEqual([
      'rituals.autoAge+rituals.autoAgeDays',
    ]);

    const reminders = groupOf(groups, 'rituals.reminders')!;
    expect(reminders.mode).toBe('chips');
    expect(ids((reminders as Extract<PaneGroup, { mode: 'chips' }>).chips)).toEqual([
      'rituals.lastCall+rituals.lastCallTime',
    ]);
  });

  it('draws a lone time and an action as single chips', () => {
    const eod = groupOf(groups, 'rituals.eod') as Extract<PaneGroup, { mode: 'chips' }>;
    expect(ids(eod.chips)).toEqual(['rituals.eodTime']);

    const stakes = groupOf(groups, 'rituals.stakes') as Extract<PaneGroup, { mode: 'chips' }>;
    expect(ids(stakes.chips)).toEqual(['rituals.stakesTime', 'rituals.ledger']);
  });

  it('leaves a root with no dependents a plain row', () => {
    expect(groupOf(groups, 'rituals.push')!.mode).toBe('row');
  });

  it('places every pane row exactly once', () => {
    const placed = groups.flatMap((g) => [
      g.parent.id,
      ...(g.mode === 'row' ? [] : g.descendants.map((d) => d.id)),
    ]);
    expect(placed.sort()).toEqual(paneRows('rituals').rows.map((r) => r.id).sort());
  });
});

describe('extension panes', () => {
  it('draw text and credential fields as ROWS under the toggle, never chips', () => {
    const groups = groupPaneRows(paneRows('extensions/beeminder').rows);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.parent.id).toBe('extensions.beeminder');
    expect(group.mode).toBe('rows');
    expect((group as Extract<PaneGroup, { mode: 'rows' }>).descendants.map((d) => d.id)).toEqual([
      'extensions.beeminder.username',
      'extensions.beeminder.goals',
      'extensions.beeminder.authToken',
    ]);
  });
});

describe('rules from shape, not from ids', () => {
  it('a text, info or keys dependent forces rows', () => {
    for (const kind of ['text', 'info', 'keys'] as const) {
      const [group] = groupPaneRows([rec('p', 'switch'), rec('c', kind, 'p')]);
      expect(group.mode, kind).toBe('rows');
    }
  });

  it('a switch that cannot merge forces rows rather than becoming a chip', () => {
    // A bare switch, and a switch with two dependents, are both outside the
    // allowlist — "Off" on a chip would hide more than one setting.
    expect(groupPaneRows([rec('p', 'switch'), rec('s', 'switch', 'p')])[0].mode).toBe('rows');
    expect(
      groupPaneRows([
        rec('p', 'switch'),
        rec('s', 'switch', 'p'),
        rec('a', 'time', 's'),
        rec('b', 'enum', 's'),
      ])[0].mode
    ).toBe('rows');
  });

  it('does not merge a value that has dependents of its own', () => {
    const [group] = groupPaneRows([
      rec('p', 'switch'),
      rec('s', 'switch', 'p'),
      rec('v', 'enum', 's'),
      rec('t', 'time', 'v'),
    ]);
    expect(group.mode).toBe('rows');
  });

  it('a new switch-plus-time under any root merges without a line naming it', () => {
    const [group] = groupPaneRows([rec('p', 'switch'), rec('s', 'switch', 'p'), rec('t', 'time', 's')]);
    expect(group.mode).toBe('chips');
    expect(ids((group as Extract<PaneGroup, { mode: 'chips' }>).chips)).toEqual(['s+t']);
  });

  it('an orphan whose parent is not in the rows is its own plain row', () => {
    // A parent dropped as advanced, or desktop-only on a phone, must not take
    // its dependent off the screen with it.
    const groups = groupPaneRows([rec('c', 'time', 'gone')]);
    expect(groups).toEqual([{ mode: 'row', parent: expect.objectContaining({ id: 'c' }) }]);
  });

  it('stops on a dependsOn cycle and still draws every member', () => {
    const groups = groupPaneRows([rec('a', 'switch', 'b'), rec('b', 'switch', 'a')]);
    expect(groups.map((g) => g.parent.id).sort()).toEqual(['a', 'b']);
  });
});

describe('lookups', () => {
  const injected: SettingRecord[] = [];
  afterEach(() => {
    for (const r of injected.splice(0)) SETTINGS.splice(SETTINGS.indexOf(r), 1);
  });

  it('rootOf walks to the top of the chain', () => {
    expect(rootOf('rituals.autoAgeDays')).toBe('rituals.morningCheck');
    expect(rootOf('rituals.lastCallTime')).toBe('rituals.reminders');
    expect(rootOf('rituals.eodTime')).toBe('rituals.eod');
    expect(rootOf('rituals.push')).toBe('rituals.push');
  });

  it('ancestorsOf stops on a cycle in the real lookup', () => {
    const a = rec('test.cycleA', 'switch', 'test.cycleB');
    const b = rec('test.cycleB', 'switch', 'test.cycleA');
    injected.push(a, b);
    SETTINGS.push(a, b);
    expect(settingById('test.cycleA')).toBe(a);
    expect(ancestorsOf(a).map((r) => r.id)).toEqual(['test.cycleB']);
    expect(rootOf('test.cycleA')).toBe('test.cycleB');
  });
});
