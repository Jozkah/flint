import { useNavigate } from '@tanstack/react-router'
import { Cable, FileUp, HardDrive } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ImportLlamacppModelDialog } from '@/containers/dialogs/ImportLlamacppModelDialog'

const OPTION_CLASS =
  'flex min-h-11 flex-col items-start gap-1 rounded-lg border-[0.8px] border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-hover-row focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * One guided choice for getting a model: run one here, connect a provider, or
 * add a model file. Flint downloads nothing on its own. "Add a model file"
 * opens the importer in place, which can pick a .gguf file or find models that
 * Ollama, LM Studio and other apps already saved on this computer. Fit advice
 * is shown beside the model once one is chosen, never here.
 */
export function ModelSetupCard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const llamaProvider = useModelProvider((s) => s.getProviderByName('llamacpp'))

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

  const content = (id: (typeof options)[number]['id'], Icon: typeof HardDrive) => (
    <>
      <span className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 shrink-0" aria-hidden />
        {t(`onboarding:modelSetup.${id}.title`)}
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">
        {t(`onboarding:modelSetup.${id}.body`)}
      </span>
    </>
  )

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
        {options.map(({ id, icon: Icon, onClick }) =>
          id === 'import' && llamaProvider ? (
            <ImportLlamacppModelDialog
              key={id}
              provider={llamaProvider}
              trigger={
                <button
                  type="button"
                  data-testid={`model-setup-${id}`}
                  className={OPTION_CLASS}
                >
                  {content(id, Icon)}
                </button>
              }
            />
          ) : (
            <button
              key={id}
              type="button"
              data-testid={`model-setup-${id}`}
              onClick={onClick}
              className={OPTION_CLASS}
            >
              {content(id, Icon)}
            </button>
          )
        )}
      </div>
    </div>
  )
}
