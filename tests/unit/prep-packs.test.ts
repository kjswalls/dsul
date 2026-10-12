import { describe, it, expect } from 'vitest';
import { packAction, packFromRow, packHref, packIsStale, packText, PackSchema } from '@/lib/prep-packs';

/** Prep packs (lib/prep-packs.ts): the shapes, and the one tap out of the app. */

describe('the shapes', () => {
  it('accept the four kinds and nothing else', () => {
    expect(PackSchema.safeParse({ kind: 'email', subject: 's', body: 'b' }).success).toBe(true);
    expect(PackSchema.safeParse({ kind: 'message', body: 'b' }).success).toBe(true);
    expect(PackSchema.safeParse({ kind: 'call', who: 'the dentist', script: ['hi'] }).success).toBe(true);
    expect(PackSchema.safeParse({ kind: 'steps', steps: ['a', 'b'] }).success).toBe(true);
    expect(PackSchema.safeParse({ kind: 'steps', steps: ['a'] }).success).toBe(false);
    expect(PackSchema.safeParse({ kind: 'booking', url: 'x' }).success).toBe(false);
  });

  it('drop a stored row that no longer fits', () => {
    const row = { item_id: 'a', made_for: 't', updated_at: 'u' };
    expect(packFromRow({ ...row, kind: 'message', body: { body: 'hi' } })?.pack).toEqual({ kind: 'message', body: 'hi' });
    expect(packFromRow({ ...row, kind: 'message', body: {} })).toBeNull();
  });

  it('read as stale once the item is renamed', () => {
    const stored = { itemId: 'a', pack: { kind: 'message' as const, body: 'hi' }, madeFor: 'text mum', updatedAt: 'u' };
    expect(packIsStale(stored, ' text mum ')).toBe(false);
    expect(packIsStale(stored, 'text dad')).toBe(true);
  });
});

describe('the tap out', () => {
  it('opens a mail draft, with the address only when it is one', () => {
    expect(packHref({ kind: 'email', to: 'sam@example.com', subject: 'The boiler', body: 'Hi & bye' })).toBe(
      'mailto:sam%40example.com?subject=The%20boiler&body=Hi%20%26%20bye'
    );
    expect(packHref({ kind: 'email', to: 'Sam, my landlord', subject: 's', body: 'b' })).toBe('mailto:?subject=s&body=b');
  });

  it('dials a number it was given, and only copies without one', () => {
    const call = { kind: 'call' as const, who: 'the dentist', script: ['hi'] };
    expect(packHref({ ...call, number: '(555) 010-2030' })).toBe('tel:5550102030');
    expect(packHref(call)).toBeNull();
    expect(packAction(call)).toBe('Copy script');
    expect(packAction({ ...call, number: '555 0102' })).toBe('Call');
  });

  it('copies as plain text', () => {
    expect(packText({ kind: 'steps', steps: ['open the form', 'fill page one'] })).toBe('1. open the form\n2. fill page one');
    expect(packText({ kind: 'email', subject: 's', body: 'b' })).toBe('Subject: s\n\nb');
  });
});
