import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/**
 * The deep-link pages during the look-only preview.
 *
 * The preview is only ever applied on `/`, but the load is per account, not
 * per route: a client navigation from `/` (the palette, an omnibar result,
 * "Open as page", Back) lands on /item or /goal while the store still holds
 * the CACHED rows. Both pages edit in place — the item page's inline editor
 * autosaves — so neither may find its entity until the planner has settled.
 * Until then each reads "Loading…", exactly as during a cold load.
 *
 * The container pages make the same promise in container-page.test.tsx.
 */

const params = vi.hoisted(() => ({ current: { id: 'item-1' } as Record<string, string> }));
vi.mock('next/navigation', () => ({
  useParams: () => params.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/x/${params.current.id}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/db', () => ({ fetchItemEvents: vi.fn(async () => []) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
// The editor is a dynamic chunk, and the sections are their own suites' business:
// what is under test is whether the page finds its entity at all.
vi.mock('next/dynamic', () => ({
  default: () =>
    function EditorStub() {
      return <div data-testid="item-editor-stub" />;
    },
}));
vi.mock('@/components/planner/item-detail-sections', () => ({
  ItemDetailSections: () => <div data-testid="item-sections-stub" />,
  ItemThread: () => null,
}));
vi.mock('@/components/planner/goal-sections', () => ({
  CheckinHistory: () => null,
  GoalMemberGroups: () => null,
  GoalMemberNote: () => null,
  GoalSummary: () => <div data-testid="goal-summary-stub" />,
  MilestoneTimeline: () => null,
}));

import ItemPage from '@/app/item/[id]/page';
import GoalPage from '@/app/goal/[id]/page';
import { usePlannerStore } from '@/lib/planner-store';
import { EXT_GOALS } from '@/lib/extension-registry';
import { enableExtensions } from './support/extensions';
import type { Goal, Item } from '@/lib/planner-types';

const ITEM = {
  type: 'task',
  id: 'item-1',
  title: 'From last session',
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
} as Item;

const GOAL = {
  id: 'g1',
  name: 'Learn Chinese',
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
} as unknown as Goal;

const pristine = usePlannerStore.getState();

/** The entity is RIGHT THERE in the store — but only as the preview's cached copy. */
const seedPreview = () =>
  usePlannerStore.setState({
    userId: 'u1',
    isLoading: true,
    isPreview: true,
    error: null,
    items: [ITEM],
    tasks: [ITEM] as never,
    goals: [GOAL],
    userTimezone: 'UTC',
  });
const settle = () => act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  enableExtensions(EXT_GOALS);
});
afterEach(() => {
  cleanup();
  usePlannerStore.setState(pristine, true);
});

describe('/item/[id] during the preview', () => {
  beforeEach(() => {
    params.current = { id: 'item-1' };
  });

  it('reads Loading and mounts no editor over the cached row, then opens on the fresh one', () => {
    seedPreview();
    render(<ItemPage />);

    expect(heading()).toBe('Loading…');
    expect(screen.queryByTestId('item-page-editor')).toBeNull();
    expect(screen.queryByTestId('item-editor-stub')).toBeNull();

    settle();
    expect(screen.getByTestId('item-page-editor')).toBeInTheDocument();
    expect(screen.getByTestId('item-editor-stub')).toBeInTheDocument();
  });
});

describe('/goal/[id] during the preview', () => {
  beforeEach(() => {
    params.current = { id: 'g1' };
  });

  it('reads Loading over the cached goal, then opens once settled', () => {
    seedPreview();
    render(<GoalPage />);

    expect(heading()).toBe('Loading…');
    expect(screen.queryByTestId('goal-summary-stub')).toBeNull();

    settle();
    expect(screen.getByTestId('goal-summary-stub')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
