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

test('dedupe merges the exact same anchor across kinds (one line, one defect)', () => {
  const correctness = finding({ kind: 'correctness' })
  const lifecycle = finding({
    kind: 'state',
    lens: 'lifecycle',
    lenses: ['lifecycle'],
    severity: 'critical',
    detail: '更长的描述，说明缺失键会让后续读取全部崩掉。',
  })
  const result = dedupeFindings([correctness, lifecycle])
  assert.equal(result.findings.length, 1, '同一行同一 anchor 不应重复上报')
  assert.equal(result.mergedCount, 1)
  assert.deepEqual([...result.findings[0].lenses].sort(), ['correctness', 'lifecycle'])
  assert.equal(result.findings[0].severity, 'critical', '保留更严重的严重度')
  assert.match(result.findings[0].detail, /全部崩掉/)
})

test('dedupe keeps different anchors on the same line apart', () => {
  const first = finding({ line: 3, anchor: 'return this.entries.get(key).value', kind: 'correctness' })
  const second = finding({
    line: 3,
    anchor: 'const hit = this.entries.get(key)',
    kind: 'state',
    lens: 'lifecycle',
    lenses: ['lifecycle'],
  })
  const result = dedupeFindings([first, second])
  assert.equal(result.findings.length, 2, '同行但不同 anchor 是两条独立证据')
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
