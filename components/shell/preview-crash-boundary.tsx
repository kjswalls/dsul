'use client';

import { Component, type ReactNode } from 'react';

import { usePlannerStore } from '@/lib/planner-store';
import { clearPlannerSnapshot, notePreviewThrew } from '@/lib/planner-snapshot';

interface CrashState {
  /** A flag, not `error !== null`: `throw null` (or 0, or '') must still count as a throw. */
  failed: boolean;
  error: unknown;
  /** The throw was not the preview's: hand it on, exactly as if this boundary weren't here. */
  rethrow: boolean;
}

const CLEAR: CrashState = { failed: false, error: null, rethrow: false };

/**
 * A cached planner must never be able to break the app.
 *
 * The look-only preview (lib/planner-snapshot.ts) renders the real views over
 * rows this browser saved last session. If those rows make a render throw — a
 * shape a newer build no longer expects that slipped past the format ledger —
 * every reload would crash the same way until the cache aged out, and the app
 * has no other error boundary to catch it.
 *
 * So, wrapped around AppShell: a throw WHILE PREVIEWING drops the preview
 * (`dropPreview`: data back to empty, `isLoading` still true, so the skeleton
 * shows until the fresh load lands normally) and deletes the snapshot, then
 * renders the shell again. Any other throw is not ours and is rethrown to the
 * next boundary up — today's behaviour, untouched.
 *
 * Bounded by construction: the retry renders with the preview gone, so a
 * second throw finds nothing to drop and is rethrown.
 *
 * What it cannot catch — a consumer above AppShell, a hang — is the per-tab
 * crash marker's job (markPreviewPending, consumed on the next read). Every
 * catch is also reported to it (notePreviewThrew): a page that has seen a
 * render throw never counts a preview as left cleanly, so its marker is never
 * removed on the way out.
 */
export class PreviewCrashBoundary extends Component<{ children: ReactNode }, CrashState> {
  state: CrashState = CLEAR;

  static getDerivedStateFromError(error: unknown): Partial<CrashState> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown) {
    notePreviewThrew();
    let dropped = false;
    try {
      dropped = usePlannerStore.getState().dropPreview();
    } catch {
      // A store that cannot drop is a throw that was not the preview's.
    }
    if (!dropped) {
      this.setState({ rethrow: true });
      return;
    }
    try {
      clearPlannerSnapshot();
    } catch {
      // It never throws by contract (lib/planner-snapshot.ts). Belt and braces:
      // recovering this page matters more than the copy on disk.
    }
    console.warn('[preview] the cached planner failed to render; dropped it and the snapshot', error);
    this.setState(CLEAR);
  }

  render() {
    if (this.state.failed) {
      if (this.state.rethrow) throw this.state.error;
      return null;
    }
    return this.props.children;
  }
}
