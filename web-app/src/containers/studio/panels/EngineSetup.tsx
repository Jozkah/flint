import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useStudio } from '@/hooks/useStudio'
import { type EngineBuild } from '@/lib/studio/studio'
import { BUILDS } from '@/containers/studio/studioTypes'

export function EngineSetup() {
  const { t } = useTranslation()
  const status = useStudio((s) => s.status)
  const installing = useStudio((s) => s.installing)
  const install = useStudio((s) => s.installEngine)
  const builds = BUILDS.filter((b) => (status?.engineBuilds ?? ['win-vulkan-x64', 'win-cuda12-x64', 'win-cpu-x64']).includes(b.id))
  const [selected, setBuild] = useState<EngineBuild | null>(null)
  const build = builds.find((b) => b.id === selected)?.id ?? builds[0]?.id
  if (!status) return null
  if (!status.supported) {
    return (
      <Frame className="motion-safe:animate-rise-in">
        <FrameHeader title={t('studio:setup.unavailableTitle')} />
        <FrameBody className="p-3.5">
          <p className="text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">
            {t('studio:setup.unavailableBody')}
          </p>
        </FrameBody>
      </Frame>
    )
  }
  if (status.engineBackend) return null
  const percent = installing?.total
    ? Math.round((installing.downloaded / installing.total) * 100)
    : 0
  return (
    <Frame className="motion-safe:animate-rise-in">
      <FrameHeader title={t('studio:setup.title')} />
      <FrameBody className="gap-3 p-3.5">
        <p className="text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">
          {t('studio:setup.body')}
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {builds.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={!!installing}
              aria-pressed={build === b.id}
              onClick={() => setBuild(b.id)}
              className="rounded-lg border-[0.8px] border-border p-3 text-left text-[length:calc(var(--ui-font-base)*0.8125)] transition-colors duration-150 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden aria-pressed:border-input aria-pressed:bg-accent disabled:opacity-50"
            >
              <div className="font-medium text-foreground">{t(`studio:builds.${b.label}`)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t(`studio:builds.note.${b.id}`)}</div>
            </button>
          ))}
        </div>
        {installing && (
          <div className="space-y-1.5">
            <Progress value={installing.stage === 'download' ? percent : 100} />
            <p className="text-xs text-muted-foreground">
              {installing.stage === 'download'
                ? t('studio:setup.downloading', { percent })
                : installing.stage === 'unpack'
                  ? t('studio:setup.unpacking')
                  : t('studio:setup.checking')}
            </p>
          </div>
        )}
        <div>
          <Button disabled={!!installing || !build} onClick={() => { if (build) void install(build) }}>
            {installing ? t('studio:setup.installing') : t('studio:setup.install')}
          </Button>
        </div>
      </FrameBody>
    </Frame>
  )
}
