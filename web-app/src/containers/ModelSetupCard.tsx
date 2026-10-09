import { useNavigate } from '@tanstack/react-router'
import { Cable, FileUp, HardDrive } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * One guided choice for getting a model: run one here, connect a provider, or
 * import a file. Model details, quantization and fit are shown only after the
 * first choice (Discover, provider settings, the importer), never here.
 */
export function ModelSetupCard() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const options = [
    {
      id: 'local',
      icon: HardDrive,
      onClick: () => navigate({ to: route.hub.index }),
    },
    {
      id: 'provider',
      icon: Cable,
      onClick: () => navigate({ to: route.settings.model_providers }),
    },
    {
      id: 'import',
      icon: FileUp,
      onClick: () =>
        navigate({
          to: route.settings.providers,
          params: { providerName: 'llamacpp' },
        }),
    },
  ] as const

  return (
    <div
      role="group"
      aria-label={t('onboarding:modelSetup.title')}
      data-testid="model-setup-card"
      className="flex flex-col gap-2"
    >
      <p className="text-sm font-medium text-foreground">
        {t('onboarding:modelSetup.title')}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map(({ id, icon: Icon, onClick }) => (
          <button
            key={id}
            type="button"
            data-testid={`model-setup-${id}`}
            onClick={onClick}
            className="flex min-h-11 flex-col items-start gap-1 rounded-lg border-[0.8px] border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-hover-row focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Icon className="size-4 shrink-0" aria-hidden />
              {t(`onboarding:modelSetup.${id}.title`)}
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {t(`onboarding:modelSetup.${id}.body`)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
