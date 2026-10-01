'use client';

import { create } from 'zustand';

/**
 * Who the signed-in account IS, for the chrome that shows it — the sidebar's
 * user card and the mobile profile menu.
 *
 * DISPLAY ONLY. NEVER AN AUTHORIZATION INPUT. This is copied off the session
 * Supabase keeps in browser storage (getSession / onAuthStateChange), which is
 * not server-validated the way `auth.getUser()` is. A name, initials and an
 * avatar are fine to take from it; a decision about what someone may read or
 * write is not — RLS, proxy.ts and each API route's own getUser are where
 * access is enforced, and they stay that way.
 *
 * Why it exists: each widget used to call `getUser()` in its own mount effect,
 * one GET /auth/v1/user per widget per load, all in the cold-start burst. The
 * provider already holds the user it adopts, so it stamps it here once
 * (supabase-provider.tsx `adoptUser`) and every surface reads the same copy.
 *
 * NOT persist()ed and deliberately NOT in lib/local-state.ts's registry: it
 * starts at null on every load, so there is nothing in this browser for the
 * next person to inherit. An account switch replaces it in the same tick as the
 * planner wipe; SIGNED_OUT clears it.
 */
export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** The subset of a Supabase `User` this reads — a bare `{ id }` is tolerated. */
type UserLike = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

/** A non-blank string, trimmed, or null. Blank metadata falls through. */
const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};

/**
 * `full_name` beats `name`, `avatar_url` beats `picture` — the precedence the
 * widgets had. One change from them: a BLANK `full_name` now falls through to
 * `name` (and then to the email in the label) instead of rendering an empty
 * label.
 */
export function sessionUserFrom(user: UserLike): SessionUser {
  const meta = user.user_metadata ?? {};
  return {
    id: user.id,
    email: str(user.email),
    displayName: str(meta.full_name) ?? str(meta.name),
    avatarUrl: str(meta.avatar_url) ?? str(meta.picture),
  };
}

const sameUser = (a: SessionUser | null, b: SessionUser | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.avatarUrl === b.avatarUrl);

interface SessionUserStore {
  user: SessionUser | null;
  /** No-op when field-equal: Supabase re-emits SIGNED_IN on every tab focus. */
  setUser: (user: SessionUser) => void;
  /** No-op when already null. */
  clear: () => void;
}

export const useSessionUserStore = create<SessionUserStore>()((set, get) => ({
  user: null,
  setUser: (user) => {
    if (sameUser(get().user, user)) return;
    set({ user });
  },
  clear: () => {
    if (get().user === null) return;
    set({ user: null });
  },
}));
