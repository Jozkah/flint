export interface SearchResult {
  title: string
  url: string
  snippet: string
  published_at?: string
}

export interface ImageResult {
  title: string
  image_url: string
  thumbnail_url?: string
  source_url: string
}

export interface FetchedPage {
  url: string
  title: string
  content: string
  truncated: boolean
}
