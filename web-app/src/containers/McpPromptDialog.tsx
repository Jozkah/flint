import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { missingMcpArguments } from '@/lib/mcpPrompts'
import type { MCPPromptInfo } from '@/services/mcp/types'

/**
 * Asks for an MCP prompt's arguments, then hands them back. Shown only when
 * the prompt declares arguments; one without is inserted at once. Cancel
 * inserts nothing.
 */
export function McpPromptDialog({
  prompt,
  busy,
  onSubmit,
  onCancel,
}: {
  prompt: MCPPromptInfo | null
  busy?: boolean
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    setValues({})
  }, [prompt])

  const missing = prompt ? missingMcpArguments(prompt, values) : []

  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="mcp-prompt-dialog">
        <DialogHeader>
          <DialogTitle>{prompt?.title || prompt?.name}</DialogTitle>
          <DialogDescription>
            {prompt?.description ||
              t('common:mcpPrompts.from', { server: prompt?.server ?? '' })}
          </DialogDescription>
        </DialogHeader>
        {prompt && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (missing.length === 0 && !busy) onSubmit(values)
            }}
          >
            {prompt.arguments.map((arg, i) => {
              const id = `mcp-prompt-arg-${arg.name}`
              return (
                <div key={arg.name} className="flex flex-col gap-1">
                  <label
                    htmlFor={id}
                    title={arg.required ? t('common:promptLibrary.requiredField') : undefined}
                    className={cn(
                      'text-xs font-medium text-muted-foreground',
                      arg.required && "after:ml-0.5 after:text-destructive after:content-['*']"
                    )}
                  >
                    {arg.title || arg.name}
                  </label>
                  <Input
                    id={id}
                    autoFocus={i === 0}
                    value={values[arg.name] ?? ''}
                    placeholder={arg.description ?? undefined}
                    aria-required={arg.required}
                    onChange={(e) =>
                      setValues((s) => ({ ...s, [arg.name]: e.target.value }))
                    }
                  />
                </div>
              )
            })}
            {missing.length > 0 && (
              <p role="status" className="text-xs text-muted-foreground">
                {t('common:promptLibrary.fillNeeded', { names: missing.join(', ') })}
              </p>
            )}
            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t('common:cancel')}
              </Button>
              <Button type="submit" disabled={missing.length > 0 || busy}>
                {t('common:promptLibrary.insert')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
