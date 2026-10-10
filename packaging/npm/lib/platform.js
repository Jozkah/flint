'use strict'

// Maps Node's platform/arch to the release asset key and binary file name.
const TARGETS = {
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', ext: 'tar.gz', bin: 'flint' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz', bin: 'flint' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', ext: 'tar.gz', bin: 'flint' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', ext: 'zip', bin: 'flint.exe' },
}

function resolveTarget(platform = process.platform, arch = process.arch) {
  return TARGETS[`${platform}-${arch}`] ?? null
}

module.exports = { TARGETS, resolveTarget }
