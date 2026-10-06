import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import packageJson from './package.json'
import { execSync } from 'node:child_process'

// The commit this build is made from: CI provides it, a local build asks git.
// Empty when neither is available; the update check then reports unknown.
function buildCommit(): string {
  const fromCi = process.env.GITHUB_SHA?.trim()
  if (fromCi) return fromCi
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    plugins: [
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routeFileIgnorePattern: '.((test).ts)|test-page',
      }),
      react(),
      tailwindcss(),
      nodePolyfills({
        include: ['path'],
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@janhq/assistant-extension': path.resolve(__dirname, '../extensions/assistant-extension/dist/index.js'),
        '@janhq/conversational-extension': path.resolve(__dirname, '../extensions/conversational-extension/dist/index.js'),
        '@janhq/llamacpp-extension': path.resolve(__dirname, '../extensions/llamacpp-extension/dist/index.js'),
        '@janhq/mlx-extension': path.resolve(__dirname, '../extensions/mlx-extension/dist/index.js'),
        '@janhq/rag-extension': path.resolve(__dirname, '../extensions/rag-extension/dist/index.js'),
        '@janhq/vector-db-extension': path.resolve(__dirname, '../extensions/vector-db-extension/dist/index.js'),
      },
    },
    optimizeDeps: {
      // Extensions are prebuilt, self-contained ESM dist bundles. Excluding them
      // stops Vite's dev dep-optimizer from crawling/re-bundling them mid-boot,
      // which otherwise invalidates the in-flight dynamic import of the service
      // hub and surfaces as "Importing a module script failed" on cold start.
      exclude: [
        '@janhq/assistant-extension',
        '@janhq/conversational-extension',
        '@janhq/llamacpp-extension',
        '@janhq/mlx-extension',
        '@janhq/rag-extension',
        '@janhq/vector-db-extension',
      ],
    },
    define: {
      IS_TAURI: JSON.stringify(process.env.IS_TAURI === 'true'),
      IS_DEV: JSON.stringify(process.env.IS_DEV),
      IS_WEB_APP: JSON.stringify(process.env.IS_WEB_APP === 'true'),
      IS_MACOS: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('darwin') ?? false
      ),
      IS_WINDOWS: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('windows') ?? false
      ),
      IS_LINUX: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('linux') ?? false
      ),
      IS_IOS: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('ios') ?? false
      ),
      IS_ANDROID: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('android') ?? false
      ),
      PLATFORM: JSON.stringify(process.env.TAURI_ENV_PLATFORM),

      VERSION: JSON.stringify(packageJson.version),
      BUILD_COMMIT: JSON.stringify(buildCommit()),

    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // The app is served from disk inside the desktop shell, so bundle size is
    // not a download cost. The largest chunks are the route tree and mermaid
    // (itself loaded on demand).
    build: {
      chunkSizeWarningLimit: 2500,
    },
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell vite to ignore watching `src-tauri`
        ignored: [
          '**/src-tauri/**',
          // Test files are not part of the app graph; editing one made vite
          // full-reload the webview.
          '**/__tests__/**',
          '**/*.test.{ts,tsx}',
        ],
        usePolling: true
      },
    },
  }
})
