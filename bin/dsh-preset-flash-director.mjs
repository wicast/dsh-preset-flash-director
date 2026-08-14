#!/usr/bin/env node
// dsh-preset-flash-director — zero-dependency installer for the
// "Flash 主控 · Pro 专家" DeepSeek Harness agent preset.
//
// Commands:
//   install    copy the bundled preset into $DSH_HOME/.agent-presets/flash-director
//   uninstall  remove the installed preset (keeps a timestamped backup)
//   info       print where the preset lives and whether it is installed
//   --version  print the package version

import { cp, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_SOURCE = join(ROOT, 'flash-director')
const PRESET_ID = 'flash-director'

function dshHome() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
}

function presetTarget() {
  return join(dshHome(), '.agent-presets', PRESET_ID)
}

async function dirExists(p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

function usage() {
  return [
    'dsh-preset-flash-director — install the "Flash 主控 · Pro 专家" DSH preset',
    '',
    'usage: dsh-preset-flash-director <install|uninstall|info>',
    '       dsh-preset-flash-director --version',
    '',
    '  install      copy the preset into $DSH_HOME/.agent-presets/flash-director',
    '               (DSH_HOME defaults to ~/.dsh; an existing copy is backed up)',
    '  uninstall    remove the installed preset, keeping a .bak-<ts> backup',
    '  info         print preset source/target paths and install state',
  ].join('\n')
}

async function cmdInstall() {
  const target = presetTarget()
  if (!(await dirExists(PRESET_SOURCE))) {
    throw new Error(`preset source missing inside the package: ${PRESET_SOURCE}`)
  }
  await mkdir(join(target, '..'), { recursive: true })
  if (await dirExists(target)) {
    const backup = `${target}.bak-${Date.now()}`
    await rename(target, backup)
    console.log(`existing preset backed up to ${backup}`)
  }
  await cp(PRESET_SOURCE, target, { recursive: true })
  console.log(`installed preset -> ${target}`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. open the DeepSeek Harness web UI and start a new session')
  console.log('  2. pick the "Flash 主控 · Pro 专家" preset')
  console.log('  3. switch the session model to deepseek-v4-flash')
  console.log('  4. confirm expert_consult / expert_review show up in the tool list')
}

async function cmdUninstall() {
  const target = presetTarget()
  if (!(await dirExists(target))) {
    console.log(`nothing to remove: ${target}`)
    return
  }
  const backup = `${target}.bak-${Date.now()}`
  await rename(target, backup)
  console.log(`preset removed; backup kept at ${backup} (delete it once you are sure)`)
}

async function cmdInfo() {
  console.log(`DSH_HOME            : ${dshHome()}`)
  console.log(`preset source (pkg) : ${PRESET_SOURCE}`)
  console.log(`preset target       : ${presetTarget()}`)
  console.log(`installed           : ${await dirExists(presetTarget())}`)
}

const [cmd] = process.argv.slice(2)

try {
  if (cmd === '--version' || cmd === 'version') {
    console.log(process.env.npm_package_version || '0.1.0')
  } else if (cmd === 'install') {
    await cmdInstall()
  } else if (cmd === 'uninstall') {
    await cmdUninstall()
  } else if (cmd === 'info') {
    await cmdInfo()
  } else {
    console.log(usage())
    process.exitCode = 1
  }
} catch (error) {
  console.error(`error: ${error && error.message ? error.message : String(error)}`)
  process.exitCode = 1
}
