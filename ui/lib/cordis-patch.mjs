/**
 * dsh-flash-director-ui — agent.cordis.yml 基线行级定位/读取/打补丁（纯函数层）
 *
 * 策略：绝不重新生成整个 YAML 文件（那会毁掉 persona、注释与 !!js 标签）。
 * 只做"行级定位 + 逐行替换/插入"，其余内容逐字保留。
 *
 * 定位规则（对缩进自适应，不硬编码空格数）：
 *   1. 找 `- id: expert-delegation` 行（任意缩进），记录其前导空格数 itemIndent
 *   2. 从其后向下扫到第一个缩进 > itemIndent 且内容为 `config:` 的行（configIndent）
 *   3. config 块边界 = config 行之后所有缩进 > configIndent 的非空、非注释行（键行区域）；
 *      遇到缩进 <= configIndent 的非空非注释行即块结束。注释行不断块。
 *
 * 注意：本文件不 import 任何外部库（保持纯函数可单测）。写后宽容 YAML 校验
 * （js-yaml + !!js 标签扩展）由服务端 lib/index.js 承担（js-yaml 由 Desktop
 * 运行时解析，这里注入即保持可测）。
 */
import { BASELINE_KEYS } from './schema.mjs'

function indentOf(line) {
  const m = line.match(/^\s*/)
  return m ? m[0].length : 0
}

function isComment(line) {
  return /^\s*#/.test(line)
}

/**
 * 定位 expert-delegation 行的 config 块。
 * @returns {{ itemIdx, configIdx, configIndent, keys: {idx,key,rawVal}[], end } | null}
 */
export function locateBaselineConfigBlock(lines) {
  let itemIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- id:\s*expert-delegation\s*$/.test(lines[i])) {
      itemIdx = i
      break
    }
  }
  if (itemIdx < 0) return null
  const itemIndent = indentOf(lines[itemIdx])

  let configIdx = -1
  for (let i = itemIdx + 1; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '' || isComment(t)) continue
    const ind = indentOf(t)
    if (ind <= itemIndent) break // 已离开该行所属块
    if (t.trim() === 'config:') {
      configIdx = i
      break
    }
  }
  if (configIdx < 0) return null
  const configIndent = indentOf(lines[configIdx])

  const keys = []
  let end = lines.length
  for (let i = configIdx + 1; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '') continue
    if (isComment(t)) continue // 注释不界定块边界
    const ind = indentOf(t)
    if (ind <= configIndent) {
      end = i
      break
    }
    const m = t.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (m && ind > configIndent) keys.push({ idx: i, key: m[2], rawVal: m[3] })
    // 非键行（如嵌套列表）留在区域内，逐字保留
  }
  return { itemIdx, configIdx, configIndent, keys, end }
}

/** 把 YAML 标量文本解析为 JS 值（数字/布尔/引号串/裸串）。 */
export function parseScalar(raw) {
  const s = String(raw).trim()
  if (s === '') return null
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s)
  if (s === 'true') return true
  if (s === 'false') return false
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

/** 把 JS 值格式化为 YAML 标量：数字/布尔原样；字符串 JSON 双引号（无歧义）。 */
export function formatScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

/** 读取基线 config 块（行级扫描，不解析全文）。 */
export function readBaselineConfig(text) {
  const lines = text.split('\n')
  const loc = locateBaselineConfigBlock(lines)
  if (!loc) return { ok: false, error: '未找到 expert-delegation 行的 config 块（基线结构不识别）' }
  const values = {}
  for (const k of loc.keys) {
    const v = parseScalar(k.rawVal)
    if (v !== null && v !== undefined) values[k.key] = v
  }
  return { ok: true, values }
}

/**
 * 对基线文本打行级补丁。
 * @param {string} text 原始 agent.cordis.yml 文本
 * @param {object} patch { 基线键: 值 }（只接受 BASELINE_KEYS）
 * @returns {{ ok: true, text, changed } | { ok: false, error }}
 */
export function patchCordisBaseline(text, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是对象' }
  }
  const invalid = Object.keys(patch).filter((k) => !BASELINE_KEYS.includes(k))
  if (invalid.length > 0) {
    return { ok: false, error: `未知基线键: ${invalid.join(', ')}（基线只支持 ${BASELINE_KEYS.join('/')}）` }
  }
  const lines = text.split('\n')
  const loc = locateBaselineConfigBlock(lines)
  if (!loc) {
    return { ok: false, error: '未找到 expert-delegation 行的 config 块（基线结构不识别，未做任何修改）' }
  }
  const keyIndent = ' '.repeat(loc.configIndent + 2)
  const region = lines.slice(loc.configIdx + 1, loc.end)
  const seen = new Set()
  const newRegion = region.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) return line
    if (!(m[2] in patch)) return line
    seen.add(m[2])
    return keyIndent + m[2] + ': ' + formatScalar(patch[m[2]])
  })
  // patch 中出现但文件里没有的键：按 BASELINE_KEYS 顺序插入块末尾
  for (const key of BASELINE_KEYS) {
    if (key in patch && !seen.has(key)) {
      newRegion.push(keyIndent + key + ': ' + formatScalar(patch[key]))
    }
  }
  const changed = Object.keys(patch)
  const out = [...lines.slice(0, loc.configIdx + 1), ...newRegion, ...lines.slice(loc.end)]
  return { ok: true, text: out.join('\n'), changed }
}
