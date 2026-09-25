import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, OctagonAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { invalidateSkills } from '@/hooks/useSkills'
import {
  ccImport,
  ccScan,
  type CcImportResult,
  type CcImportSelection,
  type CcItem,
} from '@/lib/extensionsStore'

/** Inline error row, matching the pattern used by PluginsManagerDialog. */
const ALERT = 'flex items-start gap-1.5 text-xs text-destructive break-words'

/** Group scan results by their reported origin, preserving first-seen order. */
function groupByOrigin(items: CcItem[]): Map<string, CcItem[]> {
  const groups = new Map<string, CcItem[]>()
  for (const item of items) {
    const list = groups.get(item.origin)
    if (list) list.push(item)
    else groups.set(item.origin, [item])
  }
  return groups
}

/** Stable key for an item within the selection map. */
const itemKey = (item: CcItem) => `${item.kind}:${item.name}:${item.sourcePath}`

/**
 * Dialog to import Claude Code skills/plugins found on disk into Jan.
 *
 * Scanning is read-only and always goes through `ccScan`; the items it
 * returns are the only source of `sourcePath` ever sent to `ccImport` -- the
 * scan root the user types is never itself treated as an item path.
 */
export default function ImportFromClaudeCodeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()

  const [root, setRoot] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [items, setItems] = useState<CcItem[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [overwrite, setOverwrite] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [result, setResult] = useState<CcImportResult | null>(null)

  const grouped = useMemo(() => groupByOrigin(items), [items])

  const scan = async () => {
    setScanning(true)
    setScanError(null)
    setResult(null)
    try {
      const res = await ccScan(root.trim() || undefined)
      setItems(res.items)
      const next: Record<string, boolean> = {}
      for (const item of res.items) next[itemKey(item)] = !item.alreadyExists
      setSelected(next)
    } catch (e) {
      setScanError(t('common:extensionsManager.import.scanFailed', { error: String(e) }))
      setItems([])
      setSelected({})
    } finally {
      setScanning(false)
    }
  }

  const toggleItem = (item: CcItem, checked: boolean) => {
    setSelected((s) => ({ ...s, [itemKey(item)]: checked }))
  }

  const runImport = async () => {
    const chosen: CcImportSelection[] = items
      .filter((item) => selected[itemKey(item)])
      .map(({ kind, name, sourcePath }) => ({ kind, name, sourcePath }))
    if (chosen.length === 0) return
    setImporting(true)
    setImportError(null)
    setResult(null)
    try {
      const res = await ccImport(chosen, overwrite)
      setResult(res)
      invalidateSkills()
      toast.success(
        t('common:extensionsManager.import.done', {
          imported: res.imported.length,
          skipped: res.skipped.length,
        })
      )
    } catch (e) {
      setImportError(t('common:extensionsManager.import.importFailed', { error: String(e) }))
    } finally {
      setImporting(false)
    }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('common:extensionsManager.import.title')}</DialogTitle>
          <DialogDescription>
            {t('common:extensionsManager.import.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="cc-import-root">
                {t('common:extensionsManager.import.root')}
              </Label>
              <Input
                id="cc-import-root"
                value={root}
                placeholder={t('common:extensionsManager.import.rootPlaceholder')}
                disabled={scanning}
                onChange={(e) => setRoot(e.target.value)}
              />
            </div>
            <Button size="sm" disabled={scanning} onClick={() => void scan()}>
              {scanning && <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />}
              {t(
                scanning
                  ? 'common:extensionsManager.import.scanning'
                  : 'common:extensionsManager.import.scan'
              )}
            </Button>
          </div>

          {scanError && (
            <p role="alert" className={ALERT}>
              <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">{scanError}</span>
            </p>
          )}

          {items.length > 0 && (
            <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto pr-1">
              {[...grouped.entries()].map(([origin, group]) => (
                <div key={origin} className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted-foreground">{origin}</div>
                  <ul className="flex flex-col gap-1">
                    {group.map((item) => {
                      const key = itemKey(item)
                      const id = `cc-item-${key}`
                      return (
                        <li key={key} className="flex items-center gap-2 text-sm">
                          <input
                            id={id}
                            type="checkbox"
                            checked={selected[key] ?? false}
                            onChange={(e) => toggleItem(item, e.target.checked)}
                          />
                          <Label htmlFor={id} className="flex-1 min-w-0 truncate font-normal">
                            {item.name}
                          </Label>
                          {item.alreadyExists && (
                            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {t('common:extensionsManager.import.installed')}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {items.length === 0 && !scanning && !scanError && (
            <p className="text-xs text-muted-foreground">
              {t('common:extensionsManager.import.empty')}
            </p>
          )}

          {items.length > 0 && (
            <div className="flex items-center gap-2">
              <Switch
                id="cc-import-overwrite"
                checked={overwrite}
                onCheckedChange={setOverwrite}
              />
              <Label htmlFor="cc-import-overwrite" className="text-xs font-normal">
                {t('common:extensionsManager.import.overwrite')}
              </Label>
            </div>
          )}

          {importError && (
            <p role="alert" className={ALERT}>
              <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">{importError}</span>
            </p>
          )}

          {result && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('common:extensionsManager.import.done', {
                imported: result.imported.length,
                skipped: result.skipped.length,
              })}
              {result.errors.length > 0 &&
                ` · ${t('common:extensionsManager.import.doneErrors', { count: result.errors.length })}`}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            disabled={importing || selectedCount === 0}
            onClick={() => void runImport()}
          >
            {importing && <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />}
            {t(
              importing
                ? 'common:extensionsManager.import.importing'
                : 'common:extensionsManager.import.importSelected'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
