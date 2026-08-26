/**
 * dsh-flash-director-ui — 预设自动同步（纯异步函数，可单测）
 *
 * 插件自包含：`ui/flash-director` 打包了 agent 预设，插件每次加载时把预设
 * 同步到 `$DSH_HOME/.agent-presets/flash-director`——安装/更新插件即自动部署预设。
 *
 * 同步语义（防破坏用户配置）：
 *   - 目标缺失            → 全量拷贝 + 写版本标记（install）
 *   - 目标存在 + 无标记   → 收养：只写标记不覆盖（尊重 cp -r 手动安装的内容）
 *   - 目标存在 + 标记 < 插件版本 或 内容哈希漂移 → 更新：旁路构建 `.new` + 原子换入；
 *     失败回滚（不留残缺目录）；保留 expert-delegation.config.json；
 *     检测到用户改过基线则不覆盖基线、新版基线旁侧存放 + 警告
 *   - 目标存在 + 标记 ≥ 版本且哈希一致 → 不动（不降级）
 * 任何路径都不静默覆盖 expert-delegation.config.json（用户运行期配置）。
 *
 * 标记格式（向后兼容裸字符串）：JSON {"v","h","b"}，v=插件版本，h=打包预设内容
 * 哈希（sha256 按固定文件列表），b=更新时写入的基线 agent.cordis.yml 哈希（用于
 * 检测用户后续手改基线）。旧裸字符串标记在 v 匹配时刷新为 JSON（不动内容）。
 */
import { cp, mkdir, readFile, rename, rm, stat, lstat, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as paths from './paths.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..') // ui/
const PRESET_BUNDLE = join(PLUGIN_ROOT, 'flash-director') // ui/flash-director
const MARKER = '.flash-director-ui-version'
const USER_CONFIG = 'expert-delegation.config.json'
const BASELINE = 'agent.cordis.yml'
const BUNDLE_FILES = [BASELINE, 'expert-delegation.mjs', 'preset.yml', 'expert-delegation.config.example.json']

// 并发串行化：多 context/重载并发调用时只跑一次
let inflight = null

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function isSymlink(p) {
  try {
    return (await lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 简单版本比较：a>b→1, a<b→-1, 相等→0。
 * ⚠ 非语义化（parseInt 逐段）：'0.2.0-beta.1' 会被判 > '0.2.0'（与 semver 相反）。
 * 本流程不使用预发版本号，接受该偏差（见测试）。
 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da > db ? 1 : -1
  }
  return 0
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

/** 打包预设目录内容哈希（固定文件列表，缺文件记为 <missing>）。 */
export async function bundleHash() {
  const h = createHash('sha256')
  for (const f of BUNDLE_FILES) {
    h.update(f)
    try {
      h.update(await readFile(join(PRESET_BUNDLE, f)))
    } catch {
      h.update('<missing>')
    }
  }
  return h.digest('hex')
}

async function baselineHashOf(dir) {
  try {
    return sha256(await readFile(join(dir, BASELINE), 'utf8'))
  } catch {
    return null
  }
}

async function readMarker(target) {
  try {
    const raw = (await readFile(join(target, MARKER), 'utf8')).trim()
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return { v: raw, h: null, b: null } // 旧裸字符串标记
    }
  } catch {
    return null
  }
}

async function writeMarker(target, marker) {
  await writeFile(join(target, MARKER), JSON.stringify(marker), 'utf8')
}

function copyFilter(s) {
  return !s.split(sep).includes('node_modules')
}

async function fullInstall(target, marker) {
  await mkdir(dirname(target), { recursive: true })
  await cp(PRESET_BUNDLE, target, { recursive: true, filter: copyFilter })
  await writeMarker(target, marker)
}

/**
 * 更新：旁路构建 `${target}.new-<ts>`（含恢复 config.json + 基线策略 + 标记），
 * 再 目标→bak、new→目标 原子换入；任一步失败回滚（目标保持原状），不留残缺目录。
 * @param {{v,h,b}} marker  h=打包哈希, b=上次安装的基线哈希
 * @param {Function|null} fault 测试故障注入（换入前抛错）
 * @returns {{backup: string, preservedUserBaseline: boolean}}
 */
async function updatePreset(target, marker, fault) {
  const newDir = `${target}.new-${Date.now()}`
  const backup = `${target}.bak-${Date.now()}`
  try {
    const userConfig = await readFile(join(target, USER_CONFIG), 'utf8').catch(() => null)
    const currentBaseline = await readFile(join(target, BASELINE), 'utf8').catch(() => null)
    const bundledBaseline = await readFile(join(PRESET_BUNDLE, BASELINE), 'utf8').catch(() => null)

    // 旁路构建新目录（不影响正在服务的目标）
    await mkdir(dirname(newDir), { recursive: true })
    await cp(PRESET_BUNDLE, newDir, { recursive: true, filter: copyFilter })
    if (userConfig !== null) await writeFile(join(newDir, USER_CONFIG), userConfig, 'utf8')

    // B2 基线保护：现网基线 ≠ 上次安装指纹 → 用户改过基线 → 保留用户版本 + 新版旁侧 + 警告
    let installedBaselineHash
    let preservedUserBaseline = false
    if (currentBaseline !== null && bundledBaseline !== null && marker.b !== null && sha256(currentBaseline) !== marker.b) {
      preservedUserBaseline = true
      await writeFile(join(newDir, BASELINE), currentBaseline)
      await writeFile(join(newDir, `${BASELINE}.bundled-${Date.now()}`), bundledBaseline)
      installedBaselineHash = sha256(currentBaseline)
      console.warn(`[flash-director-ui] 检测到你手动改过基线 ${BASELINE}，本次更新保留你的版本；`)
      console.warn(`[flash-director-ui] 插件新版基线另存 ${BASELINE}.bundled-*，如需采用请自行合并。`)
    } else {
      installedBaselineHash = bundledBaseline !== null ? sha256(bundledBaseline) : null
    }

    await writeMarker(newDir, { v: marker.v, h: marker.h, b: installedBaselineHash })

    // 原子换入 + 回滚（fault 也在此 try 内：换入前失败同样回滚）
    await rename(target, backup)
    try {
      if (fault) await fault() // 测试故障注入：换入前失败 → 回滚
      await rename(newDir, target)
    } catch (e) {
      await rename(backup, target).catch(() => {})
      throw e
    }
    return { backup, preservedUserBaseline }
  } catch (e) {
    await rm(newDir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

async function doSync({ pluginVersion, _fault } = {}) {
  const target = join(paths.dshHome(), '.agent-presets', 'flash-director')
  if (!(await exists(PRESET_BUNDLE))) {
    return { action: 'skip', reason: `bundled preset missing: ${PRESET_BUNDLE}` }
  }
  if (!pluginVersion) {
    return { action: 'skip', reason: 'plugin version unknown' }
  }
  if (await isSymlink(target)) {
    return { action: 'skip', reason: `target is a symlink (${target}) — 不接管符号链接` }
  }
  const h = await bundleHash()

  if (!(await exists(target))) {
    await fullInstall(target, { v: pluginVersion, h, b: await baselineHashOf(PRESET_BUNDLE) })
    return { action: 'install', target }
  }

  const marker = await readMarker(target)
  // 旧裸字符串标记向后兼容：v 匹配则刷新为 JSON（补 h/b），不动内容
  if (marker && marker.h === null && marker.v === pluginVersion) {
    await writeMarker(target, { v: marker.v, h, b: await baselineHashOf(target) })
    return { action: 'noop', target, reason: 'legacy marker refreshed' }
  }
  if (marker && marker.v === pluginVersion && marker.h === h) {
    return { action: 'noop', target }
  }
  if (marker === null) {
    // 收养：只写标记不覆盖（尊重 cp -r 手动安装）；下次插件 bump 会接管并更新
    await writeMarker(target, { v: pluginVersion, h, b: await baselineHashOf(target) })
    return { action: 'adopt', target }
  }
  if (compareVersions(marker.v, pluginVersion) > 0) {
    return { action: 'noop', target, reason: `installed ${marker.v} > bundled ${pluginVersion}` }
  }
  // 需要更新：版本升级 或 内容哈希漂移（改内容没 bump 版本）
  const { backup, preservedUserBaseline } = await updatePreset(target, { v: pluginVersion, h, b: marker.b }, _fault || null)
  return { action: 'update', target, backup, preservedUserBaseline }
}

/**
 * 同步预设到活动 preset 目录（并发串行化：同时只执行一次）。
 * @param {{pluginVersion?: string, _fault?: Function}} opts _fault 仅测试用
 * @returns {Promise<{action: 'install'|'adopt'|'update'|'noop'|'skip', target?: string, backup?: string, preservedUserBaseline?: boolean, reason?: string}>}
 */
export function syncPreset(opts = {}) {
  if (inflight) return inflight
  inflight = doSync(opts).finally(() => {
    inflight = null
  })
  return inflight
}
