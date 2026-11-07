/**
 * Review-scope parsing and descriptions.
 *
 * Four scopes are supported, matching the design doc:
 *   - `uncommitted` — working tree against HEAD (tracked changes + untracked files)
 *   - `base`        — working tree against an explicit ref (`origin/main`, `HEAD~3`, a sha)
 *   - `commit`      — the change one commit introduced (`<sha>^..<sha>`)
 *   - `files`       — an explicit list of repository-relative files
 *
 * @module dsh-review-kit/target
 */

/** Accepted target kinds. */
export const TARGET_KINDS = Object.freeze(['uncommitted', 'base', 'commit', 'files'])

/**
 * Normalize a repository-relative path and reject anything that escapes the
 * repository. Read-only discipline starts at the path boundary.
 *
 * @param {unknown} value candidate path.
 * @returns {string} normalized path with forward slashes.
 * @throws {Error} when the path is absolute or contains `..`.
 */
export function sanitizeRepoPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  if (raw.length === 0) throw new Error('文件路径不能为空。')
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith('/') || raw.startsWith('~')) {
    throw new Error(`只接受仓库相对路径，收到绝对路径：${raw}`)
  }
  const parts = raw.split('/')
  if (parts.some((part) => part === '..')) {
    throw new Error(`路径不能包含 ..（会逃出仓库）：${raw}`)
  }
  const normalized = parts.filter((part) => part !== '' && part !== '.').join('/')
  if (normalized.length === 0) throw new Error(`无效路径：${raw}`)
  return normalized
}

/**
 * Resolve the `target` argument into a concrete scope.
 *
 * @param {Record<string, unknown>} args model arguments.
 * @returns {{kind: string, baseRef: string, commit: string, files: string[]}} the scope.
 */
export function parseTarget(args) {
  const input = args !== null && typeof args === 'object' ? args : {}
  const kind = typeof input.target === 'string' && input.target.trim().length > 0
    ? input.target.trim().toLowerCase()
    : 'uncommitted'
  if (!TARGET_KINDS.includes(kind)) {
    throw new Error(`未知的 target：${kind}。可用：${TARGET_KINDS.join('、')}。`)
  }

  if (kind === 'base') {
    const base = typeof input.base === 'string' ? input.base.trim() : ''
    if (base.length === 0) {
      throw new Error('target=base 需要 base 参数：基线引用，例如 origin/main、main、HEAD~3 或提交 sha。')
    }
    return { kind, baseRef: base, commit: '', files: [] }
  }

  if (kind === 'commit') {
    const commit = typeof input.commit === 'string' ? input.commit.trim() : ''
    if (commit.length === 0 || commit.startsWith('-')) {
      throw new Error('target=commit 需要 commit 参数：一个具体的提交 sha（不要以 - 开头）。')
    }
    return { kind, baseRef: '', commit, files: [] }
  }

  if (kind === 'files') {
    if (!Array.isArray(input.files)) {
      throw new Error('target=files 需要 files 参数：仓库相对路径数组。')
    }
    const seen = new Set()
    const files = []
    for (const item of input.files) {
      const path = sanitizeRepoPath(item)
      if (seen.has(path)) continue
      seen.add(path)
      files.push(path)
    }
    if (files.length === 0) throw new Error('target=files 的 files 不能为空。')
    return { kind, baseRef: '', commit: '', files }
  }

  return { kind: 'uncommitted', baseRef: 'HEAD', commit: '', files: [] }
}

/**
 * Human-readable scope line used in prompts, coverage and the report.
 *
 * @param {{kind: string, baseRef: string, commit: string, files: string[]}} target resolved scope.
 * @returns {string} one-line description.
 */
export function describeTarget(target) {
  if (target.kind === 'base') return `相对 ${target.baseRef} 的改动（工作区与基线对比）`
  if (target.kind === 'commit') return `提交 ${target.commit} 引入的改动`
  if (target.kind === 'files') return `指定文件（${target.files.length} 个）的当前内容`
  return '未提交改动（工作区相对 HEAD）'
}
