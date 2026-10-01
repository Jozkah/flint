import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { markPathMissing, useKnownMissing } from '@/lib/missingPaths'
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
  const { check, exists } = useCodeOpenTools()
  const roots = usePathRoots()
  const { t } = useTranslation()
  const parsed = parsePathHref(href)
  const knownMissing = useKnownMissing(roots, parsed?.path ?? '')
  if (!parsed) return <>{children}</>

  const action = classifyPath(parsed, {
    roots,
    canOpenInCode: !!open && (check ? check(parsed.path).ok : true),
  })
  if (action.kind === 'none') return <>{children}</>

  const run = (background: boolean) => {
    if (action.kind === 'code') {
      // Existence is checked here, on the click: detection stays lexical, so
      // a name in prose that looks like a file is only found wrong when used.
      // Without a way to check (the surface offers none) the open goes ahead.
      if (!exists) {
        open?.(action.path, { line: parsed.line, background })
        return
      }
      void exists(action.path)
        .catch(() => true)
        .then((found) => {
          markPathMissing(roots, parsed.path, !found)
          if (!found) {
            toast.info(t('common:codePanel.pathNotFound', { name: parsed.path }))
            return
          }
          open?.(action.path, { line: parsed.line, background })
        })
    } else {
      // The Rust side re-checks containment (symlinks, case, `..`) and
      // refuses to open an executable; the webview never names a raw path to
      // the opener plugin.
      void getServiceHub()
        .core()
        .invoke('open_session_path', {
          roots: [...roots],
          path: action.path,
          mode: action.kind === 'open' ? 'open' : 'reveal',
        })
        .catch((error: unknown) =>
          console.error('Could not open path:', error)
        )
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
      title={
        knownMissing
          ? t('common:codePanel.pathNotFound', { name: parsed.path })
          : action.path
      }
      data-missing={knownMissing ? 'true' : undefined}
      className={cn(
        'cursor-pointer text-acc-text underline decoration-dotted underline-offset-2 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
        knownMissing && 'opacity-50',
        className
      )}
    >
      {children}
    </button>
  )
}
