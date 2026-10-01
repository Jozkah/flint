/**
 * The speech model behind dictation.
 *
 * Voxtral Mini 3B reads audio through the same llama.cpp engine that runs chat
 * (its multimodal library has the Voxtral projector), so the model is the only
 * thing to fetch, and it goes through the ordinary Hugging Face download and
 * import like any GGUF. One model on purpose: a choice of sizes is one more
 * thing to explain, and the weights dominate the size anyway.
 */

export const VOICE_MODEL_REPO = 'ggml-org/Voxtral-Mini-3B-2507-GGUF'
export const VOICE_MODEL_FILE = 'Voxtral-Mini-3B-2507-Q4_K_M.gguf'
export const VOICE_MMPROJ_FILE = 'mmproj-Voxtral-Mini-3B-2507-Q8_0.gguf'

/** The id the model is imported under, and the one requests name. */
export const VOICE_MODEL_ID = `${VOICE_MODEL_REPO}/Voxtral-Mini-3B-2507-Q4_K_M`

/** Exact sizes from the Hugging Face file listing, so progress has a real total. */
export const VOICE_MODEL_BYTES = 2_473_001_920
export const VOICE_MMPROJ_BYTES = 715_714_080
export const VOICE_TOTAL_BYTES = VOICE_MODEL_BYTES + VOICE_MMPROJ_BYTES

/** The download bundle id the progress UI follows. */
export const VOICE_BUNDLE_ID = `hf:llamacpp:${VOICE_MODEL_ID}`

/**
 * Chat template the voice model is loaded with. It is not optional.
 *
 * The template inside the GGUF is a Devstral one that opens every conversation
 * with a long system prompt about being a coding agent, so the model hears the
 * audio and answers it ("I can't transcribe audio directly...") instead of
 * transcribing it. Voxtral has a transcription mode, entered by ending the user
 * turn with `[TRANSCRIBE]` instead of closing it normally. So: no system
 * prompt, and `[INST]` ... `[TRANSCRIBE]` around whatever the user turn holds
 * (the audio marker llama.cpp inserts, then the language instruction).
 *
 * `String.raw`: the Jinja engine, not JavaScript, reads any escapes in it.
 */
export const VOICE_CHAT_TEMPLATE = String.raw`{%- for message in messages %}
    {%- set content = namespace(text='') %}
    {%- if message['content'] is string %}
        {%- set content.text = message['content'] %}
    {%- else %}
        {%- for block in message['content'] %}
            {%- if block['type'] == 'text' %}
                {%- set content.text = content.text + block['text'] %}
            {%- endif %}
        {%- endfor %}
    {%- endif %}
    {%- if message['role'] == 'assistant' %}
        {{- content.text }}{{- eos_token }}
    {%- else %}
        {{- '[INST]' + content.text + '[TRANSCRIBE]' }}
    {%- endif %}
{%- endfor %}`

/**
 * Settings the voice model is given after import. Small and fixed: it runs next
 * to the chat model, a phrase is a few hundred tokens, and a transcript is
 * short, so it must not size itself to the free memory the way a chat load does.
 */
export const VOICE_MODEL_SETTINGS = {
  chat_template: VOICE_CHAT_TEMPLATE,
  ctx_len: 4096,
} as const

/** Unload the voice model after this long without a phrase, to give the memory back. */
export const VOICE_IDLE_UNLOAD_MS = 5 * 60_000

/** The instruction that tells the model what language to expect, or none for automatic. */
export function languageDirective(language: string | undefined): string {
  const code = (language ?? '').trim().toLowerCase()
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code) ? `lang:${code}` : ''
}
