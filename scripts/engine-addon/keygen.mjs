#!/usr/bin/env node
// Makes the Ed25519 key pair engine add-on packs are signed with.
//
//   node scripts/engine-addon/keygen.mjs [public-key-file]
//
// Prints the private seed (base64) to stdout: store it as the repository
// secret FLINT_ADDON_SIGNING_KEY and nowhere else. The public key is written
// to the given file (default: the one the app compiles in), to be committed.
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pubFile =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  path.resolve(here, '../../src-tauri/plugins/tauri-plugin-llamacpp/addon-signing.pub')

// Rotating the key invalidates every pack signed with the old one, so an
// existing public key is never replaced by accident.
if (fs.existsSync(pubFile) && !process.argv.includes('--force')) {
  console.error(`${pubFile} already exists; rerun with --force to rotate the signing key`)
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)

fs.writeFileSync(
  pubFile,
  '# Ed25519 public key engine add-on packs are verified with (engine/addon.rs).\n' +
    '# Made by scripts/engine-addon/keygen.mjs; the private half is the\n' +
    '# FLINT_ADDON_SIGNING_KEY repository secret.\n' +
    pub.toString('base64') +
    '\n'
)
console.error(`public key written to ${pubFile}`)
console.log(seed.toString('base64'))
