'use strict'
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function rendererBuildPlan(target, args = []) {
  if (!['web', 'desktop'].includes(target)) throw new Error('Choose web or desktop renderer')
  const frontend = path.join(__dirname, '..')
  const vite = path.join(path.dirname(require.resolve('vite/package.json', { paths: [frontend] })), 'bin/vite.js')
  return { command: process.execPath, args: [vite, 'build', ...args], options: { cwd: frontend, env: { ...process.env, ERP_BUILD_TARGET: target }, stdio: 'inherit' } }
}
module.exports = { rendererBuildPlan }
if (require.main === module) {
  try {
    const plan = rendererBuildPlan(process.argv[2], process.argv.slice(3))
    const result = spawnSync(plan.command, plan.args, plan.options)
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
