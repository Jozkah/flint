import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Eye,
  Wrench,
  Atom,
  Globe,
  Binary,
  Headphones,
  TextCursorInput,
} from 'lucide-react'
import { Fragment, memo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'

interface CapabilitiesProps {
  capabilities: string[]
  /** Small quiet glyphs, for a picker row (the design's `.caps`). */
  compact?: boolean
}

const Capabilities = memo(function Capabilities({
  capabilities,
  compact = false,
}: CapabilitiesProps) {
  const { t } = useTranslation()
  if (!capabilities.length) return null

  // Filter out proactive capability as it's now managed in MCP settings
  const filteredCapabilities = capabilities.filter((capability) => {
    return capability !== 'proactive'
  })

  return (
    <div
      className={
        compact
          ? 'flex gap-1 text-subtle-foreground [&_svg]:!size-3'
          : 'flex gap-0.5'
      }
    >
      {filteredCapabilities.map((capability: string, capIndex: number) => {
        let icon = null

        // Embedding models get special treatment with a distinct visual style
        const isEmbedding = capability === 'embeddings'

        if (capability === 'vision') {
          icon = <Eye className="size-4" />
        } else if (capability === 'audio') {
          icon = <Headphones className="size-3.5" />
        } else if (capability === 'tools') {
          icon = <Wrench className="size-3.5" />
        } else if (capability === 'reasoning') {
          icon = <Atom className="size-3.5" />
        } else if (capability === 'embeddings' || isEmbedding) {
          icon = <Binary className="size-3.5" />
        } else if (capability === 'raw_completion') {
          icon = <TextCursorInput className="size-3.5" />
        } else if (capability === 'web_search') {
          icon = <Globe className="size-3.5" />
        } else {
          icon = null
        }

        return (
          <Fragment key={`capability-${capIndex}`}>
            {icon && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={
                        compact
                          ? 'flex size-3.5 items-center justify-center'
                          : 'flex items-center gap-1 size-5 hover:bg-secondary rounded text-muted-foreground justify-center last:mr-1 transition-colors duration-150 ease-expo'
                      }
                    >
                      {icon}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {t(`common:capabilityTips.${capability}`, {
                        defaultValue: capability,
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </Fragment>
        )
      })}
    </div>
  )
})

export default Capabilities
