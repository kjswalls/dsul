import { describe, it, expect, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { AtlasSurface, atlasSpaceHeld } from '@/components/views/atlas/atlas-surface';

/**
 * Space+drag pans the board, and a card row's drag stands down while Space is
 * held (atlas-row.tsx reads `atlasSpaceHeld`), so the pan never runs under a
 * live drag. The flag follows the surface's own.
 */
afterEach(cleanup);

describe('atlasSpaceHeld', () => {
  it('follows Space on the board, and drops on blur and on unmount', () => {
    const view = render(
      <AtlasSurface rootRef={createRef<HTMLDivElement>()}>
        <div />
      </AtlasSurface>
    );
    expect(atlasSpaceHeld()).toBe(false);
    fireEvent.keyDown(window, { code: 'Space' });
    expect(atlasSpaceHeld()).toBe(true);
    fireEvent.keyUp(window, { code: 'Space' });
    expect(atlasSpaceHeld()).toBe(false);
    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.blur(window);
    expect(atlasSpaceHeld()).toBe(false);
    fireEvent.keyDown(window, { code: 'Space' });
    view.unmount();
    expect(atlasSpaceHeld()).toBe(false);
  });
});
