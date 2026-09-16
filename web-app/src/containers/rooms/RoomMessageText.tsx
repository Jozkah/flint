import { memo, useMemo } from 'react'
import type { Components } from 'react-markdown'
import { RenderMarkdown } from '@/containers/RenderMarkdown'

/**
 * A room message rendered as markdown (so a participant can write **bold**,
 * lists, code, etc.) with `@mentions` of other participants colored in that
 * participant's own color.
 *
 * Mentions are turned into a markdown link whose href carries the color, and an
 * anchor override paints them; doing it before the markdown parse keeps the rest
 * of the message -- bold, code fences, links -- rendering normally.
 */

const MENTION_PREFIX = '#roommention-'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Pseudo tool-call wrappers models sometimes emit around a command. */
const TOOL_TAGS = /<\/?(?:bash|shell|sh|cmd|powershell|python|tool|tool_call)>/gi

/**
 * Repair the tool-call syntax some models emit as prose. They wrap a command in
 * `<bash>…</bash>` and put a whole ```` ```lang … ``` ```` fence on one line, so
 * markdown renders it as a jumbled paragraph rather than a code block. Strip the
 * wrapper tags and reflow an inline fence onto its own lines. A well-formed
 * fence (a newline after the language) is left untouched, since the reflow only
 * matches a fence whose content starts on the same line.
 */
function normalizeToolBlocks(text: string): string {
  if (!text.includes('```') && !TOOL_TAGS.test(text)) {
    TOOL_TAGS.lastIndex = 0
    return text
  }
  TOOL_TAGS.lastIndex = 0
  return text
    .replace(TOOL_TAGS, '')
    .replace(/```([\w+-]*)[ \t]+([\s\S]*?)```/g, (_m, lang: string, body: string) => {
      return `\n\`\`\`${lang}\n${body.trim()}\n\`\`\`\n`
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Encode a color for the mention href. Parens must be escaped too (not escaped
 * by encodeURIComponent) or a value like `var(--primary)` would close the
 * markdown link early at its first `)`.
 */
function encodeColor(color: string): string {
  return encodeURIComponent(color).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/** Rewrite `@Name` for known participants into a color-carrying markdown link. */
function linkifyMentions(text: string, colors: Map<string, string>): string {
  if (colors.size === 0 || !text.includes('@')) return text
  // Longest names first so "@Ada Lovelace" wins over "@Ada".
  const names = [...colors.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})\\b`, 'gi')
  return text.replace(pattern, (match, name: string) => {
    const color = colors.get(name.toLowerCase())
    if (!color) return match
    return `[${match}](${MENTION_PREFIX}${encodeColor(color)})`
  })
}

const MentionAnchor = (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
  const href = props.href ?? ''
  if (href.startsWith(MENTION_PREFIX)) {
    const color = decodeURIComponent(href.slice(MENTION_PREFIX.length))
    return (
      <span className="font-semibold" style={{ color }} data-room-mention>
        {props.children}
      </span>
    )
  }
  // A plain link in a discussion: open away from the app, without leaking a
  // referrer.
  return (
    <a {...props} target="_blank" rel="noreferrer noopener">
      {props.children}
    </a>
  )
}

const COMPONENTS: Components = { a: MentionAnchor }

export const RoomMessageText = memo(function RoomMessageText({
  text,
  mentionColors,
  isStreaming,
  className,
}: {
  text: string
  mentionColors: Map<string, string>
  isStreaming?: boolean
  className?: string
}) {
  const content = useMemo(
    () => linkifyMentions(normalizeToolBlocks(text), mentionColors),
    [text, mentionColors]
  )
  return (
    <RenderMarkdown
      content={content}
      components={COMPONENTS}
      isStreaming={isStreaming}
      className={className}
    />
  )
})
