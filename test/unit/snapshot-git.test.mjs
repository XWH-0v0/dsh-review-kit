import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../../lib/config.js'
import { createGit } from '../../lib/git.js'
import { buildSnapshot, resolveRepoRoot } from '../../lib/snapshot.js'
import { parseTarget } from '../../lib/target.js'

/**
 * @param {string} dir repository directory.
 * @param {...string} args git arguments.
 * @returns {string} stdout.
 */
function gitIn(dir, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, encoding: 'utf8' })
}

const signal = new AbortController().signal

test('snapshot reads uncommitted, base and commit scopes from a real repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-kit-git-'))
  try {
    gitIn(dir, 'init', '-q')
    gitIn(dir, 'config', 'user.email', 'review-kit@example.test')
    gitIn(dir, 'config', 'user.name', 'review-kit')
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'a.js'), 'export const a = 1\n')
    await writeFile(join(dir, 'README.md'), '# doc only\n')
    gitIn(dir, 'add', '-A')
    gitIn(dir, 'commit', '-qm', 'one')

    await writeFile(join(dir, 'src', 'a.js'), 'export const a = 2\n')
    await writeFile(join(dir, 'src', 'new.js'), 'export const b = 3\n')
    await writeFile(join(dir, 'README.md'), '# doc only\n\nmore prose\n')

    const config = resolveConfig({ gitMode: 'process' })
    const git = createGit({ cwd: dir, config })
    const root = await resolveRepoRoot(git, dir, { signal })
    assert.ok(root !== null, '应能识别仓库根目录')
    assert.match(root, /review-kit-git-/)

    // ---- uncommitted: tracked modification + untracked file, README skipped.
    const snapshot = await buildSnapshot({ root, git, target: parseTarget({}), config, signal })
    assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ['src/a.js', 'src/new.js'])
    const modified = snapshot.files.find((file) => file.path === 'src/a.js')
    assert.match(modified.before ?? '', /a = 1/)
    assert.match(modified.after ?? '', /a = 2/)
    assert.match(modified.diff, /\+export const a = 2/)
    assert.deepEqual(modified.changedLines, [{ start: 1, end: 1 }])
    const added = snapshot.files.find((file) => file.path === 'src/new.js')
    assert.equal(added.before, null)
    assert.match(added.after ?? '', /b = 3/)
    assert.ok(snapshot.skipped.some((item) => item.path === 'README.md' && /文档/.test(item.reason)))

    // ---- base scope after committing the change.
    gitIn(dir, 'add', '-A')
    gitIn(dir, 'commit', '-qm', 'two')
    const baseGit = createGit({ cwd: dir, config })
    const baseSnapshot = await buildSnapshot({
      root,
      git: baseGit,
      target: parseTarget({ target: 'base', base: 'HEAD~1' }),
      config,
      signal,
    })
    assert.deepEqual(baseSnapshot.files.map((file) => file.path).sort(), ['src/a.js', 'src/new.js'])
    const baseA = baseSnapshot.files.find((file) => file.path === 'src/a.js')
    assert.match(baseA.before ?? '', /a = 1/)
    assert.match(baseA.after ?? '', /a = 2/)

    // ---- commit scope: the same change, read from the commit itself.
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim()
    const commitGit = createGit({ cwd: dir, config })
    const commitSnapshot = await buildSnapshot({
      root,
      git: commitGit,
      target: parseTarget({ target: 'commit', commit: sha }),
      config,
      signal,
    })
    assert.deepEqual(commitSnapshot.files.map((file) => file.path).sort(), ['src/a.js', 'src/new.js'])
    const commitA = commitSnapshot.files.find((file) => file.path === 'src/a.js')
    assert.match(commitA.before ?? '', /a = 1/)
    assert.match(commitA.after ?? '', /a = 2/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file scope reads explicit paths and rejects missing ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-kit-files-'))
  try {
    await writeFile(join(dir, 'only.js'), 'export const x = 1\n')
    const config = resolveConfig({ gitMode: 'process' })
    const git = createGit({ cwd: dir, config })
    const snapshot = await buildSnapshot({
      root: dir,
      git,
      target: parseTarget({ target: 'files', files: ['only.js', 'missing.js'] }),
      config,
      signal,
    })
    assert.deepEqual(snapshot.files.map((file) => file.path), ['only.js'])
    assert.match(snapshot.files[0].after ?? '', /x = 1/)
    assert.ok(snapshot.skipped.some((item) => item.path === 'missing.js'))
    // Not a repository: the root probe fails instead of inventing one.
    assert.equal(await resolveRepoRoot(git, dir, { signal }), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
