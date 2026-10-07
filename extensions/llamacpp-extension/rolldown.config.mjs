import { defineConfig } from 'rolldown'
import pkgJson from './package.json' with { type: 'json' }
import settingJson from './settings.json' with { type: 'json' }

const define = {
  SETTINGS: JSON.stringify(settingJson),
  ENGINE: JSON.stringify(pkgJson.engine),
  IS_WINDOWS: JSON.stringify(process.platform === 'win32'),
  IS_MAC: JSON.stringify(process.platform === 'darwin'),
  IS_LINUX: JSON.stringify(process.platform === 'linux'),
}

export default defineConfig([
  {
    input: 'src/index.ts',
    output: {
      format: 'esm',
      file: 'dist/index.js',
    },
    platform: 'browser',
    define,
    inject: process.env.IS_DEV ? {} : {
      fetch: ['@tauri-apps/plugin-http', 'fetch'],
    },
  },
  // The copy the browser build of the app uses (`flint serve`). It keeps the
  // Tauri API packages external, so the web app can resolve them to its own
  // stand-ins instead of the inlined copies that call a bridge a browser does
  // not have, and it leaves `fetch` as the page's own.
  {
    input: 'src/index.ts',
    output: {
      format: 'esm',
      file: 'dist/index.web.js',
    },
    platform: 'browser',
    define,
    external: [/^@tauri-apps\//],
  },
])
