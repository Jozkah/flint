import { useGeneralSetting } from '@/hooks/useGeneralSetting'

/** The languages a user can pin replies to: the name the model is told, and the name the picker shows. */
export const REPLY_LANGUAGES = [
  { value: 'English', label: 'English' },
  { value: 'Spanish', label: 'Español' },
  { value: 'French', label: 'Français' },
  { value: 'German', label: 'Deutsch' },
  { value: 'Italian', label: 'Italiano' },
  { value: 'Portuguese', label: 'Português' },
  { value: 'Dutch', label: 'Nederlands' },
  { value: 'Polish', label: 'Polski' },
  { value: 'Czech', label: 'Čeština' },
  { value: 'Turkish', label: 'Türkçe' },
  { value: 'Russian', label: 'Русский' },
  { value: 'Simplified Chinese', label: '简体中文' },
  { value: 'Traditional Chinese', label: '繁體中文' },
  { value: 'Japanese', label: '日本語' },
  { value: 'Korean', label: '한국어' },
  { value: 'Hindi', label: 'हिंदी' },
  { value: 'Vietnamese', label: 'Tiếng Việt' },
  { value: 'Indonesian', label: 'Bahasa Indonesia' },
] as const

/** The pinned language's name, or '' when replies follow the conversation. */
export const pinnedReplyLanguage = (): string =>
  useGeneralSetting.getState().replyLanguage?.trim() ?? ''

/**
 * One line for the end of a system prompt, or '' when no language is pinned.
 * Code, commands, file contents, identifiers and quotations are left as they
 * are: the setting is about the prose the user reads.
 */
export function replyLanguageLine(language: string = pinnedReplyLanguage()): string {
  if (!language) return ''
  return `Always write your replies in ${language}, whatever language the user, the files or the tool results are in. Keep code, commands, file paths, identifiers and quoted text as they are.`
}
