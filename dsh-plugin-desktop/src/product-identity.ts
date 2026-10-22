/**
 * Stable, Beta, and Coexist identities used to locate each edition's private app data.
 *
 * This package builds the Coexist edition: it installs and runs beside an
 * unchanged official DSH Desktop without sharing any install location,
 * user-data directory, DSH home, or update stream with it. The `stable` and
 * `beta` identities remain in the table because they define the legacy shared
 * home (`~/.dsh`) that only those two editions may adopt, and because the
 * Beta edition is still detected for cross-channel Profile warnings.
 */
export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop',
    appId: 'ai.deepseek.dsh.desktop',
    homeDirectoryName: '.dsh',
    /** Historically shared `~/.dsh` with the other official edition. */
    adoptsLegacySharedHome: true,
    /** Serves in-app updates from the official DSH Desktop release feed. */
    usesOfficialUpdateFeed: true,
    /** Announces the Stable-to-Next transition on this channel. */
    announcesNextTransition: true,
  }),
  beta: Object.freeze({
    releaseChannel: 'beta' as const,
    packageName: 'dsh-plugin-desktop-beta',
    productName: 'DSH Desktop Beta',
    appId: 'ai.deepseek.dsh.desktop.beta',
    homeDirectoryName: '.dsh-beta',
    /** Historically shared `~/.dsh` with the other official edition. */
    adoptsLegacySharedHome: true,
    /** Serves in-app updates from the official DSH Desktop release feed. */
    usesOfficialUpdateFeed: true,
    /** Announces the Stable-to-Next transition on this channel. */
    announcesNextTransition: true,
  }),
  coexist: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop Coexist',
    appId: 'ai.deepseek.dsh.desktop.coexist',
    homeDirectoryName: '.dsh-coexist',
    /** Never adopts the official editions' shared `~/.dsh`. */
    adoptsLegacySharedHome: false,
    /** The official feed ships official installers; the Coexist edition upgrades through its own installer. */
    usesOfficialUpdateFeed: false,
    /** The Stable-to-Next transition does not govern this edition. */
    announcesNextTransition: false,
  }),
})

export type DesktopProductIdentity = typeof DESKTOP_RELEASE_IDENTITIES[keyof typeof DESKTOP_RELEASE_IDENTITIES]

/** Coexist edition identity that must stay aligned with electron-builder. */
export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.coexist
export const OTHER_DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.beta
export const DESKTOP_PACKAGE_NAME = DESKTOP_PRODUCT_IDENTITY.packageName
export const BETA_DESKTOP_PACKAGE_NAME = OTHER_DESKTOP_PRODUCT_IDENTITY.packageName
export const DESKTOP_PRODUCT_NAME = DESKTOP_PRODUCT_IDENTITY.productName
export const DESKTOP_APP_ID = DESKTOP_PRODUCT_IDENTITY.appId
export const DESKTOP_RELEASE_CHANNEL = DESKTOP_PRODUCT_IDENTITY.releaseChannel
export const DESKTOP_HOME_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.homeDirectoryName

/** Both Desktop package identities are launcher-owned, never Profile plugins. */
export const DESKTOP_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  DESKTOP_PACKAGE_NAME,
  BETA_DESKTOP_PACKAGE_NAME,
])
