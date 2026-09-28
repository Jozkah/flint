/**
 * Bringing an exported worktree bundle into the attached project. AH-169.
 *
 * The person picks a bundle folder; the backend reads it as hostile input,
 * rebuilds its changes against this project's copy of the base commit and
 * stores them as a proposal. That proposal is reviewed here with the same
 * review every other change gets -- files, hunks, flags that need
 * acknowledging -- and applied through an approval that is also bound to this
 * import's hashes and to this destination.
 *
 * Pending imports are read from disk, so they are still here after a
 * restart; one can be abandoned, which rejects its proposal.
 */
import { useCallback, useEffect, useState } from 'react'
import { PackageOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import {
  abandonImport,
  applyImport,
  cancelImport,
  importBundle,
  listImports,
  newImportToken,
  type ImportFailure,
  type ImportView,
} from '@/lib/bundleImport'

function short(sha: string, n = 10) {
  return sha ? sha.slice(0, n) : '—'
}

function ImportRow({
  view,
  session,
  onChanged,
  onApplied,
}: {
  view: ImportView
  session: string
  onChanged: () => void
  onApplied?: () => void
}) {
  const [open, setOpen] = useState(false)
  const pending = view.state === 'pending'
  return (
    <li
      className="rounded-[10px] border-[0.8px] border-border bg-card p-2.5 text-xs"
      data-testid="bundle-import-row"
      data-id={view.id}
      data-state={view.state}
    >
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
        data-testid="bundle-import-origin"
      >
        <dt className="text-muted-foreground">From</dt>
        <dd className="min-w-0 truncate">{view.originRepository || '—'}</dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="min-w-0 truncate font-mono">{view.branch || '—'}</dd>
        <dt className="text-muted-foreground">Base</dt>
        <dd className="font-mono">{short(view.baseSha)}</dd>
        <dt className="text-muted-foreground">Bundle</dt>
        <dd className="font-mono">
          {short(view.bundleSha256, 12)} (schema {view.bundleSchema})
        </dd>
        <dt className="text-muted-foreground">State</dt>
        <dd>{view.state}</dd>
      </dl>
      {pending ? (
        <div className="mt-1 flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((o) => !o)}
            data-testid="bundle-import-review"
          >
            {open ? 'Hide review' : 'Review'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await abandonImport(view.id).catch(() => {})
              onChanged()
            }}
            data-testid="bundle-import-abandon"
          >
            Abandon
          </Button>
        </div>
      ) : null}
      {pending && open && view.proposal ? (
        <div className="mt-1">
          <CoworkProposalReview
            worktree={{ path: `bundle:${view.id}`, sourceRoot: view.destination }}
            session={session}
            title="Imported bundle"
            propose={async () => ({ ok: true, proposal: view.proposal! })}
            applyWith={(approval) => applyImport(view, approval)}
            onApplied={() => {
              onApplied?.()
              onChanged()
            }}
          />
        </div>
      ) : null}
    </li>
  )
}

export function CoworkBundleImport({
  destination,
  session,
  pickFolder,
  onApplied,
}: {
  destination: string
  session: string
  pickFolder: () => Promise<string | null>
  onApplied?: () => void
}) {
  const [imports, setImports] = useState<ImportView[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<ImportFailure | null>(null)

  const load = useCallback(async () => {
    setImports(await listImports(destination))
  }, [destination])

  useEffect(() => {
    void load()
  }, [load])

  const start = async () => {
    setError(null)
    const bundle = await pickFolder()
    if (!bundle) return
    const token = newImportToken()
    setRunning(token)
    const out = await importBundle(token, bundle, destination)
    setRunning(null)
    if (!out.ok) {
      setError(out)
      return
    }
    await load()
  }

  const shown = imports.filter((v) => v.state === 'pending' || v.state === 'applied' || v.state === 'partially-applied')

  // Nothing imported, nothing running, nothing wrong: one quiet link, not a
  // card, at the foot of the panel.
  if (shown.length === 0 && !running && !error) {
    return (
      <div className="mx-3 mb-3 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={() => void start()}
          data-testid="bundle-import"
        >
          <PackageOpen size={13} aria-hidden />
          Import patch bundle
        </Button>
      </div>
    )
  }

  return (
    <section
      className="mx-3 mb-3 rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)] p-3 motion-safe:animate-rise-in"
      data-testid="bundle-imports"
      aria-label="Imported patch bundles"
    >
      <div className="flex items-center gap-2">
        <PackageOpen size={14} className="text-muted-foreground" />
        <p className="flex-1 text-[12.5px] font-medium text-foreground">
          Patch bundles for this project
        </p>
        {running ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void cancelImport(running)}
            data-testid="bundle-import-cancel"
          >
            Stop import
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void start()}
            data-testid="bundle-import"
          >
            Import patch bundle
          </Button>
        )}
      </div>
      {running ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="bundle-import-running">
          Checking the bundle…
        </p>
      ) : null}
      {error ? (
        <p
          className="mt-1 text-xs text-destructive"
          role="alert"
          data-testid="bundle-import-error"
          data-kind={error.kind}
        >
          {error.message}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {shown.map((view) => (
            <ImportRow
              key={view.id}
              view={view}
              session={session}
              onChanged={() => void load()}
              onApplied={onApplied}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
