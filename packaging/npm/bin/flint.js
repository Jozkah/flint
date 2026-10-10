#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveTarget } = require('../lib/platform')

const target = resolveTarget()
const bin =
  process.env.FLINT_BIN ||
  (target ? path.join(__dirname, '..', 'vendor', target.bin) : '')

if (!bin || !fs.existsSync(bin)) {
  console.error(
    'flint: binary not found. Reinstall the package, or set FLINT_BIN to a flint binary.',
  )
  process.exit(1)
}

const res = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' })
if (res.error) {
  console.error(`flint: ${res.error.message}`)
  process.exit(1)
}
process.exit(res.status === null ? 1 : res.status)
