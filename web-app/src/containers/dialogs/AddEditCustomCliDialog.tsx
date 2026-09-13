import { useState, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, Trash2 } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { EnvVar } from '@/hooks/useClaudeCodeModel'

interface AddEditCustomCliProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialEnvVars?: EnvVar[]
  initialCustomCli?: string
  onSave: (envVars: EnvVar[], customCli: string) => void
}

export default function AddEditCustomCliDialog({
  open,
  onOpenChange,
  initialEnvVars = [],
  initialCustomCli = '',
  onSave,
}: AddEditCustomCliProps) {
  const { t } = useTranslation()
  const [envVars, setEnvVars] = useState<EnvVar[]>([{ key: '', value: '' }])
  const [customCli, setCustomCli] = useState('')
  const initialized = useRef(false)

  // Initialize once when dialog opens
  useEffect(() => {
    if (open && !initialized.current) {
      setEnvVars(initialEnvVars.length > 0 ? initialEnvVars : [{ key: '', value: '' }])
      setCustomCli(initialCustomCli || '')
      initialized.current = true
    }
  }, [open, initialEnvVars, initialCustomCli])

  // Reset initialized flag when dialog closes
  useEffect(() => {
    if (!open) {
      initialized.current = false
    }
  }, [open])

  const handleAddEnv = () => {
    setEnvVars([...envVars, { key: '', value: '' }])
  }

  const handleRemoveEnv = (index: number) => {
    const newEnvVars = [...envVars]
    newEnvVars.splice(index, 1)
    setEnvVars(newEnvVars.length > 0 ? newEnvVars : [{ key: '', value: '' }])
  }

  const handleEnvKeyChange = (index: number, value: string) => {
    setEnvVars((prev) => {
      const updated = [...prev]
      updated[index] = { ...updated[index], key: value }
      return updated
    })
  }

  const handleEnvValueChange = (index: number, value: string) => {
    setEnvVars((prev) => {
      const updated = [...prev]
      updated[index] = { ...updated[index], value: value }
      return updated
    })
  }

  const handleSave = () => {
    // Filter out empty env vars
    const filteredEnvVars = envVars
      .filter((env) => env.key.trim() !== '')
      .map((env) => ({ key: env.key.trim(), value: env.value.trim() }))

    onSave(filteredEnvVars, customCli.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Environment Variables</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Custom CLI Command */}
          {/* <div className="space-y-2">
            <label className="text-sm mb-2 inline-block">
              Command
            </label>
            <Input
              value={customCli}
              onChange={(e) => setCustomCli(e.target.value)}
              placeholder="Enter custom CLI command"
            />
          </div> */}

          {/* Environment Variables */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm">Environment Variables</label>
              <button
                type="button"
                aria-label="Add environment variable"
                title="Add environment variable"
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sunken hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
                onClick={handleAddEnv}
              >
                <Plus className="size-4" aria-hidden />
              </button>
            </div>

            {envVars.map((env, index) => (
              <div key={`env-${index}`} className="flex items-center gap-2">
                <Input
                  value={env.key}
                  onChange={(e) => handleEnvKeyChange(index, e.target.value)}
                  placeholder="Key"
                  className="min-w-0 flex-1 font-mono"
                />
                <Input
                  value={env.value}
                  onChange={(e) => handleEnvValueChange(index, e.target.value)}
                  placeholder="Value"
                  className="min-w-0 flex-1"
                />
                {envVars.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove environment variable ${index + 1}`}
                    title="Remove"
                    className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sunken hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
                    onClick={() => handleRemoveEnv(index)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => onOpenChange(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            onClick={() => {
              handleSave()
              onOpenChange(false)
            }}
            size="sm"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
