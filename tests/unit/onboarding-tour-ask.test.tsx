import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The tour's words about Ask (components/onboarding/onboarding-tour.tsx).
 *
 * Ask starts closed (sidebar-store ASK_OPEN_DEFAULT). The tour shows it for
 * desktop sub-step C and puts it back when it ends, so step 4 is where a new
 * user learns the ways back to it, and they are pinned here:
 *
 *  - 3C, with AI: "Ask", what it is for, and the shell asked to show it.
 *  - 4, with AI on the desktop: the Ask button, the chord AS BOUND (through
 *    chordLabel, never typed; a rebinding reads right) and `?` in the dock.
 *  - 4 on the phone: the bar below, with no chord to press.
 *  - The phone's mode step names the third surface "Ask".
 *  - With no AI, none of that: the dock, and AI as optional.
 */

vi.mock('@/lib/user-profile', () => ({ setOnboardingComplete: vi.fn(async () => {}) }));
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

import { OnboardingTour } from '@/components/onboarding/onboarding-tour';
import { chordLabel } from '@/lib/commands/keys';
import { DEFAULT_SHORTCUTS, useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED, type SeedAI } from './helpers/ai-fixtures';

const DEFAULT_ASK_KEYS = DEFAULT_SHORTCUTS.find((b) => b.id === 'toggle_right_sidebar')!.keys;

let cleanupAI: (() => void) | null = null;
const width = window.innerWidth;

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}

function renderTour(seed: SeedAI) {
  cleanupAI = seedAI(seed);
  const onExpandChat = vi.fn();
  const onCollapseChat = vi.fn();
  render(
    <OnboardingTour
      userId="u1"
      onComplete={vi.fn()}
      onOpenSettings={vi.fn()}
      onExpandChat={onExpandChat}
      onCollapseChat={onCollapseChat}
      onSetActiveTab={vi.fn()}
    />
  );
  return { onExpandChat, onCollapseChat };
}

/** Welcome → skip the first task → step 3's first card. */
function toStep3() {
  fireEvent.click(screen.getByRole('button', { name: /Let.s go/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
}

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));

beforeEach(() => {
  setWidth(1280);
});

afterEach(() => {
  cleanup();
  cleanupAI?.();
  cleanupAI = null;
  useKeyboardShortcutsStore.setState({ overrides: {} });
  setWidth(width);
});

describe('the desktop tour, with AI', () => {
  it('shows Ask for 3C, then names every way back to it at step 4', () => {
    const { onExpandChat } = renderTour(CONNECTED_MODEL);
    toStep3();
    next(); // B
    next(); // C
    expect(screen.getByText('Ask', { selector: 'p' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask anything here, or open an item to talk about it. It knows your tasks, habits and projects.'
      )
    ).toBeInTheDocument();
    expect(onExpandChat).toHaveBeenCalled();

    next(); // 4
    expect(screen.getByText('Your AI is ready')).toBeInTheDocument();
    expect(chordLabel(DEFAULT_ASK_KEYS, false)).toBe('Ctrl+J');
    expect(
      screen.getByText(
        `Open Ask any time with the Ask button or ${chordLabel(DEFAULT_ASK_KEYS, false)}, or type ? in the dock, to ask about your day.`
      )
    ).toBeInTheDocument();
    // The ⌘↵ / Ctrl↵ hint is gone: ? in the dock is the way to ask from there.
    expect(screen.queryByText(/Ctrl↵|⌘↵/)).toBeNull();
  });

  it('names the chord as the user has it bound', () => {
    useKeyboardShortcutsStore.setState({ overrides: { toggle_right_sidebar: ['meta', 'shift', 'k'] } });
    renderTour(CONNECTED_MODEL);
    toStep3();
    next();
    next();
    next();
    expect(
      screen.getByText(
        'Open Ask any time with the Ask button or Ctrl+Shift+K, or type ? in the dock, to ask about your day.'
      )
    ).toBeInTheDocument();
  });
});

describe('the desktop tour, with no AI', () => {
  it('points 3C at the dock and calls AI optional, with no word of Ask', () => {
    const { onExpandChat } = renderTour(NOTHING_CONNECTED);
    toStep3();
    next();
    next();
    expect(screen.getByText('Your dock')).toBeInTheDocument();
    expect(onExpandChat).not.toHaveBeenCalled();
    next();
    expect(screen.getByText('Bring your own AI (optional)')).toBeInTheDocument();
    expect(screen.queryByText(/Ask button|Ctrl\+J/)).toBeNull();
  });
});

describe('the phone tour', () => {
  beforeEach(() => setWidth(390));

  it('names the third surface Ask, and step 4 points at the bar below', () => {
    renderTour(CONNECTED_MODEL);
    toStep3();
    expect(
      screen.getByText('The mode button in the dock is how you move between Braindump, Today and Ask.')
    ).toBeInTheDocument();
    next(); // B
    next(); // 4
    expect(screen.getByText('Type in the bar below to ask about your day.')).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl|⌘|Ask button/)).toBeNull();
  });

  it('with no AI, names only Braindump and Today', () => {
    renderTour(NOTHING_CONNECTED);
    toStep3();
    expect(
      screen.getByText('The mode button in the dock is how you move between Braindump and Today.')
    ).toBeInTheDocument();
  });
});
