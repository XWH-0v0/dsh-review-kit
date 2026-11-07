import test from 'node:test'
import assert from 'node:assert/strict'

import { gateCandidates } from '../../lib/gate.js'

const snapshot = {
  files: [
    {
      path: 'src/cache.js',
      after: 'export class Cache {\n  get(key) {\n    return this.entries.get(key).value\n  }\n}\n',
      before: null,
    },
    {
      path: 'src/gone.js',
      after: null,
      before: 'export const legacy = keepAlive()\n',
      deleted: true,
    },
  ],
}

const base = {
  file: 'src/cache.js',
  anchor: 'return this.entries.get(key).value',
  kind: 'correctness',
  title: '缺失键会抛 TypeError',
  detail: 'get() 没有检查 Map 是否命中。',
  failureScenario: 'get("absent") → TypeError: Cannot read properties of undefined',
}

test('gate accepts a candidate whose anchor exists and resolves its line', () => {
  const result = gateCandidates({ candidates: [{ raw: base, lens: 'correctness' }], snapshot })
  assert.equal(result.accepted.length, 1)
  assert.equal(result.invalid.length, 0)
  const [finding] = result.accepted
  assert.equal(finding.line, 3)
  assert.equal(finding.side, 'after')
  assert.match(finding.id, /^[0-9a-f]{16}$/)
  assert.deepEqual(finding.lenses, ['correctness'])
  assert.equal(finding.originHint, 'unknown')
})

test('gate rejects a fabricated anchor as invalid output', () => {
  const result = gateCandidates({
    candidates: [{ raw: { ...base, anchor: 'return this.entries.get(key)?.value' }, lens: 'correctness' }],
    snapshot,
  })
  assert.equal(result.accepted.length, 0)
  assert.match(result.invalid[0].reason, /找不到/)
})

test('gate drops noise kinds before verification', () => {
  const result = gateCandidates({
    candidates: [{ raw: { ...base, kind: 'style' }, lens: 'correctness' }],
    snapshot,
  })
  assert.equal(result.accepted.length, 0)
  assert.match(result.invalid[0].reason, /白名单/)
})

test('gate requires a concrete failure scenario', () => {
  const result = gateCandidates({
    candidates: [{ raw: { ...base, failureScenario: '   ' }, lens: 'correctness' }],
    snapshot,
  })
  assert.match(result.invalid[0].reason, /failureScenario/)
})

test('gate rejects files outside the snapshot and path escapes', () => {
  const outside = gateCandidates({ candidates: [{ raw: { ...base, file: 'src/other.js' }, lens: 'correctness' }], snapshot })
  assert.match(outside.invalid[0].reason, /不在本次评审范围/)
  const escape = gateCandidates({ candidates: [{ raw: { ...base, file: '../evil.js' }, lens: 'correctness' }], snapshot })
  assert.match(escape.invalid[0].reason, /路径无效/)
})

test('gate falls back to the before snapshot for deleted files', () => {
  const result = gateCandidates({
    candidates: [{
      ...base,
      file: 'src/gone.js',
      anchor: 'export const legacy = keepAlive()',
      title: '删除后仍有调用方',
      detail: '调用方没有一起删除。',
    }].map((raw) => ({ raw, lens: 'contract' })),
    snapshot,
  })
  assert.equal(result.accepted.length, 1)
  assert.equal(result.accepted[0].side, 'before')
  assert.equal(result.accepted[0].line, 1)
})

test('gate rejects a too-short anchor', () => {
  const result = gateCandidates({
    candidates: [{ raw: { ...base, anchor: '}' }, lens: 'correctness' }],
    snapshot,
  })
  assert.match(result.invalid[0].reason, /过短/)
})
