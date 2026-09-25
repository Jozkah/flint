import { useState, useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { TriangleAlert } from 'lucide-react'

interface AddProviderDialogProps {
  onCreateProvider: (
    name: string,
    baseUrl: string,
    apiKey: string,
    apiType: ProviderApiType
  ) => void
  children: React.ReactNode
}

const URL_PATTERN = /^https?:\/\/[^\s]+$/i

export function AddProviderDialog({
  onCreateProvider,
  children,
}: AddProviderDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiType, setApiType] = useState<ProviderApiType>('openai')
  const [error, setError] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setName('')
    setBaseUrl('')
    setApiKey('')
    setApiType('openai')
    setError(null)
  }

  const handleCreate = () => {
    const trimmedName = name.trim()
    const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
    const trimmedApiKey = apiKey.trim()
    if (!trimmedName || !trimmedBaseUrl || !trimmedApiKey) return
    if (!URL_PATTERN.test(trimmedBaseUrl)) {
      setError(t('provider:invalidBaseUrl'))
      return
    }
    onCreateProvider(trimmedName, trimmedBaseUrl, trimmedApiKey, apiType)
    reset()
    setIsOpen(false)
  }

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open) reset()
  }

  const canSubmit =
    name.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    apiKey.trim().length > 0
  const baseUrlPlaceholder =
    apiType === 'anthropic'
      ? t('provider:baseUrlPlaceholderAnthropic')
      : t('provider:baseUrlPlaceholder')

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-[460px] lg:max-w-[460px] xl:max-w-[460px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          nameInputRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('provider:addOpenAIProvider')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
          <label
            htmlFor="add-provider-name"
            className="text-xs font-medium text-fg-2"
          >
            {t('provider:nameLabel')}
          </label>
          <Input
            id="add-provider-name"
            ref={nameInputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('provider:enterNameForProvider')}
            onKeyDown={(e) => e.stopPropagation()}
          />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-2">
              {t('provider:apiTypeLabel')}
            </label>
            <RadioGroup
              value={apiType}
              onValueChange={(v) => setApiType(v as ProviderApiType)}
              className="flex flex-col gap-1"
            >
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-border px-2.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-hover-row has-[[data-state=checked]]:border-border-strong has-[[data-state=checked]]:bg-hover-btn sm:min-h-9">
                <RadioGroupItem value="openai" />
                {t('provider:apiTypeOpenAI')}
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-border px-2.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-hover-row has-[[data-state=checked]]:border-border-strong has-[[data-state=checked]]:bg-hover-btn sm:min-h-9">
                <RadioGroupItem value="anthropic" />
                {t('provider:apiTypeAnthropic')}
              </label>
            </RadioGroup>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-fg-2">
              {t('provider:baseUrlLabel')}
            </label>
            <Input
              className="font-mono"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                if (error) setError(null)
              }}
              placeholder={baseUrlPlaceholder}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-fg-2">
              {t('provider:apiKeyLabel')}
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('provider:apiKeyPlaceholder')}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  handleCreate()
                }
              }}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-xs text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </div>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto pointer-coarse:h-11"
            >
              {t('common:cancel')}
            </Button>
          </DialogClose>
          <Button
            disabled={!canSubmit}
            onClick={handleCreate}
            className="w-full sm:w-auto pointer-coarse:h-11"
            size="sm"
            aria-label={t('common:create')}
          >
            {t('common:create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
