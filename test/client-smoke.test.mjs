/**
 * dsh-flash-director-ui — 客户端渲染冒烟测试
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
    override: { path: '', exists: true, values: { expertProvider: 'opencode-go', expertModel: 'deepseek-v4-pro' }, configError: null },
    baseline: { path: '', exists: true, values: { expertProvider: 'deepseek-official', expertModel: 'deepseek-v4-pro' }, configError: null },
    effective: { expertProvider: 'opencode-go', expertModel: 'deepseek-v4-pro', expertMaxTokens: 32768, maxExpertsPerUserTask: 3, briefMaxChars: 40000, expertReuse: 'session', reuseMaxFollowups: 8, followupRetryBudget: 2, expertReasoningEffort: 'max' },
    source: { expertProvider: 'override', expertModel: 'override', expertMaxTokens: 'default', maxExpertsPerUserTask: 'default', briefMaxChars: 'default', expertReuse: 'default', reuseMaxFollowups: 'default', followupRetryBudget: 'default', expertReasoningEffort: 'override' },
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

test('SettingsPanel 渲染（有 providers）：不抛错且产出控件树', () => {
  const providers = [
    { id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    { id: 'scnet', name: 'SCNet', models: [{ id: 'DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash 0731' }] },
  ]
  const tree = renderPanel(makeState(providers))
  const nodes = flatten(tree)
  const sels = nodes.filter((n) => n.props && n.props.className === 'fd-select')
  // 至少包含 expertProvider 与 expertModel 两个下拉（override + baseline 各一对）
  assert.ok(sels.length >= 4, `应渲染 ≥4 个下拉（实际 ${sels.length}）`)
  // expertProvider 下拉（override 表单 sels[0]）应含当前值 opencode-go；基线表单（sels[4]）应保留不在列表的 deepseek-official
  const overrideProviderSel = sels[0]
  const opts = flatten(overrideProviderSel).filter((o) => o.type === 'option').map((o) => o.props.value)
  assert.ok(opts.includes('opencode-go'))
  assert.ok(opts.includes('scnet'))
  const baselineProviderSel = sels[4]
  const bopts = flatten(baselineProviderSel).filter((o) => o.type === 'option').map((o) => o.props.value)
  assert.ok(bopts.includes('deepseek-official')) // 基线当前值不在列表 → 追加保留
  // expertModel 下拉（override 表单 sels[1]，跟随 opencode-go）应只含其模型
  const modelSel = sels[1]
  const mopts = flatten(modelSel).filter((o) => o.type === 'option').map((o) => o.props.value)
  assert.ok(mopts.includes('deepseek-v4-pro'))
  assert.ok(mopts.includes('deepseek-v4-flash'))
  assert.ok(!mopts.includes('DeepSeek-V4-Flash-0731'))
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
