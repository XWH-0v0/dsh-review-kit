/**
 * Build the review snapshot: the before/after text and diff for every file in
 * scope. The snapshot is the *only* source of truth the anchor gate accepts, so
 * a finding that quotes a line not present here is rejected as invalid output
 * rather than counted as a false positive.
 *
 * @module dsh-review-kit/snapshot
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isDocPath } from './config.js'

/** Git's well-known empty tree object, used for a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** One-letter diff statuses, in report language. */
const STATUS_LABEL = Object.freeze({
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
})

/**
 * Resolve the repository root that contains `cwd`.
 *
 * @param {{tryRun: Function}} git git runner.
 * @param {string} cwd starting directory.
 * @param {{signal?: AbortSignal}} [options] cancellation.
 * @returns {Promise<string|null>} absolute root, or null outside a work tree.
 */
export async function resolveRepoRoot(git, cwd, options = {}) {
  const result = await git.tryRun(['rev-parse', '--show-toplevel'], { ...options, cwd })
  if (!result.ok) return null
  const root = result.stdout.trim()
  if (root.length === 0) return null
  // A work-tree root is always absolute; anything else is stray command output.
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(root)) return null
  return root
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * @param {unknown} text NUL-separated git output.
 * @returns {Array<{status: string, path: string, oldPath?: string}>} entries.
 */
export function parseNameStatusZ(text) {
  const tokens = String(text ?? '').split('\u0000')
  const entries = []
  let index = 0
  while (index < tokens.length) {
    const status = tokens[index]
    index += 1
    if (status === undefined || status.length === 0) continue
    const code = status[0]
    if (code === 'R' || code === 'C') {
      const from = tokens[index]
      const to = tokens[index + 1]
      index += 2
      if (to !== undefined && to.length > 0) {
        entries.push({ status: code, path: to, ...(from ? { oldPath: from } : {}) })
      }
      continue
    }
    const path = tokens[index]
    index += 1
    if (path !== undefined && path.length > 0) entries.push({ status: code, path })
  }
  return entries
}

/**
 * Parse the added-line ranges out of a unified diff.
 *
 * @param {unknown} diff unified diff text.
 * @returns {Array<{start: number, end: number}>} 1-based after-side ranges.
 */
export function parseChangedLines(diff) {
  const ranges = []
  const regex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm
  let match
  while ((match = regex.exec(String(diff ?? ''))) !== null) {
    const start = Number.parseInt(match[1], 10)
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10)
    if (Number.isFinite(start) && count > 0) ranges.push({ start, end: start + count - 1 })
  }
  return ranges
}

/**
 * List the changed files for one scope.
 *
 * @param {{run: Function}} git git runner.
 * @param {{kind: string, baseRef: string, commit: string, files: string[]}} target resolved scope.
 * @param {AbortSignal} signal cancellation.
 * @returns {Promise<Array<{status: string, path: string, oldPath?: string, untracked?: boolean}>>} entries.
 */
async function listChangedEntries(git, target, signal) {
  if (target.kind === 'files') {
    return target.files.map((path) => ({ status: 'M', path }))
  }

  if (target.kind === 'commit') {
    const parent = `${target.commit}^`
    const direct = await git.tryRun(['diff', '--name-status', '-z', parent, target.commit, '--'], { signal })
    if (direct.ok) return parseNameStatusZ(direct.stdout)
    const rootCommit = await git.tryRun(['diff', '--name-status', '-z', EMPTY_TREE, target.commit, '--'], { signal })
    if (rootCommit.ok) return parseNameStatusZ(rootCommit.stdout)
    throw new Error(`无法读取提交 ${target.commit}：${direct.error?.message ?? '未知 git 错误'}`)
  }

  const ref = target.kind === 'base' ? target.baseRef : 'HEAD'
  let tracked
  const diff = await git.tryRun(['diff', '--name-status', '-z', ref, '--'], { signal })
  if (diff.ok) {
    tracked = parseNameStatusZ(diff.stdout)
  } else if (target.kind === 'base') {
    throw new Error(`无法对比基线 ${ref}：${diff.error?.message ?? '未知 git 错误'}`)
  } else {
    // An empty repository has no HEAD yet; list everything as new.
    const status = await git.tryRun(['status', '--porcelain', '-z'], { signal })
    if (!status.ok) {
      throw new Error(`无法读取改动：${diff.error?.message ?? '未知 git 错误'}。当前目录可能不是 git 仓库；可以改用 target="files" 显式列出文件，或在仓库内调用。`)
    }
    tracked = []
  }

  if (target.kind !== 'uncommitted') return tracked

  const untrackedResult = await git.tryRun(['ls-files', '--others', '--exclude-standard', '-z'], { signal })
  const untracked = untrackedResult.ok
    ? untrackedResult.stdout.split('\u0000').filter((path) => path.length > 0).map((path) => ({ status: 'A', path, untracked: true }))
    : []
  return [...tracked, ...untracked]
}

/**
 * @param {{tryRun: Function}} git git runner.
 * @param {string} ref revision.
 * @param {string} path repository path.
 * @param {AbortSignal} signal cancellation.
 * @returns {Promise<string|null>} file text at that revision, or null.
 */
async function showText(git, ref, path, signal) {
  const result = await git.tryRun(['show', `${ref}:${path}`], { signal })
  if (!result.ok) return null
  return result.stdout
}

/**
 * @param {string} root repository root.
 * @param {string} path repository path.
 * @param {AbortSignal} signal cancellation.
 * @returns {Promise<{text: string|null, error: string|null}>} current worktree text or the read failure.
 */
async function readWorkspaceFile(root, path, signal) {
  try {
    const text = await readFile(join(root, path), { encoding: 'utf8', ...(signal === undefined ? {} : { signal }) })
    return { text, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { text: null, error: `${join(root, path)}：${message}` }
  }
}

/**
 * @param {string|null} text file text.
 * @returns {boolean} whether the text looks binary.
 */
function looksBinary(text) {
  return typeof text === 'string' && text.includes('\u0000')
}

/**
 * Build the full snapshot for one review.
 *
 * @param {object} options snapshot options.
 * @param {string} options.root repository root (absolute).
 * @param {{run: Function, tryRun: Function}} options.git git runner.
 * @param {{kind: string, baseRef: string, commit: string, files: string[]}} options.target scope.
 * @param {object} options.config resolved plugin config.
 * @param {AbortSignal} options.signal cancellation.
 * @returns {Promise<object>} the snapshot consumed by prompts, gate and verifier.
 */
export async function buildSnapshot({ root, git, target, config, signal }) {
  const entries = await listChangedEntries(git, target, signal)
  const beforeRef = target.kind === 'commit'
    ? `${target.commit}^`
    : (target.kind === 'base' ? target.baseRef : 'HEAD')

  const files = []
  const skipped = []
  let budgetTruncated = false

  for (const entry of entries) {
    if (isDocPath(entry.path)) {
      skipped.push({ path: entry.path, reason: '纯文档改动不触发代码审查' })
      continue
    }
    if (files.length >= config.maxFiles) {
      skipped.push({ path: entry.path, reason: `超过单次评审文件上限（${config.maxFiles}）` })
      budgetTruncated = true
      continue
    }

    const beforePath = entry.oldPath ?? entry.path
    const before = entry.status === 'A'
      ? null
      : await showText(git, beforeRef, beforePath, signal)

    let after = null
    let afterError = null
    if (entry.status !== 'D') {
      if (target.kind === 'commit') {
        after = await showText(git, target.commit, entry.path, signal)
        if (after === null) afterError = `无法读取提交 ${target.commit} 中的 ${entry.path}`
      } else {
        const read = await readWorkspaceFile(root, entry.path, signal)
        after = read.text
        afterError = read.error
      }
    }

    if (before === null && after === null) {
      skipped.push({ path: entry.path, reason: `读取不到改动前后的内容${afterError === null ? '' : `（${afterError}）`}` })
      continue
    }
    if (looksBinary(before) || looksBinary(after)) {
      skipped.push({ path: entry.path, reason: '二进制文件' })
      continue
    }

    const bytes = Buffer.byteLength(after ?? before ?? '', 'utf8')
    if (bytes > config.maxFileBytes) {
      skipped.push({ path: entry.path, reason: `文件过大（${Math.round(bytes / 1024)} KB > ${Math.round(config.maxFileBytes / 1024)} KB）` })
      budgetTruncated = true
      continue
    }

    let diff = ''
    if (target.kind !== 'files') {
      const diffArgs = target.kind === 'commit'
        ? ['diff', '--no-color', '-U3', `${target.commit}^`, target.commit]
        : ['diff', '--no-color', '-U3', beforeRef]
      const paths = entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]
      const result = await git.tryRun([...diffArgs, '--', ...paths], { signal })
      if (result.ok) diff = result.stdout
      if (diff.includes('Binary files')) {
        skipped.push({ path: entry.path, reason: '二进制文件' })
        continue
      }
    }

    files.push({
      path: entry.path,
      oldPath: entry.oldPath ?? null,
      status: entry.status,
      statusLabel: STATUS_LABEL[entry.status] ?? entry.status,
      untracked: entry.untracked === true,
      deleted: after === null,
      newFile: before === null,
      before,
      after,
      diff,
      changedLines: parseChangedLines(diff),
    })
  }

  return {
    root,
    target,
    beforeRef,
    files,
    skipped,
    truncated: budgetTruncated,
    description: target.kind === 'files'
      ? `指定文件（${files.length} 个）的当前内容`
      : null,
  }
}
