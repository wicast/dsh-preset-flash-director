/**
 * dsh-flash-director-ui — 服务端半
 *
 * Flash 主控 · Pro 专家 预设的配置界面：
 *   1. 登记 settings 命名空间 `flash-director` + schemastery schema —— DSH 官方
 *      "插件配置"页据此渲染表单（复用 DSH 配置界面）。
 *   2. scope.watch 单向镜像：官方表单提交（经宿主 file provider 写入
 *      $DSH_HOME/settings.yaml 的 user 层）→ 写覆盖文件 expert-delegation.config.json。
 *      方向天然单向（覆盖文件走 HTTP 端点直写，不经 settings provider，无循环）。
 *   3. webServer HTTP 端点：读写覆盖文件 + 行级 patch 基线 agent.cordis.yml。
 *
 * 语义对齐 expert-delegation.mjs：
 *   - 覆盖文件 = 部分覆盖（未出现的键回退基线/默认），下次委派按 mtime 热加载生效
 *   - 基线 = agent.cordis.yml 的 expert-delegation 行 config 块（7 键），新开会话生效
 * 零新增依赖：js-yaml / @deepseek-ai/{dsh-settings,schemastery,cordis} 由 Desktop
 * 运行时从 app.asar.unpacked 的 node_modules 解析。
 */
import { readFile, writeFile, rename, copyFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import yaml from 'js-yaml'

import * as paths from './paths.mjs'
import { patchCordisBaseline, readBaselineConfig } from './cordis-patch.mjs'
import {
  buildSchema,
  validateOverrideValues,
  normalizeOverride,
  mergeEffective,
  OVERRIDE_KEYS,
} from './schema.mjs'

export const name = 'dsh-flash-director-ui'
export const inject = ['webServer']

const NS = settingsNamespace('flash-director')

// ===== 工具函数 =====

function writeJson(res, code, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 65536) {
        rejectBody(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        rejectBody(e)
      }
    })
    req.on('error', rejectBody)
  })
}

// 同源校验（复刻 perm-guard）：恶意网页无法关守卫/改配置
function isSameOrigin(req) {
  const origin = req.headers.origin || ''
  if (origin !== '') return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  const host = req.headers.host || ''
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
}

// 原子写：先写临时文件再 rename，避免覆盖文件半写被 expert-delegation.mjs 的 mtime 热重载读到坏 JSON
async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content)
  await rename(tmp, filePath)
}

async function readJsonFile(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    return { exists: true, raw }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, raw: null }
    return { exists: true, raw: null, error: `invalid JSON: ${e && e.message ? e.message : String(e)}` }
  }
}

// 读覆盖文件：防御性归一化 + configError
async function readOverride() {
  const p = paths.overridePath()
  if (!p) return { path: null, exists: false, values: null, configError: '未找到活动 preset 目录' }
  const { exists, raw, error } = await readJsonFile(p)
  if (!exists) return { path: p, exists: false, values: null, configError: null }
  if (error) return { path: p, exists: true, values: null, configError: error }
  const { values, dropped } = normalizeOverride(raw)
  return {
    path: p,
    exists: true,
    values,
    configError: dropped.length > 0 ? `忽略未知/非法键: ${dropped.join(', ')}` : null,
  }
}

// 读基线：行级扫描（不解析全文，天然兼容 !!js 标签）
async function readBaseline() {
  const p = paths.baselinePath()
  if (!p) return { path: null, exists: false, values: null, configError: '未找到活动 preset 目录' }
  try {
    const text = await readFile(p, 'utf8')
    const r = readBaselineConfig(text)
    return { path: p, exists: true, values: r.ok ? r.values : null, configError: r.ok ? null : r.error }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { path: p, exists: false, values: null, configError: null }
    return { path: p, exists: true, values: null, configError: `read failed: ${e && e.message ? e.message : String(e)}` }
  }
}

// ===== 宽容 YAML 校验（处理 agent.cordis.yml 的 !!js 标签）=====
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: String(data).trim() }),
})
const PERMISSIVE_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TAG])

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

// 写后校验：patch 后的文本必须能宽容解析，且 expert-delegation 行 config 仍是对象
function validateBaselineText(text) {
  const doc = yaml.load(text, { schema: PERMISSIVE_SCHEMA })
  const row = findById(doc, 'expert-delegation')
  if (!row || !row.config || typeof row.config !== 'object' || Array.isArray(row.config)) {
    throw new Error('patch 后 expert-delegation 行 config 块缺失或损坏')
  }
  return row.config
}

// ===== 官方表单 → 覆盖文件 单向镜像 =====
// 只镜像 settings user 层显式携带的键（resolve 值无默认/base 时 = user 层），
// 保留覆盖文件中的未知键；prev→next 消失的键视为"官方表单移除"从覆盖文件删除。
async function mirrorToOverride(overridePath, next, prev) {
  if (!overridePath) return
  try {
    const existing = await readFile(overridePath, 'utf8')
      .then((t) => {
        const parsed = JSON.parse(t)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      })
      .catch(() => ({}))
    const merged = { ...existing }
    for (const k of Object.keys(next || {})) {
      if (OVERRIDE_KEYS.includes(k) && next[k] !== undefined && next[k] !== null && next[k] !== '') {
        merged[k] = next[k]
      }
    }
    for (const k of Object.keys(prev || {})) {
      if (OVERRIDE_KEYS.includes(k) && !(k in (next || {}))) delete merged[k]
    }
    if (Object.keys(merged).length === 0) {
      await unlink(overridePath).catch(() => {})
    } else {
      await atomicWrite(overridePath, `${JSON.stringify(merged, null, 2)}\n`)
    }
    console.log(`[flash-director-ui] official form committed; mirrored ${Object.keys(next || {}).length} key(s) to override file`)
  } catch (e) {
    console.warn(`[flash-director-ui] mirror to override failed: ${e && e.message ? e.message : String(e)}`)
  }
}

// ===== HTTP 端点 =====

async function stateHandler(req, res, llm) {
  if (!isSameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
  try {
    const override = await readOverride()
    const baseline = await readBaseline()
    const { effective, source } = mergeEffective(
      baseline.values || {},
      override.values || {},
    )
    const catalog = await buildProviders(llm)
    return writeJson(res, 200, {
      ok: true,
      dshHome: paths.dshHome(),
      presetDir: paths.presetDir(),
      overridePath: override.path,
      baselinePath: baseline.path,
      env: {
        FLASH_DIRECTOR_CONFIG: process.env.FLASH_DIRECTOR_CONFIG || null,
        FLASH_DIRECTOR_PRESET_DIR: process.env.FLASH_DIRECTOR_PRESET_DIR || null,
      },
      override,
      baseline,
      effective,
      source,
      providers: catalog.providers,
      providersAvailable: catalog.available,
      providerFailures: catalog.failures,
    })
  } catch (e) {
    return writeJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
  }
}

async function overrideHandler(req, res) {
  if (!isSameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
  try {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const values = body && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {}
    const p = paths.overridePath()
    if (!p) return writeJson(res, 500, { ok: false, error: '未找到活动 preset 目录' })

    // 空对象 = 移除覆盖文件（恢复基线）
    if (Object.keys(values).length === 0) {
      await unlink(p).catch((e) => {
        if (!e || e.code !== 'ENOENT') throw e
      })
      const override = await readOverride()
      const baseline = await readBaseline()
      const { effective } = mergeEffective(baseline.values || {}, override.values || {})
      return writeJson(res, 200, { ok: true, removed: true, effective })
    }

    const check = validateOverrideValues(values)
    if (!check.ok) return writeJson(res, 400, { ok: false, error: check.errors.join('; ') })
    // 写 = 已知键整体替换（表单里清空的键 = 从覆盖文件移除、回退基线），
    // 未知键保留（防御未来键）。与镜像逻辑（prev→next 消失的键删除）保持一致。
    const existing = await readFile(p, 'utf8').then((t) => (JSON.parse(t) || {}), () => ({}))
    const merged = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}) }
    for (const k of OVERRIDE_KEYS) delete merged[k]
    for (const k of Object.keys(check.values)) merged[k] = check.values[k]
    await atomicWrite(p, `${JSON.stringify(merged, null, 2)}\n`)

    const override = await readOverride()
    const baseline = await readBaseline()
    const { effective } = mergeEffective(baseline.values || {}, override.values || {})
    return writeJson(res, 200, { ok: true, saved: true, effective })
  } catch (e) {
    return writeJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
  }
}

async function baselineHandler(req, res) {
  if (!isSameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
  try {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const patch = body && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {}
    const p = paths.baselinePath()
    if (!p) return writeJson(res, 500, { ok: false, error: '未找到活动 preset 目录' })
    if (!existsSync(p)) return writeJson(res, 404, { ok: false, error: `基线文件不存在: ${p}` })

    const text = await readFile(p, 'utf8')
    const r = patchCordisBaseline(text, patch)
    if (!r.ok) return writeJson(res, 409, { ok: false, error: r.error })

    // 写前备份（保留最近 5 份轮转）
    const backupPath = `${p}.bak-${Date.now()}`
    await copyFile(p, backupPath)
    await atomicWrite(p, r.text)

    // 写后宽容 YAML 校验；失败回滚 + 报 409（不落盘坏文件）
    try {
      validateBaselineText(r.text)
    } catch (e) {
      await copyFile(backupPath, p).catch(() => {})
      return writeJson(res, 409, {
        ok: false,
        error: `YAML 校验失败，已回滚: ${e && e.message ? e.message : String(e)}`,
        backupPath,
      })
    }
    const baseline = await readBaseline()
    return writeJson(res, 200, {
      ok: true,
      saved: true,
      changed: r.changed,
      backupPath,
      requiresNewSession: true,
      baseline,
    })
  } catch (e) {
    return writeJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
  }
}

// 从 llm 服务构建 provider/model 目录（与 DSH 模型选择器同源：listProviders + listModels）
// 单个 provider 失败不拖垮整体；llm 服务缺失 → 返回空目录，客户端回退文本输入。
async function buildProviders(llm) {
  if (!llm || typeof llm.listProviders !== 'function') return { available: false, providers: [], failures: [] }
  const providers = []
  const failures = []
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      providers.push({
        id: provider.id,
        name: provider.name || provider.id,
        models: (models || []).map((m) => ({ id: m.id, name: m.name || m.id })),
      })
    } catch (e) {
      failures.push({ id: provider.id, message: e && e.message ? e.message : String(e) })
    }
  }
  return { available: true, providers, failures }
}

// ===== 插件主体 =====
export function apply(ctx) {
  // 登记 settings 命名空间（官方"插件配置"页渲染表单）+ 单向镜像
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(NS, buildSchema(z))
      scope.watch((next, prev) => {
        // watch 回调异常由 dsh-settings warnWatcherFailure 捕获，不打断提交
        mirrorToOverride(paths.overridePath(), next, prev)
      })
    } catch (e) {
      console.warn(`[flash-director-ui] settings registration failed: ${e && e.message ? e.message : String(e)}`)
    }
  })

  const webServer = ctx.get('webServer')
  if (!webServer) return
  // llm 服务可选：缺失时客户端回退文本输入
  const llm = ctx.get('llm')
  webServer.register({
    kind: 'exact',
    path: '/api/flash-director/state',
    handler: (req, res) => stateHandler(req, res, llm),
  })
  webServer.register({ kind: 'exact', path: '/api/flash-director/override', handler: overrideHandler })
  webServer.register({ kind: 'exact', path: '/api/flash-director/baseline', handler: baselineHandler })
}
