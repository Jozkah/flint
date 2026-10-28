
import { Components, ExtraProps } from 'react-markdown'
import { memo, useDeferredValue, useMemo, useRef } from 'react'
import {
  cn,
  disableIndentedCodeBlockPlugin,
  splitHtmlArtifacts,
} from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { HtmlArtifact } from '@/components/HtmlArtifact'
import { findNamedBlock } from '@/lib/codeBlockFilename'
// import 'katex/dist/katex.min.css'
import {
  defaultRehypePlugins,
  Streamdown,
  type MermaidErrorComponentProps,
} from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { guardCodePlugin } from '@/lib/guardedCodePlugin'
import { CodeWrapToggles } from '@/components/CodeWrapToggles'
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
import { MarkdownImage } from '@/components/MarkdownImage'
import { rehypeSafeInlineHtml } from '@/lib/rehypeSafeInlineHtml'
import { rehypeStripFlankingZwsp } from '@/lib/rehypeStripFlankingZwsp'
import { rehypeBlockDir } from '@/lib/rehypeBlockDir'
import { decodeWebCiteHref } from '@/lib/webUrl'
import { mermaidConfigFor } from '@/lib/mermaidTheme'
import { useTheme } from '@/hooks/useTheme'

const WEB_CITE_MARKER = /\[\[cite:\s*([^\]\s]+?)\s*\]\]/g

// Models sometimes drop the scheme (e.g. "example.com/x"); normalize to https.
function normalizeCiteUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

// Convert model-emitted [[cite:URL]] markers into anchors the Anchor override
// renders as circular favicon chips.
function linkifyWebCitations(text: string, show = true): string {
  if (!text.includes('[[cite:')) return text
  // Off: the markers are dropped; the sources still list under the answer.
  if (!show) return text.replace(WEB_CITE_MARKER, '')
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
const REHYPE_PLUGINS_USER = [
  rehypeStripFlankingZwsp,
  rehypeKatex,
  defaultRehypePlugins.harden,
  rehypeBlockDir,
]
// Model output may carry inline HTML (e.g. <span style="color:...">); it is
// parsed, then cut down to an allowlist before KaTeX/harden run. User text stays
// literal so pasted markup is never reinterpreted.
const REHYPE_PLUGINS_MODEL = [
  defaultRehypePlugins.raw,
  rehypeSafeInlineHtml,
  rehypeStripFlankingZwsp,
  rehypeKatex,
  defaultRehypePlugins.harden,
  rehypeBlockDir,
]
const STREAMDOWN_PLUGINS = { code: guardCodePlugin(code), mermaid, cjk }
const STREAMDOWN_CONTROLS = { mermaid: { fullscreen: false } }
const LINK_SAFETY = { enabled: false }

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
// A fence owns its contents through a matching (or longer) closing fence, or
// EOF for an unfinished response; a shorter nested fence is literal code.
// ~~~ fences, longer fences and multi-backtick spans are all kept verbatim
// (janhq/jan#9364).
function maskCode(input: string, store: string[]): string {
  const save = (code: string) => tok('C', store.push(code) - 1)
  const inline = (text: string): string => {
    const runs = /`+/g
    let result = ''
    let cursor = 0
    let open: RegExpExecArray | null
    while ((open = runs.exec(text)) !== null) {
      const endOfOpen = runs.lastIndex
      let close: RegExpExecArray | null
      while ((close = runs.exec(text)) !== null) {
        if (close[0].length === open[0].length) break
      }
      if (!close) {
        // An unmatched run is prose; a later run can still open a code span.
        runs.lastIndex = endOfOpen
        continue
      }
      result += text.slice(cursor, open.index)
      result += save(text.slice(open.index, runs.lastIndex))
      cursor = runs.lastIndex
    }
    return result + text.slice(cursor)
  }

  const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm
  let result = ''
  let cursor = 0
  let open: RegExpExecArray | null
  while ((open = fences.exec(input)) !== null) {
    const marker = open[1]
    // Backticks in the info string do not form a CommonMark fence.
    if (marker[0] === '`' && open[2].includes('`')) continue
    const closing = new RegExp(
      `^ {0,3}${marker[0]}{${marker.length},}[\\t ]*\\r?$`,
      'gm'
    )
    closing.lastIndex = fences.lastIndex
    const close = closing.exec(input)
    const end = close ? closing.lastIndex : input.length
    result += inline(input.slice(cursor, open.index))
    result += save(input.slice(open.index, end))
    cursor = end
    fences.lastIndex = end
    if (!close) break
  }
  return result + inline(input.slice(cursor))
}
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

// Inline math sets fractions in text style, which shrinks a quadratic formula
// to unreadable. A leading \displaystyle gives them display size; it stays
// inline, so the line is only as tall as the fraction needs.
export const inlineFractions = (expr: string): string =>
  /\\[dt]?frac(?![a-zA-Z])/.test(expr) && !/^\s*\\displaystyle(?![a-zA-Z])/.test(expr)
    ? `\\displaystyle ${expr}`
    : expr

// Cache for normalized LaTeX content
const latexCache = new Map<string, string>()

export const normalizeLatex = (input: string): string => {
  if (latexCache.has(input)) return latexCache.get(input)!

  const code: string[] = []
  const math: string[] = []

  let s = maskBracketMath(maskCode(input, code), math)

  s = maskInlineMath(s, math)
  s = s.replace(/\$(?=\d)/g, '\\$') // leftover currency renders literally
  s = fixEmphasisFlanking(s)

  // A `$$...$$` that is alone on its line is display math. Left on one line,
  // remark-math reads it as inline math, which shrinks fractions and sums.
  s = s.replace(/^([ \t]*)\uE000L(\d+)\uE000[ \t]*$/gm, (whole, indent, n) => {
    const expr = math[Number(n)]
    if (!expr.startsWith('$$') || expr.includes('\n')) return whole
    return `${indent}$$\n${expr.slice(2, -2).trim()}\n${indent}$$`
  })

  // Restore math, converting bracket delimiters to $… / $$… for remark-math.
  s = s.replace(/\uE000L(\d+)\uE000/g, (_, n) => {
    const expr = math[Number(n)]
    if (expr.startsWith('\\[')) return `$$\n${expr.slice(2, -2).trim()}\n$$`
    if (expr.startsWith('\\(')) return `$${inlineFractions(expr.slice(2, -2).trim())}$`
    if (!expr.startsWith('$$') && expr.length > 2)
      return `$${inlineFractions(expr.slice(1, -1))}$`
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

const CODE_BLOCK_SELECTOR = '[data-streamdown="code-block"]'
const CODE_BODY_SELECTOR = '[data-streamdown="code-block-body"]'
const DOWNLOAD_BUTTON_SELECTOR = '[data-streamdown="code-block-download-button"]'

// Streamdown saves every code block as `file.<ext>` and has no filename hook.
// For a block whose fence or first-line comment names its file, take the click
// before Streamdown's own handler and save the code under that name instead;
// any other block keeps Streamdown's behavior.
function saveNamedCodeBlock(
  event: React.MouseEvent<HTMLElement>,
  markdown: string
) {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest(DOWNLOAD_BUTTON_SELECTOR)
  if (!button) return
  const body = button
    .closest(CODE_BLOCK_SELECTOR)
    ?.querySelector(CODE_BODY_SELECTOR)
  const named = body ? findNamedBlock(markdown, body.textContent ?? '') : null
  if (!named) return

  event.preventDefault()
  event.stopPropagation()
  const url = URL.createObjectURL(
    new Blob([named.code], { type: 'text/plain' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = named.fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
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
  const showInlineCitations = useInterfaceSettings((s) => s.showInlineCitations)
  const wrapCodeLines = useInterfaceSettings((s) => s.wrapCodeLines)
  const rootRef = useRef<HTMLDivElement>(null)

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
        isStreaming ? effectiveContent : normalizeLatex(effectiveContent),
        showInlineCitations
      ),
    [effectiveContent, isStreaming, showInlineCitations]
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
      // A web link opens outside the app, never replacing the chat.
      if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
        return (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      }
      // mailto opens the mail client; an in-page #fragment (footnotes) cannot
      // leave the document. Every other scheme (javascript:, data:, file:,
      // jan://, relative or protocol-relative paths) renders as plain text.
      if (
        typeof href === 'string' &&
        (/^mailto:/i.test(href) || /^#[^/\\]*$/.test(href))
      ) {
        return <a {...props}>{children}</a>
      }
      return <>{children}</>
    }
    return {
      a: Anchor,
      table: MarkdownTable,
      img: MarkdownImage,
      ...(components ?? {}),
    } as Components
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
      ref={rootRef}
      data-code-wrap={wrapCodeLines ? 'on' : undefined}
      onClickCapture={(event) => saveNamedCodeBlock(event, normalizedContent)}
    >
      <CodeWrapToggles
        root={rootRef}
        active={!isStreaming}
        blockKey={messageId}
      />
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
  const isDark = useTheme((s) => s.isDark)
  const mermaidOptions = useMemo(
    () => ({
      config: mermaidConfigFor(isDark),
      ...(messageId
        ? {
            errorComponent: (props: MermaidErrorComponentProps) => (
              <MermaidError messageId={messageId} {...props} />
            ),
          }
        : {}),
    }),
    [messageId, isDark]
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
