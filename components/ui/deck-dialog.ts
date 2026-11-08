/**
 * The add dialog's shell, for any other <Dialog> that wants to look like it
 * (Kirby's round 2 of the dialog restyle, 2026-11-07): 20px corners, a serif
 * title, and the deck, a recessed footer strip the keys stand in. The deck's
 * colour is the `[data-dialog-deck]` rule in globals.css, shared with the add
 * dialog's `[data-item-deck]` and every AlertDialog's footer.
 *
 * Class strings rather than a component so each dialog keeps its own
 * structure (a form, a scrolling list) and only takes the look:
 *
 *   <DialogContent className={DECK_DIALOG.content}>
 *     <div className={DECK_DIALOG.body}>…<DialogTitle className={DECK_DIALOG.title} /></div>
 *     <div data-dialog-deck className={DECK_DIALOG.deck}>…keys…</div>
 *   </DialogContent>
 */
export const DECK_DIALOG = {
  content: 'gap-0 overflow-hidden rounded-[20px] border-border p-0 sm:max-w-[440px]',
  body: 'flex min-h-0 flex-col gap-3 px-[22px] pt-[22px] pb-[18px]',
  title: 'font-serif text-lg leading-snug font-medium text-balance text-foreground pr-6',
  deck: 'flex flex-wrap items-center justify-end gap-2.5 border-t px-4 py-3',
  /** The deck's left side: chips and quiet actions, pushed off the keys. */
  deckLead: 'mr-auto flex min-w-0 items-center gap-1',
  /** A quiet deck chip (the add dialog's property chip at rest). */
  chip: 'text-muted-foreground hover:text-foreground hover-wash inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap transition-colors aria-expanded:text-foreground [&_svg]:size-3.5',
} as const;
