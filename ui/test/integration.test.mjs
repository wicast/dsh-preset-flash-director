/**
 * dsh-flash-director-ui — 服务端半集成测试（mock webServer + settings，真实文件）
 * 运行：node --test ui/test/integration.test.mjs
 *
 * 用临时 preset 目录（含真实 agent.cordis.yml 副本）验证：
 *   GET /state 路径与生效值合并
 *   POST /override 写覆盖文件 / 空对象移除
 *   POST /baseline 行级 patch + 备份 + 宽容 YAML 校验 + 409 回滚
 *   同源校验 403
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'flash-director')

function makeReq(method, body, extraHeaders) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const events = {}
  const req = {
    method,
    headers: { host: '127.0.0.1:43189', ...(extraHeaders || {}) },
    on(ev, cb) {
      (events[ev] ||= []).push(cb)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (buf.length) for (const cb of events.data || []) cb(buf)
    for (const cb of events.end || []) cb()
  })
  return req
}

function makeMockCtx(llm) {
  const handlers = {}
  const settingsRegistrations = []
  const webServer = { register: (spec) => { handlers[spec.path] = spec.handler } }
  const settings = {
    register: (ns, schema) => {
      const reg = { ns, schema, watchers: [] }
      settingsRegistrations.push(reg)
      return {
        get: () => ({}),
        watch: (cb) => {
          reg.watchers.push(cb)
          return () => {}
        },
        update: async () => {},
        replace: async () => {},
      }
    },
    describe: () => [],
  }
  const ctx = {
    get: (k) => (k === 'webServer' ? webServer : k === 'llm' ? llm : undefined),
    inject: (deps, cb) => {
      if (deps.includes('settings')) cb({ settings })
    },
  }
  return { ctx, handlers, settingsRegistrations }
}

async function invoke(handler, method, body, extraHeaders) {
  let status = 0
  let payload = null
  const res = {
    writeHead: (code) => { status = code },
    end: (t) => { payload = JSON.parse(t) },
  }
  await handler(makeReq(method, body, extraHeaders), res)
  return { status, payload }
}

let presetDir = null
let backupEnv = {}

test.before(() => {
  presetDir = mkdtempSync(join(tmpdir(), 'fd-ui-test-'))
  copyFileSync(join(REPO_DIR, 'agent.cordis.yml'), join(presetDir, 'agent.cordis.yml'))
  backupEnv = {
    FLASH_DIRECTOR_PRESET_DIR: process.env.FLASH_DIRECTOR_PRESET_DIR,
    FLASH_DIRECTOR_CONFIG: process.env.FLASH_DIRECTOR_CONFIG,
  }
  process.env.FLASH_DIRECTOR_PRESET_DIR = presetDir
  delete process.env.FLASH_DIRECTOR_CONFIG
})

test.after(() => {
  for (const [k, v] of Object.entries(backupEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(presetDir, { recursive: true, force: true })
})

const { ctx, handlers, settingsRegistrations } = makeMockCtx()
apply(ctx)

test('GET /state：无覆盖文件时 effective 来自基线/默认', async () => {
  const { status, payload } = await invoke(handlers['/api/flash-director/state'], 'GET')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.presetDir, presetDir)
  assert.equal(payload.override.exists, false)
  assert.equal(payload.baseline.exists, true)
  assert.equal(payload.baseline.values.expertProvider, 'deepseek-official')
  assert.equal(payload.effective.expertProvider, 'deepseek-official')
  assert.equal(payload.source.expertProvider, 'baseline')
  // expertReasoningEffort 缺省（无默认）
  assert.equal('expertReasoningEffort' in payload.effective, false)
})

test('POST /override：写入覆盖文件并反映到 effective', async () => {
  const { status, payload } = await invoke(handlers['/api/flash-director/override'], 'POST', { values: { expertModel: 'x-test' } })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.saved, true)
  assert.equal(payload.effective.expertModel, 'x-test')
  assert.equal(payload.effective.expertProvider, 'deepseek-official') // 未覆盖 → 基线

  const state = await invoke(handlers['/api/flash-director/state'], 'GET')
  assert.equal(state.payload.override.exists, true)
  assert.equal(state.payload.override.values.expertModel, 'x-test')
  assert.equal(state.payload.source.expertModel, 'override')
  // 磁盘上确实写了
  const onDisk = JSON.parse(readFileSync(join(presetDir, 'expert-delegation.config.json'), 'utf8'))
  assert.equal(onDisk.expertModel, 'x-test')
})

test('POST /override 非法值被 400 拒绝', async () => {
  const { status, payload } = await invoke(handlers['/api/flash-director/override'], 'POST', { values: { expertReuse: 'always' } })
  assert.equal(status, 400)
  assert.match(payload.error, /expertReuse/)
})

test('POST /override 已知键整体替换：清空某键即从覆盖文件移除', async () => {
  // 先写两个键
  await invoke(handlers['/api/flash-director/override'], 'POST', { values: { expertModel: 'a', expertMaxTokens: 12345 } })
  // 只提交一个键 → 另一个应从覆盖文件移除（回退基线）
  const { status } = await invoke(handlers['/api/flash-director/override'], 'POST', { values: { expertModel: 'b' } })
  assert.equal(status, 200)
  const onDisk = JSON.parse(readFileSync(join(presetDir, 'expert-delegation.config.json'), 'utf8'))
  assert.equal(onDisk.expertModel, 'b')
  assert.equal('expertMaxTokens' in onDisk, false)
  const state = await invoke(handlers['/api/flash-director/state'], 'GET')
  assert.equal(state.payload.effective.expertMaxTokens, 32768) // 回退基线（基线有 32768）
  assert.equal(state.payload.source.expertMaxTokens, 'baseline')
})

test('POST /override 空对象移除覆盖文件', async () => {
  const { status } = await invoke(handlers['/api/flash-director/override'], 'POST', { values: {} })
  assert.equal(status, 200)
  assert.equal(existsSync(join(presetDir, 'expert-delegation.config.json')), false)
})

test('POST /baseline：行级 patch + 备份 + 生效', async () => {
  const { status, payload } = await invoke(handlers['/api/flash-director/baseline'], 'POST', { patch: { expertModel: 'y-baseline', expertMaxTokens: 65536 } })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.changed, ['expertModel', 'expertMaxTokens'])
  assert.equal(payload.requiresNewSession, true)
  assert.ok(payload.backupPath)
  // 备份存在
  assert.ok(existsSync(payload.backupPath))
  // 生效：基线读取反映新值
  assert.equal(payload.baseline.values.expertModel, 'y-baseline')
  // 其余内容逐字保留（persona 注释 + !!js 标签）
  const text = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  assert.match(text, /disabled: !!js process\.platform === 'win32'/)
  assert.match(text, /# The `flash-director` agent preset/)
  assert.match(text, /expertProvider: deepseek-official/)
})

test('POST /baseline 未知键 409 且文件不变', async () => {
  const before = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  const { status, payload } = await invoke(handlers['/api/flash-director/baseline'], 'POST', { patch: { bogus: 1 } })
  assert.equal(status, 409)
  assert.match(payload.error, /未知基线键/)
  assert.equal(readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8'), before)
})

test('跨源请求被 403 拒绝', async () => {
  const { status } = await invoke(handlers['/api/flash-director/override'], 'POST', { values: { expertModel: 'x' } }, { origin: 'http://evil.example.com' })
  assert.equal(status, 403)
})

test('settings 命名空间已注册为 flash-director', () => {
  assert.equal(settingsRegistrations.length, 1)
  assert.equal(String(settingsRegistrations[0].ns), 'flash-director')
})

test('GET /state：llm 服务可用时返回 provider/model 目录（与模型选择器同源）', async () => {
  const llm = {
    listProviders: () => [
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'scnet', name: 'SCNet' },
    ],
    listModels: async (id) => (id === 'opencode-go'
      ? [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
      : [{ id: 'DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash 0731' }]),
  }
  const c = makeMockCtx(llm)
  apply(c.ctx)
  const { status, payload } = await invoke(c.handlers['/api/flash-director/state'], 'GET')
  assert.equal(status, 200)
  assert.equal(payload.providersAvailable, true)
  assert.equal(payload.providers.length, 2)
  assert.equal(payload.providers[0].id, 'opencode-go')
  assert.equal(payload.providers[0].models.length, 2)
  assert.equal(payload.providers[1].models[0].id, 'DeepSeek-V4-Flash-0731')
})

test('GET /state：llm 服务缺失时 providersAvailable=false（客户端回退文本输入）', async () => {
  const c = makeMockCtx(undefined)
  apply(c.ctx)
  const { status, payload } = await invoke(c.handlers['/api/flash-director/state'], 'GET')
  assert.equal(status, 200)
  assert.equal(payload.providersAvailable, false)
  assert.deepEqual(payload.providers, [])
})
