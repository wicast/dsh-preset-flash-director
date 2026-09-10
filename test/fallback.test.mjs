/**
 * dsh-preset-flash-director — 主 pro 失败 → fallback 策略层单测（node:test）
 * 运行：node --test test/fallback.test.mjs
 *
 * 用最小 ctx/subagents mock 驱动真实插件（flash-director/expert-delegation.mjs）：
 *   · spawn 抛错      → 当场退款 + 同一次调用内新建 child 用 fallback 配置重试
 *   · child 结算 error → subagent/end 退款 + 清槽 + 本会话降级（sticky）
 *   · aborted/max-tokens/completed → 不退款、不降级（中止多为主控主动止损）
 *   · 未配置 fallback → 完全不改变历史行为（如实报错，但失败的尝试仍退款）
 *   · 退款只退"当时那一本账"（用户已发新消息时不退，否则等于凭空加预算）
 * 配置经 apply(ctx, config) 注入（等价 agent.cordis.yml 的专家行 config）；
 * 覆盖文件路径指向不存在的临时文件，保证测试不受本机运行期覆盖影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 插件之前设置：CONFIG_PATH 在模块加载时求值
const TMP = mkdtempSync(join(tmpdir(), 'fd-fallback-test-'))
const OVERRIDE = join(TMP, 'expert-delegation.config.json')
process.env.FLASH_DIRECTOR_CONFIG = OVERRIDE

const { default: plugin } = await import('../flash-director/expert-delegation.mjs')

test.after(() => rmSync(TMP, { recursive: true, force: true }))

let childSeq = 0
let agentSeq = 0

/** 一个干净的 agent id（池/账本/降级状态都按 agentKey 记账，测试间必须隔离）。 */
function newAgentId() {
  agentSeq += 1
  return `agent-${agentSeq}`
}

/**
 * 最小插件 ctx。
 * @param {{plan?: Array<Error|Function>, agent?: object}} options
 *   plan[i] 决定第 i 次 startContinuable 的行为：Error = 抛错（spawn 失败）；
 *   函数 = 自定义返回；缺省 = 正常返回一个新 child。
 */
function makeCtx(options = {}) {
  const tools = new Map()
  const handlers = new Map()
  const spawns = []
  const followups = []
  const plan = options.plan ?? []
  const children = options.children ?? []

  const subagents = {
    async startContinuable(spec) {
      const index = spawns.length
      spawns.push(spec)
      const behavior = plan[index]
      if (behavior instanceof Error) throw behavior
      if (typeof behavior === 'function') return behavior(spec)
      childSeq += 1
      const childId = `child-${childSeq}`
      return { childId, messageId: `msg-${childId}` }
    },
    async followup(parent, childId, blocks, opts) {
      followups.push({ parent, childId, blocks, opts })
      return `msg-follow-${childId}`
    },
    async listChildren() {
      return children
    },
  }

  const ctx = {
    agent: options.agent,
    tools: { register: (tool) => tools.set(tool.name, tool) },
    subagents,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
  }

  const emit = (name, payload) => {
    for (const fn of handlers.get(name) ?? []) fn(payload, () => {})
  }
  const lastHandler = (name) => (handlers.get(name) ?? [])[(handlers.get(name) ?? []).length - 1]
  const handlerCount = (name) => (handlers.get(name) ?? []).length

  return { ctx, tools, spawns, followups, children, emit, lastHandler, handlerCount }
}

/** 起一个委派用 ctx（controller realm：ctx.agent 为 undefined）。 */
function startPlugin(config) {
  const m = makeCtx()
  plugin.apply(m.ctx, config)
  return m
}

const BRIEF = {
  kind: 'design',
  task: '订单与支付之间应如何拆分？给出推荐方案与权衡。',
  background: '当前是单体，订单模块直接调支付网关 SDK；QPS 峰值 800，目标是双活部署。',
  evidence: 'payment.ts 主流程 320 行（关键片段已摘录）；压测峰值 812 QPS @ p99 420ms。',
  acceptance: ['列出 ≥2 个候选方案并给出取舍依据'],
}

function consult(m, agentId, extra) {
  return m.tools.get('expert_consult').execute(
    { ...BRIEF, ...extra },
    { agent: { id: agentId }, signal: undefined },
  )
}

function review(m, agentId, stakes) {
  return m.tools.get('expert_review').execute(
    { subject: '支付模块服务化拆分方案与迁移路径', content: '方案正文：订单与支付拆分，含迁移路径与回滚步骤（略）。', stakes },
    { agent: { id: agentId }, signal: undefined },
  )
}

const FALLBACK_CONFIG = {
  expertFallbackProvider: 'fb-provider',
  expertFallbackModel: 'fb-model',
  expertFallbackMaxTokens: 8192,
}

// ── 未配置 fallback：与历史行为完全一致 ────────────────────────────────────

test('未配置 fallback：首次新建、二次复用，结果不含 fallback 字段', async () => {
  const m = startPlugin({})
  const agentId = newAgentId()
  const first = await consult(m, agentId)
  assert.equal(first.status, 'delegated')
  assert.equal(first.expert.attempt, 'primary')
  assert.equal(first.expert.model, 'deepseek-v4-pro')
  assert.equal('fallback' in first, false)
  assert.equal(first.budget.used, 1)

  const second = await consult(m, agentId)
  assert.equal(second.status, 'delegated')
  assert.equal(second.reused, true)
  assert.equal(m.spawns.length, 1)
  assert.equal(m.followups.length, 1)
  assert.equal(second.budget.used, 2)
})

test('未配置 fallback：spawn 失败 → 如实报错但本次不计额度', async () => {
  const m = makeCtx({ plan: [new Error('model deepseek-v4-pro is not available')] })
  plugin.apply(m.ctx, {})
  const agentId = newAgentId()
  const result = await consult(m, agentId)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /not available/)
  assert.equal(result.refunded, true)
  assert.equal(result.fallback.attempted, false)
  assert.equal(result.fallback.reason, 'not-configured')
  assert.equal(m.spawns.length, 1) // 没有第二次尝试
  // 退款：额度未被消耗（失败不计额度）
  const after = await consult(m, agentId)
  assert.equal(after.status, 'delegated')
  assert.equal(after.budget.used, 1)
})

// ── spawn 期失败：退款 + 自动降级新建 session ──────────────────────────────

test('spawn 失败 + 已配置 fallback：退款并立刻用 fallback 配置新建新 session', async () => {
  const m = makeCtx({ plan: [new Error('deepseek-v4-pro: 404 model not found')] })
  plugin.apply(m.ctx, FALLBACK_CONFIG)
  const agentId = newAgentId()
  const result = await consult(m, agentId)

  assert.equal(result.status, 'delegated')
  assert.equal(result.expert.attempt, 'fallback')
  assert.equal(result.expert.provider, 'fb-provider')
  assert.equal(result.expert.model, 'fb-model')
  assert.equal(result.expert.maxTokens, 8192)
  assert.equal(result.fallback.active, true)
  assert.equal(result.fallback.reason, 'primary-failed')
  assert.equal(result.fallback.newSession, true)
  assert.equal(result.fallback.refunded.delegations, 1)
  assert.equal(result.fallback.refunded.budget, 1)
  assert.match(result.fallback.next, /FALLBACK fb-provider\/fb-model/)
  // 只有成功的 fallback 那次计入额度（失败的尝试已退款）
  assert.equal(result.budget.used, 1)

  // 第一次尝试用主 pro，第二次用 fallback，且两个 child 不同（新建 = 新 session）
  assert.equal(m.spawns.length, 2)
  assert.deepEqual(m.spawns[0].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 32768 })
  assert.deepEqual(m.spawns[1].request.agentOptions, { provider: 'fb-provider', model: 'fb-model', maxTokens: 8192 })
  assert.notEqual(result.childId, 'child-0')
})

test('降级后继续委派：复用 fallback child（不再碰主 pro）', async () => {
  const m = makeCtx({ plan: [new Error('boom')] })
  plugin.apply(m.ctx, FALLBACK_CONFIG)
  const agentId = newAgentId()
  const first = await consult(m, agentId)
  assert.equal(first.fallback.active, true)

  const second = await consult(m, agentId)
  assert.equal(second.reused, true)
  assert.equal(second.reuseReason, 'reuse')
  assert.equal(second.expert.attempt, 'fallback')
  assert.equal(second.expert.model, 'fb-model')
  assert.equal(second.fallback.active, true)
  assert.equal(m.spawns.length, 2) // 没有为 fallback 再新建
  assert.equal(m.followups.length, 1)
  assert.equal(second.budget.used, 2)
})

test('fallback 与主 pro 完全相同 → 视为未启用（不重复尝试同一模型）', async () => {
  const m = makeCtx({ plan: [new Error('boom')] })
  plugin.apply(m.ctx, { expertFallbackModel: 'deepseek-v4-pro' }) // provider/maxTokens 继承 → 完全相同
  const agentId = newAgentId()
  const result = await consult(m, agentId)
  assert.equal(result.status, 'failed')
  assert.equal(result.refunded, true)
  assert.equal(result.fallback.attempted, false)
  assert.equal(result.fallback.reason, 'identical-to-primary')
  assert.equal(m.spawns.length, 1)
})

test('fallback 也失败：两次尝试都退款、错误里带两条原因', async () => {
  const m = makeCtx({ plan: [new Error('primary down'), new Error('fallback down')] })
  plugin.apply(m.ctx, FALLBACK_CONFIG)
  const agentId = newAgentId()
  const result = await consult(m, agentId)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /primary down/)
  assert.match(result.error, /fallback down/)
  assert.equal(result.refunded, true)
  assert.equal(result.fallback.attempted, true)
  assert.equal(result.fallback.error, 'fallback down')
  // 两次都失败 → 额度回到 0
  const after = await consult(m, agentId)
  assert.equal(after.budget.used, 1)
})

test('只声明 provider（模型继承主 pro）也算启用 fallback', async () => {
  const m = makeCtx({ plan: [new Error('boom')] })
  plugin.apply(m.ctx, { expertFallbackProvider: 'fb-provider' })
  const agentId = newAgentId()
  const result = await consult(m, agentId)
  assert.equal(result.status, 'delegated')
  assert.deepEqual(m.spawns[1].request.agentOptions, { provider: 'fb-provider', model: 'deepseek-v4-pro', maxTokens: 32768 })
})

test('stakes:high 审查失败退款 2（整次不计额度）', async () => {
  const m = makeCtx({ plan: [new Error('boom')] })
  plugin.apply(m.ctx, FALLBACK_CONFIG)
  const agentId = newAgentId()
  const result = await review(m, agentId, 'high')
  assert.equal(result.status, 'delegated')
  assert.equal(result.fallback.refunded.budget, 2)
  assert.equal(result.budget.used, 2) // 只算 fallback 那一次
})

// ── 异步结算失败：subagent/end stopReason === 'error' ─────────────────────

test('child 结算 error：退款 + 清槽 + 下次委派新建新 session 并降级', async () => {
  const m = startPlugin(FALLBACK_CONFIG)
  const agentId = newAgentId()
  const first = await consult(m, agentId)
  assert.equal(first.status, 'delegated')
  assert.equal(first.fallback, undefined) // 主 pro 尚未失败
  assert.equal(first.budget.used, 1)

  // 专家跑起来之后才失败（模型 id 无效 / provider 报错）：结算 stopReason = error
  m.emit('subagent/end', { id: first.childId, provider: 'deepseek-official', stopReason: 'error' })

  // 第二次委派：不复用失败的 child，改为新建 + fallback
  const second = await consult(m, agentId)
  assert.equal(second.status, 'delegated')
  assert.equal(second.reused, false)
  assert.equal(second.reuseReason, 'no-pool-entry')
  assert.equal(second.expert.attempt, 'fallback')
  assert.equal(second.expert.model, 'fb-model')
  assert.equal(second.fallback.active, true)
  assert.equal(second.fallback.primaryFailure.code, 'CHILD_ERROR')
  assert.equal(second.fallback.primaryFailure.childId, first.childId)
  assert.equal(second.fallback.refunded.delegations, 1)
  assert.equal(m.followups.length, 0) // 没有复用失败的 child
  assert.equal(m.spawns.length, 2)
  assert.equal(second.budget.used, 1) // 失败那次已退款，只剩 fallback 这次
})

test('child 结算 aborted / max-tokens / completed：不退款、不降级', async () => {
  for (const stopReason of ['aborted', 'max-tokens', 'refusal', 'completed']) {
    const m = startPlugin(FALLBACK_CONFIG)
    const agentId = newAgentId()
    const first = await consult(m, agentId)
    m.emit('subagent/end', { id: first.childId, stopReason })
    const second = await consult(m, agentId)
    // 仍然复用同一个主 pro child，额度照常累加，没有降级
    assert.equal(second.reused, true, `${stopReason}: 应继续复用`)
    assert.equal(second.expert.attempt, 'primary', `${stopReason}: 不应降级`)
    assert.equal('fallback' in second, false, `${stopReason}: 不应出现 fallback 诊断`)
    assert.equal(second.budget.used, 2, `${stopReason}: 不应退款`)
    assert.equal(m.spawns.length, 1, `${stopReason}: 不应新建`)
  }
})

test('未配置 fallback 时结算 error：只退款清槽，不改模型', async () => {
  const m = startPlugin({})
  const agentId = newAgentId()
  const first = await consult(m, agentId)
  m.emit('subagent/end', { id: first.childId, stopReason: 'error' })
  const second = await consult(m, agentId)
  assert.equal(second.status, 'delegated')
  assert.equal(second.reused, false) // 槽已清
  assert.equal(second.expert.attempt, 'primary')
  assert.equal(second.fallback.active, false)
  assert.equal(second.fallback.reason, 'not-configured')
  assert.match(second.fallback.next, /no usable fallback/)
  assert.equal(second.budget.used, 1) // 失败那次已退款
})

test('退款只退当时那一本账：用户已发新消息后不再退', async () => {
  const m = startPlugin(FALLBACK_CONFIG)
  const agentId = newAgentId()
  const first = await consult(m, agentId)
  assert.equal(first.budget.used, 1)

  // 新的用户消息进入 step → 账本整体重置（任务边界翻页）
  m.emit('agent/pre-step', { agent: { id: agentId }, messages: [{ role: 'user', source: { kind: 'user' } }] })

  // 旧任务里那次失败此时才结算：不能退进新任务的账本（否则等于凭空加预算）
  m.emit('subagent/end', { id: first.childId, stopReason: 'error' })

  const second = await consult(m, agentId)
  assert.equal(second.budget.used, 1) // 新任务只花掉这一次，没有被"退成负数"白送
})

// ── 收养（adoption）与降级的相互作用 ──────────────────────────────────────

const CONTINUABLE_ROW = (id) => ({ id, kind: 'child', mode: 'continuable', label: 'pro-expert:consult' })

test('对照：池空但宿主里有同 label 的存活 child → 收养并 followup（不新建）', async () => {
  const m = makeCtx({ children: [CONTINUABLE_ROW('survivor-child')] })
  plugin.apply(m.ctx, {})
  const result = await consult(m, newAgentId())
  assert.equal(result.status, 'delegated')
  assert.equal(result.reused, true)
  assert.equal(result.reuseReason, 'adopted')
  assert.equal(m.spawns.length, 0)
  assert.equal(m.followups.length, 1)
  assert.equal(m.followups[0].childId, 'survivor-child')
})

test('主 pro 失败后不收养：即使有存活 child 也新建 session 跑 fallback', async () => {
  const m = startPlugin(FALLBACK_CONFIG)
  const agentId = newAgentId()
  const first = await consult(m, agentId)
  m.emit('subagent/end', { id: first.childId, stopReason: 'error' }) // 主 pro 失败 → 降级

  // 失败的旧 child 仍活在宿主列表里（continuable），但降级要求"新建 session"
  m.children.push(CONTINUABLE_ROW(first.childId))
  const second = await consult(m, agentId)
  assert.equal(second.status, 'delegated')
  assert.equal(second.reused, false)
  assert.equal(second.expert.model, 'fb-model')
  assert.equal(m.followups.length, 0, '降级后不应 followup 任何旧 child')
  assert.equal(m.spawns.length, 2)
})

test('复用轮里失败也算主 pro 故障：退款 + 清槽 + 降级', async () => {
  const m = startPlugin(FALLBACK_CONFIG)
  const agentId = newAgentId()
  const first = await consult(m, agentId) // 新建主 pro child
  m.emit('subagent/end', { id: first.childId, stopReason: 'completed' }) // 正常回报
  const second = await consult(m, agentId) // 复用同一 child（followup）
  assert.equal(second.reused, true)
  assert.equal(second.budget.used, 2)

  // 复用轮里模型报错 → 这一轮退款 + 降级 + 清槽
  m.emit('subagent/end', { id: first.childId, stopReason: 'error' })
  const third = await consult(m, agentId)
  assert.equal(third.reused, false)
  assert.equal(third.expert.attempt, 'fallback')
  assert.equal(third.expert.model, 'fb-model')
  assert.equal(third.fallback.refunded.delegations, 1)
  assert.equal(third.budget.used, 2) // 2 次成功委派，失败那轮已退款
  assert.equal(m.followups.length, 1)
})

// ── effort 注入：fallback child 用自己的档位 ──────────────────────────────

test('fallback child 的思考强度用 expertFallbackReasoningEffort（未设则继承主 pro）', async () => {
  const cfg = { ...FALLBACK_CONFIG, expertReasoningEffort: 'high', expertFallbackReasoningEffort: 'off' }
  const m = makeCtx({ plan: [new Error('boom')] })
  plugin.apply(m.ctx, cfg)
  const agentId = newAgentId()
  const result = await consult(m, agentId) // 降级 → fallback child
  const fallbackChildId = result.childId

  // child 侧插件实例（另一个 realm，ctx.agent 带 parentSession）注册的请求钩子。
  // 生产环境里 child 加入同一预设 → 同一个 config 行，故这里传相同配置。
  const child = makeCtx({ agent: { id: fallbackChildId, session: { header: { parentSession: agentId } } } })
  plugin.apply(child.ctx, cfg)
  const inject = child.lastHandler('agent/request')
  assert.ok(inject, 'child realm 应注册 agent/request 钩子')
  const resolved = await inject({}, async () => ({ model: 'x' }))
  assert.equal(resolved.reasoningEffort, 'off') // fallback 专属档位
  assert.equal(resolved.model, 'x')

  // 主 pro child（未降级）不受 fallback 档位影响 → 仍用主 pro 档位
  const primary = startPlugin(cfg)
  const primaryResult = await consult(primary, newAgentId())
  const primaryChild = makeCtx({ agent: { id: primaryResult.childId, session: { header: { parentSession: 'p' } } } })
  plugin.apply(primaryChild.ctx, cfg)
  assert.equal((await primaryChild.lastHandler('agent/request')({}, async () => ({}))).reasoningEffort, 'high')

  // 未设 expertFallbackReasoningEffort → fallback child 继承主 pro 档位
  const child2 = makeCtx({ agent: { id: fallbackChildId, session: { header: { parentSession: agentId } } } })
  plugin.apply(child2.ctx, { ...FALLBACK_CONFIG, expertReasoningEffort: 'high' })
  assert.equal((await child2.lastHandler('agent/request')({}, async () => ({}))).reasoningEffort, 'high')
})

test('child realm 不注册 subagent/end 监听（只有主控 realm 处理结算）', async () => {
  const controller = startPlugin(FALLBACK_CONFIG)
  assert.equal(controller.handlerCount('subagent/end'), 1)
  const child = makeCtx({ agent: { id: 'child-x', session: { header: { parentSession: 'p' } } } })
  plugin.apply(child.ctx, FALLBACK_CONFIG)
  assert.equal(child.handlerCount('subagent/end'), 0, 'child realm 不应注册结算监听')
  assert.equal(child.handlerCount('agent/request'), 1, 'child realm 仍要注册 effort 钩子')
})

test('专家结算通知不重置预算（只有人类消息才是任务边界）', async () => {
  const m = startPlugin({})
  const agentId = newAgentId()
  await consult(m, agentId)
  // 平台把 child 结算作为 source.kind='subagent-settled' 的用户消息投给主控
  m.emit('agent/pre-step', {
    agent: { id: agentId },
    messages: [{ role: 'user', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-x' } }],
  })
  const second = await consult(m, agentId)
  assert.equal(second.budget.used, 2, '结算通知不该被当成人类消息重置预算')
})

// ── 热加载覆盖文件：fallback 四键可运行期改 ────────────────────────────────

test('覆盖文件里配 fallback：改文件后下次委派即生效', async () => {
  writeFileSync(OVERRIDE, JSON.stringify({ expertFallbackProvider: 'file-provider', expertFallbackModel: 'file-model' }))
  const m = makeCtx({ plan: [new Error('boom')] })
  plugin.apply(m.ctx, {})
  const agentId = newAgentId()
  const result = await consult(m, agentId)
  assert.equal(result.expert.attempt, 'fallback')
  assert.deepEqual(m.spawns[1].request.agentOptions.provider, 'file-provider')
  assert.equal(m.spawns[1].request.agentOptions.model, 'file-model')
})
