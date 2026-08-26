#!/usr/bin/env node
// dsh-preset-flash-director — zero-dependency installer for the
// "Flash 主控 · Pro 专家" DeepSeek Harness agent preset + its config UI.
//
// Commands:
//   install      copy the preset into $DSH_HOME/.agent-presets/flash-director,
//                then deploy the config UI (dsh-preset-flash-director) into the
//                DSH web profile (best-effort)
//   install-ui   deploy ONLY the config UI into the DSH web profile
//                (for manual cp -r installs that already have the preset)
//   uninstall    remove the installed preset (keeps a timestamped backup)
//   info         print where the preset/UI live and install state
//   --version    print the package version
//
// UI deployment (web profile) — the whole project IS the plugin:
//   1. copy <pkg>/{lib,flash-director,cordis.patch.yml,package.json,README.md,LICENSE}
//      -> $DSH_HOME/plugins/dsh-preset-flash-director
//      (NOT under .agent-presets/ — that dir's scanner treats every child as
//      a preset slot and a dir without agent.cordis.yml shows as "broken")
//   2. wire $DSH_HOME/profiles/web/package.json:
//      dependencies + "dsh-preset-flash-director": "link:<ui target>"
//      dsh.profile.bundles + "dsh-preset-flash-director"
//   3. run `pnpm install` in the profile (warn + manual hint if unavailable)
//   4. print: restart DSH Desktop to activate
//
// 首选安装方式是 `dsh plugin --profile web add <仓库路径>`（= pnpm add + 自动
// reconcile bundles）；本 install-ui 是无需 dsh CLI 的等价位。
// The plugin locates the active preset via $FLASH_DIRECTOR_PRESET_DIR /
// $DSH_HOME/.agent-presets/flash-director (see lib/paths.mjs), independent of
// where the plugin itself is installed — so the copied location is arbitrary.

import { cp, mkdir, rename, stat, readFile, writeFile, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_SOURCE = join(ROOT, 'flash-director')
const PRESET_ID = 'flash-director'
const UI_SOURCE = ROOT // 整个项目即插件包
const UI_ID = 'dsh-preset-flash-director'
// 部署时只拷贝插件运行所需的文件（排除 bin/scripts/test 等非运行期内容）
const UI_COPY_ENTRIES = ['lib', 'flash-director', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']

// 跨平台用户主目录：Windows 常无 HOME（PowerShell/cmd 直跑 .mjs 或 npx shim），
// 用 os.homedir() 而非 process.env.HOME，避免静默装到 cwd 相对路径 .dsh。
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = homedir()
  if (!home) {
    throw new Error('无法解析用户主目录（HOME/USERPROFILE 缺失）。请设置 DSH_HOME 环境变量后重试。')
  }
  return join(home, '.dsh')
}

function presetTarget() {
  return join(dshHome(), '.agent-presets', PRESET_ID)
}

function uiTarget() {
  return join(dshHome(), 'plugins', UI_ID)
}

function webProfileDir() {
  return join(dshHome(), 'profiles', 'web')
}

function webProfileManifest() {
  return join(webProfileDir(), 'package.json')
}

async function dirExists(p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function usage() {
  return [
    'dsh-preset-flash-director — install the "Flash 主控 · Pro 专家" DSH preset + config UI',
    '',
    'usage: dsh-preset-flash-director <install|install-ui|uninstall|uninstall-ui|info>',
    '       dsh-preset-flash-director --version',
    '',
    '  install       copy the preset into $DSH_HOME/.agent-presets/flash-director,',
    '                then deploy the config UI into the DSH web profile (best-effort)',
    '  install-ui    deploy ONLY the config UI into the DSH web profile',
    '                (for manual cp -r installs that already have the preset)',
    '  uninstall     remove the installed preset, keeping a .bak-<ts> backup',
    '  uninstall-ui  remove the config UI from the web profile (backup kept)',
    '  info          print preset/UI source+target paths and install state',
    '',
    '  DSH_HOME defaults to the user home; UI deploys to $DSH_HOME/plugins/dsh-preset-flash-director',
    '  and wires $DSH_HOME/profiles/web/package.json (bundles + link dependency).',
  ].join('\n')
}

// ===== preset =====

async function cmdInstall() {
  const target = presetTarget()
  if (!(await dirExists(PRESET_SOURCE))) {
    throw new Error(`preset source missing inside the package: ${PRESET_SOURCE}`)
  }
  await mkdir(join(target, '..'), { recursive: true })
  if (await dirExists(target)) {
    const backup = `${target}.bak-${Date.now()}`
    await rename(target, backup)
    console.log(`existing preset backed up to ${backup}`)
  }
  await cp(PRESET_SOURCE, target, { recursive: true })
  console.log(`installed preset -> ${target}`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. open the DeepSeek Harness web UI and start a new session')
  console.log('  2. pick the "Flash 主控 · Pro 专家" preset')
  console.log('  3. switch the session model to deepseek-v4-flash')
  console.log('  4. confirm expert_consult / expert_review show up in the tool list')
}

// ===== config UI =====

// 拷贝插件包到目标位置：只拷运行所需条目（lib/flash-director/cordis.patch.yml/package.json/README/LICENSE），
// 排除 node_modules/.git 等
async function copyUiToTarget() {
  const target = uiTarget()
  await mkdir(dirname(target), { recursive: true })
  if (await dirExists(target)) {
    const backup = `${target}.bak-${Date.now()}`
    await rename(target, backup)
    console.log(`existing UI backed up to ${backup}`)
  }
  await mkdir(target, { recursive: true })
  for (const entry of UI_COPY_ENTRIES) {
    const src = join(UI_SOURCE, entry)
    if (await dirExists(src)) {
      await cp(src, join(target, entry), {
        recursive: true,
        filter: (s) => {
          const parts = s.split(sep)
          return !parts.includes('node_modules') && !parts.includes('.git') && !parts.includes('node_modules')
        },
      })
    } else if (await fileExists(src)) {
      await cp(src, join(target, entry))
    }
  }
  console.log(`installed UI -> ${target}`)
  return target
}

// 幂等接入 web profile：dependencies + bundles。备份 + 原子写。
async function wireWebProfile(uiTargetAbs) {
  const manifestPath = webProfileManifest()
  if (!(await fileExists(manifestPath))) {
    return { ok: false, reason: 'missing-manifest' }
  }
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (e) {
    throw new Error(`read profile manifest failed: ${e && e.message ? e.message : String(e)}`)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new Error(`web profile package.json 不是合法 JSON（未修改，请先修复）: ${e && e.message ? e.message : String(e)}`)
  }
  const depValue = 'link:' + uiTargetAbs.replace(/\\/g, '/')
  let changed = false
  if (!json.dependencies || typeof json.dependencies !== 'object' || Array.isArray(json.dependencies)) {
    json.dependencies = {}
  }
  if (json.dependencies[UI_ID] !== depValue) {
    if (json.dependencies[UI_ID] !== undefined) {
      console.log(`profile 依赖 ${UI_ID} 已存在（${json.dependencies[UI_ID]}），改为标准路径 ${depValue}`)
    }
    json.dependencies[UI_ID] = depValue
    changed = true
  }
  if (!json.dsh || typeof json.dsh !== 'object') json.dsh = {}
  if (!json.dsh.profile || typeof json.dsh.profile !== 'object') json.dsh.profile = {}
  if (!Array.isArray(json.dsh.profile.bundles)) {
    console.warn(`dsh.profile.bundles 不是数组（${JSON.stringify(json.dsh.profile.bundles)}），将重置为仅含 ${UI_ID}`)
    json.dsh.profile.bundles = []
  }
  if (!json.dsh.profile.bundles.includes(UI_ID)) {
    json.dsh.profile.bundles.push(UI_ID)
    changed = true
  }
  if (!changed) {
    console.log('web profile 已接入 UI（幂等，无改动）')
    return { ok: true, changed: false }
  }
  // 备份 + 原子写（临时文件 + rename，避免中断留下截断 JSON）
  const backup = `${manifestPath}.bak-${Date.now()}`
  await copyFile(manifestPath, backup)
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`)
  await rename(tmp, manifestPath)
  console.log(`web profile manifest updated（备份 ${backup}）`)
  return { ok: true, changed: true }
}

// 在 web profile 目录执行 pnpm install（win 上经 shell 解析 pnpm.cmd）
function runPnpmInstall(profileDir) {
  return new Promise((resolveP) => {
    const child = spawn('pnpm', ['install'], {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => resolveP(code === 0))
    child.on('error', (err) => {
      console.warn(`pnpm 不可用: ${err.message}`)
      resolveP(false)
    })
  })
}

async function cmdInstallUi() {
  if (!(await dirExists(UI_SOURCE))) {
    throw new Error(`UI source missing inside the package: ${UI_SOURCE}`)
  }
  const target = await copyUiToTarget()
  if (!(await fileExists(webProfileManifest()))) {
    console.warn(`未找到 web profile（${webProfileDir()}）。UI 已拷贝到 ${target}，`)
    console.warn('但需要 DSH Desktop 至少启动过一次生成 profile 后，再运行 install-ui 接入。')
    return
  }
  const wire = await wireWebProfile(target)
  if (!wire.ok) {
    console.warn(`未接入 web profile: ${wire.reason}（${webProfileDir()}）`)
    return
  }
  const ok = await runPnpmInstall(webProfileDir())
  if (ok) {
    console.log('')
    console.log('UI 部署完成。请重启 DSH Desktop，刷新页面后设置里应出现「Flash 主控」分区页。')
  } else {
    console.warn('')
    console.warn(`pnpm install 未成功。请手动执行: cd ${webProfileDir()} && pnpm install，然后重启 DSH。`)
  }
}

async function cmdUninstall() {
  const target = presetTarget()
  if (!(await dirExists(target))) {
    console.log(`nothing to remove: ${target}`)
    return
  }
  const backup = `${target}.bak-${Date.now()}`
  await rename(target, backup)
  console.log(`preset removed; backup kept at ${backup} (delete it once you are sure)`)
  console.log('note: the config UI (dsh-preset-flash-director) is separate — run `install-ui` counterpart `uninstall-ui` to remove it.')
}

// 卸载 UI：从 web profile 移除依赖与 bundles 条目（备份 + 原子写），UI 目录移至 .bak
async function cmdUninstallUi() {
  let removed = false
  const manifestPath = webProfileManifest()
  if (await fileExists(manifestPath)) {
    let json
    try {
      json = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (e) {
      throw new Error(`web profile package.json 不是合法 JSON（未修改）: ${e && e.message ? e.message : String(e)}`)
    }
    let changed = false
    if (json.dependencies && typeof json.dependencies === 'object' && UI_ID in json.dependencies) {
      delete json.dependencies[UI_ID]
      changed = true
    }
    if (Array.isArray(json.dsh?.profile?.bundles)) {
      const i = json.dsh.profile.bundles.indexOf(UI_ID)
      if (i >= 0) {
        json.dsh.profile.bundles.splice(i, 1)
        changed = true
      }
    }
    if (changed) {
      const backup = `${manifestPath}.bak-${Date.now()}`
      await copyFile(manifestPath, backup)
      const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`)
      await rename(tmp, manifestPath)
      console.log(`已从 web profile 移除 ${UI_ID}（备份 ${backup}）`)
      removed = true
    }
  }
  const target = uiTarget()
  if (await dirExists(target)) {
    const backup = `${target}.bak-${Date.now()}`
    await rename(target, backup)
    console.log(`UI 目录已移至 ${backup}（确认无误后删除）`)
    removed = true
  }
  if (!removed) {
    console.log('未发现已安装的 UI（无需卸载）')
  }
}

async function cmdInfo() {
  const uiTargetAbs = uiTarget()
  console.log(`DSH_HOME            : ${dshHome()}`)
  console.log(`preset source (pkg) : ${PRESET_SOURCE}`)
  console.log(`preset target       : ${presetTarget()}`)
  console.log(`preset installed    : ${await dirExists(presetTarget())}`)
  console.log(`UI source (pkg)     : ${UI_SOURCE}`)
  console.log(`UI target           : ${uiTargetAbs}`)
  console.log(`UI installed        : ${await dirExists(uiTargetAbs)}`)
  console.log(`web profile dir     : ${webProfileDir()}`)
  console.log(`profile has UI dep  : ${await profileHasUiDep()}`)
}

async function profileHasUiDep() {
  const manifestPath = webProfileManifest()
  if (!(await fileExists(manifestPath))) return false
  try {
    const json = JSON.parse(await readFile(manifestPath, 'utf8'))
    const inDeps = json.dependencies && UI_ID in json.dependencies
    const inBundles = Array.isArray(json.dsh?.profile?.bundles) && json.dsh.profile.bundles.includes(UI_ID)
    return inDeps && inBundles
  } catch {
    return false
  }
}

// 读自身 package.json 的版本（直跑 .mjs 时 npm_package_version 不存在）
async function pkgVersion() {
  try {
    return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

const [cmd] = process.argv.slice(2)

try {
  if (cmd === '--version' || cmd === 'version') {
    console.log(await pkgVersion())
  } else if (cmd === 'install') {
    await cmdInstall()
    console.log('')
    console.log('--- 部署配置 UI（dsh-preset-flash-director）---')
    await cmdInstallUi().catch((e) => {
      console.warn(`UI 部署跳过（不影响预设安装）: ${e && e.message ? e.message : String(e)}`)
    })
  } else if (cmd === 'install-ui') {
    await cmdInstallUi()
  } else if (cmd === 'uninstall-ui') {
    await cmdUninstallUi()
  } else if (cmd === 'uninstall') {
    await cmdUninstall()
  } else if (cmd === 'info') {
    await cmdInfo()
  } else {
    console.log(usage())
    process.exitCode = 1
  }
} catch (error) {
  console.error(`error: ${error && error.message ? error.message : String(error)}`)
  process.exitCode = 1
}
