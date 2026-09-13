import { Link } from '@tanstack/react-router'
import { Cpu, Server, ShieldAlert, Workflow } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { route } from '@/constants/routes'
import { cn } from '@/lib/utils'

/**
 * The 28px status bar. Every value comes from the same stores the rest of the
 * app reads -- loaded models, Cowork runs, waiting approvals, the local API
 * server -- and each says what it counts. Nothing is estimated here.
 */
export function StatusBar({ className }: { className?: string }) {
  const { t } = useTranslation()
  const loaded = useAppState((s) => s.activeModels.length)
  const serverStatus = useAppState((s) => s.serverStatus)
  const runs = useCoworkRun((s) => Object.keys(s.runs ?? {}).length)
  const waiting = useToolApprovalRequests((s) => Object.keys(s.pending ?? {}).length)
  const host = useLocalApiServer((s) => s.serverHost)
  const port = useLocalApiServer((s) => s.serverPort)

  const item =
    'flex h-full min-w-0 items-center gap-1.5 whitespace-nowrap px-3 first:pl-0 border-l border-line-strong first:border-l-0 [&_svg]:size-3.5 [&_svg]:text-muted-foreground'

  return (
    <footer
      data-testid="status-bar"
      aria-label={t('common:statusBar.label')}
      className={cn(
        'flex h-(--status-h) shrink-0 items-center overflow-hidden border-t border-border bg-sidebar pl-4 pr-3 text-xs text-ink-2 kb-hidden',
        'pb-[env(safe-area-inset-bottom)] box-content',
        className
      )}
    >
      <span className={item} title={t('common:statusBar.modelsTitle')}>
        <Cpu aria-hidden />
        {t('common:statusBar.modelsLoaded', { count: loaded })}
      </span>
      <span className={cn(item, 'hidden sm:flex')} title={t('common:statusBar.runsTitle')}>
        <Workflow aria-hidden />
        {runs > 0
          ? t('common:statusBar.runsActive', { count: runs })
          : t('common:statusBar.runsNone')}
      </span>
      {waiting > 0 && (
        <span className={cn(item, 'text-warning [&_svg]:text-warning')} role="status">
          <ShieldAlert aria-hidden />
          {t('common:statusBar.approvalsWaiting', { count: waiting })}
        </span>
      )}
      <span className="flex-1" />
      <Link
        to={route.settings.local_api_server}
        className={cn(item, 'hidden md:flex hover:text-foreground')}
        title={t('common:statusBar.serverTitle')}
      >
        <Server aria-hidden />
        {serverStatus === 'running'
          ? t('common:statusBar.serverRunning', { address: `${host}:${port}` })
          : serverStatus === 'pending'
            ? t('common:statusBar.serverStarting')
            : t('common:statusBar.serverStopped')}
      </Link>
    </footer>
  )
}
