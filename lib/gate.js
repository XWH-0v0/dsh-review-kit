/**
 * The evidence gate: the first and cheapest precision mechanism.
 *
 * A candidate survives only when it quotes a line that actually exists in the
 * snapshot, uses an accepted `kind`, and states a concrete failure scenario.
 * Rejections here are counted as *invalid output*, never as refuted findings:
 * the two statistics answer different questions.
 *
 * @module dsh-review-kit/gate
 */

import { KINDS } from './config.js'
import { fingerprintOf } from './fingerprint.js'
import { sanitizeRepoPath } from './target.js'
import { locateAnchor, normalizeLine, normalizeSeverity } from './text.js'

const UNKNOWN = '(未知)'

/**
 * @param {unknown} value candidate text.
 * @returns {string} trimmed text or an empty string.
 */
function readString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Gate the raw finder output against the snapshot.
 *
 * @param {object} options gate options.
 * @param {Array<{raw: unknown, lens: string}>} options.candidates raw candidates with their lens.
 * @param {object} options.snapshot review snapshot.
 * @returns {{accepted: object[], invalid: Array<{file: string, title: string, reason: string}>}} the gate result.
 */
export function gateCandidates({ candidates, snapshot }) {
  const files = new Map(snapshot.files.map((file) => [file.path, file]))
  const accepted = []
  const invalid = []

  for (const { raw, lens } of candidates) {
    const reject = (reason, file = UNKNOWN, title = UNKNOWN) => {
      invalid.push({ file, title, reason })
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      reject('候选不是对象')
      continue
    }

    const title = readString(raw.title)
    const detail = readString(raw.detail)
    const failureScenario = readString(raw.failureScenario)
    const rawFile = readString(raw.file)

    let filePath
    try {
      filePath = sanitizeRepoPath(rawFile)
    } catch (error) {
      reject(`文件路径无效：${error instanceof Error ? error.message : String(error)}`, rawFile || UNKNOWN, title || UNKNOWN)
      continue
    }

    const file = files.get(filePath)
    if (file === undefined) {
      reject('文件不在本次评审范围内', filePath, title || UNKNOWN)
      continue
    }

    const kind = readString(raw.kind).toLowerCase()
    if (!KINDS.includes(kind)) {
      reject(`kind 不在白名单（${KINDS.join('|')}）：${kind || '缺失'}`, filePath, title || UNKNOWN)
      continue
    }

    const anchor = readString(raw.anchor)
    if (anchor.length === 0) {
      reject('缺少 anchor（必须逐字引用源码行）', filePath, title || UNKNOWN)
      continue
    }
    if (normalizeLine(anchor).length < 4) {
      reject('anchor 过短，无法定位', filePath, title || UNKNOWN)
      continue
    }
    if (title.length === 0) {
      reject('缺少 title', filePath, UNKNOWN)
      continue
    }
    if (detail.length === 0) {
      reject('缺少 detail', filePath, title)
      continue
    }
    if (failureScenario.length === 0) {
      reject('缺少 failureScenario（没有具体失败场景就不收）', filePath, title)
      continue
    }

    const afterLine = locateAnchor(file.after, anchor)
    const beforeLine = afterLine === 0 ? locateAnchor(file.before, anchor) : 0
    if (afterLine === 0 && beforeLine === 0) {
      reject('引用行在快照中找不到（模型编造了代码或行内容）', filePath, title)
      continue
    }

    accepted.push({
      id: fingerprintOf({ kind, file: filePath, anchor }),
      file: filePath,
      line: afterLine === 0 ? beforeLine : afterLine,
      side: afterLine === 0 ? 'before' : 'after',
      anchor,
      kind,
      title: title.slice(0, 200),
      detail: detail.slice(0, 6_000),
      failureScenario: failureScenario.slice(0, 3_000),
      severity: normalizeSeverity(raw.severity),
      suggestedFix: readString(raw.suggestedFix).slice(0, 2_000) || undefined,
      lens,
      lenses: [lens],
      originHint: 'unknown',
    })
  }

  return { accepted, invalid }
}
