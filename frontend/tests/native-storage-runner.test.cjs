'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { nativeChecks } = require('../scripts/test-desktop-storage.cjs')

test('durable-write stress waits for the other SQLite suites without dropping coverage', async () => {
  const calls = []
  let finish
  const regular = new Promise(resolve => { finish = resolve })
  const pending = nativeChecks('isolated-electron', async (executable, args, env) => {
    calls.push({ executable, args, env })
    if (calls.length === 1) await regular
  })
  try {
    assert.equal(calls.length, 1)
    assert.ok(!calls[0].args.some(arg => arg.endsWith('desktop-storage-stress.test.cjs')))
  } finally { finish(); await pending }
  assert.equal(calls.length, 2)
  assert.equal(calls[1].args[0], '--test')
  assert.ok(calls[1].args.includes('--test-concurrency=1'))
  assert.deepEqual(calls[1].args.filter(arg => arg.endsWith('.cjs')).map(file => path.basename(file)), ['desktop-storage-stress.test.cjs'])
  const suites = calls.flatMap(call => call.args.filter(arg => arg.endsWith('.cjs')).map(file => path.basename(file)))
  assert.deepEqual(suites.sort(), ['desktop-storage.test.cjs', 'desktop-read-concurrency.test.cjs', 'desktop-command-queue.test.cjs', 'desktop-sync.test.cjs', 'desktop-storage-stress.test.cjs'].sort())
  for (const call of calls) {
    assert.equal(call.executable, 'isolated-electron')
    assert.equal(call.env.ELECTRON_RUN_AS_NODE, '1')
  }
})

test('a failed regular suite stops native verification before stress starts', async () => {
  const failure = new Error('regular suite failed')
  let calls = 0
  await assert.rejects(nativeChecks('isolated-electron', async () => { calls++; throw failure }), error => error === failure)
  assert.equal(calls, 1)
})

test('a stress failure remains a failure of the native verification', async () => {
  const failure = new Error('stress failed')
  let calls = 0
  await assert.rejects(nativeChecks('isolated-electron', async () => { if (++calls === 2) throw failure }), error => error === failure)
  assert.equal(calls, 2)
})
