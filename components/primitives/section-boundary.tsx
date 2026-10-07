'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * One region of the shell that fails on its own (#74).
 *
 * Without it a throw in any render reaches app/error.tsx, which replaces the
 * whole page: a bad row in the week grid took the braindump, the rail and the
 * omnibar down with it. Wrapped, the canvas, the braindump and the right rail
 * each fail alone and the rest of the planner keeps working, so a capture in
 * the dock still lands while the grid is showing this.
 *
 * `resetKey` clears a caught error when it changes, so moving to another view
 * (or tab) is a way out as well as the button. Copy follows the app's rule for
 * failure: say what happened in plain words, blame no one, offer the next step.
 */
interface SectionBoundaryProps {
  /** What the person calls this part of the screen, for the message. */
  label: string;
  /** Changing it clears a caught error (e.g. the active view). */
  resetKey?: string | number;
  className?: string;
  children: ReactNode;
}

interface SectionBoundaryState {
  error: Error | null;
  resetKey: SectionBoundaryProps['resetKey'];
}

export class SectionBoundary extends Component<SectionBoundaryProps, SectionBoundaryState> {
  state: SectionBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<SectionBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: SectionBoundaryProps,
    state: SectionBoundaryState
  ): Partial<SectionBoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}] render failed:`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="section-error"
        className={cn(
          'flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center',
          this.props.className
        )}
      >
        <p className="text-sm text-foreground">The {this.props.label} hit a problem and couldn’t show.</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          The rest of the planner still works.
        </p>
        <Button variant="outline" size="sm" onClick={this.retry}>
          Try again
        </Button>
      </div>
    );
  }
}
