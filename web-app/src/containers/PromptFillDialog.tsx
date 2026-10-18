import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  fillPrompt,
  missingVars,
  parseVars,
  type LibraryPrompt,
} from '@/lib/promptLibrary'

/**
 * Asks for a library prompt's variables, then hands back the finished text.
 * Shown only when the prompt has variables; a plain prompt is inserted at
 * once. Cancel inserts nothing.
 */
export function PromptFillDialog({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: LibraryPrompt | null
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const vars = useMemo(() => (prompt ? parseVars(prompt.body) : []), [prompt])
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    setValues({})
  }, [prompt])

  const missing = prompt ? missingVars(prompt.body, values) : []

  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="prompt-fill-dialog">
        <DialogHeader>
          <DialogTitle>{prompt?.name}</DialogTitle>
        </DialogHeader>
        {prompt && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (missing.length === 0) onSubmit(fillPrompt(prompt.body, values))
            }}
          >
            {vars.map((v, i) => {
              const id = `prompt-var-${v.name}`
              const long = (v.default ?? '').length > 60
              return (
                <div key={v.name} className="flex flex-col gap-1">
                  <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
                    {v.name}
                  </label>
                  {long ? (
                    <Textarea
                      id={id}
                      autoFocus={i === 0}
                      rows={3}
                      value={values[v.name] ?? ''}
                      placeholder={v.default}
                      onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                    />
                  ) : (
                    <Input
                      id={id}
                      autoFocus={i === 0}
                      value={values[v.name] ?? ''}
                      placeholder={v.default}
                      onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                    />
                  )}
                </div>
              )
            })}
            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t('common:cancel')}
              </Button>
              <Button type="submit" disabled={missing.length > 0}>
                {t('common:promptLibrary.insert')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
