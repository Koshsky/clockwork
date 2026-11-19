'use strict'
// Explicit isolated workload, not a timing-sensitive CI test or an application build.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { createStorage } = require('../desktop/storage.cjs')
const { createDiagnostics } = require('../desktop/diagnostics.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function measure(mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-diagnostics-budget-'))
  let storage, journal
  try {
    if (mode === 'unavailable') await fs.writeFile(path.join(directory, 'diagnostics'), 'unavailable fixture')
    global.gc()
    const initial = process.memoryUsage().heapUsed + process.memoryUsage().external
    journal = mode === 'baseline' ? undefined : createDiagnostics({ directory, version: '2.2.0' })
    journal?.setContext({ contextId: 'fixture', user: { id: 1 }, server: 'https://fixture.invalid/api/v1', mode: 'offline' })
    storage = await createStorage({ directory, diagnostics: journal })
    const repo = storage.forScope({ server: 'https://fixture.invalid/api/v1', accountId: 1 })
    const requests = 600
    const samples = [], start = performance.now(), cpu = process.cpuUsage()
    let peak = initial, reportBytes = 0
    for (let index = 0; index < requests; index++) {
      const at = performance.now()
      await repo.commitLocal({ operationId: 'operation-' + index, operation: 'task.update', input: { id: 1, patch: { color: '#112233' } }, idempotencyKey: 'key-' + index, dependencies: [], changes: [] })
      journal?.record('queue', 'diagnostic', null, {}, 'queued')
      samples.push(performance.now() - at)
      if (index % 60 === 0) {
        if (journal) reportBytes = Math.max(reportBytes, Buffer.byteLength(JSON.stringify(await journal.report())))
        const memory = process.memoryUsage(); peak = Math.max(peak, memory.heapUsed + memory.external)
      }
      await delay(Math.max(0, start + (index + 1) * (1000 / 60) - performance.now()))
    }
    const elapsed = performance.now() - start, used = process.cpuUsage(cpu)
    assert.equal((await repo.queueStats()).pending, requests)
    await journal?.flush()
    const files = await fs.readdir(path.join(directory, 'diagnostics')).catch(() => [])
    let bytes = 0
    for (const name of files) bytes += (await fs.stat(path.join(directory, 'diagnostics', name))).size
    samples.sort((a, b) => a - b)
    return { mode, requests, reports_per_second: 1, rate: 60, elapsed_ms: elapsed, cpu_core_percent: (used.user + used.system) / (elapsed * 10), p95_commit_ms: samples[Math.floor(samples.length * .95)], peak_main_heap_external_extra_bytes: peak - initial, report_bytes: reportBytes, log_bytes: bytes }
  } finally { await storage?.close(); await journal?.close(); await fs.rm(directory, { recursive: true, force: true }) }
}
async function main() {
  if (process.argv[2]) { console.log(JSON.stringify(await measure(process.argv[2]))); return }
  const results = [], modes = ['baseline', 'enabled', 'unavailable']
  for (let round = 0; round < 3; round++) {
    for (let offset = 0; offset < modes.length; offset++) {
      const mode = modes[(round + offset) % modes.length]
      const child = spawnSync(process.execPath, ['--expose-gc', __filename, mode], { encoding: 'utf8', timeout: 60000 })
      if (child.status !== 0) throw Error(child.stderr)
      results.push({ round, ...JSON.parse(child.stdout.trim()) })
    }
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summaries = modes.map(mode => {
    const rows = results.filter(result => result.mode === mode)
    return { mode, cpu_core_percent: median(rows.map(row => row.cpu_core_percent)),
      p95_commit_ms: median(rows.map(row => row.p95_commit_ms)),
      peak_main_heap_external_extra_bytes: median(rows.map(row => row.peak_main_heap_external_extra_bytes)),
      report_bytes: Math.max(...rows.map(row => row.report_bytes)), log_bytes: Math.max(...rows.map(row => row.log_bytes)) }
  })
  for (const result of summaries.slice(1)) {
    result.cpu_extra_core_percent = result.cpu_core_percent - summaries[0].cpu_core_percent
    result.main_memory_extra_bytes = result.peak_main_heap_external_extra_bytes - summaries[0].peak_main_heap_external_extra_bytes
    result.p95_commit_change_percent = 100 * (result.p95_commit_ms / summaries[0].p95_commit_ms - 1)
  }
  console.log(JSON.stringify({ node: process.versions.node, os: process.platform, results, summaries }, null, 2))
  for (const result of summaries.slice(1)) {
    assert(result.cpu_extra_core_percent <= 3)
    assert(result.main_memory_extra_bytes <= 16 * 1024 * 1024)
    assert(result.report_bytes <= 512 * 1024); assert(result.log_bytes <= 16 * 1024 * 1024)
    assert(result.p95_commit_change_percent <= 5)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
