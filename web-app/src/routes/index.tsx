/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { PenLine } from 'lucide-react'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { usePrompt } from '@/hooks/usePrompt'

import { useModelProvider } from '@/hooks/useModelProvider'
import SetupScreen from '@/containers/SetupScreen'
import { route } from '@/constants/routes'
import { hasUsableProvider, isSetupCompleted } from '@/lib/providerReadiness'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { useMediaQuery } from '@/hooks/useMediaQuery'

/** Below Tailwind's `sm`: the page header has room for one button. */
const PHONE_QUERY = '(max-width: 639px)'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}
import { useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { PageHeaderRow } from '@/containers/PageHeaderRow'
import { NewTemporaryChatButton } from '@/containers/NewTemporaryChatButton'
import {
  GettingStartedCard,
  ResumeRecentLink,
} from '@/containers/GettingStartedCard'

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
    }

    return result
  },
})

/** Starter prompts: a click fills the composer, it never sends. */
const SUGGESTIONS = ['explain', 'summarise', 'draft', 'compare'] as const

function Index() {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const { setCurrentThreadId } = useThreads()
  useTools()

  const hasValidProviders = hasUsableProvider(providers)
  const [setupDone, setSetupDone] = useState(() => isSetupCompleted())
  const isPhone = useMediaQuery(PHONE_QUERY)

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  // Setup shows until the user finishes it. Finishing without a model is
  // allowed; the home page's getting-started card then points at adding one.
  if (!hasValidProviders && !setupDone) {
    return <SetupScreen onFinished={() => setSetupDone(true)} />
  }

  const fillComposer = (text: string) => {
    usePrompt.getState().setPrompt(text)
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]'
    )
    input?.focus()
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-1 pt-3.5 pb-4">
      <HeaderPage>
        <PageHeaderRow>
          <div className="flex-1" />
          {/* A new chat with no model chosen starts from the last-used model,
              or the first local one on a first run (janhq/jan#7703). The
              composer's own picker, which used to ask for this, is not
              rendered, so without it nothing was ever selected. */}
          {/* On a phone the model sits on the frame's header row instead. */}
          <NewTemporaryChatButton />
        </PageHeaderRow>
      </HeaderPage>
      {/* One Frame: the page's header row, a scrolling hero, and the
          composer pinned under it. */}
      <Frame className="min-h-0 flex-1 motion-safe:animate-rise-in">
        <FrameHeader
          icon={<PenLine />}
          title={t('chat:home.title')}
          actions={
            <>
              <span className="text-xs text-muted-foreground max-sm:hidden">
                {t('chat:home.notSaved')}
              </span>
              {isPhone && (
                <div className="min-w-0 shrink">
                  <DropdownModelProvider
                    model={threadModel}
                    useLastUsedModel={!threadModel}
                  />
                </div>
              )}
            </>
          }
        />
        <FrameBody className="min-h-0 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto px-[18px] py-8 [scrollbar-width:thin]">
            {/* Centred when it fits, top-aligned (and scrolling) when not. */}
            <div className="my-auto flex w-full max-w-[780px] flex-col gap-[18px]">
              <div className="flex flex-col gap-2.5 text-center">
                <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.02em] text-foreground motion-safe:animate-rise-in">
                  {t('chat:description')}
                </h1>
                <p className="text-[13px] text-muted-foreground motion-safe:animate-rise-in motion-safe:[animation-delay:60ms]">
                  {t('chat:home.sub')}
                </p>
              </div>
              <GettingStartedCard resume={false} />
              <div
                role="group"
                aria-label={t('chat:home.suggestionsLabel')}
                className="grid grid-cols-1 gap-2 motion-safe:animate-rise-in motion-safe:[animation-delay:200ms] sm:grid-cols-2"
              >
                {SUGGESTIONS.map((key) => {
                  const text = t(`chat:home.suggestions.${key}`)
                  return (
                    <button
                      key={key}
                      type="button"
                      data-testid={`suggestion-${key}`}
                      onClick={() => fillComposer(text)}
                      className="w-full rounded-[10px] border-[0.8px] border-border bg-card px-3 py-2.5 text-left text-[13px] text-secondary-foreground transition-[box-shadow,color,transform] duration-150 outline-hidden hover:-translate-y-px hover:text-foreground hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    >
                      {text}
                    </button>
                  )
                })}
              </div>
              <ResumeRecentLink className="motion-safe:animate-rise-in motion-safe:[animation-delay:260ms]" />
            </div>
          </div>
          {/* The composer stays put while the hero scrolls. */}
          <div className="mx-auto w-full max-w-[calc(780px+2rem)] shrink-0 px-4 pt-2.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
            <ChatInput
              showSpeedToken={false}
              model={threadModel}
              initialMessage={true}
              groupOptions
              modelControl={
                isPhone ? undefined : (
                  <DropdownModelProvider
                    variant="quiet"
                    model={threadModel}
                    useLastUsedModel={!threadModel}
                  />
                )
              }
            />
          </div>
        </FrameBody>
      </Frame>
    </div>
  )
}
