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

test('child route defaults favour recall for finders and precision for verifiers', () => {
  const config = resolveConfig(undefined)
  // Finder effort stays below the verifier's: finders over-generate and the
  // verifier is the precision gate.
  assert.equal(config.finderEffort, 'high')
  assert.equal(config.verifierEffort, 'max')
  assert.equal(config.finderPreset, '')
  assert.equal(config.verifierPreset, '')
  assert.equal(config.finderToolBudget, 6)
  assert.equal(config.finderToolBudgetMax, 18)
  assert.equal(config.verifierToolBudget, 5)
  assert.equal(config.verifierToolBudgetMax, 10)
  // Wall clock and fan-out rebalanced in 0.2.0 after measuring 5-23 minute runs.
  assert.equal(config.maxFindings, 8)
  assert.equal(config.maxCandidatesPerLens, 6)
  assert.equal(config.maxConcurrentChildren, 8)
  assert.equal(config.childTimeoutMs, 300_000)
  assert.equal(config.softTimeoutMs, 900_000)
  assert.equal(config.fullFileMaxChars, 20_000)
})

test('resolveConfig normalizes effort and preset overrides', () => {
  const config = resolveConfig({
    finderEffort: 'LOW',
    verifierEffort: 'nope',
    finderPreset: '  review-readonly  ',
    verifierPreset: 'review-readonly',
  })
  assert.equal(config.finderEffort, 'low')
  assert.equal(config.verifierEffort, 'max', '非法 effort 回落到默认值')
  assert.equal(config.finderPreset, 'review-readonly', 'preset id 要去空白')
  assert.equal(config.verifierPreset, 'review-readonly')
  assert.equal(resolveConfig({ finderEffort: '' }).finderEffort, '', '空字符串表示继承父代理')
  assert.equal(resolveConfig({ finderToolBudget: -3 }).finderToolBudget, 0)
  assert.equal(resolveConfig({ verifierToolBudget: 999 }).verifierToolBudget, 50)
  assert.equal(resolveConfig({ fullFileMaxChars: 1 }).fullFileMaxChars, 2_000)
  assert.equal(
    resolveConfig({ finderToolBudget: 20, finderToolBudgetMax: 5 }).finderToolBudgetMax,
    20,
    '上限期望不允许低于基准值',
  )
  assert.equal(resolveConfig({ verifierToolBudgetMax: 999 }).verifierToolBudgetMax, 80)
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
