import test from 'node:test'
import assert from 'node:assert/strict'

import { dedupeFindings } from '../../lib/dedupe.js'
import { fingerprintOf } from '../../lib/fingerprint.js'

function finding(overrides) {
  const base = {
    file: 'src/cache.js',
    line: 3,
    anchor: 'return this.entries.get(key).value',
    kind: 'correctness',
    title: '缺失键会抛 TypeError',
    detail: '短描述',
    failureScenario: 'get("absent") → TypeError',
    severity: 'major',
    lens: 'correctness',
    lenses: ['correctness'],
  }
  const merged = { ...base, ...overrides }
  merged.id = fingerprintOf(merged)
  merged.lenses = [...new Set([merged.lens, ...(overrides.lenses ?? [])])]
  return merged
}

test('dedupe merges the same fingerprint reported by two lenses', () => {
  const first = finding({ lens: 'correctness', lenses: ['correctness'] })
  const second = finding({ lens: 'security', lenses: ['security'], detail: '更长的描述，说明缺失键会让攻击者探测缓存状态。' })
  const result = dedupeFindings([first, second])
  assert.equal(result.findings.length, 1)
  assert.equal(result.mergedCount, 1)
  assert.deepEqual(result.findings[0].lenses.sort(), ['correctness', 'security'])
  assert.match(result.findings[0].detail, /攻击者/)
})

test('dedupe keeps different kinds on the same line', () => {
  const correctness = finding({ kind: 'correctness' })
  const security = finding({ kind: 'security', lens: 'security', lenses: ['security'] })
  const result = dedupeFindings([correctness, security])
  assert.equal(result.findings.length, 2)
  assert.equal(result.mergedCount, 0)
})

test('dedupe merges near-identical anchors within three lines', () => {
  const first = finding({ line: 10, anchor: 'return value.foo' })
  const second = finding({ line: 11, anchor: 'return value.foo;' })
  const result = dedupeFindings([first, second])
  assert.equal(result.findings.length, 1)
  assert.equal(result.mergedCount, 1)
})

test('dedupe keeps different bugs on adjacent lines', () => {
  const first = finding({ line: 10, anchor: 'return value.foo' })
  const second = finding({ line: 11, anchor: 'throw new Error("unreachable")' })
  const result = dedupeFindings([first, second])
  assert.equal(result.findings.length, 2)
})

test('dedupe keeps the more severe severity and the richer detail', () => {
  const minor = finding({ severity: 'minor', detail: '短' })
  const critical = finding({ severity: 'critical', lens: 'security', lenses: ['security'], detail: '长一些的描述，包含完整因果链。' })
  const result = dedupeFindings([minor, critical])
  assert.equal(result.findings[0].severity, 'critical')
  assert.match(result.findings[0].detail, /因果链/)
})
