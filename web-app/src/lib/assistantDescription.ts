import enAssistants from '@/locales/en/assistants.json'

const SHIPPED: Record<string, string> = enAssistants.starterDescriptions

/**
 * An assistant's description in the UI language. A starter assistant's
 * description is stored in English; while it is still the shipped text it is
 * shown translated (C059). A description the user wrote is shown as written.
 */
export function shownAssistantDescription(
  assistant: { id: string; description?: string },
  t: (key: string) => string
): string | undefined {
  const { id, description } = assistant
  if (description && Object.prototype.hasOwnProperty.call(SHIPPED, id) && SHIPPED[id] === description)
    return t(`assistants:starterDescriptions.${id}`)
  return description
}
