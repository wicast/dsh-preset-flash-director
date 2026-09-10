/**
 * dsh-preset-flash-director — 客户端渲染冒烟测试
 * 运行：node --test ui/test/client-smoke.test.mjs
 *
 * 用最小 react shim 在 Node 里执行客户端 bundle 的 SettingsPanel 渲染，
 * 捕获组件树渲染期的运行时错误（ReferenceError/TypeError 等）——
 * 集成测试只覆盖服务端，这类"渲染即崩"的 bug 只能靠这里兜住。
 * （曾发生：provider/model 下拉助手引用了 renderControl 参数的 get/isBaseline，
 *  渲染即抛 ReferenceError 导致整个设置页空白。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const code = readFileSync(CLIENT, 'utf8')

// 注入的 state：第一次 useState 调用返回（对应 SettingsPanel 的 st）
let injected = null
let registered = null

const fakeWindow = {
  __ModuleLoader__: { load: (r) => { registered = r } },
}

const reactShim = {
  useState: (init) => {
    const v = injected !== null ? injected : init
    injected = null
    return [v, () => {}]
  },
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  createElement: (type, props, ...children) => ({ type, props, children }),
}

const fakeRequire = (spec) => {
  if (spec === 'react') return reactShim
  throw new Error('unexpected require: ' + spec)
}

function loadClient() {
  injected = null
  registered = null
  new Function('window', code)(fakeWindow)
  assert.ok(registered, 'bundle 应注册到 __ModuleLoader__')
  // 回归防线：客户端 bundle 的注册 id 必须等于包名（改名后曾漏改导致
  // "loaded without registering <pkg> via __ModuleLoader__.load" 加载失败）
  assert.equal(registered.id, 'dsh-preset-flash-director')
  return registered.factory(fakeRequire)
}

// 构造一份与服务端 /state 同形的状态
function makeState(providers) {
  return {
    ok: true,
    dshHome: '/Users/x/.dsh',
    presetDir: '/Users/x/.dsh/.agent-presets/flash-director',
    overridePath: '/Users/x/.dsh/.agent-presets/flash-director/expert-delegation.config.json',
    baselinePath: '/Users/x/.dsh/.agent-presets/flash-director/agent.cordis.yml',
    override: {
      path: '', exists: true, configError: null,
      values: { expertProvider: 'opencode-go', expertModel: 'deepseek-v4-pro', expertFallbackProvider: 'scnet', expertFallbackModel: 'DeepSeek-V4-Flash-0731' },
    },
    baseline: { path: '', exists: true, values: { expertProvider: 'deepseek-official', expertModel: 'deepseek-v4-pro' }, configError: null },
    effective: {
      expertProvider: 'opencode-go', expertModel: 'deepseek-v4-pro', expertMaxTokens: 32768, maxExpertsPerUserTask: 3,
      briefMaxChars: 40000, expertReuse: 'session', reuseMaxFollowups: 8, followupRetryBudget: 2, expertReasoningEffort: 'max',
      expertFallbackProvider: 'scnet', expertFallbackModel: 'DeepSeek-V4-Flash-0731',
    },
    source: {
      expertProvider: 'override', expertModel: 'override', expertMaxTokens: 'default', maxExpertsPerUserTask: 'default',
      briefMaxChars: 'default', expertReuse: 'default', reuseMaxFollowups: 'default', followupRetryBudget: 'default',
      expertReasoningEffort: 'override', expertFallbackProvider: 'override', expertFallbackModel: 'override',
      expertFallbackMaxTokens: 'default', expertFallbackReasoningEffort: 'default',
    },
    providers: providers || [],
    providersAvailable: !!providers,
  }
}

function makeSlots() {
  const registrations = []
  const slots = {
    inject: (name, cb) => { registrations.push({ name, cb }) },
    register: (spec, comp) => { registrations.push({ ...spec, comp }); return spec },
  }
  return { registrations, slots }
}

function applyClient() {
  const mod = loadClient()
  const { registrations, slots } = makeSlots()
  const ctx = { get: (k) => (k === 'slots' ? slots : undefined) }
  mod.apply(ctx)
  return registrations
}

function renderSection(registrations, slotName) {
  const injectEntry = registrations.find((r) => r.name === slotName && r.cb)
  assert.ok(injectEntry, `应注册 ${slotName}`)
  injectEntry.cb() // 触发 slots.register → 推入 { spec, comp }
  const reg = registrations.find((r) => r.name === slotName && r.comp)
  assert.ok(reg, `${slotName} 应完成 register`)
  return reg
}

function renderPanel(state) {
  const registrations = applyClient() // loadClient 会重置 injected，故 state 注入必须在其后
  const reg = renderSection(registrations, 'settings.section')
  injected = state
  const vnode = reg.comp() // createElement(SettingsPanel)
  return vnode.type() // 直接调用函数组件渲染整棵组件树
}

// 展平 vnode 树（children 可能是嵌套数组）
function flatten(n, out = []) {
  if (n == null) return out
  if (Array.isArray(n)) {
    for (const x of n) flatten(x, out)
    return out
  }
  out.push(n)
  if (n.children) flatten(n.children, out)
  return out
}

/**
 * 按字段标签取控件（不依赖渲染顺序/下标——加字段不再让断言错位）。
 * 每张卡片里同一个 label 只出现一次；override 卡在前、基线卡在后。
 * @returns {Array<object>} 匹配该标签的控件（select/input），按出现顺序
 */
function controlsByLabel(nodes, labelText) {
  const rows = nodes.filter((n) => n.props && n.props.className === 'fd-row')
  const found = []
  for (const row of rows) {
    const flat = flatten(row)
    const label = flat.find((n) => n.props && n.props.className === 'fd-label')
    const text = label && label.children && label.children[0]
    if (typeof text !== 'string' || !text.includes(labelText)) continue
    const control = flat.find((n) => n.props && (n.props.className === 'fd-select' || n.props.className === 'fd-input'))
    if (control) found.push(control)
  }
  return found
}

const optionValues = (control) => flatten(control).filter((o) => o.type === 'option').map((o) => o.props.value)

test('SettingsPanel 渲染（有 providers）：不抛错且产出控件树', () => {
  const providers = [
    { id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    { id: 'scnet', name: 'SCNet', models: [{ id: 'DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash 0731' }] },
  ]
  const tree = renderPanel(makeState(providers))
  const nodes = flatten(tree)
  const sels = nodes.filter((n) => n.props && n.props.className === 'fd-select')
  // 覆盖表单（provider/model/expertReuse/effort + fallback 3 个下拉）+ 基线表单（provider/model/expertReuse）
  assert.ok(sels.length >= 10, `应渲染 ≥10 个下拉（实际 ${sels.length}）`)

  // 覆盖表单：provider 下拉含目录里的两个 provider；模型下拉跟随 provider
  const ovProvider = controlsByLabel(nodes, '专家 Provider')[0]
  const ovOpts = optionValues(ovProvider)
  assert.ok(ovOpts.includes('opencode-go'))
  assert.ok(ovOpts.includes('scnet'))
  const ovModel = controlsByLabel(nodes, '专家模型')[0]
  const mopts = optionValues(ovModel)
  assert.ok(mopts.includes('deepseek-v4-pro'))
  assert.ok(mopts.includes('deepseek-v4-flash'))
  assert.ok(!mopts.includes('DeepSeek-V4-Flash-0731'))

  // 基线表单：当前值不在目录里 → 追加保留
  const bsProvider = controlsByLabel(nodes, '专家 Provider')[1]
  assert.ok(bsProvider, '基线表单应有 Provider 下拉')
  assert.ok(optionValues(bsProvider).includes('deepseek-official'))

  // fallback：provider 下拉同源目录；模型下拉跟随 fallback provider（state 里为 scnet）
  const fbProvider = controlsByLabel(nodes, 'Fallback Provider')[0]
  assert.ok(fbProvider, '覆盖表单应有 Fallback Provider 下拉')
  assert.ok(optionValues(fbProvider).includes('local-gateway') === false) // 目录里没有就不该凭空出现
  assert.ok(optionValues(fbProvider).includes('scnet'))
  const fbModel = controlsByLabel(nodes, 'Fallback 模型')[0]
  const fbOpts = optionValues(fbModel)
  assert.ok(fbOpts.includes('DeepSeek-V4-Flash-0731')) // 跟随 scnet
  assert.ok(!fbOpts.includes('deepseek-v4-pro')) // 不是 opencode-go 的模型
  // 空值选项 = 关闭 fallback（可发现"怎么关"）
  const fbEmpty = flatten(fbModel).find((o) => o.type === 'option' && o.props.value === '')
  assert.ok(fbEmpty, 'Fallback 模型下拉应有空值选项')
  assert.match(String(fbEmpty.children[0]), /关闭 fallback/)
})

test('SettingsPanel 渲染（无 providers）：回退文本输入，不抛错', () => {
  const tree = renderPanel(makeState(null))
  const nodes = flatten(tree)
  const inputs = nodes.filter((n) => n.props && n.props.type === 'text')
  assert.ok(inputs.length >= 2, `无 providers 时应回退文本输入（实际 ${inputs.length} 个）`)
})

test('SettingsPanel 渲染（覆盖文件缺失/畸形）：不抛错', () => {
  const state = makeState(null)
  state.override = { path: '', exists: false, values: null, configError: null }
  const tree = renderPanel(state)
  assert.ok(tree)
  state.override = { path: '', exists: true, values: null, configError: 'invalid JSON: boom' }
  const tree2 = renderPanel(state)
  assert.ok(tree2)
})

test('SettingsCard 渲染：不抛错', () => {
  const registrations = applyClient()
  const reg = renderSection(registrations, 'settings.plugin.item')
  assert.equal(reg.key, 'flash-director') // key 对齐服务端命名空间
  injected = makeState(null)
  const vnode = reg.comp()
  vnode.type() // 渲染不抛
})
