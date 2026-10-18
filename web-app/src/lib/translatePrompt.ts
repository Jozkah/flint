/**
 * Languages offered on the Translate page, as the English name that goes into
 * the prompt plus the name in the language itself (a hint, and searchable).
 * `auto` is only valid as a source.
 */
export const TRANSLATE_LANGUAGE_INFO: ReadonlyArray<{
  name: string
  native: string
}> = [
  { name: 'English', native: 'English' },
  { name: 'Spanish', native: 'Español' },
  { name: 'French', native: 'Français' },
  { name: 'German', native: 'Deutsch' },
  { name: 'Italian', native: 'Italiano' },
  { name: 'Portuguese', native: 'Português' },
  { name: 'Brazilian Portuguese', native: 'Português (Brasil)' },
  { name: 'Dutch', native: 'Nederlands' },
  { name: 'Polish', native: 'Polski' },
  { name: 'Czech', native: 'Čeština' },
  { name: 'Slovak', native: 'Slovenčina' },
  { name: 'Slovenian', native: 'Slovenščina' },
  { name: 'Croatian', native: 'Hrvatski' },
  { name: 'Serbian', native: 'Српски' },
  { name: 'Bosnian', native: 'Bosanski' },
  { name: 'Bulgarian', native: 'Български' },
  { name: 'Macedonian', native: 'Македонски' },
  { name: 'Russian', native: 'Русский' },
  { name: 'Ukrainian', native: 'Українська' },
  { name: 'Belarusian', native: 'Беларуская' },
  { name: 'Romanian', native: 'Română' },
  { name: 'Hungarian', native: 'Magyar' },
  { name: 'Greek', native: 'Ελληνικά' },
  { name: 'Turkish', native: 'Türkçe' },
  { name: 'Swedish', native: 'Svenska' },
  { name: 'Norwegian', native: 'Norsk' },
  { name: 'Danish', native: 'Dansk' },
  { name: 'Finnish', native: 'Suomi' },
  { name: 'Icelandic', native: 'Íslenska' },
  { name: 'Estonian', native: 'Eesti' },
  { name: 'Latvian', native: 'Latviešu' },
  { name: 'Lithuanian', native: 'Lietuvių' },
  { name: 'Albanian', native: 'Shqip' },
  { name: 'Catalan', native: 'Català' },
  { name: 'Galician', native: 'Galego' },
  { name: 'Basque', native: 'Euskara' },
  { name: 'Irish', native: 'Gaeilge' },
  { name: 'Welsh', native: 'Cymraeg' },
  { name: 'Maltese', native: 'Malti' },
  { name: 'Luxembourgish', native: 'Lëtzebuergesch' },
  { name: 'Arabic', native: 'العربية' },
  { name: 'Hebrew', native: 'עברית' },
  { name: 'Persian', native: 'فارسی' },
  { name: 'Urdu', native: 'اردو' },
  { name: 'Pashto', native: 'پښتو' },
  { name: 'Kurdish', native: 'Kurdî' },
  { name: 'Hindi', native: 'हिन्दी' },
  { name: 'Bengali', native: 'বাংলা' },
  { name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { name: 'Gujarati', native: 'ગુજરાતી' },
  { name: 'Marathi', native: 'मराठी' },
  { name: 'Tamil', native: 'தமிழ்' },
  { name: 'Telugu', native: 'తెలుగు' },
  { name: 'Kannada', native: 'ಕನ್ನಡ' },
  { name: 'Malayalam', native: 'മലയാളം' },
  { name: 'Nepali', native: 'नेपाली' },
  { name: 'Sinhala', native: 'සිංහල' },
  { name: 'Thai', native: 'ไทย' },
  { name: 'Vietnamese', native: 'Tiếng Việt' },
  { name: 'Indonesian', native: 'Bahasa Indonesia' },
  { name: 'Malay', native: 'Bahasa Melayu' },
  { name: 'Filipino', native: 'Filipino' },
  { name: 'Burmese', native: 'မြန်မာ' },
  { name: 'Khmer', native: 'ខ្មែរ' },
  { name: 'Lao', native: 'ລາວ' },
  { name: 'Chinese', native: '中文' },
  { name: 'Simplified Chinese', native: '简体中文' },
  { name: 'Traditional Chinese', native: '繁體中文' },
  { name: 'Cantonese', native: '粵語' },
  { name: 'Japanese', native: '日本語' },
  { name: 'Korean', native: '한국어' },
  { name: 'Mongolian', native: 'Монгол' },
  { name: 'Kazakh', native: 'Қазақша' },
  { name: 'Uzbek', native: 'Oʻzbekcha' },
  { name: 'Azerbaijani', native: 'Azərbaycanca' },
  { name: 'Armenian', native: 'Հայերեն' },
  { name: 'Georgian', native: 'ქართული' },
  { name: 'Swahili', native: 'Kiswahili' },
  { name: 'Afrikaans', native: 'Afrikaans' },
  { name: 'Amharic', native: 'አማርኛ' },
  { name: 'Hausa', native: 'Hausa' },
  { name: 'Yoruba', native: 'Yorùbá' },
  { name: 'Zulu', native: 'isiZulu' },
  { name: 'Somali', native: 'Soomaali' },
  { name: 'Latin', native: 'Latina' },
  { name: 'Esperanto', native: 'Esperanto' },
]

export const TRANSLATE_LANGUAGES: readonly string[] =
  TRANSLATE_LANGUAGE_INFO.map((l) => l.name)

/**
 * Languages matching what was typed, by English or native name (accents and
 * case ignored), best matches (prefix) first. `recent` names come first when
 * nothing is typed.
 */
export function filterLanguages(
  query: string,
  recent: readonly string[] = []
): ReadonlyArray<{ name: string; native: string }> {
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const q = norm(query.trim())
  if (!q) {
    const head = recent
      .map((n) => TRANSLATE_LANGUAGE_INFO.find((l) => l.name === n))
      .filter((l): l is { name: string; native: string } => !!l)
    const rest = TRANSLATE_LANGUAGE_INFO.filter((l) => !recent.includes(l.name))
    return [...head, ...rest]
  }
  const names = (l: { name: string; native: string }) => [
    norm(l.name),
    norm(l.native),
  ]
  const prefix = (l: { name: string; native: string }) =>
    names(l).some((n) => n.startsWith(q))
  const wordStart = (l: { name: string; native: string }) =>
    names(l).some((n) => n.split(/[\s()\-,/]+/).some((w) => w.startsWith(q)))
  const lead = TRANSLATE_LANGUAGE_INFO.filter(prefix)
  const words = TRANSLATE_LANGUAGE_INFO.filter(
    (l) => !prefix(l) && wordStart(l)
  )
  // Substring hits ("ca" inside "français") are noise next to a real
  // start-of-word match, so they are only the fallback.
  if (lead.length || words.length) return [...lead, ...words]
  return TRANSLATE_LANGUAGE_INFO.filter((l) =>
    names(l).some((n) => n.includes(q))
  )
}

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
  const from = source === AUTO_LANGUAGE ? 'the source language' : source
  return (
    `Translate the following text from ${from} to ${target}. ` +
    `Output only the translation, with no explanation or quotation marks.\n\n` +
    text
  )
}
