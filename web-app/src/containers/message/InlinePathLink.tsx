import type { ReactNode } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  openInBackground,
  useCodeOpen,
  useCodeOpenTools,
  usePathRoots,
} from '@/lib/codeOpen'
import { classifyPath, parsePathHref } from '@/lib/pathOpen'
import { cn } from '@/lib/utils'

/**
 * An inline-code path from a reply, as a link.
 *
 * The href is re-parsed and re-classified here, against the folders this
 * surface holds. Where the path may not be opened (outside every folder, no
 * code panel for a relative path) it renders as the plain code it was.
 * Source files go to the Code panel where there is one; everything else opens
 * in the OS, and executables are only revealed.
 */
export function InlinePathLink({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children?: ReactNode
}) {
  const open = useCodeOpen()
  const { check } = useCodeOpenTools()
  const roots = usePathRoots()
  const parsed = parsePathHref(href)
  if (!parsed) return <>{children}</>

  const action = classifyPath(parsed, {
    roots,
    canOpenInCode: !!open && (check ? check(parsed.path).ok : true),
  })
  if (action.kind === 'none') return <>{children}</>

  const run = (background: boolean) => {
    if (action.kind === 'code') {
      open?.(action.path, { line: parsed.line, background })
    } else if (action.kind === 'open') {
      void getServiceHub().opener().openPath(action.path)
    } else {
      void getServiceHub().opener().revealItemInDir(action.path)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => run(openInBackground(e))}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        run(true)
      }}
      title={action.path}
      className={cn(
        'cursor-pointer text-acc-text underline decoration-dotted underline-offset-2 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
        className
      )}
    >
      {children}
    </button>
  )
}
