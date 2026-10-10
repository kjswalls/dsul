import { describe, it, expect } from 'vitest';
import { SIZES, WALKED_SIZES, bySize, guessSize, itemSizeOf, nextUp, sizeForDigit } from '@/lib/item-size';

/**
 * The Do stuff extension's pure half: what a size is, how one is guessed, and
 * which row comes up next. The walk is the promise ("quick first, skip means
 * later"), so it is pinned here rather than through the sidebar.
 */

const row = (id: string, size?: string, open = true) => ({ item: { id, size }, open });
type Row = ReturnType<typeof row>;
const isOpen = (r: Row) => r.open;

describe('sizes', () => {
  it('has four sizes with distinct digits, walking all but fuzzy', () => {
    expect(SIZES.map((s) => s.key)).toEqual(['quick', 'errand', 'big', 'fuzzy']);
    expect(new Set(SIZES.map((s) => s.digit)).size).toBe(4);
    expect(WALKED_SIZES).not.toContain('fuzzy');
  });

  it('maps digits to sizes, 0 to clear, anything else to nothing', () => {
    expect(sizeForDigit('1')).toBe('quick');
    expect(sizeForDigit('4')).toBe('fuzzy');
    expect(sizeForDigit('0')).toBeNull();
    expect(sizeForDigit('9')).toBeUndefined();
  });

  it('reads an unknown stored size as unsized rather than trusting it', () => {
    expect(itemSizeOf({ size: 'errand' })).toBe('errand');
    expect(itemSizeOf({ size: 'huge' })).toBeUndefined();
    expect(itemSizeOf({})).toBeUndefined();
  });
});

describe('guessSize', () => {
  it.each([
    ['call the dentist', 'quick'],
    ['email Sam about Friday', 'quick'],
    ['pick up dry cleaning', 'errand'],
    ['buy batteries', 'errand'],
    ['plan the trip', 'big'],
    ['clean the garage', 'big'],
    ['figure out who to call', 'fuzzy'],
    ['new couch?', 'fuzzy'],
  ])('%s → %s', (title, size) => {
    expect(guessSize(title)).toBe(size);
  });

  it('says nothing when no rule speaks', () => {
    expect(guessSize('xylophone')).toBeUndefined();
    expect(guessSize('   ')).toBeUndefined();
  });
});

describe('the walk', () => {
  it('splits rows by size, keeping order and the unsized apart', () => {
    const rows = [row('a', 'big'), row('b'), row('c', 'quick'), row('d', 'big'), row('e', 'nope')];
    const { sized, unsized } = bySize(rows);
    expect(sized.big.map((r) => r.item.id)).toEqual(['a', 'd']);
    expect(sized.quick.map((r) => r.item.id)).toEqual(['c']);
    expect(unsized.map((r) => r.item.id)).toEqual(['b', 'e']);
  });

  it('walks quick, then errands, then big, and never hands up fuzzy', () => {
    const { sized } = bySize([row('f', 'fuzzy'), row('b', 'big'), row('e', 'errand'), row('q', 'quick', false)]);
    expect(nextUp(sized, isOpen, [])?.item.id).toBe('e');
    const fuzzyOnly = bySize([row('f', 'fuzzy')]).sized;
    expect(nextUp(fuzzyOnly, isOpen, [])).toBeUndefined();
  });

  it('passes over skipped rows, then brings them back in skip order', () => {
    const { sized } = bySize([row('q1', 'quick'), row('q2', 'quick'), row('b', 'big')]);
    expect(nextUp(sized, isOpen, ['q1'])?.item.id).toBe('q2');
    expect(nextUp(sized, isOpen, ['q1', 'q2'])?.item.id).toBe('b');
    expect(nextUp(sized, isOpen, ['q2', 'b', 'q1'])?.item.id).toBe('q2');
  });
});
