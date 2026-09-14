import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'

import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { ExtensionManager } from '@/lib/extension'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  component: ExtensionsContent,
})

function ExtensionsContent() {
  const { t } = useTranslation()
  const extensions = ExtensionManager.getInstance().listExtensions()
  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader />
      <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0">
        <div className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6">
          <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
            {/* General */}
            <Card
              header={
                <div className="mb-4 flex items-center justify-between">
                  <h1 className=" text-xl font-semibold text-foreground">
                    {t('settings:extensions.title')}
                  </h1>
                  {/* <div className="flex items-center gap-2">
                    <Button size="sm">Install Extension</Button>
                  </div> */}
                </div>
              }
            >
              {extensions.map((item, i) => {
                return (
                  <CardItem
                    key={i}
                    title={
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <h1 className="font-medium text-foreground">
                          {item.productName ?? item.name}
                        </h1>
                        <div className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-xs tabular-nums text-ink-2">
                          v{item.version}
                        </div>
                      </div>
                    }
                    description={
                      <RenderMarkdown
                        content={item.description ?? ''}
                        components={{
                          // Make links open in a new tab
                          a: ({ ...props }) => (
                            <a
                              {...props}
                              className="text-brand-text underline-offset-4 hover:underline"
                              target="_blank"
                              rel="noopener noreferrer"
                            />
                          ),
                          // Custom paragraph component remove margin
                          p: ({ ...props }) => (
                            <p {...props} className="mb-0!" />
                          ),
                        }}
                      />
                    }
                  />
                )
              })}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
