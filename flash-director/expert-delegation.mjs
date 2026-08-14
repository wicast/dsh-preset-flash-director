// expert-delegation.mjs — Flash-Director 专家委派策略层
//
// 预设本地插件（由组合行 `./expert-delegation.mjs` 加载）。它把宿主
// `subagents` 服务包上一层策略，让 "flash 主控 + pro 专家" 模式成立：
//
//   1. expert_consult / expert_review 是生成 pro 模型（deepseek-v4-pro）专家
//      子代理的唯一通道；本预设不再暴露裸 subagent 工具。
//   2. 简报强制校验：task/background/evidence/acceptance 必填且有界；超大
//      简报被拒绝，逼主控精炼上下文（pro 的输入 token 才是最贵的）。
//   3. 硬性预算：每个用户任务最多 N 次专家启动（新的人类消息进入 step 时
//      重置）；expert_review stakes:"high" 计 2 次。
//   4. 专家子代理为 continuable（可用全局 send_message 做一次有界追问）、
//      无法再委派（工具被 deny）、不能写文件/与用户对话（toolFilter），并
//      获得遮蔽 persona：一个只输出结构化报告的独立智库。
//
// 零导入：服务走 inject，schema 是纯 JSON Schema。默认模型/预算可被组合行
// 的 config 覆盖（expertProvider/expertModel/expertMaxTokens/
// maxExpertsPerUserTask/briefMaxChars）。

const FALLBACK = {
  expertProvider: 'deepseek-official',
  expertModel: 'deepseek-v4-pro',
  expertMaxTokens: 8192,
  maxExpertsPerUserTask: 3,
  briefMaxChars: 12000,
}

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

function expertPersona(kind, reviewer) {
  const lines = reviewer
    ? [
      'You are a senior ADVERSARIAL REVIEWER (deepseek-v4-pro) engaged by a flash-model orchestrator to review material the orchestrator or another expert produced.',
      'Your job is to find what is wrong, missing, or risky. Be adversarial but precise: every criticism must cite the material under review; distinguish blocking issues (must fix) from suggestions (nice to have).',
      'Structure your report as: 裁定（通过 / 有条件通过 / 不通过）· 审查意见（按严重性分级）· 必须修改项清单。',
    ]
    : [
      'You are a senior expert subagent (deepseek-v4-pro) engaged by a flash-model orchestrator for ONE bounded cognitive task. You are the think tank; the orchestrator does all execution.',
      KIND_FOCUS[kind] ?? '',
    ]
  const common = [
    'Hard rules:',
    '1. THINK, do not gather: all needed context is in the brief. Read files or run bash only to verify a specific hypothesis, never to explore from scratch.',
    '2. Do not modify the workspace: never create, edit, or delete files; your bash runs must stay read-only or side-effect-free. All changes are applied by the orchestrator based on your report.',
    '3. Work solo: delegation and background-job tools are unavailable; do not attempt them.',
    '4. Budget discipline: output only what answers the question. No restating the brief, no filler, no exploratory writing.',
    '5. Structure your final report as: 结论 / 依据 / 风险与未决 / （如适用）建议的下一步。',
    '6. Final action: when the analysis is complete, call the report tool ONCE with the complete self-contained report text. Never finish the turn without reporting.',
  ]
  return [...lines, ...common].filter((line) => line !== '').join('\n')
}

function buildBrief(args, reviewer) {
  const head = reviewer
    ? `# 审查委派\n\n## 审查对象\n${args.subject}\n\n## 待审查材料\n${args.content}`
    : `# 专家简报 · ${KIND_LABEL[args.kind] ?? args.kind}\n\n## 目标（要回答的认知问题）\n${args.task}\n\n## 背景与现状\n${args.background}\n\n## 证据（主控已收集）\n${args.evidence}`
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
  parts.push('## 交付协议\n按「结论 / 依据 / 风险与未决」结构完成，最后调用 report 一次性提交完整报告。')
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
    }

    // 预算账本，按 agent 记账；新的人类消息进入 step 时清零（"用户任务"边界）。
    const ledgers = new Map()
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        const msgs = Array.isArray(payload?.messages) ? payload.messages : []
        const human = msgs.some((m) => m && (m.source?.kind === 'user' || (m.role === 'user' && !m.source)))
        if (human && payload?.agent && typeof payload.agent.id === 'string') ledgers.set(payload.agent.id, { used: 0 })
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

    async function spawnExpert(args, reviewer, exec) {
      const parent = exec.agent
      if (!parent) return rejectText('expert delegation requires a calling agent (exec.agent was undefined)')
      const kind = reviewer ? 'review' : args.kind
      const brief = buildBrief(args, reviewer)
      if (brief.length > settings.briefMaxChars) {
        return rejectText(`brief is ${brief.length} chars (limit ${settings.briefMaxChars}): curate background/evidence and keep only the facts the expert needs`)
      }
      const agentId = typeof parent.id === 'string' ? parent.id : String(parent.id)
      const ledger = ledgerOf(agentId)
      const cost = reviewer && args.stakes === 'high' ? 2 : 1
      if (ledger.used + cost > settings.maxExpertsPerUserTask) {
        return {
          status: 'budget-exhausted',
          budget: { used: ledger.used, limit: settings.maxExpertsPerUserTask, remaining: 0 },
          instruction: 'Expert budget for this user task is exhausted. Finish with your own best effort and tell the user the budget was hit; do not delegate again until the user sends a new message.',
        }
      }
      ledger.used += cost
      try {
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label: reviewer ? 'pro-expert:review' : `pro-expert:${kind}`,
          request: {
            prompt: [textBlock(brief)],
            parent,
            agentOptions: {
              provider: settings.expertProvider,
              model: settings.expertModel,
              maxTokens: settings.expertMaxTokens,
            },
            persona: expertPersona(kind, reviewer),
            toolFilter: { deny: DENY_TOOLS },
          },
          signal: exec.signal,
        })
        return {
          status: 'delegated',
          childId: started.childId,
          messageId: started.messageId,
          cost,
          budget: { used: ledger.used, limit: settings.maxExpertsPerUserTask, remaining: settings.maxExpertsPerUserTask - ledger.used },
          next: 'The expert will report asynchronously as "Background subagent <id> reported:". Verify the report against your acceptance checklist; at most one bounded follow-up via send_message.',
        }
      } catch (error) {
        ledger.used -= cost
        return { status: 'failed', error: String(error && error.message ? error.message : error) }
      }
    }

    const consult = {
      name: 'expert_consult',
      description: 'Delegate ONE bounded cognitive task to a pro-model expert (deepseek-v4-pro). This is the ONLY channel for deep-thinking work — planning, design, root-cause analysis, high-risk decisions — which you must never attempt yourself. The tool enforces the delegation protocol: a complete curated brief is mandatory, and a hard budget of 3 expert starts per user task applies (reset on each new user message; expert_review with stakes "high" costs 2).\n\nMANDATORY before calling: 1) gather evidence first (read files, run commands, search) — an empty evidence section is rejected; 2) task = exactly ONE cognitive question, not an operation; 3) acceptance = a mechanically verifiable checklist written BEFORE delegating; 4) curate context — oversized briefs are rejected, never dump whole files or the conversation.\n\nThe expert reports asynchronously ("Background subagent <id> reported:"), cannot write files, and cannot delegate. Verify the report against your acceptance checklist with tests/commands; at most one bounded follow-up via send_message. If the budget is exhausted the tool refuses — finish with your best effort and tell the user.',
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
        for (const field of ['task', 'background', 'evidence']) {
          const problem = validateStrings(args[field], field, 10, Math.floor(settings.briefMaxChars / 2))
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
      description: 'Ask a pro-model expert (deepseek-v4-pro) to ADVERSARIALLY REVIEW material — your own design, plan, diff, or another expert\'s output. Use this for the meta-cognition loop: high-risk or complex deliverables get checked by a stronger model before you ship them. Costs 1 budget slot, or 2 with stakes "high" (irreversible changes: schema, migration, security). The review report arrives asynchronously like expert_consult and must be verified the same way: read every blocking issue, apply the must-fix list, and only proceed once the verdict is 通过 (or the user overrides).',
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
        for (const field of ['subject', 'content']) {
          const problem = validateStrings(args[field], field, 10, settings.briefMaxChars)
          if (problem !== undefined) return rejectText(problem)
        }
        return spawnExpert(args, true, exec)
      },
    }

    ctx.tools.register(consult)
    ctx.tools.register(review)
  },
}
