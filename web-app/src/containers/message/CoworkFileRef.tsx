import type { ReactNode } from 'react'
import { useCodeOpen } from '@/lib/codeOpen'
import { parseFileRefHref } from '@/lib/coworkFileRefs'
import { cn } from '@/lib/utils'

/**
 * Renders a detected `@path` file reference from an assistant message.
 *
 * Clickable only where a code-panel opener is provided (Cowork) AND the encoded
 * path re-validates as a safe, contained reference. Everywhere else — the chat
 * surface has no opener, and a tampered href fails re-validation — it degrades
 * to plain text, so a reference can never open the wrong file or nothing.
 *
 * Opening is delegated to the same opener the structured tool widgets use, which
 * resolves the path against the attached project or the session sandbox and
 * shows the Code panel's missing-file state if it no longer exists. Verification
 * therefore happens at click time against the real workspace, not by trusting
 * the text.
 */
export function CoworkFileRef({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children?: ReactNode
}) {
  const open = useCodeOpen()
  const ref = parseFileRefHref(href)

  if (!open || !ref) {
    return <span className={className}>{children}</span>
  }

  const label = ref.line
    ? `${ref.path}:${ref.line}${ref.endLine ? `-${ref.endLine}` : ''}`
    : ref.path

  return (
    <button
      type="button"
      onClick={() => open(ref.path)}
      title={label}
      className={cn(
        'cursor-pointer rounded bg-sunken px-1 font-mono text-[0.9em] text-brand-text underline decoration-dotted underline-offset-2 hover:bg-brand-tint focus-visible:outline-2 focus-visible:outline-ring',
        className
      )}
    >
      {children}
    </button>
  )
}
