import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SectionBoundary } from '@/components/primitives/section-boundary';

/**
 * #74: one bad render no longer blanks the app. A region of the shell fails on
 * its own and offers a way back; the page and the layout each have a boundary
 * behind it.
 */

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error('boom');
  return <p>grid</p>;
}

afterEach(() => {
  cleanup();
  shouldThrow = true;
  vi.restoreAllMocks();
});

describe('SectionBoundary', () => {
  it('catches a throw in its region and leaves its siblings rendered', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <SectionBoundary label="view">
          <Flaky />
        </SectionBoundary>
        <p>braindump</p>
      </div>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The view hit a problem');
    expect(screen.getByText('braindump')).toBeInTheDocument();
  });

  it('Try again re-renders the region', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <SectionBoundary label="view">
        <Flaky />
      </SectionBoundary>
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('grid')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a new resetKey clears the caught error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <SectionBoundary label="view" resetKey="day:list">
        <Flaky />
      </SectionBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <SectionBoundary label="view" resetKey="week:list">
        <Flaky />
      </SectionBoundary>
    );

    expect(screen.getByText('grid')).toBeInTheDocument();
  });

  it('renders its children untouched when nothing throws', () => {
    shouldThrow = false;
    const { container } = render(
      <SectionBoundary label="view">
        <Flaky />
      </SectionBoundary>
    );
    expect(container.innerHTML).toBe('<p>grid</p>');
  });
});

describe('where the boundaries sit', () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

  it('the page and the layout each have one', () => {
    expect(existsSync(path.join(process.cwd(), 'app/error.tsx'))).toBe(true);
    const global = read('app/global-error.tsx');
    // It replaces the document, so it must bring its own.
    expect(global).toMatch(/<html/);
    expect(global).toMatch(/<body/);
  });

  it('the desktop shell wraps the view, the braindump and the rail separately', () => {
    const shell = read('components/shell/desktop-shell.tsx');
    expect(shell).toMatch(/<SectionBoundary[^>]*resetKey=\{viewKey\}>\s*<ViewRouter \/>/);
    expect(shell).toMatch(/<SectionBoundary label="braindump"[^>]*>\s*<Sidebar \/>/);
    expect(shell).toMatch(/<SectionBoundary label="Ask panel"[^>]*>\s*<RightRail /);
  });

  it('the phone wraps each tab body', () => {
    expect(read('components/shell/mobile-shell.tsx')).toMatch(/<SectionBoundary label=\{activeTab/);
  });
});
