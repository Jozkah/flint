import { invoke } from '@tauri-apps/api/core'
import { SearchResult, FetchedPage, ImageResult } from './types'

export { SearchResult, FetchedPage, ImageResult } from './types'

/**
 * One entry of the user's ordered search chain. When a chain is passed the
 * entries are tried top to bottom and `provider`/`apiKey`/`endpoint` are ignored.
 */
export type ChainEntry = {
  provider: string
  apiKey?: string
  endpoint?: string
}

export async function webSearch(
  query: string,
  count?: number,
  apiKey?: string,
  provider?: string,
  endpoint?: string,
  chain?: ChainEntry[]
): Promise<SearchResult[]> {
  return await invoke('plugin:websearch|web_search', {
    query,
    count,
    provider,
    apiKey,
    endpoint,
    chain,
  })
}

export async function imageSearch(
  query: string,
  count?: number,
  apiKey?: string,
  provider?: string,
  endpoint?: string,
  chain?: ChainEntry[]
): Promise<ImageResult[]> {
  return await invoke('plugin:websearch|image_search', {
    query,
    count,
    provider,
    apiKey,
    endpoint,
    chain,
  })
}

export async function webFetch(
  url: string,
  apiKey?: string,
  provider?: string,
  endpoint?: string,
  chain?: ChainEntry[]
): Promise<FetchedPage> {
  return await invoke('plugin:websearch|web_fetch', {
    url,
    provider,
    apiKey,
    endpoint,
    chain,
  })
}
