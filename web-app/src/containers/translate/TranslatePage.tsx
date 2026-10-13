import { useRef, useState } from 'react'
import { streamText } from 'ai'
import { ArrowLeftRight, Copy, Languages, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ModelFactory } from '@/lib/model-factory'
import {
  AUTO_LANGUAGE,
  TRANSLATE_LANGUAGES,
  buildTranslatePrompt,
} from '@/lib/translatePrompt'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * One-shot translation with the model picked in the model selector. Nothing is
 * saved: each run is a single user turn, so history never bloats the context.
 */
export function TranslatePage() {
  const { t } = useTranslation()
  const selectedModel = useModelProvider((s) => s.selectedModel)
  const selectedProvider = useModelProvider((s) => s.selectedProvider)
  const getProviderByName = useModelProvider((s) => s.getProviderByName)

  const [source, setSource] = useState(AUTO_LANGUAGE)
  const [target, setTarget] = useState('English')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const provider = getProviderByName(selectedProvider)
  const canRun = !!selectedModel && !!provider && input.trim().length > 0

  const run = async () => {
    if (!selectedModel || !provider || !input.trim()) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setOutput('')
    try {
      const model = await ModelFactory.createModel(selectedModel.id, provider)
      const result = streamText({
        model,
        prompt: buildTranslatePrompt(input.trim(), source, target),
        abortSignal: controller.signal,
        maxRetries: 0,
      })
      let text = ''
      for await (const delta of result.textStream) {
        text += delta
        setOutput(text)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(
          error instanceof Error ? error.message : t('common:translate.failed')
        )
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const swap = () => {
    if (source === AUTO_LANGUAGE) return
    setSource(target)
    setTarget(source)
    setInput(output)
    setOutput(input)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output)
      toast.success(t('common:translate.copied'))
    } catch {
      toast.error(t('common:translate.copyFailed'))
    }
  }

  const languageOptions = TRANSLATE_LANGUAGES.map((l) => (
    <option key={l} value={l}>
      {l}
    </option>
  ))

  return (
    <div
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto p-6"
      data-testid="translate-page"
    >
      <div className="flex items-center gap-2">
        <Languages className="size-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">
          {t('common:translate.title')}
        </h1>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {selectedModel
            ? t('common:translate.usingModel', {
                model: selectedModel.displayName ?? selectedModel.id,
              })
            : t('common:translate.noModel')}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-label={t('common:translate.from')}
          data-testid="translate-source"
          className="w-44"
        >
          <option value={AUTO_LANGUAGE}>{t('common:translate.detect')}</option>
          {languageOptions}
        </Select>
        <Button
          variant="ghost"
          size="icon"
          onClick={swap}
          disabled={source === AUTO_LANGUAGE}
          aria-label={t('common:translate.swap')}
        >
          <ArrowLeftRight />
        </Button>
        <Select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label={t('common:translate.to')}
          data-testid="translate-target"
          className="w-44"
        >
          {languageOptions}
        </Select>
        <div className="ml-auto flex gap-2">
          {running ? (
            <Button variant="outline" onClick={() => abortRef.current?.abort()}>
              <Square />
              {t('common:translate.stop')}
            </Button>
          ) : (
            <Button onClick={run} disabled={!canRun} data-testid="translate-run">
              {t('common:translate.translate')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('common:translate.inputPlaceholder')}
          className="min-h-48 resize-none"
          data-testid="translate-input"
        />
        <div className="relative">
          <Textarea
            value={output}
            readOnly
            placeholder={t('common:translate.outputPlaceholder')}
            className="min-h-48 resize-none"
            data-testid="translate-output"
          />
          {output && !running && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute right-2 top-2"
              onClick={copy}
              aria-label={t('common:translate.copy')}
            >
              <Copy />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
