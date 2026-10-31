import { afterEach, describe, expect, it } from 'vitest';
import { isPopperUp } from '@/lib/popper-up';

function mount(state: string | null) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-radix-popper-content-wrapper', '');
  const content = document.createElement('div');
  if (state) content.setAttribute('data-state', state);
  wrapper.appendChild(content);
  document.body.appendChild(wrapper);
  return wrapper;
}

describe('isPopperUp', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is false with no popper mounted', () => {
    expect(isPopperUp()).toBe(false);
  });

  it.each(['open', 'delayed-open', 'instant-open'])('is true for content in state %s', (state) => {
    mount(state);
    expect(isPopperUp()).toBe(true);
  });

  it('is false for content still mounted while it animates closed', () => {
    mount('closed');
    expect(isPopperUp()).toBe(false);
  });

  it('is true when any one of several is up', () => {
    mount('closed');
    mount('open');
    expect(isPopperUp()).toBe(true);
  });
});
