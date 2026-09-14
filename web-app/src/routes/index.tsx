/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import SetupScreen from '@/containers/SetupScreen'
import { route } from '@/constants/routes'
import { hasUsableProvider } from '@/lib/providerReadiness'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}
import { useEffect } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { NewTemporaryChatButton } from '@/containers/NewTemporaryChatButton'
import { GettingStartedCard } from '@/containers/GettingStartedCard'

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const { setCurrentThreadId } = useThreads()
  useTools()

  const hasValidProviders = hasUsableProvider(providers)

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (!hasValidProviders) {
    return <SetupScreen />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <HeaderPage>
        <PageHeaderRow>
          {/* A new chat with no model chosen starts from the last-used model,
              or the first local one on a first run (janhq/jan#7703). The
              composer's own picker, which used to ask for this, is not
              rendered, so without it nothing was ever selected. */}
          <DropdownModelProvider
            model={threadModel}
            useLastUsedModel={!threadModel}
          />
          <NewTemporaryChatButton />
        </PageHeaderRow>
      </HeaderPage>
      <div
        className={cn(
          'min-h-0 flex-1 min-w-0 overflow-y-auto overflow-x-hidden flex flex-col justify-center px-3 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6'
        )}
      >
        <div className={cn('mx-auto w-full max-w-[calc(var(--read-w)+3rem)]')}>
          <h1 className="mb-3 text-[15px] font-semibold text-foreground">
            {t('chat:description')}
          </h1>
          <GettingStartedCard />
          <div className="flex-1 shrink-0">
            <ChatInput
              showSpeedToken={false}
              model={threadModel}
              initialMessage={true}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
