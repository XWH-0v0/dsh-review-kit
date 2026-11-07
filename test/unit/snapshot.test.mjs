import test from 'node:test'
import assert from 'node:assert/strict'

import { parseChangedLines, parseNameStatusZ } from '../../lib/snapshot.js'

test('parseNameStatusZ reads modifications, deletes and renames', () => {
  const text = 'M\u0000a.txt\u0000D\u0000gone.js\u0000R100\u0000src/old name.js\u0000src/new name.js\u0000'
  assert.deepEqual(parseNameStatusZ(text), [
    { status: 'M', path: 'a.txt' },
    { status: 'D', path: 'gone.js' },
    { status: 'R', path: 'src/new name.js', oldPath: 'src/old name.js' },
  ])
})

test('parseNameStatusZ tolerates a trailing NUL and empty output', () => {
  assert.deepEqual(parseNameStatusZ('A\u0000new.js\u0000'), [{ status: 'A', path: 'new.js' }])
  assert.deepEqual(parseNameStatusZ(''), [])
})

test('parseChangedLines extracts after-side ranges', () => {
  const diff = [
    'diff --git a/a.js b/a.js',
    '@@ -1,3 +1,4 @@',
    '+new line',
    '@@ -10,2 +12,3 @@',
    '+another',
    '@@ -30,2 +40,0 @@',
  ].join('\n')
  assert.deepEqual(parseChangedLines(diff), [
    { start: 1, end: 4 },
    { start: 12, end: 14 },
  ])
})

test('parseChangedLines returns nothing for an empty diff', () => {
  assert.deepEqual(parseChangedLines(''), [])
})
