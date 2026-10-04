/** The two tools a model uses to put an inline widget in the conversation. */
export const READ_ME_TOOL = 'visualize_read_me'
export const SHOW_WIDGET_TOOL = 'show_widget'

export const VISUALIZE_TOOL_NAMES: ReadonlySet<string> = new Set([
  READ_ME_TOOL,
  SHOW_WIDGET_TOOL,
])

export const isVisualizeTool = (name: string): boolean =>
  VISUALIZE_TOOL_NAMES.has(name)

export const GUIDE_MODULES = [
  'diagram',
  'mockup',
  'chart',
  'interactive',
  'art',
] as const
export type GuideModule = (typeof GUIDE_MODULES)[number]

/** A widget larger than this is refused with an error the model can act on. */
export const MAX_WIDGET_CODE_CHARS = 200_000
/** Widgets one conversation may open inside `WIDGET_WINDOW_MS`. */
export const MAX_WIDGETS_PER_RUN = 4
export const WIDGET_WINDOW_MS = 120_000
export const MAX_TITLE_CHARS = 120
export const MAX_LOADING_MESSAGES = 4
export const MAX_LOADING_MESSAGE_CHARS = 80
/** Longest text `flint.sendPrompt` may put into a message. */
export const MAX_PROMPT_CHARS = 2_000

export const MIN_WIDGET_HEIGHT = 40
export const DEFAULT_WIDGET_MAX_HEIGHT = 640
export const WIDGET_MAX_HEIGHT_RANGE = { min: 240, max: 1600 } as const

/** Hosts a widget may load scripts from when the CDN setting is on. */
export const CDN_HOSTS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
] as const
