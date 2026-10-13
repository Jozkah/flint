/** Languages offered on the Translate page; `auto` is only valid as a source. */
export const TRANSLATE_LANGUAGES = [
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Dutch',
  'Polish',
  'Czech',
  'Russian',
  'Ukrainian',
  'Turkish',
  'Arabic',
  'Hindi',
  'Indonesian',
  'Vietnamese',
  'Thai',
  'Chinese',
  'Japanese',
  'Korean',
] as const

export const AUTO_LANGUAGE = 'auto'

/**
 * The single-turn instruction sent to the model. Translation-tuned and general
 * instruct models both follow it; the answer is the translation and nothing
 * else, so it can be shown and copied as is.
 */
export function buildTranslatePrompt(
  text: string,
  source: string,
  target: string
): string {
  const from =
    source === AUTO_LANGUAGE ? 'the source language' : source
  return (
    `Translate the following text from ${from} to ${target}. ` +
    `Output only the translation, with no explanation or quotation marks.\n\n` +
    text
  )
}
