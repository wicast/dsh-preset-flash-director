/**
 * dsh-flash-director-ui — 配置路径解析（纯函数层）
 *
 * 与 expert-delegation.mjs 的路径语义保持一致（同源逻辑）：
 *   - override 覆盖文件：$FLASH_DIRECTOR_CONFIG 优先，否则 <活动 preset 目录>/expert-delegation.config.json
 *   - 基线文件：<活动 preset 目录>/agent.cordis.yml
 *   - 活动 preset 目录：$FLASH_DIRECTOR_PRESET_DIR 优先（显式覆盖/测试），
 *     否则 $DSH_HOME/.agent-presets/flash-director（安装态，DSH 实际使用），
 *     不存在时回退仓库内 flash-director/（开发态）。
 *
 * 关键约束：路径解析必须每次调用时实时重算（不缓存）——expert-delegation.mjs
 * 每次委派都实时读 $FLASH_DIRECTOR_CONFIG，UI 若缓存会导致环境变量改动后写错文件。
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** $DSH_HOME 解析（与 expert-delegation.mjs / bin 脚本一致）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 安装态预设目录：$DSH_HOME/.agent-presets/flash-director。 */
export function installedPresetDir() {
  return join(dshHome(), '.agent-presets', 'flash-director')
}

/** 仓库内预设目录（开发态回退）：ui/lib/paths.mjs → 上溯两级 → flash-director/。 */
export function repoPresetDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'flash-director')
}

/**
 * 活动 preset 目录。优先级：
 *   1. $FLASH_DIRECTOR_PRESET_DIR（显式覆盖，用于测试/别名安装）
 *   2. 安装态目录（若存在且含 agent.cordis.yml）
 *   3. 仓库内目录（若存在）
 * 都不满足时返回 null，由调用方优雅降级（UI 显示"未找到活性 preset 目录"）。
 */
export function presetDir() {
  if (process.env.FLASH_DIRECTOR_PRESET_DIR) {
    return resolve(process.env.FLASH_DIRECTOR_PRESET_DIR)
  }
  const installed = installedPresetDir()
  if (looksLikePreset(installed)) return installed
  const repo = repoPresetDir()
  if (looksLikePreset(repo)) return repo
  return null
}

function looksLikePreset(dir) {
  try {
    return existsSync(join(dir, 'agent.cordis.yml'))
  } catch {
    return false
  }
}

/** 覆盖文件路径：$FLASH_DIRECTOR_CONFIG 优先，否则 <presetDir>/expert-delegation.config.json。 */
export function overridePath() {
  if (process.env.FLASH_DIRECTOR_CONFIG) return resolve(process.env.FLASH_DIRECTOR_CONFIG)
  const dir = presetDir()
  return dir ? join(dir, 'expert-delegation.config.json') : null
}

/** 基线文件路径：<presetDir>/agent.cordis.yml。 */
export function baselinePath() {
  const dir = presetDir()
  return dir ? join(dir, 'agent.cordis.yml') : null
}
