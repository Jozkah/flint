/**
 * A dialog footer that stays on screen while a long body scrolls.
 *
 * `DialogContent` is itself the scroll container (and a bottom sheet on
 * phones), so a footer made sticky to its bottom edge keeps the primary action
 * reachable without the user scrolling past every field first. The negative
 * margins let its background and hairline span the dialog's padding. The
 * background is the dialog's own (`bg-popover`), not the card colour: a
 * different shade drew a second, darker slab across the bottom of every
 * dialog, under a one-line body as much as a scrolling one.
 */
export const STICKY_DIALOG_FOOTER =
  'sticky -bottom-5 z-10 -mx-5 -mb-5 border-t border-border bg-popover px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-5'
