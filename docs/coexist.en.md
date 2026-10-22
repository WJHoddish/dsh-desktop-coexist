# DSH Desktop Coexist edition

This document explains how the **DSH Desktop Coexist** edition built from this repository runs beside an already-installed official DSH Desktop without interference. The Coexist edition reuses the repository's existing Stable/Beta dual-edition isolation mechanism; this checkout simply retargets the Stable package identity to a new third identity.

## Design

The Coexist edition shares no writable path or registered system resource with the official edition:

| Resource | Official edition | Coexist edition |
| --- | --- | --- |
| Product name / window and tray identity | DSH Desktop | DSH Desktop Coexist |
| Windows AppUserModelID / appId | `ai.deepseek.dsh.desktop` | `ai.deepseek.dsh.desktop.coexist` |
| Windows install directory (per user) | `%LOCALAPPDATA%\Programs\DSH Desktop` | `%LOCALAPPDATA%\Programs\DSH Desktop Coexist` |
| Windows executable | `DSH Desktop.exe` | `DSH Desktop Coexist.exe` |
| Uninstall entry (Add/Remove Programs) | derived from the official appId | derived from the Coexist appId; two independent records |
| User-data directory (settings, cache, logs, crash dumps, update state) | `%APPDATA%\DSH Desktop` | `%APPDATA%\DSH Desktop Coexist` |
| macOS application bundle | `DSH Desktop.app` (bundle ID `ai.deepseek.dsh.desktop`) | `DSH Desktop Coexist.app` (bundle ID `ai.deepseek.dsh.desktop.coexist`) |
| Linux package / desktop entry | `dsh-desktop` / `dsh-desktop.desktop` | `dsh-desktop-coexist` / `dsh-desktop-coexist.desktop` |
| DSH home (Profiles, sessions, market data) | `~/.dsh` | `~/.dsh-coexist` |

Chromium caches, GPU caches, and logs all live inside each edition's own user-data directory, so they are isolated by construction. Electron's single-instance lock is keyed by the user-data directory, so both editions can run at the same time without stealing each other's lock. The local web port starts at 43120 and shifts automatically on collision, so simultaneous runs each get their own port.

Beyond paths, the Coexist edition disables two behaviors that would otherwise reach the official edition:

- **It never adopts the shared DSH home.** Official Stable/Beta fall back to the historically shared `~/.dsh` when their own home does not exist yet. The Coexist edition explicitly disables that fallback: its first launch creates and uses `~/.dsh-coexist` and never reads or writes the official home.
- **It does not use the official update feed.** In-app updates download official installers, which would act on the official edition rather than this one. The Coexist edition disables background update polling by default, packaged builds can never download and run an official installer, and the Stable-to-Next transition notice is suppressed. Upgrade the Coexist edition by installing its own newer installer.

## Building and installing

Build the Coexist installers from this repository with the usual commands:

```bash
corepack yarn install --immutable
corepack yarn dist:win            # Windows NSIS installer (DSH-Desktop-Coexist-<version>-x64-Setup.exe)
corepack yarn dist:win-portable   # Windows portable archive
corepack yarn dist:mac            # macOS
corepack yarn dist:linux          # Linux AppImage / deb
```

### Packaging both editions in one run

`corepack yarn dist:win:editions` packages the **original** and the **Coexist** edition (Windows x64 NSIS installer plus portable archive) in one run. Its isolation guarantees:

- Before each edition, its identity (the `package.json` packaging fields plus the identity selection in `src/product-identity.ts`) is applied to the tree, then `dist/` and `lib/` are **cleared** and the package is rebuilt, so no packaging round can reuse or pollute outputs from a previous one; the compiled output always carries the current round's identity.
- After each round, an identity-aware verifier checks the artifact names and PE headers against the active identity, so stale artifacts left by the other edition cannot pass.
- Artifacts are collected under `dsh-plugin-desktop/release/original/` and `release/coexist/` (each with a SHA-256 `artifacts.json` manifest) and never overwrite each other.
- The two identity files are always restored byte-exact when the run ends, including on interruption.
- The shared `.desktop-build/` runtime staging is not cleared: it is identity-independent, version-verified by the packaging pipeline, and skipping the clear avoids re-downloading interpreter payloads.

Options: `--editions original,coexist` (selection and order) and `--targets nsis,zip` (artifact kinds). The command skips the in-tree package gate (`DSH_PACKAGE_CHECK_ALREADY_RAN=1`, because that gate asserts the committed Coexist identity); run `corepack yarn check` separately.

Installing the Coexist edition does not affect an installed official edition: the different appId yields a different install directory, Start Menu/desktop shortcuts ("DSH Desktop Coexist"), and uninstall registry entry. The installer's app-running check matches only the `DSH Desktop Coexist.exe` process and never terminates official-edition processes.

## Launching and switching

- Each edition has its own shortcuts and executable; both can be launched and used at the same time, and they group as separate applications in the taskbar.
- Version identification: the product name "DSH Desktop Coexist" appears in window titles, tray menus, About panels, the installer, and the uninstall entry.
- Data-directory switching:
  - The Coexist edition defaults to `~/.dsh-coexist`, fully independent of the official edition.
  - Setting the `DSH_HOME` environment variable points either edition at any home directory (both editions honor it unconditionally). This is the one supported way to mount another data tree temporarily; without it, each edition always uses its own directory.

## Upgrading and uninstalling

- **Upgrading**: run a newer Coexist installer over the existing installation (NSIS locates the same install via the appId). The official edition's automatic or manual updates likewise act only on the official edition.
- **Uninstalling**: uninstall each edition separately from Add/Remove Programs (or `/Applications` on macOS, or the package manager on Linux). Uninstalling the Coexist edition removes only its own install directory and shortcuts and never touches the official edition's program files, settings, or `~/.dsh` home — and vice versa. Each edition's user-data directory (`%APPDATA%\DSH Desktop Coexist` versus `%APPDATA%\DSH Desktop`) and DSH home (`~/.dsh-coexist` versus `~/.dsh`) survive uninstallation; delete them manually if you want them gone.

## Implementation notes

The identity and behavior flags live in the `coexist` entry of `dsh-plugin-desktop/src/product-identity.ts` (product name, appId, home directory name, plus the `adoptsLegacySharedHome` / `usesOfficialUpdateFeed` / `announcesNextTransition` behavior flags). The electron-builder identity lives in the `build` section of `dsh-plugin-desktop/package.json`. The Beta variant (`dsh-plugin-desktop-beta`) keeps its official identity; only the behavior flags were synchronized into its shared sources.
