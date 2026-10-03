import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isClickAwayTarget, subscribeClickAway, MAX_TRAVEL_PX } from '@/lib/click-away';

function build() {
  document.body.innerHTML = `
    <div data-click-away-scope="">
      <div id="empty"><span id="empty-child">hour label</span></div>
      <div data-item-id="a" id="item"><span id="item-title">Task</span></div>
      <aside data-testid="item-dialog"><div id="panel-body"></div></aside>
      <div data-rail=""><aside data-rail-view=""><div id="rail-body"></div></aside></div>
      <button id="btn"><span id="btn-icon"></span></button>
      <input id="field" />
      <div role="button" id="drag-handle"></div>
    </div>
    <div id="outside"></div>
  `;
}

const el = (id: string) => document.getElementById(id)!;

/** A full press: pointerdown at `from`, click at `to` on the same element. */
function press(
  target: Element,
  opts: { to?: [number, number]; mods?: Partial<MouseEventInit>; clickOn?: Element } = {}
) {
  const [x, y] = opts.to ?? [10, 10];
  target.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10, ...opts.mods })
  );
  (opts.clickOn ?? target).dispatchEvent(
    new MouseEvent('click', { bubbles: true, button: 0, clientX: x, clientY: y, ...opts.mods })
  );
}

describe('isClickAwayTarget', () => {
  beforeEach(build);

  it('is true for bare space inside the scope', () => {
    expect(isClickAwayTarget(el('empty'))).toBe(true);
    expect(isClickAwayTarget(el('empty-child'))).toBe(true);
  });

  it('is false inside an item, the panel, the rail, or a control', () => {
    for (const id of ['item', 'item-title', 'panel-body', 'rail-body', 'btn', 'btn-icon', 'field', 'drag-handle']) {
      expect(isClickAwayTarget(el(id)), id).toBe(false);
    }
  });

  it('is false outside the scope — portals, other shells', () => {
    expect(isClickAwayTarget(el('outside'))).toBe(false);
    expect(isClickAwayTarget(null)).toBe(false);
  });
});

describe('subscribeClickAway', () => {
  let off: (() => void) | undefined;
  beforeEach(build);
  afterEach(() => {
    off?.();
    off = undefined;
  });

  it('fires on a plain click on empty space', () => {
    const h = vi.fn();
    off = subscribeClickAway(h);
    press(el('empty-child'));
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('does not fire on an item, the panel, or a control', () => {
    const h = vi.fn();
    off = subscribeClickAway(h);
    press(el('item-title'));
    press(el('panel-body'));
    press(el('btn-icon'));
    expect(h).not.toHaveBeenCalled();
  });

  it('does not fire when the click ends a drag', () => {
    const h = vi.fn();
    off = subscribeClickAway(h);
    // Moved past the threshold…
    press(el('empty'), { to: [10 + MAX_TRAVEL_PX + 1, 10] });
    // …or started on an item and was released over empty space.
    press(el('item'), { clickOn: el('empty') });
    expect(h).not.toHaveBeenCalled();
  });

  it('ignores modifier clicks, so a mis-aimed ⌘-click keeps a multi-select', () => {
    const h = vi.fn();
    off = subscribeClickAway(h);
    press(el('empty'), { mods: { metaKey: true } });
    press(el('empty'), { mods: { shiftKey: true } });
    expect(h).not.toHaveBeenCalled();
  });

  it("ignores a click's follow-on, which lands wherever the first click left the page", () => {
    const h = vi.fn();
    off = subscribeClickAway(h);
    press(el('empty'), { mods: { detail: 2 } });
    press(el('empty'), { mods: { detail: 3 } });
    expect(h).not.toHaveBeenCalled();
    press(el('empty'), { mods: { detail: 1 } });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('lets a press that dismisses a popover do only that', () => {
    const h = vi.fn();
    off = subscribeClickAway(h);
    const popper = document.createElement('div');
    popper.setAttribute('data-radix-popper-content-wrapper', '');
    document.body.appendChild(popper);
    el('empty').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    popper.remove(); // Radix tears it down before the click lands
    el('empty').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(h).not.toHaveBeenCalled();
  });

  it('removes its document listeners with the last subscriber', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const a = subscribeClickAway(() => {});
    const b = subscribeClickAway(() => {});
    expect(add).toHaveBeenCalledTimes(2); // one pointerdown + one click, not per subscriber
    a();
    expect(remove).not.toHaveBeenCalled();
    b();
    expect(remove).toHaveBeenCalledTimes(2);
    add.mockRestore();
    remove.mockRestore();
  });

  it('survives a handler unsubscribing another mid-dispatch', () => {
    const second = vi.fn();
    let offSecond = () => {};
    const offFirst = subscribeClickAway(() => offSecond());
    offSecond = subscribeClickAway(second);
    press(el('empty'));
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
  });
});
