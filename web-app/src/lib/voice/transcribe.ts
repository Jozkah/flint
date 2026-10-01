import { findSessionByModel } from '@janhq/tauri-plugin-llamacpp-api'
import { providerFetch } from '@/lib/providerFetch'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceStore } from '@/hooks/useServiceHub'
import { toBase64 } from '@/lib/voice/wav'
import { VOICE_MODEL_ID, languageDirective } from '@/lib/voice/voiceModel'

/**
 * One request to the voice model: a phrase of speech in, its words out.
 *
 * The model is loaded alongside the chat model (never in its place), and the
 * request goes to the local engine as a chat completion with the audio as an
 * `input_audio` part, which llama.cpp turns into the model's audio input.
 */

export class VoiceModelMissingError extends Error {
  constructor() {
    super('The voice model is not installed.')
    this.name = 'VoiceModelMissingError'
  }
}

/** Load the voice model if it is not already, and return where to reach it. */
async function ensureVoiceSession(): Promise<{ port: number; api_key: string }> {
  const provider = useModelProvider.getState().getProviderByName('llamacpp')
  if (!provider?.models.some((m) => m.id === VOICE_MODEL_ID)) {
    throw new VoiceModelMissingError()
  }
  const hub = useServiceStore.getState().serviceHub
  if (!hub) throw new Error('Flint is still starting. Try again in a moment.')
  // `true`: start it next to the chat model instead of unloading that one.
  await hub.models().startModel(provider, VOICE_MODEL_ID, true)
  const session = await findSessionByModel(VOICE_MODEL_ID)
  if (!session) throw new Error('The voice model did not start.')
  return session as { port: number; api_key: string }
}

/** The text of a chat completion's first choice, whatever shape the content takes. */
export function completionText(body: unknown): string {
  const content = (
    body as { choices?: Array<{ message?: { content?: unknown } }> }
  )?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

/** The request body for a phrase of 16 kHz WAV audio. */
export function transcriptionRequest(wav: Uint8Array, language?: string) {
  const directive = languageDirective(language)
  return {
    model: VOICE_MODEL_ID,
    stream: false,
    temperature: 0,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: toBase64(wav), format: 'wav' } },
          ...(directive ? [{ type: 'text', text: directive }] : []),
        ],
      },
    ],
  }
}

export async function transcribeWav(
  wav: Uint8Array,
  options: { language?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const session = await ensureVoiceSession()
  const response = await providerFetch(
    `http://localhost:${session.port}/v1/chat/completions`,
    {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.api_key}`,
        Origin: 'tauri://localhost',
      },
      body: JSON.stringify(transcriptionRequest(wav, options.language)),
    }
  )
  if (!response.ok) {
    throw new Error(`The voice model answered ${response.status}.`)
  }
  return completionText(await response.json())
}
