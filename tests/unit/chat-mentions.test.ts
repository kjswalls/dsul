import { describe, expect, it } from 'vitest';
import { activeMention, insertMention, mentionChoices, mentionedItemIds } from '@/lib/chat-mentions';
import type { Item } from '@/lib/planner-types';

// @ items in the chat box (step 2c): a mention is the words "@<title>", found
// again at send time; nothing rides beside the text.

const item = (over: Partial<Item>): Item =>
  ({ type: 'task', status: 'pending', isScheduled: false, order: 0, ...over }) as unknown as Item;

const ITEMS = [
  item({ id: 'a', title: 'Call mum' }),
  item({ id: 'b', title: 'Call mum back' }),
  item({ id: 'c', title: 'Recall notes' }),
  item({ id: 'd', title: 'Call the bank', status: 'completed' }),
  item({ id: 'e', title: 'Pack', parentItemId: 'z' } as never),
  item({ id: 'f', title: 'Floss', type: 'habit', status: 'done' } as never),
];

describe('activeMention', () => {
  it('finds the @ the caret is in, at the start or after a space', () => {
    expect(activeMention('@ca', 3)).toEqual({ start: 0, end: 3, query: 'ca' });
    expect(activeMention('move @call m', 12)).toEqual({ start: 5, end: 12, query: 'call m' });
  });

  it('is not a mention inside a word, across a line, or once the caret has left it', () => {
    expect(activeMention('me@home', 7)).toBeNull();
    expect(activeMention('@call\nthen', 10)).toBeNull();
    expect(activeMention('no at here', 5)).toBeNull();
  });
});

describe('mentionChoices', () => {
  it('ranks open, then title-start, then whole items, and leaves out a blank title', () => {
    expect(mentionChoices(ITEMS, 'call').map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(mentionChoices([...ITEMS, item({ id: 'x', title: '  ' })], '').map((i) => i.id)).toEqual(['a', 'b', 'f', 'c', 'e']);
  });

  it('keeps a habit whose day is ticked: its status is today, not finished', () => {
    expect(mentionChoices(ITEMS, 'flo').map((i) => i.id)).toEqual(['f']);
  });
});

describe('insertMention', () => {
  it('writes the title after the @ and puts the caret past a space', () => {
    const m = activeMention('move @ca to Monday', 8)!;
    expect(insertMention('move @ca to Monday', m, 'Call mum')).toEqual({ text: 'move @Call mum to Monday', caret: 15 });
    expect(insertMention('@ca', activeMention('@ca', 3)!, 'Call mum')).toEqual({ text: '@Call mum ', caret: 10 });
  });
});

describe('mentionedItemIds', () => {
  it('finds the longest title first, in the order the message names them', () => {
    expect(mentionedItemIds('@Call mum back, then @call mum', ITEMS)).toEqual(['b', 'a']);
  });

  it('needs the @ at a word start and the title to end at a word end', () => {
    expect(mentionedItemIds('x@Call mum', ITEMS)).toEqual([]);
    expect(mentionedItemIds('@Call mumble', ITEMS)).toEqual([]);
    expect(mentionedItemIds('no mention of Call mum', ITEMS)).toEqual([]);
  });

  it('prefers an open item when two share a title, and stops at five', () => {
    const twins = [item({ id: 'old', title: 'Dentist', status: 'completed' }), item({ id: 'new', title: 'Dentist' })];
    expect(mentionedItemIds('@Dentist', twins)).toEqual(['new']);
    const many = Array.from({ length: 7 }, (_, i) => item({ id: `m${i}`, title: `T${i}` }));
    expect(mentionedItemIds(many.map((m) => `@${m.title}`).join(' '), many)).toHaveLength(5);
  });
});
