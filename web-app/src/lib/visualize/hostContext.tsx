import { createContext, useContext } from 'react'

/**
 * What the surface showing a widget lets it do. A surface that cannot start a
 * turn (a read-only view) provides nothing, and the widget's buttons then say so.
 */
export type WidgetHost = {
  /** Sends `text` as the user's next message. False when a reply is running. */
  sendPrompt: (text: string) => boolean
}

export const WidgetHostContext = createContext<WidgetHost | null>(null)

export const useWidgetHost = (): WidgetHost | null =>
  useContext(WidgetHostContext)
