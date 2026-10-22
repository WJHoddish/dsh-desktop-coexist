# DSH Desktop 共存版（Coexist）

本文说明本仓库构建出的 **DSH Desktop Coexist**（共存版）如何与一台已经安装了官方 DSH Desktop（原版）的机器并存运行、互不干扰。共存版沿用仓库既有的 Stable/Beta 双版本隔离机制，只是把本仓库的 Stable 包身份切换为一个全新的第三身份。

## 设计原则

共存版与原版不共享任何可写路径或系统注册资源：

| 资源 | 原版（官方安装） | 共存版 |
| --- | --- | --- |
| 产品名 / 窗口与托盘标识 | DSH Desktop | DSH Desktop Coexist |
| Windows AppUserModelID / appId | `ai.deepseek.dsh.desktop` | `ai.deepseek.dsh.desktop.coexist` |
| Windows 安装目录（每用户） | `%LOCALAPPDATA%\Programs\DSH Desktop` | `%LOCALAPPDATA%\Programs\DSH Desktop Coexist` |
| Windows 可执行文件 | `DSH Desktop.exe` | `DSH Desktop Coexist.exe` |
| 卸载入口（添加/删除程序） | 由原版 appId 派生 | 由共存版 appId 派生，两条记录独立 |
| 用户数据目录（配置、缓存、日志、崩溃转储、更新状态） | `%APPDATA%\DSH Desktop` | `%APPDATA%\DSH Desktop Coexist` |
| macOS 应用包 | `DSH Desktop.app`（Bundle ID `ai.deepseek.dsh.desktop`） | `DSH Desktop Coexist.app`（Bundle ID `ai.deepseek.dsh.desktop.coexist`） |
| Linux 包名 / 桌面入口 | `dsh-desktop` / `dsh-desktop.desktop` | `dsh-desktop-coexist` / `dsh-desktop-coexist.desktop` |
| DSH 主目录（Profiles、会话、插件市场数据） | `~/.dsh` | `~/.dsh-coexist` |

Chromium 的缓存、GPU 缓存与日志都位于各自的用户数据目录之内，因此天然隔离。Electron 的单实例锁也以用户数据目录为键：两个版本可以同时启动，互不抢锁。本机 Web 端口从 43120 起分配并在占用时自动顺延，同时运行时各自获得独立端口。

除路径外，共存版还规避了两处会"碰到"原版的行为：

- **不接管共享主目录**：官方 Stable/Beta 在自身主目录不存在时会沿用历史上共享的 `~/.dsh`。共存版显式关闭该回退，首次启动即创建并使用 `~/.dsh-coexist`，绝不读写原版的主目录。
- **不使用官方更新源**：应用内更新下载的是官方安装器，会作用于原版而非共存版。共存版默认关闭后台更新轮询，且打包后的版本永远无法下载并运行官方安装器；Stable→Next 迁移公告同样不再弹出。共存版的升级通过安装它自己的新版安装器完成。

## 构建与安装

从本仓库构建共存版安装包（与原仓库命令一致）：

```bash
corepack yarn install --immutable
corepack yarn dist:win            # Windows NSIS 安装器（DSH-Desktop-Coexist-<版本>-x64-Setup.exe）
corepack yarn dist:win-portable   # Windows 免安装压缩包
corepack yarn dist:mac            # macOS
corepack yarn dist:linux          # Linux AppImage / deb
```

安装共存版不会影响已安装的原版：不同 appId 意味着不同的安装目录、开始菜单/桌面快捷方式（"DSH Desktop Coexist"）与卸载注册表项；安装器的"应用正在运行"检查只匹配 `DSH Desktop Coexist.exe` 进程，不会结束原版进程。

## 启动与切换

- 两个版本各自拥有快捷方式与可执行文件，可同时启动、同时使用；任务栏中作为不同应用分组显示。
- 版本识别：窗口标题、托盘菜单、关于信息中的产品名为 "DSH Desktop Coexist"；安装器与卸载入口同样以此命名。
- 数据目录切换：
  - 共存版默认使用 `~/.dsh-coexist`，与原版完全独立。
  - 设置 `DSH_HOME` 环境变量可让任一版本显式指向任意主目录（两个版本都会无条件尊重该变量）。这是让共存版临时挂载另一份数据的唯一受支持方式；不设置时两者永远各用各的目录。

## 升级与卸载

- **升级**：用新版共存版安装器覆盖安装即可（NSIS 按 appId 定位同一安装）。原版的自动更新或手动安装器更新同样只作用于原版。
- **卸载**：在系统的"添加/删除程序"（或 macOS 的 `/Applications`、Linux 的包管理器）中分别卸载，卸载共存版只删除它自己的安装目录与快捷方式，不会触碰原版的程序、配置或 `~/.dsh` 主目录；反之亦然。各自的用户数据目录（`%APPDATA%\DSH Desktop Coexist` 与 `%APPDATA%\DSH Desktop`）和主目录（`~/.dsh-coexist` 与 `~/.dsh`）在卸载后仍保留，需要清理时手动删除。

## 实现说明

身份与行为开关集中在 `dsh-plugin-desktop/src/product-identity.ts` 的 `coexist` 条目（产品名、appId、主目录名，以及 `adoptsLegacySharedHome` / `usesOfficialUpdateFeed` / `announcesNextTransition` 三个行为开关）。electron-builder 身份位于 `dsh-plugin-desktop/package.json` 的 `build` 段。Beta 变体（`dsh-plugin-desktop-beta`）保持官方身份不变，仅同步了共享源码中的行为开关。
