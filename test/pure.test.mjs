/**
 * dsh-flash-director-ui — 纯函数层单测（node:test）
 * 运行：node --test ui/test/pure.test.mjs
 *
 * js-yaml 仅用于"写后宽容 YAML 校验"的验证测试；解析器优先用 node 可解析的
 * js-yaml，否则回退到 DSH Desktop bundle 内的副本（本机环境路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  readBaselineConfig,
  patchCordisBaseline,
  locateBaselineConfigBlock,
  parseScalar,
} from '../lib/cordis-patch.mjs'
import {
  buildSchema,
  validateOverrideValues,
  normalizeOverride,
  mergeEffective,
  BASELINE_KEYS,
  OVERRIDE_KEYS,
  DEFAULTS,
} from '../lib/schema.mjs'
import { presetDir, overridePath, baselinePath, dshHome } from '../lib/paths.mjs'

// ---- js-yaml 解析器（宽容 schema，处理 agent.cordis.yml 的 !!js 标签）----
let yaml
try {
  yaml = (await import('js-yaml')).default
} catch {
  const p = '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/js-yaml/index.js'
  const { createRequire } = await import('node:module')
  const req = createRequire(fileURLToPath(import.meta.url))
  yaml = req(p)
}
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => ({ __js: String(d).trim() }) })
const PERMISSIVE = yaml.DEFAULT_SCHEMA.extend([JS_TAG])
function findById(node, id) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findById(n, id)
      if (r) return r
    }
    return null
  }
  if (node.id === id) return node
  for (const k of Object.keys(node)) {
    const r = findById(node[k], id)
    if (r) return r
  }
  return null
}

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'flash-director')
const YML = join(REPO_DIR, 'agent.cordis.yml')
const text = readFileSync(YML, 'utf8')

// ---- 基线读取 ----
test('readBaselineConfig 从真实 agent.cordis.yml 读出 7 键', () => {
  const r = readBaselineConfig(text)
  assert.equal(r.ok, true)
  assert.equal(r.values.expertProvider, 'deepseek-official')
  assert.equal(r.values.expertModel, 'deepseek-v4-pro')
  assert.equal(r.values.expertMaxTokens, 32768)
  assert.equal(r.values.maxExpertsPerUserTask, 3)
  assert.equal(r.values.expertReuse, 'session')
  assert.equal(r.values.reuseMaxFollowups, 8)
})

// ---- 行级 patch ----
test('patchCordisBaseline 只改目标键、其余逐字保留', () => {
  const r = patchCordisBaseline(text, { expertModel: 'deepseek-v4-pro-fixed' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.changed, ['expertModel'])
  // 目标键已替换
  assert.match(r.text, /expertModel: "deepseek-v4-pro-fixed"/)
  // 其余键值不变
  assert.match(r.text, /expertProvider: deepseek-official/)
  assert.match(r.text, /expertMaxTokens: 32768/)
  // 基线其余部分逐字保留（注释/组结构/!!js 标签都在）
  assert.match(r.text, /disabled: !!js process\.platform === 'win32'/)
  assert.match(r.text, /# The `flash-director` agent preset/)
})

test('patchCordisBaseline 未知键被拒绝且不落盘', () => {
  const r = patchCordisBaseline(text, { expertReasoningEffort: 'max' })
  assert.equal(r.ok, false)
  assert.match(r.error, /未知基线键/)
})

test('patchCordisBaseline 插入缺失键', () => {
  // 构造一个删掉 expertReuse 的文本，patch 应把它插回
  const r0 = patchCordisBaseline(text, { expertReuse: undefined })
  // 上一步 undefined 值会被 formatScalar 写成 null 串——改为直接构造缺失场景：
  const lines = text.split('\n')
  const loc = locateBaselineConfigBlock(lines)
  const without = [...lines.slice(0, loc.configIdx + 1), ...lines.slice(loc.end)].join('\n')
  const r = patchCordisBaseline(without, { expertReuse: 'off' })
  assert.equal(r.ok, true)
  assert.match(r.text, /\n {8}expertReuse: "off"/)
})

test('patch 后全文仍能被宽容 YAML 解析且 expert-delegation 行 config 完整', () => {
  const r = patchCordisBaseline(text, { expertModel: 'deepseek-v4-pro-fixed', expertMaxTokens: 65536 })
  assert.equal(r.ok, true)
  const doc = yaml.load(r.text, { schema: PERMISSIVE })
  const row = findById(doc, 'expert-delegation')
  assert.ok(row && row.config && typeof row.config === 'object')
  assert.equal(row.config.expertModel, 'deepseek-v4-pro-fixed')
  assert.equal(row.config.expertMaxTokens, 65536)
  assert.equal(row.config.expertProvider, 'deepseek-official')
})

// ---- parseScalar ----
test('parseScalar 处理数字/布尔/引号串/裸串', () => {
  assert.equal(parseScalar('32768'), 32768)
  assert.equal(parseScalar('true'), true)
  assert.equal(parseScalar('"deepseek-v4-pro"'), 'deepseek-v4-pro')
  assert.equal(parseScalar("'session'"), 'session')
  assert.equal(parseScalar('off'), 'off')
  assert.equal(parseScalar(''), null)
})

// ---- schema 校验 ----
test('buildSchema 生成合法 9 键全可选 schema', async () => {
  const z = (await import('/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/schemastery/lib/index.mjs')).default
  const schema = buildSchema(z)
  // schemastery 的 schema 可调用：合法返回解析值，非法抛 ValidationError
  const ok = (v) => { try { schema(v); return true } catch { return false } }
  // 空对象合法（全可选）
  assert.ok(ok({}))
  // 合法完整对象
  assert.ok(ok({ expertProvider: 'opencode-free', expertModel: 'x-preview-f-free', expertMaxTokens: 32768, expertReuse: 'session', expertReasoningEffort: 'max' }))
  // 非法枚举被拒
  assert.ok(!ok({ expertReuse: 'always' }))
  assert.ok(!ok({ expertReasoningEffort: 'ultra' }))
})

test('validateOverrideValues 拒绝未知键/非法值', () => {
  assert.equal(validateOverrideValues({ expertModel: 'x' }).ok, true)
  assert.equal(validateOverrideValues({ nope: 1 }).ok, false)
  assert.equal(validateOverrideValues({ expertReuse: 'always' }).ok, false)
  assert.equal(validateOverrideValues({ expertMaxTokens: 0 }).ok, false)
  // 空值 = 不覆盖（被过滤）
  const r = validateOverrideValues({ expertModel: 'x', expertReasoningEffort: '' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.values, { expertModel: 'x' })
})

test('normalizeOverride 过滤未知键与非法值', () => {
  const r = normalizeOverride({ expertModel: 'x', nope: 1, expertMaxTokens: -5 })
  assert.deepEqual(r.values, { expertModel: 'x' })
  assert.deepEqual(r.dropped, ['nope', 'expertMaxTokens'])
})

test('mergeEffective override > baseline > default', () => {
  const m = mergeEffective({ expertModel: 'base' }, { expertModel: 'override' })
  assert.equal(m.effective.expertModel, 'override')
  assert.equal(m.source.expertModel, 'override')
  const m2 = mergeEffective({ expertModel: 'base' }, {})
  assert.equal(m2.effective.expertModel, 'base')
  assert.equal(m2.source.expertModel, 'baseline')
  const m3 = mergeEffective({}, {})
  assert.equal(m3.effective.expertProvider, DEFAULTS.expertProvider)
  assert.equal(m3.source.expertProvider, 'default')
  // expertReasoningEffort 无默认 → 缺省
  assert.equal('expertReasoningEffort' in m3.effective, false)
  assert.equal(m3.source.expertReasoningEffort, 'default')
})

// ---- 路径解析 ----
test('路径解析：默认指向安装态 preset', () => {
  const d = presetDir()
  assert.ok(d, 'presetDir 应解析到目录')
  assert.equal(baselinePath(), join(d, 'agent.cordis.yml'))
  assert.equal(overridePath(), join(d, 'expert-delegation.config.json'))
})

test('路径解析：FLASH_DIRECTOR_CONFIG 环境变量优先', () => {
  const old = process.env.FLASH_DIRECTOR_CONFIG
  process.env.FLASH_DIRECTOR_CONFIG = '/tmp/custom-override.json'
  try {
    assert.equal(overridePath(), '/tmp/custom-override.json')
  } finally {
    if (old === undefined) delete process.env.FLASH_DIRECTOR_CONFIG
    else process.env.FLASH_DIRECTOR_CONFIG = old
  }
})

test('键集合一致性', () => {
  assert.equal(OVERRIDE_KEYS.length, 9)
  assert.equal(BASELINE_KEYS.length, 7)
  for (const k of BASELINE_KEYS) assert.ok(OVERRIDE_KEYS.includes(k))
  assert.ok(!BASELINE_KEYS.includes('expertReasoningEffort'))
  assert.ok(!BASELINE_KEYS.includes('followupRetryBudget'))
})
