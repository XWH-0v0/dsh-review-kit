import test from 'node:test'
import assert from 'node:assert/strict'

import { describeTarget, parseTarget, sanitizeRepoPath } from '../../lib/target.js'

test('parseTarget defaults to uncommitted', () => {
  assert.deepEqual(parseTarget({}), { kind: 'uncommitted', baseRef: 'HEAD', commit: '', files: [] })
  assert.deepEqual(parseTarget({ target: 'uncommitted' }).kind, 'uncommitted')
})

test('parseTarget requires base for base scope', () => {
  assert.throws(() => parseTarget({ target: 'base' }), /base 参数/)
  assert.deepEqual(parseTarget({ target: 'base', base: ' origin/main ' }), {
    kind: 'base',
    baseRef: 'origin/main',
    commit: '',
    files: [],
  })
})

test('parseTarget requires a commit sha and rejects options', () => {
  assert.throws(() => parseTarget({ target: 'commit' }), /commit 参数/)
  assert.throws(() => parseTarget({ target: 'commit', commit: '--output=/tmp/x' }), /不要以 - 开头/)
  assert.equal(parseTarget({ target: 'commit', commit: 'abc1234' }).commit, 'abc1234')
})

test('parseTarget normalizes, deduplicates and bounds file lists', () => {
  const target = parseTarget({ target: 'files', files: ['src\\a.js', './src/a.js', 'src/b.ts'] })
  assert.deepEqual(target.files, ['src/a.js', 'src/b.ts'])
})

test('sanitizeRepoPath rejects escapes', () => {
  assert.throws(() => sanitizeRepoPath('/etc/passwd'), /绝对路径/)
  assert.throws(() => sanitizeRepoPath('C:\\Windows\\win.ini'), /绝对路径/)
  assert.throws(() => sanitizeRepoPath('../outside.js'), /\.\./)
  assert.throws(() => sanitizeRepoPath('src/../../outside.js'), /\.\./)
  assert.equal(sanitizeRepoPath('src\\nested\\a.js'), 'src/nested/a.js')
})

test('describeTarget is human readable', () => {
  assert.match(describeTarget(parseTarget({})), /未提交改动/)
  assert.match(describeTarget(parseTarget({ target: 'base', base: 'main' })), /main/)
  assert.match(describeTarget(parseTarget({ target: 'commit', commit: 'abc' })), /abc/)
  assert.match(describeTarget(parseTarget({ target: 'files', files: ['a.js'] })), /指定文件/)
})
