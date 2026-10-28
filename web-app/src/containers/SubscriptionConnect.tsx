import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'

/** Providers served by the user's own signed-in vendor CLI (Claude Code,
 * Codex, Gemini CLI) through Flint's loopback bridge. */
export const SUBSCRIPTION_PROVIDERS = [
  'claude-cli',
  'codex-cli',
  'gemini-cli',
] as const

export const isSubscriptionProvider = (provider: string | undefined) =>
  SUBSCRIPTION_PROVIDERS.some((id) => id === provider)

type BridgeStatus = {
  installed: boolean
  loggedIn: boolean
  loginHint: string
  installHint: string
  disclaimer: string
}

type BridgeConnection = {
  baseUrl: string
  key: string
  models: string[]
}

type Props = { providerName: string }

/** Connect a subscription provider: checks the vendor CLI, then registers the
 * loopback endpoint and its key as an ordinary provider. The vendor login never
 * reaches Flint. */
export function SubscriptionConnect({ providerName }: Props) {
  const serviceHub = useServiceHub()
  const { getProviderByName, updateProvider } = useModelProvider()
  const provider = getProviderByName(providerName)
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(
        await invoke<BridgeStatus>('cli_bridge_status', {
          provider: providerName,
        })
      )
    } catch (e) {
      setError(String(e))
    }
  }, [providerName])

  useEffect(() => {
    setError(null)
    void refresh()
  }, [refresh])

  const connect = useCallback(async () => {
    if (!provider) return
    setBusy(true)
    setError(null)
    try {
      const link = await invoke<BridgeConnection>('cli_bridge_connect', {
        provider: providerName,
      })
      const models = link.models.map((id) => ({
        id,
        model: id,
        name: id,
        capabilities: ['completion'],
        version: '1.0',
      }))
      updateProvider(providerName, {
        ...provider,
        base_url: link.baseUrl,
        api_key: link.key,
        active: true,
        models: models as typeof provider.models,
      })
      serviceHub.providers().updateSettings(providerName, provider.settings)
      toast.success(`Connected ${providerName}`, {
        description: `${models.length} models available.`,
      })
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [provider, providerName, refresh, serviceHub, updateProvider])

  const disconnect = useCallback(() => {
    if (!provider) return
    updateProvider(providerName, {
      ...provider,
      api_key: '',
      active: false,
      models: [],
    })
    serviceHub.providers().deleteProviderKeys(providerName)
  }, [provider, providerName, serviceHub, updateProvider])

  const connected = Boolean(provider?.api_key) && Boolean(provider?.active)

  return (
    <div
      className="mt-4 rounded-[14px] p-4 shadow-[inset_0_0_0_0.8px_var(--border)]"
      data-testid="subscription-connect"
    >
      <p className="text-sm text-foreground">
        Flint never sees the vendor login.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        {status?.disclaimer ??
          'Uses your own signed-in vendor CLI and your subscription. Vendor terms still apply: Anthropic and Google limit subscription plans to ordinary individual use. Do not share this login or run large unattended jobs on it; use an API key for those.'}
      </p>
      {status && !status.installed && (
        <p className="mt-3 text-sm">
          The CLI is not installed. Run{' '}
          <code className="rounded bg-muted px-1">{status.installHint}</code>,
          then come back.
        </p>
      )}
      {status && status.installed && !status.loggedIn && (
        <p className="mt-3 text-sm">
          The CLI is not signed in. {status.loginHint}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          onClick={connect}
          disabled={busy || !status?.installed || !status?.loggedIn}
        >
          {connected ? 'Reconnect' : 'Connect'}
        </Button>
        {connected && (
          <Button size="sm" variant="outline" onClick={disconnect}>
            Disconnect
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Check again
        </Button>
      </div>
    </div>
  )
}
