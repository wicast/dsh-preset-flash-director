/**
 * dsh-preset-flash-director — 预设自动同步单测
 * 运行：node --test ui/test/preset-sync.test.mjs
 *
 * 覆盖：install / adopt（不覆盖手动内容）/ noop（版本+哈希一致）/ 不降级 /
 * update（备份+保留 config.json）/ 内容哈希漂移触发 update /
 * B1 更新失败回滚（不留残缺、不固化）/ B2 用户改过基线不被静默覆盖 /
 * 旧裸字符串标记迁移 / compareVersions（含 beta 已知偏差）。
 * 用临时 DSH_HOME 隔离目标；源 = 插件内打包的 ui/flash-director（真实内容）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncPreset, compareVersions, sha256, bundleHash } from '../lib/preset-sync.mjs'

const TARGET = '.agent-presets'
const CONFIG = 'expert-delegation.config.json'
const BASELINE = 'agent.cordis.yml'
const MARKER = '.flash-director-ui-version'

let home = null
let backupEnv = {}

test.before(() => {
  home = mkdtempSync(join(tmpdir(), 'fd-sync-test-'))
  backupEnv = { DSH_HOME: process.env.DSH_HOME, FLASH_DIRECTOR_PRESET_DIR: process.env.FLASH_DIRECTOR_PRESET_DIR }
  process.env.DSH_HOME = home
  delete process.env.FLASH_DIRECTOR_PRESET_DIR
})

test.after(() => {
  for (const [k, v] of Object.entries(backupEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

const target = () => join(home, TARGET, 'flash-director')
const markerOf = () => JSON.parse(readFileSync(join(target(), MARKER), 'utf8'))

test('compareVersions（含 beta 已知偏差）', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.9.0'), 1)
  assert.equal(compareVersions('', '0.1.0'), -1)
  // 已知偏差（非语义化 parseInt）：beta 段被解析为 0 → 被判 > 正式版；流程不用预发版，接受
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), 1)
})

test('install：目标缺失 → 全量拷贝 + JSON 标记(v/h/b)', async () => {
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'install')
  assert.equal(r.target, target())
  assert.ok(existsSync(join(target(), BASELINE)))
  assert.ok(existsSync(join(target(), 'expert-delegation.mjs')))
  assert.ok(existsSync(join(target(), 'preset.yml')))
  assert.ok(existsSync(join(target(), 'expert-delegation.config.example.json')))
  assert.ok(!existsSync(join(target(), CONFIG)), '用户运行期配置不应被安装')
  const m = markerOf()
  assert.equal(m.v, '0.2.0')
  assert.equal(m.h, await bundleHash(), '标记哈希应与打包内容一致')
  assert.ok(m.b, '应有基线指纹')
})

test('noop：标记(v+h) == 插件版本 → 不动', async () => {
  const before = readFileSync(join(target(), BASELINE), 'utf8')
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'noop')
  assert.equal(readFileSync(join(target(), BASELINE), 'utf8'), before)
})

test('update：版本升级 → 备份 + 更新代码文件 + 保留 config.json + 新标记', async () => {
  // 模拟：用户有运行期配置 + 旧标记
  writeFileSync(join(target(), CONFIG), '{"expertModel":"my-model"}\n')
  writeFileSync(join(target(), MARKER), JSON.stringify({ v: '0.1.0', h: 'old-h', b: sha256(readFileSync(join(target(), BASELINE), 'utf8')) }))
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'update')
  assert.ok(r.backup && existsSync(r.backup), '应有备份目录')
  assert.equal(readFileSync(join(target(), CONFIG), 'utf8').trim(), '{"expertModel":"my-model"}', '用户配置被保留')
  const m = markerOf()
  assert.equal(m.v, '0.2.0')
  assert.equal(m.h, await bundleHash())
})

test('B1：更新失败回滚 → 目标保持原状、不留残缺/不固化', async () => {
  const beforeBaseline = readFileSync(join(target(), BASELINE), 'utf8')
  const beforeMarker = markerOf()
  // 触发更新条件，但注入换入前故障
  await assert.rejects(
    syncPreset({ pluginVersion: '0.3.0', _fault: async () => { throw new Error('boom') } }),
    /boom/,
  )
  // 目标仍在且内容未变（回滚成功）
  assert.ok(existsSync(target()), '目标目录应回滚存在')
  assert.equal(readFileSync(join(target(), BASELINE), 'utf8'), beforeBaseline, '基线未被半写')
  assert.deepEqual(markerOf(), beforeMarker, '标记未被半写')
  // 无 .new/.bak 残留
  const siblings = readdirSync(join(home, TARGET))
  assert.ok(!siblings.some((s) => s.includes('.new-')), '不应有 .new 残留: ' + siblings.join(','))
})

test('B2：用户改过基线 → 更新保留用户基线 + 新版旁侧 + 警告', async () => {
  // 让插件先正常装一遍 0.2.0（基线=打包基线）
  await syncPreset({ pluginVersion: '0.2.0' })
  const installedBaseline = readFileSync(join(target(), BASELINE), 'utf8')
  // 用户经 UI 基线编辑器改过
  const userBaseline = installedBaseline + '\n# user edit\n'
  writeFileSync(join(target(), BASELINE), userBaseline)
  // 标记里的 b 仍是最初安装时的基线指纹
  const m0 = markerOf()
  assert.notEqual(sha256(userBaseline), m0.b, '前置：用户基线应≠安装指纹')

  const r = await syncPreset({ pluginVersion: '0.3.0' })
  assert.equal(r.action, 'update')
  assert.equal(r.preservedUserBaseline, true)
  // 用户基线被保留（未覆盖）
  assert.equal(readFileSync(join(target(), BASELINE), 'utf8'), userBaseline)
  // 新版基线旁侧存在
  const side = readdirSync(target()).find((s) => s.startsWith('agent.cordis.yml.bundled-'))
  assert.ok(side, '应有旁侧新版基线文件')
  // 新标记的 b = 用户基线的哈希（下次以此为准）
  assert.equal(markerOf().b, sha256(userBaseline))
})

test('内容哈希漂移（改内容没 bump 版本）→ 触发 update', async () => {
  // 显式设定：v 相同但 h 与打包真实哈希不同 → 应触发 update 并拉回真实哈希
  const realHash = await bundleHash()
  writeFileSync(join(target(), MARKER), JSON.stringify({ v: '0.2.0', h: 'drifted-hash', b: 'x' }))
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'update')
  assert.equal(markerOf().h, realHash, '哈希应被拉回打包真实值')
})

test('不降级（标记版本 > 插件版本）', async () => {
  await syncPreset({ pluginVersion: '0.2.0' })
  writeFileSync(join(target(), MARKER), JSON.stringify({ v: '9.9.9', h: await bundleHash(), b: 'x' }))
  const before = readFileSync(join(target(), BASELINE), 'utf8')
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'noop')
  assert.match(r.reason || '', /9\.9\.9/)
  assert.equal(readFileSync(join(target(), BASELINE), 'utf8'), before)
})

test('adopt：目标存在但无标记（cp -r 手动安装）→ 只写标记不覆盖', async () => {
  // 构造"手动安装"：去掉标记 + 用户自改基线
  rmSync(join(target(), MARKER), { force: true })
  writeFileSync(join(target(), BASELINE), '# manually installed baseline\n')
  writeFileSync(join(target(), CONFIG), '{"expertModel":"manual"}\n')
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'adopt')
  assert.ok(readFileSync(join(target(), BASELINE), 'utf8').includes('manually installed'), '不覆盖手动内容')
  assert.equal(readFileSync(join(target(), CONFIG), 'utf8').trim(), '{"expertModel":"manual"}')
  const m = markerOf()
  assert.equal(m.v, '0.2.0')
  assert.equal(m.b, sha256('# manually installed baseline\n'), '收养后基线指纹=现有内容')
})

test('旧裸字符串标记迁移：v 匹配 → 刷新为 JSON，不动内容', async () => {
  await syncPreset({ pluginVersion: '0.2.0' })
  writeFileSync(join(target(), MARKER), '0.2.0') // 旧格式
  const before = readFileSync(join(target(), BASELINE), 'utf8')
  const r = await syncPreset({ pluginVersion: '0.2.0' })
  assert.equal(r.action, 'noop')
  assert.match(r.reason || '', /legacy marker refreshed/)
  const m = markerOf()
  assert.equal(m.v, '0.2.0')
  assert.equal(m.h, await bundleHash())
  assert.equal(readFileSync(join(target(), BASELINE), 'utf8'), before, '迁移不动内容')
})

test('skip：pluginVersion 未知 → 不动作', async () => {
  const r = await syncPreset({})
  assert.equal(r.action, 'skip')
})
