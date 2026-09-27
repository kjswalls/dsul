import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

/**
 * RISK SPIKE for the Organize console's rail (memory/plans/organize-console.md,
 * Phase 1). Everything in Phase 2 rides on the answer.
 *
 * The console replaces a horizontal tab strip with a GROUPED VERTICAL RAIL —
 * uppercase eyebrows ("CONTAINERS", "LABELS") and a hairline above Trash, sitting
 * as siblings of the tabs INSIDE the TabsList. That is a structural change to a
 * `role="tablist"`, and two things have to survive it:
 *
 *   1. `getByRole('tab', { name: 'Seasons' })` must keep resolving. The e2e suite
 *      drives the manager that way (seasons.spec.ts) and
 *      Phase 2's acceptance criterion is that that spec runs UNCHANGED.
 *
 *   2. Radix's RovingFocusGroup must step OVER the non-tab children rather than
 *      landing on them, or ↓ from the last tab in a group walks onto an eyebrow.
 *
 * Both are bought with `role="presentation"` on the wrappers. This pins that,
 * because if it were false the whole rail design would have to fall back to a
 * tablist of bare tabs with the grouping drawn outside it — a different component.
 *
 * jsdom + testing-library is a proxy for the DOM SHAPE, not for Playwright's own
 * accessible-name computation; the e2e specs remain the real gate. But if the
 * shape is wrong here it is wrong there too, and this runs in milliseconds.
 */

/** The rail as specced: two groups, five tabs, a ruled Trash pinned to the foot. */
function Rail({ value = 'routines' }: { value?: string }) {
  return (
    <TabsPrimitive.Root defaultValue={value} orientation="vertical">
      <TabsPrimitive.List aria-label="Sections">
        <div role="presentation">CONTAINERS</div>
        <TabsPrimitive.Trigger value="routines">Routines</TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger value="seasons">Seasons</TabsPrimitive.Trigger>
        <div role="presentation">LABELS</div>
        <TabsPrimitive.Trigger value="projects">Projects</TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger value="types">Item types</TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger value="groups">Habit groups</TabsPrimitive.Trigger>
        <div role="presentation" />
        <TabsPrimitive.Trigger value="trash">Trash</TabsPrimitive.Trigger>
      </TabsPrimitive.List>
      <TabsPrimitive.Content value="routines">routines pane</TabsPrimitive.Content>
      <TabsPrimitive.Content value="seasons">seasons pane</TabsPrimitive.Content>
      <TabsPrimitive.Content value="projects">projects pane</TabsPrimitive.Content>
      <TabsPrimitive.Content value="types">types pane</TabsPrimitive.Content>
      <TabsPrimitive.Content value="groups">groups pane</TabsPrimitive.Content>
      <TabsPrimitive.Content value="trash">trash pane</TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}

describe('Organize rail — vertical Tabs with presentation-role group headers', () => {
  it('still exposes every section as role="tab", by its visible name', () => {
    render(<Rail />);
    for (const name of ['Routines', 'Seasons', 'Projects', 'Item types', 'Habit groups', 'Trash']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    // Six tabs and no more: the eyebrows must not have joined the set.
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('does not leak the group eyebrows into any tab\'s accessible name', () => {
    render(<Rail />);
    // The failure this guards is subtle: an eyebrow rendered as a plain <div>
    // inside the list is still a text node under the tablist. If a trigger ever
    // wrapped one, `{ name: 'Routines' }` would match "CONTAINERS Routines" only
    // because Playwright substring-matches by default — a silent dependency.
    expect(screen.getByRole('tab', { name: 'Routines' })).toHaveAccessibleName('Routines');
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAccessibleName('Projects');
    expect(screen.queryByRole('tab', { name: /CONTAINERS/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /LABELS/ })).toBeNull();
  });

  it('marks the list vertical, which is what re-aims the arrow keys', () => {
    render(<Rail />);
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('walks ↓ from one group into the next, stepping over the eyebrow between them', async () => {
    render(<Rail />);
    const tab = (name: string) => screen.getByRole('tab', { name });

    /** Radix defers roving focus into a setTimeout, so each arrow needs a tick. */
    const arrowDown = async (from: string) => {
      fireEvent.keyDown(tab(from), { key: 'ArrowDown' });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    // Both halves are needed, and neither alone is enough. The real .focus()
    // sets document.activeElement, which is what RovingFocusGroup reads to find
    // its place; fireEvent.focus is what runs React's onFocus inside act(), which
    // is what registers the roving tab stop.
    tab('Seasons').focus();
    fireEvent.focus(tab('Seasons'));

    // Seasons is the last tab under CONTAINERS. Its next DOM sibling is the
    // LABELS eyebrow; roving focus has to step over it and land on Projects.
    await arrowDown('Seasons');
    expect(tab('Projects')).toHaveFocus();

    await arrowDown('Projects');
    expect(tab('Item types')).toHaveFocus();

    await arrowDown('Item types');
    expect(tab('Habit groups')).toHaveFocus();

    // ...and again across the unlabelled rule that pins Trash to the foot.
    await arrowDown('Habit groups');
    expect(tab('Trash')).toHaveFocus();
  });

  it('activates on click and swaps the pane', () => {
    render(<Rail />);

    expect(screen.getByText('routines pane')).toBeInTheDocument();
    // mouseDown, not click: Radix's TabsTrigger commits on pointer-down, so a
    // bare fireEvent.click never reaches its handler. Playwright's .click()
    // sends the full sequence, which is why the e2e specs don't hit this.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Habit groups' }), { button: 0 });

    expect(screen.getByRole('tab', { name: 'Habit groups' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('groups pane')).toBeInTheDocument();
    expect(screen.queryByText('routines pane')).toBeNull();
  });

  it('lands on the section it is opened with, so deep-linking a tab works', () => {
    render(<Rail value="seasons" />);
    expect(screen.getByRole('tab', { name: 'Seasons' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('seasons pane')).toBeInTheDocument();
  });
});
