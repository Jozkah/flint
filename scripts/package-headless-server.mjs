import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const rust = spawnSync('cargo', [
  'build', '--release', '--locked', '--no-default-features', '--features', 'cli', '--bin', 'flint',
], { cwd: join(root, 'src-tauri'), stdio: 'inherit' })
if (rust.error) throw rust.error
if (rust.status !== 0) process.exit(rust.status ?? 1)

const suffix = process.platform === 'win32' ? '.exe' : ''
const source = join(root, 'src-tauri', 'target', 'release', `flint${suffix}`)
const assets = join(root, 'web-app', 'dist')
if (!existsSync(source) || !existsSync(join(assets, 'index.html'))) {
  throw new Error('Headless server binary or production web bundle is missing')
}
const destination = join(root, 'dist', 'headless')
mkdirSync(destination, { recursive: true })
cpSync(source, join(destination, `flint${suffix}`))
cpSync(assets, join(destination, 'web'), { recursive: true, force: true })
process.stdout.write(`Headless server package: ${destination}\n`)
