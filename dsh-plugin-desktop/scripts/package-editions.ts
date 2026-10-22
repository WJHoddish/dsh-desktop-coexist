/**
 * Build the official (original) and Coexist editions of DSH Desktop from one
 * checkout, each from a clean output tree.
 *
 * Every edition owns a full identity: package.json build fields plus the
 * `DESKTOP_PRODUCT_IDENTITY` line in `src/product-identity.ts`. The script
 * snapshots both files, applies the requested edition, clears `dist/` and
 * `lib/`, rebuilds, and packages through the same Windows pipeline as
 * `dist:win`/`dist:win-portable` (package checks are skipped with
 * `DSH_PACKAGE_CHECK_ALREADY_RAN=1` because the committed-tree gate covers the
 * source; running it under a swapped identity would assert the wrong edition).
 * Artifacts are collected under `release/<edition>/` with a SHA-256 manifest,
 * and the snapshotted identity files are always restored afterwards.
 *
 * The shared `.desktop-build/` runtime staging is deliberately not cleared:
 * it is identity-independent, version-verified by the packaging pipeline, and
 * rebuilding it would re-download interpreter payloads.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createWindowsPackageOptions, packageWindowsArtifact } from './package-win.ts'
import { prepareDesktopInterpreters } from './prepare-runtime.ts'

/** Editions this script can package. */
export type DesktopEdition = 'original' | 'coexist'

/** Edition build order used when the caller does not select one. */
export const DESKTOP_EDITIONS: readonly DesktopEdition[] = ['original', 'coexist']

/** Windows packaging targets, named after the electron-builder target. */
export type DesktopEditionWindowsTarget = 'nsis' | 'zip'

/**
 * package.json identity fields each edition owns, as dotted paths into the
 * manifest. Every identity-bearing packaging field must stay listed here for
 * BOTH editions, or one edition would inherit the other's value.
 */
export const EDITION_PACKAGE_FIELDS: Readonly<Record<DesktopEdition, Readonly<Record<string, string>>>> = Object.freeze({
  original: Object.freeze({
    desktopName: 'dsh-desktop.desktop',
    'build.appId': 'ai.deepseek.dsh.desktop',
    'build.productName': 'DSH Desktop',
    'build.mac.extendInfo.NSMicrophoneUsageDescription': 'DSH Desktop uses the microphone for voice input.',
    'build.win.artifactName': 'DSH-Desktop-${version}-${arch}-Portable.${ext}',
    'build.nsis.shortcutName': 'DSH Desktop',
    'build.nsis.artifactName': 'DSH-Desktop-${version}-${arch}-Setup.${ext}',
    'build.linux.artifactName': 'DSH-Desktop-${version}-${arch}.${ext}',
    'build.linux.synopsis': 'Agentic coding desktop for the DeepSeek Harness',
    'build.linux.executableName': 'dsh-desktop',
    'build.deb.packageName': 'dsh-desktop',
  }),
  coexist: Object.freeze({
    desktopName: 'dsh-desktop-coexist.desktop',
    'build.appId': 'ai.deepseek.dsh.desktop.coexist',
    'build.productName': 'DSH Desktop Coexist',
    'build.mac.extendInfo.NSMicrophoneUsageDescription': 'DSH Desktop Coexist uses the microphone for voice input.',
    'build.win.artifactName': 'DSH-Desktop-Coexist-${version}-${arch}-Portable.${ext}',
    'build.nsis.shortcutName': 'DSH Desktop Coexist',
    'build.nsis.artifactName': 'DSH-Desktop-Coexist-${version}-${arch}-Setup.${ext}',
    'build.linux.artifactName': 'DSH-Desktop-Coexist-${version}-${arch}.${ext}',
    'build.linux.synopsis': 'Agentic coding desktop for the DeepSeek Harness (Coexist edition)',
    'build.linux.executableName': 'dsh-desktop-coexist',
    'build.deb.packageName': 'dsh-desktop-coexist',
  }),
})

const IDENTITY_LINE_PATTERN = /^(export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES\.)(coexist|stable)(\s*)$/gmu

/** The identity-table key backing an edition ('stable' is the original one). */
export function editionIdentityKey(edition: DesktopEdition): 'coexist' | 'stable' {
  return edition === 'original' ? 'stable' : 'coexist'
}

/** Report which identity-table key a product-identity.ts source selects. */
export function detectEditionIdentityKey(source: string): 'coexist' | 'stable' {
  const matches = [...source.matchAll(IDENTITY_LINE_PATTERN)]
  if (matches.length === 1) return matches[0]![2] as 'coexist' | 'stable'
  throw new Error(
    matches.length === 0
      ? 'product-identity.ts has no single DESKTOP_PRODUCT_IDENTITY selection line; update package-editions.ts for the new identity layout'
      : 'product-identity.ts selects DESKTOP_PRODUCT_IDENTITY more than once',
  )
}

/** Return the source with DESKTOP_PRODUCT_IDENTITY selecting the edition's key. */
export function withEditionIdentitySource(source: string, edition: DesktopEdition): string {
  detectEditionIdentityKey(source)
  return source.replace(IDENTITY_LINE_PATTERN, `$1${editionIdentityKey(edition)}$3`)
}

function setDeepField(record: Record<string, unknown>, dottedPath: string, value: string): void {
  const keys = dottedPath.split('.')
  let node: Record<string, unknown> = record
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys.at(-1)!] = value
}

/** Return a manifest copy with every edition-owned identity field applied. */
export function withEditionPackageFields<T extends Record<string, unknown>>(manifest: T, edition: DesktopEdition): T {
  const copy = structuredClone(manifest)
  for (const [dottedPath, value] of Object.entries(EDITION_PACKAGE_FIELDS[edition])) {
    setDeepField(copy, dottedPath, value)
  }
  return copy
}

/** Serialize a manifest the way the repository formats package.json. */
export function serializeDesktopManifest(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Resolve one electron-builder artifactName template. */
export function resolveArtifactTemplateName(
  template: string,
  version: string,
  arch: string,
  extension: string,
): string {
  return template
    .replaceAll('${version}', version)
    .replaceAll('${arch}', arch)
    .replaceAll('${ext}', extension)
}

/** Windows artifact names an edition must produce, derived from its manifest. */
export interface EditionWindowsArtifactNames {
  readonly installer: string
  readonly portable: string
  readonly unpackedExecutable: string
}

function requireTemplate(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`package.json ${label} must be a non-empty string`)
  }
  return value
}

/** Derive the edition's expected Windows artifact names from the active manifest. */
export function editionWindowsArtifacts(manifest: Record<string, unknown>): EditionWindowsArtifactNames {
  const version = requireTemplate(manifest.version, 'version')
  const build = (manifest.build ?? {}) as Record<string, unknown>
  const productName = requireTemplate(build.productName, 'build.productName')
  const win = (build.win ?? {}) as Record<string, unknown>
  const nsis = (build.nsis ?? {}) as Record<string, unknown>
  const executableName = typeof win.executableName === 'string' && win.executableName.length > 0
    ? win.executableName
    : productName
  return Object.freeze({
    installer: resolveArtifactTemplateName(
      requireTemplate(nsis.artifactName, 'build.nsis.artifactName'),
      version,
      'x64',
      'exe',
    ),
    portable: resolveArtifactTemplateName(
      requireTemplate(win.artifactName, 'build.win.artifactName'),
      version,
      'x64',
      'zip',
    ),
    unpackedExecutable: `${executableName}.exe`,
  })
}

/** Validated command-line request for one edition packaging run. */
export interface EditionsRequest {
  readonly editions: readonly DesktopEdition[]
  readonly targets: readonly DesktopEditionWindowsTarget[]
}

function parseList<T extends string>(value: string, allowed: readonly T[], label: string): readonly T[] {
  const entries = value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  const unique: T[] = []
  for (const entry of entries) {
    if (!allowed.includes(entry as T)) {
      throw new Error(`--${label} entries must be ${allowed.join(' or ')}; received ${JSON.stringify(value)}`)
    }
    if (!unique.includes(entry as T)) unique.push(entry as T)
  }
  if (unique.length === 0) throw new Error(`--${label} must name at least one of ${allowed.join(', ')}`)
  return unique
}

/** Parse the edition packaging arguments. */
export function parseEditionsArguments(argv: readonly string[]): EditionsRequest {
  const request: { editions?: readonly DesktopEdition[]; targets?: readonly DesktopEditionWindowsTarget[] } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--editions' || argument === '--targets') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a comma-separated value`)
      }
      if (argument === '--editions') request.editions = parseList(value, DESKTOP_EDITIONS, 'editions')
      else request.targets = parseList(value, ['nsis', 'zip'] as const, 'targets')
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return Object.freeze({
    editions: request.editions ?? DESKTOP_EDITIONS,
    targets: request.targets ?? ['nsis', 'zip'] as const,
  })
}

function editionWindowsTargetKind(target: DesktopEditionWindowsTarget): 'installer' | 'portable' {
  return target === 'nsis' ? 'installer' : 'portable'
}

/** Remove every artifact the previous packaging of any edition could leave behind. */
function cleanEditionOutputs(desktopRoot: string, log: (message: string) => void): void {
  for (const relative of ['dist', 'lib']) {
    rmSync(join(desktopRoot, relative), { recursive: true, force: true })
  }
  log('cleared dist/ and lib/ so this edition cannot reuse a previous build\'s outputs')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function requireArtifactStat(path: string, label: string): Stats {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size === 0) throw new Error(`${label} is not a non-empty regular file: ${path}`)
  return stat
}

/** Copy one edition's distributables into release/<edition>/ with a digest manifest. */
async function collectEditionArtifacts(
  desktopRoot: string,
  edition: DesktopEdition,
  manifest: Record<string, unknown>,
  names: EditionWindowsArtifactNames,
  targets: readonly DesktopEditionWindowsTarget[],
  log: (message: string) => void,
): Promise<void> {
  const editionRoot = join(desktopRoot, 'release', edition)
  rmSync(editionRoot, { recursive: true, force: true })
  mkdirSync(editionRoot, { recursive: true })
  const dist = join(desktopRoot, 'dist')
  const wanted: ReadonlyArray<[DesktopEditionWindowsTarget, string]> = [
    ['nsis', names.installer],
    ['zip', names.portable],
  ]
  const files: { readonly name: string; readonly bytes: number; readonly sha256: string }[] = []
  for (const [target, name] of wanted) {
    if (!targets.includes(target)) continue
    const source = join(dist, name)
    const stat = requireArtifactStat(source, `${edition} ${target} artifact`)
    copyFileSync(source, join(editionRoot, name))
    files.push(Object.freeze({ name, bytes: stat.size, sha256: await sha256File(source) }))
  }
  const build = (manifest.build ?? {}) as Record<string, unknown>
  const summary = Object.freeze({
    edition,
    productName: build.productName,
    appId: build.appId,
    desktopName: manifest.desktopName,
    version: manifest.version,
    generatedAt: new Date().toISOString(),
    targets: [...targets],
    files: Object.freeze(files),
  })
  writeFileSync(join(editionRoot, 'artifacts.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
  log(`collected ${edition} artifacts into release/${edition}/`)
}

/** Byte-exact snapshots of the two identity files a run swaps and restores. */
interface IdentitySnapshot {
  readonly manifest: Buffer
  readonly identitySource: Buffer
}

function readIdentitySnapshot(manifestPath: string, identityPath: string): IdentitySnapshot {
  return Object.freeze({
    manifest: readFileSync(manifestPath),
    identitySource: readFileSync(identityPath),
  })
}

function applyEditionToTree(
  edition: DesktopEdition,
  manifestPath: string,
  identityPath: string,
  log: (message: string) => void,
): Record<string, unknown> {
  const manifest = withEditionPackageFields(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
    edition,
  )
  writeFileSync(manifestPath, serializeDesktopManifest(manifest))
  writeFileSync(identityPath, withEditionIdentitySource(readFileSync(identityPath, 'utf8'), edition))
  const build = (manifest.build ?? {}) as Record<string, unknown>
  log(`identity applied: ${String(build.productName)} (${String(build.appId)})`)
  return manifest
}

function restoreIdentitySnapshot(snapshot: IdentitySnapshot, manifestPath: string, identityPath: string): void {
  writeFileSync(manifestPath, snapshot.manifest)
  writeFileSync(identityPath, snapshot.identitySource)
  const restored = readIdentitySnapshot(manifestPath, identityPath)
  if (!restored.manifest.equals(snapshot.manifest) || !restored.identitySource.equals(snapshot.identitySource)) {
    throw new Error('failed to restore the identity files after edition packaging; inspect git status')
  }
}

/** Package the requested editions on a native Windows host, always restoring the tree. */
async function packageEditions(argv: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('edition packaging currently supports the native Windows x64 pipeline; run it on Windows')
  }
  const request = parseEditionsArguments(argv)
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const manifestPath = join(desktopRoot, 'package.json')
  const identityPath = join(desktopRoot, 'src', 'product-identity.ts')
  const snapshot = readIdentitySnapshot(manifestPath, identityPath)
  const committedKey = detectEditionIdentityKey(snapshot.identitySource.toString('utf8'))
  const log = (message: string): void => { console.log(`package-editions: ${message}`) }
  log(`tree identity before this run: ${committedKey}`)
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
  const commandShell = windowsRoot === undefined || windowsRoot.length === 0
    ? 'cmd.exe'
    : join(windowsRoot, 'System32', 'cmd.exe')
  const baseOptions = createWindowsPackageOptions('./verify-edition-artifacts.ts')
  const interrupted = { value: false }
  const onSignal = (): void => {
    if (interrupted.value) return
    interrupted.value = true
    restoreIdentitySnapshot(snapshot, manifestPath, identityPath)
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    // Interpreter payloads are edition-independent; download once for both.
    await prepareDesktopInterpreters({ desktopRoot })
    for (const edition of request.editions) {
      log(`=== building the ${edition} edition (${request.targets.join(', ')}) ===`)
      const manifest = applyEditionToTree(edition, manifestPath, identityPath, log)
      cleanEditionOutputs(desktopRoot, log)
      const build = spawnSync(commandShell, ['/d', '/s', '/c', 'corepack yarn workspace dsh-plugin-desktop build'], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: 'inherit',
      })
      if (build.error !== undefined) throw build.error
      if (build.status !== 0) throw new Error(`edition build exited with ${String(build.status)}`)
      for (const target of request.targets) {
        packageWindowsArtifact(
          {
            ...baseOptions,
            env: {
              ...process.env,
              DSH_PACKAGE_CHECK_ALREADY_RAN: '1',
              DSH_EDITION_VERIFY_TARGET: editionWindowsTargetKind(target),
            },
          },
          target,
          editionWindowsTargetKind(target) === 'installer' ? 'installer' : 'portable archive',
        )
      }
      await collectEditionArtifacts(
        desktopRoot,
        edition,
        manifest,
        editionWindowsArtifacts(manifest),
        request.targets,
        log,
      )
    }
  } finally {
    restoreIdentitySnapshot(snapshot, manifestPath, identityPath)
    log('identity files restored to their pre-run state')
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    await packageEditions(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
