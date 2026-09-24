import { useEffect, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'

/** Must match `PREVIEW_SCHEME` in `src-tauri/src/core/preview.rs`. */
export const PREVIEW_SCHEME = 'flintpreview'

/** Props to spread on a preview iframe: a URL or an inline document. */
export type PreviewSource = { src: string } | { srcDoc: string }

/** Only the desktop app registers the preview scheme; web builds and jsdom
 * tests have no Tauri runtime and keep using `srcdoc`. */
export function previewProtocolAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  )
}

/**
 * Decide how to load a preview document.
 *
 * `srcdoc` inherits the app's CSP, whose `script-src` has no `'unsafe-inline'`,
 * so in a release build every inline script in it is blocked (#135). Where the
 * `flintpreview:` scheme exists the document is served from it instead, with
 * its own CSP header. Until the id arrives the frame stays blank rather than
 * flashing a script-dead srcdoc; if registration fails, srcdoc is the fallback.
 */
export function choosePreviewSource(
  doc: string,
  opts: { protocol: boolean; id: string | null; failed: boolean }
): PreviewSource {
  if (!opts.protocol || opts.failed) return { srcDoc: doc }
  if (opts.id) return { src: convertFileSrc(opts.id, PREVIEW_SCHEME) }
  return { src: 'about:blank' }
}

/**
 * Register `doc` with the preview scheme for as long as it is shown, and
 * release it when the preview unmounts or the document is replaced.
 */
export function usePreviewSource(
  doc: string,
  allowNetwork: boolean,
  allowScripts: boolean
): PreviewSource {
  const protocol = previewProtocolAvailable()
  const [entry, setEntry] = useState<{
    doc: string
    id: string | null
    failed: boolean
  }>({ doc, id: null, failed: false })

  useEffect(() => {
    if (!protocol || !doc) return
    let cancelled = false
    let registered: string | null = null
    invoke<string>('preview_register', {
      html: doc,
      allowNetwork,
      allowScripts,
    }).then(
      (id) => {
        if (cancelled) {
          void invoke('preview_release', { id }).catch(() => {})
          return
        }
        registered = id
        setEntry({ doc, id, failed: false })
      },
      () => {
        if (!cancelled) setEntry({ doc, id: null, failed: true })
      }
    )
    return () => {
      cancelled = true
      if (registered) {
        void invoke('preview_release', { id: registered }).catch(() => {})
      }
    }
  }, [protocol, doc, allowNetwork, allowScripts])

  // An entry for an older document must not be shown for the new one.
  const current = entry.doc === doc ? entry : { id: null, failed: false }
  return choosePreviewSource(doc, {
    protocol: protocol && !!doc,
    id: current.id,
    failed: current.failed,
  })
}
