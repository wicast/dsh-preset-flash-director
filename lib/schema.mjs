/**
 * dsh-flash-director-ui — 配置 schema / 校验 / 归一化（纯函数层）
 *
 * 与 expert-delegation.mjs 的键集合与默认值保持同源。9 个键全可选：
 * 覆盖文件是"部分覆盖"语义——未出现的键回退到基线/内置默认。
 *
 * expertReasoningEffort 无默认值：缺省 = 不注入（expert-delegation.mjs 里
 * 该键缺省时不注入思考强度）。因此它只能通过"键缺失"表达，官方表单清空它
 * 必须走 replace/移除键，不能写空字符串。
 */
export const OVERRIDE_KEYS = [
  'expertProvider',
  'expertModel',
  'expertMaxTokens',
  'maxExpertsPerUserTask',
  'briefMaxChars',
  'expertReuse',
  'reuseMaxFollowups',
  'followupRetryBudget',
  'expertReasoningEffort',
]

/** 基线 agent.cordis.yml 的 expert-delegation 行 config 块只含这 7 键。 */
export const BASELINE_KEYS = [
  'expertProvider',
  'expertModel',
  'expertMaxTokens',
  'maxExpertsPerUserTask',
  'briefMaxChars',
  'expertReuse',
  'reuseMaxFollowups',
]

/** 内置默认（与 expert-delegation.mjs 的 FALLBACK 同值；无 expertReasoningEffort）。 */
export const DEFAULTS = {
  expertProvider: 'deepseek-official',
  expertModel: 'deepseek-v4-pro',
  expertMaxTokens: 32768,
  maxExpertsPerUserTask: 3,
  briefMaxChars: 40000,
  expertReuse: 'session',
  reuseMaxFollowups: 8,
  followupRetryBudget: 2,
}

const EXPERT_REUSE = new Set(['session', 'off'])
const REASONING_EFFORT = new Set(['off', 'low', 'high', 'max'])

const RANGES = {
  expertMaxTokens: [1, 262144],
  maxExpertsPerUserTask: [1, 100],
  briefMaxChars: [1000, 1000000],
  reuseMaxFollowups: [1, 1000],
  followupRetryBudget: [1, 100],
}

/**
 * 9 键 schemastery schema（全键 .required(false)）。
 * - 枚举用 z.string().pattern()（schemastery 无 z.literal/enum）
 * - 整数用 z.number().step(1)（无 z.integer()）
 * - 不用 .default()：default 会污染 resolve 到合并层，破坏"缺失回 FALLBACK"语义。
 * 由调用方传入 z（保持纯函数可测，服务端从 '@deepseek-ai/schemastery' 注入）。
 */
export function buildSchema(z) {
  return z.object({
    expertProvider: z.string().required(false),
    expertModel: z.string().required(false),
    expertMaxTokens: z.number().step(1).min(RANGES.expertMaxTokens[0]).max(RANGES.expertMaxTokens[1]).required(false),
    maxExpertsPerUserTask: z.number().step(1).min(RANGES.maxExpertsPerUserTask[0]).max(RANGES.maxExpertsPerUserTask[1]).required(false),
    briefMaxChars: z.number().step(1).min(RANGES.briefMaxChars[0]).max(RANGES.briefMaxChars[1]).required(false),
    expertReuse: z.string().pattern(/^(session|off)$/).required(false),
    reuseMaxFollowups: z.number().step(1).min(RANGES.reuseMaxFollowups[0]).max(RANGES.reuseMaxFollowups[1]).required(false),
    followupRetryBudget: z.number().step(1).min(RANGES.followupRetryBudget[0]).max(RANGES.followupRetryBudget[1]).required(false),
    expertReasoningEffort: z.string().pattern(/^(off|low|high|max)$/).required(false),
  })
}

/** 单个键的值是否合法（服务端写覆盖文件前的类型/枚举/范围校验）。 */
export function isValidKeyValue(key, value) {
  switch (key) {
    case 'expertProvider':
    case 'expertModel':
      return typeof value === 'string' && value.trim() !== ''
    case 'expertMaxTokens':
    case 'maxExpertsPerUserTask':
    case 'briefMaxChars':
    case 'reuseMaxFollowups':
    case 'followupRetryBudget': {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return false
      const [min, max] = RANGES[key]
      return value >= min && value <= max
    }
    case 'expertReuse':
      return EXPERT_REUSE.has(value)
    case 'expertReasoningEffort':
      return REASONING_EFFORT.has(value)
    default:
      return false
  }
}

/**
 * 校验一个覆盖文件写请求的 values 对象。
 * @returns {{ ok: true, values: object } | { ok: false, errors: string[] }}
 */
export function validateOverrideValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, errors: ['values 必须是对象'] }
  }
  const errors = []
  const out = {}
  for (const key of Object.keys(values)) {
    if (!OVERRIDE_KEYS.includes(key)) {
      errors.push(`未知配置键: ${key}`)
      continue
    }
    const value = values[key]
    if (value === undefined || value === null || value === '') continue // 空 = 不覆盖
    if (!isValidKeyValue(key, value)) {
      errors.push(`键 ${key} 的值非法: ${JSON.stringify(value)}`)
      continue
    }
    out[key] = value
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out }
}

/**
 * 读取覆盖文件时的防御性归一化：只认已知键、只保留合法值，
 * 返回 { values, dropped }。坏 JSON/非对象由调用方捕获并记为 configError。
 */
export function normalizeOverride(raw) {
  const values = {}
  const dropped = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { values, dropped }
  }
  for (const key of Object.keys(raw)) {
    if (!OVERRIDE_KEYS.includes(key)) {
      dropped.push(key)
      continue
    }
    if (isValidKeyValue(key, raw[key])) values[key] = raw[key]
    else dropped.push(key)
  }
  return { values, dropped }
}

/** 生效值合并：override > baseline > DEFAULTS（expertReasoningEffort 无默认则缺省）。 */
export function mergeEffective(baselineValues, overrideValues) {
  const effective = {}
  const source = {}
  for (const key of OVERRIDE_KEYS) {
    if (overrideValues && key in overrideValues) {
      effective[key] = overrideValues[key]
      source[key] = 'override'
    } else if (baselineValues && key in baselineValues) {
      effective[key] = baselineValues[key]
      source[key] = 'baseline'
    } else if (key in DEFAULTS) {
      effective[key] = DEFAULTS[key]
      source[key] = 'default'
    } else {
      source[key] = 'default' // expertReasoningEffort：缺省
    }
  }
  return { effective, source }
}
