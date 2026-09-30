import { renderToString } from 'react-dom/server'
import App from './App'
import { NOT_FOUND, PAGES } from './pages/registry'

export const pages = [...PAGES.map(({ path, title, description }) => ({ path, title, description })), { path: NOT_FOUND.path, title: NOT_FOUND.title, description: NOT_FOUND.description }]

export function render(path: string): string {
  return renderToString(<App path={path} />)
}
