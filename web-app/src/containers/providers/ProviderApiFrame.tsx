import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon } from '@/components/ui/icon'
import { SecretInput } from '@/components/ui/secret-input'
import { BedrockCredentials } from '@/containers/BedrockCredentials'
import { ProviderCustomHeaders } from '@/containers/ProviderCustomHeaders'
import { ProviderTlsTrust } from '@/containers/ProviderTlsTrust'
import { EDITABLE_ENDPOINT, getStatusClass, getStatusLabel } from '@/lib/providerDetailHelpers'
import { cn } from '@/lib/utils'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { Dispatch, SetStateAction } from 'react'

type ProviderApiFrameProps = {
  provider: ProviderObject
  baseUrlDraft: string
  setBaseUrlDraft: Dispatch<SetStateAction<string>>
  commitBaseUrlDraft: () => void
  apiVersionDraft: string
  setApiVersionDraft: Dispatch<SetStateAction<string>>
  commitApiVersionDraft: () => void
  showAdvancedApiKeys: boolean
  primaryKeyDraft: string
  setPrimaryKeyDraft: (nextPrimary: string) => void
  commitApiKeysDraft: () => void
  setShowAdvancedApiKeys: Dispatch<SetStateAction<boolean>>
  setKeyCheckResults: Dispatch<SetStateAction<{ index: number; masked: string; status: string; detail: string; }[]>>
  handleTestApiKeys: () => Promise<void>
  isTestingKeys: boolean
  advancedApiKeyLines: string[]
  keyCheckResults: { index: number; masked: string; status: string; detail: string; }[]
  setKeyAtIndex: (index: number, nextValue: string) => void
  removeKeyLine: (index: number) => void
  addKeyLine: () => void
}

export function ProviderApiFrame({
  provider,
  baseUrlDraft,
  setBaseUrlDraft,
  commitBaseUrlDraft,
  apiVersionDraft,
  setApiVersionDraft,
  commitApiVersionDraft,
  showAdvancedApiKeys,
  primaryKeyDraft,
  setPrimaryKeyDraft,
  commitApiKeysDraft,
  setShowAdvancedApiKeys,
  setKeyCheckResults,
  handleTestApiKeys,
  isTestingKeys,
  advancedApiKeyLines,
  keyCheckResults,
  setKeyAtIndex,
  removeKeyLine,
  addKeyLine,
}: ProviderApiFrameProps) {
  const { t } = useTranslation()
  return (
    <Frame className="motion-safe:animate-rise-in [animation-delay:260ms]">
      <FrameHeader icon={<Icon name="x-key" />} title={t('engine:provider.api')} />
      <FrameBody className="gap-4 p-3">
        {EDITABLE_ENDPOINT[provider.provider] && (
          <div className="space-y-2">
            <div className="space-y-1">
              <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                {t('providers:baseUrl.title')}
              </h3>
              <p className="text-xs leading-normal text-muted-foreground">
                {t(EDITABLE_ENDPOINT[provider.provider].description)}
              </p>
            </div>
            <input
              className="flex h-8 w-full min-w-0 rounded-lg border-[0.8px] border-input bg-card px-2.5 py-1 font-mono text-base text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-xs"
              placeholder={EDITABLE_ENDPOINT[provider.provider].placeholder}
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              onBlur={() => commitBaseUrlDraft()}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {provider.provider === 'azure' && (
          <div className="space-y-2">
            <div className="space-y-1">
              <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                {t('providers:apiVersion.title')}
              </h3>
              <p className="text-xs leading-normal text-muted-foreground">
                {t('providers:apiVersion.description')}
              </p>
            </div>
            <input
              className="flex h-8 w-full min-w-0 rounded-lg border-[0.8px] border-input bg-card px-2.5 py-1 font-mono text-base text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11 md:text-xs"
              placeholder="2024-10-21"
              data-testid="azure-api-version"
              value={apiVersionDraft}
              onChange={(e) => setApiVersionDraft(e.target.value)}
              onBlur={() => commitApiVersionDraft()}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {provider.provider === 'bedrock' && <BedrockCredentials />}
        <div
          className={provider.provider === 'bedrock' ? 'hidden' : 'space-y-3'}
        >
          <div className="space-y-1">
            <h3 className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
              {t('providers:apiKeys.title')}
            </h3>
            <p className="text-xs leading-normal text-muted-foreground">
              {t('providers:apiKeys.description')}
            </p>
          </div>
          {!showAdvancedApiKeys && (
            <div className="flex flex-col gap-2">
              <SecretInput
                className="font-mono"
                placeholder={t('providers:apiKeys.primaryPlaceholder')}
                value={primaryKeyDraft}
                onChange={(e) => setPrimaryKeyDraft(e.target.value)}
                onBlur={() => commitApiKeysDraft()}
                spellCheck={false}
                autoComplete="off"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="pointer-coarse:h-11"
                  onClick={() => {
                    setShowAdvancedApiKeys(true)
                    setKeyCheckResults([])
                  }}
                >
                  {t('providers:apiKeys.advanced')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('providers:apiKeys.oneKeyHint')}
                </span>
              </div>
            </div>
          )}

          {showAdvancedApiKeys && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {t('providers:apiKeys.testHint')}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="pointer-coarse:h-11"
                    onClick={() => {
                      commitApiKeysDraft()
                      setShowAdvancedApiKeys(false)
                      setKeyCheckResults([])
                    }}
                  >
                    {t('providers:apiKeys.hideAdvanced')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="pointer-coarse:h-11"
                    onClick={handleTestApiKeys}
                    disabled={isTestingKeys}
                  >
                    {isTestingKeys ? (
                      <>
                        <LoaderCircle
                          className="motion-safe:animate-spin"
                          aria-hidden
                        />
                        {t('providers:apiKeys.testing')}
                      </>
                    ) : (
                      t('providers:apiKeys.test')
                    )}
                  </Button>
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                Primary key is <span className="font-medium">#1</span>. Flint
                retries the next key only on{' '}
                <span className="font-mono">401/403/429</span>.
              </div>

              <div className="space-y-2">
                {advancedApiKeyLines.map((keyValue, idx) => {
                  const keyIndex = idx + 1
                  const rowResult = keyCheckResults.find(
                    (r) => r.index === keyIndex
                  )

                  return (
                    <div
                      key={idx}
                      className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.75rem] items-center gap-x-2 gap-y-1"
                    >
                      <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                        #{keyIndex}
                      </div>

                      <div className="min-w-0">
                        <SecretInput
                          className="font-mono w-full"
                          placeholder={t('providers:apiKeys.keyPlaceholder')}
                          value={keyValue}
                          onChange={(e) => {
                            setKeyAtIndex(idx, e.target.value)
                          }}
                          onBlur={commitApiKeysDraft}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </div>

                      <div className="flex justify-end">
                        {idx !== 0 ? (
                          <Button
                            size="icon-sm"
                            variant="outline"
                            className="pointer-coarse:size-11"
                            onClick={() => {
                              setKeyCheckResults([])
                              removeKeyLine(idx)
                            }}
                            title={t('providers:apiKeys.removeKey')}
                          >
                            -
                          </Button>
                        ) : (
                          <span aria-hidden>&nbsp;</span>
                        )}
                      </div>

                      <div aria-hidden />
                      <div className="min-w-0">
                        {rowResult && (
                          <div
                            className={cn(
                              'text-right text-xs font-medium',
                              getStatusClass(rowResult.status)
                            )}
                            title={rowResult.detail}
                          >
                            {getStatusLabel(rowResult.status)}
                          </div>
                        )}
                      </div>
                      <div aria-hidden />
                    </div>
                  )
                })}

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="pointer-coarse:h-11"
                    onClick={() => {
                      setKeyCheckResults([])
                      addKeyLine()
                    }}
                  >
                    + {t('providers:apiKeys.addKey')}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
        <ProviderCustomHeaders provider={provider} />
        <ProviderTlsTrust provider={provider} />
      </FrameBody>
    </Frame>
  )
}
