/**
 * Which parts of the composer's control row give up their text label, from
 * the row's own width (not the window's: a split pane is narrower than the
 * screen). Parts go in priority order, least useful label first, so the
 * controls stay on one row and the send button is never pushed out.
 */
export type CollapsePart =
  /** "Run settings": the text beside the sliders icon. */
  | 'runSettingsLabel'
  /** The folder's name in the folder chip; the branch stays when there is one. */
  | 'folderName'
  /** The access chip's word (Edit, Worktree, Review). */
  | 'accessLabel'
  /** All of the folder chip's text: it becomes its icon alone. */
  | 'chipText'

/** In the order they collapse, with the row width below which each does. */
export const COLLAPSE_STEPS: readonly { part: CollapsePart; below: number }[] = [
  { part: 'runSettingsLabel', below: 620 },
  { part: 'folderName', below: 540 },
  { part: 'accessLabel', below: 460 },
  { part: 'chipText', below: 380 },
]

/** The parts collapsed at a row width; none when the width is unknown. */
export function collapsedParts(width: number | null | undefined): Set<CollapsePart> {
  const out = new Set<CollapsePart>()
  if (!width || width <= 0) return out
  for (const step of COLLAPSE_STEPS) {
    if (width < step.below) out.add(step.part)
  }
  return out
}
