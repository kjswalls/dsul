import { describe, it, expect, beforeEach } from 'vitest';
import { sessionUserFrom, useSessionUserStore } from '@/lib/session-user-store';

describe('sessionUserFrom', () => {
  it('prefers full_name over name', () => {
    const u = sessionUserFrom({ id: 'u', user_metadata: { full_name: 'Full', name: 'Short' } });
    expect(u.displayName).toBe('Full');
  });

  // A behaviour change from the widgets' `full_name ?? name`, which rendered an
  // empty-string full_name as an empty label.
  it.each(['', '   '])('falls back to name when full_name is blank (%j)', (blank) => {
    const u = sessionUserFrom({ id: 'u', user_metadata: { full_name: blank, name: 'Short' } });
    expect(u.displayName).toBe('Short');
  });

  it('prefers avatar_url over picture, and falls back to picture', () => {
    expect(
      sessionUserFrom({ id: 'u', user_metadata: { avatar_url: 'a', picture: 'p' } }).avatarUrl
    ).toBe('a');
    expect(sessionUserFrom({ id: 'u', user_metadata: { picture: 'p' } }).avatarUrl).toBe('p');
  });

  it('tolerates a bare { id }', () => {
    expect(sessionUserFrom({ id: 'u' })).toEqual({
      id: 'u',
      email: null,
      displayName: null,
      avatarUrl: null,
    });
  });
});

describe('useSessionUserStore', () => {
  const base = { id: 'u', email: 'u@example.com', displayName: 'U', avatarUrl: 'a' };

  beforeEach(() => {
    useSessionUserStore.setState({ user: null });
  });

  it('does not notify on a field-equal setUser, and does on a changed avatar', () => {
    useSessionUserStore.getState().setUser({ ...base });
    let calls = 0;
    const unsub = useSessionUserStore.subscribe(() => {
      calls += 1;
    });
    useSessionUserStore.getState().setUser({ ...base });
    expect(calls).toBe(0);
    useSessionUserStore.getState().setUser({ ...base, avatarUrl: 'b' });
    expect(calls).toBe(1);
    expect(useSessionUserStore.getState().user?.avatarUrl).toBe('b');
    unsub();
  });

  it('does not notify on clear() when already null', () => {
    let calls = 0;
    const unsub = useSessionUserStore.subscribe(() => {
      calls += 1;
    });
    useSessionUserStore.getState().clear();
    expect(calls).toBe(0);
    useSessionUserStore.getState().setUser({ ...base });
    useSessionUserStore.getState().clear();
    expect(calls).toBe(2);
    expect(useSessionUserStore.getState().user).toBeNull();
    unsub();
  });
});
