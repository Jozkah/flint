import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import {
  Bold,
  Braces,
  Code,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MentionPreview } from '@/lib/chatMentionPreview'
import { MentionPills, pillLabels, previewForToken, setMentionLabels } from '@/lib/mentionPills'
import { MentionHoverCard } from '@/containers/MentionHoverCard'

export type RichComposerHandle = {
  focus: () => void
  element: HTMLElement | null
  /** Caret at the very start/end of the draft (collapsed), else null. */
  caretEdge: () => 'start' | 'end' | 'both' | null
  /** Insert plain text at the caret, one paragraph per line. */
  insertText: (text: string) => void
}

type Props = {
  value: string
  onChange: (markdown: string) => void
  onSend: (markdown: string, steer: boolean) => void
  onPaste: (event: ClipboardEvent) => void
  onKeyDownCapture?: (event: KeyboardEvent) => void
  /** Plain Enter adds a new line; only Ctrl/Cmd+Enter or the send button sends. */
  enterInsertsNewline?: boolean
  placeholder: string
  className?: string
  /** Extra attributes for the editable element (aria, spellcheck, test id). */
  domAttributes?: Record<string, string | undefined>
  /** What the draft's conversation mentions resolve to; drawn as pills. */
  mentions?: MentionPreview[]
}

/** Inline formatting with Markdown as the saved and sent message format. */
export const RichComposerEditor = forwardRef<RichComposerHandle, Props>(
  function RichComposerEditor({ value, onChange, onSend, onPaste, onKeyDownCapture, enterInsertsNewline, placeholder, className, domAttributes, mentions }, ref) {
    const { t } = useTranslation()
    // Read at key time: the editor's key handler is created once.
    const enterNewlineRef = useRef(enterInsertsNewline)
    enterNewlineRef.current = enterInsertsNewline
    const tRef = useRef(t)
    tRef.current = t
    const wrapRef = useRef<HTMLDivElement>(null)
    const [hover, setHover] = useState<{ token: string; rect: DOMRect } | null>(null)
    const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const keepCard = () => clearTimeout(leaveTimer.current)
    const dropCard = () => {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = setTimeout(() => setHover(null), 150)
    }
    const hoverOpenRef = useRef(false)
    hoverOpenRef.current = hover !== null
    const hoverRef = useRef({ keepCard, dropCard })
    hoverRef.current = { keepCard, dropCard }
    const pills = useMemo(
      () =>
        MentionPills.configure({
          describe: (kind, title) =>
            `${tRef.current(`common:mentions.kind.${kind}`)}: ${title}`,
          onHover: (token, rect) => {
            if (token && rect) {
              hoverRef.current.keepCard()
              setHover({ token, rect })
            } else {
              hoverRef.current.dropCard()
            }
          },
        }),
      []
    )
    const editor = useEditor({
      extensions: [StarterKit, Markdown, pills],
      content: value,
      contentType: 'markdown',
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
      editorProps: {
        // A function, so the label follows a live language switch.
        attributes: () => ({
          role: 'textbox',
          'aria-label': tRef.current('common:composer.messageLabel'),
          'aria-multiline': 'true',
          class: 'min-h-10 max-h-60 overflow-y-auto outline-none',
        }),
        handleKeyDown: (_view, event) => {
          if (event.defaultPrevented) return true
          if (event.key === 'Escape' && hoverOpenRef.current) {
            setHover(null)
            return true
          }
          if (editor?.isActive('codeBlock') && !event.ctrlKey && !event.metaKey) {
            return false
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            // With "Enter adds a new line" on, leave plain Enter to the editor.
            if (enterNewlineRef.current && !event.ctrlKey && !event.metaKey) {
              return false
            }
            event.preventDefault()
            const markdown = editor?.getMarkdown() ?? ''
            onSend(markdown, event.ctrlKey || event.metaKey)
            return true
          }
          return false
        },
      },
    })

    // Titles arrive after a lookup; the pills redraw with them.
    useEffect(() => {
      if (!editor || editor.isDestroyed) return
      const tokens = (value.match(/@(?:chat|session|room):[A-Za-z0-9][A-Za-z0-9_.-]*(?:#summary)?/g) ?? []).map((m) => m.slice(1))
      setMentionLabels(editor.view, pillLabels(tokens, mentions ?? []))
    }, [editor, mentions, value])

    // A pill that went away takes its card with it.
    useEffect(() => {
      if (hover && !value.includes(`@${hover.token}`)) setHover(null)
    }, [hover, value])

    useEffect(() => {
      const dom = editor?.view.dom
      if (!dom || !domAttributes) return
      const applied: string[] = []
      for (const [name, value] of Object.entries(domAttributes)) {
        if (value === undefined) continue
        dom.setAttribute(name, value)
        applied.push(name)
      }
      return () => applied.forEach((name) => dom.removeAttribute(name))
    }, [editor, domAttributes])

    useImperativeHandle(ref, () => ({
      focus: () => editor?.commands.focus(),
      element: editor?.view.dom ?? null,
      caretEdge: () => {
        if (!editor) return null
        const { empty, from, to } = editor.state.selection
        if (!empty) return null
        const atStart = from <= 1
        const atEnd = to >= editor.state.doc.content.size - 1
        return atStart && atEnd ? 'both' : atStart ? 'start' : atEnd ? 'end' : null
      },
      insertText: (text) => {
        const paragraphs = text.split(/\r\n?|\n/).map((line) => ({
          type: 'paragraph',
          content: line ? [{ type: 'text', text: line }] : [],
        }))
        editor?.chain().focus().insertContent(paragraphs).run()
      },
    }), [editor])

    // Drafts can change outside this editor (queue edit, slash command, send).
    // Do not replace the document while it already matches: that loses caret.
    useEffect(() => {
      if (editor && editor.getMarkdown() !== value) {
        editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
      }
    }, [editor, value])

    // The formatting bar only appears over a text selection, so the composer
    // stays one clean field. Markdown shortcuts and Ctrl/Cmd+B/I work always.
    const selecting = useEditorState({
      editor,
      selector: ({ editor: e }) => !!e && !e.state.selection.empty && e.isFocused,
    })

    const button = (
      label: string,
      icon: ReactNode,
      action: () => void,
      active: boolean
    ) => (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={action}
        className={cn(
          'grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
          active && 'bg-accent text-foreground'
        )}
      >
        {icon}
      </button>
    )

    return (
      <div ref={wrapRef} className={cn('relative px-3 pt-3 pb-1', className)}>
        {selecting && (
          <div
            role="toolbar"
            aria-label="Text formatting"
            className="absolute -top-9 left-3 z-10 flex gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          >
            {button('Bold', <Bold size={14} />, () => editor?.chain().focus().toggleBold().run(), !!editor?.isActive('bold'))}
            {button('Italic', <Italic size={14} />, () => editor?.chain().focus().toggleItalic().run(), !!editor?.isActive('italic'))}
            {button('Quote', <Quote size={14} />, () => editor?.chain().focus().toggleBlockquote().run(), !!editor?.isActive('blockquote'))}
            {button('Inline code', <Code size={14} />, () => editor?.chain().focus().toggleCode().run(), !!editor?.isActive('code'))}
            {button('Code block', <Braces size={14} />, () => editor?.chain().focus().toggleCodeBlock().run(), !!editor?.isActive('codeBlock'))}
            {button('Heading', <Heading2 size={14} />, () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), !!editor?.isActive('heading', { level: 2 }))}
            {button('Bullet list', <List size={14} />, () => editor?.chain().focus().toggleBulletList().run(), !!editor?.isActive('bulletList'))}
            {button('Numbered list', <ListOrdered size={14} />, () => editor?.chain().focus().toggleOrderedList().run(), !!editor?.isActive('orderedList'))}
          </div>
        )}
        <div
          className="relative text-[13.5px] leading-normal text-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-code-bg [&_code]:px-1 [&_h2]:text-lg [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-code-bg [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
          onPasteCapture={onPaste}
          onKeyDownCapture={onKeyDownCapture}
        >
          {!value.trim() && <span aria-hidden className="pointer-events-none absolute text-muted-foreground">{placeholder}</span>}
          <EditorContent editor={editor} />
        </div>
        {hover && wrapRef.current && (() => {
          const box = wrapRef.current.getBoundingClientRect()
          const left = Math.max(8, Math.min(hover.rect.left - box.left, box.width - 296))
          return (
            <MentionHoverCard
              token={hover.token}
              preview={previewForToken(hover.token, mentions ?? [])}
              style={{ left, bottom: box.bottom - hover.rect.top + 6 }}
              onPointerEnter={keepCard}
              onPointerLeave={dropCard}
            />
          )
        })()}
      </div>
    )
  }
)
