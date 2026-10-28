import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import {
  checkGitUrl,
  type InstallSource,
  type PluginSourceKind,
} from '@/lib/pluginStore'

/**
 * The install-by-source form shared by the Extensions tab and the Cowork
 * dialog: a local folder, a git URL or a marketplace name, with the field
 * validation. Running the install itself stays with the surface (the dialog
 * can cancel one, the tab cannot).
 */
export function usePluginInstallForm() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const [kind, setKind] = useState<PluginSourceKind>('local')
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [marketName, setMarketName] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)

  const chooseFolder = async () => {
    try {
      const picked = await serviceHub.dialog().open({ directory: true })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (path) {
        setLocalPath(path)
        setFieldError(null)
      }
    } catch (e) {
      // A failing picker used to be an unhandled rejection with no feedback.
      setFieldError(errorText(e))
    }
  }

  const gitCheck = checkGitUrl(gitUrl)
  const gitHost = gitCheck.ok ? gitCheck.host : null

  /** The source the form describes, or null after showing why it is not ready. */
  const buildSource = (): InstallSource | null => {
    if (kind === 'local') {
      if (!localPath.trim()) {
        setFieldError(t('plugins:install.errors.pathRequired'))
        return null
      }
      return { kind: 'local', path: localPath.trim() }
    }
    if (kind === 'git') {
      if (!gitCheck.ok) {
        setFieldError(
          t(
            gitCheck.reason === 'empty'
              ? 'plugins:install.errors.urlRequired'
              : 'plugins:install.errors.urlFormat'
          )
        )
        return null
      }
      return { kind: 'git', url: gitUrl.trim() }
    }
    if (!marketName.trim()) {
      setFieldError(t('plugins:install.errors.nameRequired'))
      return null
    }
    return { kind: 'marketplace', name: marketName.trim() }
  }

  return {
    kind,
    setKind,
    localPath,
    setLocalPath,
    gitUrl,
    setGitUrl,
    marketName,
    setMarketName,
    fieldError,
    setFieldError,
    gitCheck,
    gitHost,
    chooseFolder,
    buildSource,
  }
}
