import { forwardRef, useEffect, useImperativeHandle } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
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

export type RichComposerHandle = {
  focus: () => void
  element: HTMLElement | null
}

type Props = {
  value: string
  onChange: (markdown: string) => void
  onSend: (markdown: string, steer: boolean) => void
  onPaste: (event: ClipboardEvent) => void
  onKeyDownCapture?: (event: KeyboardEvent) => void
  placeholder: string
  className?: string
}

/** Inline formatting with Markdown as the saved and sent message format. */
export const RichComposerEditor = forwardRef<RichComposerHandle, Props>(
  function RichComposerEditor({ value, onChange, onSend, onPaste, onKeyDownCapture, placeholder, className }, ref) {
    const editor = useEditor({
      extensions: [StarterKit, Markdown],
      content: value,
      contentType: 'markdown',
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': 'Message',
          'aria-multiline': 'true',
          class: 'min-h-14 max-h-60 overflow-y-auto outline-none',
        },
        handleKeyDown: (_view, event) => {
          if (event.defaultPrevented) return true
          if (editor?.isActive('codeBlock') && !event.ctrlKey && !event.metaKey) {
            return false
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault()
            const markdown = editor?.getMarkdown() ?? ''
            onSend(markdown, event.ctrlKey || event.metaKey)
            return true
          }
          return false
        },
      },
    })

    useImperativeHandle(ref, () => ({
      focus: () => editor?.commands.focus(),
      element: editor?.view.dom ?? null,
    }), [editor])

    // Drafts can change outside this editor (queue edit, slash command, send).
    // Do not replace the document while it already matches: that loses caret.
    useEffect(() => {
      if (editor && editor.getMarkdown() !== value) {
        editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
      }
    }, [editor, value])

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
      <div className={cn('px-3 pt-2 pb-1', className)}>
        <div role="toolbar" aria-label="Text formatting" className="mb-2 flex flex-wrap gap-0.5 border-b border-border pb-1">
          {button('Bold', <Bold size={14} />, () => editor?.chain().focus().toggleBold().run(), !!editor?.isActive('bold'))}
          {button('Italic', <Italic size={14} />, () => editor?.chain().focus().toggleItalic().run(), !!editor?.isActive('italic'))}
          {button('Quote', <Quote size={14} />, () => editor?.chain().focus().toggleBlockquote().run(), !!editor?.isActive('blockquote'))}
          {button('Inline code', <Code size={14} />, () => editor?.chain().focus().toggleCode().run(), !!editor?.isActive('code'))}
          {button('Code block', <Braces size={14} />, () => editor?.chain().focus().toggleCodeBlock().run(), !!editor?.isActive('codeBlock'))}
          {button('Heading', <Heading2 size={14} />, () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), !!editor?.isActive('heading', { level: 2 }))}
          {button('Bullet list', <List size={14} />, () => editor?.chain().focus().toggleBulletList().run(), !!editor?.isActive('bulletList'))}
          {button('Numbered list', <ListOrdered size={14} />, () => editor?.chain().focus().toggleOrderedList().run(), !!editor?.isActive('orderedList'))}
        </div>
        <div
          className="relative text-[13.5px] leading-normal text-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-code-bg [&_code]:px-1 [&_h2]:text-lg [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-code-bg [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
          onPasteCapture={onPaste}
          onKeyDownCapture={onKeyDownCapture}
        >
          {!value.trim() && <span aria-hidden className="pointer-events-none absolute text-muted-foreground">{placeholder}</span>}
          <EditorContent editor={editor} />
        </div>
      </div>
    )
  }
)
