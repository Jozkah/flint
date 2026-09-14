import type { ReactNode } from 'react'

/**
 * The scrolling body of a data page: models, providers, hardware.
 *
 * `SettingsPageBody` holds prose settings to a reading measure. A list of
 * models or providers is a table, and a table held to that measure leaves wide
 * windows mostly empty while it truncates names and hides columns. This body
 * lets the content grow with the pane up to a limit a row can still be read
 * across, and never scrolls the page sideways: wide content scrolls inside its
 * own container.
 */
export function WidePageBody({
  children,
  testId,
}: {
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
      <div
        data-testid={testId}
        className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-5"
      >
        <div className="mx-auto flex w-full max-w-[1400px] min-w-0 flex-col gap-4">
          {children}
        </div>
      </div>
    </div>
  )
}
