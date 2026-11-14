#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readVersion } = require('../frontend/scripts/app-version.cjs')

const ROOT = path.resolve(__dirname, '..')
const SYSTEMS = [
  { key: 'windows', label: 'Windows', flag: '--win', package: 'win', format: 'zip', suffix: 'portable.zip', defaultArch: 'x64' },
  { key: 'linux', label: 'Linux', flag: '--linux', package: 'linux', format: 'AppImage', suffix: 'portable.AppImage', defaultArch: 'x64' },
  { key: 'macos', label: 'macOS', flag: '--mac', package: 'mac', format: 'zip', suffix: 'app.zip' },
]

function parseArguments(args) {
  const options = { dryRun: false, arch: undefined, help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--arch') options.arch = args[++i]
    else if (arg.startsWith('--arch=')) options.arch = arg.slice(7)
    else throw new Error('Unknown option: ' + arg)
    if ((arg === '--arch' || arg.startsWith('--arch=')) && !['x64', 'arm64'].includes(options.arch)) throw new Error('--arch must be x64 or arm64')
  }
  return options
}

async function askTargets(nextLine, write) {
  const selected = []
  for (const system of SYSTEMS) {
    write(`Build ${system.label}? [Y/n] `)
    const answer = await nextLine()
    if (answer == null) throw new Error('Input ended before all three answers; nothing was built')
    if (answer.trim().toLowerCase() !== 'n') selected.push(system.key)
  }
  return selected
}

function createPlan({ root = ROOT, selected, arch, host = process.platform, hostArch = process.arch }) {
  const frontend = path.join(root, 'frontend'), desktop = path.join(frontend, 'desktop')
  const version = readVersion(frontend)
  const metadata = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
  const product = metadata.build.productName
  if (typeof product !== 'string' || !product.trim()) throw new Error('Desktop productName is missing')
  const slug = product.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!slug) throw new Error('Desktop productName cannot form a safe artifact name')
  const versionDirectory = path.join(root, 'bin', 'v' + version)
  const targets = SYSTEMS.filter(system => selected.includes(system.key)).map(system => {
    const targetArch = arch ?? system.defaultArch ?? hostArch
    if (!['x64', 'arm64'].includes(targetArch)) throw new Error('Unsupported architecture: ' + targetArch)
    return { ...system, arch: targetArch, directory: path.join(versionDirectory, system.key + '-' + targetArch), filename: `${slug}-v${version}-${system.key}-${targetArch}-${system.suffix}` }
  })
  const limitations = []
  if (!['darwin', 'linux', 'win32'].includes(host) && targets.length) limitations.push('This build host is unsupported: ' + host)
  if (host !== 'darwin' && targets.some(target => target.key === 'macos')) limitations.push('macOS requires a macOS build host; answer n for macOS on this machine')
  if (host === 'win32' && targets.some(target => target.key === 'linux')) limitations.push('Linux AppImage requires Linux or macOS here; run this script in WSL/Linux instead')
  return { root, frontend, desktop, version, product, versionDirectory, targets, limitations, host, metadata }
}

async function checkOutputs(plan) {
  for (const file of [path.join(plan.root, 'bin'), plan.versionDirectory, ...plan.targets.map(target => target.directory)]) {
    const stat = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error('Build output must not be a symlink: ' + file)
    if (stat && !stat.isDirectory()) throw new Error('Build output is not a directory: ' + file)
    if (stat && plan.targets.some(target => target.directory === file)) throw new Error('Target already exists; previous artifacts were preserved: ' + file)
  }
}

function printPlan(plan, write) {
  write(`\n${plan.product} v${plan.version}; host ${plan.host}\n`)
  for (const target of plan.targets) write(`  ${target.label} ${target.arch}: ${path.join(target.directory, target.filename)}\n`)
  if (plan.targets.length) write('Steps: npm ci (frontend and desktop), generator checks, fresh desktop renderer, packaging with --publish never, embedded renderer/storage verification.\n')
  write('Cross-built files do not prove execution on the target OS; signing/toolchain failures are fatal.\n')
  for (const limitation of plan.limitations) write('BLOCKED: ' + limitation + '\n')
}

function execute(step) {
  const result = spawnSync(step.command, step.args, { cwd: step.cwd, env: step.env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(step.label + ' failed (' + (result.signal || result.status) + ')')
}

async function resourceDirectories(directory, depth = 0) {
  if (depth > 5) return []
  const found = []
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = path.join(directory, entry.name)
    if (entry.name === 'Resources' || entry.name === 'resources') {
      try { await fsp.access(path.join(candidate, 'app.asar')); found.push(candidate); continue } catch { /* Continue searching ordinary package folders. */ }
    }
    found.push(...await resourceDirectories(candidate, depth + 1))
  }
  return found
}

async function artifactHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function runBuild(plan, { run = execute, write = value => process.stdout.write(value), dryRun = false } = {}) {
  printPlan(plan, write)
  await checkOutputs(plan)
  if (plan.limitations.length) throw new Error('Selected targets cannot be built on this host; no build was started')
  if (!plan.targets.length) { write('Nothing selected; nothing changed.\n'); return [] }
  if (dryRun) { write('Dry run: no commands, installations or directories were created.\n'); return [] }
  const lockPath = path.join(plan.root, 'bin', '.desktop-build.lock')
  await fsp.mkdir(path.dirname(lockPath), { recursive: true })
  const lock = await fsp.open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another build owns this checkout, or its lock remains: ' + lockPath + '. Do not remove it while a build is running')
    throw error
  })
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, version: plan.version }) + '\n')
    await checkOutputs(plan)
    return await runOwnedBuild(plan, { run, write })
  } finally { await lock.close(); await fsp.unlink(lockPath) }
}

async function runOwnedBuild(plan, { run, write }) {
  await fsp.mkdir(plan.versionDirectory, { recursive: true })
  const work = await fsp.mkdtemp(path.join(plan.versionDirectory, '.build-'))
  const renderer = path.join(work, 'renderer')
  const environment = { ...process.env, APP_VERSION: plan.version, ERP_BUILD_TARGET: 'desktop', ERP_DESKTOP_RENDERER_DIR: renderer }
  const node = (label, script, args = [], extra = {}) => run({ label, command: process.execPath, args: [script, ...args], cwd: plan.frontend, env: environment, ...extra })
  const npm = plan.host === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm ci'] }
    : { command: 'npm', args: ['ci'] }
  const results = []
  const manifest = path.join(work, 'result.json')
  const save = async error => fsp.writeFile(manifest, JSON.stringify({ version: plan.version, product: plan.product, host: plan.host, targets: plan.targets.map(target => ({ system: target.key, arch: target.arch, directory: target.directory })), results, ...(error ? { error } : {}) }, null, 2) + '\n')
  try {
    await run({ label: 'Frontend dependencies', ...npm, cwd: plan.frontend, env: environment })
    await run({ label: 'Desktop dependencies', ...npm, cwd: plan.desktop, env: environment })
    for (const script of ['desktop-api-routes.cjs', 'desktop-domain.cjs', 'application-services.cjs']) await node('Generated source check', path.join(plan.frontend, 'scripts', script), ['--check'])
    await node('Host SQLite runtime check', path.join(plan.desktop, 'verify-storage.cjs'))
    await node('Fresh desktop renderer', path.join(plan.frontend, 'scripts/build-renderer.cjs'), ['desktop', '--outDir', renderer], { renderer })
    const { verifyRenderer } = require(path.join(plan.frontend, 'scripts/verify-renderer.cjs'))
    verifyRenderer(renderer, 'desktop', plan.version)
    for (const target of plan.targets) {
      await fsp.mkdir(target.directory)
      const config = structuredClone(plan.metadata.build)
      config.directories = { ...config.directories, output: target.directory }
      if (!config.extraResources?.some(resource => resource.to === 'web')) throw new Error('Desktop web resource mapping is missing')
      config.extraResources = config.extraResources.map(resource => resource.to === 'web' ? { ...resource, from: renderer } : resource)
      config[target.package] = { ...config[target.package], artifactName: target.filename }
      const configFile = path.join(work, target.key + '-' + target.arch + '.json')
      await fsp.writeFile(configFile, JSON.stringify(config, null, 2) + '\n')
      await node('Package ' + target.key, path.join(plan.desktop, 'build.cjs'), [target.flag, target.format, '--' + target.arch, '--config', configFile, '--publish', 'never'], { cwd: plan.desktop, target, renderer })
      const artifact = path.join(target.directory, target.filename)
      const stat = await fsp.lstat(artifact)
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('Expected binary archive is missing: ' + artifact)
      const resources = await resourceDirectories(target.directory)
      if (resources.length !== 1) throw new Error('Expected exactly one unpacked application: ' + target.directory)
      const { verifyWeb } = require(path.join(plan.desktop, 'verify-web.cjs'))
      const { verifyStoragePayload } = require(path.join(plan.desktop, 'verify-storage.cjs'))
      verifyRenderer(path.join(resources[0], 'web'), 'desktop', plan.version)
      if (verifyWeb(renderer, path.join(resources[0], 'web')).length) throw new Error('Embedded renderer differs from the fresh build')
      verifyStoragePayload(plan.desktop, resources[0])
      results.push({ system: target.key, arch: target.arch, artifact, sha256: await artifactHash(artifact) })
      await save(); write('Verified: ' + artifact + '\n')
    }
    await save(); write('Manifest: ' + manifest + '\n'); return results
  } catch (error) {
    await save(error.message)
    throw new Error(error.message + '\nBuild stopped; existing artifacts were preserved. Details: ' + manifest)
  }
}

async function main(args = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  const options = parseArguments(args)
  if (options.help) { output.write('Usage: node scripts/build-desktop.cjs [--dry-run] [--arch x64|arm64]\nOnly n skips a platform. Default: Windows/Linux x64, macOS host architecture.\n'); return }
  const lines = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) })
  const iterator = lines[Symbol.asyncIterator]()
  let selected
  try { selected = await askTargets(async () => { const next = await iterator.next(); return next.done ? null : next.value }, value => output.write(value)) }
  finally { lines.close() }
  await runBuild(createPlan({ selected, arch: options.arch }), { dryRun: options.dryRun, write: value => output.write(value) })
}

module.exports = { parseArguments, askTargets, createPlan, checkOutputs, printPlan, runBuild, main }
if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1 })
