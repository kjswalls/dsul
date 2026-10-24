import { afterEach, describe, expect, it } from 'vitest';
import { placementFor } from '@/components/notices/day-messages';

/**
 * Where the date capsule's notes open (Kirby's pick B, 2026-10-24): beside the
 * capsule, top level with it, when the canvas has room to its right; below the
 * capsule when it does not; below the key on the phone, which has no capsule.
 */

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function mount(capsule: DOMRect | null, key: DOMRect) {
  const button = document.createElement('button');
  button.getBoundingClientRect = () => key;
  if (capsule) {
    const box = document.createElement('div');
    box.setAttribute('data-header-capsule', '');
    box.getBoundingClientRect = () => capsule;
    box.appendChild(button);
    document.body.appendChild(box);
  } else {
    document.body.appendChild(button);
  }
  return button;
}

const width = window.innerWidth;
afterEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
});

describe('placementFor', () => {
  it('opens beside the capsule, level with its top, when there is room', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    const key = mount(rect(24, 24, 344, 110), rect(324, 32, 28, 32));
    expect(placementFor(key)).toEqual({ side: 'right', align: 'start', sideOffset: 26, alignOffset: -8, caretTop: 24 });
  });

  it('hangs below the capsule on a canvas too narrow for beside', () => {
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });
    const key = mount(rect(24, 24, 344, 110), rect(324, 32, 28, 32));
    expect(placementFor(key)).toEqual({ side: 'bottom', align: 'end', sideOffset: 76, alignOffset: -16, caretTop: 0 });
  });

  it('opens below the key where there is no capsule', () => {
    const key = mount(null, rect(300, 10, 28, 32));
    expect(placementFor(key)).toEqual({ side: 'bottom', align: 'end', sideOffset: 6, alignOffset: 0, caretTop: 0 });
  });
});
