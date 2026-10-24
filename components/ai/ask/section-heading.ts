/**
 * Ask home's section headings ("NEEDS YOU · 1", "WITH AI ACTIVITY"), in
 * History's group-heading type so Ask's lists read as one system.
 * No inset of their own: each sits on its section's left edge.
 *
 * Its own module, so the surfaces that only borrow the type (settings' AI
 * pane, the tour) never import Needs you, which reads the planner's items.
 */
export const ASK_SECTION_HEADING = 'text-2xs font-medium tracking-wide text-muted-foreground uppercase';
