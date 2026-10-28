import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { buildProviderListRequest } from '@/lib/providerListRequest'
import { toast } from 'sonner'
import { useCallback, useState } from 'react'
import { describeEndpointFailure, isLocalEndpoint } from '@/lib/endpointDiagnostics'
import { maskApiKey } from '@/lib/providerDetailHelpers'

type ProviderOf = ReturnType<typeof useModelProvider.getState>['providers'][number]

/** Tests each API key line against the provider's `/models` endpoint. */
export function useProviderConnectionTest({
  provider,
  apiKeysDraft,
  serviceHub,
  onVerified,
}: {
  provider: ProviderOf | undefined
  apiKeysDraft: string
  serviceHub: ReturnType<typeof useServiceHub>
  /** At least one key answered: the connection is shown as verified. */
  onVerified: () => void
}) {
  const { t } = useTranslation()
  const [isTestingKeys, setIsTestingKeys] = useState(false)
  const [keyCheckResults, setKeyCheckResults] = useState<
    { index: number; masked: string; status: string; detail: string }[]
  >([])

  const handleTestApiKeys = useCallback(async () => {
    if (!provider?.base_url) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }

    const keyDraftLines = apiKeysDraft.split(/\r?\n/).map((l) => l.trim())
    const nonEmptyKeyCount = keyDraftLines.filter((l) => l.length > 0).length
    if (nonEmptyKeyCount === 0) {
      toast.error(t('providers:models'), {
        description: t('providers:refreshModelsError'),
      })
      return
    }

    setIsTestingKeys(true)
    try {
      const fetchImpl = serviceHub.providers().fetch()
      const results: { index: number; masked: string; status: string; detail: string }[] = []

      for (let i = 0; i < keyDraftLines.length; i++) {
        const key = keyDraftLines[i]
        const keyIndex = i + 1
        if (!key) continue
        // The same request the model list sends, so the key is tested the
        // way a real request authenticates (Anthropic's `x-api-key` and
        // `anthropic-version`, Azure's `api-key`). janhq/jan#9440.
        const { headers, urls } = buildProviderListRequest(
          { ...provider, base_url: provider.base_url },
          key
        )
        // Loopback and LAN endpoints are local engines, not remote services.
        // The old check matched the literal strings "localhost:" and
        // "127.0.0.1:", so a server on the LAN or on a Tailscale address was
        // treated as remote.
        if (isLocalEndpoint(provider.base_url)) {
          headers['Origin'] = 'tauri://localhost'
        }
        let url = urls[0]

        try {
          let response = await fetchImpl(url, { method: 'GET', headers })
          if (response.status === 404 && urls.length > 1) {
            url = urls[1]
            response = await fetchImpl(url, { method: 'GET', headers })
          }

          let status = 'http_error'
          if (response.ok) status = 'ok'
          else if (response.status === 401) status = 'unauthorized'
          else if (response.status === 403) status = 'forbidden'
          else if (response.status === 429) status = 'rate_limited'

          results.push({
            index: keyIndex,
            masked: maskApiKey(key),
            status,
            // Name the endpoint, the status and whoever answered. A bare
            // "Forbidden (403)" cannot tell a wrong key from a proxy on the
            // internet answering for a server the user believes is local.
            detail: response.ok
              ? `${response.status} ${response.statusText}`
              : describeEndpointFailure({
                  provider: provider.provider,
                  url,
                  method: 'GET',
                  status: response.status,
                  statusText: response.statusText,
                  server: response.headers?.get?.('server') ?? null,
                }),
          })
        } catch (err) {
          results.push({
            index: keyIndex,
            masked: maskApiKey(key),
            status: 'network_error',
            detail: describeEndpointFailure({
              provider: provider.provider,
              url,
              method: 'GET',
              cause: err,
            }),
          })
        }
      }

      setKeyCheckResults(results)
      if (results.some((r) => r.status === 'ok')) {
        onVerified()
      }
    } finally {
      setIsTestingKeys(false)
    }
  }, [apiKeysDraft, onVerified, provider, serviceHub, t])

  return {
    isTestingKeys,
    keyCheckResults,
    setKeyCheckResults,
    handleTestApiKeys,
  }
}
