/**
 * Verify the Windows artifacts package-editions.ts just produced, deriving
 * every expected name from the active package.json identity. Unlike the
 * single-edition verifiers, this script follows whichever identity the
 * packaging run applied, so it validates both the original and the Coexist
 * edition with the same code.
 *
 * The target under verification is selected with DSH_EDITION_VERIFY_TARGET
 * ('installer' or 'portable'), set by package-editions.ts for each
 * electron-builder pass.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { editionWindowsArtifacts } from './package-editions.ts'

/** Inputs for one verification run, injectable by focused tests. */
export interface EditionArtifactVerificationOptions {
  /** Desktop package root containing package.json and dist/. */
  readonly desktopRoot: string
  /** Parsed package.json whose identity names the artifacts. */
  readonly manifest: Record<string, unknown>
  /** Which packaging pass just finished. */
  readonly target: 'installer' | 'portable'
}

/** Assert a file starts with a minimal MZ/PE portable-executable header. */
export function assertPortableExecutableHeader(path: string, label: string): void {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} is not a non-empty regular file: ${path}`)
  }
  // NSIS installer stubs point e_lfanew well past 0x80, so read the whole DOS
  // header area instead of assuming the signature sits in the first 132 bytes.
  const buffer = Buffer.alloc(4096)
  const descriptor = openSync(path, 'r')
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0)
    if (bytesRead < 0x40 || buffer.subarray(0, 2).toString('latin1') !== 'MZ') {
      throw new Error(`${label} does not have a Windows PE header: ${path}`)
    }
    const peOffset = buffer.readUInt32LE(0x3c)
    if (peOffset <= 0 || peOffset + 4 > stat.size || peOffset + 4 > bytesRead
      || buffer.subarray(peOffset, peOffset + 4).toString('latin1') !== 'PE\0\0') {
      throw new Error(`${label} does not have a Windows PE signature: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

/** Verify one edition packaging pass against its own identity. */
export function verifyEditionArtifacts(options: EditionArtifactVerificationOptions): void {
  const names = editionWindowsArtifacts(options.manifest)
  const dist = join(options.desktopRoot, 'dist')
  if (options.target === 'installer') {
    assertPortableExecutableHeader(join(dist, names.installer), `${names.installer} NSIS installer`)
    assertPortableExecutableHeader(
      join(dist, 'win-unpacked', names.unpackedExecutable),
      `unpacked edition application ${names.unpackedExecutable}`,
    )
    return
  }
  const portablePath = join(dist, names.portable)
  const stat = statSync(portablePath)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`edition portable archive is not a non-empty regular file: ${portablePath}`)
  }
  const entries = new AdmZip(portablePath).getEntries()
  const normalized = new Set(entries.map(entry => entry.entryName.replaceAll('\\', '/')))
  if (!normalized.has(names.unpackedExecutable)) {
    throw new Error(`edition portable archive is missing ${names.unpackedExecutable}: ${portablePath}`)
  }
  if (!normalized.has('resources/app/package.json')) {
    throw new Error(`edition portable archive is missing resources/app/package.json: ${portablePath}`)
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    verifyEditionArtifacts({
      desktopRoot,
      manifest: JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as Record<string, unknown>,
      target: process.env.DSH_EDITION_VERIFY_TARGET === 'portable' ? 'portable' : 'installer',
    })
    console.log('verify-edition-artifacts: edition artifacts match the active identity')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
