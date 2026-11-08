import { CircleAlert, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { contextIsResizable } from '@/lib/knownContextWindow'
import { PREFLIGHT_CONTEXT_ERROR_PREFIX } from '@/lib/contextEstimate'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'

/**
 * The notice under a Chat conversation when the model ran out of memory, its
 * backend failed, or the context window filled, with the way out each one
 * offers. Lifted out of ThreadConversation.tsx unchanged; the conversation
 * renders it only while one of the three errors is set.
 */
export function ConversationErrorNotice({
  oomError,
  backendError,
  contextLimitError,
  error,
  contextBannerMessage,
  compacting,
  selectedProvider,
  handleCompact,
  handleContextSizeIncrease,
  handleRegenerate,
}: {
  oomError: string | undefined
  backendError: string | undefined
  contextLimitError: Error | null
  error: Error | undefined
  contextBannerMessage: string | undefined
  compacting: boolean
  selectedProvider: string
  handleCompact: (opts?: { thenRegenerate?: boolean }) => Promise<void>
  handleContextSizeIncrease: () => void | Promise<void>
  handleRegenerate: (messageId?: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      data-testid="conversation-error-notice"
      className="px-3.5 py-3 my-2 rounded-xl border-[0.8px] border-destructive/30 bg-destructive-tint"
    >
      <div className="flex items-start gap-3">
        <CircleAlert className="size-4 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive mb-1">
            {oomError
              ? t('chat:errorBanner.oomTitle')
              : backendError
                ? t('chat:errorBanner.backendTitle')
                : t('chat:errorBanner.contextTitle')}
          </p>
          <div className="table table-fixed w-full">
            <span
              className={
                (oomError || backendError
                  ? 'text-xs font-mono'
                  : 'text-sm') +
                ' text-fg-2 table-cell align-middle'
              }
              style={{ wordWrap: 'break-word' }}
            >
              {oomError ?? backendError ?? contextBannerMessage}
            </span>
          </div>
          {oomError && (
            <ul className="mt-2 list-disc pl-5 text-xs text-fg-2 space-y-0.5">
              <li>{t('chat:errorBanner.oomReduceContext')}</li>
              <li>{t('chat:errorBanner.oomDisableMtp')}</li>
              <li>{t('chat:errorBanner.oomLowerGpuLayers')}</li>
              <li>{t('chat:errorBanner.oomSmallerModel')}</li>
            </ul>
          )}
          {((error ?? contextLimitError)?.message
            ?.toLowerCase()
            .includes('context') &&
            ((error ?? contextLimitError)?.message
              ?.toLowerCase()
              .includes('size') ||
              (error ?? contextLimitError)?.message
                ?.toLowerCase()
                .includes('length') ||
              (error ?? contextLimitError)?.message
                ?.toLowerCase()
                .includes('limit'))) ||
          (error ?? contextLimitError)?.message ===
            OUT_OF_CONTEXT_SIZE ? (
            // Only where Flint sets the window at load. For any
            // other provider the server owns it, and raising a
            // setting nothing sends cannot help (janhq/jan#8760).
            <>
              {/* The same way out Cowork's stop card offers:
                 summarize older messages, then send again. */}
              <Button
                variant="outline"
                size="sm"
                className="mt-3 mr-2 pointer-coarse:h-11"
                disabled={compacting}
                onClick={() =>
                  void handleCompact({ thenRegenerate: true })
                }
              >
                {compacting
                  ? t('common:budget.compacting')
                  : t('common:compaction.compactNow')}
              </Button>
              {contextIsResizable(selectedProvider) ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 pointer-coarse:h-11"
                  onClick={handleContextSizeIncrease}
                >
                  <CircleAlert className="size-4" />
                  {t('common:outOfContextError.increaseContextSize')}
                </Button>
              ) : (
                <div className="mt-3 space-y-2">
                  {!contextLimitError?.message?.startsWith(
                    PREFLIGHT_CONTEXT_ERROR_PREFIX
                  ) && (
                    <p className="text-sm text-fg-2">
                      {t('chat:errorBanner.serverContext')}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    onClick={() => handleRegenerate()}
                  >
                    <RefreshCw className="size-4" />
                    {t('chat:errorBanner.regenerate')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 pointer-coarse:h-11"
              onClick={() => handleRegenerate()}
            >
              <RefreshCw className="size-4" />
              {oomError || backendError
                ? t('chat:errorBanner.reload')
                : t('chat:errorBanner.regenerate')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
