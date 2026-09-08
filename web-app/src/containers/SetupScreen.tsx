import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconFolderOpen } from '@tabler/icons-react'
import { ImportLlamacppModelDialog } from './dialogs/ImportLlamacppModelDialog'
import HeaderPage from './HeaderPage'

/**
 * First run, for a build that talks to nothing.
 *
 * There is no catalog to browse and nothing to download, so the only way a
 * model arrives is the user pointing the importer at a GGUF already on this
 * machine. That makes this screen a single instruction rather than a wizard:
 * the previous version's stages existed to sequence a download it no longer
 * performs.
 */
function SetupScreen() {
  const { t } = useTranslation()
  const { getProviderByName } = useModelProvider()
  const llamaProvider = getProviderByName('llamacpp')
  const [imported, setImported] = useState<string | undefined>()

  const handleImported = useCallback((name?: string) => {
    setImported(name)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <HeaderPage>
        <h1 className="font-medium">{t('setup:title')}</h1>
      </HeaderPage>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <h2 className="text-lg font-medium">{t('setup:localOnlyTitle')}</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {t('setup:localOnlyDesc')}
          </p>

          {llamaProvider ? (
            <div className="mt-6 flex justify-center">
              <ImportLlamacppModelDialog
                provider={llamaProvider}
                onSuccess={handleImported}
                trigger={
                  <Button className="gap-2">
                    <IconFolderOpen size={16} />
                    {t('setup:importLocalModel')}
                  </Button>
                }
              />
            </div>
          ) : (
            // Without the llama.cpp provider there is nothing to import into;
            // saying so beats rendering a button that cannot work.
            <p className="text-destructive mt-6 text-sm">
              {t('setup:noLocalEngine')}
            </p>
          )}

          {imported && (
            <p
              className="text-muted-foreground mt-4 text-sm"
              role="status"
              aria-live="polite"
            >
              {t('setup:importedModel', { name: imported })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default SetupScreen
