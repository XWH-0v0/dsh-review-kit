import test from 'node:test'
import assert from 'node:assert/strict'

import { clip, compareFindings, excerpt, formatDuration, locateAnchor, normalizeLine, similarity } from '../../lib/text.js'

test('normalizeLine folds every whitespace run', () => {
  assert.equal(normalizeLine('  return\t value  '), 'return value')
  assert.equal(normalizeLine('a\r\nb'), 'a b')
  assert.equal(normalizeLine(null), '')
})

test('locateAnchor finds the 1-based line and tolerates CRLF and re-indent', () => {
  const content = 'function f() {\r\n\treturn x\r\n}\r\n'
  assert.equal(locateAnchor(content, 'return x'), 2)
  assert.equal(locateAnchor(content, '   return   x  '), 2)
  assert.equal(locateAnchor(content, 'return y'), 0)
  assert.equal(locateAnchor(null, 'return x'), 0)
})

test('clip and excerpt mark truncation', () => {
  assert.equal(clip('abcdef', 3), 'abc\n…[已截断 3 字符]')
  assert.equal(clip('abc', 3), 'abc')
  assert.equal(excerpt('a  b\nc', 10), 'a b c')
  assert.equal(excerpt('abcdef', 3), 'abc…')
})

test('similarity merges near-identical anchors but not different ones', () => {
  assert.equal(similarity('return value.foo', 'return value.foo'), 1)
  assert.ok(similarity('return value.foo', 'return value.foo;') > 0.85)
  assert.ok(similarity('return value.foo', 'throw new Error("x")') < 0.5)
})

test('compareFindings sorts by severity then corroboration', () => {
  const critical = { severity: 'critical', file: 'b.js', line: 2, id: 'b', lenses: ['correctness'] }
  const major = { severity: 'major', file: 'a.js', line: 1, id: 'a', lenses: ['correctness'] }
  const majorCorroborated = { severity: 'major', file: 'c.js', line: 1, id: 'c', lenses: ['correctness', 'security'] }
  const sorted = [major, majorCorroborated, critical].sort(compareFindings)
  assert.deepEqual(sorted.map((item) => item.id), ['b', 'c', 'a'])
})

test('formatDuration stays compact', () => {
  assert.equal(formatDuration(500), '500ms')
  assert.equal(formatDuration(12_300), '12.3s')
  assert.equal(formatDuration(125_000), '2m5s')
})
