/**
 * Browser RAG service - documents are parsed on the Flint server with the
 * desktop's parser. Retrieval tools and embeddings need the local embedding
 * model and stay unavailable in the browser build.
 */

import { browserApi, jsonRequest } from '@/services/browserApi'
import { DefaultRAGService } from './default'

export class BrowserRAGService extends DefaultRAGService {
  async parseDocument(path: string, type?: string): Promise<string> {
    const result = await browserApi<{ text: string }>(
      '/api/v1/uploads/parse',
      jsonRequest('POST', { path, type: type ?? '' })
    )
    return result.text
  }
}
