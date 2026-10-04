import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import { normalizeWidgetCode, widgetFallbackTitle } from './code'
import {
  GUIDE_MODULES,
  MAX_LOADING_MESSAGE_CHARS,
  MAX_LOADING_MESSAGES,
  MAX_TITLE_CHARS,
  MAX_WIDGET_CODE_CHARS,
  MAX_WIDGETS_PER_RUN,
  READ_ME_TOOL,
  SHOW_WIDGET_TOOL,
  WIDGET_WINDOW_MS,
} from './constants'
import { buildGuide } from './guide'

/** Same shape the agent-tools plugin uses, so one list feeds every surface. */
export type VisualizeToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const READ_ME_DESCRIPTION =
  'Load the design guide for inline widgets (diagrams, mockups, charts, interactive explainers). ' +
  `Call it once per conversation, before the first ${SHOW_WIDGET_TOOL}, listing every kind you plan to draw. ` +
  'Returns text for you only; nothing is shown to the user.'

const SHOW_WIDGET_DESCRIPTION =
  'Show an interactive HTML/SVG widget inline in the chat: a diagram of a structure or flow, a UI mockup, ' +
  'a chart, or a small explainer the user can play with. Use it when seeing or touching it explains more than ' +
  'text, or when the user asks to "see" something. Do NOT use it for a simple answer, a list or code. ' +
  `widget_code is an HTML fragment (no html/head/body tags) styled with the theme variables from ${READ_ME_TOOL}; ` +
  'it has no network access. Keep it compact and say in your reply what it shows.'

export function visualizeSchemas(): VisualizeToolSchema[] {
  return [
    {
      type: 'function',
      function: {
        name: READ_ME_TOOL,
        description: READ_ME_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            modules: {
              type: 'array',
              items: { type: 'string', enum: [...GUIDE_MODULES] },
              description: 'Which guides to load.',
            },
          },
          required: ['modules'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: SHOW_WIDGET_TOOL,
        description: SHOW_WIDGET_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short caption shown above the widget.' },
            loading_messages: {
              type: 'array',
              items: { type: 'string' },
              maxItems: MAX_LOADING_MESSAGES,
              description: 'One to four short status lines shown while the code is written.',
            },
            widget_code: {
              type: 'string',
              description: 'HTML fragment: <style>, markup, then <script>.',
            },
          },
          required: ['title', 'widget_code'],
        },
      },
    },
  ]
}

export type ShowWidgetInput = {
  title: string
  loadingMessages: string[]
  code: string
}

/** The model's arguments as a widget, or the reason they cannot be one. */
export function parseShowWidgetInput(
  input: unknown
): { ok: true; value: ShowWidgetInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: `${SHOW_WIDGET_TOOL} needs an object with title and widget_code.`,
    }
  }
  const args = input as Record<string, unknown>
  if (typeof args.widget_code !== 'string' || !args.widget_code.trim()) {
    return {
      ok: false,
      error: 'widget_code is required: an HTML fragment as a string.',
    }
  }
  if (args.widget_code.length > MAX_WIDGET_CODE_CHARS) {
    return {
      ok: false,
      error:
        `widget_code is ${args.widget_code.length} characters; the limit is ${MAX_WIDGET_CODE_CHARS}. ` +
        'Send a smaller widget: fewer elements, shorter data, no inline images.',
    }
  }
  const code = normalizeWidgetCode(args.widget_code)
  if (!code) {
    return { ok: false, error: 'widget_code was empty after removing html/body wrappers.' }
  }
  const rawTitle = typeof args.title === 'string' ? args.title.trim() : ''
  const title = (rawTitle || widgetFallbackTitle(code)).slice(0, MAX_TITLE_CHARS)
  const loadingMessages = Array.isArray(args.loading_messages)
    ? args.loading_messages
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .slice(0, MAX_LOADING_MESSAGES)
        .map((m) => m.trim().slice(0, MAX_LOADING_MESSAGE_CHARS))
    : []
  return { ok: true, value: { title, loadingMessages, code } }
}

// What a conversation has done so far. In memory only: after a restart the
// model is reminded to read the guide once, which costs one short result.
const guideRead = new Set<string>()
const recentWidgets = new Map<string, number[]>()

export function resetVisualizeState(): void {
  guideRead.clear()
  recentWidgets.clear()
}

/** Loose on purpose: callers read it like every other tool's `{content, error}`. */
export type VisualizeResult = { content?: string; error?: string }

/**
 * Runs one visualize call. The widget itself is drawn by the transcript from
 * the call's input; the result the model gets back is deliberately short, so a
 * 20 KB widget does not ride along in every later request.
 */
export function executeVisualizeTool(
  toolName: string,
  input: unknown,
  conversationId: string,
  now: number = Date.now()
): VisualizeResult {
  if (!useVisualizeConfig.getState().enabled) {
    return { error: 'Visual widgets are turned off in Settings. Answer in text instead.' }
  }
  if (toolName === READ_ME_TOOL) {
    guideRead.add(conversationId)
    const modules = (input as { modules?: unknown } | null | undefined)?.modules
    return { content: buildGuide(modules) }
  }
  if (toolName !== SHOW_WIDGET_TOOL) {
    return { error: `Unknown visualize tool: ${toolName}` }
  }
  const parsed = parseShowWidgetInput(input)
  if (!parsed.ok) return { error: parsed.error }

  const recent = (recentWidgets.get(conversationId) ?? []).filter(
    (at) => now - at < WIDGET_WINDOW_MS
  )
  if (recent.length >= MAX_WIDGETS_PER_RUN) {
    recentWidgets.set(conversationId, recent)
    return {
      error:
        `Too many widgets in a short time (limit ${MAX_WIDGETS_PER_RUN}). ` +
        'Explain in text, or combine them into one widget.',
    }
  }
  recent.push(now)
  recentWidgets.set(conversationId, recent)

  const { title, code } = parsed.value
  const hint = guideRead.has(conversationId)
    ? ''
    : ` You have not called ${READ_ME_TOOL} in this conversation: call it before the next widget to match the app's look.`
  return { content: `Widget rendered: ${title}, ${code.length} chars.${hint}` }
}
