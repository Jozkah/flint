import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'

import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { ExtensionManager } from '@/lib/extension'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  component: ExtensionsContent,
})

function ExtensionsContent() {
  const { t } = useTranslation()
  const extensions = ExtensionManager.getInstance().listExtensions()
  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:extensions')} />
      <SettingsPageBody
        title={t('common:extensions')}
        description={t('settings:pageDesc.extensions')}
      >
        {/* General */}
        <Card
          title={t('settings:extensions.title')}
          aside={<span className="tabular-nums">{extensions.length}</span>}
        >
          {extensions.map((item, i) => {
            return (
              <CardItem
                key={i}
                title={
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-foreground">
                      {item.productName ?? item.name}
                    </span>
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
      </SettingsPageBody>
    </div>
  )
}
