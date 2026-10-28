// Read a reply aloud with the Web Speech API. One message speaks at a time:
// starting another cancels the first. WebKitGTK often ships no voices, so the
// feature reports itself unavailable there and the button stays hidden.

type Listener = () => void

let speakingId: string | null = null
const listeners = new Set<Listener>()

const emit = () => listeners.forEach((l) => l())

const synth = (): SpeechSynthesis | undefined =>
  typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : undefined

export const speakingMessageId = () => speakingId

export const subscribeReadAloud = (listener: Listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function stopReadAloud() {
  const s = synth()
  speakingId = null
  s?.cancel()
  emit()
}

export function readAloud(id: string, text: string, codeOmitted: string) {
  const s = synth()
  if (!s || typeof SpeechSynthesisUtterance === 'undefined') return
  s.cancel()
  const spoken = speakableText(text, codeOmitted)
  if (!spoken) {
    speakingId = null
    emit()
    return
  }
  const utterance = new SpeechSynthesisUtterance(spoken)
  const done = () => {
    if (speakingId !== id) return
    speakingId = null
    emit()
  }
  utterance.onend = done
  utterance.onerror = done
  speakingId = id
  emit()
  s.speak(utterance)
}

/** Resolves true once the engine reports at least one voice. */
export function hasVoices(): Promise<boolean> {
  const s = synth()
  if (!s || typeof SpeechSynthesisUtterance === 'undefined')
    return Promise.resolve(false)
  if (s.getVoices().length > 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      s.removeEventListener?.('voiceschanged', onChange)
      clearTimeout(timer)
      resolve(value)
    }
    const onChange = () => finish(s.getVoices().length > 0)
    s.addEventListener?.('voiceschanged', onChange)
    // Engines that never fire voiceschanged have no voices to offer.
    const timer = setTimeout(() => finish(s.getVoices().length > 0), 1500)
  })
}

/** Markdown to plain speech: drops code and thinking, keeps the words. */
export function speakableText(markdown: string, codeOmitted: string): string {
  return markdown
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ')
    .replace(
      /^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm,
      `\n${codeOmitted}.\n`
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    // No lookbehind: older WebKit (macOS, Linux) rejects it at parse time.
    .replace(/(\*|_)(\S|\S.*?\S)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
