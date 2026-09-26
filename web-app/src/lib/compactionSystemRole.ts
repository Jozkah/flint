/**
 * Where a compaction summary goes in the request: a system message when the
 * model is known to accept one, the user-message form otherwise.
 *
 * The summary is reference material, not a request, and a system message says
 * so better than a user turn that starts "this is not a new request". But a
 * chat template that rejects or mangles a system role turns that into a Jinja
 * error or a lost summary, so the system form is used only when it can be
 * determined -- from the provider, or from a chat template the user set --
 * that a first-position system message is accepted. Everything else, notably
 * a local model whose template is read from the GGUF (the renderer never sees
 * it), keeps the user-message form that works everywhere.
 */

import type { UIMessage } from 'ai'
import { isSummaryMessage } from '@/lib/compaction'

/**
 * Hosted APIs that take a system message for every model they serve. Not
 * OpenRouter or custom OpenAI-compatible endpoints: those forward to models
 * and templates this code cannot see.
 */
const SYSTEM_ROLE_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'azure',
  'gemini',
  'mistral',
  'groq',
])

/** Local engines whose chat template decides how roles are rendered. */
const TEMPLATE_PROVIDERS = new Set(['llamacpp', 'mlx'])

/**
 * llama.cpp built-in template names whose templates render a system role in
 * first position. Deliberately short: a name missing here only costs the
 * system form, while a wrong entry would break a request.
 */
const SYSTEM_ROLE_TEMPLATES = new Set([
  'chatml',
  'llama3',
  'llama4',
  'phi3',
  'phi4',
  'command-r',
  'mistral-v7',
  'mistral-v7-tekken',
  'granite',
  'zephyr',
  'deepseek3',
  'chatglm4',
  'gpt-oss',
])

type ModelLike =
  | {
      settings?: Record<string, unknown> | null
    }
  | null
  | undefined

/** The custom chat template the user set on the model, if any. */
export function customChatTemplate(model: ModelLike): string | null {
  const setting = model?.settings?.chat_template as
    | { controller_props?: { value?: unknown } }
    | string
    | undefined
  const value =
    typeof setting === 'string' ? setting : setting?.controller_props?.value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Whether an inline Jinja template renders a system role: it must branch on
 * the role `system` and must not raise on it.
 */
export function templateAcceptsSystem(template: string): boolean {
  if (!/\{[{%]/.test(template)) return false
  if (!/['"]system['"]/.test(template)) return false
  // "System role not supported" and the like.
  if (/raise_exception\([^)]*system/i.test(template)) return false
  return true
}

/**
 * Whether a first-position system message is known to be accepted. False
 * whenever it cannot be determined.
 */
export function acceptsSystemRole(
  provider: string | null | undefined,
  model: ModelLike
): boolean {
  if (!provider) return false
  if (SYSTEM_ROLE_PROVIDERS.has(provider)) return true
  if (!TEMPLATE_PROVIDERS.has(provider)) return false
  const template = customChatTemplate(model)
  // Read from the GGUF: unknown here, so not assumed.
  if (!template) return false
  if (SYSTEM_ROLE_TEMPLATES.has(template.toLowerCase())) return true
  return templateAcceptsSystem(template)
}

const textOf = (message: UIMessage): string =>
  (message.parts ?? [])
    .map((part) =>
      part.type === 'text' ? (part as { text: string }).text : ''
    )
    .filter(Boolean)
    .join('\n')

/**
 * Move compaction summaries out of the conversation and into the system
 * prompt, which the request sends as its single first-position system message.
 *
 * Returns the input unchanged when there is no summary, or when removing it
 * would leave no genuine user turn: some templates (Qwen3.5+) refuse a window
 * without one, and the summary may be what carries the folded request.
 */
export function foldSummaryIntoSystem(
  system: string | undefined,
  messages: UIMessage[]
): { system: string | undefined; messages: UIMessage[] } {
  const summaries = messages.filter(isSummaryMessage)
  if (summaries.length === 0) return { system, messages }
  const rest = messages.filter((m) => !isSummaryMessage(m))
  if (!rest.some((m) => m.role === 'user')) return { system, messages }
  const summaryText = summaries.map(textOf).filter(Boolean).join('\n\n')
  if (!summaryText) return { system, messages }
  return {
    system: system?.trim() ? `${system}\n\n${summaryText}` : summaryText,
    messages: rest,
  }
}
