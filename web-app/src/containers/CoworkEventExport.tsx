/**
 * Exporting a session's canonical events, and reading an export back.
 * AH-177.
 *
 * Metadata only by default. Including content -- prompts, tool inputs and
 * outputs, paths -- takes an explicit tick, with what that means said beside
 * it. The export is written under Flint's data folder; nothing is uploaded.
 * Inspecting an export reads it as untrusted input and only reports what is
 * in it.
 */
import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { DetailsCard } from '@/containers/DetailsCard'
import {
  cancelEventExport,
  exportEvents,
  inspectEventExport,
  newExportToken,
  type ExportErrorKind,
  type InspectReport,
} from '@/lib/eventLog'

export function CoworkEventExport({
  sessionId,
  pickFolder,
}: {
  sessionId: string | null | undefined
  pickFolder: () => Promise<string | null>
}) {
  const { t } = useTranslation()
  const [includeContent, setIncludeContent] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [exported, setExported] = useState<{ path: string; count: number; metadataOnly: boolean } | null>(null)
  const [error, setError] = useState<{ kind: ExportErrorKind; message: string } | null>(null)
  const [inspected, setInspected] = useState<InspectReport | null>(null)

  if (!sessionId) return null

  const run = async () => {
    setError(null)
    setExported(null)
    const token = newExportToken()
    setRunning(token)
    const out = await exportEvents({ token, session: sessionId, includeContent })
    setRunning(null)
    if (!out.ok) {
      setError(out)
      return
    }
    setExported({ path: out.path, count: out.manifest.count, metadataOnly: out.manifest.metadataOnly })
  }

  const inspect = async () => {
    setError(null)
    setInspected(null)
    const path = await pickFolder()
    if (!path) return
    const out = await inspectEventExport(path)
    if (!out.ok) {
      setError(out)
      return
    }
    setInspected(out)
  }

  return (
    <DetailsCard
      aria-label={t('sweep:cowork.eventExportLabel')}
      data-testid="event-export"
      title={t('sweep:cowork.sessionEvents')}
      // The actions on the heading's row and the one option under it, as
      // the design lays out the session events box.
      actions={
        <>
          <Button size="sm" variant="ghost" className="-my-1" onClick={() => void inspect()} data-testid="event-inspect">
            {t('sweep:cowork.inspectExport')}
          </Button>
          {running ? (
            <Button size="sm" variant="outline" className="-my-1" onClick={() => void cancelEventExport(running)} data-testid="event-export-cancel">
              {t('sweep:cowork.stopExport')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="-my-1" onClick={() => void run()} data-testid="event-export-run">
              {t('sweep:cowork.exportEvents')}
            </Button>
          )}
        </>
      }
    >
      <label className="flex cursor-pointer items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] leading-5 text-foreground">
            {t('sweep:cowork.includeContent')}
          </span>
          {includeContent ? (
            <span className="block text-warning" data-testid="event-export-warning">
              {t('sweep:cowork.exportWarning')}
            </span>
          ) : (
            <span className="block text-muted-foreground">
              {t('sweep:cowork.exportMetadataOnly')}
            </span>
          )}
        </span>
        {/* A real checkbox drawn as a switch: it keeps `checked` for
            everything that reads it, and the keyboard behaviour of one. */}
        <input
          type="checkbox"
          role="switch"
          aria-checked={includeContent}
          checked={includeContent}
          onChange={(e) => setIncludeContent(e.target.checked)}
          data-testid="event-export-content"
          className="relative h-[18px] w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-track outline-none transition-colors duration-200 ease-expo before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-white before:shadow-sm before:transition-transform before:duration-200 before:ease-expo checked:bg-primary checked:before:translate-x-3.5 focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
      </label>
      {exported ? (
        <p className="break-all text-fg-2" data-testid="event-export-path" data-count={exported.count} data-metadata-only={String(exported.metadataOnly)}>
          {exported.count} event(s){exported.metadataOnly ? ', metadata only,' : ', with content,'} written to {exported.path}
        </p>
      ) : null}
      {inspected ? (
        <div data-testid="event-inspect-summary" data-count={inspected.manifest.count} data-session={inspected.manifest.session}>
          <p>
            {inspected.manifest.count} event(s) of session{' '}
            <span className="font-mono">{inspected.manifest.session}</span>, sequence{' '}
            {inspected.manifest.firstSeq}–{inspected.manifest.lastSeq}
            {inspected.manifest.metadataOnly ? ', metadata only' : ', with content'}
          </p>
          <ul className="ml-4 list-disc">
            {Object.entries(inspected.kinds).map(([kind, n]) => (
              <li key={kind} className="font-mono">
                {kind}: {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p className="text-destructive" role="alert" data-testid="event-export-error" data-kind={error.kind}>
          {error.message}
        </p>
      ) : null}
    </DetailsCard>
  )
}
