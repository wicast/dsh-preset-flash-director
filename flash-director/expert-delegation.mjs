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
// 零导入：服务走 inject，schema 是纯 JSON Schema。默认模型/预算可被组合行
// 的 config 覆盖（expertProvider/expertModel/expertMaxTokens/
// maxExpertsPerUserTask/briefMaxChars/expertReuse/reuseMaxFollowups）。

const FALLBACK = {
  expertProvider: 'deepseek-official',
  expertModel: 'deepseek-v4-pro',
  expertMaxTokens: 32768,
  maxExpertsPerUserTask: 3,
  briefMaxChars: 40000,
  expertReuse: 'session',
  reuseMaxFollowups: 8,
}

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
    const c = config ?? {}
    const settings = {
      expertProvider: typeof c.expertProvider === 'string' ? c.expertProvider : FALLBACK.expertProvider,
      expertModel: typeof c.expertModel === 'string' ? c.expertModel : FALLBACK.expertModel,
      expertMaxTokens: Number.isInteger(c.expertMaxTokens) ? c.expertMaxTokens : FALLBACK.expertMaxTokens,
      maxExpertsPerUserTask: Number.isInteger(c.maxExpertsPerUserTask) ? c.maxExpertsPerUserTask : FALLBACK.maxExpertsPerUserTask,
      briefMaxChars: Number.isInteger(c.briefMaxChars) ? c.briefMaxChars : FALLBACK.briefMaxChars,
      expertReuse: c.expertReuse === 'off' || c.expertReuse === 'session' ? c.expertReuse : FALLBACK.expertReuse,
      reuseMaxFollowups: Number.isInteger(c.reuseMaxFollowups) && c.reuseMaxFollowups > 0 ? c.reuseMaxFollowups : FALLBACK.reuseMaxFollowups,
    }

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

    function budgetInfo(ledger) {
      return { used: ledger.used, limit: settings.maxExpertsPerUserTask, remaining: settings.maxExpertsPerUserTask - ledger.used }
    }

    function delegatedResult(childId, messageId, reviewer, ledger, extra) {
      const reused = extra?.reused === true
      const roleLabel = reviewer ? 'reviewer' : 'expert'
      const next = reused
        ? `Reused this session's standing ${roleLabel} child via followup (same conversation, higher cache-hit rate). It will report asynchronously as "Background subagent <id> reported:". Verify against your acceptance checklist; at most one bounded send_message follow-up — that channel is NOT counted against reuseMaxFollowups or the budget, so keep it to one.`
        : `The expert will report asynchronously as "Background subagent <id> reported:". Verify the report against your acceptance checklist; at most one bounded follow-up via send_message (a separate channel, not counted against reuseMaxFollowups or the budget).`
      return {
        status: 'delegated',
        childId,
        messageId,
        budget: budgetInfo(ledger),
        next,
        ...extra,
      }
    }

    // 会话内复用决策。返回 'followup'（复用该 child）或 'spawn'（新建）。
    function decideReuse(reviewer, agentKey) {
      if (settings.expertReuse !== 'session') return { action: 'spawn', reason: 'reuse-off' }
      if (followupDisabled.has(agentKey)) return { action: 'spawn', reason: 'followup-disabled' }
      const entry = poolSlot(agentKey, reviewer)
      if (entry === undefined) return { action: 'spawn', reason: 'no-pool-entry' }
      if (entry.followups >= settings.reuseMaxFollowups) return { action: 'spawn', reason: 'rotation-cap' }
      return { action: 'followup', entry, reason: 'reuse' }
    }

    // 把本次简报作为下一次 user turn 投递给既有 child。返回 delegated 结果或
    // null（followup 失败，调用方应回落为新建）。
    async function attemptFollowup(entry, brief, parent, exec) {
      try {
        const messageId = await ctx.subagents.followup(parent, entry.childId, [textBlock(brief)], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        })
        entry.followups += 1
        return { messageId, reused: true, childId: entry.childId }
      } catch (error) {
        return null
      }
    }

    // 新建一个专家子代理（fresh spawn），并写入该角色的池 slot。
    async function spawnFresh(reviewer, brief, parent, exec, ledger, cost) {
      ledger.used += cost
      try {
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          // 角色化 label：复用的 child 会跨 kind 服务，label 保持稳定便于
          // list_agents 识别（consult / review 两池）。
          label: reviewer ? 'pro-expert:review' : 'pro-expert:consult',
          request: {
            prompt: [textBlock(brief)],
            parent,
            agentOptions: {
              provider: settings.expertProvider,
              model: settings.expertModel,
              maxTokens: settings.expertMaxTokens,
            },
            persona: expertPersona(reviewer),
            toolFilter: { deny: DENY_TOOLS },
          },
          signal: exec.signal,
        })
        setPoolSlot(agentKeyOf(parent), reviewer, { childId: started.childId, followups: 0 })
        return delegatedResult(started.childId, started.messageId, reviewer, ledger, { reused: false, cost })
      } catch (error) {
        ledger.used -= cost
        return { status: 'failed', error: String(error && error.message ? error.message : error) }
      }
    }

    // 统一委派入口：预算闸门 → 会话内复用决策 → followup 优先、失败回落新建。
    async function spawnExpert(args, reviewer, exec) {
      const parent = exec.agent
      if (!parent) return rejectText('expert delegation requires a calling agent (exec.agent was undefined)')
      const brief = buildBrief(args, reviewer)
      if (brief.length > settings.briefMaxChars) {
        const curate = reviewer ? 'subject/content' : 'background/evidence'
        return rejectText(`brief is ${brief.length} chars (limit ${settings.briefMaxChars}): curate ${curate} and keep only the facts the expert needs`)
      }
      const agentKey = agentKeyOf(parent)
      const ledger = ledgerOf(agentKey)
      const cost = reviewer && args.stakes === 'high' ? 2 : 1
      if (ledger.used + cost > settings.maxExpertsPerUserTask) {
        return {
          status: 'budget-exhausted',
          budget: budgetInfo(ledger),
          instruction: 'Expert budget for this user task is exhausted. Finish with your own best effort and tell the user the budget was hit; do not delegate again until the user sends a new message.',
        }
      }

      const decision = decideReuse(reviewer, agentKey)
      if (decision.action === 'followup') {
        ledger.used += cost
        const outcome = await attemptFollowup(decision.entry, brief, parent, exec)
        if (outcome !== null) {
          return delegatedResult(outcome.childId, outcome.messageId, reviewer, ledger, { reused: true, cost })
        }
        // followup 失败：退款、禁用本任务复用、清掉坏 slot，回落为新建。
        ledger.used -= cost
        followupDisabled.add(agentKey)
        clearPoolSlot(agentKey, reviewer)
      }

      return spawnFresh(reviewer, brief, parent, exec, ledger, cost)
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
        const fieldMax = {
          task: TASK_MAX,
          background: Math.floor(settings.briefMaxChars * BACKGROUND_MAX_FRACTION),
          evidence: Math.floor(settings.briefMaxChars * EVIDENCE_MAX_FRACTION),
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
        return spawnExpert(args, false, exec)
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
        const subjectProblem = validateStrings(args.subject, 'subject', 10, SUBJECT_MAX)
        if (subjectProblem !== undefined) return rejectText(subjectProblem)
        // content 上限为 briefMaxChars 扣除头尾余量，避免"字段通过而拼装后超限"的二次误拒。
        const contentMax = Math.max(SUBJECT_MAX + 10, settings.briefMaxChars - REVIEW_CONTENT_HEADROOM)
        const contentProblem = validateStrings(args.content, 'content', 10, contentMax)
        if (contentProblem !== undefined) return rejectText(contentProblem)
        return spawnExpert(args, true, exec)
      },
    }

    ctx.tools.register(consult)
    ctx.tools.register(review)
  },
}
