import { providerDisplayName } from '@/lib/providerDisplayNames'
import type { Node, Position } from 'unist'
import type { Code, Paragraph, Parent, Text } from 'mdast'
import { visit } from 'unist-util-visit'
import { ExtensionManager } from './extension'
import path from 'path'
import type { VFile } from 'vfile'

export { cn } from './cn'
export { getProviderLogo } from './providerLogos'

export function basenameNoExt(filePath: string): string {
  const base = path.basename(filePath)
  const VALID_EXTENSIONS = ['.tar.gz', '.zip']

  // handle VALID extensions first
  for (const ext of VALID_EXTENSIONS) {
    if (base.toLowerCase().endsWith(ext)) {
      return base.slice(0, -ext.length)
    }
  }

  // fallback: remove only the last extension
  const ext = path.extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

/**
 * Remark plugin that disables indented code block syntax.
 * Converts indented code blocks to plain text paragraphs,
 * while preserving fenced code blocks with backticks.
 */
export function disableIndentedCodeBlockPlugin() {
  return (tree: Node, file: VFile) => {
    visit(tree, 'code', (node: Code, index, parent: Parent | undefined) => {
      // Convert indented code blocks (nodes without lang / meta property, 
      // and are not surrounded by backticks) to plain text
      // Check if the parent exists so we can replace the node safely
      if (node.lang === null && node.meta === null && parent && typeof index === 'number') {
        const nodePosition: Position | undefined = node.position
        if (nodePosition !== undefined && file.value.at(nodePosition.start.offset!) !== '`') {
          const textNode: Text = {
            type: 'text',
            value: node.value,
            position: nodePosition,
          }
          const paragraphNode: Paragraph = {
            type: 'paragraph',
            children: [textNode],
            position: nodePosition,
          }
          parent.children[index] = paragraphNode
        }
      }
    })
  }
}

export interface MarkdownSegment {
  type: 'markdown' | 'html' | 'svg'
  content: string
}

// Standalone artifact, any of:
//   1. fenced block of any language → groups 1 (lead \n) 2 (ticks) 3 (info) 4 (body)
//   2. raw <svg>…</svg> in prose    → group 5
// The fence body is promoted to an artifact only when it's an html/svg fence,
// or when its body is a lone <svg> (e.g. a model wrapping its SVG in a ```xml or
// bare ``` fence). A fence with SVG mixed into other code stays as code. Raw SVG
// is matched non-greedily so adjacent diagrams stay separate.
const ARTIFACT_RE =
  /(^|\n)(`{3,})[ \t]*([^\n]*)\n([\s\S]*?)\n\2[ \t]*(?=\n|$)|(<svg\b[\s\S]*?<\/svg>)/gi

const bodyIsLoneSvg = (body: string) => {
  const t = body.trim()
  return /^<svg\b/i.test(t) && /<\/svg>$/i.test(t)
}

/**
 * Split markdown into alternating prose and standalone artifact segments
 * (interactive HTML previews and static SVG). Splitting the string keeps
 * Streamdown's code/mermaid/inline handling intact for everything else —
 * overriding its `code` component would replace all of it.
 */
export function splitHtmlArtifacts(content: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  ARTIFACT_RE.lastIndex = 0
  while ((match = ARTIFACT_RE.exec(content)) !== null) {
    const isFence = match[2] !== undefined
    let type: MarkdownSegment['type']
    let artifactBody: string
    if (isFence) {
      const lang = match[3].trim().split(/\s+/)[0].toLowerCase()
      const body = match[4]
      if (lang === 'svg' || lang === 'html') {
        type = lang
      } else if (bodyIsLoneSvg(body)) {
        type = 'svg'
      } else {
        // Real code fence — leave it in the markdown stream untouched.
        continue
      }
      artifactBody = body
    } else {
      type = 'svg'
      artifactBody = match[5]
    }
    // Fence keeps the leading newline as prose; raw SVG starts at match.index.
    const blockStart = isFence ? match.index + match[1].length : match.index
    const before = content.slice(lastIndex, blockStart)
    if (before.length) segments.push({ type: 'markdown', content: before })
    segments.push({ type, content: artifactBody })
    lastIndex = ARTIFACT_RE.lastIndex
  }
  const rest = content.slice(lastIndex)
  if (rest.length) segments.push({ type: 'markdown', content: rest })
  return segments
}

/**
 * Get the display name for a model, falling back to the model ID if no display name is set
 */
export function getModelDisplayName(model: Model): string {
  return model.displayName || model.id
}

export const getProviderTitle = (provider: string) =>
  providerDisplayName(provider) ?? getDefaultProviderTitle(provider)

/** The built-in title for a provider key, ignoring any rename. */
export const getDefaultProviderTitle = (provider: string) => {
  switch (provider) {
    case 'jan':
      return 'Jan'
    case 'llamacpp':
      return 'Llama.cpp'
    case 'mlx':
      return 'MLX'
    case 'openai':
      return 'OpenAI'
    case 'openrouter':
      return 'OpenRouter'
    case 'gemini':
      return 'Gemini'
    case 'huggingface':
      return 'Hugging Face'
    case 'xai':
      return 'xAI'
    case 'minimax':
      return 'MiniMax'
    case 'nvidia':
      return 'NVIDIA NIM'
    case 'deepseek':
      return 'DeepSeek'
    case 'moonshot':
      return 'Moonshot AI (Kimi)'
    case 'together':
      return 'Together AI'
    case 'fireworks':
      return 'Fireworks AI'
    case 'cerebras':
      return 'Cerebras'
    case 'sambanova':
      return 'SambaNova'
    case 'zai':
      return 'Z.ai (GLM)'
    case 'qwen':
      return 'Alibaba Qwen'
    case 'poe':
      return 'Poe'
    case 'ollama-cloud':
      return 'Ollama Cloud'
    case 'llmman':
      return 'llmman'
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1)
  }
}

export function getReadableLanguageName(language: string): string {
  const languageMap: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'React JSX',
    ts: 'TypeScript',
    tsx: 'React TSX',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    md: 'Markdown',
    py: 'Python',
    rb: 'Ruby',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    cs: 'C#',
    go: 'Go',
    rust: 'Rust',
    php: 'PHP',
    swift: 'Swift',
    kotlin: 'Kotlin',
    sql: 'SQL',
    sh: 'Shell',
    bash: 'Bash',
    ps1: 'PowerShell',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    // Add more languages as needed
  }

  return (
    languageMap[language] ||
    language.charAt(0).toUpperCase() + language.slice(1)
  )
}

export const isLocalProvider = (provider: string) => {
  const extension = ExtensionManager.getInstance().getEngine(provider)
  return extension && 'load' in extension
}

export const toGigabytes = (
  input: number,
  options?: { hideUnit?: boolean; toFixed?: number }
) => {
  if (!input) return ''
  if (input > 1024 ** 3) {
    return (
      (input / 1024 ** 3).toFixed(options?.toFixed ?? 2) +
      (options?.hideUnit ? '' : 'GB')
    )
  } else if (input > 1024 ** 2) {
    return (
      (input / 1024 ** 2).toFixed(options?.toFixed ?? 2) +
      (options?.hideUnit ? '' : 'MB')
    )
  } else if (input > 1024) {
    return (
      (input / 1024).toFixed(options?.toFixed ?? 2) +
      (options?.hideUnit ? '' : 'KB')
    )
  } else {
    return input + (options?.hideUnit ? '' : 'B')
  }
}

export type ByteUnit = 'B' | 'KB' | 'MB' | 'GB'

export type FormatBytesOptions = {
  decimals?: number | ((value: number, unit: ByteUnit) => number)
  separator?: string
  hideUnit?: boolean
  minUnit?: ByteUnit
  fallback?: string
}

const BYTE_UNITS: ByteUnit[] = ['B', 'KB', 'MB', 'GB']

export function formatBytes(
  bytes: number | undefined,
  options?: FormatBytesOptions
): string {
  const fallback = options?.fallback ?? ''

  if (bytes === undefined || !Number.isFinite(bytes)) {
    return fallback
  }

  const minUnitIndex =
    options?.minUnit === undefined ? 0 : BYTE_UNITS.indexOf(options.minUnit)

  let unitIndex = 0
  let scaledValue = bytes

  while (scaledValue >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaledValue /= 1024
    unitIndex++
  }

  while (unitIndex < minUnitIndex) {
    scaledValue /= 1024
    unitIndex++
  }

  const unit = BYTE_UNITS[unitIndex]
  const rawDecimals =
    typeof options?.decimals === 'function'
      ? options.decimals(scaledValue, unit)
      : options?.decimals ?? 1
  const decimals = Math.min(20, Math.max(0, Math.trunc(rawDecimals)))
  const formattedValue = scaledValue.toFixed(decimals)

  if (options?.hideUnit) {
    return formattedValue
  }

  return `${formattedValue}${options?.separator ?? ' '}${unit}`
}

export function formatMegaBytes(mb: number) {
  const tb = mb / (1024 * 1024)
  if (tb >= 1) {
    return `${tb.toFixed(2)} TB`
  } else {
    const gb = mb / 1024
    return `${gb.toFixed(2)} GB`
  }
}

export function isDev() {
  return window.location.host.startsWith('localhost:')
}

export function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime || Date.now()
  const durationMs = end - startTime

  if (durationMs < 0) {
    return 'Invalid duration (start time is in the future)'
  }

  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  } else if (seconds > 0) {
    return `${seconds}s`
  } else {
    return `${durationMs}ms`
  }
}

/** Compact token count for badges and labels, e.g. 24567 -> "24.6K". */
export function formatTokenCount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
  return num.toString()
}

/**
 * Elide the middle of a path so both ends stay readable. The tail identifies
 * which file or session it is, so truncating from the end (CSS ellipsis) hides
 * the only part worth reading.
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

export function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9/_\-.]/g, '').replace(/\./g, '_')
}

export const extractThinkingContent = (text: string) => {
  return text
    .replace(/<\/?think>/g, '')
    .replace(/<\|channel\|>analysis<\|message\|>/g, '')
    .replace(/<\|start\|>assistant<\|channel\|>final<\|message\|>/g, '')
    .replace(/assistant<\|channel\|>final<\|message\|>/g, '')
    .replace(/<\|channel\|>/g, '') // remove any remaining channel markers
    .replace(/<\|message\|>/g, '') // remove any remaining message markers
    .replace(/<\|start\|>/g, '') // remove any remaining start markers
    .trim()
}

/** Code on the error `withTimeout` rejects with when the deadline passes. */
export const OPERATION_TIMED_OUT_CODE = 'OPERATION_TIMED_OUT'

/**
 * Ceiling for the native `startServer` call (bind a listener, build the
 * routing config). It has no reason to take more than a few seconds.
 */
export const SERVER_START_WATCHDOG_MS = 60 * 1000

/**
 * Ceiling for loading a model as part of starting the Local API Server. Kept
 * above the engine's own load-readiness limit so a slow but healthy load is
 * never cut off; it only stops a step with no timeout of its own from leaving
 * the "Starting Server" state forever.
 */
export const MODEL_LOAD_WATCHDOG_MS = 35 * 60 * 1000

/**
 * Settle with `promise`, or reject with an error carrying
 * `OPERATION_TIMED_OUT_CODE` once `ms` have passed. A promise cannot be
 * cancelled, so the underlying work keeps running; this only stops the
 * caller from waiting on it forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message) as Error & { code?: string }
      err.code = OPERATION_TIMED_OUT_CODE
      reject(err)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Wait for a `startServer` call at most `SERVER_START_WATCHDOG_MS`. On expiry
 * the server is torn down (now, and again if the start completes late) so the
 * caller can report the error and reset its status to stopped without a
 * server left running behind it.
 */
export function guardServerStart(
  call: Promise<number> | undefined
): Promise<number | undefined> {
  if (!call) return Promise.resolve(undefined)
  return withTimeout(
    call,
    SERVER_START_WATCHDOG_MS,
    'Timed out waiting for the Local API Server to start.'
  ).catch((error: unknown) => {
    if ((error as { code?: string } | null)?.code === OPERATION_TIMED_OUT_CODE) {
      const stop = () => {
        try {
          void Promise.resolve(window.core?.api?.stopServer?.()).catch(() => {})
        } catch {
          // best effort
        }
      }
      stop()
      call.then(stop, () => {})
    }
    throw error
  })
}
