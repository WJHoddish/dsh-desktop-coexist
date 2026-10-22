import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import {
  DESKTOP_EDITIONS,
  EDITION_PACKAGE_FIELDS,
  detectEditionIdentityKey,
  editionWindowsArtifacts,
  parseEditionsArguments,
  serializeDesktopManifest,
  withEditionIdentitySource,
  withEditionPackageFields,
} from '../scripts/package-editions.ts'
import {
  assertPortableExecutableHeader,
  verifyEditionArtifacts,
} from '../scripts/verify-edition-artifacts.ts'

const packageRoot = new URL('..', import.meta.url)
const temporaryRoots: string[] = []

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function portableExecutable(): Buffer {
  const executable = Buffer.alloc(132)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(128, 0x3c)
  executable.write('PE\0\0', 128, 'binary')
  return executable
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('edition identity sources', () => {
  const committedIdentity = readFileSync(new URL('src/product-identity.ts', packageRoot), 'utf8')

  it('detects the committed Coexist selection', () => {
    expect(detectEditionIdentityKey(committedIdentity)).toBe('coexist')
  })

  it('switches the selection line without touching anything else', () => {
    const original = withEditionIdentitySource(committedIdentity, 'original')
    expect(detectEditionIdentityKey(original)).toBe('stable')
    expect(original.split('\n')).toEqual(
      committedIdentity.split('\n').map(line =>
        line.startsWith('export const DESKTOP_PRODUCT_IDENTITY = ')
          ? 'export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable'
          : line),
    )
    expect(withEditionIdentitySource(original, 'coexist')).toBe(committedIdentity)
  })

  it('rejects a source without exactly one selection line', () => {
    expect(() => detectEditionIdentityKey('export const OTHER = 1\n')).toThrow('no single DESKTOP_PRODUCT_IDENTITY')
    const duplicated = `${committedIdentity}export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable\n`
    expect(() => detectEditionIdentityKey(duplicated)).toThrow('more than once')
  })
})

describe('edition package fields', () => {
  const committedManifest = readFileSync(new URL('package.json', packageRoot), 'utf8')
  const committed = JSON.parse(committedManifest) as Record<string, unknown>

  function buildSection(manifest: Record<string, unknown>): Record<string, unknown> {
    return (manifest.build ?? {}) as Record<string, unknown>
  }

  it('owns the same identity fields for both editions', () => {
    expect(Object.keys(EDITION_PACKAGE_FIELDS.coexist)).toEqual(Object.keys(EDITION_PACKAGE_FIELDS.original))
  })

  it('applies the original identity over the committed Coexist manifest', () => {
    const original = withEditionPackageFields(committed, 'original')
    const build = buildSection(original)
    expect(build).toMatchObject({
      appId: 'ai.deepseek.dsh.desktop',
      productName: 'DSH Desktop',
    })
    expect(original.desktopName).toBe('dsh-desktop.desktop')
    expect((build.nsis ?? {}) as Record<string, unknown>).toMatchObject({
      shortcutName: 'DSH Desktop',
      artifactName: 'DSH-Desktop-${version}-${arch}-Setup.${ext}',
    })
    expect((build.deb ?? {}) as Record<string, unknown>).toMatchObject({ packageName: 'dsh-desktop' })
  })

  it('round-trips both identity files back to the committed bytes', () => {
    const identity = readFileSync(new URL('src/product-identity.ts', packageRoot), 'utf8')
    const viaOriginal = withEditionPackageFields(committed, 'original')
    expect(serializeDesktopManifest(withEditionPackageFields(viaOriginal, 'coexist'))).toBe(committedManifest)
    expect(withEditionIdentitySource(withEditionIdentitySource(identity, 'original'), 'coexist')).toBe(identity)
  })

  it('creates missing intermediate objects for dotted fields', () => {
    const minimal = withEditionPackageFields({ version: '1.0.0' }, 'coexist')
    expect(buildSection(minimal)).toMatchObject({
      appId: 'ai.deepseek.dsh.desktop.coexist',
      productName: 'DSH Desktop Coexist',
    })
  })
})

describe('edition Windows artifact names', () => {
  it('derives the original edition names from a manifest', () => {
    const manifest = {
      version: '2.0.18',
      build: {
        productName: 'DSH Desktop',
        win: { artifactName: 'DSH-Desktop-${version}-${arch}-Portable.${ext}' },
        nsis: { artifactName: 'DSH-Desktop-${version}-${arch}-Setup.${ext}' },
      },
    }
    expect(editionWindowsArtifacts(manifest)).toEqual({
      installer: 'DSH-Desktop-2.0.18-x64-Setup.exe',
      portable: 'DSH-Desktop-2.0.18-x64-Portable.zip',
      unpackedExecutable: 'DSH Desktop.exe',
    })
  })

  it('derives the committed Coexist names, honoring an explicit executable name', () => {
    const committed = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
    const names = editionWindowsArtifacts({
      ...committed,
      build: { ...committed.build, win: { ...committed.build.win, executableName: 'dsh-desktop-coexist' } },
    })
    expect(names.installer).toBe('DSH-Desktop-Coexist-2.0.18-x64-Setup.exe')
    expect(names.portable).toBe('DSH-Desktop-Coexist-2.0.18-x64-Portable.zip')
    expect(names.unpackedExecutable).toBe('dsh-desktop-coexist.exe')
  })

  it('rejects manifests without artifact templates', () => {
    expect(() => editionWindowsArtifacts({ version: '1.0.0', build: {} })).toThrow('build.productName')
    expect(() => editionWindowsArtifacts({
      version: '1.0.0',
      build: { productName: 'DSH Desktop', win: { artifactName: 'x-${version}-${arch}-Portable.${ext}' } },
    })).toThrow('build.nsis.artifactName')
  })
})

describe('parseEditionsArguments', () => {
  it('defaults to every edition and both Windows targets', () => {
    expect(parseEditionsArguments([])).toEqual({
      editions: DESKTOP_EDITIONS,
      targets: ['nsis', 'zip'],
    })
  })

  it('accepts an explicit selection in order', () => {
    expect(parseEditionsArguments(['--editions', 'coexist', '--targets', 'nsis'])).toEqual({
      editions: ['coexist'],
      targets: ['nsis'],
    })
  })

  it('rejects unknown values, flags, and missing values', () => {
    expect(() => parseEditionsArguments(['--editions', 'beta'])).toThrow('--editions')
    expect(() => parseEditionsArguments(['--targets', 'dmg'])).toThrow('--targets')
    expect(() => parseEditionsArguments(['--editions'])).toThrow('requires a comma-separated value')
    expect(() => parseEditionsArguments(['--noise'])).toThrow('unknown argument')
  })
})

describe('verifyEditionArtifacts', () => {
  const coexistManifest = {
    version: '2.0.18',
    build: {
      productName: 'DSH Desktop Coexist',
      appId: 'ai.deepseek.dsh.desktop.coexist',
      win: { artifactName: 'DSH-Desktop-Coexist-${version}-${arch}-Portable.${ext}' },
      nsis: { artifactName: 'DSH-Desktop-Coexist-${version}-${arch}-Setup.${ext}' },
    },
  }
  const originalManifest = withEditionPackageFields(coexistManifest, 'original')

  it('accepts the identity-named installer and unpacked application', () => {
    const root = temporaryDirectory('dsh-editions-verify-')
    const unpacked = join(root, 'dist', 'win-unpacked')
    mkdirSync(unpacked, { recursive: true })
    writeFileSync(join(root, 'dist', 'DSH-Desktop-Coexist-2.0.18-x64-Setup.exe'), portableExecutable())
    writeFileSync(join(unpacked, 'DSH Desktop Coexist.exe'), portableExecutable())

    expect(() => verifyEditionArtifacts({
      desktopRoot: root,
      manifest: coexistManifest as unknown as Record<string, unknown>,
      target: 'installer',
    })).not.toThrow()
  })

  it('rejects artifacts left behind by the other edition', () => {
    const root = temporaryDirectory('dsh-editions-stale-')
    const unpacked = join(root, 'dist', 'win-unpacked')
    mkdirSync(unpacked, { recursive: true })
    // A previous original-edition build produced these files; the Coexist pass must not accept them.
    writeFileSync(join(root, 'dist', 'DSH-Desktop-2.0.18-x64-Setup.exe'), portableExecutable())
    writeFileSync(join(unpacked, 'DSH Desktop.exe'), portableExecutable())

    expect(() => verifyEditionArtifacts({
      desktopRoot: root,
      manifest: coexistManifest as unknown as Record<string, unknown>,
      target: 'installer',
    })).toThrow('DSH-Desktop-Coexist-2.0.18-x64-Setup.exe')
  })

  it('verifies the portable archive entries for the active edition', () => {
    const root = temporaryDirectory('dsh-editions-portable-')
    mkdirSync(join(root, 'dist'), { recursive: true })
    const archive = new AdmZip()
    archive.addFile('DSH Desktop.exe', portableExecutable())
    archive.addFile('resources/app/package.json', Buffer.from('{}'))
    archive.writeZip(join(root, 'dist', 'DSH-Desktop-2.0.18-x64-Portable.zip'))

    expect(() => verifyEditionArtifacts({
      desktopRoot: root,
      manifest: originalManifest as unknown as Record<string, unknown>,
      target: 'portable',
    })).not.toThrow()
  })

  it('rejects a non-executable installer header', () => {
    const root = temporaryDirectory('dsh-editions-header-')
    const unpacked = join(root, 'dist', 'win-unpacked')
    mkdirSync(unpacked, { recursive: true })
    const invalid = portableExecutable()
    invalid.write('NO', 0, 'ascii')
    writeFileSync(join(root, 'dist', 'DSH-Desktop-2.0.18-x64-Setup.exe'), invalid)
    writeFileSync(join(unpacked, 'DSH Desktop.exe'), portableExecutable())

    expect(() => verifyEditionArtifacts({
      desktopRoot: root,
      manifest: originalManifest as unknown as Record<string, unknown>,
      target: 'installer',
    })).toThrow('does not have a Windows PE header')
    expect(() => assertPortableExecutableHeader(join(root, 'dist', 'DSH-Desktop-2.0.18-x64-Setup.exe'), 'installer'))
      .toThrow('does not have a Windows PE header')
  })
})
