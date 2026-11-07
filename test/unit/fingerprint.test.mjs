import test from 'node:test'
import assert from 'node:assert/strict'

import { fingerprintOf } from '../../lib/fingerprint.js'

test('fingerprint ignores whitespace, CRLF and path separators', () => {
  const first = fingerprintOf({ kind: 'correctness', file: 'src/a.js', anchor: '  return x  ' })
  const second = fingerprintOf({ kind: 'Correctness', file: 'src\\a.js', anchor: 'return   x' })
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{16}$/)
})

test('fingerprint separates kinds on the same line', () => {
  const correctness = fingerprintOf({ kind: 'correctness', file: 'src/a.js', anchor: 'return x' })
  const security = fingerprintOf({ kind: 'security', file: 'src/a.js', anchor: 'return x' })
  assert.notEqual(correctness, security)
})

test('fingerprint is stable across repeated runs', () => {
  const value = { kind: 'state', file: 'src/b.ts', anchor: 'this.subscription.unsubscribe()' }
  assert.equal(fingerprintOf(value), fingerprintOf({ ...value }))
})
