import '@testing-library/jest-dom';

/**
 * jsdom ships no Element.prototype.scrollIntoView, and calling a missing method
 * throws rather than no-oping. Radix's RovingFocusGroup calls it on every
 * candidate BEFORE focusing it, so without this stub arrow-key traversal in any
 * Tabs / Menu / ToggleGroup test dies silently mid-handler and focus simply
 * never moves — which reads as a component bug rather than a jsdom gap.
 *
 * The Organize console needs it for its own reason too: deep-linking with
 * `focusId` scrolls the selected row into view with `{ block: 'nearest' }`.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

/**
 * jsdom implements no Pointer Capture API, and Radix Select's trigger calls
 * `target.hasPointerCapture(e.pointerId)` on pointerdown before deciding whether
 * the gesture is a click or a drag-to-select. A missing method THROWS, and it
 * throws inside React's dispatch, so the error surfaces as an unhandled
 * exception with the test still reporting green — the menu simply never opens
 * and every assertion about its contents quietly checks nothing.
 *
 * Reporting `false` puts every gesture on the click path, which is the one a
 * test drives.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

/**
 * jsdom implements no window.matchMedia either, and it is not optional chaining
 * away — `hooks/use-mobile.ts` and `hooks/use-media-query.ts` call it directly
 * in an effect, so ANY component that renders a ResponsiveModal, the desktop
 * shell, or anything else branching on viewport throws on mount.
 *
 * Reports "does not match" for every query, which lands every consumer on its
 * desktop branch — consistent with jsdom's own 1024px innerWidth, so
 * `useIsMobile`'s width check and this agree instead of disagreeing.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      // Deprecated pair, still called by some libraries.
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/**
 * next/font loaders are compiled away by Next; under Vitest they are bare
 * imports that are not functions. Anything that mounts the wordmark (the
 * sidebar, the login page) pulls its flavor faces in, so every loader answers
 * with an empty font here: the faces are CSS, and no test asserts on them. A new
face imported anywhere a test mounts needs its name added to this list.
 */
vi.mock('next/font/google', () => {
  const font = () => ({
    className: '',
    variable: '',
    style: { fontFamily: '' },
  });
  return Object.fromEntries(
    [
      'Inter',
      'Source_Serif_4',
      'Rubik_Bubbles',
      'Silkscreen',
      'JetBrains_Mono',
      'Permanent_Marker',
      'Tilt_Neon',
      'Instrument_Serif',
      'Fredoka',
      'Space_Mono',
      'Bungee',
    ].map((name) => [name, font]),
  );
});
