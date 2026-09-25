import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

/**
 * A shut bucket says "full, folded" with a faint peek of its titles in the
 * caption — not with an empty 8px sliver of card under it, which read as an
 * empty container. See "WHAT A SHUT BUCKET SHOWS" in bucket-card.tsx.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { BucketCard } from '@/components/primitives/bucket-card';
import { useViewStore } from '@/lib/view-store';

const PEEK = ['Groceries', 'Call mom', 'Stretch'];

function card(props: Partial<React.ComponentProps<typeof BucketCard>> = {}) {
  return render(
    <BucketCard bucket="anytime" count={3} peek={PEEK} {...props}>
      <div data-testid="rows">rows</div>
    </BucketCard>
  );
}

beforeEach(() => {
  useViewStore.setState({ collapsedBuckets: ['anytime'] });
});
afterEach(() => {
  cleanup();
  useViewStore.setState({ collapsedBuckets: [] });
});

describe('BucketCard — shut', () => {
  it('draws the titles as one line in the caption and nothing under it', () => {
    const { container, getByTestId, queryByTestId } = card();
    const section = container.querySelector('section')!;
    expect(getByTestId('bucket-peek').textContent).toBe('Groceries · Call mom · Stretch');
    // Only the caption: no card, no sliver, no rows.
    expect(Array.from(section.children).map((c) => c.tagName)).toEqual(['HEADER']);
    expect(queryByTestId('rows')).toBeNull();
  });

  it('keeps the peek out of the tab order and the accessibility tree', () => {
    const { getByTestId } = card();
    const peek = getByTestId('bucket-peek');
    expect(peek.getAttribute('tabindex')).toBe('-1');
    expect(peek.getAttribute('aria-hidden')).toBe('true');
    expect(getByTestId('bucket-toggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens when the peek is clicked', () => {
    const { getByTestId, queryByTestId } = card();
    fireEvent.click(getByTestId('bucket-peek'));
    expect(useViewStore.getState().collapsedBuckets).not.toContain('anytime');
    expect(queryByTestId('bucket-peek')).toBeNull();
    expect(getByTestId('rows')).toBeTruthy();
  });

  it('drops the peek under a drag, when the landing slot is open instead', () => {
    const { queryByTestId } = card({ dragging: true });
    expect(queryByTestId('bucket-peek')).toBeNull();
  });

  it('shows no peek on an empty bucket, which cannot be shut', () => {
    const { queryByTestId } = card({ isEmpty: true, count: 0, peek: [] });
    expect(queryByTestId('bucket-peek')).toBeNull();
    expect(queryByTestId('bucket-toggle')).toBeNull();
  });
});

describe('BucketCard — open', () => {
  it('never shows the peek', () => {
    useViewStore.setState({ collapsedBuckets: [] });
    const { queryByTestId, getByTestId } = card();
    expect(queryByTestId('bucket-peek')).toBeNull();
    expect(getByTestId('rows')).toBeTruthy();
  });
});
