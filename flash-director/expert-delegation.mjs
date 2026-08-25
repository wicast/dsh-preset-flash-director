// expert-delegation.mjs — Flash-Director 专家委派策略层
//
// 预设本地插件（由组合行 `./expert-delegation.mjs` 加载）。它把宿主
// `subagents` 服务包上一层策略，让 "flash 主控 + pro 专家" 模式成立：
//
//   1. expert_consult / expert_review 是生成 pro 模型（deepseek-v4-pro）专家
//      子代理的唯一通道；本预设不再暴露裸 subagent 工具。
//   2. 简报强制校验：task/background/evidence/acceptance 必填且有界；超大
//      简报被拒绝，逼主控精炼上下文（pro 的输入 token 才是最贵的）。
//   3. 硬性预算：每个用户任务最多 N 次专家委派（新的人类消息进入 step 时
//      重置）；expert_review stakes:"high" 计 2 次。预算按"认知委派"记账，
//      复用（followup）与新建（spawn）同价，轮换不额外计费。
//   4. 会话内复用（expertReuse: 'session'，默认开启）：同一会话内按角色
//      （consult / review）各复用同一专家子代理——后续委派经 followup 续聊
//      而非重复新建，少开 subagent、让整段对话成为 provider 前缀缓存的共享
//      前缀。轮换上限 reuseMaxFollowups 防上下文无限膨胀；followup 失败
//      （父实例失效 / child 不可恢复等）自动回落为新建并禁用本任务的复用。
//   5. 专家子代理为 continuable（可用全局 send_message 做一次有界追问）、
//      无法再委派（工具被 deny）、不能写文件/与用户对话（toolFilter），并
//      获得遮蔽 persona：一个只输出结构化报告的独立智库。
//
// 平台约束（决定了本实现）：
//   - followup 的 authorizeLineage 要求调用者是 child 的 exact live direct
//     parent，故复用范围只能是"同一会话内"；跨会话共享 subagent 被平台禁止。
//   - persona/toolFilter 在 spawn 时写入 descriptor、cold resume 时原样恢复，
//     故复用的 child 必须用统一 persona，任务差异（kind/reviewer）经简报携带。
//   - child 空闲后其 Activation 由宿主 dispose（session 持久化），后续 followup
//     自动 cold resume；我们不主动 drain，只从池里摘记。
//
// 零依赖（仅 node 内置模块）：服务走 inject，schema 是纯 JSON Schema。默认
// 模型/预算可被组合行的 config 覆盖（expertProvider/expertModel/expertMaxTokens/
// maxExpertsPerUserTask/briefMaxChars/expertReuse/reuseMaxFollowups/
// followupRetryBudget/expertReasoningEffort），并可在运行期用模块同目录的
// `expert-delegation.config.json` 热覆盖——无需重启 DSH，旧会话下一次委派即
// 生效；改 expertProvider/expertModel/expertMaxTokens 会让已复用的旧 child
// 指纹失配而自动轮换为新建（新模型生效）。
// expertReasoningEffort（off|low|high|max，缺省继承）经 agent/request 瀑布注入
// 专家子代理的请求配置，改热加载文件后该 child 下一请求即生效、不轮换。
// 复用健壮性：followup 瞬态失败（NOT_RESUMABLE/DRAINING/ACTIVATION_CLOSING）
// 保留条目并按 followupRetryBudget 有界重试，permanent（UNAUTHORIZED 等）清槽
// 禁用；池为空时按 label 经 listChildren 收养仍存活的 child（进程/模块重载后）。

// ── 热加载覆盖配置（无需重启 DSH，下次委派即生效）──
// 优先级：`expert-delegation.config.json`（模块同目录，或 $FLASH_DIRECTOR_CONFIG
// 指定路径）> 组合行 config（agent.cordis.yml 传入 apply）> FALLBACK。
// 每次委派解析一次（mtime 缓存省去未变时的重读）；文件缺失/畸形安全回落。
// 改 expertProvider/expertModel/expertMaxTokens 会让既有复用 child 指纹失配
// → 强制新建（新模型生效）；其余键（reuseMaxFollowups/maxExpertsPerUserTask/
// briefMaxChars/expertReuse）即时生效、不触发重建。
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_PATH = process.env.FLASH_DIRECTOR_CONFIG
  ? process.env.FLASH_DIRECTOR_CONFIG
  : join(dirname(fileURLToPath(import.meta.url)), 'expert-delegation.config.json')
// 本预设组合行（agent.cordis.yml）只 apply 本插件一次；若同一模块被多次
// apply（多行引用或热重载），最后一次 config 会作为全局基线生效——当前无此
// 场景，此前提仅作文档声明。
let cordisConfig = {}
let overridesCache = { mtimeMs: -1, values: null }
let lastConfigError = null

// spawn 指纹 = 决定 child 构造的键（provider/model/maxTokens）。用 JSON 序列化
// 避免分隔符碰撞；指纹变化 → 既有复用 child 轮换为新建（config-drift）。
function fingerprintOf(s) {
  return JSON.stringify([s.expertProvider, s.expertModel, s.expertMaxTokens])
}

// followup 失败分类（依据 dsh-subagent 管理器的错误语义）：
//   transient  = 冷恢复竞态/生命周期瞬时边界（NOT_RESUMABLE、DRAINING、
//                ACTIVATION_CLOSING）→ 保留条目、有界重试，下委派再试
//   permanent  = 授权失效/能力缺失（UNAUTHORIZED、PERSISTENCE_UNAVAILABLE）及
//                未知错误（保守）→ 清槽 + 本任务禁用
//   cancelled  = 调用被 abort → 原样透出，不碰槽与预算
function classifyFollowupError(error) {
  const code = error && typeof error.code === 'string'
    ? error.code
    : (error && error.name === 'AbortError' ? 'CANCELLED' : 'UNKNOWN')
  if (code === 'CANCELLED') return { code, cancelled: true, transient: false, permanent: false }
  if (code === 'NOT_RESUMABLE' || code === 'DRAINING' || code === 'ACTIVATION_CLOSING') {
    return { code, cancelled: false, transient: true, permanent: false }
  }
  return { code, cancelled: false, transient: false, permanent: true }
}

// 解析一次有效配置：FALLBACK ← cordis ← 覆盖文件，逐键按与 apply 相同的规则校验。
async function resolveSettings() {
  const merged = { ...FALLBACK, ...cordisConfig }
  try {
    const fileStat = await stat(CONFIG_PATH)
    if (overridesCache.mtimeMs !== fileStat.mtimeMs) {
      let values = null
      try {
        const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          values = parsed
          lastConfigError = null
        } else {
          lastConfigError = 'expert-delegation.config.json must be a JSON object'
          console.warn('[flash-director] ' + lastConfigError)
        }
      } catch (error) {
        lastConfigError = `expert-delegation.config.json invalid JSON: ${String(error && error.message ? error.message : error)}`
        console.warn('[flash-director] ' + lastConfigError)
      }
      overridesCache = { mtimeMs: fileStat.mtimeMs, values }
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      overridesCache = { mtimeMs: -1, values: null }
      lastConfigError = null
    }
    // 其它 stat 错误：静默保留当前缓存
  }
  if (overridesCache.values !== null) Object.assign(merged, overridesCache.values)
  return {
    expertProvider: typeof merged.expertProvider === 'string' ? merged.expertProvider : FALLBACK.expertProvider,
    expertModel: typeof merged.expertModel === 'string' ? merged.expertModel : FALLBACK.expertModel,
    expertMaxTokens: Number.isInteger(merged.expertMaxTokens) ? merged.expertMaxTokens : FALLBACK.expertMaxTokens,
    maxExpertsPerUserTask: Number.isInteger(merged.maxExpertsPerUserTask) ? merged.maxExpertsPerUserTask : FALLBACK.maxExpertsPerUserTask,
    briefMaxChars: Number.isInteger(merged.briefMaxChars) ? merged.briefMaxChars : FALLBACK.briefMaxChars,
    expertReuse: merged.expertReuse === 'off' || merged.expertReuse === 'session' ? merged.expertReuse : FALLBACK.expertReuse,
    reuseMaxFollowups: Number.isInteger(merged.reuseMaxFollowups) && merged.reuseMaxFollowups > 0 ? merged.reuseMaxFollowups : FALLBACK.reuseMaxFollowups,
    followupRetryBudget: Number.isInteger(merged.followupRetryBudget) && merged.followupRetryBudget > 0 ? merged.followupRetryBudget : FALLBACK.followupRetryBudget,
    // 思考强度：白名单外的值（含 null/缺省）一律按 undefined 处理 → 不注入。
    expertReasoningEffort: EFFORT_VALUES.has(merged.expertReasoningEffort) ? merged.expertReasoningEffort : undefined,
  }
}

const FALLBACK = {
  expertProvider: 'deepseek-official',
  expertModel: 'deepseek-v4-pro',
  expertMaxTokens: 32768,
  maxExpertsPerUserTask: 3,
  briefMaxChars: 40000,
  expertReuse: 'session',
  reuseMaxFollowups: 8,
  // 瞬态 followup 失败（NOT_RESUMABLE 等）的有界重试预算：达到上限才放弃该 child。
  followupRetryBudget: 2,
}

// 专家子代理思考强度档位（经 agent/request 瀑布注入 child 的请求配置）。
// 缺省（不在 FALLBACK 中）= undefined = 不注入 = 继承部署/适配器默认。
const EFFORT_VALUES = new Set(['off', 'low', 'high', 'max'])

// 单字段上限。evidence 是简报里最重的部分（日志、命令输出、文件摘录），
// 给最大配额；task 是"一个认知问题"，必须保持紧凑。三个字段配额之和刻意
// 留出低于 briefMaxChars 的头尾余量（固定头/答法要求/交付协议/acceptance 等
// 拼装开销），保证"各字段都到上限"的简报仍能通过拼装后的整体上限校验。
const TASK_MAX = 4000
const BACKGROUND_MAX_FRACTION = 0.35
const EVIDENCE_MAX_FRACTION = 0.45
const SUBJECT_MAX = 2000
// review 的 content 字段给 briefMaxChars 减去该余量（subject ≤2000 + 头尾/
// 审查要点开销），避免"字段通过而拼装后超限"的二次误拒。
const REVIEW_CONTENT_HEADROOM = 4000

// 专家子代理不允许持有的工具：委托链、文件写入、与用户对话、目标、后台
// 任务、计划模式、todo、skill 加载。bash/read/glob/grep/web_search 保留，
// 用于低成本验证假设（persona 同时要求只读使用）。
const DENY_TOOLS = [
  'send_message', 'interrupt_agent', 'list_agents',
  'expert_consult', 'expert_review',
  'write', 'edit',
  'ask_user_question',
  'create_goal', 'get_goal', 'update_goal',
  'job_output', 'job_list', 'job_kill',
  'exit_plan_mode', 'todo_write', 'skill',
]

const KIND_LABEL = { plan: '规划', design: '设计', debug: '调试根因', analysis: '深度分析' }

const KIND_FOCUS = {
  plan: 'Deliver a decision-complete implementation plan: goal and success criteria; steps grouped by subsystem; public API, schema, and data-flow changes; edge cases, failure modes, tests; explicit assumptions.',
  design: 'Weigh the design space explicitly: list candidate approaches with tradeoffs, choose one with justification, and describe the chosen structure precisely enough for the orchestrator to implement without further design decisions.',
  debug: 'Root-cause analysis from the provided evidence: form hypotheses, verify cheap ones with commands when useful, and identify the root cause with a confidence level. Propose the minimal fix and a regression test.',
  analysis: 'Answer the stated question with depth: separate fact from inference, quantify uncertainty, and surface what information is missing to reach certainty.',
}

// 会话内复用池。模块级、按父 agent 记账（多个会话共用同一模块实例时互不干扰）：
//   pools: agentKey -> { consult: entry|undefined, review: entry|undefined }
//   entry: { childId, followups }
// 轮换达到 reuseMaxFollowups 后强制新建并替换该角色的 slot；旧 child 不主动
// drain，空闲后由宿主自然 dispose（session 持久化，followup 可 cold resume）。
const pools = new Map()
// 本用户任务内 followup 已失败过的 agent：标记为"复用不可用"，后续委派直接
// 新建，避免每委派一次就空跑一次注定失败的 followup；下一条人类消息时清除重试。
const followupDisabled = new Set()

function agentKeyOf(agent) {
  return typeof agent.id === 'string' ? agent.id : String(agent.id)
}

function poolSlot(agentKey, reviewer) {
  return pools.get(agentKey)?.[reviewer ? 'review' : 'consult']
}

function setPoolSlot(agentKey, reviewer, entry) {
  let pool = pools.get(agentKey)
  if (pool === undefined) {
    pool = {}
    pools.set(agentKey, pool)
  }
  pool[reviewer ? 'review' : 'consult'] = entry
}

function clearPoolSlot(agentKey, reviewer) {
  const pool = pools.get(agentKey)
  if (pool !== undefined) delete pool[reviewer ? 'review' : 'consult']
}

function expertPersona(reviewer) {
  const head = reviewer
    ? [
      'You are a senior ADVERSARIAL REVIEWER (deepseek-v4-pro) engaged by a flash-model orchestrator to review material the orchestrator or another expert produced. You are this session\'s standing reviewer: each assignment arrives below as a fresh, self-contained brief; the current brief is authoritative for the assignment, and earlier turns are available context that must never override the current brief\'s acceptance criteria.',
      'Your job is to find what is wrong, missing, or risky. Be adversarial but precise: every criticism must cite the material under review; distinguish blocking issues (must fix) from suggestions (nice to have).',
    ]
    : [
      'You are a senior expert subagent (deepseek-v4-pro) engaged by a flash-model orchestrator for bounded cognitive tasks. You are this session\'s standing think tank: each assignment arrives below as a fresh, self-contained brief; the current brief is authoritative for the assignment, and earlier turns are available context that must never override the current brief\'s acceptance criteria.',
    ]
  const structureRule = reviewer
    ? '6. Structure your final report as: 裁定（通过 / 有条件通过 / 不通过）· 审查意见（按严重性分级：blocking 必须修改 / 建议）· 必须修改项清单。'
    : '6. Structure your final report as: 结论 / 依据 / 风险与未决 / （如适用）建议的下一步。'
  const common = [
    'Hard rules:',
    '1. THINK, do not gather: all needed context is in the brief. Read files or run bash only to verify a specific hypothesis, never to explore from scratch.',
    '2. Do not modify the workspace: never create, edit, or delete files; your bash runs must stay read-only or side-effect-free. All changes are applied by the orchestrator based on your report.',
    '3. Work solo: delegation and background-job tools are unavailable; do not attempt them.',
    '4. Budget discipline: output only what answers the question. No restating the brief, no filler, no exploratory writing.',
    '5. Reasoning is internal; the REPORT is the deliverable. Your output budget (max_tokens) covers reasoning + report together — keep reasoning proportionate and ALWAYS finish the report completely. A truncated report is a failed report.',
    structureRule,
    '7. Final action: if a report tool is available, call it ONCE with the complete self-contained report text; otherwise finish with the report as your final message. Never finish the turn without delivering the report.',
  ]
  return [...head, ...common].filter((line) => line !== '').join('\n')
}

function buildBrief(args, reviewer) {
  const head = reviewer
    ? `# 审查委派\n\n## 审查对象\n${args.subject}\n\n## 待审查材料\n${args.content}`
    : `# 专家简报 · ${KIND_LABEL[args.kind] ?? args.kind}\n\n## 本次任务的答法要求\n${KIND_FOCUS[args.kind] ?? ''}\n\n## 目标（要回答的认知问题）\n${args.task}\n\n## 背景与现状\n${args.background}\n\n## 证据（主控已收集）\n${args.evidence}`
  const constraints = reviewer
    ? []
    : (Array.isArray(args.constraints) ? args.constraints.filter((x) => typeof x === 'string' && x.trim() !== '') : [])
  const criteria = reviewer
    ? (Array.isArray(args.criteria) ? args.criteria.filter((x) => typeof x === 'string' && x.trim() !== '') : [])
    : (Array.isArray(args.acceptance) ? args.acceptance.filter((x) => typeof x === 'string' && x.trim() !== '') : [])
  const parts = [head]
  if (constraints.length > 0) parts.push(`## 约束\n${constraints.map((x) => '- ' + x).join('\n')}`)
  if (criteria.length > 0) {
    const title = reviewer ? '## 审查要点' : '## 验收标准（主控将据此逐项验证）'
    parts.push(`${title}\n${criteria.map((x, i) => `${i + 1}. ${x}`).join('\n')}`)
  }
  const delivery = reviewer
    ? '## 交付协议\n按「裁定 · 审查意见（blocking 必须修改 / 建议）· 必须修改项清单」结构完成，最后调用 report 一次性提交完整报告。'
    : '## 交付协议\n按「结论 / 依据 / 风险与未决」结构完成，最后调用 report 一次性提交完整报告。'
  parts.push(delivery)
  return parts.join('\n\n')
}

export default {
  name: 'flash-director-expert-delegation',
  inject: ['tools', 'subagents'],
  apply(ctx, config) {
    // 组合行 config（agent.cordis.yml）作为基线；运行期每次委派由
    // resolveSettings() 再合并覆盖文件动态解析，不再冻结为单次快照。
    cordisConfig = config ?? {}

    // 预算账本，按 agent 记账；新的人类消息进入 step 时清零（"用户任务"边界）。
    // 同时清除本任务的 followupDisabled 标记（下个任务重试复用）。
    const ledgers = new Map()
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        const msgs = Array.isArray(payload?.messages) ? payload.messages : []
        const human = msgs.some((m) => m && (m.source?.kind === 'user' || (m.role === 'user' && !m.source)))
        if (human && payload?.agent && typeof payload.agent.id === 'string') {
          ledgers.set(payload.agent.id, { used: 0 })
          followupDisabled.delete(payload.agent.id)
        }
      } catch {
        /* 绝不让预算监听器打断瀑布 */
      }
      return next()
    })

    function ledgerOf(agentId) {
      let entry = ledgers.get(agentId)
      if (entry === undefined) {
        entry = { used: 0 }
        ledgers.set(agentId, entry)
      }
      return entry
    }

    function textBlock(text) {
      return { type: 'text', text }
    }

    function rejectText(reason) {
      return { status: 'rejected', reason }
    }

    function validateStrings(value, field, min, max) {
      if (typeof value !== 'string' || value.trim().length === 0) return `${field} is required`
      if (value.length < min) return `${field} is too short (min ${min} chars)`
      if (value.length > max) return `${field} exceeds ${max} chars — curate it down to what the expert needs`
      return undefined
    }

    function budgetInfo(ledger, s) {
      return { used: ledger.used, limit: s.maxExpertsPerUserTask, remaining: s.maxExpertsPerUserTask - ledger.used }
    }

    function delegatedResult(childId, messageId, reviewer, ledger, s, extra) {
      const reused = extra?.reused === true
      const roleLabel = reviewer ? 'reviewer' : 'expert'
      const next = reused
        ? `Reused this session's standing ${roleLabel} child via followup (same conversation, higher cache-hit rate). It will report asynchronously as "Background subagent <id> reported:". Verify against your acceptance checklist; at most one bounded send_message follow-up — that channel is NOT counted against reuseMaxFollowups or the budget, so keep it to one.`
        : `The expert will report asynchronously as "Background subagent <id> reported:". Verify the report against your acceptance checklist; at most one bounded follow-up via send_message (a separate channel, not counted against reuseMaxFollowups or the budget).`
      return {
        status: 'delegated',
        childId,
        messageId,
        budget: budgetInfo(ledger, s),
        next,
        // 覆盖文件畸形/非法时把诊断带给控制器，避免"改了没生效"却无信号
        ...(lastConfigError !== null ? { configError: lastConfigError } : {}),
        ...extra,
      }
    }

    // 会话内复用决策。返回 'followup'（复用该 child）或 'spawn'（新建）。
    // s 是本次委派解析的一次性有效配置快照（含热覆盖）。
    function decideReuse(reviewer, agentKey, s) {
      if (s.expertReuse !== 'session') return { action: 'spawn', reason: 'reuse-off' }
      if (followupDisabled.has(agentKey)) return { action: 'spawn', reason: 'followup-disabled' }
      const entry = poolSlot(agentKey, reviewer)
      if (entry === undefined) return { action: 'spawn', reason: 'no-pool-entry' }
      // 收养的 child 指纹未知：本委派强制 followup（一次性吸附），成功后以当前
      // 配置固化指纹，此后受 config-drift 约束（换模型不再被静默复用）。
      if (entry.adopted === true) return { action: 'followup', entry, reason: 'adopted' }
      // 配置漂移：spawn 指纹键（provider/model/maxTokens）变了 → 旧 child 的
      // 模型已过时，清槽新建（与 followupDisabled 语义无关，只是轮换）。
      if (entry.fingerprint !== fingerprintOf(s)) {
        clearPoolSlot(agentKey, reviewer)
        return { action: 'spawn', reason: 'config-drift' }
      }
      if (entry.followups >= s.reuseMaxFollowups) return { action: 'spawn', reason: 'rotation-cap' }
      return { action: 'followup', entry, reason: 'reuse' }
    }

    // 把本次简报作为下一次 user turn 投递给既有 child。结构化返回：
    // 成功 { ok:true, messageId, childId }；失败 { ok:false, code, cls, error }。
    async function attemptFollowup(entry, brief, parent, exec, retryBudget) {
      try {
        const messageId = await ctx.subagents.followup(parent, entry.childId, [textBlock(brief)], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        })
        entry.followups += 1
        entry.retries = 0
        return { ok: true, messageId, childId: entry.childId }
      } catch (error) {
        const cls = classifyFollowupError(error)
        if (cls.transient) entry.retries = (entry.retries || 0) + 1
        console.warn(
          `[flash-director] followup failed (code=${cls.code}, child=${entry.childId}, `
          + `retries=${entry.retries || 0}/${retryBudget}, ${cls.cancelled ? 'cancelled' : cls.permanent ? 'permanent' : 'transient'})`
        )
        return { ok: false, code: cls.code, cls, error }
      }
    }

    // 进程/模块重载后池为空时，按角色 label 在父级子代理列表中找回仍可续的
    // child（listChildren 持久化感知），避免盲目新建。收养条目 adopted 标记
    // + 指纹未知；若 listChildren 失败，安静回落为新建，不打断委派。
    async function adoptExistingChild(agentKey, reviewer, parent, exec) {
      try {
        const rows = await ctx.subagents.listChildren(parent.id, exec.signal)
        const label = reviewer ? 'pro-expert:review' : 'pro-expert:consult'
        const row = (Array.isArray(rows) ? rows : []).find(
          (r) => r && r.kind === 'child' && r.mode === 'continuable' && r.label === label && (r.id || r.childId)
        )
        if (row === undefined) return
        setPoolSlot(agentKey, reviewer, {
          childId: row.id ?? row.childId,
          followups: 0,
          fingerprint: null,
          retries: 0,
          adopted: true,
        })
      } catch (error) {
        console.warn(`[flash-director] listChildren adoption skipped: ${String(error && error.message ? error.message : error)}`)
      }
    }

    // 新建一个专家子代理（fresh spawn）。preserveSlot=true 时（瞬态失败后回落的
    // 一次性 spawn）不写池槽——被保留的旧 child 留给下一次委派重试，本委派的新
    // child 是一次性的，空闲后由宿主回收。meta: { reuseReason, followupError? }。
    async function spawnFresh(reviewer, brief, parent, exec, ledger, cost, s, meta, preserveSlot) {
      ledger.used += cost
      try {
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          // 角色化 label：复用的 child 会跨 kind 服务，label 保持稳定便于
          // list_agents 识别与 listChildren 收养（consult / review 两池）。
          label: reviewer ? 'pro-expert:review' : 'pro-expert:consult',
          request: {
            prompt: [textBlock(brief)],
            parent,
            agentOptions: {
              provider: s.expertProvider,
              model: s.expertModel,
              maxTokens: s.expertMaxTokens,
            },
            persona: expertPersona(reviewer),
            toolFilter: { deny: DENY_TOOLS },
          },
          signal: exec.signal,
        })
        if (preserveSlot !== true) {
          setPoolSlot(agentKeyOf(parent), reviewer, {
            childId: started.childId,
            followups: 0,
            fingerprint: fingerprintOf(s),
            retries: 0,
            adopted: false,
          })
        }
        return delegatedResult(started.childId, started.messageId, reviewer, ledger, s, { reused: false, cost, ...meta })
      } catch (error) {
        ledger.used -= cost
        return { status: 'failed', error: String(error && error.message ? error.message : error) }
      }
    }

    // 统一委派入口：解析有效配置 → 预算闸门 → （可选）收养找回 → 复用决策
    // → followup 优先、失败按分类回落新建。
    // s 由调用方（工具 execute）解析一次并下传，保证一次委派内键一致。
    async function spawnExpert(args, reviewer, exec, s) {
      const parent = exec.agent
      if (!parent) return rejectText('expert delegation requires a calling agent (exec.agent was undefined)')
      const brief = buildBrief(args, reviewer)
      if (brief.length > s.briefMaxChars) {
        const curate = reviewer ? 'subject/content' : 'background/evidence'
        return rejectText(`brief is ${brief.length} chars (limit ${s.briefMaxChars}): curate ${curate} and keep only the facts the expert needs`)
      }
      const agentKey = agentKeyOf(parent)
      const ledger = ledgerOf(agentKey)
      const cost = reviewer && args.stakes === 'high' ? 2 : 1
      if (ledger.used + cost > s.maxExpertsPerUserTask) {
        return {
          status: 'budget-exhausted',
          budget: budgetInfo(ledger, s),
          instruction: 'Expert budget for this user task is exhausted. Finish with your own best effort and tell the user the budget was hit; do not delegate again until the user sends a new message.',
        }
      }

      // 池空且复用开启：尝试按 label 收养仍存活的 child（进程/模块重载后）。
      if (s.expertReuse === 'session' && !followupDisabled.has(agentKey) && poolSlot(agentKey, reviewer) === undefined) {
        await adoptExistingChild(agentKey, reviewer, parent, exec)
      }

      const decision = decideReuse(reviewer, agentKey, s)
      if (decision.action === 'followup') {
        ledger.used += cost
        const outcome = await attemptFollowup(decision.entry, brief, parent, exec, s.followupRetryBudget)
        if (outcome.ok) {
          // 收养条目一次性吸附后固化：指纹以当前配置为准，后续受 config-drift 约束。
          if (decision.entry.adopted === true) {
            decision.entry.adopted = false
            decision.entry.fingerprint = fingerprintOf(s)
          }
          return delegatedResult(outcome.childId, outcome.messageId, reviewer, ledger, s, {
            reused: true,
            cost,
            reuseReason: decision.reason,
          })
        }
        // followup 失败：退款；CANCELLED 原样透出；transient 保留条目有界重试，
        // permanent 清槽 + 本任务禁用；预算不重复扣（spawn 路径重新记账）。
        ledger.used -= cost
        if (outcome.cls.cancelled) throw outcome.error
        const willRetry = outcome.cls.transient && (decision.entry.retries || 0) < s.followupRetryBudget
        const reuseMeta = {
          reuseReason: `followup-error:${outcome.code}`,
          followupError: { code: outcome.code, retries: decision.entry.retries || 0, willRetry },
        }
        if (outcome.cls.permanent) {
          followupDisabled.add(agentKey)
          clearPoolSlot(agentKey, reviewer)
        } else if (!willRetry) {
          // 瞬态重试预算耗尽：清槽但不禁用（不是授权失效，只是该 child 老化）。
          clearPoolSlot(agentKey, reviewer)
        }
        // willRetry=true 时保留被重试的旧 entry，本次回落 spawn 不覆盖槽位。
        return spawnFresh(reviewer, brief, parent, exec, ledger, cost, s, reuseMeta, willRetry)
      }

      return spawnFresh(reviewer, brief, parent, exec, ledger, cost, s, { reuseReason: decision.reason })
    }

    const consult = {
      name: 'expert_consult',
      description: 'Delegate ONE bounded cognitive task to a pro-model expert (deepseek-v4-pro). This is the ONLY channel for deep-thinking work — planning, design, root-cause analysis, high-risk decisions — which you must never attempt yourself. The tool enforces the delegation protocol: a complete curated brief is mandatory, and a hard budget of 3 expert delegations per user task applies (reset on each new user message; expert_review with stakes "high" costs 2). In the default session-reuse mode the delegation reuses this session\'s standing expert child via followup (fewer subagents, higher provider cache-hit rate) instead of spawning a fresh one; rotation and failure fallback are automatic.\n\nMANDATORY before calling: 1) gather evidence first (read files, run commands, search) — an empty evidence section is rejected; 2) task = exactly ONE cognitive question, not an operation; 3) acceptance = a mechanically verifiable checklist written BEFORE delegating; 4) curate context — oversized briefs are rejected, never dump whole files or the conversation.\n\nThe expert reports asynchronously ("Background subagent <id> reported:"), cannot write files, and cannot delegate. Verify the report against your acceptance checklist with tests/commands; at most one bounded follow-up via send_message. If the budget is exhausted the tool refuses — finish with your best effort and tell the user.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['plan', 'design', 'debug', 'analysis'], description: 'Cognitive task kind; selects the expert focus.' },
          task: { type: 'string', description: 'The ONE cognitive question to answer.' },
          background: { type: 'string', description: 'Current state, what was tried, known constraints.' },
          evidence: { type: 'string', description: 'Curated facts you already gathered (files read, command outputs, search findings).' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Optional hard constraints the answer must respect.' },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Verification checklist you wrote BEFORE delegating; you will check each item when the report arrives.' },
        },
        required: ['kind', 'task', 'background', 'evidence', 'acceptance'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [textBlock(JSON.stringify(value, null, 2))]
        },
      },
      async execute(args, exec) {
        const s = await resolveSettings()
        const fieldMax = {
          task: TASK_MAX,
          background: Math.floor(s.briefMaxChars * BACKGROUND_MAX_FRACTION),
          evidence: Math.floor(s.briefMaxChars * EVIDENCE_MAX_FRACTION),
        }
        for (const field of ['task', 'background', 'evidence']) {
          const problem = validateStrings(args[field], field, 10, fieldMax[field])
          if (problem !== undefined) return rejectText(problem)
        }
        if (!Array.isArray(args.acceptance) || args.acceptance.filter((a) => typeof a === 'string' && a.trim() !== '').length === 0) {
          return rejectText('acceptance must be a non-empty list of verification criteria written BEFORE delegating')
        }
        if (typeof args.kind !== 'string' || !Object.prototype.hasOwnProperty.call(KIND_FOCUS, args.kind)) {
          return rejectText('kind must be one of plan/design/debug/analysis')
        }
        return spawnExpert(args, false, exec, s)
      },
    }

    const review = {
      name: 'expert_review',
      description: 'Ask a pro-model expert (deepseek-v4-pro) to ADVERSARIALLY REVIEW material — your own design, plan, diff, or another expert\'s output. Use this for the meta-cognition loop: high-risk or complex deliverables get checked by a stronger model before you ship them. Costs 1 budget slot, or 2 with stakes "high" (irreversible changes: schema, migration, security). In the default session-reuse mode the review reuses this session\'s standing reviewer child via followup. The review report arrives asynchronously like expert_consult and must be verified the same way: read every blocking issue, apply the must-fix list, and only proceed once the verdict is 通过 (or the user overrides).',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'What is being reviewed (design/plan/diff/decision).' },
          content: { type: 'string', description: 'The complete material under review.' },
          criteria: { type: 'array', items: { type: 'string' }, description: 'Optional specific concerns or checkpoints for the reviewer.' },
          stakes: { type: 'string', enum: ['normal', 'high'], description: 'high = irreversible change; costs 2 budget slots.' },
        },
        required: ['subject', 'content'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [textBlock(JSON.stringify(value, null, 2))]
        },
      },
      async execute(args, exec) {
        const s = await resolveSettings()
        const subjectProblem = validateStrings(args.subject, 'subject', 10, SUBJECT_MAX)
        if (subjectProblem !== undefined) return rejectText(subjectProblem)
        // content 上限为 briefMaxChars 扣除头尾余量，避免"字段通过而拼装后超限"的二次误拒。
        const contentMax = Math.max(SUBJECT_MAX + 10, s.briefMaxChars - REVIEW_CONTENT_HEADROOM)
        const contentProblem = validateStrings(args.content, 'content', 10, contentMax)
        if (contentProblem !== undefined) return rejectText(contentProblem)
        return spawnExpert(args, true, exec, s)
      },
    }

    ctx.tools.register(consult)
    ctx.tools.register(review)

    // ── 专家子代理思考强度（expertReasoningEffort）──
    // 平台事实：agent-loop buildRequest 只从会话持久化 header 读 reasoningEffort、
    // 不读 this.options.reasoningEffort，所以 spawn 时塞进 agentOptions 无效；唯一
    // 覆盖请求配置的插件扩展点是 agent/request 瀑布。child（continuable 子代理）无
    // 宿主 installModelSelection，此钩子是 child 侧 effort 的唯一注入源；先 await
    // next() 再注入，保证任何上游（如未来某处的模型选择）已落定。判定只用本 ctx
    // 自身 agent（agent-scoped ctx 的 own property；waterfall payload 不带 agent）：
    // parentSession 存在即专家子代理；主控（顶层会话）无 parentSession、不受影响。
    // 改动不参与 spawn 指纹 → 切换档位热生效、不轮换 child；非法值由 resolveSettings
    // 降级为 undefined（不注入）；钩子自身绝不因我们的逻辑破坏专家轮次。
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next() // 下游错误原样上抛，不掩盖
      try {
        const agent = ctx.agent
        const isChild = !!(agent && agent.session && agent.session.header && agent.session.header.parentSession !== undefined)
        if (!isChild) return resolved
        const s = await resolveSettings()
        if (s.expertReasoningEffort === undefined) return resolved
        const { reasoningEffort: _inherited, ...rest } = resolved
        return { ...rest, reasoningEffort: s.expertReasoningEffort }
      } catch {
        return resolved // 我们自己的任何异常都不改变请求配置
      }
    })
  },
}
