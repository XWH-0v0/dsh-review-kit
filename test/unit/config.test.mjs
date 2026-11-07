import test from 'node:test'
import assert from 'node:assert/strict'

import { isDocPath, normalizeLenses, resolveConfig } from '../../lib/config.js'

test('resolveConfig fills defaults and clamps ranges', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.subagentProvider, 'spawn')
  assert.equal(config.depth, 'full')
  assert.deepEqual(config.lenses, ['correctness', 'lifecycle', 'contract', 'security'])
  assert.equal(config.verifiersPerFinding, 1)
  assert.equal(config.maxChildren, 24)

  const clamped = resolveConfig({ maxFindings: 0, maxConcurrentChildren: 999, verifiersPerFinding: 9 })
  assert.equal(clamped.maxFindings, 1)
  assert.equal(clamped.maxConcurrentChildren, 16)
  assert.equal(clamped.verifiersPerFinding, 3)
})

test('resolveConfig rejects unknown enum values', () => {
  const config = resolveConfig({ depth: 'deep', onVerifierFailure: 'crash', gitMode: 'magic' })
  assert.equal(config.depth, 'full')
  assert.equal(config.onVerifierFailure, 'refute')
  assert.equal(config.gitMode, 'auto')
})

test('normalizeLenses keeps known keys in canonical order', () => {
  assert.deepEqual(normalizeLenses(['security', 'correctness', 'nope']), ['correctness', 'security'])
  assert.deepEqual(normalizeLenses([]), ['correctness', 'lifecycle', 'contract', 'security'])
  assert.deepEqual(normalizeLenses('correctness'), ['correctness', 'lifecycle', 'contract', 'security'])
})

test('isDocPath marks documentation files', () => {
  assert.equal(isDocPath('README.md'), true)
  assert.equal(isDocPath('docs/guide.rst'), true)
  assert.equal(isDocPath('src/index.ts'), false)
  assert.equal(isDocPath('Makefile'), false)
})
