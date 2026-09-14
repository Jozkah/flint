import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { OctagonAlert } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'

interface McpServerLogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName: string
}

/**
 * One MCP server's own log (AH-140): what that server printed to stderr,
 * scrubbed and bounded by the backend, newest last. Kept apart from the
 * application log so "why did this server stop" has an answer on its own.
 */
export default function McpServerLogDialog({
  open,
  onOpenChange,
  serverName,
}: McpServerLogDialogProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [lines, setLines] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setError(null)
    serviceHub
      .mcp()
      .getServerLog(serverName, 200)
      .then(setLines)
      .catch((e: unknown) => setError(String(e)))
  }

  useEffect(() => {
    if (open && serverName) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverName])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('mcp-servers:serverLog.title', { serverName })}</DialogTitle>
          <DialogDescription>{t('mcp-servers:serverLog.description')}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="flex items-start gap-2 text-destructive text-sm">
            <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : lines === null ? null : lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('mcp-servers:serverLog.empty')}</p>
        ) : (
          <pre
            aria-label={t('mcp-servers:serverLog.title', { serverName })}
            tabIndex={0}
            className="max-h-96 overflow-auto rounded-md border border-border bg-code p-3 font-mono text-xs whitespace-pre-wrap text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            {lines.join('\n')}
          </pre>
        )}
        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-11"
            onClick={load}
          >
            {t('mcp-servers:serverLog.refresh')}
          </Button>
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => onOpenChange(false)}
          >
            {t('common:close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
