import type { ReactNode } from 'react'

/**
 * The row inside `HeaderPage`, shared by every page that has one.
 *
 * It exists so the header cannot drift between pages. The model selector and
 * the page's own control were laid out separately on the chat page and in
 * Cowork, and ended up different sizes, in different places, with different
 * spacing. One component means one answer for all of it, and a page that adds
 * a control gets the same padding and order without deciding anything.
 *
 * Pages differ only in which trailing control they pass.
 */
export function PageHeaderRow({ children }: { children: ReactNode }) {
  return <div className="flex w-full items-center gap-2">{children}</div>
}

export default PageHeaderRow
