import { Chip } from '@/components/ui/chip'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ServerHostSwitcher } from '@/containers/ServerHostSwitcher'
import { PortInput } from '@/containers/PortInput'
import { ProxyTimeoutInput } from '@/containers/ProxyTimeoutInput'
import { ApiPrefixInput } from '@/containers/ApiPrefixInput'
import { TrustedHostsInput } from '@/containers/TrustedHostsInput'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { cn } from '@/lib/utils'
import { ApiKeyInput } from '@/containers/ApiKeyInput'
import { LocalModelSelect } from '@/containers/LocalModelSelect'
import { LogViewer } from '@/components/LogViewer'
import type { ReactNode } from 'react'

export function ServerCard({
  isServerRunning,
  isPending,
  onToggle,
  buttonContent,
  serverUrl,
}: {
  isServerRunning: boolean
  /** Starting, or loading the model: the button is locked. */
  isPending: boolean
  onToggle: () => void
  buttonContent: ReactNode
  serverUrl: string
}) {
  const { t } = useTranslation()
  const {
    enableOnStartup,
    setEnableOnStartup,
    runInBackground,
    setRunInBackground,
    apiPrefix,
    defaultModelLocalApiServer,
    setDefaultModelLocalApiServer,
  } = useLocalApiServer()
  return (
    <Card
      title={t('settings:localApiServer.title')}
      description={t('settings:localApiServer.description')}
      aside={
        <Button
          onClick={onToggle}
          variant={isServerRunning ? 'destructive' : 'default'}
          className="pointer-coarse:h-11"
          disabled={isPending}
        >
          {buttonContent}
        </Button>
      }
    >
      <CardItem
        title={t('uiLeftovers:localApi.status')}
        description={
          isServerRunning
            ? t('uiLeftovers:localApi.runningDesc')
            : t('uiLeftovers:localApi.stoppedDesc')
        }
        actions={
          <>
            <Chip
              tone={isServerRunning ? 'ok' : 'neutral'}
              dot
              live={isServerRunning}
            >
              {isServerRunning
                ? t('uiLeftovers:localApi.running')
                : t('uiLeftovers:localApi.stopped')}
            </Chip>
            {isServerRunning && (
              <code className="inline-flex h-[30px] items-center rounded-lg bg-muted px-2.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)] text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
                {serverUrl}
                {apiPrefix}
              </code>
            )}
          </>
        }
      />
      <CardItem
        title={t('settings:localApiServer.swaggerDocs')}
        description={t('settings:localApiServer.swaggerDocsDesc')}
        actions={
          <a
            href={serverUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(isServerRunning ? '' : 'pointer-events-none')}
          >
            <Button
              variant="outline"
              disabled={!isServerRunning}
              title={t('settings:localApiServer.swaggerDocs')}
            >
              <span>{t('settings:localApiServer.openDocs')}</span>
            </Button>
          </a>
        }
      />
      <CardItem
        anchor="settings-local-api-server-run-on-startup"
        title={t('settings:localApiServer.runOnStartup')}
        description={t('settings:localApiServer.runOnStartupDesc')}
        actions={
          <Switch
            checked={enableOnStartup}
            onCheckedChange={(checked) => {
              setEnableOnStartup(checked)
            }}
          />
        }
      />
      {!IS_MACOS && (
        <CardItem
          title={t('settings:localApiServer.runInBackground')}
          description={t('settings:localApiServer.runInBackgroundDesc')}
          actions={
            <Switch
              checked={runInBackground}
              onCheckedChange={setRunInBackground}
            />
          }
        />
      )}
      <CardItem
        anchor="settings-local-api-server-default-model"
        title={t('settings:localApiServer.defaultModel')}
        description={t('settings:localApiServer.defaultModelDesc')}
        actions={
          <div className="w-full min-w-0 sm:w-64 sm:max-w-full">
            <LocalModelSelect
              value={defaultModelLocalApiServer}
              onChange={setDefaultModelLocalApiServer}
            />
          </div>
        }
      />
    </Card>
  )
}

export function ServerLogCard({ onOpenLogs }: { onOpenLogs: () => void }) {
  const { t } = useTranslation()
  return (
    <Card
      title={t('settings:localApiServer.serverLog')}
      aside={
        <Button
          variant="outline"
          onClick={onOpenLogs}
          className="pointer-coarse:h-11"
        >
          {t('settings:localApiServer.openInNewWindow')}
        </Button>
      }
    >
      <div className="h-[160px]">
        <LogViewer />
      </div>
    </Card>
  )
}

export function ConnectionCard({
  isServerRunning,
  showApiKeyError,
}: {
  isServerRunning: boolean
  showApiKeyError: boolean
}) {
  const { t } = useTranslation()
  const { serverHost, trustedHosts } = useLocalApiServer()
  return (
    <Card title={t('engine:provider.connection')}>
      <CardItem
        anchor="settings-local-api-server-host"
        title={t('settings:localApiServer.serverHost')}
        description={t('settings:localApiServer.serverHostDesc')}
        actions={<ServerHostSwitcher isServerRunning={isServerRunning} />}
      />
      {serverHost === '0.0.0.0' && (
        <p role="note" className="py-2 text-xs text-warning">
          {t('settings:localApiServer.serverHostLanWarning')}
          {trustedHosts.length === 0 && (
            <> {t('settings:localApiServer.serverHostLanNoTrusted')}</>
          )}
        </p>
      )}
      <CardItem
        anchor="settings-local-api-server-port"
        title={t('settings:localApiServer.serverPort')}
        description={t('settings:localApiServer.serverPortDesc')}
        actions={<PortInput isServerRunning={isServerRunning} />}
      />
      <CardItem
        anchor="settings-local-api-server-api-prefix"
        title={t('settings:localApiServer.apiPrefix')}
        description={t('settings:localApiServer.apiPrefixDesc')}
        actions={<ApiPrefixInput isServerRunning={isServerRunning} />}
      />
      <CardItem
        anchor="settings-local-api-server-api-key"
        column
        title={t('settings:localApiServer.apiKey')}
        description={t('settings:localApiServer.apiKeyDesc')}
        actions={
          <ApiKeyInput
            isServerRunning={isServerRunning}
            showError={showApiKeyError}
          />
        }
      />
      <CardItem
        anchor="settings-local-api-server-trusted-hosts"
        column
        title={t('settings:localApiServer.trustedHosts')}
        description={t('settings:localApiServer.trustedHostsDesc')}
        actions={<TrustedHostsInput isServerRunning={isServerRunning} />}
      />
      <CardItem
        anchor="settings-local-api-server-request-timeout"
        title={t('settings:localApiServer.proxyTimeout')}
        description={t('settings:localApiServer.proxyTimeoutDesc')}
        actions={<ProxyTimeoutInput isServerRunning={isServerRunning} />}
      />
    </Card>
  )
}

export function BehaviourCard({ isServerRunning }: { isServerRunning: boolean }) {
  const { t } = useTranslation()
  const {
    corsEnabled,
    setCorsEnabled,
    verboseLogs,
    setVerboseLogs,
    enableServerToolExecution,
    setEnableServerToolExecution,
  } = useLocalApiServer()
  return (
    <Card title={t('settings:agentTools.tabBehaviour')}>
      <CardItem
        anchor="settings-local-api-server-server-tools"
        title={t('settings:localApiServer.serverTools')}
        description={t('settings:localApiServer.serverToolsDesc')}
        actions={
          <Switch
            checked={enableServerToolExecution}
            onCheckedChange={setEnableServerToolExecution}
            disabled={isServerRunning}
          />
        }
      />
      <CardItem
        anchor="settings-local-api-server-cors"
        title={t('settings:localApiServer.cors')}
        description={t('settings:localApiServer.corsDesc')}
        actions={
          <Switch
            checked={corsEnabled}
            onCheckedChange={setCorsEnabled}
            disabled={isServerRunning}
          />
        }
      />
      <CardItem
        anchor="settings-local-api-server-verbose-logs"
        title={t('settings:localApiServer.verboseLogs')}
        description={t('settings:localApiServer.verboseLogsDesc')}
        actions={
          <Switch
            checked={verboseLogs}
            onCheckedChange={setVerboseLogs}
            disabled={isServerRunning}
          />
        }
      />
    </Card>
  )
}
