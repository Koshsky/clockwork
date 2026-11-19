'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { diagnosticEvent } = require('../desktop/command-diagnostics.cjs')
const { storageFailure } = require('../desktop/storage-validation.cjs')

test('Electron worker errors and report metadata do not disclose the profile or account', () => {
  const secret = '/Users/canary-profile/password=secret'
  const source = { message: secret, stack: secret, code: 'ENOSPC', password: secret }
  const code = storageFailure(source)
  const report = diagnosticEvent('desktop-start', { code }, { profile: secret, accountId: 42, server: secret, sqlite: secret, vault: secret, version: '2.2.0', platform: 'desktop' })
  assert.deepEqual(report, { event: 'desktop-start', error_code: 'STORAGE_FULL', platform: 'desktop', version: '2.2.0' })
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(source.message, secret)
})
test('Electron diagnostics are isolated disposable values without a shared account buffer', () => {
  const first = diagnosticEvent('desktop-start', { code: 'ERR_NETWORK', config: { headers: { Authorization: 'canary-token' } } }, { accountId: 1 })
  first.error_code = 'changed'
  const second = diagnosticEvent('desktop-start', { code: 'ERR_NETWORK' }, { accountId: 2 })
  assert.deepEqual(second, { event: 'desktop-start', error_code: 'ERR_NETWORK' })
})
