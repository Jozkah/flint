
import { Components, ExtraProps } from 'react-markdown'
import { memo, useDeferredValue, useMemo } from 'react'
import {
  cn,
  disableIndentedCodeBlockPlugin,
  splitHtmlArtifacts,
} from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { HtmlArtifact } from '@/components/HtmlArtifact'
// import 'katex/dist/katex.min.css'
import {
  defaultRehypePlugins,
  Streamdown,
  type MermaidErrorComponentProps,
} from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'

import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { MermaidError } from '@/components/MermaidError'
import { CitationLink } from '@/components/CitationLink'
import { WebCitationChip } from '@/components/WebCitationChip'
import { CoworkFileRef } from '@/containers/message/CoworkFileRef'
import { InlinePathLink } from '@/containers/message/InlinePathLink'
import { PATH_HREF_PREFIX } from '@/lib/pathOpen'
import { remarkFileRefs, FILE_REF_HREF_PREFIX } from '@/lib/coworkFileRefs'
import { MarkdownTable } from '@/components/MarkdownTable'
import { rehypeSafeInlineHtml } from '@/lib/rehypeSafeInlineHtml'
import { decodeWebCiteHref } from '@/lib/webUrl'

const WEB_CITE_MARKER = /\[\[cite:\s*([^\]\s]+?)\s*\]\]/g

// Models sometimes drop the scheme (e.g. "example.com/x"); normalize to https.
function normalizeCiteUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

// Convert model-emitted [[cite:URL]] markers into anchors the Anchor override
// renders as circular favicon chips.
function linkifyWebCitations(text: string): string {
  if (!text.includes('[[cite:')) return text
  return text.replace(
    WEB_CITE_MARKER,
    (_m, url: string) =>
      `[cite](#webcite-${encodeURIComponent(normalizeCiteUrl(url))})`
  )
}

interface MarkdownProps {
  content: string
  className?: string
  components?: Components
  isUser?: boolean
  isStreaming?: boolean
  messageId?: string
  isAnimating?: boolean
}

// Hoisted so their identity is stable across renders — Streamdown is memoized
// with a shallow prop compare, and fresh literals here would defeat it, forcing
// a full re-parse + re-highlight on every streamed token.
const REMARK_PLUGINS = [
  remarkGfm,
  remarkMath,
  disableIndentedCodeBlockPlugin,
  // Turn explicit `@path` references into fragment links; inert (rendered as
  // plain text) wherever no code-panel opener is provided, e.g. the chat route.
  remarkFileRefs,
]
const REHYPE_PLUGINS_USER = [rehypeKatex, defaultRehypePlugins.harden]
// Model output may carry inline HTML (e.g. <span style="color:...">); it is
// parsed, then cut down to an allowlist before KaTeX/harden run. User text stays
// literal so pasted markup is never reinterpreted.
const REHYPE_PLUGINS_MODEL = [
  defaultRehypePlugins.raw,
  rehypeSafeInlineHtml,
  rehypeKatex,
  defaultRehypePlugins.harden,
]
const STREAMDOWN_PLUGINS = { code, mermaid, cjk }
const STREAMDOWN_CONTROLS = { mermaid: { fullscreen: false } }
const LINK_SAFETY = { enabled: false }
const EMPTY_MERMAID = {}

// While streaming, the active (unclosed) code block would be re-highlighted by
// Shiki over its whole contents on every commit — O(n) per render, and the
// highlighted DOM is re-inserted wholesale (slow on webkitgtk). Render plain
// text instead; Streamdown's Shiki CodeBlock takes over once streaming ends.
type CodeProps = React.HTMLAttributes<HTMLElement> & ExtraProps
function StreamingCode({ node, className, children, ...props }: CodeProps) {
  const pos = node?.position
  const isInline = !pos || pos.start.line === pos.end.line
  if (isInline) {
    return (
      <code
        className={cn(
          'rounded-[5px] bg-accent px-1.5 py-0.5 font-mono text-[0.86em]',
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  }
  return (
    <pre className="mt-1 mb-3 overflow-x-auto rounded-[10px] border-[0.8px] border-border bg-code-bg px-3 py-2.5">
      <code className={cn('font-mono text-xs leading-[1.6]', className)}>{children}</code>
    </pre>
  )
}
const STREAMING_COMPONENTS: Components = { code: StreamingCode }

const ZWSP = '​'

// "word**,**" is neither left- nor right-flanking per CommonMark, so the markers
// render literally; a ZWSP just inside restores flanking (U+200B is treated as
// non-punctuation). Runs after math/code are masked, so '_'/'*' subscripts never
// get a ZWSP — that made KaTeX warn "Unrecognized Unicode character 8203".
const fixEmphasisFlanking = (s: string): string =>
  s.includes('*') || s.includes('_')
    ? s
        .replace(/([\p{L}\p{N}])(\*\*?|__?)(?=[^\s\p{L}\p{N}*_])/gu, `$1$2${ZWSP}`)
        .replace(/([^\s\p{L}\p{N}*_])(\*\*?|__?)(?=[\p{L}\p{N}])/gu, `$1${ZWSP}$2`)
    : s

// Placeholder-protection pipeline (adapted from llama.cpp's webui / LibreChat):
// remark-math only parses $…$/$$…$$, so brackets need converting — but converting,
// escaping currency, and fixing emphasis would corrupt each other unless code and
// math are first lifted out as opaque tokens. PUA-delimited tokens can't occur in
// model output and are inert to every transform here.
const CODE_BLOCK = /(```[\s\S]*?```|`[^`\n]+`)/g
const BRACKET_MATH =
  /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\(.*?\\\))/g
const tok = (kind: 'C' | 'L', n: number) => `\uE000${kind}${n}\uE000`

// Lifts bracket math out as tokens. A bracket opener preceded by another
// backslash is escaped and left alone; checked by hand because regex
// lookbehind is a parse error on WebKit older than 16.4.
const maskBracketMath = (input: string, store: string[]): string => {
  const re = new RegExp(BRACKET_MATH.source, 'g')
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    if (m[0][0] === '\\' && input[m.index - 1] === '\\') {
      re.lastIndex = m.index + 1
      continue
    }
    out += input.slice(last, m.index) + tok('L', store.push(m[0]) - 1)
    last = m.index + m[0].length
  }
  return out + input.slice(last)
}

// Mask genuine inline $…$ math; leave currency/identifiers ($5, a$b) in place.
// Per-line so a stray $ can't swallow the rest.
const maskInlineMath = (content: string, store: string[]): string => {
  if (!content.includes('$')) return content
  return content
    .split('\n')
    .map((line) => {
      if (!line.includes('$')) return line
      let out = ''
      let pos = 0
      while (pos < line.length) {
        const open = line.indexOf('$', pos)
        if (open === -1) {
          out += line.slice(pos)
          break
        }
        const close = line.indexOf('$', open + 1)
        if (close === -1) {
          out += line.slice(pos)
          break
        }

        const before = open > 0 ? line[open - 1] : ''
        const afterOpen = line[open + 1]
        const beforeClose = open + 1 < close ? line[close - 1] : ''
        const afterClose = close + 1 < line.length ? line[close + 1] : ''

        const empty = close === open + 1
        const gluedLeft = /[A-Za-z0-9_$-]/.test(before)
        const looksMoney =
          /[0-9]/.test(afterOpen) &&
          (/[A-Za-z0-9_$-]/.test(afterClose) || beforeClose === ' ')

        if (empty || gluedLeft || looksMoney) {
          out += line.slice(pos, open + 1)
          pos = open + 1
          continue
        }

        out += line.slice(pos, open)
        store.push(line.slice(open, close + 1))
        out += tok('L', store.length - 1)
        pos = close + 1
      }
      return out
    })
    .join('\n')
}

// Cache for normalized LaTeX content
const latexCache = new Map<string, string>()

const normalizeLatex = (input: string): string => {
  if (latexCache.has(input)) return latexCache.get(input)!

  const code: string[] = []
  const math: string[] = []

  let s = maskBracketMath(
    input.replace(CODE_BLOCK, (m) => tok('C', code.push(m) - 1)),
    math
  )

  s = maskInlineMath(s, math)
  s = s.replace(/\$(?=\d)/g, '\\$') // leftover currency renders literally
  s = fixEmphasisFlanking(s)

  // Restore math, converting bracket delimiters to $… / $$… for remark-math.
  s = s.replace(/\uE000L(\d+)\uE000/g, (_, n) => {
    const expr = math[Number(n)]
    if (expr.startsWith('\\[')) return `$$\n${expr.slice(2, -2).trim()}\n$$`
    if (expr.startsWith('\\(')) return `$${expr.slice(2, -2).trim()}$`
    return expr
  })
  s = s.replace(/\uE000C(\d+)\uE000/g, (_, n) => code[Number(n)])

  if (latexCache.size > 100) {
    const firstKey = latexCache.keys().next().value || ''
    latexCache.delete(firstKey)
  }
  latexCache.set(input, s)
  return s
}

function RenderMarkdownComponent({
  content,
  className,
  isUser,
  components,
  messageId,
  isAnimating,
  isStreaming,
}: MarkdownProps) {
  const renderHtmlArtifacts = useInterfaceSettings(
    (s) => s.renderHtmlArtifacts
  )

  // Coalesce rapid streamed updates: React renders the deferred (older) value
  // while new tokens arrive and skips intermediates under load, so the memoized
  // Streamdown subtree re-renders far less than once per token. Always converges
  // to the latest value, so it can't get stuck. Non-streaming uses content as-is.
  const deferredContent = useDeferredValue(content)
  const effectiveContent = isStreaming ? deferredContent : content

  // normalizeLatex is O(n) over the full string and its cache misses every chunk;
  // skip it while streaming (LaTeX can't render mid-token) to avoid O(n²) cost.
  const normalizedContent = useMemo(
    () =>
      linkifyWebCitations(
        isStreaming ? effectiveContent : normalizeLatex(effectiveContent)
      ),
    [effectiveContent, isStreaming]
  )

  const mergedComponents = useMemo<Components>(() => {
    const Anchor = (
      props: React.AnchorHTMLAttributes<HTMLAnchorElement>
    ) => {
      const { href, children, className: aClass } = props
      if (typeof href === 'string' && href.startsWith(FILE_REF_HREF_PREFIX)) {
        return (
          <CoworkFileRef href={href} className={aClass}>
            {children}
          </CoworkFileRef>
        )
      }
      if (typeof href === 'string' && href.startsWith(PATH_HREF_PREFIX)) {
        return (
          <InlinePathLink href={href} className={aClass}>
            {children}
          </InlinePathLink>
        )
      }
      if (typeof href === 'string' && href.startsWith('#cite-')) {
        return (
          <CitationLink href={href} className={aClass}>
            {children}
          </CitationLink>
        )
      }
      if (typeof href === 'string' && href.startsWith('#webcite-')) {
        const url = decodeWebCiteHref(href)
        if (!url) return <>{children}</>
        return <WebCitationChip messageId={messageId} url={url} />
      }
      return <a {...props}>{children}</a>
    }
    return { a: Anchor, table: MarkdownTable, ...(components ?? {}) } as Components
  }, [components, messageId])

  // Interactive HTML artifacts: only when the user opted in and the stream is
  // complete (an incomplete fence must not be torn out mid-token). Splitting the
  // string keeps Streamdown's code/mermaid/inline handling intact for everything
  // else — overriding its `code` component would replace all of it.
  const segments = useMemo(() => {
    if (isStreaming || !renderHtmlArtifacts) return null
    const segs = splitHtmlArtifacts(normalizedContent)
    return segs.some((s) => s.type === 'html' || s.type === 'svg')
      ? segs
      : null
  }, [normalizedContent, isStreaming, renderHtmlArtifacts])

  return (
    <div
      dir="auto"
      className={cn(
        'markdown wrap-break-word select-text',
        isUser && 'is-user',
        className
      )}
    >
      {segments
        ? segments.map((seg, i) =>
            seg.type === 'html' ? (
              <HtmlArtifact key={i} code={seg.content} />
            ) : seg.type === 'svg' ? (
              <HtmlArtifact
                key={i}
                code={seg.content}
                allowScripts={false}
                language="xml"
              />
            ) : (
              <StreamdownView
                key={i}
                content={seg.content}
                isStreaming={isStreaming}
                isAnimating={isAnimating}
                messageId={messageId}
                className={className}
                components={mergedComponents}
                isUser={isUser}
              />
            )
          )
        : (
          <StreamdownView
            content={normalizedContent}
            isStreaming={isStreaming}
            isAnimating={isAnimating}
            messageId={messageId}
            className={className}
            components={mergedComponents}
            isUser={isUser}
          />
        )}
    </div>
  )
}

interface StreamdownViewProps {
  content: string
  components: Components
  className?: string
  isStreaming?: boolean
  isAnimating?: boolean
  messageId?: string
  isUser?: boolean
}

function StreamdownViewComponent({
  content,
  components,
  className,
  isStreaming,
  isAnimating,
  messageId,
  isUser,
}: StreamdownViewProps) {
  const mermaidOptions = useMemo(
    () =>
      messageId
        ? {
            errorComponent: (props: MermaidErrorComponentProps) => (
              <MermaidError messageId={messageId} {...props} />
            ),
          }
        : EMPTY_MERMAID,
    [messageId]
  )

  const mergedClassName = useMemo(
    () =>
      cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className),
    [className]
  )

  // Skip Shiki on the in-progress code block while streaming.
  const effectiveComponents = useMemo(
    () =>
      isStreaming ? { ...components, ...STREAMING_COMPONENTS } : components,
    [components, isStreaming]
  )

  return (
    <Streamdown
      mode={isStreaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={isStreaming ?? false}
      animate={isStreaming ? false : (isAnimating ?? true)}
      animationDuration={500}
      linkSafety={LINK_SAFETY}
      className={mergedClassName}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={isUser ? REHYPE_PLUGINS_USER : REHYPE_PLUGINS_MODEL}
      components={effectiveComponents}
      plugins={STREAMDOWN_PLUGINS}
      controls={STREAMDOWN_CONTROLS}
      mermaid={mermaidOptions}
    >
      {content}
    </Streamdown>
  )
}

const StreamdownView = memo(StreamdownViewComponent)
export const RenderMarkdown = memo(
  RenderMarkdownComponent,
  (prevProps, nextProps) =>
    prevProps.content === nextProps.content &&
    prevProps.isStreaming === nextProps.isStreaming
)
