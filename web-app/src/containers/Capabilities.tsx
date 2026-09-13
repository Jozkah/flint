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
} from 'lucide-react'
import { Fragment, memo } from 'react'

interface CapabilitiesProps {
  capabilities: string[]
}

const Capabilities = memo(function Capabilities({ capabilities }: CapabilitiesProps) {
  if (!capabilities.length) return null

  // Filter out proactive capability as it's now managed in MCP settings
  const filteredCapabilities = capabilities.filter((capability) => {
    return capability !== 'proactive'
  })

  return (
    <div className="flex gap-0.5">
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
                      className="flex items-center gap-1 size-5 hover:bg-secondary rounded text-muted-foreground justify-center last:mr-1 transition-all"
                    >
                      {icon}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {capability === 'web_search'
                        ? 'Web Search'
                        : capability === 'embeddings'
                          ? 'Embedding Model (for RAG/vectors, not chat)'
                          : capability}
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
